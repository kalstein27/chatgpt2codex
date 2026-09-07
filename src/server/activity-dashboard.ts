import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redact } from "../policy/secrets.js";
import type { RuntimeActivityTracker, RuntimeConversationSummary } from "../runtime/activity.js";
import type { ActivityMcpHealth } from "./activity-mcp-health.js";

const MAX_DASHBOARD_OPERATIONS = 12;
const MAX_WIDGET_LOAD_ACTIVITY = 24;
const WIDGET_ASSET_GET_TOOL = "chatgpt_widget_asset_get";
const ACTIVITY_DASHBOARD_REVISION_TOKEN = "__C2CT_ACTIVITY_DASHBOARD_REVISION__";
export const ACTIVITY_DASHBOARD_OVERRIDE_FILE = "activity-dashboard.html";
export const ACTIVITY_DASHBOARD_CONTRACT_VERSION = 1;
const ACTIVITY_DASHBOARD_MAX_OVERRIDE_BYTES = 512 * 1024;
const ACTIVITY_DASHBOARD_CONTRACT_MARKER = `<meta name="c2ct-activity-dashboard-contract" content="${ACTIVITY_DASHBOARD_CONTRACT_VERSION}">`;

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

function dashboardConversation(conversation: RuntimeConversationSummary) {
  const visibleOperations = conversation.operations.filter((operation) => operation.tool !== WIDGET_ASSET_GET_TOOL);
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
    ...(taskLabel ? { taskLabel } : {}),
    firstSeenAt: conversation.firstSeenAt,
    lastActiveAt: conversation.lastActiveAt,
    state: conversation.state,
    ...(conversation.dashboardVisibleUntil !== undefined
      ? { dashboardVisibleUntil: conversation.dashboardVisibleUntil }
      : {}),
    operations: visibleOperations.slice(-MAX_DASHBOARD_OPERATIONS).map((operation) => ({
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
    })),
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
    main { width: min(1120px, 100%); margin: 0 auto; padding: max(12px, env(safe-area-inset-top)) 14px max(28px, env(safe-area-inset-bottom)); }
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
    .view-switch { display: inline-flex; gap: 3px; margin: 0 1px 10px; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel2); }
    .view-tab { appearance: none; border: 0; border-radius: 8px; padding: 6px 10px; background: transparent; color: var(--muted); font-size: 11px; font-weight: 730; }
    .view-tab.active { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.06); }
    .view-panel[hidden] { display: none !important; }
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
    .gallery-choice-list { display: grid; gap: 7px; margin-top: 9px; }
    .gallery-choice { text-align: left; padding: 8px 10px; }
    .gallery-choice small { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 1.4; font-weight: 500; }
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
    .empty { grid-column: 1/-1; text-align: center; color: var(--muted); padding: 44px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
    .footer { color: var(--muted); font-size: 9.5px; text-align: center; margin-top: 13px; opacity: .8; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
    }
    html.embedded-mac main { width: 100%; max-width: none; padding-top: 10px; }
    html.embedded-mac .footer { margin-bottom: 4px; }
    @media (max-width: 720px) {
      main { padding-left: 12px; padding-right: 12px; padding-bottom: max(92px, calc(env(safe-area-inset-bottom) + 72px)); }
      header { gap: 10px; min-height: 50px; margin-bottom: 14px; }
      .header-main { gap: 9px; }
      .app-mark { width: 40px; height: 40px; }
      .live { gap: 7px; font-size: 13px; }
      .dot { width: 8px; height: 8px; }
      .metric { min-height: 30px; padding: 4px 8px; gap: 5px; }
      .metric b { font-size: 15px; }
      .metric span { font-size: 13px; }
      .view-switch { display: grid; grid-template-columns: 1fr 1fr; width: 100%; margin-bottom: 16px; padding: 4px; border-radius: 12px; }
      .view-tab { min-height: 44px; padding: 9px 12px; border-radius: 9px; font-size: 15px; }
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
      .activity-preview-line, .activity-line { font-size: 13px; }
      .activity-time { flex-basis: 46px; font-size: 12px; }
      .activity-detail { margin-left: 54px; font-size: 12.5px; }
      .footer { font-size: 12px; }
    }
  </style>
</head>
<body>
<!-- activity-dashboard-hot-override-enabled -->
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
  <nav class="view-switch" aria-label="대시보드 보기">
    <button id="view-activity" class="view-tab active" type="button">작업 현황</button>
    <button id="view-gallery" class="view-tab" type="button">카드 보기</button>
  </nav>
  <section id="activity-view" class="view-panel">
    <section id="approval-box" class="approval-box hidden">
      <div class="section-head"><h2>승인 필요</h2><span id="approval-label">0건</span></div>
      <div id="approvals" class="approval-list"></div>
    </section>
    <section id="deployment-box" class="deployment-box hidden">
      <div class="section-head"><h2>배포 상태</h2><span id="deployment-label">0건</span></div>
      <div id="deployments" class="deployment-list"></div>
    </section>
    <section id="mcp-health-box" class="mcp-health-box">
      <div class="section-head"><h2>C2CT MCP Health</h2><span id="mcp-health-state" class="mcp-health-state healthy">확인 중</span></div>
      <div id="mcp-health-reason" class="mcp-health-reason">내부 진단 상태를 확인하는 중입니다.</div>
      <div id="mcp-health-meta" class="mcp-health-meta"></div>
      <div id="mcp-health-events" class="mcp-health-events"></div>
    </section>
    <section id="widget-load-box" class="widget-load-box hidden">
      <div class="section-head"><h2>카드 로딩</h2><span id="widget-load-label">0건</span></div>
      <div id="widget-loads" class="widget-load-list"></div>
    </section>
    <nav id="filters" class="toolbar"></nav>
    <section id="cards"></section>
  </section>
  <section id="gallery-view" class="view-panel" hidden>
    <div class="gallery-note"><b>미리보기 전용</b> · 실제 승인 카드의 정보 구조를 보여줍니다. 아래 버튼과 선택지는 작동하지 않습니다.</div>
    <section class="gallery-section">
      <div class="section-head"><h2>인라인 승인 카드</h2><span>실제 표시 정보</span></div>
      <div class="gallery-grid">
        <article class="gallery-card">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state orange">승인 대기</span></div>
          <div class="gallery-preview">프로젝트 chatgpt2codex · 보호 작업 “command_run” 1회 수행</div>
          <div class="gallery-time">생성: 2026. 09. 05. 10:58:12 · 만료: 2026. 09. 05. 11:03:12</div>
          <div class="gallery-impact">영향: 검증 범위 로컬 파일 변경</div>
          <details class="gallery-details"><summary>상세 명령 및 파라미터</summary><div class="gallery-detail-command">tool: command_run\nprojectId: chatgpt2codex\ncommandId: npm:activity-dashboard:apply\nwritesWorkspace: false\nwritesExternalLocalPath: true</div></details>
          <div class="gallery-actions"><button class="deny" disabled>거절</button><button class="allow" disabled>허용</button></div>
        </article>
        <article class="gallery-card critical">
          <div class="gallery-title-row"><div class="gallery-title">⚠️ 고위험 승인</div><span class="gallery-state red">승인 대기</span></div>
          <div class="gallery-critical-badge">Mac 시스템 변경</div>
          <div class="gallery-warning">실행 중인 runtime을 실제로 교체합니다. 정상 적용 후 필요하면 ChatGPT 도구 목록을 자동 갱신합니다.</div>
          <div class="gallery-critical-meta"><div class="gallery-critical-row"><span class="gallery-critical-key">대상</span><span class="gallery-critical-value">69dcc3e66222 → 84f2c71b12aa</span></div><div class="gallery-meta">롤백: 새 runtime health check 실패 시 기존 runtime 자동 롤백</div><div class="gallery-meta">적용 후: 고정 catalog-refresh + scan-tools만 자동 실행</div></div>
          <div class="gallery-preview">현재 runtime을 새 runtime으로 교체합니다.</div>
          <div class="gallery-time">생성: 2026. 09. 05. 10:59:04 · 만료: 2026. 09. 05. 11:04:04</div>
          <div class="gallery-impact">영향: 파일 교체·삭제·작업 취소 등 되돌리기 어려운 변경 가능</div>
          <details class="gallery-details"><summary>상세 명령 및 파라미터</summary><div class="gallery-detail-command">tool: runtime_apply_local\nprojectId: chatgpt2codex\nexpectedCurrentFingerprint: 69dcc3e66222…\ntargetFingerprint: 84f2c71b12aa…\npreserveConnector: true\nrollbackOnHealthFailure: true</div></details>
          <details class="gallery-details"><summary>기술 원문</summary><div class="gallery-detail-command">CRITICAL: replace the live C2CT runtime; preserve connector/tunnel; automatic rollback on failed runtime health checks</div></details>
          <div class="gallery-actions"><button class="deny" disabled>거절</button><button class="allow" disabled>위험을 이해하고 승인</button></div>
        </article>
        <article class="gallery-card success">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state green">승인 완료</span></div>
          <div class="gallery-preview">승인 상태가 서버에 저장되었습니다.</div>
          <div class="gallery-time">생성: 10:58:12 · 승인: 10:58:31 · 소비 유효시간 내</div>
          <div class="gallery-impact">영향: 승인된 정확한 작업 1회만 재개 가능</div>
          <div class="gallery-status-message">후속 대화는 서버 상태를 최종 기준으로 확인 · token은 카드에 표시하지 않음</div>
        </article>
        <article class="gallery-card denied">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state red">거절 완료</span></div>
          <div class="gallery-preview">요청이 거절되어 보호 작업은 실행되지 않습니다.</div>
          <div class="gallery-time">생성: 10:58:12 · 거절: 10:58:26</div>
          <div class="gallery-status-message">새 승인이 필요하면 새 요청으로 다시 시작 · 기존 one-shot token 재사용 금지</div>
        </article>
        <article class="gallery-card">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state blue">처리 중</span></div>
          <div class="gallery-preview">승인 결정을 서버에 저장하고 후속 대화를 연결하는 중입니다.</div>
          <div class="gallery-time">생성: 10:58:12 · 현재: 10:58:31</div>
          <div class="gallery-impact">영향: 아직 보호 작업의 실행 권한으로 간주하지 않음</div>
          <div class="gallery-actions"><button disabled>거절</button><button disabled>허용</button></div>
        </article>
        <article class="gallery-card muted">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state gray">만료</span></div>
          <div class="gallery-preview">승인 유효 시간이 지나 카드가 비활성화되었습니다.</div>
          <div class="gallery-time">생성: 10:50:00 · 만료: 10:55:00</div>
          <div class="gallery-status-message">만료된 token은 재사용하지 않음 · 새 승인 요청 필요</div>
        </article>
        <article class="gallery-card">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state orange">확인 불가</span></div>
          <div class="gallery-preview">승인 상태 저장 또는 후속 대화 전달을 확인할 수 없습니다.</div>
          <div class="gallery-status-message">승인 상태 확인 불가 · 카드 비활성 · 실제 서버 receipt를 확인한 뒤 재시도 여부 판단</div>
        </article>
        <article class="gallery-card denied">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state red">처리 실패</span></div>
          <div class="gallery-preview">승인 상태 저장 또는 카드 처리 중 오류가 발생했습니다.</div>
          <div class="gallery-impact">영향: 실패 상태 자체로는 보호 작업을 실행하지 않음</div>
          <div class="gallery-status-message">재시도 전 persisted approval / receipt 확인 필요</div>
        </article>
        <article class="gallery-card success">
          <div class="gallery-title-row"><div class="gallery-title">확인</div><span class="gallery-state green">처리 완료</span></div>
          <div class="gallery-preview">승인된 one-shot 작업이 소비되어 처리가 완료되었습니다.</div>
          <div class="gallery-status-message">동일 승인으로 재실행 불가 · 다음 변경은 새 승인 필요</div>
        </article>
      </div>
    </section>
    <section class="gallery-section">
      <div class="section-head"><h2>선택 카드</h2><span>Widget Shell</span></div>
      <article class="gallery-card">
        <div class="gallery-title-row"><div class="gallery-title">다음 작업 선택</div><span class="gallery-state blue">선택 대기</span></div>
        <div class="gallery-preview">여러 안전한 경로 중 하나를 선택하는 카드입니다.</div>
        <div class="gallery-choice-list">
          <button class="gallery-choice" disabled>상태만 확인<small>읽기 전용으로 현재 상태를 다시 확인합니다.</small></button>
          <button class="gallery-choice" disabled>검증 진행<small>테스트와 빌드를 실행해 변경을 검증합니다.</small></button>
          <button class="gallery-choice" disabled>나중에 하기<small>아무 변경 없이 카드를 닫습니다.</small></button>
        </div>
      </article>
    </section>
    <section class="gallery-section">
      <div class="section-head"><h2>Activity 작업 카드</h2><span>대표 상태</span></div>
      <div class="gallery-grid gallery-activity">
        <article class="card status-blue"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title">승인 UX 수정</div><span class="start-time">10:42</span><span class="status blue">작업 중</span></div></article>
        <article class="card status-orange"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title">런타임 교체</div><span class="start-time">10:44</span><span class="status orange">승인 대기</span></div></article>
        <article class="card status-green"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title">전체 테스트</div><span class="start-time">10:46</span><span class="status green">완료</span></div></article>
        <article class="card status-red"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title">도구 호출</div><span class="start-time">10:47</span><span class="status red">실패</span></div></article>
        <article class="card status-gray"><div class="card-primary"><span class="project-badge">chatgpt2codex</span><div class="title provisional">이전 실패 기록</div><span class="start-time">09:12</span><span class="status gray">이전 실패</span></div></article>
      </div>
    </section>
  </section>
</main>
<script>
(function () {
  var pageDashboardRevision = "__C2CT_ACTIVITY_DASHBOARD_REVISION__";
  var initialParams = new URLSearchParams(window.location.search);
  var selectedView = initialParams.get("view") === "cards" ? "cards" : "activity";
  var selectedProject = "all";
  var latest = [];
  var latestApprovals = [];
  var latestDeployments = [];
  var latestMcpHealth = null;
  var latestWidgetLoads = [];
  var expandedToolRequestChats = new Set();
  var expandedOperationDetails = new Set();
  var lastFilterSignature = "";
  var reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var embeddedHint = initialParams.get("embedded") === "mac";
  if (embeddedHint) document.documentElement.classList.add("embedded-mac");
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
  var liveDot = document.getElementById("live-dot");
  var liveText = document.getElementById("live-text");
  var activityView = document.getElementById("activity-view");
  var galleryView = document.getElementById("gallery-view");
  var activityViewButton = document.getElementById("view-activity");
  var galleryViewButton = document.getElementById("view-gallery");

  function setDashboardView(nextView, updateLocation) {
    selectedView = nextView === "cards" ? "cards" : "activity";
    activityView.hidden = selectedView !== "activity";
    galleryView.hidden = selectedView !== "cards";
    activityViewButton.classList.toggle("active", selectedView === "activity");
    galleryViewButton.classList.toggle("active", selectedView === "cards");
    activityViewButton.setAttribute("aria-pressed", selectedView === "activity" ? "true" : "false");
    galleryViewButton.setAttribute("aria-pressed", selectedView === "cards" ? "true" : "false");
    if (updateLocation && window.history && window.history.replaceState) {
      var url = new URL(window.location.href);
      if (selectedView === "cards") url.searchParams.set("view", "cards");
      else url.searchParams.delete("view");
      window.history.replaceState(null, "", url);
    }
  }
  activityViewButton.addEventListener("click", function () { setDashboardView("activity", true); });
  galleryViewButton.addEventListener("click", function () { setDashboardView("cards", true); });
  setDashboardView(selectedView, false);

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
      var detachedBase = op.activityHint || humanToolLabel(op.tool);
      return "ChatGPT 응답 연결 끊김 · 로컬 작업 계속 중 · " + detachedBase;
    }
    var base;
    if (op.activityHint) {
      base = op.activityHint;
    } else {
      var action = humanToolLabel(op.tool);
      var detail = chat.taskLabel || op.message || "";
      base = detail ? action + " · " + detail : action;
    }
    return op.state === "failed" ? (isHistoricalFailure(op, now) ? "이전 실패 · " : "실패 · ") + base : base;
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
    if (Number.isFinite(entry.finishedAt)) meta.push("완료 " + fmtClock(entry.finishedAt));
    if (Number.isFinite(entry.elapsedMs)) meta.push("소요 " + fmtDuration(entry.elapsedMs));
    if (entry.state) meta.push("상태 " + entry.state);
    if (entry.phase) meta.push("단계 " + entry.phase);
    if (entry.errorCode) meta.push("오류 " + entry.errorCode);
    if (historicalFailure) meta.push("구분 이전 실패");
    detail.appendChild(el("div", "activity-detail-meta", meta.join(" · ")));
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
        : (macCanDecide ? "Mac에서 바로 승인 가능" : "Mac에서 승인 필요");
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
        var detail = el("div", "approval-meta", macCanDecide ? "이 Mac에서 바로 처리 가능" : "이 화면에서 바로 처리 가능");
        row.appendChild(detail);
        var actions = el("div", "approval-actions");
        var approve = el("button", "approve", item.tool === "runtime_apply_local" ? "런타임 교체 허용" : "승인");
        var reject = el("button", "reject", "거절");
        approve.type = "button";
        reject.type = "button";
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
        var nativeButton = el("button", "native", "Mac 승인창 열기");
        nativeButton.type = "button";
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
  function renderWidgetLoads(items) {
    widgetLoadLabel.textContent = items.length + "건";
    if (!items.length) {
      widgetLoadBox.classList.add("hidden");
      widgetLoads.replaceChildren();
      return;
    }
    widgetLoadBox.classList.remove("hidden");
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
    mcpHealthMeta.appendChild(el("span", "", "최근 실패 " + (health.recentFailureCount || 0)));
    mcpHealthMeta.appendChild(el("span", "", "transport " + (health.recentTransportFailureCount || 0)));
    mcpHealthMeta.appendChild(el("span", "", "watchdog " + (health.watchdogStatus || "unknown")));
    if (Number.isFinite(health.watchdogProbeAgeMs)) mcpHealthMeta.appendChild(el("span", "", "probe " + age(now - health.watchdogProbeAgeMs, now)));
    mcpHealthEvents.replaceChildren();
    var events = Array.isArray(health.events) ? health.events.slice().reverse() : [];
    if (!events.length) {
      mcpHealthEvents.appendChild(el("div", "mcp-health-reason", "최근 내부 오류 없음"));
      return;
    }
    events.forEach(function (item) {
      var row = el("div", "mcp-health-event" + (item.outcome === "failure" ? " failure" : ""));
      row.appendChild(el("span", "mcp-health-event-time", fmtStartClock(Date.parse(item.at))));
      var parts = [item.event || "diagnostic"];
      if (item.tool) parts.push(item.tool);
      if (item.errorCode) parts.push(item.errorCode);
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

    var ops = (chat.operations || []).slice().reverse();
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
    renderWidgetLoads(latestWidgetLoads);
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
      liveDot.classList.toggle("offline", Boolean(latestMcpHealth && latestMcpHealth.state === "unhealthy"));
      liveText.textContent = latestMcpHealth
        ? "MCP " + (latestMcpHealth.label || latestMcpHealth.state) + " · " + age(payload.generatedAt || Date.now(), Date.now())
        : "갱신 " + age(payload.generatedAt || Date.now(), Date.now());
      render();
    } catch (error) {
      liveDot.classList.add("offline");
      liveText.textContent = "연결 끊김";
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
