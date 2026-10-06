import type {
  ConnectionDiagnosticEvent,
  ConnectionDiagnosticSummary,
} from "../runtime/connection-diagnostics.js";
import type { ExternalWatchdogStatus } from "../runtime/external-watchdog-status.js";

const RECENT_HEALTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_HEALTH_EVENTS = 16;

const RECOVERABLE_FAILURE_CODES = new Set([
  "INVALID_ARGUMENT",
  "LEASE_REQUIRED",
  "LEASE_EXPIRED",
  "ACTIVE_PROJECT_LEASE_HELD",
  "PROJECT_NOT_FOUND",
  "PROJECT_NOT_SELECTED",
  "AMBIGUOUS_PROJECT",
  "WORKSPACE_NOT_READY",
  "APPROVAL_REQUIRED",
  "CONFIRMATION_PENDING",
  "PENDING_WORK_IN_ACTIVE",
  "ACTIVE_OPERATION_IN_PROGRESS",
  "RUNTIME_UPDATE_IN_PROGRESS",
]);

export type ActivityMcpHealthState = "healthy" | "degraded" | "unhealthy";
export type ActivityMcpFailureClass = "recoverable" | "transport" | "runtime" | "operation";

export interface ActivityMcpHealthEvent {
  at: string;
  event: string;
  outcome: "success" | "failure" | "info";
  errorCode?: string;
  tool?: string;
  phase?: string;
  diagnosticId?: string;
  classification?: ActivityMcpFailureClass;
}

export interface ActivityMcpHealth {
  state: ActivityMcpHealthState;
  label: "Healthy" | "Degraded" | "Unhealthy";
  reason: string;
  generatedAt: number;
  recentFailureCount: number;
  recentRecoverableFailureCount: number;
  recentTransportFailureCount: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  watchdogStatus: "healthy" | "unhealthy" | "unknown" | "unavailable";
  watchdogProbeFresh: boolean | null;
  watchdogConsecutiveFailures: number;
  watchdogProbeAgeMs: number | null;
  watchdogIncident: ExternalWatchdogStatus["incident"];
  events: ActivityMcpHealthEvent[];
}

