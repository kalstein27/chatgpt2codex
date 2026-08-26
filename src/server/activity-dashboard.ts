import { createHash } from "node:crypto";
import { redact } from "../policy/secrets.js";
import type { RuntimeActivityTracker, RuntimeConversationSummary } from "../runtime/activity.js";

const MAX_DASHBOARD_OPERATIONS = 12;
const ACTIVITY_DASHBOARD_REVISION_TOKEN = "__C2CT_ACTIVITY_DASHBOARD_REVISION__";

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
) {
  return {
    schemaVersion: 2,
    dashboardRevision: ACTIVITY_DASHBOARD_REVISION,
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
  <title>C2CT 작업 및 승인</title>
  <style>
    :root {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Apple SD Gothic Neo", sans-serif;
      color-scheme: light dark;
      --bg: #f4f5f7;
      --panel: rgba(255,255,255,.92);
      --panel2: rgba(246,247,249,.95);
      --text: #161719;
      --muted: #6d7178;
      --line: rgba(0,0,0,.1);
      --blue: #0a84ff;
      --green: #2a9d55;
      --orange: #d97706;
      --red: #dc3545;
      --gray: #8b9097;
      --shadow: 0 8px 28px rgba(0,0,0,.07);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101113;
        --panel: rgba(29,30,33,.96);
        --panel2: rgba(36,37,40,.96);
        --text: #f5f5f7;
        --muted: #a2a5aa;
        --line: rgba(255,255,255,.1);
        --green: #43c46b;
        --orange: #ff9f0a;
        --red: #ff453a;
        --gray: #98989f;
        --shadow: 0 12px 36px rgba(0,0,0,.2);
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    main { width: min(1100px, 100%); margin: 0 auto; padding: max(18px, env(safe-area-inset-top)) 14px max(28px, env(safe-area-inset-bottom)); }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin: 4px 2px 14px; }
    h1 { font-size: 24px; line-height: 1.15; margin: 0 0 6px; letter-spacing: -.02em; }
    .subtitle { color: var(--muted); font-size: 13px; }
    .live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); white-space: nowrap; padding-top: 4px; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--green); box-shadow: 0 0 0 4px rgba(42,157,85,.12); }
    .dot.offline { background: var(--red); box-shadow: 0 0 0 4px rgba(220,53,69,.12); }
    .summary { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 8px; margin-bottom: 12px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 13px; padding: 10px 11px; box-shadow: var(--shadow); }
    .metric b { display: block; font-size: 20px; line-height: 1; margin-bottom: 5px; }
    .metric span { font-size: 11px; color: var(--muted); }
    .approval-box { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 13px; box-shadow: var(--shadow); margin-bottom: 12px; }
    .section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 9px; }
    .section-head h2 { font-size: 15px; margin: 0; }
    .section-head span { color: var(--muted); font-size: 11px; }
    .approval-list { display: grid; gap: 8px; }
    .approval-item { border: 1px solid var(--line); border-radius: 13px; background: var(--panel2); padding: 11px; }
    .approval-item.mobile { border-color: color-mix(in srgb, var(--blue) 45%, var(--line)); }
    .approval-item.mac { border-color: color-mix(in srgb, var(--orange) 55%, var(--line)); }
    .approval-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
    .approval-category { font-size: 13px; font-weight: 700; line-height: 1.35; }
    .approval-channel { flex: 0 0 auto; font-size: 10px; font-weight: 700; border-radius: 999px; padding: 4px 7px; background: var(--panel); }
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
    .approval-empty { color: var(--muted); font-size: 12px; padding: 5px 2px 2px; }
    .toolbar { display: flex; gap: 8px; overflow-x: auto; padding: 1px 1px 10px; scrollbar-width: none; }
    .toolbar::-webkit-scrollbar { display: none; }
    button.filter { appearance: none; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 999px; padding: 7px 11px; font-size: 12px; white-space: nowrap; }
    button.filter.active { border-color: var(--blue); color: var(--blue); background: color-mix(in srgb, var(--blue) 10%, var(--panel)); }
    #cards { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px; box-shadow: var(--shadow); min-width: 0; }
    .card.active-card { border-color: color-mix(in srgb, var(--blue) 55%, var(--line)); }
    .card.stale-card { border-color: color-mix(in srgb, var(--orange) 62%, var(--line)); }
    .card-meta-row { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; margin-bottom: 9px; min-width: 0; }
    .project-row { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
    .project-badge { display: inline-flex; align-items: center; min-height: 27px; border-radius: 9px; padding: 5px 9px; border: 1px solid color-mix(in srgb, var(--blue) 48%, var(--line)); background: color-mix(in srgb, var(--blue) 10%, var(--panel2)); color: var(--blue); font-size: 12px; font-weight: 800; letter-spacing: .01em; }
    .project-badge.none { border-color: var(--line); background: var(--panel2); color: var(--muted); }
    .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
    .title { font-size: 16px; font-weight: 700; line-height: 1.35; min-width: 0; overflow-wrap: anywhere; }
    .title.provisional { color: var(--muted); }
    .status { flex: 0 0 auto; display: inline-flex; align-items: center; min-height: 25px; border-radius: 999px; padding: 4px 8px; background: var(--panel2); font-size: 11px; font-weight: 800; white-space: nowrap; }
    .status.blue { color: var(--blue); }
    .status.green { color: var(--green); }
    .status.orange { color: var(--orange); }
    .status.red { color: var(--red); }
    .status.gray { color: var(--gray); }
    .meta { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 4px 8px; color: var(--muted); font-size: 10px; text-align: right; }
    .current { margin-top: 10px; padding: 10px 11px; border-radius: 12px; background: var(--panel2); }
    .current .summary-line { font-size: 12px; font-weight: 650; line-height: 1.45; overflow-wrap: anywhere; }
    details { border-top: 1px solid var(--line); margin-top: 11px; padding-top: 9px; }
    summary { cursor: pointer; color: var(--muted); font-size: 12px; user-select: none; }
    .timeline { margin-top: 9px; display: grid; gap: 7px; }
    .op { display: grid; grid-template-columns: 58px minmax(0,1fr); gap: 8px; font-size: 11px; line-height: 1.35; }
    .op-time { color: var(--muted); font-variant-numeric: tabular-nums; }
    .op-body { min-width: 0; overflow-wrap: anywhere; }
    .op-body b { font-weight: 650; }
    .op-hint { color: var(--muted); margin-left: 5px; }
    .empty { grid-column: 1/-1; text-align: center; color: var(--muted); padding: 44px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
    .footer { color: var(--muted); font-size: 10px; text-align: center; margin-top: 14px; }
    html.embedded-mac main { width: 100%; max-width: none; padding-top: 14px; }
    html.embedded-mac .footer { margin-bottom: 4px; }
    @media (max-width: 720px) {
      main { padding-left: 10px; padding-right: 10px; }
      h1 { font-size: 21px; }
      .summary { grid-template-columns: repeat(5, minmax(68px,1fr)); overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
      .metric { min-width: 72px; }
      #cards { grid-template-columns: 1fr; }
      .card { border-radius: 15px; }
      .card-meta-row { align-items: flex-start; }
      .meta { max-width: 58%; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>C2CT 작업 및 승인</h1>
      <div class="subtitle">ChatGPT 작업 현황과 승인 대기 항목을 한 화면에서 확인</div>
    </div>
    <div class="live"><span id="live-dot" class="dot"></span><span id="live-text">연결 중</span></div>
  </header>
  <section class="summary">
    <div class="metric"><b id="m-active">0</b><span>활성</span></div>
    <div class="metric"><b id="m-quiet">0</b><span>응답 대기</span></div>
    <div class="metric"><b id="m-stale">0</b><span>정체</span></div>
    <div class="metric"><b id="m-approval">0</b><span>승인 대기</span></div>
    <div class="metric"><b id="m-done">0</b><span>완료</span></div>
  </section>
  <section class="approval-box">
    <div class="section-head"><h2>승인함</h2><span id="approval-label">대기 0건</span></div>
    <div id="approvals" class="approval-list"></div>
  </section>
  <nav id="filters" class="toolbar"></nav>
  <section id="cards"></section>
  <div class="footer">작업 현황은 읽기 전용 · 기존 모바일 승인 정책에서 허용된 항목만 이 화면에서 승인/거절 가능</div>
</main>
<script>
(function () {
  var pageDashboardRevision = "__C2CT_ACTIVITY_DASHBOARD_REVISION__";
  var selectedProject = "all";
  var latest = [];
  var latestApprovals = [];
  var expandedToolRequestChats = new Set();
  var embeddedHint = new URLSearchParams(window.location.search).get("embedded") === "mac";
  if (embeddedHint) document.documentElement.classList.add("embedded-mac");
  var macBridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.c2ctMacApp
    ? window.webkit.messageHandlers.c2ctMacApp
    : null;
  var cards = document.getElementById("cards");
  var filters = document.getElementById("filters");
  var approvals = document.getElementById("approvals");
  var approvalLabel = document.getElementById("approval-label");
  var liveDot = document.getElementById("live-dot");
  var liveText = document.getElementById("live-text");

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function fmtClock(ms) {
    if (!ms) return "-";
    return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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
    approvalLabel.textContent = "대기 " + items.length + "건";
    approvals.replaceChildren();
    if (!items.length) {
      approvals.appendChild(el("div", "approval-empty", "현재 대기 중인 승인이 없습니다."));
      return;
    }
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
    filters.replaceChildren();
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
    var projects = projectSet(chat);
    var metaRow = el("div", "card-meta-row");
    var projectRow = el("div", "project-row");
    if (projects.length) {
      projects.forEach(function (project) { projectRow.appendChild(el("span", "project-badge", project)); });
    } else {
      projectRow.appendChild(el("span", "project-badge none", "프로젝트 미확인"));
    }
    metaRow.appendChild(projectRow);
    var meta = el("div", "meta");
    meta.appendChild(el("span", "", "첫 요청 " + fmtClock(chat.firstSeenAt)));
    meta.appendChild(el("span", "", "마지막 활동 " + age(chat.lastActiveAt, now)));
    metaRow.appendChild(meta);
    card.appendChild(metaRow);
    var head = el("div", "card-head");
    head.appendChild(el("div", "title" + (chat.titleSource === "missing" ? " provisional" : ""), chat.title || "채팅 이름 필요"));
    head.appendChild(el("div", "status " + st.color, st.text));
    card.appendChild(head);

    var op = latestOperation(chat);
    if (op) {
      var current = el("div", "current");
      var summaryLine = el("div", "summary-line", activitySummary(chat, op));
      summaryLine.title = activitySummary(chat, op);
      current.appendChild(summaryLine);
      card.appendChild(current);
    }

    var ops = (chat.operations || []).slice().reverse();
    if (ops.length) {
      var details = document.createElement("details");
      var disclosureKey = String(chat.id || "");
      details.open = disclosureKey ? expandedToolRequestChats.has(disclosureKey) : false;
      details.addEventListener("toggle", function () {
        if (!disclosureKey) return;
        if (details.open) expandedToolRequestChats.add(disclosureKey);
        else expandedToolRequestChats.delete(disclosureKey);
      });
      var summary = document.createElement("summary");
      summary.textContent = "최근 도구 요청 " + ops.length + "개";
      details.appendChild(summary);
      var timeline = el("div", "timeline");
      ops.forEach(function (entry) {
        var row = el("div", "op");
        row.appendChild(el("div", "op-time", fmtClock(entry.startedAt)));
        var body = el("div", "op-body");
        body.appendChild(el("b", "", entry.tool));
        var hint = entry.activityHint || entry.message || entry.phase;
        if (hint) body.appendChild(el("span", "op-hint", hint));
        row.appendChild(body);
        timeline.appendChild(row);
      });
      details.appendChild(timeline);
      card.appendChild(details);
    }
    return card;
  }
  function updateMetrics(chats, approvalItems, now) {
    var counts = { active: 0, quiet: 0, stale: 0, approval: 0, done: 0 };
    chats.forEach(function (chat) {
      var key = statusOf(chat, now).key;
      if (counts[key] !== undefined) counts[key] += 1;
      if (key === "failed" || key === "idle") counts.done += 1;
    });
    document.getElementById("m-active").textContent = counts.active;
    document.getElementById("m-quiet").textContent = counts.quiet;
    document.getElementById("m-stale").textContent = counts.stale;
    document.getElementById("m-approval").textContent = approvalItems.length;
    document.getElementById("m-done").textContent = counts.done;
  }
  function render() {
    var now = Date.now();
    updateMetrics(latest, latestApprovals, now);
    renderApprovals(latestApprovals, now);
    renderFilters(latest);
    var visible = latest.filter(function (chat) {
      return selectedProject === "all" || projectSet(chat).indexOf(selectedProject) >= 0;
    }).slice().sort(function (a, b) {
      var sa = statusOf(a, now), sb = statusOf(b, now);
      return sa.priority - sb.priority || b.lastActiveAt - a.lastActiveAt;
    });
    cards.replaceChildren();
    if (!visible.length) {
      cards.appendChild(el("div", "empty", "표시할 채팅 작업이 없습니다."));
      return;
    }
    visible.forEach(function (chat) { cards.appendChild(makeCard(chat, now)); });
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
