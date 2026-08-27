import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redact } from "../policy/secrets.js";
import type { RuntimeActivityTracker, RuntimeConversationSummary } from "../runtime/activity.js";

const MAX_DASHBOARD_OPERATIONS = 12;
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
    operations: conversation.operations.slice(-MAX_DASHBOARD_OPERATIONS).map((operation) => ({
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

export function activityDashboardSnapshot(
  tracker: RuntimeActivityTracker,
  approvals: ActivityDashboardApproval[] = [],
  now = Date.now(),
  dashboardRevision = ACTIVITY_DASHBOARD_REVISION,
) {
  return {
    schemaVersion: 2,
    dashboardRevision,
    generatedAt: now,
    approvals: approvals.map(dashboardApproval),
    conversations: tracker.conversationSnapshot(now).map(dashboardConversation),
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
    .toolbar { display: flex; gap: 5px; overflow-x: auto; padding: 0 1px 9px; scrollbar-width: none; }
    .toolbar.hidden { display: none; }
    .toolbar::-webkit-scrollbar { display: none; }
    button.filter { appearance: none; border: 1px solid transparent; background: var(--panel2); color: var(--muted); border-radius: 999px; padding: 5px 9px; font-size: 10px; font-weight: 650; white-space: nowrap; transition: color var(--motion-fast) ease, background-color var(--motion-fast) ease, border-color var(--motion-fast) ease; }
    button.filter.active { color: var(--text); background: var(--panel); border-color: var(--line); }
    #cards { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 13px 14px; box-shadow: var(--shadow); min-width: 0; transition: box-shadow var(--motion-fast) ease, border-color var(--motion-fast) ease; }
    .card.active-card { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--blue) 72%, transparent), var(--shadow); }
    .card.stale-card { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--orange) 82%, transparent), var(--shadow); }
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
    .activity-time { flex: 0 0 40px; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 9.5px; }
    .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 620; }
    .activity-collapse-label { display: none; color: var(--muted); font-size: 10px; font-weight: 650; }
    .disclosure-indicator { position: absolute; right: 10px; top: 50%; color: var(--muted); font-size: 13px; transform: translateY(-50%) rotate(0deg); transition: transform var(--motion-fast) var(--motion-ease); }
    .activity-disclosure[open] > summary .activity-preview { display: none; }
    .activity-disclosure[open] > summary .activity-collapse-label { display: inline; }
    .activity-disclosure[open] > summary .disclosure-indicator { transform: translateY(-50%) rotate(180deg); }
    .activity-timeline { display: grid; gap: 2px; border-top: 1px solid var(--line); margin: 0 10px 8px; padding-top: 7px; }
    .activity-disclosure[open] .activity-timeline { animation: disclosure-in var(--motion-fast) var(--motion-ease); }
    .activity-entry { min-width: 0; border-radius: 7px; }
    .activity-line { cursor: pointer; padding: 4px 2px; outline: none; }
    .activity-line:focus-visible { box-shadow: 0 0 0 1px color-mix(in srgb, var(--blue) 65%, transparent); }
    .activity-detail { display: none; margin: 0 2px 7px 50px; color: var(--muted); font-size: 9.5px; line-height: 1.45; overflow-wrap: anywhere; }
    .activity-entry.detail-open .activity-detail { display: block; }
    .activity-detail-text { color: var(--text); margin-bottom: 2px; }
    .activity-detail-meta { font-variant-numeric: tabular-nums; }
    .empty { grid-column: 1/-1; text-align: center; color: var(--muted); padding: 44px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
    .footer { color: var(--muted); font-size: 9.5px; text-align: center; margin-top: 13px; opacity: .8; }
    @keyframes disclosure-in { from { opacity: .3; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
    }
    html.embedded-mac main { width: 100%; max-width: none; padding-top: 10px; }
    html.embedded-mac .footer { margin-bottom: 4px; }
    @media (max-width: 720px) {
      main { padding-left: 10px; padding-right: 10px; }
      header { gap: 8px; }
      .header-main { gap: 7px; }
      .app-mark { width: 34px; height: 34px; }
      .metric { padding-left: 6px; padding-right: 6px; }
      .metric b { font-size: 11px; }
      .metric span { font-size: 9px; }
      #cards { grid-template-columns: 1fr; }
      .card { border-radius: 13px; }
      .card-primary { grid-template-columns: auto minmax(0,1fr) auto auto; gap: 6px 7px; }
      .project-badge { max-width: 104px; }
      .title { font-size: 13px; }
      .status { padding-left: 6px; padding-right: 6px; }
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
  <section id="approval-box" class="approval-box hidden">
    <div class="section-head"><h2>승인 필요</h2><span id="approval-label">0건</span></div>
    <div id="approvals" class="approval-list"></div>
  </section>
  <nav id="filters" class="toolbar"></nav>
  <section id="cards"></section>
</main>
<script>
(function () {
  var pageDashboardRevision = "__C2CT_ACTIVITY_DASHBOARD_REVISION__";
  var selectedProject = "all";
  var latest = [];
  var latestApprovals = [];
  var expandedToolRequestChats = new Set();
  var expandedOperationDetails = new Set();
  var lastFilterSignature = "";
  var reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var embeddedHint = new URLSearchParams(window.location.search).get("embedded") === "mac";
  if (embeddedHint) document.documentElement.classList.add("embedded-mac");
  var macBridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.c2ctMacApp
    ? window.webkit.messageHandlers.c2ctMacApp
    : null;
  var cards = document.getElementById("cards");
  var filters = document.getElementById("filters");
  var approvals = document.getElementById("approvals");
  var approvalBox = document.getElementById("approval-box");
  var approvalLabel = document.getElementById("approval-label");
  var liveDot = document.getElementById("live-dot");
  var liveText = document.getElementById("live-text");

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
  var RECENT_COMPLETION_ACTIVE_MS = 15000;
  function statusOf(chat, now) {
    var state = String(chat.state || "idle").toLowerCase();
    var ageMs = Math.max(0, now - chat.lastActiveAt);
    var current = latestOperation(chat);
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
    if (state === "failed") return { key: "failed", text: "실패", color: "red", priority: 5 };
    if (state === "completed" || state === "success") {
      if (ageMs < RECENT_COMPLETION_ACTIVE_MS) return { key: "active", text: "작업 중", color: "blue", priority: 0 };
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
  function activitySummary(chat, op) {
    if (!op) return chat.taskLabel || "현재 작업 내용 확인 중";
    if (op.clientCancellation && op.clientCancellation.operationContinues) {
      var detachedBase = op.activityHint || humanToolLabel(op.tool);
      return "ChatGPT 응답 연결 끊김 · 로컬 작업 계속 중 · " + detachedBase;
    }
    if (op.activityHint) return op.activityHint;
    var action = humanToolLabel(op.tool);
    var detail = chat.taskLabel || op.message || "";
    return detail ? action + " · " + detail : action;
  }
  function makeActivityPreviewLine(chat, entry) {
    var text = activitySummary(chat, entry);
    var line = el("span", "activity-preview-line");
    line.appendChild(el("span", "activity-time", fmtStartClock(entry.startedAt)));
    var content = el("span", "activity-text", text);
    content.title = text;
    line.appendChild(content);
    return line;
  }
  function makeActivityEntry(chat, entry) {
    var text = activitySummary(chat, entry);
    var detailKey = String(entry.operationId || (cardKey(chat) + ":" + entry.startedAt + ":" + entry.tool));
    var wrapper = el("div", "activity-entry" + (expandedOperationDetails.has(detailKey) ? " detail-open" : ""));
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
    var meta = ["도구 " + entry.tool, "시작 " + fmtClock(entry.startedAt)];
    if (Number.isFinite(entry.finishedAt)) meta.push("완료 " + fmtClock(entry.finishedAt));
    if (entry.state) meta.push("상태 " + entry.state);
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
      var channelText = item.channel === "mobile"
        ? (item.canDecide ? "iPhone 승인 가능" : "Tailscale에서 승인")
        : "Mac에서 승인 필요";
      top.appendChild(el("div", "approval-channel " + (item.channel === "mobile" ? "mobile" : "mac"), channelText));
      row.appendChild(top);
      row.appendChild(el("div", "approval-summary", item.summary || "보호 작업 승인 요청"));
      var meta = el("div", "approval-meta");
      meta.appendChild(el("span", "", item.projectId || "project"));
      if (item.risk) meta.appendChild(el("span", "", riskLabel(item.risk)));
      meta.appendChild(el("span", "", "요청 " + age(item.createdAt, now)));
      meta.appendChild(el("span", "", "만료까지 " + Math.max(0, Math.ceil((item.expiresAt - now) / 1000)) + "초"));
      row.appendChild(meta);
      if (item.canDecide) {
        var detail = el("div", "approval-meta", "이 화면에서 바로 처리 가능");
        row.appendChild(detail);
        var actions = el("div", "approval-actions");
        var approve = el("button", "approve", "승인");
        var reject = el("button", "reject", "거절");
        approve.type = "button";
        reject.type = "button";
        var buttons = [approve, reject];
        approve.onclick = function () { void decideApproval(item, "approve", buttons, detail); };
        reject.onclick = function () { void decideApproval(item, "reject", buttons, detail); };
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
    var card = el("article", "card" + (st.key === "active" || st.key === "quiet" ? " active-card" : "") + (st.key === "stale" ? " stale-card" : ""));
    card.dataset.chatKey = cardKey(chat);
    card.dataset.statusKey = st.key;
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
      card.dataset.summary = previewOps.map(function (entry) { return activitySummary(chat, entry); }).join("\u001f");
      var details = document.createElement("details");
      details.className = "activity-disclosure";
      var disclosureKey = String(chat.id || "");
      details.open = disclosureKey ? expandedToolRequestChats.has(disclosureKey) : false;
      details.addEventListener("toggle", function () {
        if (!disclosureKey) return;
        if (details.open) expandedToolRequestChats.add(disclosureKey);
        else expandedToolRequestChats.delete(disclosureKey);
      });
      var summary = document.createElement("summary");
      var preview = el("span", "activity-preview");
      previewOps.forEach(function (entry) { preview.appendChild(makeActivityPreviewLine(chat, entry)); });
      summary.appendChild(preview);
      summary.appendChild(el("span", "activity-collapse-label", "접기"));
      summary.appendChild(el("span", "disclosure-indicator", "⌄"));
      details.appendChild(summary);
      var timeline = el("div", "activity-timeline");
      ops.forEach(function (entry) { timeline.appendChild(makeActivityEntry(chat, entry)); });
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
      previous.set(key, {
        rect: card.getBoundingClientRect(),
        summary: card.dataset.summary || "",
        statusKey: card.dataset.statusKey || ""
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
      if (Math.abs(dx) > .5 || Math.abs(dy) > .5 || Math.abs(sx - 1) > .01 || Math.abs(sy - 1) > .01) {
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
    });
  }
  function updateMetrics(chats, approvalItems, now) {
    var counts = { active: 0, attention: 0 };
    chats.forEach(function (chat) {
      var key = statusOf(chat, now).key;
      if (key === "active" || key === "quiet" || key === "detached") counts.active += 1;
      if (key === "stale" || key === "failed") counts.attention += 1;
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
      liveDot.classList.remove("offline");
      liveText.textContent = "갱신 " + age(payload.generatedAt || Date.now(), Date.now());
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
