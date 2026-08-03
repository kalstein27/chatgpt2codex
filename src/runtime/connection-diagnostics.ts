import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

const LOG_FILE = "connection-events.jsonl";
const MAX_LOG_BYTES = 1024 * 1024;
const RETAIN_LOG_BYTES = 512 * 1024;
const MAX_STRING_LENGTH = 160;
const DEFAULT_RECENT_EVENTS = 40;
const MAX_RECENT_EVENTS = 200;

export type ConnectionDiagnosticOutcome = "success" | "failure" | "info";

export interface ConnectionDiagnosticInput {
  event: string;
  outcome: ConnectionDiagnosticOutcome;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  errorCode?: string;
  clientName?: string;
  tool?: string;
  sessionLabel?: string;
  jsonRpcMethod?: string;
  requestKind?: string;
  hasSessionHeader?: boolean;
  initializeRequest?: boolean;
  notification?: boolean;
  closeReason?: string;
  sessionDurationMs?: number;
  reconnectDelayMs?: number;
  sessionSetupMs?: number;
  requestCount?: number;
  reusedRequestCount?: number;
  activeSessionCount?: number;
}
export interface ConnectionDiagnosticEvent extends ConnectionDiagnosticInput {
  at: string;
  diagnosticId?: string;
}

export interface ConnectionDiagnosticSummary {
  logPath: string;
  lastEventAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailure?: ConnectionDiagnosticEvent;
  lifecycle: ConnectionLifecycleSummary;
  recentEvents: ConnectionDiagnosticEvent[];
}

export interface ConnectionLifecycleSummary {
  retainedEventCount: number;
  sessionStarts: number;
  normalRequestRotations: number;
  clientDisconnects: number;
  reconnects: number;
  transportErrors: number;
  serverCloses: {
    capacity: number;
    idleTtl: number;
    shutdown: number;
    other: number;
  };
  averageSessionDurationMs?: number;
  averageReconnectDelayMs?: number;
  averageSessionSetupMs?: number;
  averageRequestsPerSession?: number;
  averageReusedRequestsPerSession?: number;
}

export interface ConnectionDiagnosticsSink {
  readonly logPath: string;
  record(input: ConnectionDiagnosticInput): Promise<ConnectionDiagnosticEvent>;
  summary(limit?: number): Promise<ConnectionDiagnosticSummary>;
}

function bounded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[^\p{L}\p{N} ._:/@-]/gu, "").trim();
  return normalized ? normalized.slice(0, MAX_STRING_LENGTH) : undefined;
}

function safeEvent(input: ConnectionDiagnosticInput): ConnectionDiagnosticEvent {
  const failure = input.outcome === "failure";
  return {
    at: new Date().toISOString(),
    event: bounded(input.event) ?? "connection.event",
    outcome: input.outcome,
    ...(bounded(input.method) ? { method: bounded(input.method) } : {}),
    ...(bounded(input.path) ? { path: bounded(input.path) } : {}),
    ...(Number.isFinite(input.status) ? { status: input.status } : {}),
    ...(Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, Math.round(input.durationMs ?? 0)) } : {}),
    ...(bounded(input.errorCode) ? { errorCode: bounded(input.errorCode) } : {}),
    ...(bounded(input.clientName) ? { clientName: bounded(input.clientName) } : {}),
    ...(bounded(input.tool) ? { tool: bounded(input.tool) } : {}),
    ...(bounded(input.sessionLabel) ? { sessionLabel: bounded(input.sessionLabel) } : {}),
    ...(bounded(input.jsonRpcMethod) ? { jsonRpcMethod: bounded(input.jsonRpcMethod) } : {}),
    ...(bounded(input.requestKind) ? { requestKind: bounded(input.requestKind) } : {}),
    ...(typeof input.hasSessionHeader === "boolean" ? { hasSessionHeader: input.hasSessionHeader } : {}),
    ...(typeof input.initializeRequest === "boolean" ? { initializeRequest: input.initializeRequest } : {}),
    ...(typeof input.notification === "boolean" ? { notification: input.notification } : {}),
    ...(bounded(input.closeReason) ? { closeReason: bounded(input.closeReason) } : {}),
    ...(Number.isFinite(input.sessionDurationMs)
      ? { sessionDurationMs: Math.max(0, Math.round(input.sessionDurationMs ?? 0)) }
      : {}),
    ...(Number.isFinite(input.reconnectDelayMs)
      ? { reconnectDelayMs: Math.max(0, Math.round(input.reconnectDelayMs ?? 0)) }
      : {}),
    ...(Number.isFinite(input.sessionSetupMs)
      ? { sessionSetupMs: Math.max(0, Math.round(input.sessionSetupMs ?? 0)) }
      : {}),
    ...(Number.isFinite(input.requestCount) ? { requestCount: Math.max(0, Math.round(input.requestCount ?? 0)) } : {}),
    ...(Number.isFinite(input.reusedRequestCount)
      ? { reusedRequestCount: Math.max(0, Math.round(input.reusedRequestCount ?? 0)) }
      : {}),
    ...(Number.isFinite(input.activeSessionCount)
      ? { activeSessionCount: Math.max(0, Math.round(input.activeSessionCount ?? 0)) }
      : {}),
    ...(failure ? { diagnosticId: `diag_${randomUUID()}` } : {}),
  };
}

