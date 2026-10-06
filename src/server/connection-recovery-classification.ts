import type { ConnectionDiagnosticSummary } from "../runtime/connection-diagnostics.js";
import type { TurnLossRecoveryEvidence } from "../runtime/connection-diagnostics.js";
import type { ExternalWatchdogProbeWindow, ExternalWatchdogStatus } from "../runtime/external-watchdog-status.js";

export type ConnectionRecoveryClassification =
  | "pre-server-transient-likely"
  | "server-dispatched-failure"
  | "server-transport-failure-likely"
  | "runtime-changed"
  | "indeterminate";

export interface ConnectionRecoveryAssessment {
  classification: ConnectionRecoveryClassification;
  confidence: "high" | "medium" | "low";
  automaticRetrySafe: false;
  failureStage:
    | "pre-server"
    | "server-received"
    | "server-dispatched"
    | "runtime-service"
    | "runtime-changed"
    | "unknown";
  requestReachedServer: boolean | null;
  dispatchStarted: boolean | null;
  runtimeHealthy: boolean | null;
  continueOriginalGoal: boolean;
  runtimeRestartRecommended: boolean;
  boundedRecoveryRecommended: boolean;
  recoveryWindow?: {
    maxWindowMs: number;
    startedAt: string | null;
    elapsedMs: number;
    remainingMs: number;
    recheckAfterMs: number;
    routeRecovered: boolean;
    exhausted: boolean;
  };
  evidence: {
    recentServerFailure: boolean;
    serverObservedTransportError: boolean;
    runtimeFingerprintMatched: boolean | null;
    watchdogStatus: "healthy" | "unhealthy" | "unknown" | "unavailable";
    watchdogFresh: boolean | null;
    watchdogFailureReason: string | null;
    watchdogProbeClass: string | null;
    watchdogIncidentId: string | null;
    watchdogFailureLayer: string | null;
    lastObservableRequestReachedServer: boolean | null;
    lastObservableDispatchStarted: boolean | null;
    lastObservableTerminalOutcome: "success" | "failure" | null;
    failedTool: string | null;
    toolRecoveryClass: "read-only" | "presentation" | "capability-acquisition" | "ordinary-mutation" | "critical-mutation" | "unknown";
    toolRecoveryPolicy:
      | "read-only-reissue-after-route-recovery"
      | "retry-presentation-only-after-route-recovery"
      | "reconcile-capability-then-reacquire-if-absent"
      | "status-first-no-blind-replay"
      | "persisted-status-only-no-mutation-replay"
      | "inspect-before-action";
    toolRecoveryFirst: string | null;
    blindReplayAllowed: false;
  };
  recommendedAction:
    | "call-agent-guide-then-continue-without-runtime-restart"
    | "wait-bounded-and-recheck-then-continue"
    | "inspect-server-failure-or-persisted-operation-before-retry"
    | "inspect-transport-and-watchdog-before-recovery"
    | "inspect-runtime-health-before-restart"
    | "rebootstrap-on-current-runtime-before-continuing"
    | "inspect-connection-audit-before-retry";
}

const RECENT_FAILURE_WINDOW_MS = 30_000;
const RECENT_TURN_ABANDONMENT_WINDOW_MS = 15 * 60 * 1_000;
const CONNECTION_RECOVERY_GRACE_MS = 90_000;
const CONNECTION_RECOVERY_RECHECK_MS = 5_000;

const READ_ONLY_RECOVERY_TOOLS = new Set([
  "agent_bootstrap", "agent_guide", "connection_audit", "connection_status", "project_rules", "project_status",
  "repo_status", "git_status", "code_search", "code_search_batch", "file_read_slice", "file_read_batch", "command_list",
  "operation_status", "output_read", "mutation_status", "runtime_apply_status", "macos_app_apply_status",
  "chatgpt_catalog_refresh_status", "tool_schema_get", "managed_mcp_list", "managed_mcp_status", "managed_mcp_logs",
  "managed_mcp_tools", "managed_mcp_resources", "managed_mcp_read_resource", "host_management_status", "project_lane_status",
]);
const CAPABILITY_RECOVERY_TOOLS = new Set([
  "project_lane_open", "project_lane_renew", "project_lane_recover", "project_select", "project_renew_lease",
  "host_management_acquire",
]);
const CRITICAL_MUTATION_RECOVERY_TOOLS = new Set([
  "runtime_apply_local", "macos_app_apply_local", "verified_local_file_apply",
]);
const VERSIONED_OPERATION_APPROVAL_PRESENTER_RE = /^chatgpt_operation_approval_presenter_v\d+$/u;
const PRESENTATION_RECOVERY_TOOLS = new Set([
  "chatgpt_manual_refresh_presenter_v1",
  "chatgpt_catalog_reentry_presenter_v1",
  "chatgpt_widget_preapply_presenter_v1",
  "chatgpt_widget_lab_presenter",
  "chatgpt_consent_probe",
]);

