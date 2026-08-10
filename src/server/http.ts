import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { classifyMcpRequest } from "./mcp-request-classification.js";
import { isModernMcpRequest, modernClientName } from "./mcp-discovery.js";
import { dispatchModernMcpRequest } from "./mcp-modern.js";
import { classifyModernMcpDiagnostic } from "./mcp-diagnostic-classification.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { ToolContext } from "../types.js";
import { createServer as createMcpServer } from "./mcp-server.js";
import { SingleUserOAuthProvider, type OAuthConfig } from "../auth/oauth-provider.js";
import { verifyOwnerToken } from "../auth/owner-token.js";
import { registerActionRoutes } from "./actions.js";
import { registerLocalControlRoutes, type LocalControlRouteConfig } from "./local-control.js";
import { RuntimeActivityTracker, type RuntimeSessionHandle } from "../runtime/activity.js";
import { isDesktopControlSupported } from "../control/policy.js";
import {
  FileConnectionDiagnostics,
  type ConnectionDiagnosticSafeInputs,
} from "../runtime/connection-diagnostics.js";
import { toRemoteBoundaryError } from "./error-safety.js";
import { remoteOwnerSessionScope } from "../state/session-scope.js";
import {
  McpSessionLifecycleDiagnostics,
  type McpSessionCloseReason,
} from "../runtime/mcp-session-lifecycle.js";

/**
 * HTTP + OAuth 2.1 transport gateway (PRD §4 Transport Gateway, §5 CLI,
 * §7 auth, §11 SR-05/SR-12) exposing the SAME 15 tools that serve over
 * stdio (src/server/mcp-server.ts / registerTools) over a Streamable HTTP
 * `/mcp` endpoint, so ChatGPT (web) can connect over a public HTTPS tunnel.
 *
 * Does not alter or remove the stdio transport path in src/cli.ts.
 */

export interface HttpServerConfig {
  /** Bind host, default 127.0.0.1 (loopback only unless overridden). */
  host: string;
  /** Bind port, default 7979 (PRD §5). */
  port: number;
  /** Public origin ChatGPT/clients will reach this server at, e.g.
   * https://my-tunnel.example.com. Used as the OAuth issuer/resource base
   * and to derive the allowed Origin/Host for DNS-rebinding defense. */
  publicUrl: string;
  /** Extra hostnames to allow in the Host header allowlist (SR-12), beyond
   * the host derived from publicUrl and standard loopback aliases. */
  extraAllowedHosts?: string[];
  oauth: {
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    scopes: string[];
    allowedRedirectHosts: string[];
  };
  /** Idle TTL for a session transport before it is evicted (NFR-03). */
  sessionTtlMs: number;
  /** Hard cap on concurrently tracked session transports (SR-09/NFR-03). */
  maxSessions: number;
  /** File-protected capability used only by the native loopback UI. */
  localControlToken: string;
  /** Real synthetic-input backend availability for this host platform. */
  desktopControlSupported: boolean;
  /** Test-only failure injection for the local approval transaction. */
  localControlApprovalState?: LocalControlRouteConfig["approvalState"];
  /** Test/embedded override for the verified external rg binary inspection. */
  localControlRgBinary?: LocalControlRouteConfig["rgBinary"];
  /** Optional process-level idle shutdown when no MCP sessions are active. */
  idleShutdownMs?: number;
  /** Called once after idleShutdownMs elapses with no active MCP sessions. */
  onIdleTimeout?: () => void;
}

export function defaultHttpServerConfig(overrides: Partial<HttpServerConfig> = {}): HttpServerConfig {
  const config = {
    host: "127.0.0.1",
    port: 7979,
    publicUrl: "http://127.0.0.1:7979",
    oauth: {
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 30 * 24 * 3600,
      scopes: ["chatgpt2codex"],
      allowedRedirectHosts: ["chatgpt.com", "chat.openai.com"],
    },
    sessionTtlMs: 30 * 60 * 1000,
    maxSessions: 8,
    localControlToken: randomBytes(32).toString("base64url"),
    desktopControlSupported: isDesktopControlSupported(),
    ...overrides,
  };
  config.maxSessions = Math.min(16, Math.max(1, config.maxSessions));
  return config;
}

