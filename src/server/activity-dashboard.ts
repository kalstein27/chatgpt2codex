import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redact } from "../policy/secrets.js";
import type { RuntimeActivityTracker, RuntimeConversationSummary } from "../runtime/activity.js";
import type { ActivityMcpHealth } from "./activity-mcp-health.js";
import { CHATGPT_OPERATION_APPROVAL_USER_PROMPTS, CHATGPT_STANDARD_CONSENT_USER_PROMPTS } from "./chatgpt-card-prompts.js";

const MAX_DASHBOARD_OPERATIONS = 12;
const MAX_WIDGET_LOAD_ACTIVITY = 24;
const WIDGET_ASSET_GET_TOOL = "chatgpt_widget_asset_get";
const WIDGET_NORMAL_PRESENTER_RE = /^(?:chatgpt_operation_approval_presenter_v\d+|chatgpt_consent_probe)$/u;
const WIDGET_STATUS_TOOLS = new Set(["chatgpt_operation_approval_status", "chatgpt_consent_probe_status"]);
const WIDGET_CARD_TOOLS = new Set([
  "chatgpt_widget_shell",
  "chatgpt_widget_shell_action",
  "chatgpt_widget_shell_result",
  "chatgpt_continuation_resume",
  "chatgpt_operation_approval_status",
  "chatgpt_operation_approval_decide",
  "chatgpt_consent_probe_status",
  "chatgpt_consent_probe_decide",
  WIDGET_ASSET_GET_TOOL,
]);
const ACTIVITY_DASHBOARD_REVISION_TOKEN = "__C2CT_ACTIVITY_DASHBOARD_REVISION__";
export const ACTIVITY_DASHBOARD_OVERRIDE_FILE = "activity-dashboard.html";
export const ACTIVITY_DASHBOARD_CONTRACT_VERSION = 1;
const ACTIVITY_DASHBOARD_MAX_OVERRIDE_BYTES = 512 * 1024;
const ACTIVITY_DASHBOARD_CONTRACT_MARKER = `<meta name="c2ct-activity-dashboard-contract" content="${ACTIVITY_DASHBOARD_CONTRACT_VERSION}">`;
const FAILURE_BURST_WINDOW_MS = 2 * 60 * 1000;

export interface ActivityDashboardApproval {
  id: string;
  kind: "operation" | "rg" | "control";
  projectId: string;
  category: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
  channel: "mobile" | "mac";
  canDecide: boolean;
  tool?: string;
  risk?: string;
  relatedOperationId?: string;
}

export interface ActivityDashboardDeployment {
  kind: "runtime" | "macos-app";
  projectId: string;
  requestId: string;
  operationId: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  phase?: string;
  currentIdentity?: string;
  targetIdentity?: string;
  approvalRequestId?: string;
  finalHealthy?: boolean | null;
  rollbackAttempted?: boolean;
  rollbackSucceeded?: boolean | null;
  reconnectDurationMs?: number;
  message?: string;
}

function safeDashboardText(value: string | undefined, limit = 140): string | undefined {
  if (!value) return undefined;
  const safe = redact(value)
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return safe ? safe.slice(0, limit) : undefined;
}

function safeApprovalId(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim();
  return /^(?:op|rg|arm)_[A-Za-z0-9-]{8,96}$/u.test(normalized) ? normalized : undefined;
}

function dashboardOperation(operation: RuntimeConversationSummary["operations"][number]) {
  return {
    operationId: operation.operationId,
    tool: operation.tool,
    ...(safeDashboardText(operation.projectId, 80) ? { projectId: safeDashboardText(operation.projectId, 80) } : {}),
    state: operation.state,
    startedAt: operation.startedAt,
    ...(operation.finishedAt !== undefined ? { finishedAt: operation.finishedAt } : {}),
    elapsedMs: operation.elapsedMs,
    ...(safeDashboardText(operation.phase, 80) ? { phase: safeDashboardText(operation.phase, 80) } : {}),
    ...(safeDashboardText(operation.activityHint, 140) ? { activityHint: safeDashboardText(operation.activityHint, 140) } : {}),
    ...(safeDashboardText(operation.message, 140) ? { message: safeDashboardText(operation.message, 140) } : {}),
    ...(safeDashboardText(operation.errorCode, 80) ? { errorCode: safeDashboardText(operation.errorCode, 80) } : {}),
    ...(operation.lastProgressAt !== undefined ? { lastProgressAt: operation.lastProgressAt } : {}),
    ...(operation.clientCancellation
      ? {
          clientCancellation: {
            observedAt: operation.clientCancellation.observedAt,
            operationContinues: operation.clientCancellation.operationContinues,
          },
        }
      : {}),
    semanticKind: operation.semanticKind,
    workGroupId: operation.workGroupId,
    phaseId: operation.phaseId,
    stepOrdinal: operation.stepOrdinal,
    toolFamily: operation.toolFamily,
    displayLabel: safeDashboardText(operation.displayLabel, 80) ?? "C2CT 작업",
    currentActivity: safeDashboardText(operation.currentActivity, 140) ?? "작업 진행 중",
  };
}

type DashboardOperation = ReturnType<typeof dashboardOperation> & {
  repeatCount?: number;
  repeatOccurrences?: Array<{
    operationId: string;
    startedAt: number;
    finishedAt?: number;
    elapsedMs: number;
    errorCode?: string;
  }>;
  lastRepeatAt?: number;
};

function failureBurstKey(operation: DashboardOperation): string | undefined {
  if (operation.state !== "failed") return undefined;
  return [operation.projectId ?? "", operation.tool, operation.errorCode ?? "TOOL_RESULT_ERROR"].join("\u001f");
}

function repeatOccurrence(operation: DashboardOperation) {
  return {
    operationId: operation.operationId,
    startedAt: operation.startedAt,
    ...(operation.finishedAt !== undefined ? { finishedAt: operation.finishedAt } : {}),
    elapsedMs: operation.elapsedMs,
    ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
  };
}

function collapseFailureBursts(operations: DashboardOperation[]): DashboardOperation[] {
  const collapsed: DashboardOperation[] = [];
  for (const operation of operations) {
    const previous = collapsed.at(-1);
    const previousKey = previous ? failureBurstKey(previous) : undefined;
    const currentKey = failureBurstKey(operation);
    const previousAt = previous?.lastRepeatAt ?? previous?.startedAt ?? 0;
    if (
      previous
      && previousKey
      && previousKey === currentKey
      && operation.startedAt - previousAt <= FAILURE_BURST_WINDOW_MS
    ) {
      if (!previous.repeatOccurrences) {
        previous.repeatOccurrences = [repeatOccurrence(previous)];
        previous.repeatCount = 1;
      }
      previous.repeatOccurrences.push(repeatOccurrence(operation));
      previous.repeatCount = (previous.repeatCount ?? 1) + 1;
      previous.lastRepeatAt = operation.startedAt;
      previous.finishedAt = operation.finishedAt;
      previous.elapsedMs = operation.elapsedMs;
      if (operation.message) previous.message = operation.message;
      if (operation.currentActivity) previous.currentActivity = operation.currentActivity;
      if (operation.activityHint) previous.activityHint = operation.activityHint;
      continue;
    }
    collapsed.push({ ...operation, lastRepeatAt: operation.startedAt });
  }
  return collapsed.map(({ lastRepeatAt: _lastRepeatAt, ...operation }) => operation);
}

function dashboardConversation(conversation: RuntimeConversationSummary) {
  const visibleOperations = conversation.operations.filter((operation) => operation.tool !== WIDGET_ASSET_GET_TOOL);
  const dashboardOperations = collapseFailureBursts(visibleOperations.map((operation) => dashboardOperation(operation)));
  const visibleWorkGroups = conversation.workGroups
    .map((group) => {
      const tools = group.tools.filter((tool) => tool !== WIDGET_ASSET_GET_TOOL);
      const groupOperations = visibleOperations.filter((operation) => operation.workGroupId === group.workGroupId);
      const latestOperation = groupOperations.at(-1);
      return {
        workGroupId: group.workGroupId,
        phaseId: group.phaseId,
        toolFamily: group.toolFamily,
        displayLabel: safeDashboardText(group.displayLabel, 80) ?? "C2CT 작업",
        currentActivity: safeDashboardText(latestOperation?.currentActivity ?? group.currentActivity, 140) ?? "작업 진행 중",
        state: latestOperation?.state ?? group.state,
        startedAt: group.startedAt,
        ...(group.finishedAt !== undefined ? { finishedAt: group.finishedAt } : {}),
        elapsedMs: group.elapsedMs,
        stepCount: groupOperations.length,
        tools,
      };
    })
    .filter((group) => group.stepCount > 0);
  const displayTitle = safeDashboardText(conversation.displayTitle, 80);
  const taskLabel = safeDashboardText(conversation.taskLabel, 120);
  const titleSource = displayTitle
    ? (conversation.displayTitleSource ?? "host")
    : taskLabel
      ? "task"
      : "missing";
  return {
    id: conversation.conversationLabel,
    title: displayTitle ?? taskLabel?.slice(0, 60) ?? "채팅 이름 필요",
    hasChatTitle: titleSource === "host",
    titleSource,
    ...(safeDashboardText(conversation.boundProjectId, 80)
      ? { boundProjectId: safeDashboardText(conversation.boundProjectId, 80) }
      : {}),
    ...(taskLabel ? { taskLabel } : {}),
    firstSeenAt: conversation.firstSeenAt,
    lastActiveAt: conversation.lastActiveAt,
    state: conversation.state,
    ...(conversation.dashboardVisibleUntil !== undefined
      ? { dashboardVisibleUntil: conversation.dashboardVisibleUntil }
      : {}),
    workGroups: visibleWorkGroups,
    operations: dashboardOperations.slice(-MAX_DASHBOARD_OPERATIONS),
  };
}

function dashboardWidgetLoads(conversations: RuntimeConversationSummary[]) {
  return conversations
    .flatMap((conversation) => {
      const title = safeDashboardText(conversation.displayTitle, 80)
        ?? safeDashboardText(conversation.taskLabel, 80)
        ?? conversation.conversationLabel;
      return conversation.operations
        .filter((operation) => operation.tool === WIDGET_ASSET_GET_TOOL)
        .map((operation) => ({
          conversationId: conversation.conversationLabel,
          title,
          operationId: operation.operationId,
          state: operation.state,
          startedAt: operation.startedAt,
          ...(operation.finishedAt !== undefined ? { finishedAt: operation.finishedAt } : {}),
          elapsedMs: operation.elapsedMs,
        }));
    })
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_WIDGET_LOAD_ACTIVITY);
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? null;
}

function dashboardWidgetPerformance(conversations: RuntimeConversationSummary[]) {
  const presenterDurations: number[] = [];
  const presenterToAssetReady: number[] = [];
  const cardRoundTripsPerPresenter: number[] = [];
  let presenterMountCount = 0;
  let assetFetchCount = 0;
  let statusPollCount = 0;
  let legacyResultLookupCount = 0;
  let continuationResumeCount = 0;
  let totalCardToolRoundTrips = 0;
  let presenterWithAssetFetchCount = 0;

  for (const conversation of conversations) {
    const operations = conversation.operations.slice().sort((a, b) => a.startedAt - b.startedAt);
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      const isPresenter = WIDGET_NORMAL_PRESENTER_RE.test(operation.tool);
      if (isPresenter) {
        presenterMountCount += 1;
        presenterDurations.push(Math.max(0, operation.elapsedMs));
        let segmentRoundTrips = 1;
        let matchedAsset = false;
        for (let cursor = index + 1; cursor < operations.length; cursor += 1) {
          const candidate = operations[cursor]!;
          if (WIDGET_NORMAL_PRESENTER_RE.test(candidate.tool)) break;
          if (candidate.tool === WIDGET_ASSET_GET_TOOL && !matchedAsset) {
            matchedAsset = true;
            presenterWithAssetFetchCount += 1;
            const assetReadyAt = candidate.finishedAt ?? candidate.startedAt;
            presenterToAssetReady.push(Math.max(0, assetReadyAt - operation.startedAt));
          }
          if (WIDGET_CARD_TOOLS.has(candidate.tool)) segmentRoundTrips += 1;
        }
        cardRoundTripsPerPresenter.push(segmentRoundTrips);
      }
      if (operation.tool === WIDGET_ASSET_GET_TOOL) assetFetchCount += 1;
      if (WIDGET_STATUS_TOOLS.has(operation.tool)) statusPollCount += 1;
      if (operation.tool === "chatgpt_widget_shell_result") legacyResultLookupCount += 1;
      if (operation.tool === "chatgpt_continuation_resume") continuationResumeCount += 1;
      if (isPresenter || WIDGET_CARD_TOOLS.has(operation.tool)) totalCardToolRoundTrips += 1;
    }
  }

  const bundledCacheHitEstimate = Math.max(0, presenterMountCount - presenterWithAssetFetchCount);
  return {
    presenterMountCount,
    totalCardToolRoundTrips,
    statusPollCount,
    assetFetchCount,
    presenterWithAssetFetchCount,
    bundledCacheHitEstimate,
    legacyResultLookupCount,
    continuationResumeCount,
    presenterServerLatencyMs: {
      samples: presenterDurations.length,
      p50: percentile(presenterDurations, 0.5),
      p95: percentile(presenterDurations, 0.95),
    },
    presenterToAssetReadyMs: {
      samples: presenterToAssetReady.length,
      p50: percentile(presenterToAssetReady, 0.5),
      p95: percentile(presenterToAssetReady, 0.95),
    },
    cardToolRoundTripsPerPresenter: {
      samples: cardRoundTripsPerPresenter.length,
      p50: percentile(cardRoundTripsPerPresenter, 0.5),
      p95: percentile(cardRoundTripsPerPresenter, 0.95),
    },
    terminalShortCircuitCount: null,
    terminalShortCircuitMeasurement: "client-local-no-extra-roundtrip",
    cacheHitEstimateBasis: "normal presenter mounts without a following asset fetch before the next presenter",
  };
}

function dashboardApproval(approval: ActivityDashboardApproval): ActivityDashboardApproval {
  return {
    ...approval,
    id: safeApprovalId(approval.id) ?? "approval",
    projectId: safeDashboardText(approval.projectId, 80) ?? "project",
    category: safeDashboardText(approval.category, 80) ?? "승인 요청",
    summary: safeDashboardText(approval.summary, 180) ?? "보호 작업 승인 요청",
    ...(approval.tool ? { tool: safeDashboardText(approval.tool, 80) } : {}),
    ...(approval.risk ? { risk: safeDashboardText(approval.risk, 40) } : {}),
    ...(approval.relatedOperationId ? { relatedOperationId: safeDashboardText(approval.relatedOperationId, 100) } : {}),
  };
}

function dashboardDeployment(deployment: ActivityDashboardDeployment): ActivityDashboardDeployment {
  return {
    ...deployment,
    projectId: safeDashboardText(deployment.projectId, 80) ?? "project",
    requestId: safeDashboardText(deployment.requestId, 128) ?? "request",
    operationId: safeDashboardText(deployment.operationId, 100) ?? "operation",
    state: safeDashboardText(deployment.state, 80) ?? "UNKNOWN",
    ...(deployment.phase ? { phase: safeDashboardText(deployment.phase, 80) } : {}),
    ...(deployment.currentIdentity ? { currentIdentity: safeDashboardText(deployment.currentIdentity, 80) } : {}),
    ...(deployment.targetIdentity ? { targetIdentity: safeDashboardText(deployment.targetIdentity, 80) } : {}),
    ...(deployment.approvalRequestId ? { approvalRequestId: safeDashboardText(deployment.approvalRequestId, 100) } : {}),
    ...(deployment.message ? { message: safeDashboardText(deployment.message, 180) } : {}),
  };
}

export function activityDashboardSnapshot(
  tracker: RuntimeActivityTracker,
  approvals: ActivityDashboardApproval[] = [],
  now = Date.now(),
  dashboardRevision = ACTIVITY_DASHBOARD_REVISION,
  deployments: ActivityDashboardDeployment[] = [],
  mcpHealth: ActivityMcpHealth | null = null,
) {
  const conversations = tracker.conversationSnapshot(now);
  return {
    schemaVersion: 5,
    dashboardRevision,
    generatedAt: now,
    approvals: approvals.map(dashboardApproval),
    deployments: deployments.map(dashboardDeployment),
    mcpHealth,
    widgetLoads: dashboardWidgetLoads(conversations),
    widgetPerformance: dashboardWidgetPerformance(conversations),
    conversations: conversations
      .filter((conversation) => conversation.operations.some((operation) => operation.tool !== WIDGET_ASSET_GET_TOOL))
      .map(dashboardConversation),
  };
}

