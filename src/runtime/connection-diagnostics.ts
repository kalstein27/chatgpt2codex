import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const LOG_FILE = "connection-events.jsonl";
const ARCHIVE_DIR = "connection-events-archive";
const MAX_LOG_BYTES = 1024 * 1024;
const ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_FILES = 128;
const MAX_SUMMARY_ARCHIVE_FILES = 4;
const MAX_STRING_LENGTH = 160;
const DEFAULT_RECENT_EVENTS = 40;
const MAX_RECENT_EVENTS = 200;

export type ConnectionDiagnosticOutcome = "success" | "failure" | "info";

export interface ConnectionDiagnosticSafeInputs {
  leasePreset?: "read-only" | "tests-only" | "full-write" | "image-only" | "control";
  requestedPreset?: "read-only" | "tests-only" | "full-write" | "image-only" | "control";
  requiredCapability?: "read" | "verify" | "write" | "image" | "remote" | "control";
  projectSelectPurpose?: "legacy-admin" | "control";
  confirmSwitch?: boolean;
  captureScreenshot?: boolean;
  label?: string;
  writesWorkspace?: boolean;
  needsNetwork?: boolean;
  destructive?: boolean;
  projectId?: string;
  commandId?: string;
}

export type ConnectionDiagnosticPhase =
  | "queued"
  | "approval"
  | "spawn"
  | "running"
  | "cleanup"
  | "serialize"
  | "transport"
  | "completed";

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
  probeResult?: "unsupported";
  resourceScheme?: string;
  resourceName?: string;
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
  operationId?: string;
  phase?: ConnectionDiagnosticPhase;
  actionStarted?: boolean;
  subprocessStarted?: boolean;
  subprocessStillRunning?: boolean;
  cleanupStarted?: boolean;
  cleanupCompleted?: boolean;
  commandStatus?: "SUCCESS" | "NONZERO_EXIT" | "TIMEOUT" | "SPAWN_FAILED" | "CANCELLED";
  cleanupStatus?: "NOT_REQUIRED" | "COMPLETED" | "FAILED";
  cancelledByClient?: boolean;
  progressHeartbeat?: boolean;
  safeInputs?: ConnectionDiagnosticSafeInputs;
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
  lastServerRequestAt?: string;
  lastToolDispatchAt?: string;
  serverObservedTransportError: boolean;
  hostFailureObservable: false;
  recommendedRecovery: "compare-server-receipt-and-dispatch";
  lastFailure?: ConnectionDiagnosticEvent;
  lifecycle: ConnectionLifecycleSummary;
  recentEvents: ConnectionDiagnosticEvent[];
  recentCommandEvents: ConnectionDiagnosticEvent[];
  clientCancellationRecovery?: ClientCancellationRecovery;
}

export interface ClientCancellationRecovery {
  observedAt: string;
  operationId?: string;
  tool?: string;
  projectId?: string;
  commandId?: string;
  state: "still-running" | "completed" | "failed" | "unknown";
  lastPhase?: ConnectionDiagnosticPhase;
  subprocessStarted?: boolean;
  subprocessStillRunning?: boolean;
  commandStatus?: "SUCCESS" | "NONZERO_EXIT" | "TIMEOUT" | "SPAWN_FAILED" | "CANCELLED";
  cleanupStatus?: "NOT_REQUIRED" | "COMPLETED" | "FAILED";
  automaticRetrySafe: false;
  recommendedAction:
    | "wait-and-recheck-connection-status"
    | "inspect-completed-result-before-retry"
    | "inspect-failure-before-retry"
    | "inspect-connection-audit-before-retry";
}

export interface ConnectionAuditOptions {
  since?: string;
  until?: string;
  slowRequestThresholdMs?: number;
  maxSlowRequests?: number;
  maxRecentFailures?: number;
}

export interface ConnectionAuditSummary {
  logPath: string;
  archiveDir: string;
  requestedSince?: string;
  requestedUntil?: string;
  firstEventAt?: string;
  lastEventAt?: string;
  sourceFileCount: number;
  eventCount: number;
  outcomes: Record<ConnectionDiagnosticOutcome, number>;
  failureCodes: Array<{ errorCode: string; count: number }>;
  tools: Array<{ tool: string; calls: number; failures: number }>;
  toolLatency: Array<{
    tool: string;
    count: number;
    slowCount: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }>;
  slowRequests: ConnectionDiagnosticEvent[];
  recentFailures: ConnectionDiagnosticEvent[];
  lifecycle: ConnectionLifecycleSummary;
}