interface TrackedSession {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  lastActiveAtMs: number;
  activitySession: RuntimeSessionHandle;
  clientName?: string;
  openedAtMs: number;
  requestCount: number;
  reusedRequestCount: number;
  closeReason?: McpSessionCloseReason;
  finalizePromise?: Promise<void>;
}

function diagnosticEventForPath(pathname: string): string | undefined {
  if (pathname === "/mcp") return "mcp.request";
  if (pathname === "/authorize" || pathname === "/token" || pathname === "/register") return "oauth.request";
  if (pathname.startsWith("/.well-known/")) return "oauth.metadata";
  if (pathname.startsWith("/actions/")) return "actions.request";
  return undefined;
}

function safeMcpToolAttribution(body: unknown, knownProjectIds: ReadonlySet<string>): {
  tool?: string;
  safeInputs?: ConnectionDiagnosticSafeInputs;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const envelope = body as Record<string, unknown>;
  if (envelope.method !== "tools/call") return {};
  if (!envelope.params || typeof envelope.params !== "object" || Array.isArray(envelope.params)) return {};
  const params = envelope.params as Record<string, unknown>;
  const tool = typeof params.name === "string"
    && /^[a-z][a-z0-9_]{0,63}$/u.test(params.name)
    && !/(?:token|secret|credential|password|api[_-]?key)/iu.test(params.name)
    ? params.name
    : undefined;
  if (!tool) return {};
  if (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments)) return { tool };
  const args = params.arguments as Record<string, unknown>;
  const projectId = typeof args.projectId === "string" && knownProjectIds.has(args.projectId)
    ? args.projectId
    : undefined;
  const commandId = tool === "command_run"
    && typeof args.commandId === "string"
    && /^(?:npm|make|flutter):[A-Za-z0-9._:-]{1,96}$/u.test(args.commandId)
    && !/(?:token|secret|credential|password|api[_-]?key)/iu.test(args.commandId)
    ? args.commandId
    : undefined;
  const safeInputs: ConnectionDiagnosticSafeInputs = {
    ...(projectId ? { projectId } : {}),
    ...(commandId ? { commandId } : {}),
  };
  return {
    tool,
    ...(Object.keys(safeInputs).length > 0 ? { safeInputs } : {}),
  };
}

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message, ...(data ? { data } : {}) }, id: null });
}

