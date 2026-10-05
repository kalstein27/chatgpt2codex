import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_SCHEMA_VERSION = 1;
const MAX_RETIRED_GENERATIONS = 8;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface RuntimeGenerationEndpoint {
  generationId: string;
  runtimeRoot: string;
  pid: number;
  port: number;
}

export interface RuntimeGenerationRoutingState {
  schemaVersion: 1;
  revision: number;
  active: RuntimeGenerationEndpoint;
  candidate: RuntimeGenerationEndpoint | null;
  retired: RuntimeGenerationEndpoint[];
  updatedAt: string;
  switchedAt: string | null;
}

export interface RuntimeGenerationDispatch {
  dispatchGeneration: string;
  routingRevision: number;
  upstream: RuntimeGenerationEndpoint;
  replayPolicy: "never-auto-replay";
}

export interface RuntimeGenerationRouterOptions {
  stateDir: string;
  host?: string;
  port: number;
  onDispatch?: (dispatch: RuntimeGenerationDispatch, request: IncomingMessage) => void | Promise<void>;
  onProxyError?: (error: Error, dispatch: RuntimeGenerationDispatch, request: IncomingMessage) => void | Promise<void>;
}

function statePath(stateDir: string): string {
  return path.join(stateDir, "runtime-router-state.json");
}

function validEndpoint(value: unknown): value is RuntimeGenerationEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const endpoint = value as Partial<RuntimeGenerationEndpoint>;
  return typeof endpoint.generationId === "string"
    && GENERATION_PATTERN.test(endpoint.generationId)
    && typeof endpoint.runtimeRoot === "string"
    && path.isAbsolute(endpoint.runtimeRoot)
    && Number.isSafeInteger(endpoint.pid)
    && Number(endpoint.pid) > 0
    && Number.isSafeInteger(endpoint.port)
    && Number(endpoint.port) > 0
    && Number(endpoint.port) <= 65_535;
}

function validateState(value: unknown): RuntimeGenerationRoutingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime router state is malformed");
  }
  const state = value as Partial<RuntimeGenerationRoutingState>;
  if (
    state.schemaVersion !== STATE_SCHEMA_VERSION
    || !Number.isSafeInteger(state.revision)
    || Number(state.revision) < 1
    || !validEndpoint(state.active)
    || (state.candidate !== null && state.candidate !== undefined && !validEndpoint(state.candidate))
    || !Array.isArray(state.retired)
    || state.retired.some((entry) => !validEndpoint(entry))
    || typeof state.updatedAt !== "string"
    || (state.switchedAt !== null && state.switchedAt !== undefined && typeof state.switchedAt !== "string")
  ) {
    throw new Error("runtime router state is malformed");
  }
  return {
    schemaVersion: 1,
    revision: Number(state.revision),
    active: state.active,
    candidate: state.candidate ?? null,
    retired: state.retired,
    updatedAt: state.updatedAt,
    switchedAt: state.switchedAt ?? null,
  };
}

function validateEndpoint(endpoint: RuntimeGenerationEndpoint): RuntimeGenerationEndpoint {
  if (!validEndpoint(endpoint)) throw new Error("runtime generation endpoint is invalid");
  return {
    generationId: endpoint.generationId,
    runtimeRoot: path.resolve(endpoint.runtimeRoot),
    pid: endpoint.pid,
    port: endpoint.port,
  };
}

async function ensurePrivateStateDir(stateDir: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(stateDir, DIR_MODE).catch(() => undefined);
}