export interface FileConnectionDiagnosticsOptions {
  maxLogBytes?: number;
  archiveRetentionMs?: number;
  maxArchiveFiles?: number;
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
  audit(options?: ConnectionAuditOptions): Promise<ConnectionAuditSummary>;
}

function bounded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[^\p{L}\p{N} ._:/@-]/gu, "").trim();
  return normalized ? normalized.slice(0, MAX_STRING_LENGTH) : undefined;
}

const SAFE_LEASE_PRESETS = new Set(["read-only", "tests-only", "full-write", "image-only", "control"]);
const SAFE_LEASE_CAPABILITIES = new Set(["read", "verify", "write", "image", "remote", "control"]);
const SAFE_DIAGNOSTIC_PHASES = new Set<ConnectionDiagnosticPhase>([
  "queued",
  "approval",
  "spawn",
  "running",
  "cleanup",
  "serialize",
  "transport",
  "completed",
]);
const SAFE_COMMAND_STATUSES = new Set(["SUCCESS", "NONZERO_EXIT", "TIMEOUT", "SPAWN_FAILED", "CANCELLED"]);
const SAFE_CLEANUP_STATUSES = new Set(["NOT_REQUIRED", "COMPLETED", "FAILED"]);

function safeDiagnosticInputs(
  input: ConnectionDiagnosticSafeInputs | undefined,
): ConnectionDiagnosticSafeInputs | undefined {
  if (!input) return undefined;
  const safe: ConnectionDiagnosticSafeInputs = {};
  if (typeof input.leasePreset === "string" && SAFE_LEASE_PRESETS.has(input.leasePreset)) {
    safe.leasePreset = input.leasePreset;
  }
  if (typeof input.requestedPreset === "string" && SAFE_LEASE_PRESETS.has(input.requestedPreset)) {
    safe.requestedPreset = input.requestedPreset;
  }
  if (typeof input.requiredCapability === "string" && SAFE_LEASE_CAPABILITIES.has(input.requiredCapability)) {
    safe.requiredCapability = input.requiredCapability;
  }
  if (input.projectSelectPurpose === "legacy-admin" || input.projectSelectPurpose === "control") {
    safe.projectSelectPurpose = input.projectSelectPurpose;
  }
  if (typeof input.confirmSwitch === "boolean") safe.confirmSwitch = input.confirmSwitch;
  if (typeof input.captureScreenshot === "boolean") safe.captureScreenshot = input.captureScreenshot;
  const label = bounded(input.label);
  if (label) safe.label = label;
  if (typeof input.writesWorkspace === "boolean") safe.writesWorkspace = input.writesWorkspace;
  if (typeof input.needsNetwork === "boolean") safe.needsNetwork = input.needsNetwork;
  if (typeof input.destructive === "boolean") safe.destructive = input.destructive;
  const projectId = bounded(input.projectId);
  if (projectId) safe.projectId = projectId;
  const commandId = bounded(input.commandId);
  if (commandId) safe.commandId = commandId;
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function safeEvent(input: ConnectionDiagnosticInput): ConnectionDiagnosticEvent {
  const failure = input.outcome === "failure";
  const safeInputs = safeDiagnosticInputs(input.safeInputs);
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
    ...(input.probeResult === "unsupported" ? { probeResult: input.probeResult } : {}),
    ...(bounded(input.resourceScheme) ? { resourceScheme: bounded(input.resourceScheme) } : {}),
    ...(bounded(input.resourceName) ? { resourceName: bounded(input.resourceName) } : {}),
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
    ...(bounded(input.operationId) ? { operationId: bounded(input.operationId) } : {}),
    ...(input.phase && SAFE_DIAGNOSTIC_PHASES.has(input.phase) ? { phase: input.phase } : {}),
    ...(typeof input.actionStarted === "boolean" ? { actionStarted: input.actionStarted } : {}),
    ...(typeof input.subprocessStarted === "boolean" ? { subprocessStarted: input.subprocessStarted } : {}),
    ...(typeof input.subprocessStillRunning === "boolean" ? { subprocessStillRunning: input.subprocessStillRunning } : {}),
    ...(typeof input.cleanupStarted === "boolean" ? { cleanupStarted: input.cleanupStarted } : {}),
    ...(typeof input.cleanupCompleted === "boolean" ? { cleanupCompleted: input.cleanupCompleted } : {}),
    ...(input.commandStatus && SAFE_COMMAND_STATUSES.has(input.commandStatus) ? { commandStatus: input.commandStatus } : {}),
    ...(input.cleanupStatus && SAFE_CLEANUP_STATUSES.has(input.cleanupStatus) ? { cleanupStatus: input.cleanupStatus } : {}),
    ...(typeof input.cancelledByClient === "boolean" ? { cancelledByClient: input.cancelledByClient } : {}),
    ...(typeof input.progressHeartbeat === "boolean" ? { progressHeartbeat: input.progressHeartbeat } : {}),
    ...(safeInputs ? { safeInputs } : {}),
    ...(failure ? { diagnosticId: `diag_${randomUUID()}` } : {}),
  };
}