function hashAuditValue(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function jsonRpcErrorCode(response: Record<string, unknown> | undefined): number | undefined {
  if (!response || typeof response.error !== "object" || response.error === null || Array.isArray(response.error)) {
    return undefined;
  }
  const code = (response.error as Record<string, unknown>).code;
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}


const TRUSTED_CHATGPT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"] as const;
const REGISTER_RATE_LIMIT_MAX = 10;
const REGISTER_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Single-user OAuth registration is intentionally global and bounded. Per-IP
 * limits are not sufficient behind a Cloudflare loopback proxy, and a map of
 * attacker-controlled IPs would itself become an unbounded state sink.
 *
 * This is a bounded sliding window rather than a fixed window so an attacker
 * cannot obtain a second burst by straddling a minute boundary. Only accepted
 * request timestamps are retained, with a hard cap of ten entries.
 */
export class RegisterRateLimiter {
  private readonly acceptedAtMs: number[] = [];

  consume(now = Date.now()): number | undefined {
    const cutoff = now - REGISTER_RATE_LIMIT_WINDOW_MS;
    // Keep an event exactly at the boundary so ten requests cannot be
    // followed by a second ten-request burst at the same instant.
    while (this.acceptedAtMs.length > 0 && this.acceptedAtMs[0]! < cutoff) {
      this.acceptedAtMs.shift();
    }
    if (this.acceptedAtMs.length >= REGISTER_RATE_LIMIT_MAX) {
      const retryAt = this.acceptedAtMs[0]! + REGISTER_RATE_LIMIT_WINDOW_MS;
      return Math.max(1, Math.ceil((retryAt - now) / 1000));
    }
    this.acceptedAtMs.push(now);
    return undefined;
  }
}
const OWNER_TOKEN_TOGGLE_SCRIPT = `
(() => {
  const input = document.getElementById("owner_token");
  const toggle = document.getElementById("owner_token_toggle");
  if (!(input instanceof HTMLInputElement) || !(toggle instanceof HTMLButtonElement)) return;

  const showLabel = toggle.dataset.labelShow || "Show owner token";
  const hideLabel = toggle.dataset.labelHide || "Hide owner token";
  const setVisible = (visible) => {
    input.type = visible ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(visible));
    toggle.setAttribute("aria-label", visible ? hideLabel : showLabel);
  };

  toggle.addEventListener("click", () => setVisible(input.type === "password"));
  setVisible(false);
})();
`.trimStart();

/** SR-12: strict security headers applied to every response. The OAuth HTML
 * form is intentionally frameable by ChatGPT because connector authorization
 * may be shown inside ChatGPT's web UI. */
function securityHeaders(_req: Request, res: Response, next: () => void): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "script-src 'self'",
      `form-action 'self' ${TRUSTED_CHATGPT_ORIGINS.join(" ")}`,
      `frame-ancestors 'self' ${TRUSTED_CHATGPT_ORIGINS.join(" ")}`,
      "style-src 'unsafe-inline'",
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

/** SR-05/SR-12: reject cross-origin browser requests to /mcp and the OAuth
 * endpoints whose Origin header does not match the configured public origin
 * or a loopback origin. Non-browser clients (no Origin header, e.g. the
 * ChatGPT backend or curl) are unaffected — Origin is only ever sent by
 * browsers, so this only closes the browser/DNS-rebinding attack surface. */
function makeOriginAllowlist(allowedOrigins: Set<string>) {
  return function originAllowlist(req: Request, res: Response, next: () => void): void {
    if (isOAuthBrowserFlowPath(req.path)) {
      next();
      return;
    }
    const origin = req.header("origin");
    if (!origin) {
      next();
      return;
    }
    if (allowedOrigins.has(origin)) {
      next();
      return;
    }
    sendJsonRpcError(res, 403, -32000, "Origin not allowed");
  };
}

function isOAuthBrowserFlowPath(pathName: string): boolean {
  return (
    pathName === "/authorize" ||
    pathName.startsWith("/authorize/") ||
    pathName === "/token" ||
    pathName.startsWith("/token/") ||
    pathName === "/register" ||
    pathName.startsWith("/register/") ||
    pathName === "/revoke" ||
    pathName.startsWith("/revoke/") ||
    pathName.startsWith("/.well-known/")
  );
}

export interface RunningHttpServer {
  app: Express;
  config: HttpServerConfig;
  close(): Promise<void>;
}

export function createHttpServer(ctx: ToolContext, config: HttpServerConfig): RunningHttpServer {
  const startedAt = Date.now();
  const activityTracker = new RuntimeActivityTracker();
  const diagnostics = new FileConnectionDiagnostics(ctx.stateDir);
  ctx.diagnostics = diagnostics;
  const publicUrl = new URL(config.publicUrl);
  const mcpUrl = new URL("/mcp", publicUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);

  const loopbackHosts = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const allowedHostnames = Array.from(
    new Set([publicUrl.hostname, ...loopbackHosts, ...(config.extraAllowedHosts ?? [])]),
  );
  // createMcpExpressApp's DNS-rebinding middleware matches Host headers
  // against this list; include host:port forms too since browsers/clients
  // typically send `Host: host:port`.
  const allowedHostHeaders = Array.from(
    new Set([
      ...allowedHostnames,
      `${publicUrl.hostname}:${publicUrl.port || (publicUrl.protocol === "https:" ? "443" : "80")}`,
      `127.0.0.1:${config.port}`,
      `localhost:${config.port}`,
    ]),
  );

  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: allowedHostHeaders,
  });
  diagnostics.record({ event: "server.started", outcome: "success" }).catch(() => undefined);
  app.use((req, res, next) => {
    const event = diagnosticEventForPath(req.path);
    if (!event) {
      next();
      return;
    }
    const requestStartedAt = Date.now();
    const attribution = req.path === "/mcp"
      ? safeMcpToolAttribution(req.body, new Set(ctx.registry.map((entry) => entry.projectId)))
      : {};
    let responseFinished = false;
    let clientCancelRecorded = false;
    res.once("finish", () => {
      responseFinished = true;
      const failure = res.statusCode >= 400;
      const bearerChallenge = req.path === "/mcp" && res.statusCode === 401 && !req.header("authorization");
      diagnostics
        .record({
          event: bearerChallenge ? "oauth.challenge" : event,
          outcome: bearerChallenge ? "info" : failure ? "failure" : "success",
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - requestStartedAt,
          ...(req.path === "/mcp" ? { phase: "transport" as const } : {}),
          ...attribution,
          ...(failure && !bearerChallenge ? { errorCode: `HTTP_${res.statusCode}` } : {}),
        })
        .catch(() => undefined);
    });
    res.once("close", () => {
      if (req.path !== "/mcp" || responseFinished || clientCancelRecorded) return;
      clientCancelRecorded = true;
      const activitySession = res.locals.c2ctActivitySession as RuntimeSessionHandle | undefined;
      const cancelledOperation = activitySession
        ? activityTracker.markClientCancelled(activitySession, attribution.tool)
        : undefined;
      diagnostics.record({
        event: "mcp.client_cancelled",
        outcome: "info",
        method: req.method,
        path: req.path,
        durationMs: Date.now() - requestStartedAt,
        phase: "transport",
        cancelledByClient: true,
        ...(cancelledOperation?.operationId ? { operationId: cancelledOperation.operationId } : {}),
        ...attribution,
      }).catch(() => undefined);
    });
    next();
  });
  // Cloudflare tunnels terminate on loopback and forward X-Forwarded-For; trust
  // only loopback proxies so express-rate-limit keys clients without warning.
  app.set("trust proxy", "loopback");
  app.use(securityHeaders);

  const allowedOrigins = new Set<string>([
    publicUrl.origin,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...TRUSTED_CHATGPT_ORIGINS,
  ]);
  app.use(makeOriginAllowlist(allowedOrigins));

  // Dynamic client registration is intentionally global and bounded. This
  // route is unauthenticated by OAuth design, so a single process-wide window
  // prevents an attacker from rotating source IPs behind a proxy and forcing
  // unbounded JSON-file writes.
  const registerRateLimiter = new RegisterRateLimiter();
  app.use("/register", (req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    const retryAfter = registerRateLimiter.consume();
    if (retryAfter === undefined) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "temporarily_unavailable",
      error_description: "OAuth client registration is temporarily rate limited; retry later",
    });
  });

  const oauthConfig: OAuthConfig = {
    verifyOwnerToken: (candidate) => verifyOwnerToken(ctx.stateDir, candidate),
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    scopes: config.oauth.scopes,
    allowedRedirectHosts: config.oauth.allowedRedirectHosts,
    onOwnerTokenAttempt: (event) =>
      Promise.all([
        ctx.ledger.append({
          type: "oauth.owner_token_attempt",
          outcome: event.outcome,
          clientIpHash: hashAuditValue(event.clientIp),
          clientIdHash: hashAuditValue(event.clientId),
          hasClientName: event.clientName !== undefined,
        }),
        diagnostics.record({
          event: "oauth.owner_token_attempt",
          outcome: "failure",
          errorCode: event.outcome === "locked_out" ? "OWNER_TOKEN_LOCKED_OUT" : "OWNER_TOKEN_REJECTED",
          clientName: event.clientName,
        }),
      ]).then(() => undefined),
  };
  const oauthProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, ctx.stateDir);
  const oauthMetadata = createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl: publicUrl,
    baseUrl: publicUrl,
    scopesSupported: config.oauth.scopes,
  });
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "chatgpt2codex"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "chatgpt2codex",
    }),
  );

  app.get("/assets/owner-token-toggle.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("application/javascript").send(OWNER_TOKEN_TOGGLE_SCRIPT);
  });

  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.json(oauthMetadata);
  });

  app.get("/healthz", (req, res) => {
    const host = String(req.header("host") ?? "").toLowerCase();
    const localHealthHosts = new Set([
      "127.0.0.1",
      `127.0.0.1:${config.port}`,
      "localhost",
      `localhost:${config.port}`,
      "[::1]",
      `[::1]:${config.port}`,
      "::1",
      `::1:${config.port}`,
    ]);
    const remoteAddress = String(req.ip ?? req.socket.remoteAddress ?? "");
    const loopbackClient = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).has(remoteAddress);
    const payload: Record<string, unknown> = {
      ok: true,
      name: "chatgpt2codex",
      schemaVersion: 2,
      transport: "http",
    };
    // Keep public health checks useful without disclosing process start time,
    // runtime build labels, or host platform. Loopback callers (the updater,
    // local diagnostics, and CI smoke checks) retain the detailed payload.
    if (loopbackClient && localHealthHosts.has(host)) {
      payload.startedAt = startedAt;
      payload.runtimeVersion = process.env.CHATGPT2CODEX_RUNTIME_VERSION ?? "development";
      payload.platform = process.platform;
    }
    res.json(payload);
  });

  registerLocalControlRoutes(app, ctx, activityTracker, {
    port: config.port,
    token: config.localControlToken,
    startedAt,
    desktopControlSupported: config.desktopControlSupported,
    diagnostics,
    approvalState: config.localControlApprovalState,
    rgBinary: config.localControlRgBinary,
  });

  app.get("/privacy", (_req, res) => {
    res
      .type("text/plain")
      .send(
        [
          "chatgpt2codex privacy notice",
          "",
          "chatgpt2codex is a local MCP/action bridge controlled by the owner of this server.",
          "Custom GPT Actions sent to this server are used only to select local projects, save/import ChatGPT images, list saved images, and check action status.",
          "The server stores operational audit entries and saved image files on the owner's local machine. It does not sell data, run advertising profiles, or call OpenAI Images/Codex APIs to generate images.",
          "Do not send secrets or unrelated personal data to this action bridge.",
        ].join("\n"),
      );
  });

  registerActionRoutes(app, ctx, publicUrl);

  // Per-session transport map with TTL + hard cap (NFR-03/SR-09): every
  // initialize request creates one transport, keyed by MCP session id.
  // Idle sessions are swept on a timer; the map never grows unbounded even
  // under a client that never sends a clean close.
  const sessions = new Map<string, TrackedSession>();
  const sessionLifecycle = new McpSessionLifecycleDiagnostics(diagnostics);
  let lastSessionActivityAtMs = Date.now();
  let idleShutdownQueued = false;

  function finalizeTrackedSession(
    session: TrackedSession,
    reason: McpSessionCloseReason,
    errorCode?: string,
  ): Promise<void> {
    if (session.finalizePromise) return session.finalizePromise;
    session.finalizePromise = (async () => {
      if (sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
      activityTracker.closeSession(session.activitySession);
      await sessionLifecycle.closed({
        clientName: session.clientName,
        openedAtMs: session.openedAtMs,
        closedAtMs: Date.now(),
        requestCount: session.requestCount,
        reusedRequestCount: session.reusedRequestCount,
        reason,
        activeSessionCount: sessions.size,
        errorCode,
      });
    })();
    return session.finalizePromise;
  }

  async function closeTrackedSession(session: TrackedSession, reason: McpSessionCloseReason): Promise<void> {
    session.closeReason = reason;
    try {
      await session.transport.close();
    } finally {
      await finalizeTrackedSession(session, reason);
    }
  }

  async function evictOldestSession(): Promise<void> {
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, session] of sessions) {
      if (session.lastActiveAtMs < oldestAt) {
        oldestAt = session.lastActiveAtMs;
        oldestId = id;
      }
    }
    if (oldestId) {
      const session = sessions.get(oldestId);
      if (session) await closeTrackedSession(session, "capacity");
    }
  }

  async function sweepSessions(): Promise<void> {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (now - session.lastActiveAtMs > config.sessionTtlMs) {
        await closeTrackedSession(session, "idle_ttl");
      }
    }
    if (
      config.idleShutdownMs !== undefined &&
      config.idleShutdownMs > 0 &&
      sessions.size === 0 &&
      now - lastSessionActivityAtMs > config.idleShutdownMs &&
      !idleShutdownQueued
    ) {
      idleShutdownQueued = true;
      setImmediate(() => config.onIdleTimeout?.());
    }
  }

  const sweepInterval = setInterval(() => {
    void sweepSessions().catch(() => undefined);
  }, Math.min(config.sessionTtlMs, config.idleShutdownMs ?? 60_000, 60_000));
  sweepInterval.unref();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    const requestClassification = classifyMcpRequest(req.body, Boolean(sessionId));

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch(() => undefined);
    if (res.headersSent) return;

    if (
      !req.auth?.resource ||
      !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })
    ) {
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    if (
      isModernMcpRequest(
        req.method,
        req.body,
        requestClassification,
        req.header("mcp-protocol-version"),
      )
    ) {
      const clientName = modernClientName(req.body);
      const activitySession = activityTracker.openSession({ transport: "http", clientName });
      res.locals.c2ctActivitySession = activitySession;
      const now = Date.now();
      lastSessionActivityAtMs = now;
      activityTracker.touch(activitySession, now);
      try {
        const result = await dispatchModernMcpRequest(
          {
            ...ctx,
            remote: true,
            sessionScope: remoteOwnerSessionScope(),
            activity: { tracker: activityTracker, session: activitySession },
          },
          req.body,
          {
            name: "chatgpt2codex",
            version: process.env.CHATGPT2CODEX_RUNTIME_VERSION ?? "development",
          },
          {
            protocolVersion: req.header("mcp-protocol-version"),
            method: req.header("mcp-method"),
            name: req.header("mcp-name"),
          },
        );
        const rpcErrorCode = jsonRpcErrorCode(result.response);
        const diagnosticClassification = classifyModernMcpDiagnostic({
          status: result.status,
          jsonRpcMethod: requestClassification.jsonRpcMethod,
          jsonRpcErrorCode: rpcErrorCode,
          body: req.body,
        });
        diagnostics
          .record({
            ...diagnosticClassification,
            ...safeMcpToolAttribution(req.body, new Set(ctx.registry.map((entry) => entry.projectId))),
            method: req.method,
            status: result.status,
            clientName,
            jsonRpcMethod: requestClassification.jsonRpcMethod,
            requestKind: requestClassification.requestKind,
            hasSessionHeader: false,
            initializeRequest: false,
            notification: requestClassification.notification,
          })
          .catch(() => undefined);
        if (result.response) res.status(result.status).json(result.response);
        else res.status(result.status).end();
      } finally {
        activityTracker.closeSession(activitySession);
      }
      return;
    }

    let trackedForRequest: TrackedSession | undefined;
    try {
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId) {
        const tracked = sessions.get(sessionId);
        if (!tracked) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        tracked.lastActiveAtMs = Date.now();
        lastSessionActivityAtMs = tracked.lastActiveAtMs;
        activityTracker.touch(tracked.activitySession, tracked.lastActiveAtMs);
        tracked.requestCount += 1;
        tracked.reusedRequestCount += 1;
        trackedForRequest = tracked;
        res.locals.c2ctActivitySession = tracked.activitySession;
        transport = tracked.transport;
      } else if (initializeRequest) {
        if (sessions.size >= config.maxSessions) await evictOldestSession();

        const clientName =
          typeof req.body?.params?.clientInfo?.name === "string" ? req.body.params.clientInfo.name : undefined;
        const activitySession = activityTracker.openSession({ transport: "http", clientName });
        res.locals.c2ctActivitySession = activitySession;
        const initializeStartedAtMs = Date.now();
        const sessionScope = remoteOwnerSessionScope();
        let trackedSession: TrackedSession | undefined;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) {
              lastSessionActivityAtMs = Date.now();
              activityTracker.updateSession(activitySession, {
                externalId: newSessionId,
                clientName,
                now: lastSessionActivityAtMs,
              });
              trackedSession = {
                sessionId: newSessionId,
                transport,
                lastActiveAtMs: lastSessionActivityAtMs,
                activitySession,
                clientName,
                openedAtMs: lastSessionActivityAtMs,
                requestCount: 1,
                reusedRequestCount: 0,
              };
              trackedForRequest = trackedSession;
              sessions.set(newSessionId, trackedSession);
              void sessionLifecycle.opened({
                clientName,
                openedAtMs: lastSessionActivityAtMs,
                sessionSetupMs: Math.max(0, lastSessionActivityAtMs - initializeStartedAtMs),
                activeSessionCount: sessions.size,
              }).catch(() => undefined);
            }
          },
        });

        transport.onclose = () => {
          if (trackedSession) {
            void finalizeTrackedSession(trackedSession, trackedSession.closeReason ?? "client").catch(() => undefined);
          } else {
            activityTracker.closeSession(activitySession);
          }
        };
        transport.onerror = (error) => {
          if (!trackedSession) return;
          void sessionLifecycle.transportError({
            clientName,
            openedAtMs: trackedSession.openedAtMs,
            closedAtMs: Date.now(),
            requestCount: trackedSession.requestCount,
            reusedRequestCount: trackedSession.reusedRequestCount,
            reason: "transport_error",
            activeSessionCount: sessions.size,
            errorCode: error instanceof Error && error.name ? `MCP_${error.name.toUpperCase()}` : "MCP_TRANSPORT_ERROR",
          }).catch(() => undefined);
        };

        // Mark this session remote: it's how ChatGPT (and any other network
        // MCP client) connects, so project_select preset=control must be
        // refused here even when the desktop-control tools are exposed to
        // ChatGPT (see src/server/tools.ts project_select handler /
        // isControlChatGptExposed) — lease arming stays local-only (stdio).
        const mcpServer = await createMcpServer({
          ...ctx,
          remote: true,
          sessionScope,
          activity: { tracker: activityTracker, session: activitySession },
        });
        await mcpServer.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        diagnostics
          .record({
            event: "mcp.session_rejected",
            outcome: "failure",
            errorCode: "MCP_SESSION_REQUIRED",
            method: req.method,
            jsonRpcMethod: requestClassification.jsonRpcMethod,
            requestKind: requestClassification.requestKind,
            hasSessionHeader: requestClassification.hasSessionHeader,
            initializeRequest: requestClassification.initializeRequest,
            notification: requestClassification.notification,
          })
          .catch(() => undefined);
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (trackedForRequest) {
        await sessionLifecycle.transportError({
          clientName: trackedForRequest.clientName,
          openedAtMs: trackedForRequest.openedAtMs,
          closedAtMs: Date.now(),
          requestCount: trackedForRequest.requestCount,
          reusedRequestCount: trackedForRequest.reusedRequestCount,
          reason: "transport_error",
          activeSessionCount: sessions.size,
          errorCode: "MCP_REQUEST_FAILED",
        }).catch(() => undefined);
      }
      const boundary = toRemoteBoundaryError(error);
      const diagnostic = await diagnostics
        .record({ event: "mcp.request_failed", outcome: "failure", errorCode: boundary.code })
        .catch(() => undefined);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, boundary.message, {
          code: boundary.code,
          ...(diagnostic?.diagnosticId ? { diagnosticId: diagnostic.diagnosticId } : {}),
        });
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    close: async () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        clearInterval(sweepInterval);
        await Promise.all(
          [...sessions.values()].map((session) => closeTrackedSession(session, "shutdown").catch(() => undefined)),
        );
        sessionLifecycle.dispose();
        oauthProvider.close();
        await diagnostics.record({ event: "server.stopped", outcome: "info" }).catch(() => undefined);
      })();
      return closePromise;
    },
  };
}