function roundedAverage(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function lifecycleSummary(events: ConnectionDiagnosticEvent[]): ConnectionLifecycleSummary {
  const sessionDurations = events.flatMap((event) =>
    Number.isFinite(event.sessionDurationMs) ? [Math.max(0, event.sessionDurationMs ?? 0)] : [],
  );
  const reconnectDelays = events.flatMap((event) =>
    Number.isFinite(event.reconnectDelayMs) ? [Math.max(0, event.reconnectDelayMs ?? 0)] : [],
  );
  const setupDurations = events.flatMap((event) =>
    Number.isFinite(event.sessionSetupMs) ? [Math.max(0, event.sessionSetupMs ?? 0)] : [],
  );
  const requestCounts = events.flatMap((event) =>
    Number.isFinite(event.requestCount) ? [Math.max(0, event.requestCount ?? 0)] : [],
  );
  const reusedRequestCounts = events.flatMap((event) =>
    Number.isFinite(event.reusedRequestCount) ? [Math.max(0, event.reusedRequestCount ?? 0)] : [],
  );
  const serverCloseEvents = events.filter((event) => event.event === "mcp.session_closed");
  return {
    retainedEventCount: events.length,
    sessionStarts: events.filter((event) => event.event === "mcp.session_opened").length,
    normalRequestRotations: events.filter((event) => event.event === "mcp.request_session_completed").length,
    clientDisconnects: events.filter((event) => event.event === "mcp.session_disconnected").length,
    reconnects: events.filter((event) => event.event === "mcp.session_reconnected").length,
    transportErrors: events.filter((event) => event.event === "mcp.transport_error").length,
    serverCloses: {
      capacity: serverCloseEvents.filter((event) => event.closeReason === "capacity").length,
      idleTtl: serverCloseEvents.filter((event) => event.closeReason === "idle_ttl").length,
      shutdown: serverCloseEvents.filter((event) => event.closeReason === "shutdown").length,
      other: serverCloseEvents.filter(
        (event) => !["capacity", "idle_ttl", "shutdown"].includes(event.closeReason ?? ""),
      ).length,
    },
    ...(roundedAverage(sessionDurations) !== undefined
      ? { averageSessionDurationMs: roundedAverage(sessionDurations) }
      : {}),
    ...(roundedAverage(reconnectDelays) !== undefined
      ? { averageReconnectDelayMs: roundedAverage(reconnectDelays) }
      : {}),
    ...(roundedAverage(setupDurations) !== undefined
      ? { averageSessionSetupMs: roundedAverage(setupDurations) }
      : {}),
    ...(roundedAverage(requestCounts) !== undefined
      ? { averageRequestsPerSession: roundedAverage(requestCounts) }
      : {}),
    ...(roundedAverage(reusedRequestCounts) !== undefined
      ? { averageReusedRequestsPerSession: roundedAverage(reusedRequestCounts) }
      : {}),
  };
}

function parseEvents(text: string): ConnectionDiagnosticEvent[] {
  const events: ConnectionDiagnosticEvent[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ConnectionDiagnosticEvent;
      if (parsed && typeof parsed.at === "string" && typeof parsed.event === "string") events.push(parsed);
    } catch {
      // A partial final line after an unclean process exit is ignored.
    }
  }
  return events;
}

export class FileConnectionDiagnostics implements ConnectionDiagnosticsSink {
  readonly logPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.logPath = path.join(stateDir, LOG_FILE);
  }

  record(input: ConnectionDiagnosticInput): Promise<ConnectionDiagnosticEvent> {
    const event = safeEvent(input);
    const write = this.queue.then(async () => {
      await mkdir(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
      await appendFile(this.logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(this.logPath, 0o600).catch(() => undefined);
      await this.trimIfNeeded();
      return event;
    });
    this.queue = write.catch(() => undefined);
    return write;
  }

  async summary(limit = DEFAULT_RECENT_EVENTS): Promise<ConnectionDiagnosticSummary> {
    await this.queue.catch(() => undefined);
    const boundedLimit = Math.min(MAX_RECENT_EVENTS, Math.max(1, Math.floor(limit)));
    const text = await readFile(this.logPath, "utf8").catch(() => "");
    const events = parseEvents(text);
    const recentEvents = events.slice(-boundedLimit);
    const lastSuccess = [...events].reverse().find((event) => event.outcome === "success");
    const lastFailure = [...events].reverse().find((event) => event.outcome === "failure");
    return {
      logPath: this.logPath,
      lastEventAt: events.at(-1)?.at,
      lastSuccessAt: lastSuccess?.at,
      lastFailureAt: lastFailure?.at,
      lastFailure,
      lifecycle: lifecycleSummary(events),
      recentEvents,
    };
  }

  private async trimIfNeeded(): Promise<void> {
    const info = await stat(this.logPath).catch(() => undefined);
    if (!info || info.size <= MAX_LOG_BYTES) return;
    const data = await readFile(this.logPath);
    let tail = data.subarray(Math.max(0, data.length - RETAIN_LOG_BYTES));
    const firstNewline = tail.indexOf(0x0a);
    if (firstNewline >= 0) tail = tail.subarray(firstNewline + 1);
    const tempPath = `${this.logPath}.${process.pid}.tmp`;
    await writeFile(tempPath, tail, { mode: 0o600 });
    await unlink(this.logPath).catch(() => undefined);
    await rename(tempPath, this.logPath);
    await chmod(this.logPath, 0o600).catch(() => undefined);
  }
}