function toolRecoveryPolicy(failedTool: string | undefined): {
  toolRecoveryClass: ConnectionRecoveryAssessment["evidence"]["toolRecoveryClass"];
  toolRecoveryPolicy: ConnectionRecoveryAssessment["evidence"]["toolRecoveryPolicy"];
  toolRecoveryFirst: string | null;
} {
  if (!failedTool) return { toolRecoveryClass: "unknown", toolRecoveryPolicy: "inspect-before-action", toolRecoveryFirst: null };
  if (PRESENTATION_RECOVERY_TOOLS.has(failedTool) || VERSIONED_OPERATION_APPROVAL_PRESENTER_RE.test(failedTool)) {
    return { toolRecoveryClass: "presentation", toolRecoveryPolicy: "retry-presentation-only-after-route-recovery", toolRecoveryFirst: failedTool };
  }
  if (READ_ONLY_RECOVERY_TOOLS.has(failedTool)) {
    return { toolRecoveryClass: "read-only", toolRecoveryPolicy: "read-only-reissue-after-route-recovery", toolRecoveryFirst: null };
  }
  if (CAPABILITY_RECOVERY_TOOLS.has(failedTool)) {
    const recoveryFirst = failedTool === "project_lane_open"
      ? "project_lane_recover"
      : failedTool.startsWith("host_management_")
        ? "host_management_status"
        : failedTool === "project_select"
          ? "connection_status"
          : "project_lane_status";
    return { toolRecoveryClass: "capability-acquisition", toolRecoveryPolicy: "reconcile-capability-then-reacquire-if-absent", toolRecoveryFirst: recoveryFirst };
  }
  if (CRITICAL_MUTATION_RECOVERY_TOOLS.has(failedTool)) {
    const statusTool = failedTool === "runtime_apply_local"
      ? "runtime_apply_status"
      : failedTool === "macos_app_apply_local"
        ? "macos_app_apply_status"
        : failedTool === "chatgpt_catalog_refresh"
          ? "chatgpt_catalog_refresh_status"
          : "mutation_status";
    return { toolRecoveryClass: "critical-mutation", toolRecoveryPolicy: "persisted-status-only-no-mutation-replay", toolRecoveryFirst: statusTool };
  }
  return { toolRecoveryClass: "ordinary-mutation", toolRecoveryPolicy: "status-first-no-blind-replay", toolRecoveryFirst: "mutation_status" };
}

export interface ClientTurnAbandonmentAssessment {
  classification: "client-turn-abandonment-likely" | "indeterminate";
  confidence: "high" | "medium" | "low";
  automaticRetrySafe: false;
  evidence: {
    observedAt: string;
    projectId: string | null;
    idleMs: number | null;
    previousToolSucceeded: boolean;
    transportErrorObserved: boolean;
    unreleasedPrivilegedLaneObserved: true;
    watchdogStatus: "healthy" | "unhealthy" | "unknown" | "unavailable";
    watchdogFresh: boolean | null;
  };
  recommendedAction:
    | "continue-from-clean-state-without-mutation-replay"
    | "inspect-connection-audit-before-retry";
}