async function writeStateAtomic(stateDir: string, state: RuntimeGenerationRoutingState): Promise<void> {
  await ensurePrivateStateDir(stateDir);
  const destination = statePath(stateDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
  await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
  try {
    await fs.rename(temporary, destination);
    await fs.chmod(destination, FILE_MODE).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function readRuntimeGenerationRoutingState(stateDir: string): Promise<RuntimeGenerationRoutingState> {
  const parsed = JSON.parse(await fs.readFile(statePath(stateDir), "utf8")) as unknown;
  return validateState(parsed);
}

export async function initializeRuntimeGenerationRoutingState(
  stateDir: string,
  active: RuntimeGenerationEndpoint,
  now = new Date(),
): Promise<RuntimeGenerationRoutingState> {
  const state: RuntimeGenerationRoutingState = {
    schemaVersion: 1,
    revision: 1,
    active: validateEndpoint(active),
    candidate: null,
    retired: [],
    updatedAt: now.toISOString(),
    switchedAt: null,
  };
  await writeStateAtomic(stateDir, state);
  return state;
}

export async function stageRuntimeGenerationCandidate(
  stateDir: string,
  candidate: RuntimeGenerationEndpoint,
  now = new Date(),
): Promise<RuntimeGenerationRoutingState> {
  const current = await readRuntimeGenerationRoutingState(stateDir);
  const normalized = validateEndpoint(candidate);
  if (normalized.generationId === current.active.generationId) {
    throw new Error("candidate generation must differ from the active generation");
  }
  if (current.candidate && current.candidate.generationId !== normalized.generationId) {
    throw new Error("a different runtime candidate is already staged");
  }
  const next: RuntimeGenerationRoutingState = {
    ...current,
    revision: current.revision + 1,
    candidate: normalized,
    updatedAt: now.toISOString(),
  };
  await writeStateAtomic(stateDir, next);
  return next;
}

export async function activateRuntimeGenerationCandidate(
  stateDir: string,
  generationId: string,
  now = new Date(),
): Promise<RuntimeGenerationRoutingState> {
  if (!GENERATION_PATTERN.test(generationId)) throw new Error("candidate generation id is invalid");
  const current = await readRuntimeGenerationRoutingState(stateDir);
  const candidate = current.candidate;
  if (!candidate || candidate.generationId !== generationId) {
    throw new Error("requested runtime candidate is not staged");
  }
  const retired = [...current.retired, current.active].slice(-MAX_RETIRED_GENERATIONS);
  const switchedAt = now.toISOString();
  const next: RuntimeGenerationRoutingState = {
    schemaVersion: 1,
    revision: current.revision + 1,
    active: candidate,
    candidate: null,
    retired,
    updatedAt: switchedAt,
    switchedAt,
  };
  await writeStateAtomic(stateDir, next);
  return next;
}

export async function clearRuntimeGenerationCandidate(
  stateDir: string,
  generationId: string,
  now = new Date(),
): Promise<RuntimeGenerationRoutingState> {
  const current = await readRuntimeGenerationRoutingState(stateDir);
  if (!current.candidate || current.candidate.generationId !== generationId) return current;
  const next: RuntimeGenerationRoutingState = {
    ...current,
    revision: current.revision + 1,
    candidate: null,
    updatedAt: now.toISOString(),
  };
  await writeStateAtomic(stateDir, next);
  return next;
}

export async function captureRuntimeGenerationDispatch(stateDir: string): Promise<RuntimeGenerationDispatch> {
  const state = await readRuntimeGenerationRoutingState(stateDir);
  return {
    dispatchGeneration: state.active.generationId,
    routingRevision: state.revision,
    upstream: { ...state.active },
    replayPolicy: "never-auto-replay",
  };
}

function sanitizeForwardHeaders(
  headers: IncomingHttpHeaders,
  incomingHost: string | undefined,
  routerPort: number,
  upstreamPort: number,
): IncomingHttpHeaders {
  const next: IncomingHttpHeaders = { ...headers };
  for (const name of [
    "connection",
    "proxy-connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete next[name];
  }
  const normalizedHost = (incomingHost ?? "").trim().toLowerCase();
  if (
    normalizedHost === `127.0.0.1:${routerPort}`
    || normalizedHost === `localhost:${routerPort}`
    || normalizedHost === `[::1]:${routerPort}`
  ) {
    next.host = `127.0.0.1:${upstreamPort}`;
  }
  return next;
}

function copyUpstreamHeaders(source: IncomingHttpHeaders, response: ServerResponse): void {
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      lower === "connection"
      || lower === "proxy-connection"
      || lower === "keep-alive"
      || lower === "transfer-encoding"
      || lower === "upgrade"
    ) continue;
    response.setHeader(name, value);
  }
}

async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dispatch: RuntimeGenerationDispatch,
  routerPort: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const upstreamRequest = http.request({
      host: "127.0.0.1",
      port: dispatch.upstream.port,
      method: request.method,
      path: request.url,
      headers: {
        ...sanitizeForwardHeaders(request.headers, request.headers.host, routerPort, dispatch.upstream.port),
        "x-chatgpt2codex-dispatch-generation": dispatch.dispatchGeneration,
        "x-chatgpt2codex-routing-revision": String(dispatch.routingRevision),
      },
    });

    let headersForwarded = false;
    upstreamRequest.once("response", (upstreamResponse) => {
      headersForwarded = true;
      response.statusCode = upstreamResponse.statusCode ?? 502;
      if (upstreamResponse.statusMessage) response.statusMessage = upstreamResponse.statusMessage;
      copyUpstreamHeaders(upstreamResponse.headers, response);
      upstreamResponse.once("error", reject);
      response.once("close", resolve);
      upstreamResponse.pipe(response);
    });
    upstreamRequest.once("error", (error) => {
      if (headersForwarded || response.headersSent) {
        response.destroy(error);
      }
      reject(error);
    });
    request.once("aborted", () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  });
}

export function createRuntimeGenerationRouterServer(options: RuntimeGenerationRouterOptions): Server {
  return http.createServer(async (request, response) => {
    let dispatch: RuntimeGenerationDispatch | undefined;
    try {
      dispatch = await captureRuntimeGenerationDispatch(options.stateDir);
      await options.onDispatch?.(dispatch, request);
      await proxyRequest(request, response, dispatch, options.port);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (dispatch) await options.onProxyError?.(failure, dispatch, request);
      if (!response.headersSent) {
        response.statusCode = 502;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "runtime_upstream_unavailable" }));
      } else {
        response.destroy(failure);
      }
    }
  });
}

export async function appendRuntimeRouterDispatchLog(
  logFile: string,
  dispatch: RuntimeGenerationDispatch,
  request: IncomingMessage,
): Promise<void> {
  const rawUrl = request.url ?? "/";
  let pathname = "/";
  try {
    pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
  } catch {
    pathname = "/";
  }
  await fs.mkdir(path.dirname(logFile), { recursive: true, mode: DIR_MODE });
  const entry = {
    at: new Date().toISOString(),
    method: request.method ?? "UNKNOWN",
    pathname,
    dispatchGeneration: dispatch.dispatchGeneration,
    routingRevision: dispatch.routingRevision,
    upstreamPid: dispatch.upstream.pid,
    upstreamPort: dispatch.upstream.port,
    replayPolicy: dispatch.replayPolicy,
  };
  await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
}