const ACTIVITY_DASHBOARD_TEMPLATE = String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="c2ct-activity-dashboard-contract" content="1">
  <meta name="application-name" content="ChatGPT To Codex">
  <meta name="theme-color" content="#087E78">
  <meta name="msapplication-TileImage" content="/activity/app-icon.png?brand=20260910">
  <link rel="manifest" href="/activity/manifest.webmanifest?brand=20260910">
  <link rel="icon" type="image/png" sizes="1024x1024" href="/activity/app-icon.png?brand=20260910">
  <link rel="icon" type="image/svg+xml" sizes="any" href="/activity/app-icon.svg?brand=20260910">
  <link rel="shortcut icon" type="image/x-icon" href="/activity/favicon.ico?brand=20260910">
  <link rel="apple-touch-icon" href="/activity/app-icon.png?brand=20260910">
  <title>ChatGPT To Codex</title>
  <style>
    :root {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Apple SD Gothic Neo", sans-serif;
      color-scheme: light dark;
      --bg: #f6f7f8;
      --panel: rgba(255,255,255,.96);
      --panel2: #f7f8fa;
      --text: #17181a;
      --muted: #73777e;
      --line: rgba(17,24,39,.08);
      --blue: #0a84ff;
      --green: #2a9d55;
      --orange: #d97706;
      --red: #dc3545;
      --gray: #8b9097;
      --shadow: 0 1px 2px rgba(0,0,0,.035), 0 8px 24px rgba(0,0,0,.035);
      --motion-fast: 270ms;
      --motion-layout: 430ms;
      --motion-ease: cubic-bezier(.2,.72,.2,1);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111315;
        --panel: rgba(28,30,33,.98);
        --panel2: #222529;
        --text: #f5f5f7;
        --muted: #a2a5aa;
        --line: rgba(255,255,255,.085);
        --green: #43c46b;
        --orange: #ff9f0a;
        --red: #ff453a;
        --gray: #98989f;
        --shadow: 0 1px 2px rgba(0,0,0,.16), 0 10px 26px rgba(0,0,0,.12);
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    .desktop-shell { min-height: 100vh; display: grid; grid-template-columns: 168px minmax(0,1fr); }
    .app-sidebar { position: sticky; top: 0; height: 100vh; padding: 12px 8px; border-right: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 94%, var(--bg)); }
    .sidebar-nav { display: grid; gap: 4px; }
    .sidebar-nav .view-tab { width: 100%; min-height: 36px; display: flex; align-items: center; justify-content: flex-start; border: 1px solid transparent; border-radius: 8px; padding: 7px 8px; background: transparent; color: var(--muted); font-size: 11.5px; font-weight: 690; text-align: left; }
    .sidebar-nav .view-tab[hidden] { display: none; }
    .sidebar-nav .view-tab.active { background: color-mix(in srgb, var(--blue) 9%, var(--panel)); border-color: color-mix(in srgb, var(--blue) 18%, var(--line)); color: var(--blue); box-shadow: none; }
    .app-main { min-width: 0; }
    main { width: min(1120px, 100%); margin: 0 auto; padding: max(12px, env(safe-area-inset-top)) 18px max(28px, env(safe-area-inset-bottom)); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; margin: 0 2px 11px; }
    .header-main { display: flex; align-items: center; gap: 11px; min-width: 0; }
    .app-mark { width: 38px; height: 38px; flex: 0 0 auto; filter: drop-shadow(0 3px 9px rgba(0,0,0,.1)); }
    .app-mark svg { display: block; width: 100%; height: 100%; }
    .live { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; color: var(--muted); white-space: nowrap; }
    .dot { width: 7px; height: 7px; border-radius: 999px; background: var(--green); box-shadow: 0 0 0 3px rgba(42,157,85,.1); transition: background-color var(--motion-fast) ease, box-shadow var(--motion-fast) ease; }
    .dot.offline { background: var(--red); box-shadow: 0 0 0 3px rgba(220,53,69,.1); }
    .summary { display: inline-flex; align-items: center; gap: 0; min-width: 0; }
    .metric { display: inline-flex; align-items: baseline; gap: 4px; min-height: 24px; padding: 3px 8px; color: var(--text); }
    .metric + .metric { border-left: 1px solid var(--line); }
    .metric b { display: inline-block; font-size: 12px; line-height: 1; font-weight: 760; font-variant-numeric: tabular-nums; }
    .metric span { font-size: 10px; color: var(--muted); }
    .metric.attention.has-value { color: var(--orange); }
    .metric.approval.has-value { color: var(--blue); }
    .metric.attention.has-value span, .metric.approval.has-value span { color: currentColor; opacity: .78; }
    .view-tab { appearance: none; cursor: pointer; }
    .view-panel[hidden] { display: none !important; }
    .settings-stack { display: grid; gap: 10px; }
    .settings-card { border: 1px solid var(--line); border-radius: 14px; padding: 15px 16px; background: var(--panel); box-shadow: var(--shadow); }
    .settings-card h2 { margin: 0; font-size: 14px; }
    .settings-card > p { margin: 5px 0 13px; color: var(--muted); font-size: 11px; line-height: 1.45; }
    .settings-row { display: grid; grid-template-columns: 160px minmax(0,1fr); align-items: center; gap: 12px; min-height: 40px; }
    .settings-row + .settings-row { border-top: 1px solid var(--line); }
    .settings-label { color: var(--muted); font-size: 11px; line-height: 1.4; }
    .settings-control { min-width: 0; }
    .settings-control input[type="text"], .settings-control input[type="number"], .settings-control select {
      width: 100%; min-height: 32px; border: 1px solid var(--line); border-radius: 9px; padding: 6px 9px;
      background: var(--panel2); color: var(--text); font: inherit; font-size: 12px; outline: none;
    }
    .settings-control input:focus, .settings-control select:focus { border-color: color-mix(in srgb, var(--blue) 60%, var(--line)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--blue) 12%, transparent); }
    .settings-check { display: flex; align-items: center; gap: 8px; min-height: 32px; color: var(--text); font-size: 12px; }
    .settings-check input { width: 16px; height: 16px; accent-color: var(--blue); }
    .settings-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 12px; }
    .settings-status { margin-right: auto; color: var(--muted); font-size: 11px; line-height: 1.4; }
    .settings-status.success { color: var(--green); }
    .settings-status.error { color: var(--red); }
    .settings-save { appearance: none; min-height: 36px; border: 1px solid color-mix(in srgb, var(--blue) 45%, var(--line)); border-radius: 10px; padding: 7px 14px; background: color-mix(in srgb, var(--blue) 7%, var(--panel)); color: var(--blue); font-size: 12px; font-weight: 750; }
    .settings-save:disabled { opacity: .5; }
    .command-grant-list { display: grid; gap: 8px; }
    .command-grant-item { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: center; border: 1px solid var(--line); border-radius: 10px; padding: 10px 11px; background: var(--panel2); }
    .command-grant-main { min-width: 0; }
    .command-grant-command { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
    .command-grant-meta { margin-top: 5px; color: var(--muted); font-size: 10px; line-height: 1.45; overflow-wrap: anywhere; }
    .command-grant-revoke { appearance: none; min-height: 34px; border: 1px solid color-mix(in srgb, var(--red) 45%, var(--line)); border-radius: 9px; padding: 6px 11px; background: color-mix(in srgb, var(--red) 5%, var(--panel)); color: var(--red); font-size: 11px; font-weight: 750; }
    .command-grant-revoke:disabled { opacity: .5; }
    .command-grant-empty { color: var(--muted); font-size: 11px; line-height: 1.45; }
    .managed-mcp-list { display: grid; gap: 8px; margin-top: 12px; }
    .managed-mcp-item { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: start; border: 1px solid var(--line); border-radius: 10px; padding: 10px 11px; background: var(--panel2); }
    .managed-mcp-main { min-width: 0; }
    .managed-mcp-title { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; font-size: 12px; font-weight: 740; }
    .managed-mcp-state { border-radius: 999px; padding: 3px 7px; background: var(--panel); color: var(--muted); font-size: 10px; font-weight: 760; }
    .managed-mcp-state.running { color: var(--green); }
    .managed-mcp-state.starting, .managed-mcp-state.updating { color: var(--blue); }
    .managed-mcp-state.degraded { color: var(--orange); }
    .managed-mcp-url { margin-top: 4px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.45; overflow-wrap: anywhere; }
    .managed-mcp-meta { margin-top: 4px; color: var(--muted); font-size: 10px; line-height: 1.45; overflow-wrap: anywhere; }
    .managed-mcp-runtime { display: flex; flex-wrap: wrap; gap: 5px 8px; margin-top: 7px; color: var(--muted); font-size: 10px; line-height: 1.4; }
    .managed-mcp-runtime b { color: var(--text); font-weight: 720; }
    .managed-mcp-exit { margin-top: 5px; color: var(--orange); font-size: 10px; line-height: 1.4; }
    .managed-mcp-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .managed-mcp-action { appearance: none; min-height: 32px; border: 1px solid var(--line); border-radius: 9px; padding: 5px 9px; background: var(--panel); color: var(--text); font-size: 10.5px; font-weight: 720; }
    .managed-mcp-action.primary { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 45%, var(--line)); }
    .managed-mcp-action.danger { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }
    .managed-mcp-action:disabled { opacity: .5; }
    .managed-mcp-detail { display: none; grid-column: 1 / -1; min-width: 0; margin-top: 2px; border-top: 1px solid var(--line); padding-top: 9px; }
    .managed-mcp-detail.visible { display: block; }
    .managed-mcp-detail-title { margin-bottom: 6px; color: var(--muted); font-size: 10px; font-weight: 740; }
    .managed-mcp-tools { display: flex; flex-wrap: wrap; gap: 5px; }
    .managed-mcp-tool { border: 1px solid var(--line); border-radius: 7px; padding: 4px 6px; background: var(--panel); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; }
    .managed-mcp-log { max-height: 260px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; padding: 8px 9px; background: var(--panel); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .gallery-note { margin-bottom: 14px; border: 1px solid color-mix(in srgb, var(--blue) 24%, var(--line)); border-radius: 12px; padding: 11px 12px; background: color-mix(in srgb, var(--blue) 4%, var(--panel)); color: var(--muted); font-size: 12px; line-height: 1.5; }
    .gallery-note b { color: var(--text); }
    .gallery-section + .gallery-section { margin-top: 16px; }
    .gallery-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; align-items: start; }
    .gallery-card { min-width: 0; border: 1px solid var(--line); border-radius: 14px; padding: 14px 15px; background: var(--panel); box-shadow: var(--shadow); }
    .gallery-card.critical { border-color: color-mix(in srgb, var(--red) 58%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--red) 13%, transparent), var(--shadow); }
    .gallery-card.success { border-color: color-mix(in srgb, var(--green) 52%, var(--line)); }
    .gallery-card.denied { border-color: color-mix(in srgb, var(--red) 34%, var(--line)); }
    .gallery-card.muted { border-color: color-mix(in srgb, var(--gray) 34%, var(--line)); color: var(--muted); }
    .gallery-title-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 9px; }
    .gallery-title { font-size: 15px; font-weight: 780; line-height: 1.35; }
    .gallery-state { flex: 0 0 auto; border-radius: 999px; padding: 4px 8px; background: var(--panel2); font-size: 11px; font-weight: 760; }
    .gallery-state.blue { color: var(--blue); }
    .gallery-state.green { color: var(--green); }
    .gallery-state.orange { color: var(--orange); }
    .gallery-state.red { color: var(--red); }
    .gallery-state.gray { color: var(--gray); }
    .gallery-critical-badge { display: inline-block; margin-bottom: 8px; border: 1px solid color-mix(in srgb, var(--red) 72%, var(--line)); border-radius: 999px; padding: 4px 8px; color: var(--red); font-size: 11px; font-weight: 760; }
    .gallery-warning { margin-bottom: 10px; border-radius: 9px; padding: 10px 11px; background: color-mix(in srgb, var(--red) 7%, var(--panel2)); color: var(--red); font-size: 12.5px; font-weight: 690; line-height: 1.5; }
    .gallery-critical-meta { margin: 8px 0 10px; border: 1px solid color-mix(in srgb, var(--red) 24%, var(--line)); border-radius: 9px; padding: 9px 10px; background: color-mix(in srgb, var(--red) 3%, var(--panel2)); font-size: 11px; line-height: 1.55; }
    .gallery-critical-row { display: flex; justify-content: space-between; gap: 10px; }
    .gallery-critical-key { color: var(--muted); }
    .gallery-critical-value { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 650; overflow-wrap: anywhere; }
    .gallery-preview { margin-top: 0; font-size: 14px; font-weight: 700; line-height: 1.5; color: var(--text); white-space: pre-wrap; }
    .gallery-time { margin-top: 7px; color: var(--muted); font-size: 11px; line-height: 1.5; font-variant-numeric: tabular-nums; }
    .gallery-impact { margin-top: 8px; border-radius: 8px; padding: 8px 10px; background: var(--panel2); color: color-mix(in srgb, var(--text) 82%, var(--muted)); font-size: 12px; font-weight: 620; line-height: 1.5; }
    .gallery-meta { margin-top: 6px; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .gallery-details { margin-top: 9px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--panel2); }
    .gallery-details summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; list-style: none; padding: 9px 0; color: var(--muted); font-size: 12px; font-weight: 650; user-select: none; }
    .gallery-details summary::-webkit-details-marker { display: none; }
    .gallery-details summary::before { content: "›"; flex: 0 0 auto; margin-right: 7px; font-size: 19px; font-weight: 500; line-height: 1; transform: rotate(0deg); transform-origin: center; transition: transform var(--motion-fast) var(--motion-ease); }
    .gallery-details[open] summary::before { transform: rotate(90deg); }
    .gallery-detail-command { max-height: 180px; overflow: auto; margin: 0 0 9px; border-radius: 7px; padding: 9px 10px; background: color-mix(in srgb, var(--panel) 70%, var(--panel2)); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .gallery-status-message { margin-top: 8px; color: var(--muted); font-size: 11.5px; line-height: 1.5; }
    .gallery-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 11px; }
    .gallery-actions button, .gallery-choice { appearance: none; min-height: 44px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel2); color: var(--text); font-size: 13px; font-weight: 720; }
    .gallery-actions button.allow { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 45%, var(--line)); }
    .gallery-actions button.deny { color: var(--red); }
    .gallery-actions button:disabled, .gallery-choice:disabled { opacity: 1; }
    .gallery-actions button:not(:disabled), .gallery-choice:not(:disabled) { cursor: pointer; transition: transform var(--motion-fast) var(--motion-ease), background var(--motion-fast) var(--motion-ease), border-color var(--motion-fast) var(--motion-ease); }
    .gallery-actions button:not(:disabled):hover, .gallery-choice:not(:disabled):hover { background: color-mix(in srgb, var(--blue) 6%, var(--panel2)); border-color: color-mix(in srgb, var(--blue) 36%, var(--line)); }
    .gallery-actions button:not(:disabled):active, .gallery-choice:not(:disabled):active { transform: translateY(1px); }
    .gallery-choice-list { display: grid; gap: 7px; margin-top: 9px; }
    .gallery-choice { text-align: left; padding: 8px 10px; }
    .gallery-choice small { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 1.4; font-weight: 500; }
    .gallery-flow { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
    .gallery-flow-title, .gallery-button-guide-title { color: var(--muted); font-size: 10.5px; font-weight: 760; letter-spacing: .01em; }
    .gallery-flow-steps { display: flex; flex-wrap: wrap; gap: 5px 4px; align-items: center; margin-top: 7px; }
    .gallery-flow-step { display: inline-flex; align-items: center; min-height: 25px; border: 1px solid var(--line); border-radius: 999px; padding: 3px 7px; background: var(--panel2); color: color-mix(in srgb, var(--text) 76%, var(--muted)); font-size: 10.5px; font-weight: 620; line-height: 1.35; }
    .gallery-flow-arrow { color: var(--muted); font-size: 11px; opacity: .72; }
    .gallery-button-guide { margin-top: 10px; border-radius: 9px; padding: 9px 10px; background: color-mix(in srgb, var(--blue) 3%, var(--panel2)); }
    .gallery-button-guide-row { display: grid; grid-template-columns: minmax(72px, auto) minmax(0, 1fr); gap: 8px; margin-top: 6px; font-size: 10.8px; line-height: 1.45; }
    .gallery-button-guide-label { color: var(--text); font-weight: 720; }
    .gallery-button-guide-body { min-width: 0; }
    .gallery-button-guide-effect { color: var(--muted); }
    .gallery-button-guide-prompt { margin-top: 4px; color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .gallery-sim-result { display: none; margin-top: 9px; border: 1px solid color-mix(in srgb, var(--blue) 26%, var(--line)); border-radius: 9px; padding: 9px 10px; background: color-mix(in srgb, var(--blue) 5%, var(--panel)); color: var(--blue); font-size: 11px; font-weight: 650; line-height: 1.45; white-space: pre-wrap; }
    .gallery-sim-result.visible { display: block; }
    .gallery-activity { display: grid; gap: 8px; }
    .gallery-activity .card { pointer-events: none; }
    .approval-box { max-height: 1600px; overflow: hidden; background: color-mix(in srgb, var(--orange) 5%, var(--panel)); border: 1px solid color-mix(in srgb, var(--orange) 30%, var(--line)); border-radius: 13px; padding: 11px 12px; margin-bottom: 10px; opacity: 1; transform: translateY(0); transition: max-height var(--motion-layout) var(--motion-ease), opacity var(--motion-fast) ease, transform var(--motion-layout) var(--motion-ease), margin-bottom var(--motion-layout) var(--motion-ease), padding var(--motion-layout) var(--motion-ease), border-width var(--motion-layout) var(--motion-ease); }
    .approval-box.hidden { max-height: 0; opacity: 0; transform: translateY(-4px); margin-bottom: 0; padding-top: 0; padding-bottom: 0; border-width: 0; pointer-events: none; }
    .section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 9px; }
    .section-head h2 { font-size: 14px; margin: 0; }
    .section-head span { color: var(--muted); font-size: 11px; }
    .approval-list { display: grid; gap: 8px; }
    .approval-item { border: 1px solid var(--line); border-radius: 11px; background: var(--panel); padding: 11px; }
    .approval-item.mobile { border-color: color-mix(in srgb, var(--blue) 45%, var(--line)); }
    .approval-item.mac { border-color: color-mix(in srgb, var(--orange) 55%, var(--line)); }
    .approval-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
    .approval-category { font-size: 13px; font-weight: 700; line-height: 1.35; }
    .approval-channel { flex: 0 0 auto; font-size: 10px; font-weight: 700; border-radius: 999px; padding: 4px 7px; background: var(--panel2); }
    .approval-channel.mobile { color: var(--blue); }
    .approval-channel.mac { color: var(--orange); }
    .approval-summary { margin-top: 6px; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
    .approval-meta { margin-top: 6px; color: var(--muted); font-size: 10px; display: flex; flex-wrap: wrap; gap: 4px 8px; }
    .approval-actions { margin-top: 9px; display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    .approval-actions button { appearance: none; min-height: 40px; border-radius: 10px; border: 1px solid var(--line); font-size: 13px; font-weight: 700; background: var(--panel); color: var(--text); }
    .approval-actions button.approve { border-color: color-mix(in srgb, var(--blue) 55%, var(--line)); color: var(--blue); }
    .approval-actions button.reject { color: var(--red); }
    .approval-actions button:disabled { opacity: .5; }
    .approval-actions button.native { border-color: color-mix(in srgb, var(--orange) 55%, var(--line)); color: var(--orange); }
    .deployment-box { background: color-mix(in srgb, var(--blue) 3%, var(--panel)); border: 1px solid color-mix(in srgb, var(--blue) 22%, var(--line)); border-radius: 13px; padding: 11px 12px; margin-bottom: 10px; }
    .deployment-box.hidden { display: none; }
    .deployment-list { display: grid; gap: 8px; }
    .deployment-item { border: 1px solid var(--line); border-radius: 11px; background: var(--panel); padding: 11px; }
    .deployment-item.blue { border-color: color-mix(in srgb, var(--blue) 45%, var(--line)); }
    .deployment-item.orange { border-color: color-mix(in srgb, var(--orange) 55%, var(--line)); }
    .deployment-item.green { border-color: color-mix(in srgb, var(--green) 48%, var(--line)); }
    .deployment-item.red { border-color: color-mix(in srgb, var(--red) 48%, var(--line)); }
    .deployment-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
    .deployment-title { font-size: 13px; font-weight: 740; line-height: 1.35; }
    .deployment-state { flex: 0 0 auto; border-radius: 999px; padding: 4px 7px; background: var(--panel2); font-size: 10px; font-weight: 760; }
    .deployment-state.blue { color: var(--blue); }
    .deployment-state.orange { color: var(--orange); }
    .deployment-state.green { color: var(--green); }
    .deployment-state.red { color: var(--red); }
    .deployment-state.gray { color: var(--gray); }
    .deployment-route { margin-top: 7px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; line-height: 1.45; overflow-wrap: anywhere; }
    .deployment-meta { margin-top: 6px; color: var(--muted); font-size: 10px; line-height: 1.5; display: flex; flex-wrap: wrap; gap: 4px 8px; }
    .deployment-message { margin-top: 6px; color: var(--muted); font-size: 11px; line-height: 1.45; }
    .mcp-health-box { background: color-mix(in srgb, var(--green) 3%, var(--panel)); border: 1px solid color-mix(in srgb, var(--green) 24%, var(--line)); border-radius: 13px; padding: 11px 12px; margin-bottom: 10px; }
    .mcp-health-box.degraded { background: color-mix(in srgb, var(--orange) 4%, var(--panel)); border-color: color-mix(in srgb, var(--orange) 32%, var(--line)); }
    .mcp-health-box.unhealthy { background: color-mix(in srgb, var(--red) 4%, var(--panel)); border-color: color-mix(in srgb, var(--red) 36%, var(--line)); }
    .mcp-health-state { flex: 0 0 auto; border-radius: 999px; padding: 4px 8px; background: var(--panel2); font-size: 10px; font-weight: 780; }
    .mcp-health-state.healthy { color: var(--green); }
    .mcp-health-state.degraded { color: var(--orange); }
    .mcp-health-state.unhealthy { color: var(--red); }
    .mcp-health-reason { margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.45; }
    .mcp-health-meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 9px; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
    .mcp-health-events { display: grid; gap: 4px; margin-top: 8px; }
    .mcp-health-event { border-top: 1px solid var(--line); padding-top: 6px; display: grid; grid-template-columns: auto minmax(0,1fr); gap: 8px; font-size: 10.5px; line-height: 1.4; }
    .mcp-health-event-time { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .mcp-health-event-text { min-width: 0; overflow-wrap: anywhere; }
    .mcp-health-event.failure .mcp-health-event-text { color: var(--red); }
    .mcp-health-event.recoverable .mcp-health-event-text { color: var(--orange); }
    .widget-load-box { background: color-mix(in srgb, var(--gray) 4%, var(--panel)); border: 1px solid color-mix(in srgb, var(--gray) 24%, var(--line)); border-radius: 13px; padding: 11px 12px; margin-bottom: 10px; }
    .widget-load-box.hidden { display: none; }
    .widget-load-list { display: grid; gap: 6px; }
    .widget-load-item { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); padding: 8px 10px; font-size: 10.5px; }
    .widget-load-chat { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 680; }
    .widget-load-meta { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .toolbar { display: flex; gap: 5px; overflow-x: auto; padding: 0 1px 9px; scrollbar-width: none; }
    .toolbar.hidden { display: none; }
    .toolbar::-webkit-scrollbar { display: none; }
    button.filter { appearance: none; border: 1px solid transparent; background: var(--panel2); color: var(--muted); border-radius: 999px; padding: 5px 9px; font-size: 10px; font-weight: 650; white-space: nowrap; transition: color var(--motion-fast) ease, background-color var(--motion-fast) ease, border-color var(--motion-fast) ease; }
    button.filter.active { color: var(--text); background: var(--panel); border-color: var(--line); }
    #cards { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 13px 14px; box-shadow: var(--shadow); min-width: 0; transition: border-color 180ms ease, box-shadow 180ms ease; }
    .card.status-blue { border-color: color-mix(in srgb, var(--blue) 72%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--blue) 22%, transparent), var(--shadow); }
    .card.status-green { border-color: color-mix(in srgb, var(--green) 66%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--green) 18%, transparent), var(--shadow); }
    .card.status-orange { border-color: color-mix(in srgb, var(--orange) 72%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--orange) 20%, transparent), var(--shadow); }
    .card.status-red { border-color: color-mix(in srgb, var(--red) 70%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--red) 20%, transparent), var(--shadow); }
    .card.status-gray { border-color: color-mix(in srgb, var(--gray) 42%, var(--line)); }
    .card-primary { display: grid; grid-template-columns: auto minmax(0,1fr) auto auto; align-items: center; gap: 7px 10px; min-width: 0; }
    .project-badge { display: inline-flex; align-items: center; min-width: 0; max-width: 132px; min-height: 22px; border-radius: 7px; padding: 3px 7px; background: color-mix(in srgb, var(--blue) 7%, var(--panel2)); color: color-mix(in srgb, var(--blue) 80%, var(--text)); font-size: 10px; font-weight: 760; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .project-badge.none { border-color: var(--line); background: var(--panel2); color: var(--muted); }
    .title { font-size: 14px; font-weight: 730; line-height: 1.35; letter-spacing: -.01em; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .title.provisional { color: var(--muted); }
    .start-time { color: var(--muted); font-size: 9.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .status { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; min-height: 23px; border-radius: 999px; padding: 3px 7px; background: var(--panel2); font-size: 10px; font-weight: 760; white-space: nowrap; transition: color var(--motion-fast) ease, background-color var(--motion-fast) ease; }
    .status::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; opacity: .8; }
    .status.blue { color: var(--blue); }
    .status.green { color: var(--green); }
    .status.orange { color: var(--orange); }
    .status.red { color: var(--red); }
    .status.gray { color: var(--gray); }
    .work-group-current { display: flex; align-items: center; gap: 7px; min-width: 0; margin-top: 9px; padding: 7px 9px; border: 1px solid color-mix(in srgb, var(--blue) 16%, var(--line)); border-radius: 9px; background: color-mix(in srgb, var(--blue) 3%, var(--panel2)); }
    .work-group-label { flex: 0 0 auto; color: var(--blue); font-size: 10px; font-weight: 760; }
    .work-group-activity { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 11px; font-weight: 640; }
    .activity-disclosure { margin-top: 9px; border: 1px solid color-mix(in srgb, var(--line) 72%, transparent); border-radius: 10px; background: var(--panel2); overflow: hidden; }
    .activity-disclosure > summary { position: relative; list-style: none; cursor: pointer; user-select: none; padding: 9px 31px 9px 10px; }
    .activity-disclosure > summary::-webkit-details-marker { display: none; }
    .activity-preview { display: grid; gap: 4px; min-width: 0; }
    .activity-preview-line, .activity-line { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11px; line-height: 1.4; white-space: nowrap; }
    .activity-preview-line[role="button"] { cursor: pointer; border-radius: 6px; outline: none; }
    .activity-preview-line[role="button"]:focus-visible { box-shadow: 0 0 0 1px color-mix(in srgb, var(--blue) 65%, transparent); }
    .activity-preview-line.failed, .activity-entry.failed .activity-line { color: var(--red); }
    .activity-preview-line.failed .activity-time, .activity-entry.failed .activity-time { color: color-mix(in srgb, var(--red) 72%, var(--muted)); }
    .activity-preview-line.failed.historical, .activity-entry.failed.historical .activity-line { color: var(--muted); opacity: .76; }
    .activity-preview-line.failed.historical .activity-time, .activity-entry.failed.historical .activity-time { color: var(--muted); }
    .activity-time { flex: 0 0 40px; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 9.5px; }
    .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 620; }
    .activity-collapse-label { display: none; color: var(--muted); font-size: 10px; font-weight: 650; }
    .disclosure-indicator { position: absolute; right: 10px; top: 50%; color: var(--muted); font-size: 13px; transform: translateY(-50%) rotate(0deg); transition: transform var(--motion-fast) var(--motion-ease); }
    .activity-disclosure[open] > summary .activity-preview { display: none; }
    .activity-disclosure[open] > summary .activity-collapse-label { display: inline; }
    .activity-disclosure[open] > summary .disclosure-indicator { transform: translateY(-50%) rotate(180deg); }
    .activity-timeline { display: grid; gap: 2px; border-top: 1px solid var(--line); margin: 0 10px 8px; padding-top: 7px; }
    .activity-entry { min-width: 0; border-radius: 7px; }
    .activity-entry.failed { background: color-mix(in srgb, var(--red) 6%, transparent); }
    .activity-entry.failed.historical { background: transparent; }
    .activity-line { cursor: pointer; padding: 4px 2px; outline: none; }
    .activity-line:focus-visible { box-shadow: 0 0 0 1px color-mix(in srgb, var(--blue) 65%, transparent); }
    .activity-detail { display: none; margin: 0 2px 7px 50px; color: var(--muted); font-size: 9.5px; line-height: 1.45; overflow-wrap: anywhere; }
    .activity-entry.detail-open .activity-detail { display: block; }
    .activity-detail-text { color: var(--text); margin-bottom: 2px; }
    .activity-detail-message { margin-bottom: 2px; }
    .activity-detail-meta { font-variant-numeric: tabular-nums; }
    .activity-repeat-list { display: grid; gap: 2px; margin-top: 4px; padding-left: 8px; border-left: 2px solid color-mix(in srgb, var(--orange) 30%, var(--line)); font-variant-numeric: tabular-nums; }
    .empty { grid-column: 1/-1; text-align: center; color: var(--muted); padding: 44px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
    .footer { color: var(--muted); font-size: 9.5px; text-align: center; margin-top: 13px; opacity: .8; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
    }
    html.embedded-mac main, html.embedded-windows main { width: 100%; max-width: none; padding-top: 10px; }
    html.embedded-mac .footer, html.embedded-windows .footer { margin-bottom: 4px; }
    @media (max-width: 720px) {
      .desktop-shell { display: block; }
      .app-sidebar { position: sticky; z-index: 10; height: auto; padding: max(8px, env(safe-area-inset-top)) 10px 8px; border-right: 0; border-bottom: 1px solid var(--line); }
      .sidebar-brand, .sidebar-meta { display: none; }
      .sidebar-nav { display: flex; gap: 5px; overflow-x: auto; scrollbar-width: none; }
      .sidebar-nav::-webkit-scrollbar { display: none; }
      .sidebar-nav .view-tab { flex: 0 0 auto; width: auto; min-height: 40px; padding: 8px 12px; font-size: 14px; }
      main { padding-left: 12px; padding-right: 12px; padding-bottom: max(92px, calc(env(safe-area-inset-bottom) + 72px)); }
      header { gap: 10px; min-height: 50px; margin-bottom: 14px; }
      .header-main { gap: 9px; }
      .app-mark { width: 40px; height: 40px; }
      .live { gap: 7px; font-size: 13px; }
      .dot { width: 8px; height: 8px; }
      .metric { min-height: 30px; padding: 4px 8px; gap: 5px; }
      .metric b { font-size: 15px; }
      .metric span { font-size: 13px; }
      .gallery-note { margin-bottom: 17px; padding: 12px 13px; border-radius: 13px; font-size: 14px; line-height: 1.55; }
      .gallery-section + .gallery-section { margin-top: 22px; }
      .section-head { align-items: flex-start; flex-wrap: wrap; margin-bottom: 11px; }
      .section-head h2 { font-size: 18px; line-height: 1.35; }
      .section-head span { font-size: 13px; line-height: 1.4; }
      #cards { grid-template-columns: 1fr; }
      .gallery-grid { grid-template-columns: 1fr; }
      .gallery-card { border-radius: 16px; padding: 16px; }
      .gallery-title-row { align-items: flex-start; margin-bottom: 11px; }
      .gallery-title { font-size: 18px; }
      .gallery-state { padding: 5px 10px; font-size: 13px; line-height: 1.35; }
      .gallery-critical-badge { margin-bottom: 9px; padding: 5px 9px; font-size: 13px; }
      .gallery-warning { padding: 11px 12px; font-size: 15px; line-height: 1.5; }
      .gallery-critical-meta { padding: 10px 11px; font-size: 13px; line-height: 1.55; }
      .gallery-preview { font-size: 16px; line-height: 1.5; }
      .gallery-time { font-size: 13px; line-height: 1.5; }
      .gallery-impact { padding: 9px 11px; font-size: 14px; line-height: 1.5; }
      .gallery-meta { font-size: 13px; line-height: 1.5; }
      .gallery-details, .gallery-dev { margin-top: 9px; padding-left: 11px; padding-right: 11px; border-radius: 10px; }
      .gallery-details summary, .gallery-dev summary { min-height: 44px; display: flex; align-items: center; padding: 10px 0; font-size: 14px; line-height: 1.4; }
      .gallery-detail-command { font-size: 12.5px; line-height: 1.55; }
      .gallery-dev-grid { grid-template-columns: 1fr; gap: 2px; padding-bottom: 10px; font-size: 12.5px; line-height: 1.5; }
      .gallery-dev-value + .gallery-dev-key { margin-top: 6px; }
      .gallery-status-message { font-size: 13.5px; }
      .gallery-actions { gap: 10px; margin-top: 13px; }
      .gallery-actions button, .gallery-choice { min-height: 48px; font-size: 15px; }
      .gallery-choice { padding: 10px 12px; }
      .gallery-choice small { font-size: 13px; }
      .card { border-radius: 14px; padding: 14px; }
      .card-primary { grid-template-columns: auto minmax(0,1fr) auto auto; gap: 6px 7px; }
      .project-badge { max-width: 112px; min-height: 25px; font-size: 12px; }
      .title { font-size: 15px; }
      .start-time { font-size: 12px; }
      .status { min-height: 26px; padding-left: 7px; padding-right: 7px; font-size: 12px; }
      .work-group-label { font-size: 12px; }
      .work-group-activity { font-size: 13px; }
      .activity-preview-line, .activity-line { font-size: 13px; }
      .activity-time { flex-basis: 46px; font-size: 12px; }
      .activity-detail { margin-left: 54px; font-size: 12.5px; }
      .footer { font-size: 12px; }
      .settings-card { padding: 15px; border-radius: 16px; }
      .settings-card h2 { font-size: 18px; }
      .settings-card > p { font-size: 13px; }
      .settings-row { grid-template-columns: 1fr; gap: 5px; padding: 9px 0; }
      .settings-label { font-size: 13px; }
      .settings-control input[type="text"], .settings-control input[type="number"], .settings-control select { min-height: 42px; font-size: 15px; }
      .settings-check { min-height: 40px; font-size: 15px; }
      .settings-save { min-height: 44px; font-size: 15px; }
      .settings-status { font-size: 13px; }
    }
  </style>
</head>
<body>
<!-- activity-dashboard-hot-override-enabled -->
<div class="desktop-shell">
<aside class="app-sidebar" aria-label="ChatGPT To Codex 탐색">
  <nav class="sidebar-nav" aria-label="데스크톱 보기">
    <button id="view-activity" class="view-tab active" type="button">작업 현황</button>
    <button id="view-approvals" class="view-tab" type="button">승인</button>
    <button id="view-connection" class="view-tab" type="button">MCP / 연결</button>
    <button id="view-cards" class="view-tab" type="button">카드 미리보기</button>
    <button id="view-settings" class="view-tab" type="button">설정</button>
    <button id="view-diagnostics" class="view-tab" type="button">진단</button>
  </nav>
</aside>
<div class="app-main">
<main>
  <header>
    <div class="header-main">
      <div class="app-mark" aria-label="ChatGPT To Codex">
        <svg viewBox="0 0 1024 1024" role="img" aria-hidden="true">
          <defs>
            <linearGradient id="dash-bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#087E78"/><stop offset=".55" stop-color="#119B93"/><stop offset="1" stop-color="#20B6AD"/>
            </linearGradient>
            <linearGradient id="dash-shield" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#FF9C14"/><stop offset="1" stop-color="#FF7A00"/>
            </linearGradient>
          </defs>
          <rect x="28" y="28" width="968" height="968" rx="210" fill="url(#dash-bg)"/>
          <g fill="none" stroke="#fff" stroke-width="64" stroke-linecap="round" stroke-linejoin="round">
            <path d="M514 171 C321 171 176 308 176 491 C176 594 225 684 306 744 L286 842 L405 777 C440 786 476 791 514 791 C705 791 852 655 852 476 C852 299 706 171 514 171 Z"/>
            <path d="M426 388 L334 480 L426 572"/><path d="M602 388 L694 480 L602 572"/><path d="M552 349 L476 611"/>
          </g>
          <path d="M720 596 C789 620 850 618 905 596 L919 610 V738 C919 833 858 895 812 919 C766 895 705 833 705 738 V610 Z" fill="url(#dash-shield)" stroke="#FFD13A" stroke-width="26" stroke-linejoin="round"/>
          <path d="M755 758 L799 802 L873 718" fill="none" stroke="#fff" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <section class="summary" aria-label="작업 상태">
        <div class="metric"><b id="m-active">0</b><span>진행</span></div>
        <div id="metric-attention" class="metric attention"><b id="m-attention">0</b><span>주의</span></div>
        <div id="metric-approval" class="metric approval"><b id="m-approval">0</b><span>승인</span></div>
      </section>
    </div>
    <div class="live"><span id="live-dot" class="dot"></span><span id="live-text">연결 중</span></div>
  </header>
  <section id="activity-view" class="view-panel">
    <nav id="filters" class="toolbar"></nav>
    <section id="cards"></section>
  </section>
  <section id="approvals-view" class="view-panel" hidden>
    <section id="approval-box" class="approval-box hidden">
      <div class="section-head"><h2>승인 필요</h2><span id="approval-label">0건</span></div>
      <div id="approvals" class="approval-list"></div>
    </section>
    <div id="approvals-empty" class="empty">현재 대기 중인 승인이 없습니다.</div>
  </section>
  <section id="connection-view" class="view-panel" hidden>
    <div class="section-head"><h2>MCP / 연결</h2><span>공통 연결 상태</span></div>
    <section id="mcp-health-box" class="mcp-health-box">
      <div class="section-head"><h2>C2CT MCP Health</h2><span id="mcp-health-state" class="mcp-health-state healthy">확인 중</span></div>
      <div id="mcp-health-reason" class="mcp-health-reason">내부 진단 상태를 확인하는 중입니다.</div>
      <div id="mcp-health-meta" class="mcp-health-meta"></div>
      <div id="mcp-health-events" class="mcp-health-events"></div>
    </section>
  </section>
  <section id="diagnostics-view" class="view-panel" hidden>
    <section id="deployment-box" class="deployment-box hidden">
      <div class="section-head"><h2>배포 상태</h2><span id="deployment-label">0건</span></div>
      <div id="deployments" class="deployment-list"></div>
    </section>
    <section id="widget-load-box" class="widget-load-box hidden">
      <div class="section-head"><h2>카드 로딩</h2><span id="widget-load-label">0건</span></div>
      <div id="widget-performance" class="mcp-health-meta"></div>
      <div id="widget-loads" class="widget-load-list"></div>
    </section>
    <div id="diagnostics-empty" class="empty">표시할 배포 또는 카드 로딩 진단이 없습니다.</div>
  </section>
  <section id="settings-view" class="view-panel" hidden>
    <div class="settings-stack">
      <section class="settings-card">
        <h2>일반</h2>
        <p>Mac과 Windows가 함께 사용하는 데스크톱 설정입니다. 플랫폼별 동작은 각 네이티브 셸이 같은 값을 적용합니다.</p>
        <div class="settings-row"><div class="settings-label">언어</div><div class="settings-control"><select id="setting-language"><option value="auto">자동</option><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh-Hans">简体中文</option><option value="zh-Hant">繁體中文</option></select></div></div>
        <div class="settings-row"><div class="settings-label">기본 프로젝트</div><div class="settings-control"><input id="setting-project" type="text" autocomplete="off" placeholder="프로젝트 폴더 경로"></div></div>
        <div class="settings-row"><div class="settings-label">시작 동작</div><div class="settings-control"><label class="settings-check"><input id="setting-launch" type="checkbox">로그인 시 ChatGPT To Codex 실행</label></div></div>
        <div class="settings-row"><div class="settings-label"></div><div class="settings-control"><label class="settings-check"><input id="setting-start-mcp" type="checkbox">앱 실행 시 MCP 시작</label></div></div>
        <div class="settings-row"><div class="settings-label"></div><div class="settings-control"><label class="settings-check"><input id="setting-updates" type="checkbox">업데이트 자동 확인</label></div></div>
        <div class="settings-row"><div class="settings-label">프로젝트 작업</div><div class="settings-control"><label class="settings-check"><input id="setting-lanes" type="checkbox">멀티 프로젝트 작업 레인 사용</label></div></div>
      </section>
      <section class="settings-card">
        <h2>연결</h2>
        <p>로컬 MCP와 ChatGPT에서 접근할 공개 주소를 관리합니다. 터널 종류에 따른 실제 연결은 플랫폼 셸이 적용합니다.</p>
        <div class="settings-row"><div class="settings-label">공개 연결</div><div class="settings-control"><label class="settings-check"><input id="setting-tunnel" type="checkbox">공개 터널 사용</label></div></div>
        <div class="settings-row"><div class="settings-label">공개 주소</div><div class="settings-control"><input id="setting-host" type="text" autocomplete="off" placeholder="host.example.com 또는 https://..."></div></div>
        <div class="settings-row"><div class="settings-label">MCP 포트</div><div class="settings-control"><input id="setting-port" type="number" min="1" max="65535" inputmode="numeric"></div></div>
        <div class="settings-row"><div class="settings-label">MCP 서비스</div><div class="settings-control"><button id="settings-restart-mcp" class="settings-save" type="button">MCP 재시작</button></div></div>
      </section>
      <section class="settings-card">
        <h2>런타임 복구</h2>
        <p>최근 성공한 런타임 교체 직전의 immutable snapshot으로만 되돌립니다. 임의 경로는 선택할 수 없고, Mac 앱의 네이티브 확인창에서 현재/이전 fingerprint를 다시 확인한 뒤 실행됩니다.</p>
        <div class="settings-row"><div class="settings-label">이전 정상 버전</div><div class="settings-control"><button id="settings-rollback-runtime" class="settings-save" type="button">이전 런타임으로 복구</button></div></div>
      </section>
      <section class="settings-card">
        <h2>데스크톱 제어</h2>
        <p>ChatGPT가 제어할 수 있는 앱 이름입니다. 실행 중 앱을 + 버튼으로 고르는 UX는 후속 네이티브 브리지 단계에서 연결합니다.</p>
        <div class="settings-row"><div class="settings-label">허용 앱</div><div class="settings-control"><input id="setting-allowlist" type="text" autocomplete="off" placeholder="Finder, UTM"></div></div>
        <div class="settings-actions"><span id="settings-status" class="settings-status">이 PC의 설정을 불러오는 중…</span><button id="settings-save" class="settings-save" type="button">저장</button></div>
      </section>
      <section class="settings-card">
        <h2>외부 MCP</h2>
        <p>신뢰하는 GitHub MCP 저장소를 이 PC에 설치하고 실행합니다. 업데이트는 기존 서버 ID·ref·실행 설정·환경변수 설정을 유지한 채 새 revision만 교체하며, 새 버전 시작에 실패하면 이전 revision으로 되돌립니다.</p>
        <div class="settings-row"><div class="settings-label">GitHub 저장소</div><div class="settings-control"><input id="managed-mcp-repository" type="text" autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/repository"></div></div>
        <div class="settings-row"><div class="settings-label">브랜치 / 태그</div><div class="settings-control"><input id="managed-mcp-ref" type="text" autocomplete="off" spellcheck="false" placeholder="비워두면 기본 브랜치"></div></div>
        <div class="settings-row"><div class="settings-label">설치 옵션</div><div class="settings-control"><label class="settings-check"><input id="managed-mcp-build" type="checkbox" checked>저장소에 build 스크립트가 있으면 실행</label></div></div>
        <div class="settings-actions"><span id="managed-mcp-status" class="settings-status">설치된 외부 MCP를 불러오는 중…</span><button id="managed-mcp-install" class="settings-save" type="button">MCP 설치</button></div>
        <div id="managed-mcp-list" class="managed-mcp-list"><div class="command-grant-empty">설치 목록을 불러오는 중…</div></div>
      </section>
      <section class="settings-card">
        <h2>프로젝트 명령 승인</h2>
        <p>“이 프로젝트에서 허용”으로 저장한 exact executable + argv 승인입니다. 회수하면 해당 프로필은 즉시 프로젝트 명령 승격에서 빠집니다.</p>
        <div id="command-grants" class="command-grant-list"><div class="command-grant-empty">승인 목록을 불러오는 중…</div></div>
      </section>
    </div>
  </section>
  <section id="gallery-view" class="view-panel" hidden>
    <div class="gallery-note"><b>미리보기 전용</b> · 현재 ChatGPT 카드 상태머신과 같은 사용자 흐름을 한곳에 모았습니다. 이 화면의 클릭은 실제 승인이나 작업을 실행하지 않으며, 승인 카드의 프롬프트는 실제 전송 경로와 같은 공용 문자열 소스를 사용합니다.</div>
    <section class="gallery-section">
      <div class="section-head"><h2>인라인 승인 카드</h2><span>현재 승인 · 자동 재개 흐름</span></div>
      <div class="gallery-grid">
        <article class="gallery-card" data-gallery-flow="보호 작업 요청 생성|서버에 pending 승인 저장|카드 즉시 표시|허용 1회|서버 authoritative allow 확정|exact 작업 continuation 시작|현재 채팅 자동 재개 1회|작업 상태 자동 확인">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state orange">승인 대기</span></div>
          <div class="gallery-preview">프로젝트 chatgpt2codex · 보호 작업 “command_run” 1회 수행</div>
          <div class="gallery-time">생성: 2026. 09. 27. 12:40:12 · 만료: 2026. 09. 27. 12:45:12</div>
          <div class="gallery-impact">영향: 승인된 정확한 요청만 1회 실행</div>
          <details class="gallery-details"><summary>상세 명령 및 파라미터</summary><div class="gallery-detail-command">tool: command_run\nprojectId: chatgpt2codex\ncommandId: npm:test\nwritesWorkspace: false</div></details>
          <div class="gallery-actions"><button class="deny" data-preview-label="거절" data-preview-prompt-key="deny" data-preview-effect="서버에 denied 결정을 저장하고 보호 작업은 실행하지 않습니다.">거절</button><button class="allow" data-preview-label="허용" data-preview-prompt-key="allow" data-preview-effect="정확히 이 one-shot 승인을 저장하고 연결된 작업을 시작합니다. 승인 확정 뒤 현재 채팅도 자동으로 한 번 재개되므로 완료 결과 확인 버튼을 다시 누르지 않습니다.">허용</button></div>
        </article>
        <article class="gallery-card" data-gallery-flow="일반 consent 요청|pending 카드 표시|사용자 범위 선택|이번만 또는 프로젝트 범위 저장|후속 대화 자동 전달">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state orange">권한 선택</span></div>
          <div class="gallery-preview">이 작업을 이번 한 번만 허용하거나 현재 프로젝트 범위에서 허용합니다.</div>
          <div class="gallery-impact">영향: 선택한 범위의 일반 consent만 저장 · operation approval과 별도</div>
          <div class="gallery-actions"><button class="deny" data-preview-label="거절" data-preview-prompt-set="standard" data-preview-prompt-key="deny" data-preview-effect="일반 consent 요청을 거절하고 후속 대화에 거절 의도를 전달합니다.">거절</button><button class="allow" data-preview-label="이번만 허용" data-preview-prompt-set="standard" data-preview-prompt-key="allow" data-preview-effect="이번 요청만 허용하고 후속 대화를 자동 전달합니다.">이번만 허용</button><button class="allow" data-preview-label="이 프로젝트에서 허용" data-preview-prompt-set="standard" data-preview-prompt-key="allowProject" data-preview-effect="현재 프로젝트 범위 consent를 저장하고 후속 대화를 자동 전달합니다.">이 프로젝트에서 허용</button></div>
        </article>
        <article class="gallery-card critical" data-gallery-flow="고위험 작업 preflight|exact 요청 봉인|Critical Approval 표시|허용 1회|봉인된 worker 시작|현재 채팅 자동 재개|health / rollback 확인|필요 시 수동 Settings 새로고침 handoff">
          <div class="gallery-title-row"><div class="gallery-title">⚠️ 고위험 승인</div><span class="gallery-state red">승인 대기</span></div>
          <div class="gallery-critical-badge">Mac 시스템 변경</div>
          <div class="gallery-warning">Mac C2CT runtime 실제 교체 · 성공 후 schema 변경 시 Settings에서 C2CT를 수동 새로고침</div>
          <div class="gallery-critical-meta"><div class="gallery-critical-row"><span class="gallery-critical-key">대상</span><span class="gallery-critical-value">현재 fingerprint → sealed candidate</span></div><div class="gallery-meta">롤백: 새 runtime health check 실패 시 기존 runtime 자동 롤백</div><div class="gallery-meta">적용 후: 정상 적용 후 자동 catalog refresh 없음 · Settings 수동 새로고침 후 scan-tools 별도 실행</div></div>
          <div class="gallery-preview">현재 runtime을 새 immutable runtime으로 교체합니다.</div>
          <div class="gallery-time">승인은 exact request와 현재 세션에만 결합</div>
          <div class="gallery-impact">영향: 앱/runtime/process 실제 변경 가능</div>
          <details class="gallery-details"><summary>상세 명령 및 파라미터</summary><div class="gallery-detail-command">tool: runtime_apply_local\nprojectId: chatgpt2codex\npreserveConnector: true\nrollbackOnHealthFailure: true</div></details>
          <details class="gallery-details"><summary>기술 원문</summary><div class="gallery-detail-command">CRITICAL: replace the live C2CT runtime; preserve supervisor/connector/tunnel; never replay an approved mutation</div></details>
          <div class="gallery-actions"><button class="deny" data-preview-label="거절" data-preview-prompt-key="deny" data-preview-effect="고위험 작업을 시작하지 않고 요청을 거절 상태로 종료합니다.">거절</button><button class="allow" data-preview-label="위험을 이해하고 승인" data-preview-prompt-key="allow" data-preview-effect="봉인된 exact 작업만 시작합니다. 승인 후 mutation을 다시 호출하지 않고 status-only로 이어가며 현재 채팅은 자동 재개합니다.">위험을 이해하고 승인</button></div>
        </article>
        <article class="gallery-card critical" data-gallery-flow="검증된 app build 확인|exact app 교체 요청 봉인|Critical Approval 표시|허용 1회|/Applications 교체|app/supervisor/runtime 재기동|health 확인 또는 rollback|현재 채팅 자동 재개">
          <div class="gallery-title-row"><div class="gallery-title">⚠️ 고위험 승인</div><span class="gallery-state red">승인 대기</span></div>
          <div class="gallery-critical-badge">Mac 앱 교체</div>
          <div class="gallery-warning">/Applications 앱 실제 교체 · app/supervisor/runtime 재기동 가능 · 연결 일시 중단 가능</div>
          <div class="gallery-critical-meta"><div class="gallery-critical-row"><span class="gallery-critical-key">대상</span><span class="gallery-critical-value">현재 executable → 검증된 새 executable</span></div><div class="gallery-meta">롤백: 설치/health verification 실패 시 기존 앱·실행 상태 롤백</div></div>
          <div class="gallery-preview">검증된 ChatGPT To Codex 앱을 /Applications에 설치합니다.</div>
          <div class="gallery-impact">영향: 앱 파일 교체와 연결 일시 중단 가능</div>
          <div class="gallery-actions"><button class="deny" data-preview-label="거절" data-preview-prompt-key="deny" data-preview-effect="앱을 교체하지 않고 exact 요청을 종료합니다.">거절</button><button class="allow" data-preview-label="위험을 이해하고 승인" data-preview-prompt-key="allow" data-preview-effect="승인에 묶인 exact app worker만 시작합니다. mutation을 재호출하지 않고 status-only로 이어가며 현재 채팅은 자동 재개합니다.">위험을 이해하고 승인</button></div>
        </article>
        <article class="gallery-card success" data-gallery-flow="허용 클릭|서버 allow 확정|one-shot worker 시작|현재 채팅 자동 재개 dispatch|operation 상태 자동 관찰">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state green">승인 완료</span></div>
          <div class="gallery-preview">승인 완료 · 작업 실행 중</div>
          <div class="gallery-impact">영향: 승인된 정확한 작업 1회만 실행</div>
          <div class="gallery-status-message">현재 채팅 자동 재개 중 · 별도의 “완료 결과 확인” 버튼을 다시 누르지 않음</div>
        </article>
        <article class="gallery-card success" data-gallery-flow="승인 완료|작업 terminal 관찰|outputRef 보존|현재 채팅 자동 재개 latch 확인|카드 terminal 상태 유지">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state green">처리 완료</span></div>
          <div class="gallery-preview">작업 완료 · 결과 확인 가능</div>
          <div class="gallery-status-message">현재 채팅 자동 재개됨 · 동일 승인으로 mutation 재실행 불가</div>
        </article>
        <article class="gallery-card denied" data-gallery-flow="승인 카드 표시|거절 클릭|서버에 denied 저장|원래 작업 중단|terminal 상태 유지">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state red">거절 완료</span></div>
          <div class="gallery-preview">요청이 거절되어 보호 작업은 실행되지 않습니다.</div>
          <div class="gallery-status-message">기존 one-shot token 재사용 금지 · 다시 필요하면 새 요청 생성</div>
        </article>
        <article class="gallery-card" data-gallery-flow="사용자 결정 수신|decision 요청 1회|서버 authoritative 검증 중|중복 클릭 차단|응답 또는 receipt reconciliation">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state blue">처리 중</span></div>
          <div class="gallery-preview">승인 결정을 서버에 저장하고 연결된 작업을 준비하는 중입니다.</div>
          <div class="gallery-impact">영향: authoritative allow 전에는 실행 권한으로 간주하지 않음</div>
          <div class="gallery-actions"><button disabled>거절</button><button disabled>허용</button></div>
        </article>
        <article class="gallery-card muted" data-gallery-flow="pending 카드 표시|서버 expiry 확인|버튼 비활성|새 요청 필요">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state gray">만료</span></div>
          <div class="gallery-preview">승인 유효 시간이 지나 카드가 비활성화되었습니다.</div>
          <div class="gallery-status-message">만료된 token 재사용 금지 · 새 승인 요청 필요</div>
        </article>
        <article class="gallery-card" data-gallery-flow="decision 응답 유실 또는 status 오류|서버 receipt 상태만 재조회|mutation 자동 재전송 금지|읽기 전용 복구">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state orange">확인 불가</span></div>
          <div class="gallery-preview">서버 승인 기록을 확인할 수 없습니다.</div>
          <div class="gallery-status-message">승인 재전송 없이 상태만 다시 확인할 수 있습니다.</div>
          <div class="gallery-actions"><button class="gallery-choice" data-preview-label="상태만 다시 확인" data-preview-effect="persisted approval/receipt를 읽기 전용으로 확인합니다. 기존 mutation은 재실행하지 않습니다.">상태만 다시 확인</button></div>
        </article>
        <article class="gallery-card denied" data-gallery-flow="authoritative allow 확정|채팅 자동 재개 전송 실패|승인 성공 상태 유지|mutation 재실행 금지|사용자가 채팅에서 상태 확인 가능">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state red">대화 재개 실패</span></div>
          <div class="gallery-preview">승인된 작업은 그대로 유지되지만 현재 채팅 자동 재개 전송에 실패했습니다.</div>
          <div class="gallery-status-message">승인된 작업은 재실행하지 않음 · 필요하면 채팅에서 status-only 확인</div>
        </article>
      </div>
    </section>
    <section class="gallery-section">
      <div class="section-head"><h2>선택 · 진행 카드</h2><span>Widget Shell / handoff</span></div>
      <div class="gallery-grid">
        <article class="gallery-card" data-gallery-flow="선택 카드 payload 생성|Widget Shell 표시|사용자 옵션 선택|로컬 선택 상태 저장|선택 intent를 후속 대화 입력으로 전달">
          <div class="gallery-title-row"><div class="gallery-title">다음 작업 선택</div><span class="gallery-state blue">선택 대기</span></div>
          <div class="gallery-preview">여러 안전한 경로 중 하나를 선택하는 일반 Widget Shell 카드입니다.</div>
          <div class="gallery-choice-list">
            <button class="gallery-choice" data-preview-label="상태만 확인" data-preview-effect="선택 intent가 다음 사용자 입력으로 전달되고 읽기 전용 상태 확인을 이어갑니다.">상태만 확인<small>읽기 전용으로 현재 상태를 다시 확인합니다.</small></button>
            <button class="gallery-choice" data-preview-label="검증 진행" data-preview-effect="선택 intent가 다음 사용자 입력으로 전달되고 테스트·빌드 검증을 이어갑니다.">검증 진행<small>테스트와 빌드를 실행해 변경을 검증합니다.</small></button>
            <button class="gallery-choice" data-preview-label="나중에 하기" data-preview-effect="추가 작업 없이 선택 카드 흐름만 종료합니다.">나중에 하기<small>아무 변경 없이 카드를 닫습니다.</small></button>
          </div>
        </article>
        <article class="gallery-card" data-gallery-flow="compact continuation 카드 표시|15초 countdown|사용자가 먼저 누르면 즉시 진행|취소하면 자동 진행 중단|timer 만료 시 후속 대화 1회 전달">
          <div class="gallery-title-row"><div class="gallery-title">계속 진행</div><span class="gallery-state blue">자동 진행 대기</span></div>
          <div class="gallery-preview">15초 후 자동으로 계속합니다.</div>
          <div class="gallery-choice-list"><button class="gallery-choice" data-preview-label="계속 진행하기" data-preview-effect="후속 대화를 즉시 1회 전달하고 자동 timer를 종료합니다.">계속 진행하기</button><button class="gallery-choice" data-preview-label="자동 진행 취소" data-preview-effect="자동 진행 timer만 취소하고 보호 작업 승인에는 영향을 주지 않습니다.">자동 진행 취소</button></div>
        </article>
        <article class="gallery-card" data-gallery-flow="runtime 적용 완료|Settings에서 C2CT 수동 새로고침|사용자가 완료 클릭|scan-tools 정확히 1회|필요 시 generation 재진입 안내">
          <div class="gallery-title-row"><div class="gallery-title">C2CT 새로고침</div><span class="gallery-state orange">사용자 확인 대기</span></div>
          <div class="gallery-preview">Settings에서 C2CT를 새로고침한 뒤 확인해 주세요.</div>
          <div class="gallery-choice-list"><button class="gallery-choice" data-preview-label="완료" data-preview-effect="Settings 새로고침이 이미 끝났다는 확인입니다. catalog-refresh를 다시 하지 않고 scan-tools를 정확히 1회 실행합니다.">완료</button></div>
        </article>
        <article class="gallery-card" data-gallery-flow="scan-tools에서 새 generation marker 확인|재진입 카드 표시|@C2CT 탭해 복사|ChatGPT 입력창에서 native 도구 mention 선택 후 전송|exact marker 직접 호출">
          <div class="gallery-title-row"><div class="gallery-title">C2CT 다시 연결</div><span class="gallery-state blue">재진입 필요</span></div>
          <div class="gallery-preview">현재 채팅이 새 도구 generation을 직접 마운트했는지 확인합니다.</div>
          <div class="gallery-choice-list"><button class="gallery-choice" data-preview-label="@C2CT" data-preview-effect="토큰을 복사합니다. Widget의 합성 follow-up이 아니라 ChatGPT 입력창에서 native @C2CT 도구 mention을 선택해 직접 전송해야 합니다.">@C2CT<small>탭해서 복사 후 입력창에서 도구 선택, 전송</small></button></div>
        </article>
      </div>
    </section>
    <section class="gallery-section">
      <div class="section-head"><h2>Activity 작업 카드</h2><span>대표 상태</span></div>
      <div class="gallery-grid gallery-activity">
        <article class="card status-blue" data-gallery-flow="activity event 기록|dashboard poll 수신|프로젝트/상태 정규화|작업 중 카드 렌더"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title">승인 UX 수정</div><span class="start-time">12:42</span><span class="status blue">작업 중</span></div></article>
        <article class="card status-orange" data-gallery-flow="보호 작업 approval 대기|activity event 갱신|dashboard poll 수신|승인 대기 카드 렌더"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title">런타임 교체</div><span class="start-time">12:44</span><span class="status orange">승인 대기</span></div></article>
        <article class="card status-green" data-gallery-flow="검증 작업 시작|완료 event 기록|dashboard poll 수신|완료 카드 렌더"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title">전체 테스트</div><span class="start-time">12:46</span><span class="status green">완료</span></div></article>
        <article class="card status-red" data-gallery-flow="도구 실행 시작|실패 event 기록|dashboard poll 수신|실패 카드 렌더"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title">도구 호출</div><span class="start-time">12:47</span><span class="status red">실패</span></div></article>
        <article class="card status-gray" data-gallery-flow="과거 terminal event 보존|현재 세션과 분리|dashboard history 분류|이전 실패 카드 렌더"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title provisional">이전 실패 기록</div><span class="start-time">11:12</span><span class="status gray">이전 실패</span></div></article>
      </div>
    </section>
  </section>
</main>
</div>
</div>
<script>
(function () {
  var pageDashboardRevision = "__C2CT_ACTIVITY_DASHBOARD_REVISION__";
  var initialParams = new URLSearchParams(window.location.search);
  var dashboardHostname = String(window.location.hostname || "").toLowerCase();
  var isLocalDashboard = dashboardHostname === "127.0.0.1"
    || dashboardHostname === "localhost"
    || dashboardHostname === "::1"
    || dashboardHostname === "[::1]";
  var isTailscaleDashboard = dashboardHostname.endsWith(".ts.net");
  var settingsEnabled = isLocalDashboard;
  var devCardsEnabled = isLocalDashboard || isTailscaleDashboard;
  var initialView = initialParams.get("view");
  function normalizedView(value) {
    if (value === "cards" && devCardsEnabled) return "cards";
    if (value === "settings" && settingsEnabled) return "settings";
    if (["activity", "approvals", "connection", "diagnostics"].indexOf(value) >= 0) return value;
    return "activity";
  }
  var selectedView = normalizedView(initialView);
  var selectedProject = "all";
  var latest = [];
  var latestApprovals = [];
  var latestDeployments = [];
  var latestMcpHealth = null;
  var latestWidgetLoads = [];
  var latestWidgetPerformance = null;
  var expandedToolRequestChats = new Set();
  var expandedOperationDetails = new Set();
  var lastFilterSignature = "";
  var reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var embeddedPlatform = initialParams.get("embedded");
  if (embeddedPlatform === "mac" || embeddedPlatform === "windows") {
    document.documentElement.classList.add("embedded-" + embeddedPlatform);
  }
  var macBridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.c2ctMacApp
    ? window.webkit.messageHandlers.c2ctMacApp
    : null;
  var cards = document.getElementById("cards");
  var filters = document.getElementById("filters");
  var approvals = document.getElementById("approvals");
  var approvalBox = document.getElementById("approval-box");
  var approvalLabel = document.getElementById("approval-label");
  var deployments = document.getElementById("deployments");
  var deploymentBox = document.getElementById("deployment-box");
  var deploymentLabel = document.getElementById("deployment-label");
  var mcpHealthBox = document.getElementById("mcp-health-box");
  var mcpHealthState = document.getElementById("mcp-health-state");
  var mcpHealthReason = document.getElementById("mcp-health-reason");
  var mcpHealthMeta = document.getElementById("mcp-health-meta");
  var mcpHealthEvents = document.getElementById("mcp-health-events");
  var widgetLoads = document.getElementById("widget-loads");
  var widgetLoadBox = document.getElementById("widget-load-box");
  var widgetLoadLabel = document.getElementById("widget-load-label");
  var widgetPerformance = document.getElementById("widget-performance");
  var liveDot = document.getElementById("live-dot");
  var liveText = document.getElementById("live-text");
  var activityView = document.getElementById("activity-view");
  var approvalsView = document.getElementById("approvals-view");
  var connectionView = document.getElementById("connection-view");
  var diagnosticsView = document.getElementById("diagnostics-view");
  var galleryView = document.getElementById("gallery-view");
  var settingsView = document.getElementById("settings-view");
  var activityViewButton = document.getElementById("view-activity");
  var approvalsViewButton = document.getElementById("view-approvals");
  var connectionViewButton = document.getElementById("view-connection");
  var cardsViewButton = document.getElementById("view-cards");
  var settingsViewButton = document.getElementById("view-settings");
  var diagnosticsViewButton = document.getElementById("view-diagnostics");
  var approvalsEmpty = document.getElementById("approvals-empty");
  var diagnosticsEmpty = document.getElementById("diagnostics-empty");
  var settingsLoaded = false;
  var mutableControlsAvailable = false;
  var restartPending = false;
  var restartRequestedAt = 0;
  var restartSawDisconnect = false;
  var operationApprovalUserPrompts = ${JSON.stringify(CHATGPT_OPERATION_APPROVAL_USER_PROMPTS)};
  var standardConsentUserPrompts = ${JSON.stringify(CHATGPT_STANDARD_CONSENT_USER_PROMPTS)};
  cardsViewButton.hidden = !devCardsEnabled;
  settingsViewButton.hidden = !settingsEnabled;

  function renderGalleryPreviewGuides() {
    document.querySelectorAll("[data-gallery-flow]").forEach(function (card) {
      if (card.getAttribute("data-gallery-enhanced") === "1") return;
      card.setAttribute("data-gallery-enhanced", "1");

      var flow = document.createElement("div");
      flow.className = "gallery-flow";
      var flowTitle = document.createElement("div");
      flowTitle.className = "gallery-flow-title";
      flowTitle.textContent = "카드 로딩 과정";
      var flowSteps = document.createElement("div");
      flowSteps.className = "gallery-flow-steps";
      String(card.getAttribute("data-gallery-flow") || "")
        .split("|")
        .filter(Boolean)
        .forEach(function (label, index) {
          if (index > 0) {
            var arrow = document.createElement("span");
            arrow.className = "gallery-flow-arrow";
            arrow.textContent = "→";
            flowSteps.appendChild(arrow);
          }
          var step = document.createElement("span");
          step.className = "gallery-flow-step";
          step.textContent = label;
          flowSteps.appendChild(step);
        });
      flow.append(flowTitle, flowSteps);
      card.appendChild(flow);

      var buttons = Array.from(card.querySelectorAll("[data-preview-effect]"));
      if (!buttons.length) return;

      var guide = document.createElement("div");
      guide.className = "gallery-button-guide";
      var guideTitle = document.createElement("div");
      guideTitle.className = "gallery-button-guide-title";
      guideTitle.textContent = "버튼을 누르면";
      guide.appendChild(guideTitle);
      buttons.forEach(function (button) {
        var row = document.createElement("div");
        row.className = "gallery-button-guide-row";
        var label = document.createElement("div");
        label.className = "gallery-button-guide-label";
        label.textContent = button.getAttribute("data-preview-label") || button.textContent.trim();
        var promptKey = button.getAttribute("data-preview-prompt-key");
        var promptSet = button.getAttribute("data-preview-prompt-set") === "standard" ? standardConsentUserPrompts : operationApprovalUserPrompts;
        var promptText = promptKey && promptSet[promptKey]
          ? promptSet[promptKey]
          : (button.getAttribute("data-preview-prompt") || label.textContent);
        var body = document.createElement("div");
        body.className = "gallery-button-guide-body";
        var effect = document.createElement("div");
        effect.className = "gallery-button-guide-effect";
        effect.textContent = button.getAttribute("data-preview-effect") || "";
        var prompt = document.createElement("div");
        prompt.className = "gallery-button-guide-prompt";
        prompt.textContent = "실제 입력 프롬프트 · " + promptText;
        body.append(effect, prompt);
        row.append(label, body);
        guide.appendChild(row);
      });
      card.appendChild(guide);

      var result = document.createElement("div");
      result.className = "gallery-sim-result";
      result.setAttribute("role", "status");
      result.setAttribute("aria-live", "polite");
      card.appendChild(result);
      buttons.forEach(function (button) {
        if (button.disabled) return;
        button.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          var label = button.getAttribute("data-preview-label") || button.textContent.trim();
          var promptKey = button.getAttribute("data-preview-prompt-key");
          var promptSet = button.getAttribute("data-preview-prompt-set") === "standard" ? standardConsentUserPrompts : operationApprovalUserPrompts;
          var promptText = promptKey && promptSet[promptKey]
            ? promptSet[promptKey]
            : (button.getAttribute("data-preview-prompt") || label);
          result.textContent = "미리보기 결과 · " + label + "\n실제 입력 프롬프트 · " + promptText + "\n" + (button.getAttribute("data-preview-effect") || "");
          result.classList.add("visible");
        });
      });
    });
  }
  renderGalleryPreviewGuides();

  function setDashboardView(nextView, updateLocation) {
    selectedView = normalizedView(nextView);
    activityView.hidden = selectedView !== "activity";
    approvalsView.hidden = selectedView !== "approvals";
    connectionView.hidden = selectedView !== "connection";
    diagnosticsView.hidden = selectedView !== "diagnostics";
    galleryView.hidden = selectedView !== "cards";
    settingsView.hidden = selectedView !== "settings";
    activityViewButton.classList.toggle("active", selectedView === "activity");
    approvalsViewButton.classList.toggle("active", selectedView === "approvals");
    connectionViewButton.classList.toggle("active", selectedView === "connection");
    settingsViewButton.classList.toggle("active", selectedView === "settings");
    diagnosticsViewButton.classList.toggle("active", selectedView === "diagnostics");
    cardsViewButton.classList.toggle("active", selectedView === "cards");
    activityViewButton.setAttribute("aria-pressed", selectedView === "activity" ? "true" : "false");
    approvalsViewButton.setAttribute("aria-pressed", selectedView === "approvals" ? "true" : "false");
    connectionViewButton.setAttribute("aria-pressed", selectedView === "connection" ? "true" : "false");
    settingsViewButton.setAttribute("aria-pressed", selectedView === "settings" ? "true" : "false");
    diagnosticsViewButton.setAttribute("aria-pressed", selectedView === "diagnostics" ? "true" : "false");
    cardsViewButton.setAttribute("aria-pressed", selectedView === "cards" ? "true" : "false");
    if (updateLocation && window.history && window.history.replaceState) {
      var url = new URL(window.location.href);
      if (selectedView === "activity") url.searchParams.delete("view");
      else url.searchParams.set("view", selectedView);
      window.history.replaceState(null, "", url);
    }
    if (selectedView === "settings" && !settingsLoaded) loadSettings();
  }
  activityViewButton.addEventListener("click", function () { setDashboardView("activity", true); });
  approvalsViewButton.addEventListener("click", function () { setDashboardView("approvals", true); });
  connectionViewButton.addEventListener("click", function () { setDashboardView("connection", true); });
  cardsViewButton.addEventListener("click", function () { setDashboardView("cards", true); });
  settingsViewButton.addEventListener("click", function () { setDashboardView("settings", true); });
  diagnosticsViewButton.addEventListener("click", function () { setDashboardView("diagnostics", true); });
  setDashboardView(selectedView, false);

  function setting(id) { return document.getElementById(id); }
  function settingsStatus(text, kind) {
    var node = setting("settings-status");
    node.textContent = text;
    node.classList.toggle("success", kind === "success");
    node.classList.toggle("error", kind === "error");
  }
  function setMutableControlsAvailable(available) {
    mutableControlsAvailable = Boolean(available);
    var disabled = !mutableControlsAvailable || restartPending;
    ["setting-language", "setting-project", "setting-launch", "setting-start-mcp", "setting-updates", "setting-lanes", "setting-tunnel", "setting-host", "setting-port", "setting-allowlist", "settings-save", "settings-rollback-runtime", "managed-mcp-repository", "managed-mcp-ref", "managed-mcp-build", "managed-mcp-install"].forEach(function (id) {
      var node = setting(id);
      if (node) node.disabled = disabled;
    });
    var restartButton = setting("settings-restart-mcp");
    if (restartButton) {
      restartButton.disabled = restartPending || (!macBridge && !mutableControlsAvailable);
      restartButton.textContent = restartPending ? "MCP 복구 중…" : (mutableControlsAvailable ? "MCP 재시작" : "MCP 되살리기");
    }
    document.querySelectorAll(".approval-actions button").forEach(function (button) {
      button.disabled = disabled;
    });
    document.querySelectorAll(".command-grant-revoke").forEach(function (button) {
      button.disabled = disabled;
    });
    document.querySelectorAll(".managed-mcp-action").forEach(function (button) {
      button.disabled = disabled || button.getAttribute("data-runtime-disabled") === "true";
    });
  }
  function applySettingsForm(value) {
    value = value || {};
    setting("setting-language").value = value.language || "auto";
    setting("setting-project").value = value.projectFolder || "";
    setting("setting-launch").checked = Boolean(value.launchAtStartup);
    setting("setting-start-mcp").checked = Boolean(value.startMcpOnOpen);
    setting("setting-updates").checked = Boolean(value.autoCheckUpdates);
    setting("setting-lanes").checked = value.multiProjectLanesEnabled !== false;
    setting("setting-tunnel").checked = Boolean(value.enablePublicTunnel);
    setting("setting-host").value = value.publicHostname || "";
    setting("setting-port").value = String(value.port || 7979);
    setting("setting-allowlist").value = Array.isArray(value.controlAllowlist) ? value.controlAllowlist.join(", ") : "";
  }
  function renderCommandGrants(grants) {
    var container = setting("command-grants");
    if (!container) return;
    container.textContent = "";
    if (!Array.isArray(grants) || grants.length === 0) {
      container.appendChild(el("div", "command-grant-empty", "저장된 프로젝트 명령 승인이 없습니다."));
      return;
    }
    grants.forEach(function (grant) {
      var item = el("div", "command-grant-item");
      var main = el("div", "command-grant-main");
      var argv = Array.isArray(grant.argv) ? grant.argv.map(function (value) { return JSON.stringify(String(value)); }) : [];
      var command = [String(grant.resolvedExecutable || "")].concat(argv).filter(Boolean).join(" ");
      main.appendChild(el("div", "command-grant-command", command || String(grant.commandId || grant.grantId || "승인된 명령")));
      var metaParts = [String(grant.projectId || "프로젝트 미상"), String(grant.risk || "risk 미상")];
      if (grant.cwd) metaParts.push("cwd " + String(grant.cwd));
      if (grant.createdAt) metaParts.push("승인 " + new Date(grant.createdAt).toLocaleString("ko-KR"));
      main.appendChild(el("div", "command-grant-meta", metaParts.join(" · ")));
      var button = el("button", "command-grant-revoke", "회수");
      button.type = "button";
      button.disabled = !mutableControlsAvailable || restartPending;
      button.addEventListener("click", function () { revokeCommandGrant(grant, button); });
      item.appendChild(main);
      item.appendChild(button);
      container.appendChild(item);
    });
  }
  async function loadCommandGrants() {
    try {
      var response = await fetch("/activity/api/command-grants", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      renderCommandGrants(payload.grants);
    } catch (error) {
      var container = setting("command-grants");
      if (container) {
        container.textContent = "";
        container.appendChild(el("div", "command-grant-empty", "프로젝트 명령 승인 목록을 불러오지 못했습니다."));
      }
    }
  }
  async function revokeCommandGrant(grant, button) {
    if (!mutableControlsAvailable || restartPending || !grant || !grant.projectId || !grant.grantId) return;
    button.disabled = true;
    button.textContent = "회수 중…";
    try {
      var response = await fetch("/activity/api/command-grants/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: grant.projectId, grantId: grant.grantId })
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      await loadCommandGrants();
      settingsStatus("프로젝트 명령 승인을 회수했습니다.", "success");
    } catch (error) {
      button.textContent = "회수";
      button.disabled = !mutableControlsAvailable || restartPending;
      settingsStatus("프로젝트 명령 승인을 회수하지 못했습니다.", "error");
    }
  }
  async function loadSettings() {
    settingsStatus("이 PC의 설정을 불러오는 중…");
    loadCommandGrants();
    loadManagedMcps();
    try {
      var response = await fetch("/activity/api/settings", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      applySettingsForm(payload.settings);
      settingsLoaded = true;
      settingsStatus((payload.platform || "desktop") + " 설정과 연결됨", "success");
    } catch (error) {
      settingsStatus("설정 변경은 ChatGPT To Codex가 실행 중인 PC에서만 사용할 수 있습니다.", "error");
    }
  }
  async function saveSettings() {
    if (!mutableControlsAvailable || restartPending) return;
    var button = setting("settings-save");
    var parsedPort = Number(setting("setting-port").value);
    var body = {
      language: setting("setting-language").value,
      projectFolder: setting("setting-project").value.trim() || null,
      launchAtStartup: setting("setting-launch").checked,
      startMcpOnOpen: setting("setting-start-mcp").checked,
      autoCheckUpdates: setting("setting-updates").checked,
      multiProjectLanesEnabled: setting("setting-lanes").checked,
      enablePublicTunnel: setting("setting-tunnel").checked,
      publicHostname: setting("setting-host").value.trim() || null,
      port: Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 7979,
      controlAllowlist: setting("setting-allowlist").value.split(",").map(function (item) { return item.trim(); }).filter(Boolean)
    };
    button.disabled = true;
    settingsStatus("저장 중…");
    try {
      var response = await fetch("/activity/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      applySettingsForm(payload.settings);
      settingsLoaded = true;
      settingsStatus("저장됨 · 네이티브 적용 중", "success");
      if (macBridge) macBridge.postMessage({ action: "settingsSaved" });
    } catch (error) {
      settingsStatus("설정을 저장하지 못했습니다.", "error");
    } finally {
      setMutableControlsAvailable(mutableControlsAvailable);
    }
  }
  setting("settings-save").addEventListener("click", saveSettings);
  function managedMcpStatus(text, kind) {
    var node = setting("managed-mcp-status");
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("success", kind === "success");
    node.classList.toggle("error", kind === "error");
  }
  function managedMcpStateLabel(state) {
    return state === "running" ? "정상 실행" : state === "starting" ? "시작 중" : state === "updating" ? "업데이트 중" : state === "degraded" ? "부분 실행" : "중지";
  }
  function managedMcpUptime(startedAt) {
    if (!startedAt) return "";
    var seconds = Math.max(0, Math.floor((Date.now() - Number(startedAt)) / 1000));
    if (seconds < 60) return seconds + "초";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "분";
    var hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + "시간";
    return Math.floor(hours / 24) + "일";
  }
  function showManagedMcpDetail(detail, title, node) {
    detail.textContent = "";
    detail.classList.add("visible");
    detail.appendChild(el("div", "managed-mcp-detail-title", title));
    detail.appendChild(node);
  }
  function renderManagedMcps(servers) {
    var container = setting("managed-mcp-list");
    if (!container) return;
    container.textContent = "";
    if (!Array.isArray(servers) || servers.length === 0) {
      container.appendChild(el("div", "command-grant-empty", "설치된 외부 MCP가 없습니다."));
      return;
    }
    servers.forEach(function (server) {
      var item = el("div", "managed-mcp-item");
      var main = el("div", "managed-mcp-main");
      var title = el("div", "managed-mcp-title");
      var state = String(server.status || (server.running ? "running" : "stopped"));
      title.appendChild(el("span", "", String(server.name || server.id || "MCP")));
      title.appendChild(el("span", "managed-mcp-state " + state, managedMcpStateLabel(state)));
      main.appendChild(title);
      main.appendChild(el("div", "managed-mcp-url", String(server.repositoryUrl || "")));
      var meta = [];
      if (server.ref) meta.push("ref " + String(server.ref));
      if (server.commit) meta.push("commit " + String(server.commit).slice(0, 12));
      main.appendChild(el("div", "managed-mcp-meta", meta.join(" · ")));
      var runtime = el("div", "managed-mcp-runtime");
      var mcpRuntime = "MCP " + (server.running ? "PID " + String(server.pid || "-") + (server.startedAt ? " · " + managedMcpUptime(server.startedAt) : "") : "중지");
      runtime.appendChild(el("span", "", mcpRuntime));
      if (server.serviceConfigured) {
        var serviceRuntime = "Service " + (server.serviceRunning ? "PID " + String(server.servicePid || "-") + (server.serviceStartedAt ? " · " + managedMcpUptime(server.serviceStartedAt) : "") : "중지");
        runtime.appendChild(el("span", "", serviceRuntime));
      }
      main.appendChild(runtime);
      if (server.serviceLastExit) {
        main.appendChild(el("div", "managed-mcp-exit", "Service 최근 종료 · code " + String(server.serviceLastExit.exitCode == null ? "-" : server.serviceLastExit.exitCode) + (server.serviceLastExit.signal ? " · " + String(server.serviceLastExit.signal) : "")));
      } else if (server.mcpLastExit) {
        main.appendChild(el("div", "managed-mcp-exit", "MCP 최근 비정상 종료 기록 있음"));
      }
      var actions = el("div", "managed-mcp-actions");
      var details = el("div", "managed-mcp-detail");
      var tools = el("button", "managed-mcp-action", "도구");
      tools.type = "button";
      tools.setAttribute("data-runtime-disabled", server.running ? "false" : "true");
      tools.disabled = !mutableControlsAvailable || restartPending || !server.running;
      tools.title = server.running ? "이 MCP가 제공하는 도구 목록" : "MCP 실행 후 도구 목록을 확인할 수 있습니다.";
      tools.addEventListener("click", function () { managedMcpInspect("tools", server, details, tools); });
      actions.appendChild(tools);
      var logs = el("button", "managed-mcp-action", "로그");
      logs.type = "button";
      logs.disabled = !mutableControlsAvailable || restartPending;
      logs.addEventListener("click", function () { managedMcpInspect("logs", server, details, logs); });
      actions.appendChild(logs);
      var update = el("button", "managed-mcp-action", "업데이트 확인");
      update.type = "button";
      update.disabled = !mutableControlsAvailable || restartPending;
      update.addEventListener("click", function () { managedMcpUpdate(server, update); });
      actions.appendChild(update);
      var active = !!server.running || !!server.serviceRunning;
      var restart = el("button", "managed-mcp-action", "재시작");
      restart.type = "button";
      restart.setAttribute("data-runtime-disabled", active ? "false" : "true");
      restart.disabled = !mutableControlsAvailable || restartPending || !active;
      restart.addEventListener("click", function () { managedMcpLifecycle("restart", server, restart); });
      actions.appendChild(restart);
      var toggle = el("button", "managed-mcp-action primary", active ? "중지" : "시작");
      toggle.type = "button";
      toggle.disabled = !mutableControlsAvailable || restartPending;
      toggle.addEventListener("click", function () { managedMcpLifecycle(active ? "stop" : "start", server, toggle); });
      actions.appendChild(toggle);
      var remove = el("button", "managed-mcp-action danger", "삭제");
      remove.type = "button";
      remove.disabled = !mutableControlsAvailable || restartPending;
      remove.addEventListener("click", function () { managedMcpLifecycle("remove", server, remove); });
      actions.appendChild(remove);
      item.append(main, actions, details);
      container.appendChild(item);
    });
  }
  async function loadManagedMcps() {
    try {
      var response = await fetch("/activity/api/managed-mcp", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      renderManagedMcps(payload.servers);
      managedMcpStatus((payload.servers || []).length + "개 설치됨", "success");
    } catch (error) {
      renderManagedMcps([]);
      managedMcpStatus("외부 MCP 목록을 불러오지 못했습니다.", "error");
    }
  }
  async function managedMcpRequest(body) {
    var response = await fetch("/activity/api/managed-mcp/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    var payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(payload && payload.error ? String(payload.error) : ("HTTP " + response.status));
    return payload || {};
  }
  async function managedMcpInspect(action, server, detail, button) {
    if (!server || !server.id || !detail) return;
    button.disabled = true;
    managedMcpStatus(action === "logs" ? "MCP 로그 읽는 중…" : "MCP 도구 목록 읽는 중…");
    try {
      var payload = await managedMcpRequest({ action: action, serverId: server.id, maxBytes: 8192 });
      var result = payload && payload.result ? payload.result : {};
      if (action === "tools") {
        var list = el("div", "managed-mcp-tools");
        var toolItems = Array.isArray(result.tools) ? result.tools : [];
        if (toolItems.length === 0) list.appendChild(el("div", "command-grant-empty", "광고된 도구가 없습니다."));
        toolItems.forEach(function (tool) {
          var readOnly = tool && tool.annotations && tool.annotations.readOnlyHint === true;
          list.appendChild(el("span", "managed-mcp-tool", String(tool && tool.name ? tool.name : "unknown") + (readOnly ? " · RO" : "")));
        });
        showManagedMcpDetail(detail, "제공 도구 " + toolItems.length + "개" + (result.truncated ? " · 일부만 표시" : ""), list);
      } else {
        var lines = [];
        var mcp = result.mcp || {};
        var service = result.service || {};
        lines.push("[MCP stderr]");
        lines.push(String(mcp.stderr || "(로그 없음)"));
        if (service.configured) {
          lines.push("", "[Service stdout]", String(service.stdout || "(로그 없음)"));
          lines.push("", "[Service stderr]", String(service.stderr || "(로그 없음)"));
        }
        if (mcp.lastExit) lines.push("", "[MCP last exit]", JSON.stringify(mcp.lastExit));
        if (service.lastExit) lines.push("", "[Service last exit]", JSON.stringify(service.lastExit));
        showManagedMcpDetail(detail, "최근 bounded / redacted 로그", el("div", "managed-mcp-log", lines.join("\n")));
      }
      managedMcpStatus(action === "logs" ? "MCP 로그 확인 완료" : "MCP 도구 목록 확인 완료", "success");
    } catch (error) {
      showManagedMcpDetail(detail, "확인 실패", el("div", "command-grant-empty", String(error.message || error)));
      managedMcpStatus("MCP 상세 정보를 불러오지 못했습니다.", "error");
    } finally {
      setMutableControlsAvailable(mutableControlsAvailable);
    }
  }
  async function installManagedMcpFromSettings() {
    if (!mutableControlsAvailable || restartPending) return;
    var repository = setting("managed-mcp-repository").value.trim();
    var ref = setting("managed-mcp-ref").value.trim();
    if (!repository) {
      managedMcpStatus("GitHub 저장소 주소를 입력하세요.", "error");
      return;
    }
    var warning = "이 저장소의 코드가 이 Mac/PC에서 실행될 수 있습니다. 출처와 코드를 신뢰하는 GitHub MCP 저장소가 맞습니까?\n\n" + repository;
    if (!window.confirm(warning)) return;
    var button = setting("managed-mcp-install");
    button.disabled = true;
    managedMcpStatus("MCP 저장소 설치 중…");
    try {
      await managedMcpRequest({
        action: "install",
        repositoryUrl: repository,
        ref: ref || null,
        runBuild: setting("managed-mcp-build").checked,
        trustRepository: true
      });
      setting("managed-mcp-repository").value = "";
      setting("managed-mcp-ref").value = "";
      await loadManagedMcps();
      managedMcpStatus("MCP 설치 완료", "success");
    } catch (error) {
      managedMcpStatus("MCP 설치 실패 · " + String(error.message || error), "error");
    } finally {
      setMutableControlsAvailable(mutableControlsAvailable);
    }
  }
  async function managedMcpUpdate(server, button) {
    if (!mutableControlsAvailable || restartPending || !server || !server.id) return;
    button.disabled = true;
    managedMcpStatus("MCP 업데이트 확인 중…");
    try {
      var check = await managedMcpRequest({ action: "check-update", serverId: server.id });
      var result = check && check.result ? check.result : {};
      if (!result.updateAvailable) {
        managedMcpStatus("이미 최신 버전입니다 · " + String(result.currentCommit || server.commit || "").slice(0, 12), "success");
        return;
      }
      var current = String(result.currentCommit || server.commit || "").slice(0, 12);
      var latest = String(result.latestCommit || "").slice(0, 12);
      var confirmed = window.confirm(
        "기존 MCP 정보와 실행 설정을 그대로 유지하고 새 revision으로 업데이트할까요?\n\n" +
        String(server.name || server.id) + "\n" + current + " → " + latest +
        (server.running ? "\n\n현재 실행 중이므로 업데이트 후 자동으로 다시 시작합니다." : "")
      );
      if (!confirmed) {
        managedMcpStatus("업데이트 취소됨");
        return;
      }
      managedMcpStatus("새 버전 설치·검증 중…");
      var updated = await managedMcpRequest({ action: "update", serverId: server.id, confirmUpdate: true });
      await loadManagedMcps();
      var updatedResult = updated && updated.result ? updated.result : {};
      var commit = updatedResult.record && updatedResult.record.commit ? String(updatedResult.record.commit).slice(0, 12) : latest;
      managedMcpStatus(updatedResult.updated === false ? "이미 최신 버전입니다" : "MCP 업데이트 완료 · " + commit, "success");
    } catch (error) {
      managedMcpStatus("MCP 업데이트 실패 · 기존 버전 유지 · " + String(error.message || error), "error");
    } finally {
      setMutableControlsAvailable(mutableControlsAvailable);
    }
  }
  async function managedMcpLifecycle(action, server, button) {
    if (!mutableControlsAvailable || restartPending || !server || !server.id) return;
    if (action === "remove") {
      var confirmed = window.confirm("설치된 MCP와 로컬 저장소 복사본을 삭제할까요?\n\n" + String(server.name || server.id));
      if (!confirmed) return;
    }
    button.disabled = true;
    managedMcpStatus(action === "start" ? "MCP 시작 중…" : action === "stop" ? "MCP 중지 중…" : action === "restart" ? "MCP 재시작 중…" : "MCP 삭제 중…");
    try {
      await managedMcpRequest({ action: action, serverId: server.id, confirmRemove: action === "remove" });
      await loadManagedMcps();
      managedMcpStatus(action === "start" ? "MCP 시작 완료" : action === "stop" ? "MCP 중지 완료" : action === "restart" ? "MCP 재시작 완료" : "MCP 삭제 완료", "success");
    } catch (error) {
      managedMcpStatus("MCP 작업 실패 · " + String(error.message || error), "error");
      setMutableControlsAvailable(mutableControlsAvailable);
    }
  }
  setting("managed-mcp-install").addEventListener("click", installManagedMcpFromSettings);
  function rollbackPreviousRuntime() {
    if (!mutableControlsAvailable || restartPending) return;
    if (!macBridge) {
      settingsStatus("이 복구 버튼은 현재 macOS 네이티브 앱에서만 사용할 수 있습니다.", "error");
      return;
    }
    settingsStatus("Mac 확인창에서 복구 대상을 확인하세요.");
    macBridge.postMessage({ action: "rollbackPreviousRuntime" });
  }
  setting("settings-rollback-runtime").addEventListener("click", rollbackPreviousRuntime);
  async function restartMcp() {
    if (restartPending || (!macBridge && !mutableControlsAvailable)) return;
    restartPending = true;
    restartRequestedAt = Date.now();
    restartSawDisconnect = false;
    setMutableControlsAvailable(mutableControlsAvailable);
    settingsStatus(mutableControlsAvailable ? "MCP 재시작 요청 중…" : "MCP 되살리기 요청 중…");
    try {
      if (macBridge) {
        macBridge.postMessage({ action: "restartMcp" });
      } else {
        var response = await fetch("/activity/api/native/restart-mcp", { method: "POST" });
        if (!response.ok) throw new Error("HTTP " + response.status);
      }
      settingsStatus("MCP 복구 중 · 재연결을 기다리는 중…");
    } catch (error) {
      restartPending = false;
      settingsStatus("MCP 복구 요청을 전달하지 못했습니다.", "error");
      setMutableControlsAvailable(Boolean(latestMcpHealth && latestMcpHealth.state !== "unhealthy"));
    }
  }
  setting("settings-restart-mcp").addEventListener("click", restartMcp);
  setMutableControlsAvailable(false);

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function motionEnabled() {
    return !(reducedMotion && reducedMotion.matches);
  }
  function cardKey(chat) {
    return String(chat.id || chat.sessionId || chat.conversationId || ((chat.title || "chat") + ":" + (chat.firstSeenAt || 0)));
  }
  function animateNode(node, keyframes, duration) {
    if (!motionEnabled() || !node || typeof node.animate !== "function") return;
    node.animate(keyframes, { duration: duration, easing: "cubic-bezier(.2,.72,.2,1)", fill: "both" });
  }
  function setMetricValue(id, value) {
    var node = document.getElementById(id);
    var next = String(value);
    if (!node || node.textContent === next) return;
    node.textContent = next;
    animateNode(node, [{ opacity: .72, transform: "translateY(.5px)" }, { opacity: 1, transform: "translateY(0)" }], 260);
  }
  function fmtClock(ms) {
    if (!ms) return "-";
    return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  function fmtStartClock(ms) {
    if (!ms) return "-";
    return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function fmtDuration(ms) {
    if (!Number.isFinite(ms)) return "-";
    if (ms < 1000) return Math.max(0, Math.round(ms)) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "초";
    var minutes = Math.floor(ms / 60000);
    var seconds = Math.floor((ms % 60000) / 1000);
    return minutes + "분 " + seconds + "초";
  }
  function age(ms, now) {
    var s = Math.max(0, Math.floor((now - ms) / 1000));
    if (s < 5) return "방금";
    if (s < 60) return s + "초 전";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "분 전";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "시간 전";
    return Math.floor(h / 24) + "일 전";
  }
  function isRunning(state) {
    return ["queued", "starting", "running", "cancelling"].indexOf(String(state || "").toLowerCase()) >= 0;
  }
  var RECENT_COMPLETION_ACTIVE_MS = 60000;
  var RECENT_FAILURE_EMPHASIS_MS = 5 * 60 * 1000;
  var FAILURE_BURST_WINDOW_MS = 2 * 60 * 1000;
  function isHistoricalFailure(entry, now) {
    if (!entry || entry.state !== "failed") return false;
    var terminalAt = Number.isFinite(entry.finishedAt) ? entry.finishedAt : entry.startedAt;
    return Number.isFinite(terminalAt) && Math.max(0, now - terminalAt) > RECENT_FAILURE_EMPHASIS_MS;
  }
  function statusOf(chat, now) {
    var state = String(chat.state || "idle").toLowerCase();
    var ageMs = Math.max(0, now - chat.lastActiveAt);
    var current = latestOperation(chat);
    var terminalAgeMs = current && Number.isFinite(current.finishedAt)
      ? Math.max(0, now - current.finishedAt)
      : ageMs;
    if (state === "waiting-approval") return { key: "approval", text: "승인 대기", color: "orange", priority: 1 };
    if (isRunning(state)) {
      if (current && current.clientCancellation && current.clientCancellation.operationContinues) {
        return { key: "detached", text: "로컬 작업 계속 중", color: "orange", priority: 1 };
      }
      if (ageMs < 15000) return { key: "active", text: "작업 중", color: "blue", priority: 0 };
      if (ageMs < 60000) return { key: "quiet", text: "응답 대기", color: "blue", priority: 2 };
      if (ageMs < 180000) return { key: "stale", text: "정체 가능", color: "orange", priority: 3 };
      return { key: "stale", text: "장시간 정체", color: "orange", priority: 4 };
    }
    if (state === "failed") {
      if (terminalAgeMs < RECENT_COMPLETION_ACTIVE_MS) return { key: "warning", text: "주의", color: "orange", priority: 3 };
      return { key: "failed", text: "실패", color: "red", priority: 5 };
    }
    if (state === "completed" || state === "success") {
      if (terminalAgeMs < RECENT_COMPLETION_ACTIVE_MS) return { key: "active", text: "작업 중", color: "blue", priority: 0 };
      return { key: "done", text: "완료", color: "green", priority: 6 };
    }
    return { key: "idle", text: "유휴", color: "gray", priority: 7 };
  }
  function projectSet(chat) {
    var set = new Set();
    (chat.operations || []).forEach(function (op) { if (op.projectId) set.add(op.projectId); });
    if (chat.boundProjectId) set.add(chat.boundProjectId);
    return Array.from(set);
  }
  function latestOperation(chat) {
    var ops = chat.operations || [];
    for (var i = ops.length - 1; i >= 0; i--) if (isRunning(ops[i].state) || ops[i].state === "waiting-approval") return ops[i];
    return ops.length ? ops[ops.length - 1] : null;
  }
  function targetProject(chat) {
    var current = latestOperation(chat);
    if (current && current.projectId) return current.projectId;
    if (chat.boundProjectId) return chat.boundProjectId;
    var projects = projectSet(chat);
    return projects.length ? projects[0] : "";
  }
  var DASHBOARD_TERMINAL_TTL_MS = 5 * 60 * 1000;
  function isDashboardVisible(chat, now) {
    if (Number.isFinite(chat.dashboardVisibleUntil)) return now <= chat.dashboardVisibleUntil;
    var state = String(chat.state || "idle").toLowerCase();
    if (state !== "completed" && state !== "success" && state !== "failed") return true;
    var latest = latestOperation(chat);
    if (!latest || !Number.isFinite(latest.finishedAt)) return true;
    return now <= latest.finishedAt + DASHBOARD_TERMINAL_TTL_MS;
  }
  function semanticLabel(kind, running) {
    var map = {
      planning: ["작업 계획", "계획 완료"], inspecting: ["관련 내용 확인 중", "내용 확인 완료"], editing: ["변경 반영 중", "변경 반영 완료"],
      verifying: ["검증 중", "검증 완료"], building: ["빌드 중", "빌드 완료"], installing: ["설치 중", "설치 완료"],
      applying: ["적용 중", "적용 완료"], connecting: ["연결 확인 중", "연결 확인 완료"], controlling: ["원격 제어 중", "원격 제어 완료"],
      "waiting-approval": ["승인 대기", "승인 대기"]
    };
    var v = map[kind] || ["작업 진행 중", "작업 완료"];
    return running ? v[0] : v[1];
  }
  function humanToolLabel(tool) {
    var map = {
      project_rules: "프로젝트 작업 규칙 확인", project_status: "프로젝트 상태 확인", repo_status: "Git 저장소 상태 확인",
      code_search: "관련 코드 검색", rg_search: "프로젝트 전체 검색", file_read_slice: "파일 내용 확인", file_read_batch: "관련 파일 여러 개 확인",
      file_apply_patch: "코드 변경 반영", file_edit_lines: "코드 줄 단위 수정", file_create: "새 파일 작성", command_run: "명령 실행",
      operation_status: "백그라운드 작업 진행 상태 확인", output_read: "이전 작업 결과 확인", runtime_update_check: "새 런타임 빌드 확인",
      runtime_update_prepare: "런타임 교체 준비", runtime_apply_local: "새 런타임 적용", runtime_apply_status: "런타임 적용 상태 확인",
      macos_app_apply_local: "Mac 앱 업데이트 적용", macos_app_apply_status: "Mac 앱 업데이트 상태 확인", connection_status: "C2CT 연결 상태 확인"
    };
    return map[tool] || "C2CT 작업 수행";
  }
  function activitySummary(chat, op, now) {
    if (!op) return chat.taskLabel || "현재 작업 내용 확인 중";
    if (op.clientCancellation && op.clientCancellation.operationContinues) {
      var detachedBase = op.currentActivity || op.activityHint || humanToolLabel(op.tool);
      return "ChatGPT 응답 연결 끊김 · 로컬 작업 계속 중 · " + detachedBase;
    }
    var base;
    if (op.currentActivity) {
      base = op.currentActivity;
    } else if (op.activityHint) {
      base = op.activityHint;
    } else {
      var action = humanToolLabel(op.tool);
      var detail = chat.taskLabel || op.message || "";
      base = detail ? action + " · " + detail : action;
    }
    if (op.state !== "failed") return base;
    var failureLabel = isHistoricalFailure(op, now) ? "이전 실패" : "실패";
    if (Number(op.repeatCount || 1) > 1) failureLabel += " " + op.repeatCount + "회";
    return failureLabel + " · " + base;
  }
  function failureBurstKey(entry) {
    if (!entry || entry.state !== "failed") return "";
    return [entry.projectId || "", entry.tool || "", entry.errorCode || "TOOL_RESULT_ERROR"].join("\u001f");
  }
  function repeatOccurrence(entry) {
    return {
      operationId: entry.operationId,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      elapsedMs: entry.elapsedMs,
      errorCode: entry.errorCode || "TOOL_RESULT_ERROR"
    };
  }
  function collapseFailureBursts(entries) {
    var collapsed = [];
    (entries || []).forEach(function (entry) {
      var copy = Object.assign({}, entry);
      var previous = collapsed.length ? collapsed[collapsed.length - 1] : null;
      var sameFailure = previous
        && failureBurstKey(previous)
        && failureBurstKey(previous) === failureBurstKey(copy);
      var previousAt = previous
        ? Number(previous.lastRepeatAt || previous.startedAt || 0)
        : 0;
      if (sameFailure && Number(copy.startedAt || 0) - previousAt <= FAILURE_BURST_WINDOW_MS) {
        if (!Array.isArray(previous.repeatOccurrences)) {
          previous.repeatOccurrences = [repeatOccurrence(previous)];
          previous.repeatCount = 1;
        }
        previous.repeatOccurrences.push(repeatOccurrence(copy));
        previous.repeatCount += 1;
        previous.lastRepeatAt = copy.startedAt;
        previous.finishedAt = copy.finishedAt;
        previous.elapsedMs = copy.elapsedMs;
        if (copy.message) previous.message = copy.message;
        if (copy.currentActivity) previous.currentActivity = copy.currentActivity;
        if (copy.activityHint) previous.activityHint = copy.activityHint;
        return;
      }
      copy.lastRepeatAt = copy.startedAt;
      collapsed.push(copy);
    });
    return collapsed;
  }
  function activityDetailKey(chat, entry) {
    return String(entry.operationId || (cardKey(chat) + ":" + entry.startedAt + ":" + entry.tool));
  }
  function makeActivityPreviewLine(chat, entry, now, openDetail) {
    var historicalFailure = isHistoricalFailure(entry, now);
    var text = activitySummary(chat, entry, now);
    var line = el("span", "activity-preview-line" + (entry.state === "failed" ? " failed" : "") + (historicalFailure ? " historical" : ""));
    line.setAttribute("role", "button");
    line.tabIndex = 0;
    line.setAttribute("aria-label", "상세 보기 · " + text);
    line.title = historicalFailure ? "이전 실패 기록 · 눌러서 상세 보기" : "눌러서 상세 보기";
    line.appendChild(el("span", "activity-time", fmtStartClock(entry.startedAt)));
    var content = el("span", "activity-text", text);
    content.title = text;
    line.appendChild(content);
    function activate(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      openDetail();
    }
    line.addEventListener("click", activate);
    line.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") activate(event);
    });
    return line;
  }
  function makeActivityEntry(chat, entry, now) {
    var historicalFailure = isHistoricalFailure(entry, now);
    var text = activitySummary(chat, entry, now);
    var detailKey = activityDetailKey(chat, entry);
    var wrapper = el("div", "activity-entry" + (entry.state === "failed" ? " failed" : "") + (historicalFailure ? " historical" : "") + (expandedOperationDetails.has(detailKey) ? " detail-open" : ""));
    var line = el("div", "activity-line");
    line.setAttribute("role", "button");
    line.tabIndex = 0;
    line.setAttribute("aria-expanded", expandedOperationDetails.has(detailKey) ? "true" : "false");
    line.appendChild(el("span", "activity-time", fmtStartClock(entry.startedAt)));
    var content = el("span", "activity-text", text);
    content.title = text;
    line.appendChild(content);
    var detail = el("div", "activity-detail");
    detail.appendChild(el("div", "activity-detail-text", text));
    if (entry.message && entry.message !== text) detail.appendChild(el("div", "activity-detail-message", entry.message));
    var meta = ["도구 " + entry.tool, "시작 " + fmtClock(entry.startedAt)];
    if (entry.displayLabel) meta.push("작업 묶음 " + entry.displayLabel);
    if (entry.toolFamily) meta.push("도구군 " + entry.toolFamily);
    if (entry.stepOrdinal) meta.push("묶음 내 순서 " + entry.stepOrdinal);
    if (Number.isFinite(entry.finishedAt)) meta.push("완료 " + fmtClock(entry.finishedAt));
    if (Number.isFinite(entry.elapsedMs)) meta.push("소요 " + fmtDuration(entry.elapsedMs));
    if (entry.state) meta.push("상태 " + entry.state);
    if (entry.phase) meta.push("단계 " + entry.phase);
    if (entry.errorCode) meta.push("오류 " + entry.errorCode);
    if (Number(entry.repeatCount || 1) > 1) meta.push("연속 반복 " + entry.repeatCount + "회");
    if (historicalFailure) meta.push("구분 이전 실패");
    detail.appendChild(el("div", "activity-detail-meta", meta.join(" · ")));
    if (Array.isArray(entry.repeatOccurrences) && entry.repeatOccurrences.length > 1) {
      var repeats = el("div", "activity-repeat-list");
      entry.repeatOccurrences.forEach(function (repeat, index) {
        var repeatText = (index + 1) + "회 · " + fmtClock(repeat.startedAt);
        if (repeat.errorCode) repeatText += " · " + repeat.errorCode;
        if (Number.isFinite(repeat.elapsedMs)) repeatText += " · " + fmtDuration(repeat.elapsedMs);
        repeats.appendChild(el("div", "", repeatText));
      });
      detail.appendChild(repeats);
    }
    function toggleDetail(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      var open = !wrapper.classList.contains("detail-open");
      wrapper.classList.toggle("detail-open", open);
      line.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) expandedOperationDetails.add(detailKey);
      else expandedOperationDetails.delete(detailKey);
    }
    line.addEventListener("click", toggleDetail);
    line.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") toggleDetail(event);
    });
    wrapper.appendChild(line);
    wrapper.appendChild(detail);
    return wrapper;
  }
  function riskLabel(risk) {
    if (risk === "network") return "네트워크 접근";
    if (risk === "local-file-mutation") return "로컬 파일 변경";
    if (risk === "destructive") return "고위험 변경";
    return risk || "보호 작업";
  }
  function openNativeApprovalInbox() {
    if (!macBridge) return;
    try {
      macBridge.postMessage({ action: "openApprovals" });
    } catch (_) {
      // The native bridge is optional. Browser/Tailscale views remain unchanged.
    }
  }
  async function decideApproval(item, decision, buttons, detail) {
    buttons.forEach(function (button) { button.disabled = true; });
    detail.textContent = decision === "approve" ? "승인 처리 중…" : "거절 처리 중…";
    try {
      var response = await fetch("/activity/api/approvals/" + encodeURIComponent(item.id) + "/" + decision, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      detail.textContent = decision === "approve" ? "승인됨" : "거절됨";
      await refresh();
    } catch (error) {
      detail.textContent = "처리 실패 · " + String(error && error.message ? error.message : error);
      buttons.forEach(function (button) { button.disabled = false; });
    }
  }
  function decideMacApproval(item, decision, buttons, detail) {
    if (!macBridge) return;
    buttons.forEach(function (button) { button.disabled = true; });
    detail.textContent = decision === "approve" ? "Mac에서 승인 처리 중…" : "Mac에서 거절 처리 중…";
    try {
      macBridge.postMessage({ action: "decideApproval", requestId: item.id, decision: decision });
      detail.textContent = decision === "approve" ? "Mac 승인 요청 전달됨…" : "Mac 거절 요청 전달됨…";
      window.setTimeout(function () { void refresh(); }, 350);
      window.setTimeout(function () { void refresh(); }, 1200);
    } catch (error) {
      detail.textContent = "처리 실패 · " + String(error && error.message ? error.message : error);
      buttons.forEach(function (button) { button.disabled = false; });
    }
  }
  function renderApprovals(items, now) {
    approvalLabel.textContent = items.length + "건";
    approvalsEmpty.hidden = items.length > 0;
    if (!items.length) {
      approvalBox.classList.add("hidden");
      window.setTimeout(function () {
        if (approvalBox.classList.contains("hidden")) approvals.replaceChildren();
      }, 230);
      return;
    }
    approvals.replaceChildren();
    approvalBox.classList.remove("hidden");
    items.slice().sort(function (a, b) { return a.createdAt - b.createdAt; }).forEach(function (item) {
      var row = el("article", "approval-item " + (item.channel === "mobile" ? "mobile" : "mac"));
      var top = el("div", "approval-top");
      top.appendChild(el("div", "approval-category", item.category || "승인 요청"));
      var macCanDecide = Boolean(macBridge && item.channel === "mac" && item.kind === "operation");
      var channelText = item.channel === "mobile"
        ? (item.canDecide ? "iPhone 승인 가능" : "Tailscale에서 승인")
        : (macCanDecide ? "이 앱에서 바로 승인 가능" : "로컬 앱에서 승인 필요");
      top.appendChild(el("div", "approval-channel " + (item.channel === "mobile" ? "mobile" : "mac"), channelText));
      row.appendChild(top);
      row.appendChild(el("div", "approval-summary", item.summary || "보호 작업 승인 요청"));
      var meta = el("div", "approval-meta");
      meta.appendChild(el("span", "", item.projectId || "project"));
      if (item.risk) meta.appendChild(el("span", "", riskLabel(item.risk)));
      meta.appendChild(el("span", "", "요청 " + age(item.createdAt, now)));
      meta.appendChild(el("span", "", "만료까지 " + Math.max(0, Math.ceil((item.expiresAt - now) / 1000)) + "초"));
      row.appendChild(meta);
      if (item.canDecide || macCanDecide) {
        var detail = el("div", "approval-meta", macCanDecide ? "이 앱에서 바로 처리 가능" : "이 화면에서 바로 처리 가능");
        row.appendChild(detail);
        var actions = el("div", "approval-actions");
        var approve = el("button", "approve", item.tool === "runtime_apply_local" ? "런타임 교체 허용" : "승인");
        var reject = el("button", "reject", "거절");
        approve.type = "button";
        reject.type = "button";
        approve.disabled = !mutableControlsAvailable || restartPending;
        reject.disabled = !mutableControlsAvailable || restartPending;
        var buttons = [approve, reject];
        approve.onclick = function () {
          if (macCanDecide) decideMacApproval(item, "approve", buttons, detail);
          else void decideApproval(item, "approve", buttons, detail);
        };
        reject.onclick = function () {
          if (macCanDecide) decideMacApproval(item, "reject", buttons, detail);
          else void decideApproval(item, "reject", buttons, detail);
        };
        actions.appendChild(approve);
        actions.appendChild(reject);
        row.appendChild(actions);
      }
      if (macBridge) {
        var nativeActions = el("div", "approval-actions");
        var nativeButton = el("button", "native", "로컬 승인 메뉴 열기");
        nativeButton.type = "button";
        nativeButton.disabled = !mutableControlsAvailable || restartPending;
        nativeButton.onclick = openNativeApprovalInbox;
        nativeActions.appendChild(nativeButton);
        row.appendChild(nativeActions);
      }
      approvals.appendChild(row);
    });
  }
  function deploymentStatus(item) {
    var state = String(item && item.state || "").toUpperCase();
    var phase = String(item && item.phase || "").toLowerCase();
    if (state === "APPROVAL_REQUIRED") return { text: "승인 대기", color: "orange" };
    if (state === "APPROVAL_EXPIRED") return { text: "승인 만료", color: "gray" };
    if (state === "ACTIVATION_REQUESTED") {
      if (phase === "health") return { text: "상태 확인", color: "blue" };
      if (phase === "catalog-refresh") return { text: "도구 갱신", color: "blue" };
      if (phase === "rollback") return { text: "롤백 중", color: "orange" };
      return { text: "배포 중", color: "blue" };
    }
    if (state === "APPLIED" || state === "ALREADY_APPLIED") return { text: "배포 완료", color: "green" };
    if (state.indexOf("FAILED") >= 0 || state === "HEALTH_CHECK_FAILED" || state === "REQUEST_CONFLICT" || state === "PRECONDITION_FAILED" || state === "TARGET_INVALID") {
      return { text: item.rollbackSucceeded ? "실패 · 롤백 완료" : "배포 실패", color: "red" };
    }
    return { text: state || "상태 확인", color: "gray" };
  }
  function shortIdentity(value) {
    var text = String(value || "");
    return text.length > 12 ? text.slice(0, 12) : text;
  }
  function renderDeployments(items, now) {
    deploymentLabel.textContent = items.length + "건";
    if (!items.length) {
      deploymentBox.classList.add("hidden");
      deployments.replaceChildren();
      return;
    }
    deploymentBox.classList.remove("hidden");
    deployments.replaceChildren();
    items.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).forEach(function (item) {
      var status = deploymentStatus(item);
      var row = el("article", "deployment-item " + status.color);
      var top = el("div", "deployment-top");
      top.appendChild(el("div", "deployment-title", item.kind === "runtime" ? "C2CT Runtime 배포" : "Mac 앱 배포"));
      top.appendChild(el("div", "deployment-state " + status.color, status.text));
      row.appendChild(top);
      if (item.currentIdentity || item.targetIdentity) row.appendChild(el("div", "deployment-route", shortIdentity(item.currentIdentity) + " → " + shortIdentity(item.targetIdentity)));
      var meta = el("div", "deployment-meta");
      meta.appendChild(el("span", "", item.projectId || "project"));
      if (item.phase) meta.appendChild(el("span", "", "단계 " + item.phase));
      meta.appendChild(el("span", "", "갱신 " + age(item.updatedAt || now, now)));
      if (Number.isFinite(item.reconnectDurationMs)) meta.appendChild(el("span", "", "재연결 " + fmtDuration(item.reconnectDurationMs)));
      if (item.finalHealthy === true) meta.appendChild(el("span", "", "health 정상"));
      if (item.rollbackAttempted) meta.appendChild(el("span", "", item.rollbackSucceeded ? "롤백 완료" : "롤백 시도"));
      row.appendChild(meta);
      if (item.message) row.appendChild(el("div", "deployment-message", item.message));
      deployments.appendChild(row);
    });
  }
  function renderWidgetLoads(items, performance) {
    widgetLoadLabel.textContent = items.length + "건";
    var hasPerformance = performance && (performance.presenterMountCount || performance.totalCardToolRoundTrips);
    if (!items.length && !hasPerformance) {
      widgetLoadBox.classList.add("hidden");
      widgetLoads.replaceChildren();
      widgetPerformance.replaceChildren();
      return;
    }
    widgetLoadBox.classList.remove("hidden");
    widgetPerformance.replaceChildren();
    if (performance) {
      widgetPerformance.appendChild(el("span", "", "presenter " + (performance.presenterMountCount || 0)));
      widgetPerformance.appendChild(el("span", "", "card RT " + (performance.totalCardToolRoundTrips || 0)));
      widgetPerformance.appendChild(el("span", "", "status poll " + (performance.statusPollCount || 0)));
      widgetPerformance.appendChild(el("span", "", "asset fetch " + (performance.assetFetchCount || 0)));
      widgetPerformance.appendChild(el("span", "", "bundled hit≈ " + (performance.bundledCacheHitEstimate || 0)));
      widgetPerformance.appendChild(el("span", "", "legacy lookup " + (performance.legacyResultLookupCount || 0)));
      widgetPerformance.appendChild(el("span", "", "resume " + (performance.continuationResumeCount || 0)));
      var presenterLatency = performance.presenterServerLatencyMs || {};
      if (Number.isFinite(presenterLatency.p50)) widgetPerformance.appendChild(el("span", "", "presenter p50 " + fmtDuration(presenterLatency.p50)));
      if (Number.isFinite(presenterLatency.p95)) widgetPerformance.appendChild(el("span", "", "p95 " + fmtDuration(presenterLatency.p95)));
      var assetReady = performance.presenterToAssetReadyMs || {};
      if (Number.isFinite(assetReady.p50)) widgetPerformance.appendChild(el("span", "", "asset-ready p50 " + fmtDuration(assetReady.p50)));
      if (Number.isFinite(assetReady.p95)) widgetPerformance.appendChild(el("span", "", "p95 " + fmtDuration(assetReady.p95)));
    }
    widgetLoads.replaceChildren();
    items.forEach(function (item) {
      var row = el("div", "widget-load-item");
      row.appendChild(el("span", "widget-load-meta", fmtStartClock(item.startedAt)));
      var title = el("span", "widget-load-chat", item.title || item.conversationId || "채팅");
      title.title = (item.title || "채팅") + " · " + (item.conversationId || "");
      row.appendChild(title);
      row.appendChild(el("span", "widget-load-meta", fmtDuration(item.elapsedMs || 0)));
      widgetLoads.appendChild(row);
    });
  }
  function renderMcpHealth(health, now) {
    if (!health) {
      mcpHealthBox.className = "mcp-health-box degraded";
      mcpHealthState.className = "mcp-health-state degraded";
      mcpHealthState.textContent = "Unknown";
      mcpHealthReason.textContent = "MCP 내부 진단 데이터가 아직 없습니다.";
      mcpHealthMeta.replaceChildren();
      mcpHealthEvents.replaceChildren();
      return;
    }
    var state = ["healthy", "degraded", "unhealthy"].indexOf(health.state) >= 0 ? health.state : "degraded";
    mcpHealthBox.className = "mcp-health-box " + state;
    mcpHealthState.className = "mcp-health-state " + state;
    mcpHealthState.textContent = health.label || (state === "healthy" ? "Healthy" : state === "unhealthy" ? "Unhealthy" : "Degraded");
    mcpHealthReason.textContent = health.reason || "상태 확인 중";
    mcpHealthMeta.replaceChildren();
    mcpHealthMeta.appendChild(el("span", "", "최근 장애 " + (health.recentFailureCount || 0)));
    mcpHealthMeta.appendChild(el("span", "", "복구 가능 " + (health.recentRecoverableFailureCount || 0)));
    mcpHealthMeta.appendChild(el("span", "", "transport " + (health.recentTransportFailureCount || 0)));
    mcpHealthMeta.appendChild(el("span", "", "watchdog " + (health.watchdogStatus || "unknown")));
    if (Number.isFinite(health.watchdogProbeAgeMs)) mcpHealthMeta.appendChild(el("span", "", "probe " + age(now - health.watchdogProbeAgeMs, now)));
    var incident = health.watchdogIncident && typeof health.watchdogIncident === "object" ? health.watchdogIncident : null;
    if (incident) {
      mcpHealthMeta.appendChild(el("span", "", incident.active ? "route 장애 진행 중" : "route 복구됨"));
      mcpHealthMeta.appendChild(el("span", "", "layer " + String(incident.latestFailureLayer || "unknown")));
      if (Number.isFinite(incident.durationMs)) mcpHealthMeta.appendChild(el("span", "", "장애 " + fmtDuration(incident.durationMs)));
      if (incident.recoveredAt) mcpHealthMeta.appendChild(el("span", "", "복구 " + fmtStartClock(Date.parse(incident.recoveredAt))));
    }
    mcpHealthEvents.replaceChildren();
    var events = Array.isArray(health.events) ? health.events.slice().reverse() : [];
    if (!events.length) {
      mcpHealthEvents.appendChild(el("div", "mcp-health-reason", "최근 내부 오류 없음"));
      return;
    }
    events.forEach(function (item) {
      var recoverable = item.classification === "recoverable";
      var row = el("div", "mcp-health-event" + (recoverable ? " recoverable" : item.outcome === "failure" ? " failure" : ""));
      row.appendChild(el("span", "mcp-health-event-time", fmtStartClock(Date.parse(item.at))));
      var parts = [item.event || "diagnostic"];
      if (item.tool) parts.push(item.tool);
      if (item.errorCode) parts.push(item.errorCode);
      if (recoverable) parts.push("recoverable");
      if (item.phase) parts.push("phase=" + item.phase);
      if (item.diagnosticId) parts.push(item.diagnosticId);
      row.appendChild(el("span", "mcp-health-event-text", parts.join(" · ")));
      mcpHealthEvents.appendChild(row);
    });
  }
  function renderFilters(chats) {
    var projects = new Set();
    chats.forEach(function (chat) { projectSet(chat).forEach(function (p) { projects.add(p); }); });
    var values = ["all"].concat(Array.from(projects).sort());
    var signature = values.join("\u001f") + "|" + selectedProject;
    if (signature === lastFilterSignature) return;
    lastFilterSignature = signature;
    filters.replaceChildren();
    filters.classList.toggle("hidden", values.length <= 1);
    values.forEach(function (value) {
      var b = el("button", "filter" + (selectedProject === value ? " active" : ""), value === "all" ? "전체" : value);
      b.type = "button";
      b.onclick = function () { selectedProject = value; render(); };
      filters.appendChild(b);
    });
  }
  function makeCard(chat, now) {
    var st = statusOf(chat, now);
    var card = el("article", "card status-" + st.color);
    card.dataset.chatKey = cardKey(chat);
    card.dataset.statusKey = st.key;
    card.dataset.statusColor = st.color;
    var primary = el("div", "card-primary");
    var project = targetProject(chat);
    var projectBadge = el("span", "project-badge" + (project ? "" : " none"), project || "프로젝트 미확인");
    projectBadge.title = project || "프로젝트 미확인";
    primary.appendChild(projectBadge);
    var title = el("div", "title" + (chat.titleSource === "missing" ? " provisional" : ""), chat.title || "채팅 이름 필요");
    title.title = chat.title || "채팅 이름 필요";
    primary.appendChild(title);
    var started = el("div", "start-time", fmtStartClock(chat.firstSeenAt));
    started.title = "작업 시작 " + fmtClock(chat.firstSeenAt);
    primary.appendChild(started);
    primary.appendChild(el("div", "status " + st.color, st.text));
    card.appendChild(primary);

    var groups = chat.workGroups || [];
    var currentGroup = null;
    for (var gi = groups.length - 1; gi >= 0; gi--) {
      if (isRunning(groups[gi].state) || groups[gi].state === "waiting-approval") { currentGroup = groups[gi]; break; }
    }
    if (!currentGroup && groups.length) currentGroup = groups[groups.length - 1];
    if (currentGroup) {
      var groupLine = el("div", "work-group-current");
      groupLine.appendChild(el("span", "work-group-label", currentGroup.displayLabel || "C2CT 작업"));
      var groupActivity = el("span", "work-group-activity", currentGroup.currentActivity || "작업 진행 중");
      groupActivity.title = (currentGroup.displayLabel || "C2CT 작업") + " · " + (currentGroup.currentActivity || "작업 진행 중");
      groupLine.appendChild(groupActivity);
      card.appendChild(groupLine);
    }

    var ops = collapseFailureBursts(chat.operations || []).slice().reverse();
    if (ops.length) {
      var previewOps = ops.slice(0, 3);
      card.dataset.summary = previewOps.map(function (entry) { return activitySummary(chat, entry, now); }).join("\u001f");
      var details = document.createElement("details");
      details.className = "activity-disclosure";
      var disclosureKey = String(chat.id || "");
      details.open = disclosureKey ? expandedToolRequestChats.has(disclosureKey) : false;
      card.dataset.expanded = details.open ? "true" : "false";
      details.addEventListener("toggle", function () {
        if (!disclosureKey) return;
        if (details.open) expandedToolRequestChats.add(disclosureKey);
        else expandedToolRequestChats.delete(disclosureKey);
      });
      var summary = document.createElement("summary");
      var preview = el("span", "activity-preview");
      previewOps.forEach(function (entry) {
        preview.appendChild(makeActivityPreviewLine(chat, entry, now, function () {
          if (disclosureKey) expandedToolRequestChats.add(disclosureKey);
          expandedOperationDetails.add(activityDetailKey(chat, entry));
          render();
        }));
      });
      summary.appendChild(preview);
      summary.appendChild(el("span", "activity-collapse-label", "접기"));
      summary.appendChild(el("span", "disclosure-indicator", "⌄"));
      details.appendChild(summary);
      var timeline = el("div", "activity-timeline");
      ops.forEach(function (entry) { timeline.appendChild(makeActivityEntry(chat, entry, now)); });
      details.appendChild(timeline);
      card.appendChild(details);
    }
    return card;
  }
  function renderCards(visible, now) {
    var previous = new Map();
    Array.from(cards.children).forEach(function (card) {
      var key = card.dataset && card.dataset.chatKey;
      if (!key) return;
      var cardStyle = window.getComputedStyle(card);
      previous.set(key, {
        rect: card.getBoundingClientRect(),
        summary: card.dataset.summary || "",
        statusKey: card.dataset.statusKey || "",
        statusColor: card.dataset.statusColor || "",
        borderColor: cardStyle.borderTopColor,
        boxShadow: cardStyle.boxShadow,
        expanded: card.dataset.expanded === "true"
      });
    });
    if (!visible.length) {
      cards.replaceChildren(el("div", "empty", "표시할 채팅 작업이 없습니다."));
      return;
    }
    var nextCards = visible.map(function (chat) { return makeCard(chat, now); });
    var fragment = document.createDocumentFragment();
    nextCards.forEach(function (card) { fragment.appendChild(card); });
    cards.replaceChildren(fragment);
    if (!motionEnabled() || !previous.size) return;
    nextCards.forEach(function (card) {
      var before = previous.get(card.dataset.chatKey || "");
      if (!before) {
        animateNode(card, [{ opacity: .68, transform: "translateY(2px)" }, { opacity: 1, transform: "translateY(0)" }], 340);
        return;
      }
      var after = card.getBoundingClientRect();
      var dx = before.rect.left - after.left;
      var dy = before.rect.top - after.top;
      var sx = after.width ? before.rect.width / after.width : 1;
      var sy = after.height ? before.rect.height / after.height : 1;
      var expanded = card.dataset.expanded === "true";
      if (!before.expanded && !expanded && (Math.abs(dx) > .5 || Math.abs(dy) > .5 || Math.abs(sx - 1) > .01 || Math.abs(sy - 1) > .01)) {
        animateNode(card, [
          { transformOrigin: "top left", transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")" },
          { transformOrigin: "top left", transform: "none" }
        ], 430);
      }
      if (before.summary !== (card.dataset.summary || "")) {
        animateNode(card.querySelector(".activity-preview"), [{ opacity: .7 }, { opacity: 1 }], 240);
      }
      if (before.statusKey !== (card.dataset.statusKey || "")) {
        animateNode(card.querySelector(".status"), [{ opacity: .74, transform: "translateY(.5px)" }, { opacity: 1, transform: "translateY(0)" }], 280);
      }
      if (before.statusColor !== (card.dataset.statusColor || "")) {
        var targetStyle = window.getComputedStyle(card);
        animateNode(card, [
          { borderColor: before.borderColor, boxShadow: before.boxShadow },
          { borderColor: targetStyle.borderTopColor, boxShadow: targetStyle.boxShadow }
        ], 180);
      }
    });
  }
  function updateMetrics(chats, approvalItems, now) {
    var counts = { active: 0, attention: 0 };
    chats.forEach(function (chat) {
      var key = statusOf(chat, now).key;
      if (key === "active" || key === "quiet" || key === "detached") counts.active += 1;
      if (key === "stale" || key === "warning" || key === "failed") counts.attention += 1;
    });
    setMetricValue("m-active", counts.active);
    setMetricValue("m-attention", counts.attention);
    setMetricValue("m-approval", approvalItems.length);
    document.getElementById("metric-attention").classList.toggle("has-value", counts.attention > 0);
    document.getElementById("metric-approval").classList.toggle("has-value", approvalItems.length > 0);
  }
  function render() {
    var now = Date.now();
    var retained = latest.filter(function (chat) { return isDashboardVisible(chat, now); });
    updateMetrics(retained, latestApprovals, now);
    renderApprovals(latestApprovals, now);
    renderDeployments(latestDeployments, now);
    renderMcpHealth(latestMcpHealth, now);
    renderWidgetLoads(latestWidgetLoads, latestWidgetPerformance);
    diagnosticsEmpty.hidden = latestDeployments.length > 0 || latestWidgetLoads.length > 0 || Boolean(latestWidgetPerformance && latestWidgetPerformance.totalCardToolRoundTrips);
    renderFilters(retained);
    var visible = retained.filter(function (chat) {
      return selectedProject === "all" || projectSet(chat).indexOf(selectedProject) >= 0;
    }).slice().sort(function (a, b) {
      return (a.firstSeenAt || 0) - (b.firstSeenAt || 0) || cardKey(a).localeCompare(cardKey(b));
    });
    renderCards(visible, now);
  }
  async function refresh() {
    try {
      var response = await fetch("/activity/api/activity", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      if (typeof payload.dashboardRevision === "string" && payload.dashboardRevision !== pageDashboardRevision) {
        window.location.reload();
        return;
      }
      latest = Array.isArray(payload.conversations) ? payload.conversations : [];
      latestApprovals = Array.isArray(payload.approvals) ? payload.approvals : [];
      latestDeployments = Array.isArray(payload.deployments) ? payload.deployments : [];
      latestMcpHealth = payload.mcpHealth && typeof payload.mcpHealth === "object" ? payload.mcpHealth : null;
      latestWidgetLoads = Array.isArray(payload.widgetLoads) ? payload.widgetLoads : [];
      latestWidgetPerformance = payload.widgetPerformance && typeof payload.widgetPerformance === "object" ? payload.widgetPerformance : null;
      liveDot.classList.toggle("offline", Boolean(latestMcpHealth && latestMcpHealth.state === "unhealthy"));
      liveText.textContent = latestMcpHealth
        ? "MCP " + (latestMcpHealth.label || latestMcpHealth.state) + " · " + age(payload.generatedAt || Date.now(), Date.now())
        : "갱신 " + age(payload.generatedAt || Date.now(), Date.now());
      var connected = Boolean(latestMcpHealth && latestMcpHealth.state !== "unhealthy");
      if (restartPending) {
        var restartElapsed = Date.now() - restartRequestedAt;
        if (!connected) restartSawDisconnect = true;
        if (connected && (restartSawDisconnect || restartElapsed >= 3000)) {
          restartPending = false;
          restartSawDisconnect = false;
          if (settingsLoaded) settingsStatus("MCP 재연결 완료", "success");
        } else if (restartElapsed >= 30000) {
          restartPending = false;
          restartSawDisconnect = false;
          if (settingsLoaded) settingsStatus("MCP 복구에 실패했습니다. 다시 시도할 수 있습니다.", "error");
        }
      }
      setMutableControlsAvailable(connected);
      render();
    } catch (error) {
      liveDot.classList.add("offline");
      liveText.textContent = "연결 끊김";
      if (restartPending) {
        restartSawDisconnect = true;
        if (Date.now() - restartRequestedAt >= 30000) {
          restartPending = false;
          restartSawDisconnect = false;
          if (settingsLoaded) settingsStatus("MCP 복구에 실패했습니다. 다시 시도할 수 있습니다.", "error");
        }
      }
      setMutableControlsAvailable(false);
    }
  }
  refresh();
  setInterval(refresh, 1000);
})();
</script>
</body>
</html>`;

export const ACTIVITY_DASHBOARD_REVISION = createHash("sha256")
  .update(ACTIVITY_DASHBOARD_TEMPLATE)
  .digest("hex")
  .slice(0, 16);

export const ACTIVITY_DASHBOARD_HTML = ACTIVITY_DASHBOARD_TEMPLATE.replace(
  ACTIVITY_DASHBOARD_REVISION_TOKEN,
  ACTIVITY_DASHBOARD_REVISION,
);

export interface ActivityDashboardDocument {
  html: string;
  revision: string;
  source: "bundled" | "override";
}

interface CachedActivityDashboardDocument {
  mtimeMs: number;
  size: number;
  document: ActivityDashboardDocument;
}

const activityDashboardDocumentCache = new Map<string, CachedActivityDashboardDocument>();
const bundledActivityDashboardDocument: ActivityDashboardDocument = {
  html: ACTIVITY_DASHBOARD_HTML,
  revision: ACTIVITY_DASHBOARD_REVISION,
  source: "bundled",
};

function activityDashboardRevisionFromHtml(html: string): string | undefined {
  if (!html.includes(ACTIVITY_DASHBOARD_CONTRACT_MARKER)) return undefined;
  return /var pageDashboardRevision = "([a-f0-9]{16})";/u.exec(html)?.[1];
}

export async function activityDashboardDocument(stateDir: string): Promise<ActivityDashboardDocument> {
  const resolvedStateDir = path.resolve(stateDir);
  const overridePath = path.join(resolvedStateDir, ACTIVITY_DASHBOARD_OVERRIDE_FILE);
  try {
    const stat = await fs.stat(overridePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > ACTIVITY_DASHBOARD_MAX_OVERRIDE_BYTES) {
      activityDashboardDocumentCache.delete(resolvedStateDir);
      return bundledActivityDashboardDocument;
    }
    const cached = activityDashboardDocumentCache.get(resolvedStateDir);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.document;

    const html = await fs.readFile(overridePath, "utf8");
    const revision = activityDashboardRevisionFromHtml(html);
    const document = revision
      ? { html, revision, source: "override" as const }
      : bundledActivityDashboardDocument;
    activityDashboardDocumentCache.set(resolvedStateDir, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      document,
    });
    return document;
  } catch {
    activityDashboardDocumentCache.delete(resolvedStateDir);
    return bundledActivityDashboardDocument;
  }
}