export function classifyClientTurnAbandonment(input: {
  recovery: TurnLossRecoveryEvidence | undefined;
  watchdog?: ExternalWatchdogStatus | null;
  watchdogWindow?: ExternalWatchdogProbeWindow | null;
  now?: number;
  allowHistorical?: boolean;
}): ClientTurnAbandonmentAssessment | null {
  if (!input.recovery) return null;
  const now = input.now ?? Date.now();
  const observedAtMs = Date.parse(input.recovery.observedAt);
  if (
    !input.allowHistorical
    && (!Number.isFinite(observedAtMs) || now - observedAtMs > RECENT_TURN_ABANDONMENT_WINDOW_MS)
  ) return null;

  const windowHasSamples = Boolean(input.watchdogWindow?.available && (input.watchdogWindow.sampleCount ?? 0) > 0);
  const watchdogStatus: ClientTurnAbandonmentAssessment["evidence"]["watchdogStatus"] = input.watchdog?.available
    ? input.watchdog.status
    : windowHasSamples
      ? (input.watchdogWindow?.unhealthySampleCount ?? 0) === 0 ? "healthy" : "unhealthy"
      : "unavailable";
  const watchdogFresh = input.watchdog?.available
    ? input.watchdog.probeFresh
    : windowHasSamples
      ? true
      : null;
  const evidence = {
    observedAt: input.recovery.observedAt,
    projectId: input.recovery.projectId ?? null,
    idleMs: input.recovery.idleMs ?? null,
    previousToolSucceeded: input.recovery.previousToolSucceeded,
    transportErrorObserved: input.recovery.transportErrorObserved,
    unreleasedPrivilegedLaneObserved: true as const,
    watchdogStatus,
    watchdogFresh,
  };
  const serverPathHealthy = input.recovery.previousToolSucceeded && !input.recovery.transportErrorObserved;
  const watchdogHealthy = watchdogStatus === "healthy" && watchdogFresh !== false;
  if (serverPathHealthy && watchdogHealthy) {
    return {
      classification: "client-turn-abandonment-likely",
      confidence: watchdogFresh === true ? "high" : "medium",
      automaticRetrySafe: false,
      evidence,
      recommendedAction: "continue-from-clean-state-without-mutation-replay",
    };
  }
  return {
    classification: "indeterminate",
    confidence: "low",
    automaticRetrySafe: false,
    evidence,
    recommendedAction: "inspect-connection-audit-before-retry",
  };
}

function previousObservableRequest(diagnostics: ConnectionDiagnosticSummary | null): {
  requestReachedServer: boolean | null;
  dispatchStarted: boolean | null;
  terminalOutcome: "success" | "failure" | null;
} {
  const events = diagnostics?.recentEvents ?? [];
  let end = events.length;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.event === "tool.dispatch" && event.tool === "connection_status") {
      end = index;
      break;
    }
  }

  let requestIndex = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (events[index]?.event === "mcp.authenticated_request_received") {
      requestIndex = index;
      break;
    }
  }
  if (requestIndex < 0) {
    return { requestReachedServer: null, dispatchStarted: null, terminalOutcome: null };
  }

  let dispatchIndex = -1;
  for (let index = requestIndex + 1; index < end; index += 1) {
    if (events[index]?.event === "tool.dispatch") {
      dispatchIndex = index;
      break;
    }
  }
  if (dispatchIndex < 0) {
    return { requestReachedServer: true, dispatchStarted: false, terminalOutcome: null };
  }

  const dispatch = events[dispatchIndex]!;
  let terminalOutcome: "success" | "failure" | null = null;
  for (let index = dispatchIndex + 1; index < end; index += 1) {
    const event = events[index]!;
    if (event.event !== "tool.call") continue;
    if (dispatch.operationId && event.operationId && event.operationId !== dispatch.operationId) continue;
    terminalOutcome = event.outcome === "success" ? "success" : event.outcome === "failure" ? "failure" : null;
  }
  return { requestReachedServer: true, dispatchStarted: true, terminalOutcome };
}

function boundedRecoveryWindow(input: {
  diagnostics: ConnectionDiagnosticSummary | null;
  watchdog: ExternalWatchdogStatus | null;
  now: number;
}): NonNullable<ConnectionRecoveryAssessment["recoveryWindow"]> {
  const failureAt = input.watchdog?.recentFailure?.at ?? input.diagnostics?.lastFailureAt ?? null;
  const failureAtMs = failureAt ? Date.parse(failureAt) : Number.NaN;
  const elapsedMs = Number.isFinite(failureAtMs) ? Math.max(0, input.now - failureAtMs) : 0;
  const routeRecovered = input.watchdog?.available === true
    && input.watchdog.status === "healthy"
    && input.watchdog.probeFresh !== false
    && (input.watchdog.probeWindow.recentSamples.at(-1)?.publicFunnelOk ?? true);
  const exhausted = !routeRecovered && elapsedMs >= CONNECTION_RECOVERY_GRACE_MS;
  const remainingMs = exhausted ? 0 : Math.max(0, CONNECTION_RECOVERY_GRACE_MS - elapsedMs);
  return {
    maxWindowMs: CONNECTION_RECOVERY_GRACE_MS,
    startedAt: Number.isFinite(failureAtMs) ? new Date(failureAtMs).toISOString() : null,
    elapsedMs,
    remainingMs,
    recheckAfterMs: routeRecovered ? 0 : Math.min(CONNECTION_RECOVERY_RECHECK_MS, remainingMs),
    routeRecovered,
    exhausted,
  };
}


