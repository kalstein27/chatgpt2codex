import { isIP } from "node:net";
import { MCP_CORE_TOOL_NAMES } from "../server/mcp-discovery.js";
import {
  CHATGPT_OPERATION_APPROVAL_PRESENTER_TOOL,
  CHATGPT_OPERATION_APPROVAL_WIDGET_URI,
} from "../server/chatgpt-consent-widget.js";

const DEFAULT_TIMEOUT_MS = 4_000;
const CONNECTOR_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/u;

export interface ConnectorProbe {
  ok: boolean;
  status: number | null;
  category: "ok" | "timeout" | "network" | "http" | "invalid-response" | "not-run";
}

export interface ConnectorRegistrationAssistantReport {
  schemaVersion: 1;
  generatedAt: string;
  state: "READY" | "BLOCKED";
  currentConnectorName: string;
  candidateConnectorName: string;
  settingsUrl: "https://chatgpt.com/plugins";
  connector: {
    publicOrigin: string | null;
    mcpUrl: string | null;
    localHealth: ConnectorProbe;
    publicHealth: ConnectorProbe;
    oauthMetadata: ConnectorProbe;
  };
  runtime: {
    pid: number | null;
    schemaRevision: string | null;
    fingerprint: string | null;
    coreToolNames: readonly string[];
  };
  safety: {
    blueGreen: true;
    storesChatGptCookies: false;
    storesOAuthTokens: false;
    usesUndocumentedChatGptApi: false;
    deletesExistingConnectorAutomatically: false;
  };
  blockers: string[];
  steps: string[];
  acceptancePrompt: string;
}

export interface ConnectorRegistrationAssistantOptions {
  port?: number;
  publicOrigin?: string;
  currentConnectorName?: string;
  candidateConnectorName?: string;
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

interface LocalHealthPayload {
  ok?: unknown;
  runtimePid?: unknown;
  runtimeManifest?: {
    toolSchemaRevision?: unknown;
    hostCatalogRevision?: unknown;
    runtimeFingerprint?: unknown;
    buildFingerprint?: unknown;
  };
  runtimeExternalIdentity?: {
    connectorPublicOrigin?: unknown;
  };
}

function notRun(): ConnectorProbe {
  return { ok: false, status: null, category: "not-run" };
}

function validConnectorName(value: string, label: string): string {
  const normalized = value.trim();
  if (!CONNECTOR_NAME_PATTERN.test(normalized)) {
    throw new Error(`${label} must be 1-64 printable characters`);
  }
  return normalized;
}

/**
 * Only HTTPS origins with a DNS hostname are accepted. Raw IPs, local names,
 * credentials, custom ports, paths, queries, and fragments are deliberately
 * rejected so this operator helper cannot become a convenient SSRF probe.
 */
export function normalizePublicConnectorOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("public connector URL is invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIP(hostname) !== 0
  ) {
    throw new Error("public connector URL must be a credential-free HTTPS DNS origin");
  }
  return url.origin;
}

function safePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeSchemaRevision(value: unknown): string | null {
  return typeof value === "string" && /^sha256:[a-f0-9]{24}$/u.test(value) ? value : null;
}

