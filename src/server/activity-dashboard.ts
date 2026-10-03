import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redact } from "../policy/secrets.js";
import type { RuntimeActivityTracker, RuntimeConversationSummary } from "../runtime/activity.js";
import type { ActivityMcpHealth } from "./activity-mcp-health.js";
import { CHATGPT_CONSENT_META_KEY, CHATGPT_CONSENT_WIDGET_HTML } from "./chatgpt-consent-widget.js";

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
const GALLERY_C2CT_APP_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
  '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#087E78"/><stop offset=".55" stop-color="#119B93"/><stop offset="1" stop-color="#20B6AD"/></linearGradient><linearGradient id="shield" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF9C14"/><stop offset="1" stop-color="#FF7A00"/></linearGradient></defs>',
  '<rect x="28" y="28" width="968" height="968" rx="210" fill="url(#bg)"/>',
  '<g fill="none" stroke="#fff" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"><path d="M514 171 C321 171 176 308 176 491 C176 594 225 684 306 744 L286 842 L405 777 C440 786 476 791 514 791 C705 791 852 655 852 476 C852 299 706 171 514 171 Z"/><path d="M426 388 L334 480 L426 572"/><path d="M602 388 L694 480 L602 572"/><path d="M552 349 L476 611"/></g>',
  '<g><path d="M720 596 C789 620 850 618 905 596 L919 610 V738 C919 833 858 895 812 919 C766 895 705 833 705 738 V610 Z" fill="url(#shield)" stroke="#FFD13A" stroke-width="26" stroke-linejoin="round"/><path d="M755 758 L799 802 L873 718" fill="none" stroke="#fff" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/></g>',
  '</svg>',
].join("");
const GALLERY_C2CT_APP_ICON_DATA_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(GALLERY_C2CT_APP_ICON_SVG)}`;

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
    .gallery-live-card { padding: 12px; overflow: hidden; }
    .gallery-live-label { margin: 0 2px 10px; color: var(--muted); font-size: 11px; font-weight: 760; }
    .gallery-host-controls { display: flex; justify-content: flex-end; margin: -2px 0 10px; }
    .gallery-host-debug-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 10.5px; font-weight: 650; user-select: none; }
    .gallery-host-debug-toggle input { width: 14px; height: 14px; margin: 0; accent-color: var(--blue); }
    .gallery-chatgpt-host {
      box-sizing: border-box;
      width: 100%;
      margin: 0 auto;
      padding: clamp(12px, 2.1vw, 20px);
      border-radius: 0;
      background: transparent;
      color: #555;
    }
    .gallery-live-card[data-preview-platform="ios"] {
      width: 100%;
      max-width: 440px;
      justify-self: center;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      overflow: visible;
    }
    .gallery-live-card[data-preview-platform="ios"] > .gallery-live-label,
    .gallery-live-card[data-preview-platform="ios"] > .gallery-flow { display: none; }
    .gallery-comparison-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; align-items: start; }
    .gallery-comparison-card { position: relative; padding-top: 36px !important; }
    .gallery-comparison-card > .gallery-live-label { display: none; }
    .gallery-comparison-card::before {
      content: attr(data-ab-label);
      position: absolute;
      top: 7px;
      left: 10px;
      min-height: 22px;
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      background: var(--panel2);
      color: var(--text);
      font-size: 11px;
      font-weight: 760;
      line-height: 1.2;
    }
    .gallery-comparison-card[data-preview-variant="improved"]::before {
      color: var(--blue);
      border-color: color-mix(in srgb, var(--blue) 42%, var(--line));
    }
    .gallery-auto-ios-spacer { min-height: 1px; }
    .gallery-comparison-note { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.45; }
    .gallery-ios-reference-image {
      display: block;
      width: 100%;
      height: auto;
      margin: 0 0 12px;
      padding: 0;
      border: 0;
      border-radius: 0;
    }
    .gallery-chatgpt-host[data-platform="ios"] {
      max-width: 440px;
      padding: 0 16px;
      border-radius: 0;
      background: #fff;
      color: #555;
    }
    .gallery-chatgpt-host[data-platform="desktop"] { max-width: 820px; }
    .gallery-chatgpt-app-row {
      display: flex;
      align-items: center;
      gap: clamp(9px, 1.4vw, 12px);
      margin: 0 0 clamp(14px, 2.3vw, 22px);
      padding-left: 1px;
    }
    .gallery-chatgpt-app-icon {
      display: block;
      width: clamp(28px, 4.4vw, 40px);
      height: clamp(28px, 4.4vw, 40px);
      border-radius: clamp(8px, 1.2vw, 11px);
      object-fit: cover;
      flex: 0 0 auto;
    }
    .gallery-chatgpt-app-name {
      font-size: clamp(17px, 2.6vw, 24px);
      font-weight: 700;
      letter-spacing: -.015em;
      line-height: 1.2;
    }
    .gallery-chatgpt-host[data-platform="ios"] .gallery-chatgpt-app-row {
      gap: 8px;
      margin: 0 0 12px;
      padding: 0;
    }
    .gallery-chatgpt-host[data-platform="ios"] .gallery-chatgpt-app-icon {
      width: 20px;
      height: 20px;
      border-radius: 6px;
    }
    .gallery-chatgpt-host[data-platform="ios"] .gallery-chatgpt-app-name {
      color: #555;
      font-size: 16px;
      font-weight: 650;
    }
    .gallery-chatgpt-widget-viewport {
      box-sizing: border-box;
      width: 100%;
      padding: clamp(10px, 1.7vw, 16px);
      border: 1px solid rgba(255,255,255,.18);
      border-radius: clamp(18px, 2.7vw, 25px);
      background: rgba(255,255,255,.025);
      overflow: hidden;
    }
    .gallery-chatgpt-host[data-platform="ios"] .gallery-chatgpt-widget-viewport {
      width: auto;
      margin: 0 4px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .gallery-live-widget-frame { display: block; width: 100%; min-height: 88px; border: 0; background: transparent; overflow: hidden; }
    #gallery-view.gallery-show-bounds .gallery-chatgpt-host { outline: none; }
    #gallery-view.gallery-show-bounds .gallery-chatgpt-widget-viewport { outline: 1px dashed rgba(255,185,92,.82); outline-offset: -4px; }
    #gallery-view.gallery-show-bounds .gallery-live-widget-frame { outline: 1px dashed rgba(107,224,157,.84); outline-offset: -2px; }
    @media (max-width: 720px) {
      .gallery-ios-reference-image {
        width: 100vw;
        max-width: none;
        margin-left: calc(50% - 50vw);
        margin-right: calc(50% - 50vw);
      }
      .gallery-chatgpt-host { padding: 12px; border-radius: 16px; }
      .gallery-chatgpt-app-row { margin-bottom: 14px; }
      .gallery-chatgpt-widget-viewport { padding: 10px; border-radius: 18px; }
      .gallery-chatgpt-host[data-platform="ios"] { padding: 0 16px; border-radius: 0; }
      .gallery-chatgpt-host[data-platform="ios"] .gallery-chatgpt-app-row { margin-bottom: 12px; }
      .gallery-chatgpt-host[data-platform="ios"] .gallery-chatgpt-widget-viewport { padding: 0; border-radius: 0; }
      .gallery-auto-ios-spacer { display: none; }
    }
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
    .activity-preview-line.permission-required, .activity-entry.permission-required .activity-line { color: var(--orange); }
    .activity-preview-line.permission-required .activity-time, .activity-entry.permission-required .activity-time { color: color-mix(in srgb, var(--orange) 74%, var(--muted)); }
    .activity-preview-line.stopped, .activity-entry.stopped .activity-line { color: var(--muted); }
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
      /*
       * iPhone reference measurement:
       *   screenshot width = 1320px
       *   real ChatGPT card = x 60..1259 = 1200px = 90.9090909vw
       * The shared widget document adds 4px body padding on each side, so the
       * preview viewport is reference-card width + 8px. The visible .card
       * therefore lands at the same measured 400pt width on a 440pt viewport.
       */
      .gallery-card.gallery-live-card { overflow: visible; }
      .gallery-card.gallery-live-card .gallery-chatgpt-widget-viewport {
        width: calc(90.9090909vw + 8px);
        max-width: none;
        margin-left: 50%;
        margin-right: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        overflow: visible;
        transform: translateX(-50%);
      }
      .gallery-card.gallery-live-card[data-preview-variant="improved"] .gallery-chatgpt-widget-viewport {
        width: 90.9090909vw;
      }
      .gallery-comparison-grid { grid-template-columns: 1fr; }
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
    <div class="gallery-note"><b>미리보기 전용</b> · ChatGPT 카드는 실제 <code>CHATGPT_CONSENT_WIDGET_HTML</code> 렌더러를 그대로 사용하고, 그 바깥에 ChatGPT가 제공하는 앱 행·외곽선·호스트 여백만 미리보기용으로 재현합니다. Activity 카드는 실제 <code>makeCard()</code>로 샘플 데이터만 렌더합니다. 미리보기에서는 클릭·승인·자동진행·상태조회가 비활성화됩니다.</div>
    <div class="gallery-host-controls"><label class="gallery-host-debug-toggle"><input id="gallery-debug-bounds" type="checkbox">영역선 보기</label></div>
    <section class="gallery-section">
      <div class="section-head"><h2>인라인 승인 카드 A/B</h2><span>원본 코드 vs 미리보기 전용 개선안</span></div>
      <div class="gallery-comparison-grid">
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="approval-standard" data-preview-name="일반 작업 승인 · 기존" data-preview-variant="baseline" data-ab-label="일반 작업 승인 · 기존" data-gallery-flow="보호 작업 요청|pending 승인|사용자 결정|exact 작업 1회"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="approval-standard" data-preview-name="일반 작업 승인 · 개선안" data-preview-variant="improved" data-ab-label="일반 작업 승인 · 개선안" data-gallery-flow="보호 작업 요청|pending 승인|사용자 결정|exact 작업 1회"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="approval-project" data-preview-name="프로젝트 명령 승인 · 기존" data-preview-variant="baseline" data-ab-label="프로젝트 명령 승인 · 기존" data-gallery-flow="명령 승인 요청|이번만 또는 프로젝트 허용|exact 명령 실행"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="approval-project" data-preview-name="프로젝트 명령 승인 · 개선안" data-preview-variant="improved" data-ab-label="프로젝트 명령 승인 · 개선안" data-gallery-flow="명령 승인 요청|이번만 또는 프로젝트 허용|exact 명령 실행"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="preapply" data-preview-name="Runtime 교체 사전준비 · 기존" data-preview-variant="baseline" data-ab-label="Runtime 사전준비 · 기존" data-gallery-flow="새 카드 자산 적용|실제 위젯 로드 확인|Critical 승인 준비"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="preapply" data-preview-name="Runtime 교체 사전준비 · 개선안" data-preview-variant="improved" data-ab-label="Runtime 사전준비 · 개선안" data-gallery-flow="새 카드 자산 적용|실제 위젯 로드 확인|Critical 승인 준비"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="critical-runtime" data-preview-name="Runtime 교체 승인 · 기존" data-preview-variant="baseline" data-ab-label="Runtime 교체 승인 · 기존" data-gallery-flow="고위험 preflight|Critical 승인|봉인된 runtime 교체"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="critical-runtime" data-preview-name="Runtime 교체 승인 · 개선안" data-preview-variant="improved" data-ab-label="Runtime 교체 승인 · 개선안" data-gallery-flow="고위험 preflight|Critical 승인|봉인된 runtime 교체"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="critical-app" data-preview-name="Mac 앱 교체 승인 · 기존" data-preview-variant="baseline" data-ab-label="Mac 앱 교체 승인 · 기존" data-gallery-flow="앱 검증|Critical 승인|검증된 앱 교체"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="critical-app" data-preview-name="Mac 앱 교체 승인 · 개선안" data-preview-variant="improved" data-ab-label="Mac 앱 교체 승인 · 개선안" data-gallery-flow="앱 검증|Critical 승인|검증된 앱 교체"></article>
      </div>
    </section>
    <section class="gallery-section">
      <div class="section-head"><h2>선택 · 진행 카드 A/B</h2><span>자동 진행은 현재안 고정</span></div>
      <div class="gallery-comparison-grid">
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="choice" data-preview-name="일반 선택 카드 · 기존" data-preview-variant="baseline" data-ab-label="일반 선택 · 기존" data-gallery-flow="선택 payload|Widget Shell 표시|사용자 선택"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="choice" data-preview-name="일반 선택 카드 · 개선안" data-preview-variant="improved" data-ab-label="일반 선택 · 개선안" data-gallery-flow="선택 payload|Widget Shell 표시|사용자 선택"></article>
        <article id="gallery-preview-auto-ios" class="gallery-card gallery-live-card" data-live-widget-preview="auto-ios" data-preview-name="자동 진행 · iPhone" data-gallery-flow="compact 카드|15초 countdown|취소 또는 자동 진행"></article>
        <div class="gallery-auto-ios-spacer" aria-hidden="true"></div>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="manual-refresh" data-preview-name="C2CT 새로고침 · 기존" data-preview-variant="baseline" data-ab-label="C2CT 새로고침 · 기존" data-gallery-flow="Settings 수동 새로고침|완료 입력|scan-tools 1회"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="manual-refresh" data-preview-name="C2CT 새로고침 · 개선안" data-preview-variant="improved" data-ab-label="C2CT 새로고침 · 개선안" data-gallery-flow="Settings 수동 새로고침|완료 입력|scan-tools 1회"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="reentry" data-preview-name="C2CT 다시 연결 · 기존" data-preview-variant="baseline" data-ab-label="C2CT 다시 연결 · 기존" data-gallery-flow="generation marker 확인|@C2CT native 재진입"></article>
        <article class="gallery-card gallery-live-card gallery-comparison-card" data-live-widget-preview="reentry" data-preview-name="C2CT 다시 연결 · 개선안" data-preview-variant="improved" data-ab-label="C2CT 다시 연결 · 개선안" data-gallery-flow="generation marker 확인|@C2CT native 재진입"></article>
      </div>
    </section>
    <section class="gallery-section">
      <div class="section-head"><h2>Activity 작업 카드</h2><span>실제 makeCard() 렌더러</span></div>
      <div id="gallery-activity-live" class="gallery-grid gallery-activity"></div>
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
  var liveCardWidgetHtml = ${JSON.stringify(CHATGPT_CONSENT_WIDGET_HTML).replace(/</gu, "\\u003c")};
  var consentMetaKey = ${JSON.stringify(CHATGPT_CONSENT_META_KEY)};
  var galleryPreviewFrameSeq = 0;
  cardsViewButton.hidden = !devCardsEnabled;
  settingsViewButton.hidden = !settingsEnabled;

  function galleryApprovalOutput(overrides) {
    var now = Date.now();
    return Object.assign({
      requestId: "op_00000000-0000-4000-8000-000000000001",
      projectId: "chatgpt2codex",
      status: "pending",
      approvalKind: "operation",
      approvalChannel: "chatgpt-widget",
      approvalSeverity: "standard",
      decisionTool: "chatgpt_operation_approval_decide",
      statusTool: "chatgpt_operation_approval_status",
      interactionProofRequired: true,
      operationTool: "command_run",
      preview: "프로젝트 chatgpt2codex · 보호 작업 “command_run” 1회 수행",
      summary: "프로젝트 chatgpt2codex · 보호 작업 “command_run” 1회 수행",
      impact: "승인된 정확한 요청만 1회 실행",
      details: "tool: command_run\nprojectId: chatgpt2codex\ncommandId: npm:test\nwritesWorkspace: false",
      projectScopeAllowed: false,
      createdAt: now - 30000,
      expiresAt: now + 300000,
      serverNow: now
    }, overrides || {});
  }
  function galleryApprovalMeta() {
    var meta = {};
    meta[consentMetaKey] = { token: "preview-token" };
    return meta;
  }
  function galleryWidgetScenario(name) {
    var now = Date.now();
    if (name === "approval-standard") {
      return { output: galleryApprovalOutput(), meta: galleryApprovalMeta(), widgetState: {}, platform: "desktop" };
    }
    if (name === "approval-project") {
      return {
        output: galleryApprovalOutput({
          requestId: "op_00000000-0000-4000-8000-000000000002",
          summary: "프로젝트 chatgpt2codex · 새 명령 프로필을 이번만 허용하거나 이 프로젝트에서 허용",
          preview: "프로젝트 chatgpt2codex · 새 명령 프로필을 이번만 허용하거나 이 프로젝트에서 허용",
          impact: "승인된 exact executable + argv 프로필만 해당 범위에서 허용",
          projectScopeAllowed: true
        }),
        meta: galleryApprovalMeta(),
        widgetState: {},
        platform: "desktop"
      };
    }
    if (name === "preapply") {
      return {
        output: { presentationKind: "widget-preapply-load-only", status: "pending" },
        meta: {},
        widgetState: {},
        platform: "desktop"
      };
    }
    if (name === "critical-runtime") {
      return {
        output: galleryApprovalOutput({
          requestId: "op_00000000-0000-4000-8000-000000000003",
          approvalSeverity: "critical",
          operationTool: "runtime_apply_local",
          summary: "현재 runtime을 새 immutable runtime으로 교체합니다.",
          preview: "현재 runtime을 새 immutable runtime으로 교체합니다.",
          impact: "앱/runtime/process 실제 변경 가능",
          details: "tool: runtime_apply_local\nprojectId: chatgpt2codex\npreserveConnector: true\nrollbackOnHealthFailure: true",
          criticalBadge: "Mac 시스템 변경",
          criticalWarning: "Mac C2CT runtime 실제 교체 · 성공 후 schema 변경 시 Settings에서 C2CT를 수동 새로고침",
          criticalIdentityBefore: "현재 fingerprint",
          criticalIdentityAfter: "sealed candidate",
          criticalRollback: "새 runtime health check 실패 시 기존 runtime 자동 롤백",
          criticalPostApply: "Settings 수동 새로고침 후 scan-tools 별도 실행"
        }),
        meta: galleryApprovalMeta(),
        widgetState: {},
        platform: "desktop"
      };
    }
    if (name === "critical-app") {
      return {
        output: galleryApprovalOutput({
          requestId: "op_00000000-0000-4000-8000-000000000004",
          approvalSeverity: "critical",
          operationTool: "macos_app_apply_local",
          summary: "검증된 ChatGPT To Codex 앱을 /Applications에 설치합니다.",
          preview: "검증된 ChatGPT To Codex 앱을 /Applications에 설치합니다.",
          impact: "앱 파일 교체와 연결 일시 중단 가능",
          details: "tool: macos_app_apply_local\nprojectId: chatgpt2codex",
          criticalBadge: "Mac 앱 교체",
          criticalWarning: "/Applications 앱 실제 교체 · app/supervisor/runtime 재기동 가능 · 연결 일시 중단 가능",
          criticalIdentityBefore: "현재 executable",
          criticalIdentityAfter: "검증된 새 executable",
          criticalRollback: "설치/health verification 실패 시 기존 앱·실행 상태 롤백"
        }),
        meta: galleryApprovalMeta(),
        widgetState: {},
        platform: "desktop"
      };
    }
    if (name === "choice") {
      return {
        output: {
          presentationKind: "widget-shell-choice",
          shellVersion: 1,
          card: {
            kind: "choice",
            cardId: "wcc_preview_choice",
            title: "다음 작업 선택",
            prompt: "여러 안전한 경로 중 하나를 선택하세요.",
            options: [
              { id: "status", label: "상태만 확인", description: "읽기 전용으로 현재 상태를 다시 확인합니다." },
              { id: "verify", label: "검증 진행", description: "테스트와 빌드를 실행해 변경을 검증합니다." },
              { id: "later", label: "나중에 하기", description: "아무 변경 없이 카드를 닫습니다." }
            ],
            compact: false,
            availableAt: null,
            createdAt: now,
            expiresAt: now + 1800000,
            status: "pending"
          }
        },
        meta: {},
        widgetState: {},
        platform: "desktop"
      };
    }
    if (name === "auto-ios") {
      return {
        output: {
          presentationKind: "widget-shell-choice",
          shellVersion: 1,
          card: {
            kind: "choice",
            cardId: "wcc_preview_auto_ios",
            title: "계속 진행",
            prompt: "자동 진행 카드 UI 확인",
            options: [{ id: "continue", label: "계속 진행하기" }],
            compact: true,
            availableAt: null,
            autoContinueAt: now + 14000,
            createdAt: now,
            expiresAt: now + 1800000,
            status: "pending"
          }
        },
        meta: {},
        widgetState: {},
        platform: "ios"
      };
    }
    if (name === "manual-refresh") {
      return {
        output: {
          presentationKind: "widget-shell-choice",
          shellVersion: 1,
          card: {
            kind: "choice",
            cardId: "wcc_preview_refresh",
            title: "C2CT 새로고침",
            prompt: "Settings에서 C2CT를 새로고침한 뒤 확인해 주세요.",
            options: [{ id: "refreshed", label: "완료" }],
            compact: true,
            availableAt: null,
            createdAt: now,
            expiresAt: now + 1800000,
            status: "pending"
          }
        },
        meta: {},
        widgetState: {},
        platform: "desktop"
      };
    }
    if (name === "reentry") {
      return {
        output: {
          presentationKind: "catalog-host-reentry",
          hostToolMentionRequired: true,
          hostToolMention: "@C2CT",
          expectedMarkerTool: "chatgpt_catalog_refresh_marker_preview",
          syntheticFollowUpAllowed: false,
          sideEffects: "none"
        },
        meta: {},
        widgetState: {},
        platform: "desktop"
      };
    }
    return null;
  }
  function galleryImprovedCardPreviewCss() {
    return "<style id=\"c2ct-gallery-improved-v1\">"
      + "body{padding:0!important;}"
      + ".card{border-radius:14px!important;padding:12px 13px 13px!important;}"
      + ".title-row{margin-bottom:7px!important;}"
      + ".title{font-size:15.5px!important;line-height:1.32!important;}"
      + ".approval-time{margin-top:5px!important;}"
      + ".impact{margin-top:7px!important;padding:7px 9px!important;}"
      + ".approval-details{margin-top:7px!important;padding-left:9px!important;padding-right:9px!important;}"
      + ".approval-details summary{min-height:42px!important;padding:8px 0!important;}"
      + ".actions{gap:8px!important;margin-top:10px!important;}"
      + "button{min-height:44px!important;}"
      + ".critical-badge{margin-bottom:6px!important;padding:4px 8px!important;}"
      + ".critical-warning{margin-bottom:8px!important;padding:9px 10px!important;}"
      + ".critical-meta{margin:7px 0 8px!important;padding:8px 9px!important;}"
      + ".card.preapply-minimal{padding:9px 11px!important;}"
      + ".card.preapply-minimal .title-row{margin-bottom:0!important;}"
      + ".shell-options{gap:7px!important;margin-top:9px!important;}"
      + ".shell-option{min-height:46px!important;padding:8px 10px!important;}"
      + ".card.reentry-compact{padding:10px 11px 11px!important;}"
      + ".reentry-token{margin-top:8px!important;padding:9px 11px!important;}"
      + ".card.shell-compact.shell-auto{--shell-auto-pad-y:12px!important;border-radius:18px!important;padding:12px 14px 10px!important;}"
      + ".card.shell-compact.shell-auto .shell-options{gap:10px!important;}"
      + ".card.shell-compact.shell-auto .shell-option{min-height:52px!important;padding:11px 14px!important;border-radius:13px!important;}"
      + ".card.shell-compact.shell-auto .shell-option-title{font-size:16px!important;line-height:1.35!important;}"
      + "</style>";
  }
  function galleryWidgetDocument(name, previewId, variant, forcedTheme) {
    var scenario = galleryWidgetScenario(name);
    if (!scenario) return "";
    var previewTheme = forcedTheme === "light" || forcedTheme === "dark" ? forcedTheme : "";
    var themeExpression = previewTheme
      ? JSON.stringify(previewTheme)
      : "(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')";
    var bootstrap = "<script>(function(){"
      + "window.__C2CT_CARD_PREVIEW__=true;"
      + "window.__C2CT_CARD_PREVIEW_PLATFORM__=" + JSON.stringify(scenario.platform || "desktop") + ";"
      + "var state=" + JSON.stringify(scenario.widgetState || {}) + ";"
      + "window.openai={"
      + "theme:" + themeExpression + ","
      + "toolOutput:" + JSON.stringify(scenario.output || {}) + ","
      + "toolResponseMetadata:" + JSON.stringify(scenario.meta || {}) + ","
      + "widgetState:state,"
      + "setWidgetState:function(next){state=next||{};this.widgetState=state;},"
      + "notifyIntrinsicHeight:function(height){window.parent.postMessage({type:'c2ct-card-preview-height',previewId:" + JSON.stringify(previewId) + ",height:height},'*');}"
      + "};"
      + "})();<\/script><style>body{pointer-events:none!important;overflow:hidden!important}</style>";
    var html = liveCardWidgetHtml;
    if (variant === "improved") html = html.replace("</head>", galleryImprovedCardPreviewCss() + "</head>");
    return html.replace("<body>", "<body>" + bootstrap);
  }
  function renderGalleryLiveWidgets() {
    document.querySelectorAll("[data-live-widget-preview]").forEach(function (host) {
      if (host.getAttribute("data-live-mounted") === "1") return;
      host.setAttribute("data-live-mounted", "1");
      var name = host.getAttribute("data-live-widget-preview") || "";
      var variant = host.getAttribute("data-preview-variant") || "baseline";
      var forcedTheme = host.getAttribute("data-preview-theme") || "";
      var scenario = galleryWidgetScenario(name);
      var label = document.createElement("div");
      label.className = "gallery-live-label";
      label.textContent = host.getAttribute("data-preview-name") || name;
      var chatHost = document.createElement("div");
      chatHost.className = "gallery-chatgpt-host";
      chatHost.dataset.platform = scenario && scenario.platform === "ios" ? "ios" : "desktop";
      host.dataset.previewPlatform = chatHost.dataset.platform;
      host.dataset.previewVariant = variant;
      var appRow = document.createElement("div");
      appRow.className = "gallery-chatgpt-app-row";
      var appIcon = document.createElement("img");
      appIcon.className = "gallery-chatgpt-app-icon";
      appIcon.src = ${JSON.stringify(GALLERY_C2CT_APP_ICON_DATA_URI)};
      appIcon.alt = "";
      var appName = document.createElement("div");
      appName.className = "gallery-chatgpt-app-name";
      appName.textContent = "C2CT";
      appRow.append(appIcon, appName);
      var viewport = document.createElement("div");
      viewport.className = "gallery-chatgpt-widget-viewport";
      var frame = document.createElement("iframe");
      var previewId = "gallery-preview-" + (++galleryPreviewFrameSeq);
      frame.className = "gallery-live-widget-frame";
      frame.title = label.textContent + " 실제 UI 미리보기";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("scrolling", "no");
      frame.dataset.previewId = previewId;
      frame.srcdoc = galleryWidgetDocument(name, previewId, variant, forcedTheme);
      viewport.appendChild(frame);
      chatHost.append(appRow, viewport);
      if (name === "auto-ios" && host.getAttribute("data-reference-image") !== "0") {
        var referenceImage = document.createElement("img");
        referenceImage.className = "gallery-ios-reference-image";
        referenceImage.src = "data:image/webp;base64,"
          + "UklGRiQfAABXRUJQVlA4IBgfAACwhwCdASq4AT4BPjEYikQiIaEQ2sSoIAMEtLd+JsKp1Xclp6PocGu5x2c+0ntY+JP06/MV/C/7B/qv8B7wHize4B+sfWiegB+yvpi/tH8HP7Xftd8AH6sf+DWj/KP9e/B7v6/pH4pf0D/yes/4b8a/Tvx7/vf/m/z/xBZS7S/4v9aPpX9j/YX+z//D/YfHf9j/KHzj/H/0j+1flT8AX4j/GP6Z+O39f/cDkltM/03+n/FX4AvTL5R/Zf73+z/95/cH2Vfzb8nvcj6tf4L81v7H9gH8T/jX9o/sH7N/3b/+9DtQB/jv80/x/93/0X/M/x////8P4j/u3+N/xX7mf5r//+9P8m/un+8/xv+a/8n+h///4Dfxv+ef5L+6f5P/n/4f///+f71PYb6K/7X//ESzvG2dUmNG5tl5251SY0bm2XnbnVJjRspJm3cY5+CfhU0axKN9dzqkxo3NsvO3Oo2aAU6JDTJt5ZSXzrcGsFYvOgYKAq3jbOqTGjc2y87czcFNjlRaOLCSbzizl9s9zsIc6pMaNzbLztzqkq0/6eH0u2Itl5251SY0bm2XnbnERvZ7a2PyFstVBn8YUeJGFhmu0S6IF4i0FJ6I5DMYJPRbBGMmnZ0gVwza8fOiUhloViIlC/AdCwjRubZedrlOy5F/b9OGCu44yRtbjR1woVcO25Nzhor9FPOrTo1X8kgMmXfFKc0FDngbzZt/5Z7ff6MLDR1CZPeaZ+wjRubZedudUmNG5tl5251SY0PLOkbLUy+GaT8eghYchVY4FuUJXtVl2LAe7bZ6x1lRtcDudUmNG5tl525wutiFOzb6xXESlsBA3cLtAwc+jc2y87c6pMaNzXt1vhJOC6dapwWPKVllup+CHa+gYpTr0Gzmb6lcOpp73acPDtzcHPLBmMYfu8ClATHDwYTywfmbRXVorq0ViO4fQX4z8To//TNBpbzMCtu16Tnxds/PMZ3v8wdg75qHZTKOMm6HAhyuSeEOA8u404w3D2TUQVGcrK+NzWxo71dd+3fbbvtt31fwe8EEhsRZmHHL5Dl8hy+Q5fIcvkNHp8jIvfChhsumm+sLeSZN8zIAZJAIV61KEqa6mSYqBnIHRQpiMCdSmU5LipQFxTFQLXuQ1iG1NW8dOUGgp6ODh2klJbBIZuL00sOzp2OlYT1Y6GHZG2SEO9PWDCXSZtte+MEvD3/4/ZhS7ZWnI9BM5MBrqTS9qboX7xH3JYOYj/vSvVByVUdrpoE568CGTptsXjmQOFDjKmzDWyiXudOVIsHvwSSPCU+/WKpQ25xGGivcKhV+sbLCfy3vT5fk6idUKCinsUN0TiVD+zcngDznBup+NhxN6bs6pZ+T/Rsm7o44XY+nqkwroVCb1HzuiPDySl7IaBG/76dejxmNiLZedudUmNG4xPDxpq9BfYUQsvO3OqTGjc2y87c6pMaNzbLztzqkxo3FAAD+//JMAAOmnejGiSKHuR2ACySgYgA9oFOt7YVLoIQdOE/PtqL/Eslvx5sy0JzfVCgQDpfWjwoGwSuHCBLu/BZnf2Q1nlBjlHSErCirITo6hL6dGiiQkGE8iK+RdMc+mBYwGETVFTTUcwAfg8/hnQsKI4MxOFQalqZ+xmrNjMkBhI7fX6naNyN2MD/r/JLilI24YF3CWDVZ8v1EkaR7jGtbelhq/ecuEPPXdrJ0DkhOiD6sGBFdIk+wiG+rrF8fYQOCs3gk4Hbh+yxydCYiRe3Pijx0LcUrcJC7KC5iTy8ivLxFums+5zl44kTSgK7q8Os18cPGz/4KN+NRx9Lbo4Db7/OS49IuaptfpI8geG6aqGMi/SbE816jZYy7BQNtL07AJ6xxH8vMuoFNgkFeKWgIkgQc88wJ6Qx4ydmP7Anpx29+wXQbJJ3ghFwkMDav2oISyFgFPJP0ygKBkZpguqF8aSIq6X8qirSysks9wH9svDau0orviq4qD9aYTZoES2cxP/3R7rT5GPmDKHbwwPHALN63/UYB33ujuIts6eCF4gyNtnwDoUWyAZRQo9r0jtmyMAFIZxiywFABkM7tKItpQ2zg5X7rulWmsQ1sGUKNskGKnq4ukgHgBAVOiYE8UumqSOG7i5DquIcycrc9qNvw+JbwpiydBCXect/TRnBCEv7UYlzO4F61J0U8xBtLKzQ5iPT/6XzXsoX64uVhr8Hq8Xba7Y6W5z01GfGxpBjQNorv4pw+FGXBrv1Bsy0L3Tt/f76bVawx2gPzMwxZjkPZx1tcC63RxME6I0AaZ5HgA1u8pMKCRq/8hRGcSQdfhi4NdzGLUo6qMwi7O3hoJO3VvGTtf0rVKBGN6P5AYeMrgfPgcjM7+Wb3RN3z6AueOABVZC4Tg5n4ZR3ns+P5btiYmfYhZpwkvCHaVUaJtDhh8pMmY07313N2tQLRia2oq5l1RmDO6cxh6OJSntZMV5RNEt+7k+xBnUuHNx0vZg+CRbhazlyXk9qZBo6EU6lukv0ukjKT5UHrbzrpFufPTStCv3uNKo6tWjauxYT1zO1oac4fOpsfz4sIL0EqN9t/Vinqthjd36UMOm/TMjdhYlJeOEm8PL1ZzKW+cIEjWMC0lqIbVh5/LE49Vwx9bzHXMQmX3XCwpHNUdhTEarfVzlskTEvnxvR3nJv4obUGjTMg147DHNfszEcfwrxK9mOVu2LlWYqlRzjX/D5ibhYbLtGGgbthkDgnWCb7cII/fGFp7XcWAd3naGhaGdAP+rnwI3we3ZQ2a77rKsuIoJg2PZOcMDH7D02pFj4DIYIeS7lKDSLtMqT7DR5QXzioW4gF/RrDgf0RkaZUzAYifxohnDBuJMxWCW5fHmYFkk8UnDaBdw39ycFpopqFDPqV96222uw8nms/74uY7KthjfLsYsOlKWNQ/l4bDBCUZXZ8aZPGFDI9Q8D6YvA+p9nGiwcbPP1P6mIU80uezxz7FNtM7YLeXJmFA5vDpjEWPFbNdckM"
          + "3ku2cVnq8bYwyPqtZGj/1mjFIfJgZQrPqBX88GmKpd/LonyBHDKYM9HB4rlVFbsjOUBbPaz7/JIBEWwXaov6jGQOKcoV/JAHiOevP8cDudkymRAu5G6nFlimfByDOYF5GPcZNJvuZYwOKH+dS67fT+kPcJyVNvtRCGh+F1pjLqLsV0Ll0SURHALSM31GhH6uLn97hVBow6bltn+hKy6CABqgnAGYilRW1SZ8uox8ZjPTm0uyKkpvFHZKemEhwJFIAs0rwNcOWdl8ak3uzAYjXdIpvGzQbjISRmOC6bf4IQ3TJoQvVb8X+xcixyRB770v1ZkCPAcBr7sFjQn5/1IA4EfUg0JjQBGURbxL3Owdl3iDENSCCJCQTJHLhzEcKC7IwVd7NZC7hYsbKWBrBXRRwWAPQg1wvfqkfeDXFbyx4nk7Xs4xKz5ORr8rxXWhRwSDsBAh/isyw4f0VkkgitK8kDbAJRFCMSitQrpgjTE+X2lJ5khG8c6YleHJz0y3ws/x+JJ8pf3AwvBYaVvmZDBGdU8JmB/HymrvR6ebOjc2RSGgf3uX+5KNfBZeDhjjSYoKy1J1BJ4PJ6rUbNz/57l5hNyc64caMpxFgAFq+wDlT5W1v3t6BUmCDIAYgGKn92GurJxm3WRgAnQwaWhic3bb9EshgNp3u8SdrxoIzNtdsJjyX81lV9CfZUYRVM6EAjLdLhvC0TiZ5TIi+m/HmIcu4aR69M4KXK5sgAskJb92QpuQ7mWwbhrQhDWLu820vwN+5i8xiUe6DekwZ+pAd/a0DvbbkqtkvuBaS4N2i+bG8l9e6A///ho13v8c1jl28uWj64zmqnxzOkPaOyvfnuNn6Fwl0tFmPzRAmbEK+ovIKDYTRBh9+ALo5crGcg7K+LVIDbACwzpEPQpQ8rcpAEgcPfSqWmt05SHjYTQ9Je3JAGF5zmrJD8MIVWSNflfZkCOcxrvnsWEigJ2UHUMrBk8lLJF/y/x4RDO0xGXlZMMAMl9o0k4yk4YdHgywzIbAj40iNPOYwH+vJ89x0C14FizJy0z8Fo/tgem+vVJUskK7DTI0M6C+oQjsXs5N202vXojQ4BTwtNlg+na3HWaxSmQp/9u+4GLmOgUVF2zZNSIbLX7OgH9RSbl8+2rzoF4BLXhllJE/HgypC0fy0M5na0kQBYgUH3j8IBF1AhWxRbhsbGesF30HoQFCbQOjKQjf/zeDbo0pM5BxwqmFS55sidJBCvShaqURVg8BVYnC4qK4AspcmZcoXpzKQYp8wnViXCGQbE/xfexRyK8hk/ygqhZR4sdMaVTVpT9/Q1sIIYjnY2IU4SndRolA6AYRhyAMAcZ5gUw80lLA7m2lnvzSxmJ4zT9kfD9I5Z7vhH6EfvN5LOXfTGC0bQxM0uhI6Dw7f1fQvmr3ijIUbjOu7VMJ1sStegC5vGWhdYe4h5jlfM4g5PbkAQVZxT9nFIKIBvLqEOgiv2b/RHnYQAsYKKOA5zHh1lAjuibZ0MDaGrHbyftMzwhD87Hk6mkYYAj8qmymkpkF/L6RA/q5xkV0WrALViZBffQI+mUtKa0mImsZOjabqknJGXzptrhm55i0eJQCfQJNW0TjoS7cO9jb/X/4pwZKiK2JojB1sXoIHIJSFK2vJj8Z60VdGmtmdXI1AGtM4pEnE9brdQgfz66r/rxAKK8SS4keM+mQN53TSRPMh3PHhzSZudjfJ7vzy3cYXJWs8E3v079EYeNJ5t5udRpZIwn9Qs0p/CINUcX1EqYwzOqPXTvm+nBp8sGtQYljrRiZ76QW29lx79adyTkIE9BX9224sxBDvKBv2IKvMu3b74tr0DgVQCPTlfF6vom7wHQyC9Hk4VBXwx0r4S0qGhzbgx9wFB80LfdPc/saFgRntQiu/gtwdvGc5AHDuqYEdYEp/XZ9+eyk3eWsKvDLmrqQDrgzCNv9ZK/+Mq7btqkq0qthNjbrKuf0B2GNWoTZfRpb5Ir/bvqo/VeLbWwtzy8j0G/NC93pLgTOrwBeuLa090wpUOkx8KBSwq+CW3qoKmX2UFEqMok41vKC/QlZoIzSyyz4CYvXmxVSa7Lozu91mGLKx3VGzR/94FiZDlNcc5k0VKIE6pUA4yCx+A8ROWubJMHxLQMVtaM1uM43z7r1wNSqVSEK17GvfSZ59gx4uSm7631Acd6ErkhDwQ92Gmq2VgOrHhm3Gk9DejbQxj7j9/RvN4wkaulJdJ6mGUXPLdVGzG+zByxmtpN90FkOXZ5J4W5HIcXNlQfPYdnbA0OFxfQVzWSKq76/+hZuqyztVBVt357dBmq6nV325ZR81rL33kv5A9zdyYWw/WNxQ0VqnH1svqEvvvEopFYzn2Eh+ks6yJPs4Tr1p+urs9gqsmsR3xJ2UEX86XQjdczVqa0sCogo9eR2UQlJlMcL3lT6eALqO51FfLVli0DwxhlGl2jqjTOerIJd4HgpNd2OBkDkxMj4TErDuuD5mPGxKyfSgMfugdTf2LefmBfmHh75H/fMP75h/e645+wnARwlb3slmD5fNoz8Rb43kUE/tWopxWzPMqc6fK1HGvqAgqTJSTxGcwzoAW8MZyHzPq/WEgwfSktaId7imhU/tT/q9SCZFpQoW6RLGklMiok7IpvFvR4YB4NQZiC1Updml7cEahDUuEjyqtQaD7iW1EzTOXNoliHd84hT5h3jGHtRfQRH5Te5HxVVGZEyidzTG77DjhIqCN2EIUQaF5ALZ5TjRb7dyKseBwcsXcrIcd6o2TrzqVNDMk/6laIdtXJ0A8DZJfNVouUSP8+ydB8iSbtnCoN8dxCDxddIlnToQZitBU5lHsp84AdhjKnlEzNr58J1tRoJkUP95YHxCFb7RMwTIR6906dqQOkNVeIJUWzxUb8/0ufLglE3eQp5xJDwG4OFUTEE1Hj+KHIHvM+xNhNJoYc6EFK71tQ4a24arAbcwPb5nTTTY9Z/dMYQKLeaUiZC5TC2+7+vN/g1F9AfGKelb4A/"
          + "miS0KLLdDLHYb7mki1EjzfAxj8Q8bQE+Bx73SexEGGRKMmwvFizCb5JWV6yysQAiT/rNZ6aJBlbNp0mzGQoqXhbBraa2ei0lGkWIzymBUoFN4kUrCpGymuqDInkl2cGl2T9UPZIJaATNGMPdzqL9w+uPUXqjrE2Z/weBreU6/i6zgABLi6jE62bJDhjE/Y2CBQV3/dxMOyhAZcAJ1TKxbR2SzfJhcGXpJCrnnPcT1i34GWN7wOGnx9oPsaPabvqIo5YEww56WpLZjj51EckbKhOlMUxjYzjLsWYCUAG42tMf5mRkvww3zl42uQkdqJARj733D0hzuPUEIrqUi5P83FaVQ7qMtHD03zrsBZkIkBueAPpHoCTx7vgWsxQFUu3A5g9lScrFS1ir9HFuS2c0gR/12dj+GJOwlRW33CrIzDrDBLqft1W2U62NhflEzk3Pw4ZGjm/C/1XL1Vc226qJbSPgS7F1aLcF+X9ZcM0ssJWE6wmmICuZQktMpoJq8JndRSV0zoLErjrrCvs1VffYaThaEwaYMy8+4XCLEfAftcINrvo1LFeap6yZAj6nr/udCW1cC8kjfEopU424gnbgH8iCDI2SNXvXMQxjllXtTxQfsnX712IMupTAzUQaf8VglcA+ee5xYCunTaGD/hfl8BMppFZp51djzYL5p8+JVzk8/qng+Y5gp0ijczAUgkHsBXF5sAKBWgrRZ8tSBDPUzfnaUKnlbOKxTU10/HQomb3CwivrIPs8o9WQtfAA+BoFMEThmmMBePlVfEWE9R9Ec7jYpr0l/9UOTrJISVK8v3H3tvS2Q/0tYE8gvo5/8wza3m2JH1YiF5i3Np/KugQ6SudEutZQpVfv41gCgg4ctFPo/XZj+wfD+kLuKwHAeMcGi0F4mlBKpiVXxGFHOvOXHDqKlqgzz5IXdSoURfqdxZp9vMl6rL1qYtXvoiGU5pkWdrlYgs1m6uQ09tjEcWylLJxSbQiZqaKeGkbrw7KsfCbss1vPkDBxZ98VZKEThn2K0yUUZi7Oqx5ABS70VslykHAgEwG7r6MPfsQL0EX8+kHyj3gpHogrQBvRylg5BRgNl5Zh0VB9e4gE4xl0hKmYMhgX6nbBvXzYYdqZTUoGt91ks4EASdGotnk1csFdF29tpaef4hxEJ8TMYOBrrQbTDyjtr5//R8C+gg30ptmZazUDdcFytCYVxXIp3wSGQ0KRYe690J8Zk6knIKnivBnQ8ustB87eoctR46J4otOS2yCioHjzP1HAsPOkg/b1rBseYoOiDlAVTlPMjdJBlZP00w8YPX4QFLCMmVMB152LP4zVD0TpBvd4PJjWHfWtegD0pqBE2z3vCTmLk60QpWACBtv5GOSJRrEzmdC3or6yv6BFNC3tT6I1e4FVXY6YKkCDrRe9Fuop3glPn0yfFHhVP5s53WVWZ6Nr4jg/OmYnColuen7RhZd7Dg0c/g5jO3JuVBySzBC8pCWA6WFe3ntbEL0fpFC9l4EsyGxmLGOLzGfGu2OZDi/cHG4qYrSwe4P+T/L2EFPgzpgm7uvIXAA5Gjraxtpf1ocK76TlJJp3ZwVhPo7JOlo/13Se0s7fZiRys6Sz2uHbJgVb4PuoNflykzieYTffdBXXVCOnHRRwPokRZ2bhX/al+VuFdcB6OQnpvV92gNgJcr7D1aKU67urplBNhfichp96CXmvgLP1Qt639jSQZvv3gHBL4U9VVAMK8E6ih2QyWwzWGhY5QB49kOBCdgTmzy+CEanJDz8OX+wRo1Pk20B/VE1KSXkmiS03odlzh/AKsH8y4Qg6ezAdySq2ZdFXbCW0FsTZ0eyzZRGpYAtoCTyusk+Q04qlTxFzpueUYrSawuJmYw06Ia1T7cV76o7oZNMlklmsHHDgdYS7VP8KXqiQ/v2wGJ2wGAcs9qct7K03kp5NyRYenoIRY8TktjYpyQ7tIpg1RBsHiZn50yVF+gChRQL9UpgCcmSkpVE4jgpZA6Ibsv05O5ea/aCuwNY6XS9V27kldt2r4rC4nqeHdbpxxX/WuRil9IBdZuuydheeZAefkX4AGggNN5Or9rGu+P0gqGrxDdqJtr8Zo7fo4g1C6tfsin3bpmiet8VK3TTva26xJ3FdCBXxb1gcem73IXBfqLqB1EdrL4nxz5+PIqa/uxZNBRz08YYXLj5Up12F/yjo23tn+TzWXnu2rRFrmZt3NbhSlRdeDcgD3ilufnsxRRZy8i0OGseLcHTjJ5NFJsnixbl6hmTU15z0HIHwysDBUa1GnWu5Lj+jaCDD6v/Y7tgUseva/Yyari+28Eq+twuWL6lpOMlaevX06AMnB153PMvsRQDHHljprT5CpaaBz+0DJEUXuVbLxXQtyYax/mQBjWl6ixdK3dGQEm9T5iMcH9QA+MK5M/1ucDFMWwky/V8C4C3dqy1b/DDL8irn38XTus99TC3R7B3SVZnc+FBqksa+xGWYzf7s/NKzsGGF6BwATQGVvX6UjocNYX52bjbgNQiLQF8pQc3o5/jwAwla24HwXFV2wafZRNZprkvoXNdmBmP/b//+ZiaixECJ0T5NLCmp+Aqe3u/OCbBjroIwj9QwmElIPh21CbPQnrJFB9i+V8Z8ky8aGjdDjFlbphl8OVi4BS77gxf2QFSqSVo5XrqB+vAk8hGjgkvd9P3oPpfj5UfNpAyg/oe88LVYOyS701ZXOxa+oB4xrjD7yVN03GMf4lOeOj/aZ0G4i9GOLRaISEK4uP76VOkixqxVsX2ClnZ/Vl5JZND7iHEaYmXb46wJEDrYnBRQs14Jr+wlhGrEMiGHWmMUQ0wk7roNZbNmDFC4JyPcku+ykwSENE81fu5zYeNdTG4ff86/8CpCkXszQ0XTZJJycvgZaAuVjOLlVtZKNOKeBV/1EEnpLsTjrhuYFvkHuaTa/ioV5Nvk2WsBVNx/5zLmW4f/mHpVGAAfHL+Tenc4IkOQslekSbrbCF3Np/xlUy8KznGUmecYp6vv"
          + "7+4RNxX1a9au33kiKlPooQBwPB6gcuIowCUzqTabFBtQWvI1fEYOwqiGgINzhntC0a0kQfUrnLSfZNCPcXrNFeJkd6Y1ayQUdiVW1eCqLYSgy6S7YHEQhdF2sJa13qhjSl5S3gIt50GUE1QWSmHmOML2jzgS/ErOcsU2xQIMIHNQsFxdg2G6W8A5IS/OVPMYvj4Vp2UT/E6cJ12a3JGRhzlVg41sXToBbZaqbtTo9tt/B+nynR4Jo14/PWshE/d3N6QN2cxK91YMlqi6s3R9WmyuLChg4qa73YhTIHmcVEx3LDmtU+v7QwW0vE4xJs9ogiud2TQ4GanapVmgwKB9H0lxo5xLQP/F4IwaPoFMmZuBfw1whkS95F8Qw6NoRHWc1P+bzRqqWy3kLjGan6+u5EADMKLyErIads9ATPFvBYQRfzqtaENR56c8XkcZywqpN5ssYbID4JPbDTX1yhfRx3s+jA8js/tOg0b2KHKmHj1KwM82dMJ5V4alSuL164upe5dBDHN3seCJ3/IX+SkUmL8THQX64SEGlx5y9RbkvjsDVDxXBUiwFalRiYVmvIDLm1YZXAPHRU6RjlMxporLTEhdcLARMgR0cmwS5zUJ6lZXfOCqIB0xtooRhVaum16aUVzFk9uhqOi8vmv1OjzXaP1b9KmWUUxNb/607lmYb9IrUApUcZYuVSK+G3e3q25KYrunp5IJnqze04CrvAbdHrWOruJ9MrPze/t0c4trjtN1OyvqRGA5TNhyEYriaGTpHUPbCKF9CSk1TC62o8wfK0fEMp7zEa21LIIi/BK/VOQxgCgO784TPnrjWHET+52r86f8wrSUuLNzEPc8nFYVYDJRvWEBj6inFUWBuisOxgINzDuWi/dbdKu0imlkXWVKtqmUlvVnh+LbxAmCj9E5VhFJtAljGbiNnIZOdQhVUaAyWRXQdVJQAEZJguiNF/ST690t3ErhpCbkdLoVBVOC1XyQp0q75ZrWYqZ2JeoQXLs+Sy6de9mMWzmaXpqVTDH30IqKAt9oD0DSDv3hCldgdKRzbslJ6K+IbKSKngt3OW1Oy0G6VFHwjXmLcb9NDX8vbDcTvnYBxARA6fVKv3FENQgDeCOBf+mRlxhcfUV3X9blSPS8pba/WvEgHp28TnUWU3Xg46EfMui2xNCAATJb3EsfLCXaLfV9ABMfQTP7wt2s3EJ7Q86DaqbHipUBN+DPbTy3pGbn87BBaxfXt+d53WpdHqpHldP/wHGvhzXza9h0A1ax9Bbj0XpQm5Yezhaw8q8zEWcjRvrjBflVxLUsm4UCWlX6zKc+JJJ+oAMQ4gdVqk+Gw7iE2HsCTWyEHfRUoQbY5detFRB2UVn/mnyQIhI9k92frm2v69bSQaE002Zaabt1Rcv1BzOr/Pou0611hAnFZWsPGqN7NFjRBuenLF+quDPKGB128sKC2PnT65vJq0YIiTazqIc5ZKJXs5rrQgMGrTJH4F8HHJbsANPfdGkhDs2TU8JKhLnJPxfskgsBkufAA0u910mcJQ+zUU8Gz4UvF2+a2PxFM82Q75JbpUd2sIL8oOUEGd0A+ogRKADkU3nNN96d/N5TohfnM/QgzehhHxHPV0Kg19vYwsZqiQ+6YpxvNxOGCwAAAAAA";
        referenceImage.alt = "";
        host.append(label, referenceImage, chatHost);
      } else {
        host.append(label, chatHost);
      }
    });
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "c2ct-card-preview-height") return;
    document.querySelectorAll(".gallery-live-widget-frame").forEach(function (frame) {
      if (frame.contentWindow !== event.source) return;
      var height = Math.max(88, Math.min(760, Number(data.height) || 88));
      frame.style.height = height + "px";
    });
  });
  function renderGalleryActivityCards() {
    var host = document.getElementById("gallery-activity-live");
    if (!host || host.getAttribute("data-live-mounted") === "1") return;
    host.setAttribute("data-live-mounted", "1");
    var now = Date.now();
    var samples = [
      { id: "preview-active", title: "승인 UX 수정", titleSource: "host", state: "running", firstSeenAt: now - 120000, lastActiveAt: now - 3000, boundProjectId: "chatgpt2codex", operations: [], workGroups: [] },
      { id: "preview-approval", title: "런타임 교체", titleSource: "host", state: "waiting-approval", firstSeenAt: now - 90000, lastActiveAt: now - 2000, boundProjectId: "chatgpt2codex", operations: [], workGroups: [] },
      { id: "preview-done", title: "전체 테스트", titleSource: "host", state: "completed", firstSeenAt: now - 240000, lastActiveAt: now - 120000, boundProjectId: "chatgpt2codex", operations: [], workGroups: [] },
      { id: "preview-permission", title: "도구 호출", titleSource: "host", state: "failed", firstSeenAt: now - 60000, lastActiveAt: now - 5000, boundProjectId: "chatgpt2codex", operations: [{ operationId: "preview-permission-op", tool: "project_lane_open", projectId: "chatgpt2codex", state: "failed", startedAt: now - 6000, finishedAt: now - 5000, errorCode: "LEASE_REQUIRED" }], workGroups: [] },
      { id: "preview-failed", title: "도구 호출", titleSource: "host", state: "failed", firstSeenAt: now - 300000, lastActiveAt: now - 120000, boundProjectId: "chatgpt2codex", operations: [{ operationId: "preview-failed-op", tool: "command_run", projectId: "chatgpt2codex", state: "failed", startedAt: now - 125000, finishedAt: now - 120000, errorCode: "INTERNAL_ERROR" }], workGroups: [] }
    ];
    var fragment = document.createDocumentFragment();
    samples.forEach(function (chat) { fragment.appendChild(makeCard(chat, now)); });
    host.replaceChildren(fragment);
  }
  var galleryDebugBounds = document.getElementById("gallery-debug-bounds");
  if (galleryDebugBounds) {
    galleryDebugBounds.checked = initialParams.get("bounds") === "1";
    galleryView.classList.toggle("gallery-show-bounds", galleryDebugBounds.checked);
    galleryDebugBounds.addEventListener("change", function () {
      galleryView.classList.toggle("gallery-show-bounds", galleryDebugBounds.checked);
    });
  }

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
    });
  }

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
  var PERMISSION_REQUIRED_CODES = new Set([
    "LEASE_REQUIRED", "LEASE_EXPIRED", "HOST_MANAGEMENT_REQUIRED", "HOST_MANAGEMENT_EXPIRED",
    "COMMAND_NOT_ALLOWED", "PERMISSION_DENIED", "CONTROL_DISABLED", "SCAN_DENIED"
  ]);
  function isPermissionRequiredFailure(entry) {
    return Boolean(entry && entry.state === "failed" && PERMISSION_REQUIRED_CODES.has(String(entry.errorCode || "")));
  }
  function approvalStopLabel(entry) {
    if (!entry || entry.state !== "failed") return "";
    if (entry.errorCode === "APPROVAL_DENIED") return "승인 거절";
    if (entry.errorCode === "APPROVAL_EXPIRED") return "승인 만료";
    return "";
  }
  function isHardFailure(entry) {
    return Boolean(entry && entry.state === "failed" && !isPermissionRequiredFailure(entry) && !approvalStopLabel(entry));
  }
  function isHistoricalFailure(entry, now) {
    if (!isHardFailure(entry)) return false;
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
      if (current && isPermissionRequiredFailure(current)) return { key: "permission", text: "권한 필요", color: "orange", priority: 3 };
      var stoppedLabel = approvalStopLabel(current);
      if (stoppedLabel) return { key: "stopped", text: stoppedLabel, color: "gray", priority: 4 };
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
    if (isPermissionRequiredFailure(op)) return "권한 필요 · " + base;
    var stoppedLabel = approvalStopLabel(op);
    if (stoppedLabel) return stoppedLabel + " · " + base;
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
    var permissionRequired = isPermissionRequiredFailure(entry);
    var stopped = Boolean(approvalStopLabel(entry));
    var text = activitySummary(chat, entry, now);
    var line = el("span", "activity-preview-line" + (permissionRequired ? " permission-required" : stopped ? " stopped" : entry.state === "failed" ? " failed" : "") + (historicalFailure ? " historical" : ""));
    line.setAttribute("role", "button");
    line.tabIndex = 0;
    line.setAttribute("aria-label", "상세 보기 · " + text);
    line.title = permissionRequired ? "권한 필요 기록 · 눌러서 상세 보기" : stopped ? "승인 종료 기록 · 눌러서 상세 보기" : historicalFailure ? "이전 실패 기록 · 눌러서 상세 보기" : "눌러서 상세 보기";
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
    var permissionRequired = isPermissionRequiredFailure(entry);
    var stoppedLabel = approvalStopLabel(entry);
    var text = activitySummary(chat, entry, now);
    var detailKey = activityDetailKey(chat, entry);
    var wrapper = el("div", "activity-entry" + (permissionRequired ? " permission-required" : stoppedLabel ? " stopped" : entry.state === "failed" ? " failed" : "") + (historicalFailure ? " historical" : "") + (expandedOperationDetails.has(detailKey) ? " detail-open" : ""));
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
    if (entry.errorCode) meta.push((permissionRequired || stoppedLabel ? "사유 " : "오류 ") + entry.errorCode);
    if (Number(entry.repeatCount || 1) > 1) meta.push("연속 반복 " + entry.repeatCount + "회");
    if (permissionRequired) meta.push("구분 권한 필요");
    if (stoppedLabel) meta.push("구분 " + stoppedLabel);
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
  renderGalleryLiveWidgets();
  renderGalleryPreviewGuides();
  renderGalleryActivityCards();
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