export function classifyRecentHostFailure(input: {
  diagnostics: ConnectionDiagnosticSummary | null;
  watchdog: ExternalWatchdogStatus | null;
  currentRuntimeFingerprint: string;
  knownRuntimeFingerprint?: string;
  failedTool?: string;
  now?: number;
}): ConnectionRecoveryAssessment {
  const now = input.now ?? Date.now();
  const lastFailureAt = input.diagnostics?.lastFailureAt
    ? Date.parse(input.diagnostics.lastFailureAt)
    : Number.NaN;
  const recentServerFailure = Number.isFinite(lastFailureAt) && now - lastFailureAt <= RECENT_FAILURE_WINDOW_MS;
  const serverObservedTransportError = (input.diagnostics?.recentEvents ?? []).some((event) => {
    if (event.event !== "mcp.transport_error") return false;
    const at = Date.parse(event.at);
    return Number.isFinite(at) && now - at <= RECENT_FAILURE_WINDOW_MS;
  });
  const runtimeFingerprintMatched = input.knownRuntimeFingerprint
    ? input.knownRuntimeFingerprint === input.currentRuntimeFingerprint
    : null;
  const watchdogStatus = input.watchdog?.available ? input.watchdog.status : "unavailable";
  const watchdogFresh = input.watchdog?.available ? input.watchdog.probeFresh : null;
  const watchdogFailureReason = input.watchdog?.recentFailure?.category ?? input.watchdog?.lastFailureReason ?? null;
  const watchdogProbeClass = input.watchdog?.recentFailure?.probeClass ?? null;
  const latestProbe = input.watchdog?.probeWindow.recentSamples.at(-1);
  const runtimeHealthy = latestProbe ? latestProbe.localRuntimeOk : true;
  const observable = previousObservableRequest(input.diagnostics);
  const recoveryWindow = boundedRecoveryWindow({ diagnostics: input.diagnostics, watchdog: input.watchdog, now });
  const toolRecovery = toolRecoveryPolicy(input.failedTool);
  const evidence = {
    recentServerFailure,
    serverObservedTransportError,
    runtimeFingerprintMatched,
    watchdogStatus,
    watchdogFresh,
    watchdogFailureReason,
    watchdogProbeClass,
    watchdogIncidentId: input.watchdog?.incident?.incidentId ?? null,
    watchdogFailureLayer: input.watchdog?.incident?.latestFailureLayer ?? null,
    lastObservableRequestReachedServer: observable.requestReachedServer,
    lastObservableDispatchStarted: observable.dispatchStarted,
    lastObservableTerminalOutcome: observable.terminalOutcome,
    failedTool: input.failedTool ?? null,
    toolRecoveryClass: toolRecovery.toolRecoveryClass,
    toolRecoveryPolicy: toolRecovery.toolRecoveryPolicy,
    toolRecoveryFirst: toolRecovery.toolRecoveryFirst,
    blindReplayAllowed: false as const,
  } as const;

  if (runtimeFingerprintMatched === false) {
    return {
      classification: "runtime-changed",
      confidence: "high",
      automaticRetrySafe: false,
      failureStage: "runtime-changed",
      requestReachedServer: null,
      dispatchStarted: null,
      runtimeHealthy,
      continueOriginalGoal: true,
      runtimeRestartRecommended: false,
      boundedRecoveryRecommended: false,
      evidence,
      recommendedAction: "rebootstrap-on-current-runtime-before-continuing",
    };
  }

  if (runtimeHealthy === false && watchdogFresh !== false) {
    return {
      classification: "server-transport-failure-likely",
      confidence: "high",
      automaticRetrySafe: false,
      failureStage: "runtime-service",
      requestReachedServer: observable.requestReachedServer,
      dispatchStarted: observable.dispatchStarted,
      runtimeHealthy: false,
      continueOriginalGoal: false,
      runtimeRestartRecommended: true,
      boundedRecoveryRecommended: false,
      evidence,
      recommendedAction: "inspect-runtime-health-before-restart",
    };
  }

  if (
    recoveryWindow.exhausted
    && observable.dispatchStarted !== true
    && (
      observable.requestReachedServer === true
      || serverObservedTransportError
      || (watchdogStatus === "unhealthy" && watchdogFresh !== false)
    )
  ) {
    return {
      classification: "server-transport-failure-likely",
      confidence: "high",
      automaticRetrySafe: false,
      failureStage: observable.requestReachedServer === true ? "server-received" : "pre-server",
      requestReachedServer: observable.requestReachedServer,
      dispatchStarted: observable.dispatchStarted,
      runtimeHealthy,
      continueOriginalGoal: false,
      runtimeRestartRecommended: false,
      boundedRecoveryRecommended: false,
      recoveryWindow,
      evidence,
      recommendedAction: "inspect-connection-audit-before-retry",
    };
  }

  if (observable.requestReachedServer === true && observable.dispatchStarted === false) {
    return {
      classification: "server-transport-failure-likely",
      confidence: "high",
      automaticRetrySafe: false,
      failureStage: "server-received",
      requestReachedServer: true,
      dispatchStarted: false,
      runtimeHealthy,
      continueOriginalGoal: true,
      runtimeRestartRecommended: false,
      boundedRecoveryRecommended: true,
      recoveryWindow,
      evidence,
      recommendedAction: recoveryWindow.routeRecovered
        ? "call-agent-guide-then-continue-without-runtime-restart"
        : "wait-bounded-and-recheck-then-continue",
    };
  }

  if (observable.dispatchStarted === true && observable.terminalOutcome !== "success") {
    return {
      classification: "server-dispatched-failure",
      confidence: "high",
      automaticRetrySafe: false,
      failureStage: "server-dispatched",
      requestReachedServer: true,
      dispatchStarted: true,
      runtimeHealthy,
      continueOriginalGoal: false,
      runtimeRestartRecommended: false,
      boundedRecoveryRecommended: false,
      evidence,
      recommendedAction: "inspect-server-failure-or-persisted-operation-before-retry",
    };
  }

  if (recentServerFailure && observable.terminalOutcome !== "success") {
    return {
      classification: "server-dispatched-failure",
      confidence: "medium",
      automaticRetrySafe: false,
      failureStage: "server-dispatched",
      requestReachedServer: observable.requestReachedServer,
      dispatchStarted: observable.dispatchStarted,
      runtimeHealthy,
      continueOriginalGoal: false,
      runtimeRestartRecommended: false,
      boundedRecoveryRecommended: false,
      evidence,
      recommendedAction: "inspect-server-failure-or-persisted-operation-before-retry",
    };
  }

  if (serverObservedTransportError || (watchdogStatus === "unhealthy" && watchdogFresh !== false)) {
    return {
      classification: "server-transport-failure-likely",
      confidence: serverObservedTransportError && watchdogStatus === "unhealthy" ? "high" : "medium",
      automaticRetrySafe: false,
      failureStage: "pre-server",
      requestReachedServer: null,
      dispatchStarted: null,
      runtimeHealthy,
      continueOriginalGoal: true,
      runtimeRestartRecommended: false,
      boundedRecoveryRecommended: true,
      recoveryWindow,
      evidence,
      recommendedAction: recoveryWindow.routeRecovered
        ? "call-agent-guide-then-continue-without-runtime-restart"
        : "wait-bounded-and-recheck-then-continue",
    };
  }

  if (
    !recentServerFailure
    && !serverObservedTransportError
    && (watchdogStatus === "healthy" || watchdogStatus === "unavailable" || watchdogFresh === false)
  ) {
    return {
      classification: "pre-server-transient-likely",
      confidence: runtimeFingerprintMatched === true && watchdogStatus === "healthy" && watchdogFresh === true
        ? "high"
        : "medium",
      automaticRetrySafe: false,
      failureStage: "pre-server",
      requestReachedServer: false,
      dispatchStarted: false,
      runtimeHealthy,
      continueOriginalGoal: true,
      runtimeRestartRecommended: false,
      boundedRecoveryRecommended: true,
      recoveryWindow,
      evidence,
      recommendedAction: recoveryWindow.routeRecovered
        ? "call-agent-guide-then-continue-without-runtime-restart"
        : "wait-bounded-and-recheck-then-continue",
    };
  }

  return {
    classification: "indeterminate",
    confidence: "low",
    automaticRetrySafe: false,
    failureStage: "unknown",
    requestReachedServer: null,
    dispatchStarted: null,
    runtimeHealthy,
    continueOriginalGoal: false,
    runtimeRestartRecommended: false,
    boundedRecoveryRecommended: false,
    evidence,
    recommendedAction: "inspect-connection-audit-before-retry",
  };
}