function eventTime(event: ConnectionDiagnosticEvent): number {
  const parsed = Date.parse(event.at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTransportFailure(event: ConnectionDiagnosticEvent): boolean {
  if (event.outcome !== "failure") return false;
  return event.event === "mcp.transport_error"
    || event.event === "mcp.request"
    || event.event === "mcp.modern_request"
    || event.phase === "transport";
}

function failureClassification(event: ConnectionDiagnosticEvent): ActivityMcpFailureClass | undefined {
  if (event.outcome !== "failure") return undefined;
  if (event.errorCode && RECOVERABLE_FAILURE_CODES.has(event.errorCode)) return "recoverable";
  if (isTransportFailure(event)) return "transport";
  if (event.event.startsWith("runtime.")) return "runtime";
  return "operation";
}

function isHealthTimelineEvent(event: ConnectionDiagnosticEvent): boolean {
  return event.outcome === "failure"
    || event.event === "mcp.transport_error"
    || event.event === "mcp.session_disconnected"
    || event.event === "mcp.session_reconnected"
    || event.event.startsWith("runtime.")
    || event.event.startsWith("approval.");
}

function toHealthEvent(event: ConnectionDiagnosticEvent): ActivityMcpHealthEvent {
  const classification = failureClassification(event);
  return {
    at: event.at,
    event: event.event,
    outcome: event.outcome,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(event.tool ? { tool: event.tool } : {}),
    ...(event.phase ? { phase: event.phase } : {}),
    ...(event.diagnosticId ? { diagnosticId: event.diagnosticId } : {}),
    ...(classification ? { classification } : {}),
  };
}

export function activityMcpHealth(
  diagnostics: ConnectionDiagnosticSummary | null | undefined,
  watchdog: ExternalWatchdogStatus | null | undefined,
  now = Date.now(),
): ActivityMcpHealth {
  const cutoff = now - RECENT_HEALTH_WINDOW_MS;
  const recentEvents = (diagnostics?.recentEvents ?? []).filter((event) => eventTime(event) >= cutoff);
  const observedFailures = recentEvents.filter((event) => event.outcome === "failure");
  const recentRecoverableFailures = observedFailures.filter((event) => failureClassification(event) === "recoverable");
  const recentFailures = observedFailures.filter((event) => failureClassification(event) !== "recoverable");
  const recentTransportFailures = recentFailures.filter(isTransportFailure);
  const watchdogStatus = watchdog?.available ? watchdog.status : "unavailable";
  const watchdogFresh = watchdog?.available ? watchdog.probeFresh : null;
  const watchdogFailures = watchdog?.available ? watchdog.consecutiveFailures : 0;
  const freshWatchdogUnhealthy = watchdog?.available === true
    && watchdog.probeFresh !== false
    && watchdog.status === "unhealthy";

  let state: ActivityMcpHealthState = "healthy";
  let reason = "runtime 응답 · 최근 내부 오류 · watchdog 정상";
  if ((freshWatchdogUnhealthy && watchdogFailures >= 2) || recentTransportFailures.length >= 2) {
    state = "unhealthy";
    reason = freshWatchdogUnhealthy
      ? `watchdog 연속 실패 ${watchdogFailures}회`
      : `최근 transport 실패 ${recentTransportFailures.length}건`;
  } else if (
    recentFailures.length > 0
    || freshWatchdogUnhealthy
    || watchdog?.status === "unknown"
    || watchdog?.probeFresh === false
    || watchdogFailures > 0
  ) {
    state = "degraded";
    reason = recentFailures.length > 0
      ? `최근 내부 실패 ${recentFailures.length}건`
      : watchdog?.probeFresh === false
        ? "watchdog probe 오래됨"
        : "watchdog 상태 확인 필요";
  }

  if (watchdog?.incident) {
    if (watchdog.incident.active) {
      reason = `외부 연결 장애 · ${watchdog.incident.latestFailureLayer}`;
    } else if (state === "healthy") {
      reason = `최근 외부 연결 장애 복구됨 · ${watchdog.incident.latestFailureLayer}`;
    }
  }

  const events = (diagnostics?.recentEvents ?? [])
    .filter(isHealthTimelineEvent)
    .slice(-MAX_HEALTH_EVENTS)
    .map(toHealthEvent);

  if (watchdog?.incident && Date.parse(watchdog.incident.startedAt) >= now - 30 * 60 * 1000) {
    for (const stage of watchdog.incident.stages) {
      events.push({
        at: stage.at,
        event: `external.watchdog.${stage.layer}`,
        outcome: stage.layer === "healthy" ? "success" : "failure",
        ...(stage.layer === "healthy" ? {} : { errorCode: stage.layer }),
        diagnosticId: watchdog.incident.incidentId,
      });
    }
  } else if (watchdog?.recentFailure && Date.parse(watchdog.recentFailure.at) >= now - 30 * 60 * 1000) {
    events.push({
      at: watchdog.recentFailure.at,
      event: "external.watchdog",
      outcome: "failure",
      errorCode: watchdog.recentFailure.category,
      ...(watchdog.recentFailure.diagnosticId ? { diagnosticId: watchdog.recentFailure.diagnosticId } : {}),
    });
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    state,
    label: state === "healthy" ? "Healthy" : state === "degraded" ? "Degraded" : "Unhealthy",
    reason,
    generatedAt: now,
    recentFailureCount: recentFailures.length,
    recentRecoverableFailureCount: recentRecoverableFailures.length,
    recentTransportFailureCount: recentTransportFailures.length,
    ...(diagnostics?.lastSuccessAt ? { lastSuccessAt: diagnostics.lastSuccessAt } : {}),
    ...(diagnostics?.lastFailureAt ? { lastFailureAt: diagnostics.lastFailureAt } : {}),
    watchdogStatus,
    watchdogProbeFresh: watchdogFresh ?? null,
    watchdogConsecutiveFailures: watchdogFailures,
    watchdogProbeAgeMs: watchdog?.probeAgeMs ?? null,
    watchdogIncident: watchdog?.incident ?? null,
    events: events.slice(-MAX_HEALTH_EVENTS),
  };
}
