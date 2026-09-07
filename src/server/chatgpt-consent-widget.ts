import { CHATGPT_WIDGET_SHELL_COMPAT_PREFIX } from "../exec/chatgpt-widget-shell.js";

export const CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION = 18;
export const CHATGPT_OPERATION_APPROVAL_PRESENTER_TOOL =
  `chatgpt_operation_approval_presenter_v${CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION}`;
export const CHATGPT_OPERATION_APPROVAL_WIDGET_URI =
  `ui://widget/c2ct-operation-approval-v${CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION}.html`;
export const CHATGPT_OPERATION_APPROVAL_WIDGET_RESOURCE_NAME =
  `c2ct-operation-approval-widget-v${CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION}`;

// One final cache-boundary bump introduces the stable hot-loader resource. Once
// this generation is mounted, UI-only card changes are delivered through the
// state-dir widget asset and no longer require presenter URI churn.
export const CHATGPT_CONSENT_WIDGET_URI = "ui://widget/c2ct-consent-v8.html";
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
  body { box-sizing: border-box; padding: 12px 14px; font-family: -apple-system, system-ui, sans-serif; color: #111827; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f5; } }
  #status { box-sizing: border-box; min-height: 52px; display: flex; align-items: center; padding: 12px 14px; border-radius: 10px; background: rgba(128,128,128,.06); font-size: 12px; line-height: 1.45; opacity: .72; }
</style>
</head>
<body>
<div id="status">카드 로딩 중</div>
<script>
(function () {
  var pending = new Map();
  var nextId = 1;
  var presenterBootstrap = null;
  function structured(result) {
    if (!result || typeof result !== "object") return {};
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    return result;
  }
  function capturePresenterBootstrap(toolOutput, toolMeta) {
    var out = structured(toolOutput);
    var presenterLike = typeof out.requestId === "string" ||
      typeof out.presentationKind === "string" ||
      (out.card && typeof out.card === "object");
    if (!presenterLike) return;
    var previousMeta = presenterBootstrap && presenterBootstrap.toolResponseMetadata;
    presenterBootstrap = {
      toolOutput: out,
      toolResponseMetadata: toolMeta && typeof toolMeta === "object" && !Array.isArray(toolMeta)
        ? toolMeta
        : (previousMeta || {})
    };
  }
  function captureOpenAiBootstrap() {
    var a = window.openai || {};
    capturePresenterBootstrap(a.toolOutput, a.toolResponseMetadata);
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
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/tool-result") {
      var params = message.params || {};
      capturePresenterBootstrap(params.structuredContent || {}, params._meta || {});
      return;
    }
    if (message.id === undefined || !pending.has(message.id)) return;
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
    // Snapshot the original presenter payload before the private asset_get call.
    // Host implementations may update window.openai.toolOutput to asset_get's
    // result, and document.write replaces the script that could otherwise hear
    // the one-shot presenter tool-result notification.
    captureOpenAiBootstrap();
    try {
      result = await withTimeout(loadThroughMcpApps(), 1800);
    } catch (_) {
      var a = window.openai || {};
      if (typeof a.callTool !== "function") throw _;
      result = await a.callTool("${CHATGPT_WIDGET_ASSET_GET_TOOL}", {});
    }
    var out = structured(result);
    if (typeof out.html !== "string" || !out.html) throw new Error("widget asset HTML unavailable");
    captureOpenAiBootstrap();
    if (presenterBootstrap) window.__c2ctPresenterBootstrapV1 = presenterBootstrap;
    document.open();
    document.write(out.html);
    document.close();
  }
  void load().catch(function () {
    var status = document.getElementById("status");
    if (status) status.textContent = "카드 로딩 실패 · presenter/runtime 확인 필요";
  });
})();
</script>
</body>
</html>`;

export const CHATGPT_CONSENT_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
  html { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { display: block; box-sizing: border-box; padding: 6px 4px 4px; font-family: -apple-system, system-ui, sans-serif; color: #111827; overflow: visible; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f5; } }
  .card { box-sizing: border-box; border: 1px solid rgba(128,128,128,.35); border-radius: 13px; padding: 14px 15px 15px; margin: 0; color: inherit; background: transparent; }
  .card.critical { border-color: rgba(220,72,48,.78); background: rgba(220,72,48,.08); box-shadow: inset 0 0 0 1px rgba(220,72,48,.12); }
  .title-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 9px; }
  .title { min-width: 0; font-weight: 760; font-size: 16px; line-height: 1.35; }
  .title-state { flex: none; border-radius: 999px; padding: 4px 8px; background: rgba(128,128,128,.10); font-size: 12.5px; font-weight: 720; line-height: 1.35; opacity: .9; white-space: nowrap; }
  .critical-badge { display: inline-block; margin-bottom: 8px; border: 1px solid rgba(220,72,48,.72); border-radius: 999px; padding: 5px 9px; font-size: 12.5px; font-weight: 760; letter-spacing: .01em; }
  .critical-warning { margin-bottom: 10px; border-radius: 9px; padding: 10px 11px; background: rgba(220,72,48,.12); font-size: 13.5px; font-weight: 680; line-height: 1.5; }
  .critical-meta { margin: 8px 0 10px; border: 1px solid rgba(220,72,48,.24); border-radius: 9px; padding: 9px 10px; background: rgba(220,72,48,.05); font-size: 12.5px; line-height: 1.55; }
  .critical-meta-row { display: flex; gap: 8px; justify-content: space-between; }
  .critical-meta-key { opacity: .68; }
  .critical-meta-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 650; text-align: right; }
  .entry-head { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; }
  .preview { min-width: 0; font-size: 15.5px; font-weight: 700; line-height: 1.5; white-space: pre-wrap; }
  .state { flex: none; font-size: 12px; font-weight: 650; opacity: .78; white-space: nowrap; }
  .approval-time { margin-top: 7px; font-size: 12.5px; line-height: 1.45; opacity: .66; }
  .impact { margin-top: 8px; border-radius: 8px; padding: 8px 10px; background: rgba(128,128,128,.08); font-size: 13.5px; font-weight: 600; line-height: 1.5; opacity: .9; }
  .approval-details { margin-top: 9px; border: 1px solid rgba(128,128,128,.20); border-radius: 10px; padding: 0 10px; background: rgba(128,128,128,.035); }
  .approval-details summary { cursor: pointer; user-select: none; min-height: 44px; display: flex; align-items: center; list-style: none; padding: 9px 0; font-size: 13px; font-weight: 650; line-height: 1.4; opacity: .76; }
  .approval-details summary::-webkit-details-marker { display: none; }
  .approval-details summary::before { content: "›"; flex: 0 0 auto; margin-right: 7px; font-size: 20px; font-weight: 500; line-height: 1; transform: rotate(0deg); transform-origin: center; transition: transform 180ms ease; }
  .approval-details[open] summary::before { transform: rotate(90deg); }
  .detail-command { box-sizing: border-box; max-height: 240px; overflow: auto; margin: 0 0 9px; padding: 9px 10px; border-radius: 7px; background: rgba(128,128,128,.10); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  button { flex: 1; min-height: 46px; border-radius: 10px; border: 1px solid rgba(128,128,128,.35); background: #f8fafc; color: #0a63c9; font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button { background: rgba(255,255,255,.08); color: #62a9ff; } }
  button.critical-allow { border-color: rgba(220,72,48,.85); background: rgba(220,72,48,.16); font-weight: 760; }
  button:disabled { opacity: .5; cursor: default; }
  .status { font-size: 13px; line-height: 1.45; opacity: .74; margin-top: 8px; }
  .shell-prompt { font-size: 13px; line-height: 1.5; opacity: .86; white-space: pre-wrap; }
  .shell-options { display: grid; gap: 8px; margin-top: 11px; }
  .shell-option { display: block; width: 100%; min-height: 48px; padding: 9px 11px; text-align: left; background: transparent; color: inherit; }
  .shell-option-title { display: block; font-size: 13px; font-weight: 650; line-height: 1.35; }
  .shell-option-description { display: block; margin-top: 3px; font-size: 11px; line-height: 1.35; opacity: .65; }
  .card.shell-compact { border-color: transparent; padding: 2px 0; }
  .card.shell-compact .title-row, .card.shell-compact #shell-prompt, .card.shell-compact #shell-status { display: none; }
  .card.shell-compact .shell-options { margin-top: 0; }
  .card.shell-compact .shell-option { min-height: 46px; text-align: center; }
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
    <div class="title" id="card-title">확인</div>
    <div class="title-state" id="card-title-state"></div>
  </div>
  <div id="approval"><div class="status">승인 정보 로딩 중</div></div>
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
      <div class="lab-note">테스트 문자열 · app-only callback 전달 · 모델/follow-up/widget state/브라우저 저장 없음 · 권장값 banana-7291-test</div>
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
  var bootstrap = window.__c2ctPresenterBootstrapV1;
  var latestToolOutput = bootstrap && bootstrap.toolOutput && typeof bootstrap.toolOutput === "object"
    ? bootstrap.toolOutput
    : null;
  var latestToolMeta = bootstrap && bootstrap.toolResponseMetadata && typeof bootstrap.toolResponseMetadata === "object"
    ? bootstrap.toolResponseMetadata
    : null;
  try { delete window.__c2ctPresenterBootstrapV1; } catch (_) { window.__c2ctPresenterBootstrapV1 = null; }
  var pendingRequests = new Map();
  var nextRequestId = 1;
  var entry = null;
  var mcpAppsReady = null;
  var mcpHostCapabilities = null;
  var heightFrame = 0;
  var lastReportedHeight = 0;
  var presentationKind = null;
  var shellBusy = false;
  var shellUnlockTimer = null;
  var shellUnlockCardId = null;
  var shellSubmittedCardId = null;
  var statusRefreshInFlight = false;
  var statusRefreshedRequestId = null;
  var statusRefreshAttempts = Object.create(null);
  var hydrationExhausted = false;
  var paintTelemetrySent = false;
  var widgetStateWriteQueue = Promise.resolve();
  function api() { return window.openai || {}; }
  function output() { return latestToolOutput || api().toolOutput || {}; }
  function responseMeta() { return latestToolMeta || api().toolResponseMetadata || {}; }
  function queueWidgetStateWrite(buildNext) {
    widgetStateWriteQueue = widgetStateWriteQueue.catch(function () {}).then(function () {
      var a = api();
      if (typeof a.setWidgetState !== "function") return;
      var current = a.widgetState && typeof a.widgetState === "object" && !Array.isArray(a.widgetState)
        ? a.widgetState
        : {};
      var next = buildNext(current);
      if (!next) return;
      return Promise.resolve(a.setWidgetState(next));
    }).catch(function () {});
    return widgetStateWriteQueue;
  }
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
  function persistFollowUpDiagnostic(requestId, detail) {
    return queueWidgetStateWrite(function (current) {
      var previous = current.c2ctFollowUpDiagnostic && current.c2ctFollowUpDiagnostic.requestId === requestId
        ? current.c2ctFollowUpDiagnostic
        : {};
      return Object.assign({}, current, {
        c2ctFollowUpDiagnostic: Object.assign({}, previous, detail || {}, {
          version: 1,
          requestId: requestId,
          updatedAt: Date.now()
        })
      });
    });
  }
  function beginFollowUpTurn(requestId, prompt) {
    // Important: this function must dispatch from the original click stack.
    // Awaiting approval persistence first loses transient user activation on
    // ChatGPT hosts that gate app-initiated conversation messages.
    var activation = !!(navigator.userActivation && navigator.userActivation.isActive);
    var messageSupported = !!(mcpHostCapabilities && mcpHostCapabilities.message);
    var a = api();
    if (messageSupported) {
      try {
        var messagePromise = request("ui/message", {
          role: "user",
          content: [{ type: "text", text: prompt }]
        });
        persistFollowUpDiagnostic(requestId, {
          transport: "ui/message",
          phase: "dispatched",
          userActivation: activation,
          messageCapability: true
        });
        return withTimeout(messagePromise, 2000).then(function (result) {
          if (result && result.isError === true) {
            persistFollowUpDiagnostic(requestId, { phase: "is-error" });
            return false;
          }
          persistFollowUpDiagnostic(requestId, { phase: "ack" });
          return true;
        }).catch(function (error) {
          persistFollowUpDiagnostic(requestId, { phase: "rejected", error: bridgeFailureTag(error) });
          return false;
        });
      } catch (error) {
        persistFollowUpDiagnostic(requestId, { transport: "ui/message", phase: "dispatch-error", error: bridgeFailureTag(error) });
      }
    }
    if (typeof a.sendFollowUpMessage === "function") {
      try {
        var legacyPromise = a.sendFollowUpMessage({ prompt: prompt });
        persistFollowUpDiagnostic(requestId, {
          transport: "openai-legacy",
          phase: "dispatched",
          userActivation: activation,
          messageCapability: messageSupported
        });
        return Promise.resolve(legacyPromise).then(function () {
          persistFollowUpDiagnostic(requestId, { phase: "ack" });
          return true;
        }, function (error) {
          persistFollowUpDiagnostic(requestId, { phase: "rejected", error: bridgeFailureTag(error) });
          return false;
        });
      } catch (error) {
        persistFollowUpDiagnostic(requestId, { transport: "openai-legacy", phase: "dispatch-error", error: bridgeFailureTag(error) });
      }
    }
    persistFollowUpDiagnostic(requestId, {
      transport: "none",
      phase: "unavailable",
      userActivation: activation,
      messageCapability: messageSupported
    });
    return Promise.resolve(false);
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
  async function callServerTool(name, args, options) {
    var a = api();
    var allowCrossBridgeFallback = options && options.allowCrossBridgeFallback === true;
    var preferOpenAi = options && options.preferOpenAi === true;
    if (preferOpenAi && a.callTool) {
      // Mutating approval decisions use exactly one host bridge. Prefer the
      // native OpenAI app bridge when present; if that attempted call rejects,
      // do not replay the mutation over MCP Apps.
      return await a.callTool(name, args || {});
    }
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
    if (mcpState === "tools/call-rejected" && !allowCrossBridgeFallback) {
      // Once tools/call was dispatched, never replay the same logical tool call
      // over a second bridge. A domain rejection or uncertain post-dispatch
      // failure is authoritative for this attempt; higher-level read-only status
      // reconciliation may decide whether a later retry is safe.
      if (mcpError) throw mcpError;
      throw new Error("MCP Apps tools/call rejected after dispatch");
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
    if (status === "allowed") return "승인 완료";
    if (status === "denied") return "거절 완료";
    if (status === "consumed") return "처리 완료";
    if (status === "expired") return "만료";
    if (status === "unavailable") return "확인 불가";
    if (status === "checking") return "승인 확인 중";
    if (status === "working") return "처리 중";
    if (status === "error") return "처리 실패";
    return "승인 대기";
  }
  function formatApprovalTime(value) {
    var milliseconds = Number(value || 0);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "알 수 없음";
    try {
      return new Date(milliseconds).toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false
      }) + " KST";
    } catch (_) {
      return new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", " KST");
    }
  }
  function approvalExpiredByClock(now) {
    if (!entry) return false;
    var expiresAt = Number(entry.expiresAt || 0);
    return Number.isFinite(expiresAt) && expiresAt > 0 && now >= expiresAt;
  }
  function expirePendingEntryLocally(now) {
    if (!entry || (entry.status !== "checking" && entry.status !== "pending" && entry.status !== "error")) return false;
    if (!approvalExpiredByClock(now)) return false;
    entry.status = "expired";
    entry.token = null;
    entry.message = "승인 만료 · 새 승인 필요";
    statusRefreshedRequestId = entry.requestId;
    return true;
  }
  function mapPersistedStatus(status) {
    if (status === "approved" || status === "allowed") return "allowed";
    if (status === "rejected" || status === "denied") return "denied";
    if (status === "consumed") return "consumed";
    if (status === "expired") return "expired";
    return "pending";
  }
  function persistedStatusMessage(status) {
    if (status === "allowed" || status === "denied" || status === "consumed") return "";
    if (status === "expired") return "승인 만료";
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
  function restoredApprovalInteraction(requestId) {
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctApprovalInteraction;
    if (!saved || typeof saved !== "object" || saved.requestId !== requestId) return null;
    if (saved.status === "working") return "working";
    if (saved.status === "unavailable") return "unavailable";
    return null;
  }
  function persistApprovalInteraction(requestId, status) {
    if (status !== "working" && status !== "unavailable") return;
    return queueWidgetStateWrite(function (current) {
      var savedDecision = current.c2ctApprovalDecision;
      if (savedDecision && savedDecision.requestId === requestId && mapPersistedStatus(savedDecision.status) !== "pending") {
        return null;
      }
      return Object.assign({}, current, {
        c2ctApprovalInteraction: {
          version: 1,
          requestId: requestId,
          status: status,
          updatedAt: Date.now()
        }
      });
    });
  }
  function persistWidgetDecision(requestId, status) {
    if (status === "pending" || status === "working" || status === "error" || status === "unavailable") return;
    return queueWidgetStateWrite(function (current) {
      return Object.assign({}, current, {
        c2ctApprovalDecision: {
          version: 1,
          requestId: requestId,
          status: status,
          updatedAt: Date.now()
        },
        c2ctApprovalInteraction: null
      });
    });
  }
  function restoredShellSubmission(cardId) {
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctShellChoice;
    if (!saved || typeof saved !== "object" || saved.cardId !== cardId) return null;
    if (saved.status !== "submitted" && saved.status !== "resolved") return null;
    if (typeof saved.choiceId !== "string" || !saved.choiceId) return null;
    return saved;
  }
  function restoredShellChoice(cardId) {
    var saved = restoredShellSubmission(cardId);
    return saved && saved.status === "resolved" ? saved : null;
  }
  function persistShellSubmission(card, choiceId) {
    return queueWidgetStateWrite(function (current) {
      var saved = current.c2ctShellChoice;
      if (saved && saved.cardId === card.cardId && (saved.status === "submitted" || saved.status === "resolved")) return null;
      var matched = (Array.isArray(card.options) ? card.options : []).find(function (option) { return option.id === choiceId; });
      return Object.assign({}, current, {
        c2ctShellChoice: {
          version: 1,
          cardId: card.cardId,
          choiceId: choiceId,
          choiceLabel: matched && matched.label ? matched.label : choiceId,
          status: "submitted",
          updatedAt: Date.now()
        }
      });
    });
  }
  async function persistShellChoice(card, choiceId, receiptId) {
    await queueWidgetStateWrite(function (current) {
      var matched = (Array.isArray(card.options) ? card.options : []).find(function (option) { return option.id === choiceId; });
      return Object.assign({}, current, {
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
    });
  }
  function collectPaintTelemetry() {
    var out = output();
    if (!out || out.measurePaint !== true || typeof performance !== "object" || !performance) return null;
    var telemetry = { version: 1 };
    if (Number.isFinite(performance.timeOrigin)) telemetry.timeOriginMs = Math.round(performance.timeOrigin * 1000) / 1000;
    if (typeof performance.now === "function") telemetry.callbackStartMs = Math.round(performance.now() * 1000) / 1000;
    var paints = typeof performance.getEntriesByType === "function" ? performance.getEntriesByType("paint") : [];
    telemetry.paintEntryCount = Array.isArray(paints) ? paints.length : 0;
    if (paints && typeof paints.forEach === "function") {
      paints.forEach(function (paint) {
        if (!paint || !Number.isFinite(paint.startTime)) return;
        var value = Math.round(paint.startTime * 1000) / 1000;
        if (paint.name === "first-paint") telemetry.firstPaintMs = value;
        if (paint.name === "first-contentful-paint") telemetry.firstContentfulPaintMs = value;
      });
    }
    return telemetry;
  }
  function approvalStatusErrorText(error) {
    var queue = [error];
    var seen = [];
    var parts = [];
    var keys = ["code", "errorCode", "message", "error", "data", "structuredContent", "cause"];
    while (queue.length && seen.length < 24 && parts.join(" ").length < 1600) {
      var value = queue.shift();
      if (value === null || value === undefined) continue;
      if (typeof value === "string" || typeof value === "number") {
        parts.push(String(value));
        continue;
      }
      if (typeof value !== "object" || seen.indexOf(value) >= 0) continue;
      seen.push(value);
      keys.forEach(function (key) {
        if (value[key] !== undefined) queue.push(value[key]);
      });
    }
    return parts.join(" ").toLowerCase();
  }
  function isPermanentApprovalStatusError(error) {
    var text = approvalStatusErrorText(error);
    return text.indexOf("permission_denied") >= 0 ||
      text.indexOf("permission denied") >= 0 ||
      text.indexOf("operation_not_found") >= 0 ||
      text.indexOf("operation not found") >= 0 ||
      text.indexOf("approval_required") >= 0 ||
      text.indexOf("approval required") >= 0 ||
      text.indexOf("missing or expired") >= 0 ||
      text.indexOf("belongs to another conversation") >= 0 ||
      text.indexOf("invalid chatgpt approval widget token") >= 0;
  }
  function maybeRefreshPersistedStatus() {
    if (!entry || presentationKind === "widget-capability-lab" || presentationKind === "widget-shell-choice") return;
    if (entry.status !== "checking" && entry.status !== "pending" && entry.status !== "error" && entry.status !== "working") return;
    if (statusRefreshedRequestId === entry.requestId || statusRefreshInFlight) return;
    var attempts = statusRefreshAttempts[entry.requestId] || 0;
    var maxAttempts = entry.status === "working" ? 8 : 3;
    if (attempts >= maxAttempts) return;
    var requestId = entry.requestId;
    var token = entry.token;
    statusRefreshAttempts[requestId] = attempts + 1;
    statusRefreshInFlight = true;
    void (async function () {
      try {
        var result;
        if (requestId.indexOf("op_") === 0 && token) {
          var statusArgs = {
            requestId: requestId,
            token: token,
            decision: "status"
          };
          var paintTelemetry = paintTelemetrySent ? null : collectPaintTelemetry();
          if (paintTelemetry) statusArgs.paintTelemetry = paintTelemetry;
          result = structured(await callServerTool(entry.decisionTool, statusArgs, { allowCrossBridgeFallback: true }));
          if (paintTelemetry) paintTelemetrySent = true;
        } else if (requestId.indexOf("consent_") === 0) {
          result = structured(await callServerTool("chatgpt_consent_probe_status", { requestId: requestId }, { allowCrossBridgeFallback: true }));
        } else {
          return;
        }
        if (!entry || entry.requestId !== requestId) return;
        if (entry.status === "allowed" || entry.status === "denied" || entry.status === "consumed") {
          statusRefreshedRequestId = requestId;
          return;
        }
        var mapped = mapPersistedStatus(result.status);
        if (mapped === "pending" && entry.status === "working") {
          var workingAttemptCount = statusRefreshAttempts[requestId] || 0;
          if (workingAttemptCount < 8) {
            setTimeout(maybeRefreshPersistedStatus, 350 * Math.max(1, workingAttemptCount));
            return;
          }
          entry.status = "unavailable";
          entry.token = null;
          entry.message = "승인 반영 확인 불가 · 카드 비활성 · 새 승인 필요";
          await persistApprovalInteraction(requestId, "unavailable");
          render();
          return;
        }
        statusRefreshedRequestId = requestId;
        entry.status = mapped;
        entry.message = persistedStatusMessage(mapped);
        if (mapped !== "pending") entry.token = null;
        if (mapped !== "pending") await persistWidgetDecision(requestId, mapped);
        render();
      } catch (error) {
        if (entry && entry.requestId === requestId) {
          if (entry.status === "allowed" || entry.status === "denied" || entry.status === "consumed") {
            statusRefreshedRequestId = requestId;
            return;
          }
          if (isPermanentApprovalStatusError(error)) {
            statusRefreshedRequestId = requestId;
            entry.status = "unavailable";
            entry.token = null;
            entry.message = "승인 카드가 더 이상 유효하지 않음 · 카드 비활성 · 새 승인 필요";
            await persistApprovalInteraction(requestId, "unavailable");
            render();
            return;
          }
          var attemptCount = statusRefreshAttempts[requestId] || 0;
          var retryLimit = entry.status === "working" ? 8 : 3;
          if (attemptCount < retryLimit) {
            setTimeout(maybeRefreshPersistedStatus, 300 * Math.max(1, attemptCount));
          } else {
            entry.status = "unavailable";
            entry.token = null;
            entry.message = "승인 상태 확인 불가 · 카드 비활성 · 새 승인 필요";
            await persistApprovalInteraction(requestId, "unavailable");
            render();
          }
        }
        statusRefreshInFlight = false;
      }
    })();
  }
  function scheduleInitialStatusRefresh(requestId) {
    // Fail closed: first paint keeps approval actions disabled until the
    // persisted server state confirms that this request is still pending.
    setTimeout(function () {
      if (entry && entry.requestId === requestId) maybeRefreshPersistedStatus();
    }, 0);
  }
  function syncCurrentRequest() {
    var out = output();
    presentationKind = out.presentationKind || null;
    if (presentationKind === "widget-capability-lab" || presentationKind === "widget-shell-choice") return;
    var sec = secret();
    if (!out.requestId) return;
    var restored = restoredWidgetDecision(out.requestId);
    var interaction = restoredApprovalInteraction(out.requestId);
    if (!sec.token && !restored && !interaction) return;
    if (!entry || entry.requestId !== out.requestId) {
      entry = {
        requestId: out.requestId,
        projectId: out.projectId || "",
        originOperationId: out.originOperationId || "",
        preview: out.summary || out.preview || "C2CT 작업 승인",
        impact: out.impact || "",
        details: out.details || "",
        createdAt: out.createdAt || null,
        expiresAt: out.expiresAt || null,
        approvalSeverity: out.approvalSeverity || "standard",
        criticalBadge: out.criticalBadge || "Mac 시스템 변경",
        criticalWarning: out.criticalWarning || "",
        criticalIdentityBefore: out.criticalIdentityBefore || "",
        criticalIdentityAfter: out.criticalIdentityAfter || "",
        criticalRollback: out.criticalRollback || "",
        criticalPostApply: out.criticalPostApply || "",
        decisionTool: out.decisionTool || "chatgpt_consent_probe_decide",
        operationTool: out.operationTool || "",
        turnlessContinuationAfterApproval: out.turnlessContinuationAfterApproval === true,
        allowFollowUpPrompt: out.allowFollowUpPrompt,
        denyFollowUpPrompt: out.denyFollowUpPrompt,
        token: restored ? null : sec.token,
        status: restored || interaction || "checking",
        message: restored
          ? persistedStatusMessage(restored)
          : (interaction === "working"
            ? ""
            : (interaction === "unavailable" ? "승인 상태 확인 불가 · 카드 비활성 · 새 승인 필요" : "승인 상태 확인 중"))
      };
      if (restored) {
        statusRefreshedRequestId = out.requestId;
        return;
      }
      if (interaction === "unavailable") {
        entry.token = null;
        return;
      }
      if (expirePendingEntryLocally(Date.now())) return;
      scheduleInitialStatusRefresh(out.requestId);
      return;
    }
    if (restored) {
      entry.status = restored;
      entry.token = null;
      entry.message = persistedStatusMessage(restored);
      statusRefreshedRequestId = out.requestId;
      return;
    }
    if (interaction === "working") {
      entry.status = "working";
      entry.token = sec.token;
      entry.message = "";
      maybeRefreshPersistedStatus();
      return;
    }
    if (interaction === "unavailable") {
      entry.status = "unavailable";
      entry.token = null;
      entry.message = "승인 상태 확인 불가 · 카드 비활성 · 새 승인 필요";
      return;
    }
    if (entry.status === "checking" || entry.status === "pending" || entry.status === "error") {
      entry.preview = out.summary || out.preview || entry.preview;
      entry.impact = out.impact || entry.impact;
      entry.details = out.details || entry.details;
      entry.createdAt = entry.createdAt || out.createdAt || null;
      entry.expiresAt = out.expiresAt || entry.expiresAt || null;
      entry.approvalSeverity = out.approvalSeverity || entry.approvalSeverity;
      entry.criticalBadge = out.criticalBadge || entry.criticalBadge;
      entry.criticalWarning = out.criticalWarning || entry.criticalWarning;
      entry.criticalIdentityBefore = out.criticalIdentityBefore || entry.criticalIdentityBefore;
      entry.criticalIdentityAfter = out.criticalIdentityAfter || entry.criticalIdentityAfter;
      entry.criticalRollback = out.criticalRollback || entry.criticalRollback;
      entry.criticalPostApply = out.criticalPostApply || entry.criticalPostApply;
      entry.decisionTool = out.decisionTool || entry.decisionTool;
      entry.operationTool = out.operationTool || entry.operationTool;
      entry.projectId = out.projectId || entry.projectId;
      entry.originOperationId = out.originOperationId || entry.originOperationId;
      entry.turnlessContinuationAfterApproval = out.turnlessContinuationAfterApproval === true;
      entry.allowFollowUpPrompt = out.allowFollowUpPrompt || entry.allowFollowUpPrompt;
      entry.denyFollowUpPrompt = out.denyFollowUpPrompt || entry.denyFollowUpPrompt;
      entry.token = sec.token;
      if (entry.status === "error") entry.status = "checking";
      if (expirePendingEntryLocally(Date.now())) return;
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
      prompt.textContent = "선택 카드 없음";
      clearShellUnlockTimer();
      return;
    }
    var submitted = restoredShellSubmission(card.cardId);
    var restored = submitted && submitted.status === "resolved" ? submitted : null;
    var resolved = card.status === "resolved" || Boolean(restored);
    var submittedForCard = shellSubmittedCardId === card.cardId || Boolean(submitted);
    var remainingMs = typeof card.availableAt === "number" ? Math.max(0, card.availableAt - Date.now()) : 0;
    var locked = remainingMs > 0;
    var compact = card.compact === true && Array.isArray(card.options) && card.options.length === 1;
    prompt.textContent = card.prompt || "선택 필요";
    (Array.isArray(card.options) ? card.options : []).forEach(function (option) {
      var button = document.createElement("button");
      button.className = "shell-option";
      button.disabled = shellBusy || submittedForCard || resolved || locked;
      var title = document.createElement("span");
      title.className = "shell-option-title";
      title.textContent = option.label || option.id || "선택";
      if (locked && compact) title.textContent += " · " + formatShellDelay(remainingMs) + " 후";
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
    } else if (submittedForCard) {
      status.textContent = "⏳ 진행 요청됨";
    } else if (locked && !compact) {
      status.textContent = formatShellDelay(remainingMs) + " 후 사용 가능";
    } else if (!shellBusy) {
      status.textContent = "";
    }
    scheduleShellUnlock(card);
  }
  function formatShellDelay(ms) {
    var totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    if (totalSeconds < 60) return totalSeconds + "초";
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return seconds ? minutes + "분 " + seconds + "초" : minutes + "분";
  }
  function clearShellUnlockTimer() {
    if (shellUnlockTimer !== null) clearInterval(shellUnlockTimer);
    shellUnlockTimer = null;
    shellUnlockCardId = null;
  }
  function scheduleShellUnlock(card) {
    var remainingMs = card && typeof card.availableAt === "number" ? card.availableAt - Date.now() : 0;
    if (!card || remainingMs <= 0 || card.status === "resolved") {
      clearShellUnlockTimer();
      return;
    }
    if (shellUnlockTimer !== null && shellUnlockCardId === card.cardId) return;
    clearShellUnlockTimer();
    shellUnlockCardId = card.cardId;
    shellUnlockTimer = setInterval(function () {
      var currentOut = output();
      var currentCard = currentOut && currentOut.card && currentOut.card.kind === "choice" ? currentOut.card : null;
      if (!currentCard || currentCard.cardId !== shellUnlockCardId) {
        clearShellUnlockTimer();
        return;
      }
      renderShellChoice(currentOut);
      if (typeof currentCard.availableAt !== "number" || Date.now() >= currentCard.availableAt) clearShellUnlockTimer();
    }, 1000);
  }
  async function submitShellChoice(choiceId, clickedButton) {
    if (shellBusy) return;
    var out = output();
    var card = out && out.card && out.card.kind === "choice" ? out.card : null;
    if (!card || !card.cardId || !choiceId) return;
    if (restoredShellSubmission(card.cardId)) return;
    if (typeof card.availableAt === "number" && Date.now() < card.availableAt) {
      renderShellChoice(out);
      return;
    }
    shellBusy = true;
    shellSubmittedCardId = card.cardId;
    document.querySelectorAll(".shell-option").forEach(function (button) { button.disabled = true; });
    document.getElementById("shell-status").textContent = "후속 대화 요청 중";
    // Persist a submitted latch without awaiting it so the original click stack
    // remains eligible for the iOS/ChatGPT follow-up dispatch. The latch survives
    // remounts and is intentionally never cleared for this card.
    void persistShellSubmission(card, choiceId);
    // Start the authoritative server receipt request first, but do not await it.
    // The follow-up turn must still be dispatched from this original click stack
    // so iOS/ChatGPT transient user activation is not lost.
    var receiptPromise = callServerTool("chatgpt_widget_lab_action", {
      action: "secret-relay",
      secretValue: "${CHATGPT_WIDGET_SHELL_COMPAT_PREFIX}" + card.cardId + "|" + choiceId
    });
    var continuationTask = typeof card.prompt === "string" && card.prompt.trim()
      ? card.prompt.trim()
      : "직전 작업의 다음 단계를 이어서 진행";
    var continuationPrompt = card.compact === true && Array.isArray(card.options) && card.options.length === 1
      ? "C2CT 계속 진행 버튼을 눌렀어. cardId: " + card.cardId + ". 서버 receipt 저장 요청은 이 버튼 클릭과 동시에 먼저 시작됐어. 이어갈 실제 작업: " + continuationTask + ". 이 follow-up 턴의 첫 C2CT 호출은 반드시 chatgpt_widget_shell_result(cardId)여야 해. 첫 조회가 pending/not-found면 작업 mutation을 재호출하지 말고 같은 턴에서 최대 3회 status-only로 재확인해. resolved 되면 확인 문장이나 최종 답변을 먼저 보내지 말고 같은 assistant 턴에서 실제 작업을 즉시 시작해. 실제 작업을 진행하지 못하고 턴을 끝내야 한다면 반드시 새 계속 진행 카드를 생성하고 presenter까지 렌더링한 뒤 종료해. 사용자에게 추가 '고고'를 요구하지 마."
      : "C2CT Widget Shell 선택 버튼을 눌렀어. cardId: " + card.cardId + ", choiceId: " + choiceId + ". 서버 receipt 저장 요청은 이 버튼 클릭과 동시에 먼저 시작됐어. 이어갈 실제 작업: " + continuationTask + ". 이 follow-up 턴의 첫 C2CT 호출은 반드시 chatgpt_widget_shell_result(cardId)여야 해. 첫 조회가 pending/not-found면 작업 mutation을 재호출하지 말고 같은 턴에서 최대 3회 status-only로 재확인해. resolved 되면 확인 문장이나 최종 답변을 먼저 보내지 말고 같은 assistant 턴에서 실제 작업을 즉시 시작해. 실제 작업을 진행하지 못하고 턴을 끝내야 한다면 반드시 새 계속 진행 카드를 생성하고 presenter까지 렌더링한 뒤 종료해. 사용자에게 추가 '고고'를 요구하지 마.";
    var followUpPromise = beginFollowUpTurn(card.cardId, continuationPrompt);
    var result = null;
    try {
      result = structured(await receiptPromise);
      if (!result.ok || typeof result.receiptId !== "string") throw new Error("missing server receipt");
      await persistShellChoice(card, choiceId, result.receiptId);
      if (clickedButton) clickedButton.querySelector(".shell-option-title").textContent += " ✓";
    } catch (_) {
      shellBusy = false;
      document.getElementById("shell-status").textContent = "❌ 선택 처리 실패 · 버튼 잠금 유지 · 새 카드 필요";
      scheduleIntrinsicHeight();
      return;
    }
    var followUpSucceeded = false;
    try {
      followUpSucceeded = await followUpPromise;
    } catch (_) {
      followUpSucceeded = false;
    }
    shellBusy = false;
    document.getElementById("shell-status").textContent = followUpSucceeded
      ? "✅ 선택 저장 완료 · 후속 대화 요청 전송"
      : "✅ 선택 저장 완료 · 후속 대화 요청 실패";
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
    var expiredByClock = Boolean(entry && approvalExpiredByClock(Date.now()));
    if (expiredByClock) expirePendingEntryLocally(Date.now());
    var approvalStillNeeded = Boolean(entry && !expiredByClock && (
      entry.status === "checking" || entry.status === "pending" || entry.status === "working" || entry.status === "error"
    ));
    var minimalApprovalMode = Boolean(entry && !labMode && !shellMode && !approvalStillNeeded);
    var cardNode = document.querySelector(".card");
    var criticalMode = Boolean(entry && entry.approvalSeverity === "critical" && !labMode && !shellMode && !minimalApprovalMode);
    var shellCompactMode = Boolean(shellMode && out.card && out.card.compact === true && Array.isArray(out.card.options) && out.card.options.length === 1);
    if (cardNode) cardNode.classList.toggle("critical", criticalMode);
    if (cardNode) cardNode.classList.toggle("shell-compact", shellCompactMode);
    document.getElementById("card-title").textContent = shellMode
      ? ((out.card && out.card.title) || "선택")
      : (labMode ? "Widget Capability Lab" : (minimalApprovalMode ? "승인 상태" : (criticalMode ? "⚠️ 고위험 승인" : "확인")));
    document.getElementById("card-title-state").textContent =
      !labMode && !shellMode ? (entry ? stateLabel(expiredByClock ? "expired" : entry.status) : (hydrationExhausted ? "확인 불가" : "")) : "";
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
        ? "승인 정보 로딩 실패 · 카드 사용 불가 · 새 승인 필요"
        : "승인 정보 로딩 중";
      approval.appendChild(loading);
      scheduleIntrinsicHeight();
      return;
    }
    if (minimalApprovalMode) {
      if (entry.expiresAt) {
        var minimalExpiry = document.createElement("div");
        minimalExpiry.className = "approval-time";
        minimalExpiry.textContent = "만료: " + formatApprovalTime(entry.expiresAt);
        approval.appendChild(minimalExpiry);
      }
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
      var warningText = entry.criticalWarning || "Mac 실행 상태 실제 변경 · 요청 확인 후 승인 필요";
      if (warningText.indexOf("Mac C2CT runtime 실제 교체") === 0) {
        warningText = "실행 중인 runtime을 실제로 교체합니다. 정상 적용 후 필요하면 ChatGPT 도구 목록을 자동 갱신합니다.";
      }
      warning.textContent = warningText;
      approval.appendChild(warning);
      if (entry.criticalIdentityBefore || entry.criticalIdentityAfter || entry.criticalRollback || entry.criticalPostApply) {
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
        if (entry.criticalPostApply) {
          var postApply = document.createElement("div");
          postApply.style.marginTop = "5px";
          postApply.textContent = "적용 후: " + entry.criticalPostApply;
          criticalMeta.appendChild(postApply);
        }
        approval.appendChild(criticalMeta);
      }
    }
    var technicalPreview = criticalMode && typeof entry.preview === "string" && entry.preview.indexOf("CRITICAL:") === 0
      ? entry.preview
      : "";
    if (!technicalPreview) {
      var head = document.createElement("div");
      head.className = "entry-head";
      var preview = document.createElement("div");
      preview.className = "preview";
      preview.textContent = entry.preview;
      head.append(preview);
      approval.appendChild(head);
    }
    if (entry.createdAt || entry.expiresAt) {
      var approvalTime = document.createElement("div");
      approvalTime.className = "approval-time";
      var timeParts = [];
      if (entry.createdAt) timeParts.push("생성: " + formatApprovalTime(entry.createdAt));
      if (entry.expiresAt) timeParts.push("만료: " + formatApprovalTime(entry.expiresAt));
      approvalTime.textContent = timeParts.join(" · ");
      approval.appendChild(approvalTime);
    }
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
      disclosureTitle.textContent = "상세 명령 및 파라미터";
      var detailCommand = document.createElement("div");
      detailCommand.className = "detail-command";
      detailCommand.textContent = entry.details;
      disclosure.append(disclosureTitle, detailCommand);
      disclosure.addEventListener("toggle", scheduleIntrinsicHeight);
      approval.appendChild(disclosure);
    }
    if (technicalPreview) {
      var technicalDisclosure = document.createElement("details");
      technicalDisclosure.className = "approval-details";
      var technicalTitle = document.createElement("summary");
      technicalTitle.textContent = "기술 원문";
      var technicalCommand = document.createElement("div");
      technicalCommand.className = "detail-command";
      technicalCommand.textContent = technicalPreview;
      technicalDisclosure.append(technicalTitle, technicalCommand);
      technicalDisclosure.addEventListener("toggle", scheduleIntrinsicHeight);
      approval.appendChild(technicalDisclosure);
    }
    if (entry.status === "checking" || entry.status === "pending" || entry.status === "working" || entry.status === "error") {
      var actions = document.createElement("div");
      actions.className = "actions";
      var deny = document.createElement("button");
      deny.textContent = "거절";
      var allow = document.createElement("button");
      allow.textContent = criticalMode ? "위험을 이해하고 승인" : "허용";
      if (criticalMode) allow.className = "critical-allow";
      var disabled = entry.status !== "pending";
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
    if (!secretValue) return labText("lab-secret-status", "테스트 문자열 입력 필요");
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
  function beginDecision(entry, decision) {
    var args = { requestId: entry.requestId, token: entry.token, decision: decision };
    // Mutating approval decisions must use exactly one host bridge. Prefer the
    // native OpenAI bridge when available; callServerTool refuses cross-bridge
    // replay after a dispatched mutation and uses MCP Apps only when no native
    // bridge is available.
    return callServerTool(entry.decisionTool, args, { preferOpenAi: true });
  }
  async function decide(entry, decision) {
    if (entry.status !== "pending") return;
    if (!entry.requestId || !entry.token) {
      entry.status = "error";
      entry.message = "확인 채널 사용 불가";
      render();
      return;
    }
    entry.status = "working";
    entry.message = "";
    render();
    persistApprovalInteraction(entry.requestId, "working");
    var followUpPrompt = decision === "allow"
      ? (entry.allowFollowUpPrompt || "C2CT 인라인 확인에서 허용을 눌렀어. 다음 단계를 진행해줘.")
      : (entry.denyFollowUpPrompt || "C2CT 인라인 확인에서 거절을 눌렀어. 결과를 반영해줘.");
    try {
      // Keep the existing FIFO tools/call -> ui/message ordering on the original
      // click stack so transient user activation is preserved. Eligible turnless
      // approvals start the exact worker inside the decision callback; their
      // follow-up is status-only and must never replay the mutation.
      var orderedDecision = !!(mcpHostCapabilities && mcpHostCapabilities.serverTools);
      var turnlessApproval = entry.turnlessContinuationAfterApproval === true;
      var decisionPromise = beginDecision(entry, decision);
      var shouldOpenFollowUp = orderedDecision && (!turnlessApproval || decision === "allow");
      var followUpAttempted = shouldOpenFollowUp;
      var exactRuntimeStatusTarget = entry.projectId && entry.originOperationId
        ? " projectId=" + entry.projectId + ", operationId=" + entry.originOperationId + "로"
        : "";
      var turnlessFollowUpPrompt = entry.operationTool === "macos_app_apply_local"
        ? "C2CT turnless macOS app 승인 카드에서 허용을 눌렀어. 이 follow-up은 상태 확인용이고 실행 권한이 아니야. macos_app_apply_local은 절대 재호출하지 마. 방금 승인 카드와 연결된 exact macOS app apply request id는 직전 C2CT 결과에서 가져와 macos_app_apply_status로 status-only 확인해. 서버 approval callback이 exact operation을 자동 시작한다. 아직 APPROVAL_REQUIRED면 mutation을 재호출하지 말고 status-only로 다시 확인하고, ACTIVATION_REQUESTED 이후에는 reconnectPlan을 따라 terminal 상태까지 확인해줘."
        : "C2CT turnless runtime 승인 카드에서 허용을 눌렀어. 이 follow-up은 상태 확인용이고 실행 권한이 아니야. runtime_apply_local은 절대 재호출하지 마. 이 턴에서는 설명/요약/최종 답변을 먼저 하지 말고 첫 C2CT 호출로 runtime_apply_status를" + exactRuntimeStatusTarget + " 즉시 실행해. 서버 approval callback이 exact operation을 자동 시작한다. 아직 APPROVAL_REQUIRED면 같은 exact operation을 mutation 재호출 없이 status-only로 다시 확인하고, ACTIVATION_REQUESTED 이후에는 reconnectPlan을 따라 terminal 상태까지 확인해. APPLIED가 되면 새 runtime에서 connection_status -> agent_guide -> project_rules/project_status -> 새 lane 검증 -> 실제 읽기 도구 1회까지 자동으로 이어가. 사용자에게 추가 '고고'를 요구하지 마.";
      var followUpPromise = shouldOpenFollowUp
        ? beginFollowUpTurn(
            entry.requestId,
            turnlessApproval && decision === "allow"
              ? turnlessFollowUpPrompt
              : "C2CT 승인 카드 버튼 입력이 발생했어. 서버에 저장된 승인 상태를 최종 기준으로 확인하고 approved/allowed일 때만 이어서 진행해줘. pending/denied/error면 실행하지 마. " + followUpPrompt
          )
        : Promise.resolve(true);
      var decisionResult = structured(await decisionPromise);
      if (turnlessApproval && decision === "allow" && decisionResult.continuationDeferred === true) {
        entry.status = "consumed";
        entry.message = followUpAttempted
          ? "승인 완료 · 기존 작업 종료 대기 중"
          : "승인 완료 · 기존 작업 종료 대기 중 · 자동 후속 대화 미지원 · 채팅에 ‘상태 확인해줘’를 보내세요";
      } else if (turnlessApproval && decision === "allow" && decisionResult.continuationStarted === true) {
        entry.status = "consumed";
        entry.message = followUpAttempted
          ? "승인 완료 · 작업 시작됨"
          : "승인 완료 · 작업 시작됨 · 자동 후속 대화 미지원 · 채팅에 ‘상태 확인해줘’를 보내세요";
      } else {
        entry.status = decision === "allow" ? "allowed" : "denied";
        entry.message = "";
      }
      entry.token = null;
      persistWidgetDecision(entry.requestId, entry.status);
      render();
      if (turnlessApproval && decision === "allow" && decisionResult.fallbackRequiresExactReplay === true) {
        if (!followUpAttempted) {
          entry.message = "승인 완료 · 자동 실행 실패 · 자동 후속 대화 미지원 · 채팅에 ‘계속 진행해줘’를 보내세요";
          render();
          return;
        }
        var turnlessFallbackFollowUpFailed = !(await followUpPromise);
        entry.message = turnlessFallbackFollowUpFailed
          ? "승인 완료 · 자동 실행 실패 · 후속 대화 열기 실패 · 채팅에 ‘계속 진행해줘’를 보내세요"
          : "승인 완료 · 자동 실행 실패 · 후속 대화에서 상태 확인";
        render();
        return;
      }
      var followUpFailed = !(await followUpPromise);
      if (followUpFailed) {
        entry.message = turnlessApproval && decision === "allow"
          ? "후속 대화 자동 열기 실패 · 채팅에 ‘상태 확인해줘’를 보내세요"
          : "후속 대화 자동 열기 실패";
        render();
      }
    } catch (_) {
      entry.status = "unavailable";
      entry.token = null;
      entry.message = "승인 상태 저장 실패 · 카드 비활성 · 새 승인 필요";
      persistApprovalInteraction(entry.requestId, "unavailable");
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
  var hydrationTimer = 0;
  var fastHydrationDelays = [16, 16, 18, 25, 25, 25];
  function pollHydration() {
    hydrationPolls += 1;
    render();
    if (entry || hydrationPolls >= 40) {
      if (!entry) hydrationExhausted = true;
      render();
      return;
    }
    var delay = hydrationPolls < fastHydrationDelays.length
      ? fastHydrationDelays[hydrationPolls]
      : 125;
    hydrationTimer = setTimeout(pollHydration, delay);
  }
  hydrationTimer = setTimeout(pollHydration, fastHydrationDelays[0]);
})();
</script>
</body>
</html>`;

// The versioned operation presenter serves the verified card HTML directly.
// Shared Widget Shell/Lab presenters retain the hot-loader path, but approvals
// avoid the extra iframe -> ui/initialize -> tools/call(asset_get) round trip.
export const CHATGPT_OPERATION_APPROVAL_WIDGET_HTML = CHATGPT_CONSENT_WIDGET_HTML;