function safeFingerprint(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

async function fetchJson(
  url: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ probe: ConnectorProbe; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { probe: { ok: false, status: response.status, category: "http" }, body: null };
    }
    try {
      return {
        probe: { ok: true, status: response.status, category: "ok" },
        body: await response.json(),
      };
    } catch {
      return {
        probe: { ok: false, status: response.status, category: "invalid-response" },
        body: null,
      };
    }
  } catch (error) {
    const timeout = error instanceof Error && error.name === "AbortError";
    return {
      probe: { ok: false, status: null, category: timeout ? "timeout" : "network" },
      body: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sameOriginEndpoint(value: unknown, origin: string, pathname: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === origin && url.pathname === pathname && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function oauthMetadataValid(value: unknown, origin: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return sameOriginEndpoint(record.issuer, origin, "/") &&
    sameOriginEndpoint(record.authorization_endpoint, origin, "/authorize") &&
    sameOriginEndpoint(record.token_endpoint, origin, "/token") &&
    sameOriginEndpoint(record.registration_endpoint, origin, "/register");
}

function publicHealthValid(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.ok === true && record.name === "chatgpt2codex" && record.transport === "http";
}

function acceptancePrompt(candidateName: string, revision: string | null): string {
  return [
    `새 ChatGPT 채팅에서 @${candidateName}의 connection_status를 직접 호출해줘.`,
    "ok=true, currentTurnProof=true, transportErrors=0을 확인하고 named catalog와 live runtime catalog를 분리해 검증해.",
    revision ? `기대 runtime tool schema revision은 ${revision}이야.` : "runtime tool schema revision을 실제 응답에서 기록해.",
    "runtime_apply_status, macos_app_apply_status, runtime_snapshot_status, runtime_snapshot_prune_local을 exact-name으로 확인하고 각 outputSchema가 비어 있지 않은지 봐줘.",
    `${CHATGPT_OPERATION_APPROVAL_PRESENTER_TOOL}을 exact-name으로 확인하고 openai/outputTemplate과 ui.resourceUri가 ${CHATGPT_OPERATION_APPROVAL_WIDGET_URI}인지 확인해. generic c2ct_invoke 결과만으로 presenter mount를 PASS 처리하지 마.`,
    "기존 연결은 변경하지 말고, 검증 후 lease가 있다면 명시적으로 release해.",
  ].join("\n");
}

export async function inspectConnectorRegistration(
  options: ConnectorRegistrationAssistantOptions = {},
): Promise<ConnectorRegistrationAssistantReport> {
  const port = options.port ?? 7979;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("port must be between 1 and 65535");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new Error("timeoutMs must be between 250 and 30000");
  }
  const currentConnectorName = validConnectorName(options.currentConnectorName ?? "C2CT", "current connector name");
  const candidateConnectorName = validConnectorName(options.candidateConnectorName ?? "C2CT_next", "candidate connector name");
  if (currentConnectorName === candidateConnectorName) {
    throw new Error("candidate connector name must differ from the current connector name");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const local = await fetchJson(new URL(`http://127.0.0.1:${port}/healthz`), fetchImpl, timeoutMs);
  const localPayload = local.body && typeof local.body === "object" && !Array.isArray(local.body)
    ? local.body as LocalHealthPayload
    : {};
  if (localPayload.ok !== true && local.probe.ok) {
    local.probe = { ...local.probe, ok: false, category: "invalid-response" };
  }

  const runtimeManifest = localPayload.runtimeManifest;
  const schemaRevision = safeSchemaRevision(runtimeManifest?.hostCatalogRevision)
    ?? safeSchemaRevision(runtimeManifest?.toolSchemaRevision);
  const fingerprint = safeFingerprint(runtimeManifest?.runtimeFingerprint) ??
    safeFingerprint(runtimeManifest?.buildFingerprint);
  const runtimePid = safePositiveInteger(localPayload.runtimePid);

  let publicOrigin: string | null = null;
  const configuredOrigin = options.publicOrigin ?? localPayload.runtimeExternalIdentity?.connectorPublicOrigin;
  if (typeof configuredOrigin === "string" && configuredOrigin.trim()) {
    publicOrigin = normalizePublicConnectorOrigin(configuredOrigin.trim());
  }

  let publicHealth = notRun();
  let oauthMetadata = notRun();
  if (publicOrigin) {
    const healthResult = await fetchJson(new URL("/healthz", publicOrigin), fetchImpl, timeoutMs);
    publicHealth = publicHealthValid(healthResult.body)
      ? healthResult.probe
      : { ...healthResult.probe, ok: false, category: healthResult.probe.ok ? "invalid-response" : healthResult.probe.category };

    const metadataResult = await fetchJson(new URL("/.well-known/openid-configuration", publicOrigin), fetchImpl, timeoutMs);
    oauthMetadata = oauthMetadataValid(metadataResult.body, publicOrigin)
      ? metadataResult.probe
      : { ...metadataResult.probe, ok: false, category: metadataResult.probe.ok ? "invalid-response" : metadataResult.probe.category };
  }

  const blockers: string[] = [];
  if (!local.probe.ok) blockers.push("local runtime health is not ready");
  if (!publicOrigin) blockers.push("public connector origin is unavailable; pass --public-url or enable the web connector");
  if (publicOrigin && !publicHealth.ok) blockers.push(`public health probe failed (${publicHealth.category})`);
  if (publicOrigin && !oauthMetadata.ok) blockers.push(`OAuth metadata probe failed (${oauthMetadata.category})`);
  if (!schemaRevision) blockers.push("live runtime did not expose a valid tool schema revision");

  // Keep connector registration permanently bound to the stable bare /mcp endpoint.
  // Tool-schema revisions are runtime metadata, not connector-address identity:
  // schema-qualified query URLs can become host cache keys and strand individual
  // named-tool mounts on an obsolete endpoint after a runtime replacement.
  const mcpUrl = publicOrigin ? new URL("/mcp", publicOrigin).toString() : null;
  const steps = [
    `Keep ${currentConnectorName} installed and open ${"https://chatgpt.com/plugins"}.`,
    `Add a new connector named ${candidateConnectorName}${mcpUrl ? ` with the stable endpoint ${mcpUrl}` : " after resolving the blockers"}. Do not append a schema hash or other schema-version query parameter.`,
    "Complete OAuth interactively; do not paste the Owner Token into scripts, logs, or chat messages.",
    `Run the generated acceptance prompt in a fresh chat using ${candidateConnectorName}.`,
    `Only after PASS, rename ${currentConnectorName} to ${currentConnectorName}_old and ${candidateConnectorName} to ${currentConnectorName}.`,
    `Delete ${currentConnectorName}_old only after one final direct connection_status succeeds in another fresh chat.`,
  ];

  return {
    schemaVersion: 1,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    state: blockers.length === 0 ? "READY" : "BLOCKED",
    currentConnectorName,
    candidateConnectorName,
    settingsUrl: "https://chatgpt.com/plugins",
    connector: {
      publicOrigin,
      mcpUrl,
      localHealth: local.probe,
      publicHealth,
      oauthMetadata,
    },
    runtime: {
      pid: runtimePid,
      schemaRevision,
      fingerprint,
      coreToolNames: [...MCP_CORE_TOOL_NAMES],
    },
    safety: {
      blueGreen: true,
      storesChatGptCookies: false,
      storesOAuthTokens: false,
      usesUndocumentedChatGptApi: false,
      deletesExistingConnectorAutomatically: false,
    },
    blockers,
    steps,
    acceptancePrompt: acceptancePrompt(candidateConnectorName, schemaRevision),
  };
}

export function formatConnectorRegistrationReport(report: ConnectorRegistrationAssistantReport): string {
  const lines = [
    `C2CT connector re-registration assistant: ${report.state}`,
    `current: ${report.currentConnectorName}`,
    `candidate: ${report.candidateConnectorName}`,
    `settings: ${report.settingsUrl}`,
    `MCP URL: ${report.connector.mcpUrl ?? "unavailable"}`,
    `runtime PID: ${report.runtime.pid ?? "unknown"}`,
    `schema revision: ${report.runtime.schemaRevision ?? "unknown"}`,
    `local health: ${report.connector.localHealth.category}`,
    `public health: ${report.connector.publicHealth.category}`,
    `OAuth metadata: ${report.connector.oauthMetadata.category}`,
  ];
  if (report.blockers.length > 0) {
    lines.push("", "Blockers:", ...report.blockers.map((entry) => `- ${entry}`));
  }
  lines.push("", "Safe blue-green steps:", ...report.steps.map((entry, index) => `${index + 1}. ${entry}`));
  lines.push("", "Fresh-chat acceptance prompt:", "---", report.acceptancePrompt, "---");
  return lines.join("\n");
}