function roundedAverage(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index] ?? 0);
}

function recentCommandEvents(events: ConnectionDiagnosticEvent[], limit = 20): ConnectionDiagnosticEvent[] {
  return events
    .filter((event) =>
      event.event === "mcp.client_cancelled"
      || event.event === "command.lifecycle"
      || (event.event === "tool.progress" && event.tool === "command_run"),
    )
    .slice(-limit);
}

function clientCancellationRecovery(
  events: ConnectionDiagnosticEvent[],
): ClientCancellationRecovery | undefined {
  const cancelled = [...events].reverse().find(
    (event) => event.event === "mcp.client_cancelled" && event.cancelledByClient === true,
  );
  if (!cancelled) return undefined;

  const safeInputs = cancelled.safeInputs;
  const correlated = cancelled.operationId
    ? events.filter(
        (event) => event.operationId === cancelled.operationId && Date.parse(event.at) >= Date.parse(cancelled.at),
      )
    : [];
  const lastLifecycle = [...correlated].reverse().find((event) => event.event === "command.lifecycle");
  const terminalToolCall = [...correlated].reverse().find((event) => event.event === "tool.call");

  let state: ClientCancellationRecovery["state"] = "unknown";
  let recommendedAction: ClientCancellationRecovery["recommendedAction"] =
    "inspect-connection-audit-before-retry";
  if (lastLifecycle?.phase === "completed") {
    const lifecycleFailed = Boolean(
      (lastLifecycle.commandStatus && lastLifecycle.commandStatus !== "SUCCESS")
      || (lastLifecycle.cleanupStatus && lastLifecycle.cleanupStatus === "FAILED"),
    );
    state = lifecycleFailed ? "failed" : "completed";
    recommendedAction = lifecycleFailed
      ? "inspect-failure-before-retry"
      : "inspect-completed-result-before-retry";
  } else if (terminalToolCall?.outcome === "success") {
    state = "completed";
    recommendedAction = "inspect-completed-result-before-retry";
  } else if (terminalToolCall?.outcome === "failure") {
    state = "failed";
    recommendedAction = "inspect-failure-before-retry";
  } else if (lastLifecycle && ["approval", "spawn", "running", "cleanup", "serialize"].includes(lastLifecycle.phase ?? "")) {
    state = "still-running";
    recommendedAction = "wait-and-recheck-connection-status";
  }

  return {
    observedAt: cancelled.at,
    ...(cancelled.operationId ? { operationId: cancelled.operationId } : {}),
    ...(cancelled.tool ? { tool: cancelled.tool } : {}),
    ...(safeInputs?.projectId ? { projectId: safeInputs.projectId } : {}),
    ...(safeInputs?.commandId ? { commandId: safeInputs.commandId } : {}),
    state,
    ...(lastLifecycle?.phase ? { lastPhase: lastLifecycle.phase } : {}),
    ...(typeof lastLifecycle?.subprocessStarted === "boolean"
      ? { subprocessStarted: lastLifecycle.subprocessStarted }
      : {}),
    ...(typeof lastLifecycle?.subprocessStillRunning === "boolean"
      ? { subprocessStillRunning: lastLifecycle.subprocessStillRunning }
      : {}),
    ...(lastLifecycle?.commandStatus ? { commandStatus: lastLifecycle.commandStatus } : {}),
    ...(lastLifecycle?.cleanupStatus ? { cleanupStatus: lastLifecycle.cleanupStatus } : {}),
    automaticRetrySafe: false,
    recommendedAction,
  };
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
  readonly archiveDir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxLogBytes: number;
  private readonly archiveRetentionMs: number;
  private readonly maxArchiveFiles: number;

  constructor(stateDir: string, options: FileConnectionDiagnosticsOptions = {}) {
    this.logPath = path.join(stateDir, LOG_FILE);
    this.archiveDir = path.join(stateDir, ARCHIVE_DIR);
    this.maxLogBytes = Math.max(1, options.maxLogBytes ?? MAX_LOG_BYTES);
    this.archiveRetentionMs = Math.max(1, options.archiveRetentionMs ?? ARCHIVE_RETENTION_MS);
    this.maxArchiveFiles = Math.max(1, options.maxArchiveFiles ?? MAX_ARCHIVE_FILES);
  }

  record(input: ConnectionDiagnosticInput): Promise<ConnectionDiagnosticEvent> {
    const event = safeEvent(input);
    const write = this.queue.then(async () => {
      await mkdir(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
      await appendFile(this.logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(this.logPath, 0o600).catch(() => undefined);
      await this.rotateIfNeeded();
      return event;
    });
    this.queue = write.catch(() => undefined);
    return write;
  }

  async summary(limit = DEFAULT_RECENT_EVENTS): Promise<ConnectionDiagnosticSummary> {
    await this.queue.catch(() => undefined);
    const boundedLimit = Math.min(MAX_RECENT_EVENTS, Math.max(1, Math.floor(limit)));
    const archivePaths = (await this.listArchivePaths()).slice(-MAX_SUMMARY_ARCHIVE_FILES);
    const sourcePaths = [...archivePaths, this.logPath];
    const texts = await Promise.all(sourcePaths.map((filePath) => readFile(filePath, "utf8").catch(() => "")));
    const events = texts
      .flatMap((text) => parseEvents(text))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const recentEvents = events.slice(-boundedLimit);
    const lastSuccess = [...events].reverse().find((event) => event.outcome === "success");
    const lastFailure = [...events].reverse().find((event) => event.outcome === "failure");
    const lastServerRequest = [...events].reverse().find((event) => event.event === "mcp.authenticated_request_received");
    const lastToolDispatch = [...events].reverse().find((event) => event.event === "tool.dispatch");
    const lifecycle = lifecycleSummary(events);
    const cancellationRecovery = clientCancellationRecovery(events);
    return {
      logPath: this.logPath,
      lastEventAt: events.at(-1)?.at,
      lastSuccessAt: lastSuccess?.at,
      lastFailureAt: lastFailure?.at,
      lastServerRequestAt: lastServerRequest?.at,
      lastToolDispatchAt: lastToolDispatch?.at,
      serverObservedTransportError: lifecycle.transportErrors > 0,
      hostFailureObservable: false,
      recommendedRecovery: "compare-server-receipt-and-dispatch",
      lastFailure,
      lifecycle,
      recentEvents,
      recentCommandEvents: recentCommandEvents(events),
      ...(cancellationRecovery ? { clientCancellationRecovery: cancellationRecovery } : {}),
    };
  }

  async audit(options: ConnectionAuditOptions = {}): Promise<ConnectionAuditSummary> {
    await this.queue.catch(() => undefined);
    const sinceMs = options.since ? Date.parse(options.since) : Number.NEGATIVE_INFINITY;
    const untilMs = options.until ? Date.parse(options.until) : Number.POSITIVE_INFINITY;
    const slowRequestThresholdMs = Math.max(0, options.slowRequestThresholdMs ?? 1_000);
    const maxSlowRequests = Math.min(50, Math.max(1, Math.floor(options.maxSlowRequests ?? 20)));
    const maxRecentFailures = Math.min(50, Math.max(1, Math.floor(options.maxRecentFailures ?? 20)));
    const archivePaths = await this.listArchivePaths();
    const sourcePaths = [...archivePaths, this.logPath];
    const texts = await Promise.all(sourcePaths.map((filePath) => readFile(filePath, "utf8").catch(() => "")));
    const events = texts
      .flatMap((text) => parseEvents(text))
      .filter((event) => {
        const at = Date.parse(event.at);
        return Number.isFinite(at) && at >= sinceMs && at <= untilMs;
      })
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    const failureCodeCounts = new Map<string, number>();
    const toolCounts = new Map<string, { calls: number; failures: number }>();
    const toolDurations = new Map<string, number[]>();
    for (const event of events) {
      if (event.outcome === "failure") {
        const code = event.errorCode ?? "UNKNOWN";
        failureCodeCounts.set(code, (failureCodeCounts.get(code) ?? 0) + 1);
      }
      if (event.event === "tool.call" && event.tool) {
        const current = toolCounts.get(event.tool) ?? { calls: 0, failures: 0 };
        current.calls += 1;
        if (event.outcome === "failure") current.failures += 1;
        toolCounts.set(event.tool, current);
        if (Number.isFinite(event.durationMs)) {
          const durations = toolDurations.get(event.tool) ?? [];
          durations.push(Math.max(0, event.durationMs ?? 0));
          toolDurations.set(event.tool, durations);
        }
      }
    }

    return {
      logPath: this.logPath,
      archiveDir: this.archiveDir,
      ...(options.since ? { requestedSince: options.since } : {}),
      ...(options.until ? { requestedUntil: options.until } : {}),
      firstEventAt: events.at(0)?.at,
      lastEventAt: events.at(-1)?.at,
      sourceFileCount: sourcePaths.length,
      eventCount: events.length,
      outcomes: {
        success: events.filter((event) => event.outcome === "success").length,
        failure: events.filter((event) => event.outcome === "failure").length,
        info: events.filter((event) => event.outcome === "info").length,
      },
      failureCodes: [...failureCodeCounts.entries()]
        .map(([errorCode, count]) => ({ errorCode, count }))
        .sort((a, b) => b.count - a.count || a.errorCode.localeCompare(b.errorCode)),
      tools: [...toolCounts.entries()]
        .map(([tool, counts]) => ({ tool, ...counts }))
        .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
      toolLatency: [...toolDurations.entries()]
        .map(([tool, durations]) => ({
          tool,
          count: durations.length,
          slowCount: durations.filter((duration) => duration >= slowRequestThresholdMs).length,
          p50Ms: percentile(durations, 0.50),
          p95Ms: percentile(durations, 0.95),
          p99Ms: percentile(durations, 0.99),
        }))
        .sort((a, b) => b.p95Ms - a.p95Ms || a.tool.localeCompare(b.tool)),
      slowRequests: events
        .filter((event) => (event.durationMs ?? -1) >= slowRequestThresholdMs)
        .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0) || b.at.localeCompare(a.at))
        .slice(0, maxSlowRequests),
      recentFailures: events.filter((event) => event.outcome === "failure").slice(-maxRecentFailures),
      lifecycle: lifecycleSummary(events),
    };
  }

  private async listArchivePaths(): Promise<string[]> {
    const entries = await readdir(this.archiveDir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && /^connection-events-.*\.jsonl$/u.test(entry.name))
      .map((entry) => path.join(this.archiveDir, entry.name))
      .sort();
  }

  private async rotateIfNeeded(): Promise<void> {
    const info = await stat(this.logPath).catch(() => undefined);
    if (!info || info.size <= this.maxLogBytes) return;
    await mkdir(this.archiveDir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const archivePath = path.join(
      this.archiveDir,
      `connection-events-${timestamp}-${randomUUID().slice(0, 8)}.jsonl`,
    );
    await rename(this.logPath, archivePath);
    await chmod(archivePath, 0o600).catch(() => undefined);
    await writeFile(this.logPath, "", { mode: 0o600 });
    await chmod(this.logPath, 0o600).catch(() => undefined);
    await this.pruneArchives();
  }

  private async pruneArchives(now = Date.now()): Promise<void> {
    const paths = await this.listArchivePaths();
    const entries: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const filePath of paths) {
      const info = await stat(filePath).catch(() => undefined);
      if (info) entries.push({ filePath, mtimeMs: info.mtimeMs });
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const expired = entries.filter((entry) => now - entry.mtimeMs > this.archiveRetentionMs);
    const retained = entries.filter((entry) => now - entry.mtimeMs <= this.archiveRetentionMs);
    const overflow = retained.slice(0, Math.max(0, retained.length - this.maxArchiveFiles));
    await Promise.all([...expired, ...overflow].map((entry) => rm(entry.filePath, { force: true })));
  }
}
