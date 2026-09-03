import { CHATGPT_WIDGET_SHELL_COMPAT_PREFIX } from "../exec/chatgpt-widget-shell.js";

export const CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION = 13;
export const CHATGPT_OPERATION_APPROVAL_PRESENTER_TOOL =
  `chatgpt_operation_approval_presenter_v${CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION}`;
export const CHATGPT_OPERATION_APPROVAL_WIDGET_URI =
  `ui://widget/c2ct-operation-approval-v${CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION}.html`;
export const CHATGPT_OPERATION_APPROVAL_WIDGET_RESOURCE_NAME =
  `c2ct-operation-approval-widget-v${CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION}`;

// One final cache-boundary bump introduces the stable hot-loader resource. Once
// this generation is mounted, UI-only card changes are delivered through the
// state-dir widget asset and no longer require presenter URI churn.
export const CHATGPT_CONSENT_WIDGET_URI = "ui://widget/c2ct-consent-v7.html";
export const CHATGPT_CONSENT_WIDGET_LAB_VERSION = 9;
export const CHATGPT_CONSENT_WIDGET_LAB_URI = `ui://widget/c2ct-consent-v${CHATGPT_CONSENT_WIDGET_LAB_VERSION}.html`;
export const CHATGPT_CONSENT_WIDGET_MIME = "text/html;profile=mcp-app";
export const CHATGPT_CONSENT_META_KEY = "chatgpt2codex/consent";
export const CHATGPT_WIDGET_ASSET_PROTOCOL_VERSION = 1;
export const CHATGPT_WIDGET_ASSET_GET_TOOL = "chatgpt_widget_asset_get";
export function chatGptWidgetSessionId(requestId: string): string {
  return `c2ct-approval-${requestId}`;
}
export const CHATGPT_CONSENT_WIDGET_RESOURCE_META = {
  "openai/widgetDescription": "Shared C2CT harmless confirmation and widget interaction surface.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
  ui: {
    prefersBorder: true,
    csp: { connectDomains: [], resourceDomains: [] },
  },
} as const;

