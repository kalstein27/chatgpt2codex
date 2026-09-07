export const CHATGPT_WIDGET_CAPABILITY_LAB_VERSION = 1;
export const CHATGPT_WIDGET_CAPABILITY_LAB_URI = `ui://widget/c2ct-widget-capability-lab-v${CHATGPT_WIDGET_CAPABILITY_LAB_VERSION}.html`;
export const CHATGPT_WIDGET_CAPABILITY_LAB_MIME = "text/html;profile=mcp-app";

export const CHATGPT_WIDGET_CAPABILITY_LAB_RESOURCE_META = {
  "openai/widgetDescription": "C2CT Widget Capability Lab for safe in-chat host, action, layout, and model-blind input experiments.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
  ui: {
    prefersBorder: true,
    csp: { connectDomains: [], resourceDomains: [] },
  },
} as const;

export function summarizeWidgetLabSyntheticSecret(secretValue: string): {
  length: number;
  syntheticExampleMatched: boolean;
  plaintextReturned: false;
  persisted: false;
} {
  return {
    length: secretValue.length,
    syntheticExampleMatched: secretValue === "banana-7291-test",
    plaintextReturned: false,
    persisted: false,
  };
}

export const CHATGPT_WIDGET_CAPABILITY_LAB_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { box-sizing: border-box; padding: 6px 4px 4px; font-family: -apple-system, system-ui, sans-serif; color: inherit; }
  .lab { border: 1px solid rgba(128,128,128,.35); border-radius: 12px; overflow: hidden; }
  .top { padding: 14px 14px 10px; }
  .title { font-size: 16px; line-height: 1.3; font-weight: 700; }
  .subtitle { margin-top: 4px; font-size: 12px; line-height: 1.4; opacity: .7; }
  .version { margin-top: 3px; font-size: 10px; line-height: 1.4; opacity: .58; }
  .tabs { display: flex; gap: 6px; padding: 0 14px 12px; }
  .tab { flex: 1; min-height: 34px; border-radius: 8px; border: 1px solid rgba(128,128,128,.3); background: transparent; color: inherit; font: inherit; font-size: 12px; }
  .tab[aria-selected="true"] { font-weight: 700; background: rgba(128,128,128,.14); }
  .pane { display: none; padding: 0 14px 14px; }
  .pane.active { display: block; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px 10px; align-items: baseline; }
  .key { font-size: 12px; opacity: .68; }
  .value { max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; text-align: right; }
  .actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .action { min-height: 40px; border-radius: 9px; border: 1px solid rgba(128,128,128,.35); color: inherit; font: inherit; }
  .status { min-height: 18px; margin-top: 9px; font-size: 12px; line-height: 1.4; opacity: .75; white-space: pre-wrap; }
  .secret-note { font-size: 12px; line-height: 1.45; opacity: .72; margin-bottom: 10px; }
  .secret-row { display: flex; gap: 8px; }
  .secret-row input { min-width: 0; flex: 1; min-height: 40px; box-sizing: border-box; border: 1px solid rgba(128,128,128,.35); border-radius: 9px; padding: 0 10px; background: transparent; color: inherit; font: inherit; }
  .secret-row button { flex: none; min-height: 40px; border-radius: 9px; border: 1px solid rgba(128,128,128,.35); color: inherit; font: inherit; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .badge { border: 1px solid rgba(128,128,128,.3); border-radius: 999px; padding: 4px 7px; font-size: 11px; opacity: .82; }
</style>
</head>
<body>
<div class="lab">
  <div class="top">
    <div class="title">C2CT Widget Capability Lab</div>
    <div class="subtitle">안전한 인라인 위젯 기능 실험 · Lab v${CHATGPT_WIDGET_CAPABILITY_LAB_VERSION}</div>
    <div class="version">Lab v${CHATGPT_WIDGET_CAPABILITY_LAB_VERSION} · Standalone UI v${CHATGPT_WIDGET_CAPABILITY_LAB_VERSION}</div>
  </div>
  <div class="tabs" role="tablist">
    <button class="tab" data-tab="host" aria-selected="true">Host</button>
    <button class="tab" data-tab="actions" aria-selected="false">Actions</button>
    <button class="tab" data-tab="secret" aria-selected="false">Secret</button>
  </div>
  <section class="pane active" data-pane="host">
    <div class="grid" id="host-grid"></div>
    <div class="badges" id="host-badges"></div>
  </section>
  <section class="pane" data-pane="actions">
    <div class="actions">
      <button class="action" id="server-ping">Server ping</button>
      <button class="action" id="follow-up">Follow-up</button>
      <button class="action" id="fullscreen">Fullscreen</button>
      <button class="action" id="approval-demo">Approval probe</button>
    </div>
    <div class="status" id="action-status"></div>
  </section>
  <section class="pane" data-pane="secret">
    <div class="secret-note">테스트 문자열은 app-only callback으로만 전달되고 모델 출력, follow-up, widget state, 브라우저 저장소에는 기록하지 않습니다. 권장 테스트값: banana-7291-test</div>
    <div class="secret-row">
      <input id="secret-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="banana-7291-test">
      <button id="secret-send">Relay</button>
    </div>
    <div class="status" id="secret-status"></div>
  </section>
</div>
<script>
(function () {
  var pendingRequests = new Map();
  var nextRequestId = 1;
  var mcpAppsReady = null;
  var mcpHostCapabilities = {};
  var heightFrame = 0;
  var lastHeight = 0;

  function api() { return window.openai || {}; }
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
  function ensureMcpAppsReady() {
    if (mcpAppsReady) return mcpAppsReady;
    mcpAppsReady = request("ui/initialize", {
      appInfo: { name: "C2CT Widget Capability Lab", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26"
    }).then(function (result) {
      mcpHostCapabilities = result && result.hostCapabilities ? result.hostCapabilities : {};
      notify("ui/notifications/initialized", {});
      renderHost();
      scheduleHeight();
      return mcpHostCapabilities;
    }).catch(function (error) {
      mcpAppsReady = null;
      throw error;
    });
    return mcpAppsReady;
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
      var capabilities = await ensureMcpAppsReady();
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
    if (typeof a.callTool === "function") {
      try {
        // Await the compatibility fallback so its rejection is visible as a
        // separate diagnostic leg; success behavior is unchanged.
        return await a.callTool(name, args || {});
      } catch (error) {
        throw bridgeFailureError(mcpState, mcpError, "callTool-rejected", error);
      }
    }
    throw bridgeFailureError(mcpState, mcpError, "callTool-unavailable", null);
  }
  function structured(result) {
    if (!result || typeof result !== "object") return {};
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    return result;
  }
  function text(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value || "";
  }
  function yesNo(value) { return value ? "✅" : "❌"; }
  function scalar(value) {
    if (value === undefined || value === null || value === "") return "unknown";
    if (typeof value === "object") {
      try { return JSON.stringify(value); } catch (_) { return "object"; }
    }
    return String(value);
  }
  function renderHost() {
    var a = api();
    var rows = [
      ["theme", scalar(a.theme)],
      ["displayMode", scalar(a.displayMode)],
      ["locale", scalar(a.locale)],
      ["maxHeight", scalar(a.maxHeight)],
      ["safeArea", scalar(a.safeArea)],
      ["userAgent", scalar(a.userAgent || navigator.userAgent)]
    ];
    var grid = document.getElementById("host-grid");
    grid.replaceChildren();
    rows.forEach(function (row) {
      var key = document.createElement("div");
      key.className = "key";
      key.textContent = row[0];
      var value = document.createElement("div");
      value.className = "value";
      value.textContent = row[1];
      grid.append(key, value);
    });
    var badges = document.getElementById("host-badges");
    badges.replaceChildren();
    [
      ["callTool", typeof a.callTool === "function" || !!mcpHostCapabilities.serverTools],
      ["follow-up", typeof a.sendFollowUpMessage === "function"],
      ["fullscreen", typeof a.requestDisplayMode === "function"],
      ["widgetState", typeof a.setWidgetState === "function"]
    ].forEach(function (item) {
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = yesNo(item[1]) + " " + item[0];
      badges.appendChild(badge);
    });
  }
  async function serverPing() {
    text("action-status", "서버 callback 확인 중…");
    try {
      var result = structured(await callServerTool("chatgpt_widget_lab_action", { action: "ping" }));
      text("action-status", result.ok ? "✅ app-only server callback 도달" : "⚠️ callback 응답 확인 필요");
    } catch (error) {
      text("action-status", "❌ " + (error && error.message ? error.message : "server callback failed"));
    }
    scheduleHeight();
  }
  async function sendFollowUp() {
    var a = api();
    if (typeof a.sendFollowUpMessage !== "function") {
      text("action-status", "❌ follow-up API 미지원");
      return;
    }
    try {
      await a.sendFollowUpMessage({ prompt: "C2CT Widget Capability Lab follow-up 테스트가 도착했어. 기능 확인만 짧게 알려줘." });
      text("action-status", "✅ follow-up 요청 전송");
    } catch (_) {
      text("action-status", "⚠️ follow-up 요청 실패");
    }
  }
  async function requestFullscreen() {
    var a = api();
    if (typeof a.requestDisplayMode !== "function") {
      text("action-status", "❌ fullscreen API 미지원");
      return;
    }
    try {
      await a.requestDisplayMode({ mode: "fullscreen" });
      text("action-status", "✅ fullscreen 요청 전달");
    } catch (_) {
      try {
        await a.requestDisplayMode("fullscreen");
        text("action-status", "✅ fullscreen 요청 전달");
      } catch (_) {
        text("action-status", "⚠️ fullscreen 요청 거절/실패");
      }
    }
  }
  async function approvalProbe() {
    text("action-status", "승인 primitive 호출 중…");
    try {
      var result = structured(await callServerTool("chatgpt_consent_probe", {}));
      var requestId = typeof result.requestId === "string" ? result.requestId : "created";
      text("action-status", "✅ approval primitive 생성 · " + requestId);
    } catch (error) {
      text("action-status", "❌ " + (error && error.message ? error.message : "approval probe failed"));
    }
  }
  async function relaySecret() {
    var input = document.getElementById("secret-input");
    var secretValue = input.value;
    if (!secretValue) {
      text("secret-status", "테스트 문자열을 입력해줘.");
      return;
    }
    input.value = "";
    text("secret-status", "app-only relay 확인 중…");
    try {
      var result = structured(await callServerTool("chatgpt_widget_lab_action", {
        action: "secret-relay",
        secretValue: secretValue
      }));
      secretValue = "";
      var matched = result.syntheticExampleMatched ? "synthetic match ✅" : "synthetic match —";
      text("secret-status", "✅ plaintext 미반환 · length " + scalar(result.length) + " · " + matched);
    } catch (error) {
      secretValue = "";
      text("secret-status", "❌ relay 실패 · 입력값은 표시하지 않음");
    }
    scheduleHeight();
  }
  function reportHeight() {
    heightFrame = 0;
    var height = Math.ceil(document.body.scrollHeight);
    if (!Number.isFinite(height) || height <= 0 || Math.abs(height - lastHeight) < 1) return;
    lastHeight = height;
    var a = api();
    if (typeof a.notifyIntrinsicHeight === "function") a.notifyIntrinsicHeight(height);
    if (mcpAppsReady) {
      void mcpAppsReady.then(function () {
        notify("ui/notifications/size-changed", { height: height });
      }).catch(function () {});
    }
  }
  function scheduleHeight() {
    if (heightFrame) cancelAnimationFrame(heightFrame);
    heightFrame = requestAnimationFrame(reportHeight);
  }
  function selectTab(name) {
    document.querySelectorAll(".tab").forEach(function (button) {
      button.setAttribute("aria-selected", button.getAttribute("data-tab") === name ? "true" : "false");
    });
    document.querySelectorAll(".pane").forEach(function (pane) {
      pane.classList.toggle("active", pane.getAttribute("data-pane") === name);
    });
    scheduleHeight();
  }

  document.querySelectorAll(".tab").forEach(function (button) {
    button.addEventListener("click", function () { selectTab(button.getAttribute("data-tab")); });
  });
  document.getElementById("server-ping").addEventListener("click", function () { void serverPing(); });
  document.getElementById("follow-up").addEventListener("click", function () { void sendFollowUp(); });
  document.getElementById("fullscreen").addEventListener("click", function () { void requestFullscreen(); });
  document.getElementById("approval-demo").addEventListener("click", function () { void approvalProbe(); });
  document.getElementById("secret-send").addEventListener("click", function () { void relaySecret(); });
  document.getElementById("secret-input").addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); void relaySecret(); }
  });
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pendingRequests.has(message.id)) {
      var pending = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result);
    }
  }, { passive: true });
  window.addEventListener("openai:set_globals", function () { renderHost(); scheduleHeight(); });
  window.addEventListener("resize", scheduleHeight, { passive: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(scheduleHeight).observe(document.querySelector(".lab"));
  void ensureMcpAppsReady().catch(function () { renderHost(); });
  renderHost();
  scheduleHeight();
})();
</script>
</body>
</html>`;