export const CHATGPT_CONSENT_WIDGET_LOADER_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { box-sizing: border-box; padding: 10px 12px; font-family: -apple-system, system-ui, sans-serif; color: #111827; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f5; } }
  #status { font-size: 12px; line-height: 1.45; opacity: .68; }
</style>
</head>
<body>
<div id="status">C2CT 카드 로딩 중…</div>
<script>
(function () {
  var pending = new Map();
  var nextId = 1;
  function structured(result) {
    if (!result || typeof result !== "object") return {};
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    return result;
  }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
    });
  }
  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0" || message.id === undefined || !pending.has(message.id)) return;
    var waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(message.error);
    else waiter.resolve(message.result);
  }, { passive: true });
  function withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error("widget asset bridge timeout")); }, timeoutMs);
      })
    ]);
  }
  async function loadThroughMcpApps() {
    var initialized = await request("ui/initialize", {
      appInfo: { name: "C2CT Widget Loader", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26"
    });
    notify("ui/notifications/initialized", {});
    var capabilities = initialized && initialized.hostCapabilities ? initialized.hostCapabilities : {};
    if (!capabilities.serverTools) throw new Error("MCP Apps serverTools unavailable");
    return request("tools/call", { name: "${CHATGPT_WIDGET_ASSET_GET_TOOL}", arguments: {} });
  }
  async function load() {
    var result;
    try {
      result = await withTimeout(loadThroughMcpApps(), 1800);
    } catch (_) {
      var a = window.openai || {};
      if (typeof a.callTool !== "function") throw _;
      result = await a.callTool("${CHATGPT_WIDGET_ASSET_GET_TOOL}", {});
    }
    var out = structured(result);
    if (typeof out.html !== "string" || !out.html) throw new Error("widget asset HTML unavailable");
    document.open();
    document.write(out.html);
    document.close();
  }
  void load().catch(function () {
    var status = document.getElementById("status");
    if (status) status.textContent = "C2CT 카드 asset을 불러오지 못했습니다. presenter/runtime 상태를 다시 확인해줘.";
  });
})();
</script>
</body>
</html>`;

export const CHATGPT_CONSENT_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { display: none; box-sizing: border-box; padding: 6px 4px 4px; font-family: -apple-system, system-ui, sans-serif; color: #111827; overflow: visible; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f5; } }
  .card { box-sizing: border-box; border: 1px solid rgba(128,128,128,.35); border-radius: 12px; padding: 14px; margin: 0; color: inherit; background: transparent; }
  .card.critical { border-color: rgba(220,72,48,.78); background: rgba(220,72,48,.08); box-shadow: inset 0 0 0 1px rgba(220,72,48,.12); }
  .title-row { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; margin-bottom: 10px; }
  .title { min-width: 0; font-weight: 650; font-size: 15px; line-height: 1.35; padding-top: 1px; }
  .title-state { flex: none; font-size: 12px; font-weight: 650; line-height: 1.35; padding-top: 2px; opacity: .78; white-space: nowrap; }
  .critical-badge { display: inline-block; margin-bottom: 9px; border: 1px solid rgba(220,72,48,.72); border-radius: 999px; padding: 4px 8px; font-size: 11px; font-weight: 750; letter-spacing: .01em; }
  .critical-warning { margin-bottom: 10px; border-radius: 9px; padding: 10px 11px; background: rgba(220,72,48,.12); font-size: 12px; font-weight: 620; line-height: 1.48; }
  .critical-meta { margin: 9px 0 2px; border-top: 1px solid rgba(220,72,48,.28); padding-top: 8px; font-size: 11px; line-height: 1.5; }
  .critical-meta-row { display: flex; gap: 8px; justify-content: space-between; }
  .critical-meta-key { opacity: .68; }
  .critical-meta-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 650; text-align: right; }
  .entry-head { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; }
  .preview { min-width: 0; font-size: 13px; font-weight: 620; line-height: 1.45; white-space: pre-wrap; }
  .state { flex: none; font-size: 12px; font-weight: 650; opacity: .78; white-space: nowrap; }
  .impact { margin-top: 7px; font-size: 12px; line-height: 1.45; opacity: .74; }
  .approval-details { margin-top: 10px; border-top: 1px solid rgba(128,128,128,.24); padding-top: 8px; }
  .approval-details summary { cursor: pointer; user-select: none; font-size: 12px; font-weight: 620; opacity: .78; }
  .detail-command { box-sizing: border-box; max-height: 220px; overflow: auto; margin-top: 8px; padding: 9px 10px; border-radius: 8px; background: rgba(128,128,128,.10); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; margin-top: 10px; }
  button { flex: 1; min-height: 38px; border-radius: 9px; border: 1px solid rgba(128,128,128,.35); background: #f8fafc; color: #0a63c9; font: inherit; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button { background: rgba(255,255,255,.08); color: #62a9ff; } }
  button.critical-allow { border-color: rgba(220,72,48,.85); background: rgba(220,72,48,.16); font-weight: 760; }
  button:disabled { opacity: .5; cursor: default; }
  .status { font-size: 12px; opacity: .72; margin-top: 7px; }
  .shell-prompt { font-size: 13px; line-height: 1.5; opacity: .86; white-space: pre-wrap; }
  .shell-options { display: grid; gap: 8px; margin-top: 11px; }
  .shell-option { display: block; width: 100%; min-height: 48px; padding: 9px 11px; text-align: left; background: transparent; color: inherit; }
  .shell-option-title { display: block; font-size: 13px; font-weight: 650; line-height: 1.35; }
  .shell-option-description { display: block; margin-top: 3px; font-size: 11px; line-height: 1.35; opacity: .65; }
  .lab-subtitle { margin-top: -4px; margin-bottom: 3px; font-size: 12px; line-height: 1.4; opacity: .7; }
  .lab-version { margin-bottom: 10px; font-size: 10px; line-height: 1.4; opacity: .58; overflow-wrap: anywhere; }
  .lab-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
  .lab-tab { flex: 1; min-height: 34px; border-radius: 8px; border: 1px solid rgba(128,128,128,.3); background: transparent; color: inherit; font: inherit; font-size: 12px; }
  .lab-tab[aria-selected="true"] { font-weight: 700; background: rgba(128,128,128,.14); }
  .lab-pane { display: none; }
  .lab-pane.active { display: block; }
  .lab-grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px 10px; align-items: baseline; }
  .lab-key { font-size: 12px; opacity: .68; }
  .lab-value { max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; text-align: right; }
  .lab-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .lab-badge { border: 1px solid rgba(128,128,128,.3); border-radius: 999px; padding: 4px 7px; font-size: 11px; opacity: .82; }
  .lab-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .lab-action { min-height: 40px; border-radius: 9px; border: 1px solid rgba(128,128,128,.35); color: inherit; background: transparent; font: inherit; }
  .lab-note { font-size: 12px; line-height: 1.45; opacity: .72; margin-bottom: 10px; }
  .lab-secret-row { display: flex; gap: 8px; }
  .lab-secret-row input { min-width: 0; flex: 1; min-height: 40px; box-sizing: border-box; border: 1px solid rgba(128,128,128,.35); border-radius: 9px; padding: 0 10px; background: transparent; color: inherit; font: inherit; }
  .lab-secret-row button { flex: none; min-height: 40px; border-radius: 9px; border: 1px solid rgba(128,128,128,.35); color: inherit; background: transparent; font: inherit; }
</style>
</head>
<body>
<div class="card">
  <div class="title-row">
    <div class="title" id="card-title">C2CT 확인</div>
    <div class="title-state" id="card-title-state"></div>
  </div>
  <div id="approval"></div>
  <div id="shell" hidden>
    <div class="shell-prompt" id="shell-prompt"></div>
    <div class="shell-options" id="shell-options"></div>
    <div class="status" id="shell-status"></div>
  </div>
  <div id="lab" hidden>
    <div class="lab-subtitle">안전한 인라인 위젯 기능 실험 · Lab v1</div>
    <div class="lab-version" id="lab-version">Lab v1 · UI v${CHATGPT_CONSENT_WIDGET_LAB_VERSION} · Server UI unknown · RT unknown</div>
    <div class="lab-tabs" role="tablist">
      <button class="lab-tab" data-lab-tab="host" aria-selected="true">Host</button>
      <button class="lab-tab" data-lab-tab="actions" aria-selected="false">Actions</button>
      <button class="lab-tab" data-lab-tab="secret" aria-selected="false">Secret</button>
    </div>
    <section class="lab-pane active" data-lab-pane="host">
      <div class="lab-grid" id="lab-host-grid"></div>
      <div class="lab-badges" id="lab-host-badges"></div>
    </section>
    <section class="lab-pane" data-lab-pane="actions">
      <div class="lab-actions">
        <button class="lab-action" id="lab-server-ping">Server ping</button>
        <button class="lab-action" id="lab-follow-up">Follow-up</button>
        <button class="lab-action" id="lab-fullscreen">Fullscreen</button>
        <button class="lab-action" id="lab-approval-demo">Approval probe</button>
      </div>
      <div class="status" id="lab-action-status"></div>
    </section>
    <section class="lab-pane" data-lab-pane="secret">
      <div class="lab-note">테스트 문자열은 app-only callback으로만 전달되고 모델 출력, follow-up, widget state, 브라우저 저장소에는 기록하지 않습니다. 권장 테스트값: banana-7291-test</div>
      <div class="lab-secret-row">
        <input id="lab-secret-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="banana-7291-test">
        <button id="lab-secret-send">Relay</button>
      </div>
      <div class="status" id="lab-secret-status"></div>
    </section>
  </div>
</div>
<script>
(function () {
  var latestToolOutput = null;
  var latestToolMeta = null;
  var pendingRequests = new Map();
  var nextRequestId = 1;
  var entry = null;
  var mcpAppsReady = null;
  var mcpHostCapabilities = null;
  var heightFrame = 0;
  var lastReportedHeight = 0;
  var presentationKind = null;
  var shellBusy = false;
  var statusRefreshInFlight = false;
  var statusRefreshedRequestId = null;
  var statusRefreshAttempts = Object.create(null);
  var hydrationExhausted = false;
  function api() { return window.openai || {}; }
  function output() { return latestToolOutput || api().toolOutput || {}; }
  function responseMeta() { return latestToolMeta || api().toolResponseMetadata || {}; }
  function request(method, params) {
    var id = nextRequestId++;
    return new Promise(function (resolve, reject) {
      pendingRequests.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
    });
  }
  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }
  function withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error("MCP Apps bridge timeout")); }, timeoutMs);
      })
    ]);
  }
  function ensureMcpAppsReady() {
    if (mcpAppsReady) return mcpAppsReady;
    mcpAppsReady = request("ui/initialize", {
      appInfo: { name: "C2CT Approval", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26"
    }).then(function (result) {
      mcpHostCapabilities = result && result.hostCapabilities ? result.hostCapabilities : {};
      notify("ui/notifications/initialized", {});
      return mcpHostCapabilities;
    }).catch(function (error) {
      mcpAppsReady = null;
      throw error;
    });
    return mcpAppsReady;
  }
  async function sendFollowUpTurn(prompt) {
    try {
      // Prefer the MCP Apps standard messaging path. On iOS the legacy
      // window.openai.sendFollowUpMessage compatibility API can resolve without
      // creating a new conversation turn, while ui/message is the standard path.
      await withTimeout(ensureMcpAppsReady(), 1200);
      notify("ui/message", {
        role: "user",
        content: [{ type: "text", text: prompt }]
      });
      return true;
    } catch (_) {
      // Compatibility fallback for hosts that do not expose the MCP Apps bridge.
    }
    var a = api();
    if (typeof a.sendFollowUpMessage === "function") {
      try {
        await a.sendFollowUpMessage({ prompt: prompt });
        return true;
      } catch (_) {}
    }
    return false;
  }
  function reportIntrinsicHeight() {
    heightFrame = 0;
    if (document.body.style.display === "none") return;
    var card = document.querySelector(".card");
    if (!card) return;
    var bodyStyle = getComputedStyle(document.body);
    var paddingBottom = parseFloat(bodyStyle.paddingBottom || "0") || 0;
    var height = Math.ceil(card.getBoundingClientRect().bottom + paddingBottom);
    if (!Number.isFinite(height) || height <= 0 || Math.abs(height - lastReportedHeight) < 1) return;
    lastReportedHeight = height;
    var a = api();
    if (typeof a.notifyIntrinsicHeight === "function") a.notifyIntrinsicHeight(height);
    if (mcpAppsReady) {
      void mcpAppsReady.then(function () {
        notify("ui/notifications/size-changed", { height: height });
      }).catch(function () {});
    }
  }
  function scheduleIntrinsicHeight() {
    if (heightFrame) cancelAnimationFrame(heightFrame);
    heightFrame = requestAnimationFrame(reportIntrinsicHeight);
  }
  function secret() {
    return responseMeta()["${CHATGPT_CONSENT_META_KEY}"] || {};
  }
  function structured(result) {
    if (!result || typeof result !== "object") return {};
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    return result;
  }
  function bridgeFailureTag(error) {
    if (!error || typeof error !== "object") return typeof error === "string" ? "string-error" : "unknown";
    var name = typeof error.name === "string"
      ? error.name.replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 40)
      : "Error";
    var rawCode = error.code !== undefined ? error.code : error.status;
    var code = typeof rawCode === "string" || typeof rawCode === "number"
      ? String(rawCode).replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 40)
      : "";
    return code ? name + ":" + code : name;
  }
  function bridgeFailureError(mcpState, mcpError, openaiState, openaiError) {
    var message = "bridge 진단 · MCP " + mcpState;
    if (mcpError) message += " (" + bridgeFailureTag(mcpError) + ")";
    message += " · OpenAI " + openaiState;
    if (openaiError) message += " (" + bridgeFailureTag(openaiError) + ")";
    return new Error(message);
  }
  async function callServerTool(name, args) {
    var a = api();
    var mcpState = "initialize-not-attempted";
    var mcpError = null;
    try {
      var capabilities = await withTimeout(ensureMcpAppsReady(), 2500);
      if (capabilities && capabilities.serverTools) {
        mcpState = "tools/call";
        try {
          // Regression guard: keep this await. On 2026-08-31 iOS, returning the
          // Promise directly skipped this catch on async rejection and silently
          // prevented the OpenAI bridge fallback from running.
          return await request("tools/call", { name: name, arguments: args || {} });
        } catch (error) {
          mcpState = "tools/call-rejected";
          mcpError = error;
        }
      } else {
        mcpState = "serverTools-unavailable";
      }
    } catch (error) {
      mcpState = "initialize-rejected";
      mcpError = error;
    }
    if (a.callTool) {
      try {
        // Keep await here too so a rejected OpenAI fallback can be classified
        // separately from the MCP Apps failure instead of collapsing to one UI error.
        return await a.callTool(name, args || {});
      } catch (error) {
        throw bridgeFailureError(mcpState, mcpError, "callTool-rejected", error);
      }
    }
    throw bridgeFailureError(mcpState, mcpError, "callTool-unavailable", null);
  }
  function stateLabel(status) {
    if (status === "allowed") return "허용됨";
    if (status === "denied") return "거절됨";
    if (status === "consumed") return "처리 완료";
    if (status === "expired") return "만료됨";
    if (status === "unavailable") return "확인 불가";
    if (status === "working") return "처리 중…";
    if (status === "error") return "처리 실패";
    return "승인 대기";
  }
  function mapPersistedStatus(status) {
    if (status === "approved" || status === "allowed") return "allowed";
    if (status === "rejected" || status === "denied") return "denied";
    if (status === "consumed") return "consumed";
    if (status === "expired") return "expired";
    return "pending";
  }
  function persistedStatusMessage(status) {
    if (status === "allowed") return "이 승인은 처리되었습니다.";
    if (status === "denied") return "이 승인은 거절되었습니다.";
    if (status === "consumed") return "승인된 작업이 이미 처리되었습니다.";
    if (status === "expired") return "이 승인은 만료되었습니다.";
    return "";
  }
  function restoredWidgetDecision(requestId) {
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctApprovalDecision;
    if (!saved || typeof saved !== "object" || saved.requestId !== requestId) return null;
    var mapped = mapPersistedStatus(saved.status);
    return mapped === "pending" ? null : mapped;
  }
  async function persistWidgetDecision(requestId, status) {
    if (status === "pending" || status === "working" || status === "error" || status === "unavailable") return;
    var a = api();
    if (typeof a.setWidgetState !== "function") return;
    var current = a.widgetState && typeof a.widgetState === "object" && !Array.isArray(a.widgetState)
      ? a.widgetState
      : {};
    var next = Object.assign({}, current, {
      c2ctApprovalDecision: {
        version: 1,
        requestId: requestId,
        status: status,
        updatedAt: Date.now()
      }
    });
    try {
      await a.setWidgetState(next);
    } catch (_) {
      // Server persisted status remains the source-of-truth fallback.
    }
  }
  function restoredShellChoice(cardId) {
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctShellChoice;
    if (!saved || typeof saved !== "object" || saved.cardId !== cardId || saved.status !== "resolved") return null;
    if (typeof saved.choiceId !== "string" || !saved.choiceId) return null;
    return saved;
  }
  async function persistShellChoice(card, choiceId, receiptId) {
    var a = api();
    if (typeof a.setWidgetState !== "function") return;
    var current = a.widgetState && typeof a.widgetState === "object" && !Array.isArray(a.widgetState)
      ? a.widgetState
      : {};
    var matched = (Array.isArray(card.options) ? card.options : []).find(function (option) { return option.id === choiceId; });
    var next = Object.assign({}, current, {
      c2ctShellChoice: {
        version: 1,
        cardId: card.cardId,
        choiceId: choiceId,
        choiceLabel: matched && matched.label ? matched.label : choiceId,
        receiptId: receiptId,
        status: "resolved",
        updatedAt: Date.now()
      }
    });
    try {
      await a.setWidgetState(next);
    } catch (_) {
      // The server receipt remains the source-of-truth if widget state persistence fails.
    }
  }
  function maybeRefreshPersistedStatus() {
    if (!entry || presentationKind === "widget-capability-lab" || presentationKind === "widget-shell-choice") return;
    if (entry.status !== "pending" && entry.status !== "error") return;
    if (statusRefreshedRequestId === entry.requestId || statusRefreshInFlight) return;
    var attempts = statusRefreshAttempts[entry.requestId] || 0;
    if (attempts >= 3) return;
    var requestId = entry.requestId;
    var token = entry.token;
    statusRefreshAttempts[requestId] = attempts + 1;
    statusRefreshInFlight = true;
    void (async function () {
      try {
        var result;
        if (requestId.indexOf("op_") === 0 && token) {
          result = structured(await callServerTool(entry.decisionTool, {
            requestId: requestId,
            token: token,
            decision: "status"
          }));
        } else if (requestId.indexOf("consent_") === 0) {
          result = structured(await callServerTool("chatgpt_consent_probe_status", { requestId: requestId }));
        } else {
          return;
        }
        if (!entry || entry.requestId !== requestId) return;
        var mapped = mapPersistedStatus(result.status);
        statusRefreshedRequestId = requestId;
        entry.status = mapped;
        entry.message = persistedStatusMessage(mapped);
        if (mapped !== "pending") entry.token = null;
        if (mapped !== "pending") await persistWidgetDecision(requestId, mapped);
        render();
      } catch (_) {
        if (entry && entry.requestId === requestId) {
          var attemptCount = statusRefreshAttempts[requestId] || 0;
          if (attemptCount < 3) {
            setTimeout(maybeRefreshPersistedStatus, 300 * Math.max(1, attemptCount));
          } else {
            entry.status = "unavailable";
            entry.token = null;
            entry.message = "이 승인 카드는 상태를 확인할 수 없어 비활성화되었습니다. 새 승인 카드를 요청해줘.";
            render();
          }
        }
      } finally {
        statusRefreshInFlight = false;
      }
    })();
  }
  function syncCurrentRequest() {
    var out = output();
    presentationKind = out.presentationKind || null;
    if (presentationKind === "widget-capability-lab" || presentationKind === "widget-shell-choice") return;
    var sec = secret();
    if (!out.requestId) return;
    var restored = restoredWidgetDecision(out.requestId);
    if (!sec.token && !restored) return;
    if (!entry || entry.requestId !== out.requestId) {
      entry = {
        requestId: out.requestId,
        preview: out.summary || out.preview || "C2CT 작업 승인",
        impact: out.impact || "",
        details: out.details || "",
        approvalSeverity: out.approvalSeverity || "standard",
        criticalBadge: out.criticalBadge || "Mac 시스템 변경",
        criticalWarning: out.criticalWarning || "",
        criticalIdentityBefore: out.criticalIdentityBefore || "",
        criticalIdentityAfter: out.criticalIdentityAfter || "",
        criticalRollback: out.criticalRollback || "",
        decisionTool: out.decisionTool || "chatgpt_consent_probe_decide",
        allowFollowUpPrompt: out.allowFollowUpPrompt,
        denyFollowUpPrompt: out.denyFollowUpPrompt,
        token: restored ? null : sec.token,
        status: restored || "pending",
        message: restored ? persistedStatusMessage(restored) : ""
      };
      if (restored) {
        statusRefreshedRequestId = out.requestId;
        return;
      }
      maybeRefreshPersistedStatus();
      return;
    }
    if (restored) {
      entry.status = restored;
      entry.token = null;
      entry.message = persistedStatusMessage(restored);
      statusRefreshedRequestId = out.requestId;
      return;
    }
    if (entry.status === "pending" || entry.status === "error") {
      entry.preview = out.summary || out.preview || entry.preview;
      entry.impact = out.impact || entry.impact;
      entry.details = out.details || entry.details;
      entry.approvalSeverity = out.approvalSeverity || entry.approvalSeverity;
      entry.criticalBadge = out.criticalBadge || entry.criticalBadge;
      entry.criticalWarning = out.criticalWarning || entry.criticalWarning;
      entry.criticalIdentityBefore = out.criticalIdentityBefore || entry.criticalIdentityBefore;
      entry.criticalIdentityAfter = out.criticalIdentityAfter || entry.criticalIdentityAfter;
      entry.criticalRollback = out.criticalRollback || entry.criticalRollback;
      entry.decisionTool = out.decisionTool || entry.decisionTool;
      entry.allowFollowUpPrompt = out.allowFollowUpPrompt || entry.allowFollowUpPrompt;
      entry.denyFollowUpPrompt = out.denyFollowUpPrompt || entry.denyFollowUpPrompt;
      entry.token = sec.token;
      if (entry.status === "error") entry.status = "pending";
      maybeRefreshPersistedStatus();
    }
  }
  function renderShellChoice(out) {
    var card = out && out.card && out.card.kind === "choice" ? out.card : null;
    var prompt = document.getElementById("shell-prompt");
    var options = document.getElementById("shell-options");
    var status = document.getElementById("shell-status");
    options.replaceChildren();
    if (!card) {
      prompt.textContent = "표시할 선택 카드가 없습니다.";
      return;
    }
    var restored = restoredShellChoice(card.cardId);
    var resolved = card.status === "resolved" || Boolean(restored);
    prompt.textContent = card.prompt || "하나를 선택해줘.";
    (Array.isArray(card.options) ? card.options : []).forEach(function (option) {
      var button = document.createElement("button");
      button.className = "shell-option";
      button.disabled = shellBusy || resolved;
      var title = document.createElement("span");
      title.className = "shell-option-title";
      title.textContent = option.label || option.id || "선택";
      if (restored && restored.choiceId === option.id) title.textContent += " ✓";
      button.appendChild(title);
      if (option.description) {
        var description = document.createElement("span");
        description.className = "shell-option-description";
        description.textContent = option.description;
        button.appendChild(description);
      }
      button.addEventListener("click", function () { void submitShellChoice(option.id, button); });
      options.appendChild(button);
    });
    if (restored) {
      status.textContent = "✅ 선택 완료 · " + (restored.choiceLabel || restored.choiceId);
    } else if (!shellBusy) {
      status.textContent = "";
    }
  }
  async function submitShellChoice(choiceId, clickedButton) {
    if (shellBusy) return;
    var out = output();
    var card = out && out.card && out.card.kind === "choice" ? out.card : null;
    if (!card || !card.cardId || !choiceId) return;
    if (restoredShellChoice(card.cardId)) return;
    shellBusy = true;
    document.querySelectorAll(".shell-option").forEach(function (button) { button.disabled = true; });
    document.getElementById("shell-status").textContent = "후속 대화 요청 중…";
    var a = api();
    var followUpFailed = false;
    if (typeof a.sendFollowUpMessage === "function") {
      try {
        // Match the Capability Lab path that is proven to create a new iOS
        // conversation turn. Do not overlap this host request with the server
        // receipt call: iOS can silently drop the follow-up when both are in flight.
        await a.sendFollowUpMessage({
          prompt: "C2CT Widget Shell 선택 버튼을 눌렀어. cardId: " + card.cardId + ", choiceId: " + choiceId + ". chatgpt_widget_shell_result로 서버 결과를 확인하고 다음 단계를 진행해줘."
        });
      } catch (_) {
        followUpFailed = true;
      }
    } else {
      followUpFailed = true;
    }
    try {
      var result = structured(await callServerTool("chatgpt_widget_lab_action", {
        action: "secret-relay",
        secretValue: "${CHATGPT_WIDGET_SHELL_COMPAT_PREFIX}" + card.cardId + "|" + choiceId
      }));
      if (!result.ok || typeof result.receiptId !== "string") throw new Error("missing server receipt");
      await persistShellChoice(card, choiceId, result.receiptId);
      if (clickedButton) clickedButton.querySelector(".shell-option-title").textContent += " ✓";
      document.getElementById("shell-status").textContent = followUpFailed
        ? "✅ 선택 저장 완료 · 후속 대화 요청 실패"
        : "✅ 선택 저장 완료 · 후속 대화 요청 전송";
    } catch (_) {
      shellBusy = false;
      document.getElementById("shell-status").textContent = "❌ 선택을 처리하지 못했습니다. 다시 시도해줘.";
      document.querySelectorAll(".shell-option").forEach(function (button) { button.disabled = false; });
    }
    scheduleIntrinsicHeight();
  }
  function render() {
    syncCurrentRequest();
    var out = output();
    var labMode = presentationKind === "widget-capability-lab";
    var shellMode = presentationKind === "widget-shell-choice";
    // Keep the widget visible while iOS hydrates toolOutput/toolResponseMetadata.
    // Some iOS hosts mount the iframe before exposing the presenter result;
    // hiding body here leaves a permanent blank host frame if no later globals
    // event is delivered. A visible loading state plus bounded polling makes that
    // race recoverable and gives us observable evidence when hydration fails.
    document.body.style.display = "block";
    var cardNode = document.querySelector(".card");
    var criticalMode = Boolean(entry && entry.approvalSeverity === "critical" && !labMode && !shellMode);
    if (cardNode) cardNode.classList.toggle("critical", criticalMode);
    document.getElementById("card-title").textContent = shellMode
      ? ((out.card && out.card.title) || "C2CT 선택")
      : (labMode ? "C2CT Widget Capability Lab" : (criticalMode ? "⚠️ C2CT 고위험 승인" : "C2CT 확인"));
    document.getElementById("card-title-state").textContent =
      !labMode && !shellMode ? (entry ? stateLabel(entry.status) : (hydrationExhausted ? "확인 불가" : "")) : "";
    var approval = document.getElementById("approval");
    var shell = document.getElementById("shell");
    var lab = document.getElementById("lab");
    approval.replaceChildren();
    approval.hidden = labMode || shellMode;
    shell.hidden = !shellMode;
    lab.hidden = !labMode;
    if (shellMode) {
      renderShellChoice(out);
      scheduleIntrinsicHeight();
      return;
    }
    if (labMode) {
      renderLabVersion(out);
      renderLabHost();
      scheduleIntrinsicHeight();
      return;
    }
    if (!entry) {
      var loading = document.createElement("div");
      loading.className = "status";
      loading.textContent = hydrationExhausted
        ? "승인 정보를 불러오지 못했습니다. 이 카드는 실행에 사용할 수 없습니다. 새 승인 카드를 요청해줘."
        : "승인 정보를 불러오는 중…";
      approval.appendChild(loading);
      scheduleIntrinsicHeight();
      return;
    }
    if (criticalMode) {
      var badge = document.createElement("div");
      badge.className = "critical-badge";
      badge.textContent = entry.criticalBadge || "Mac 시스템 변경";
      approval.appendChild(badge);
      var warning = document.createElement("div");
      warning.className = "critical-warning";
      warning.textContent = entry.criticalWarning || "이 승인은 Mac의 실행 상태를 실제로 변경합니다. 요청 내용을 확인한 뒤 승인해줘.";
      approval.appendChild(warning);
      if (entry.criticalIdentityBefore || entry.criticalIdentityAfter || entry.criticalRollback) {
        var criticalMeta = document.createElement("div");
        criticalMeta.className = "critical-meta";
        if (entry.criticalIdentityBefore || entry.criticalIdentityAfter) {
          var identityRow = document.createElement("div");
          identityRow.className = "critical-meta-row";
          var identityKey = document.createElement("span");
          identityKey.className = "critical-meta-key";
          identityKey.textContent = "대상";
          var identityValue = document.createElement("span");
          identityValue.className = "critical-meta-value";
          identityValue.textContent = (entry.criticalIdentityBefore || "?") + " → " + (entry.criticalIdentityAfter || "?");
          identityRow.append(identityKey, identityValue);
          criticalMeta.appendChild(identityRow);
        }
        if (entry.criticalRollback) {
          var rollback = document.createElement("div");
          rollback.style.marginTop = "5px";
          rollback.textContent = "롤백: " + entry.criticalRollback;
          criticalMeta.appendChild(rollback);
        }
        approval.appendChild(criticalMeta);
      }
    }
    var head = document.createElement("div");
    head.className = "entry-head";
    var preview = document.createElement("div");
    preview.className = "preview";
    preview.textContent = entry.preview;
    head.append(preview);
    approval.appendChild(head);
    if (entry.impact) {
      var impact = document.createElement("div");
      impact.className = "impact";
      impact.textContent = "영향: " + entry.impact;
      approval.appendChild(impact);
    }
    if (entry.details && entry.details !== entry.preview) {
      var disclosure = document.createElement("details");
      disclosure.className = "approval-details";
      var disclosureTitle = document.createElement("summary");
      disclosureTitle.textContent = "상세 명령 및 파라미터 보기";
      var detailCommand = document.createElement("div");
      detailCommand.className = "detail-command";
      detailCommand.textContent = entry.details;
      disclosure.append(disclosureTitle, detailCommand);
      disclosure.addEventListener("toggle", scheduleIntrinsicHeight);
      approval.appendChild(disclosure);
    }
    if (entry.status === "pending" || entry.status === "working" || entry.status === "error") {
      var actions = document.createElement("div");
      actions.className = "actions";
      var deny = document.createElement("button");
      deny.textContent = "거절";
      var allow = document.createElement("button");
      allow.textContent = criticalMode ? "위험을 이해하고 승인" : "허용";
      if (criticalMode) allow.className = "critical-allow";
      var disabled = entry.status === "working";
      deny.disabled = disabled;
      allow.disabled = disabled;
      deny.addEventListener("click", function () { void decide(entry, "deny"); });
      allow.addEventListener("click", function () { void decide(entry, "allow"); });
      actions.append(deny, allow);
      approval.appendChild(actions);
    }
    if (entry.message) {
      var status = document.createElement("div");
      status.className = "status";
      status.textContent = entry.message;
      approval.appendChild(status);
    }
    scheduleIntrinsicHeight();
  }
  function scalar(value) {
    if (value === undefined || value === null || value === "") return "unknown";
    if (typeof value === "object") {
      try { return JSON.stringify(value); } catch (_) { return "object"; }
    }
    return String(value);
  }
  function shortIdentity(value) {
    if (typeof value !== "string" || !value) return "unknown";
    var normalized = value.indexOf("sha256:") === 0 ? value.slice(7) : value;
    return normalized.slice(0, 8);
  }
  function labText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value || "";
  }
  function renderLabVersion(out) {
    labText(
      "lab-version",
      "Lab v" + scalar((out && out.labVersion) || 1) +
        " · UI v${CHATGPT_CONSENT_WIDGET_LAB_VERSION}" +
        " · Server UI v" + scalar(out && out.presenterUiVersion) +
        " · RT " + scalar(out && out.runtimeVersion) + " " + shortIdentity(out && out.runtimeFingerprint) +
        " · schema " + shortIdentity(out && out.toolSchemaRevision)
    );
  }
  function renderLabHost() {
    var a = api();
    var rows = [
      ["theme", scalar(a.theme)],
      ["displayMode", scalar(a.displayMode)],
      ["locale", scalar(a.locale)],
      ["maxHeight", scalar(a.maxHeight)],
      ["safeArea", scalar(a.safeArea)],
      ["userAgent", scalar(a.userAgent || navigator.userAgent)]
    ];
    var grid = document.getElementById("lab-host-grid");
    grid.replaceChildren();
    rows.forEach(function (row) {
      var key = document.createElement("div");
      key.className = "lab-key";
      key.textContent = row[0];
      var value = document.createElement("div");
      value.className = "lab-value";
      value.textContent = row[1];
      grid.append(key, value);
    });
    var badges = document.getElementById("lab-host-badges");
    badges.replaceChildren();
    [
      ["callTool", typeof a.callTool === "function" || !!(mcpHostCapabilities && mcpHostCapabilities.serverTools)],
      ["follow-up", typeof a.sendFollowUpMessage === "function"],
      ["fullscreen", typeof a.requestDisplayMode === "function"],
      ["widgetState", typeof a.setWidgetState === "function"]
    ].forEach(function (item) {
      var badge = document.createElement("span");
      badge.className = "lab-badge";
      badge.textContent = (item[1] ? "✅ " : "❌ ") + item[0];
      badges.appendChild(badge);
    });
  }
  function selectLabTab(name) {
    document.querySelectorAll(".lab-tab").forEach(function (button) {
      button.setAttribute("aria-selected", button.getAttribute("data-lab-tab") === name ? "true" : "false");
    });
    document.querySelectorAll(".lab-pane").forEach(function (pane) {
      pane.classList.toggle("active", pane.getAttribute("data-lab-pane") === name);
    });
    scheduleIntrinsicHeight();
  }
  async function labServerPing() {
    labText("lab-action-status", "서버 callback 확인 중…");
    try {
      var result = structured(await callServerTool("chatgpt_widget_lab_action", { action: "ping" }));
      labText("lab-action-status", result.ok ? "✅ app-only server callback 도달" : "⚠️ callback 응답 확인 필요");
    } catch (error) {
      labText("lab-action-status", "❌ " + (error && error.message ? error.message : "server callback 실패"));
    }
    scheduleIntrinsicHeight();
  }
  async function labFollowUp() {
    var a = api();
    if (!a.sendFollowUpMessage) return labText("lab-action-status", "❌ follow-up API 미지원");
    try {
      await a.sendFollowUpMessage({ prompt: "C2CT Widget Capability Lab follow-up 테스트가 도착했어. 기능 확인만 짧게 알려줘." });
      labText("lab-action-status", "✅ follow-up 요청 전송");
    } catch (_) { labText("lab-action-status", "⚠️ follow-up 요청 실패"); }
  }
  async function labFullscreen() {
    var a = api();
    if (!a.requestDisplayMode) return labText("lab-action-status", "❌ fullscreen API 미지원");
    try {
      await a.requestDisplayMode({ mode: "fullscreen" });
      labText("lab-action-status", "✅ fullscreen 요청 전달");
    } catch (_) { labText("lab-action-status", "⚠️ fullscreen 요청 거절/실패"); }
  }
  async function labApprovalProbe() {
    labText("lab-action-status", "승인 primitive 호출 중…");
    try {
      var result = structured(await callServerTool("chatgpt_consent_probe", {}));
      labText("lab-action-status", "✅ approval primitive 생성 · " + scalar(result.requestId || "created"));
    } catch (_) { labText("lab-action-status", "❌ approval probe 실패"); }
  }
  async function labRelaySecret() {
    var input = document.getElementById("lab-secret-input");
    var secretValue = input.value;
    if (!secretValue) return labText("lab-secret-status", "테스트 문자열을 입력해줘.");
    input.value = "";
    labText("lab-secret-status", "app-only relay 확인 중…");
    try {
      var result = structured(await callServerTool("chatgpt_widget_lab_action", { action: "secret-relay", secretValue: secretValue }));
      secretValue = "";
      labText("lab-secret-status", "✅ plaintext 미반환 · length " + scalar(result.length) + (result.syntheticExampleMatched ? " · synthetic match ✅" : ""));
    } catch (_) {
      secretValue = "";
      labText("lab-secret-status", "❌ relay 실패 · 입력값은 표시하지 않음");
    }
    scheduleIntrinsicHeight();
  }
  async function callDecision(entry, decision) {
    var args = { requestId: entry.requestId, token: entry.token, decision: decision };
    var a = api();
    try {
      var capabilities = await withTimeout(ensureMcpAppsReady(), 2500);
      if (capabilities && capabilities.serverTools) {
        return await request("tools/call", { name: entry.decisionTool, arguments: args });
      }
    } catch (_) {
      // Compatibility fallback below for hosts exposing the OpenAI bridge.
    }
    if (a.callTool) return a.callTool(entry.decisionTool, args);
    throw new Error("No app-to-server tool bridge is available");
  }
  async function decide(entry, decision) {
    if (entry.status === "working" || entry.status === "allowed" || entry.status === "denied") return;
    if (!entry.requestId || !entry.token) {
      entry.status = "error";
      entry.message = "확인 채널을 사용할 수 없습니다.";
      render();
      return;
    }
    entry.status = "working";
    entry.message = "";
    render();
    var a = api();
    var followUpPrompt = decision === "allow"
      ? (entry.allowFollowUpPrompt || "C2CT 인라인 확인에서 허용을 눌렀어. 다음 단계를 진행해줘.")
      : (entry.denyFollowUpPrompt || "C2CT 인라인 확인에서 거절을 눌렀어. 결과를 반영해줘.");
    // Queue the next conversation turn before the app-to-server decision call.
    // The server-side approval state remains authoritative, so an allow replay
    // still cannot execute unless the persisted decision has actually been saved.
    var followUpFailed = !(await sendFollowUpTurn(
      "C2CT 승인 카드에서 버튼을 눌렀어. 서버에 저장된 승인 상태를 최종 기준으로 확인해서 진행해줘. " + followUpPrompt
    ));
    try {
      await callDecision(entry, decision);
      entry.status = decision === "allow" ? "allowed" : "denied";
      entry.token = null;
      entry.message = decision === "allow" ? "이 승인은 처리되었습니다." : "이 승인은 거절되었습니다.";
      if (followUpFailed) entry.message += " 다음 대화를 자동으로 열지 못했습니다.";
      await persistWidgetDecision(entry.requestId, entry.status);
      render();
    } catch (_) {
      entry.status = "error";
      entry.message = "승인 상태를 저장하지 못했습니다. 서버 상태를 다시 확인해줘.";
      render();
    }
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pendingRequests.has(message.id)) {
      var pending = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") {
      var params = message.params || {};
      latestToolOutput = params.structuredContent || {};
      latestToolMeta = params._meta || latestToolMeta;
      render();
    }
  }, { passive: true });
  window.addEventListener("openai:set_globals", render);
  window.addEventListener("resize", scheduleIntrinsicHeight, { passive: true });
  if (typeof ResizeObserver === "function") {
    var resizeObserver = new ResizeObserver(scheduleIntrinsicHeight);
    resizeObserver.observe(document.querySelector(".card"));
  }
  document.querySelectorAll(".lab-tab").forEach(function (button) {
    button.addEventListener("click", function () { selectLabTab(button.getAttribute("data-lab-tab")); });
  });
  document.getElementById("lab-server-ping").addEventListener("click", function () { void labServerPing(); });
  document.getElementById("lab-follow-up").addEventListener("click", function () { void labFollowUp(); });
  document.getElementById("lab-fullscreen").addEventListener("click", function () { void labFullscreen(); });
  document.getElementById("lab-approval-demo").addEventListener("click", function () { void labApprovalProbe(); });
  document.getElementById("lab-secret-send").addEventListener("click", function () { void labRelaySecret(); });
  document.getElementById("lab-secret-input").addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); void labRelaySecret(); }
  });
  // Warm the MCP Apps bridge before the user can press an approval button so
  // ui/message normally stays inside the original transient user interaction.
  void ensureMcpAppsReady().catch(function () {});
  render();
  // iOS can hydrate window.openai globals after the iframe's first script turn
  // without emitting openai:set_globals. Poll briefly so the approval payload
  // can still become visible; stop once the request is hydrated.
  var hydrationPolls = 0;
  var hydrationTimer = setInterval(function () {
    hydrationPolls += 1;
    render();
    if (entry || hydrationPolls >= 40) {
      if (!entry) hydrationExhausted = true;
      clearInterval(hydrationTimer);
      render();
    }
  }, 125);
})();
</script>
</body>
</html>`;