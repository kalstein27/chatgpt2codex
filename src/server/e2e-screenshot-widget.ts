import { CHATGPT_CONSENT_META_KEY } from "./chatgpt-consent-widget.js";

export const E2E_SCREENSHOT_WIDGET_URI = "ui://widget/e2e-screenshots.html";
export const E2E_SCREENSHOT_WIDGET_MIME = "text/html;profile=mcp-app";
export const E2E_SCREENSHOT_META_KEY = "chatgpt2codex/screenshots";
export const E2E_WIDGET_TOOL_META = {
  "openai/outputTemplate": E2E_SCREENSHOT_WIDGET_URI,
  ui: { visibility: ["model"], resourceUri: E2E_SCREENSHOT_WIDGET_URI },
} as const;

export const E2E_SCREENSHOT_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: transparent; }
  #status { font-size: 13px; color: #8e8ea0; margin: 8px 10px; }
  #grid { display: flex; flex-direction: column; gap: 10px; padding: 0 10px 10px; }
  #consent { display: none; border: 1px solid rgba(128,128,128,.35); border-radius: 12px; padding: 14px; margin: 4px; }
  #consentTitle { font-weight: 650; font-size: 15px; margin-bottom: 6px; }
  #consentPreview { font-size: 13px; line-height: 1.45; opacity: .82; white-space: pre-wrap; }
  #consentActions { display: flex; gap: 8px; margin-top: 12px; }
  #consentActions button { flex: 1; min-height: 38px; border-radius: 9px; border: 1px solid rgba(128,128,128,.35); font: inherit; cursor: pointer; }
  #consentActions button:disabled { opacity: .5; cursor: default; }
  #consentStatus { font-size: 12px; opacity: .72; margin-top: 9px; min-height: 18px; }
  figure { margin: 0; }
  img { width: 100%; border-radius: 8px; border: 1px solid rgba(128, 128, 128, 0.35); display: block; }
  figcaption { font-size: 12px; color: #8e8ea0; margin-top: 4px; }
</style>
</head>
<body>
<div id="consent">
  <div id="consentTitle">확인</div>
  <div id="consentPreview">승인 내용을 불러오는 중…</div>
  <div id="consentActions">
    <button id="consentDeny">거절</button>
    <button id="consentAllow">허용</button>
  </div>
  <div id="consentStatus"></div>
</div>
<div id="status">Loading E2E screenshots...</div>
<div id="grid"></div>
<script>
(function () {
  var consentBusy = false;
  var latestToolOutput = null;
  var latestToolMeta = null;
  var pendingRequests = new Map();
  var nextRequestId = 1;
  function api() { return window.openai || {}; }
  function output() { return latestToolOutput || api().toolOutput || {}; }
  function responseMeta() { return latestToolMeta || api().toolResponseMetadata || {}; }
  function request(method, params) {
    var id = nextRequestId++;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
    return new Promise(function (resolve, reject) {
      pendingRequests.set(id, { resolve: resolve, reject: reject });
    });
  }
  function consentSecret() {
    return responseMeta()["${CHATGPT_CONSENT_META_KEY}"] || {};
  }
  function setConsentBusy(value) {
    consentBusy = value;
    document.getElementById("consentDeny").disabled = value;
    document.getElementById("consentAllow").disabled = value;
  }
  async function callConsentDecision(decision, out, sec) {
    var args = { requestId: out.requestId, token: sec.token, decision: decision };
    var a = api();
    if (a.callTool) return a.callTool("chatgpt_consent_probe_decide", args);
    return request("tools/call", { name: "chatgpt_consent_probe_decide", arguments: args });
  }
  async function decideConsent(decision) {
    if (consentBusy) return;
    var out = output();
    var sec = consentSecret();
    if (!out.requestId || !sec.token) {
      document.getElementById("consentStatus").textContent = "확인 채널을 사용할 수 없습니다.";
      return;
    }
    setConsentBusy(true);
    document.getElementById("consentStatus").textContent = "처리 중…";
    try {
      await callConsentDecision(decision, out, sec);
      document.getElementById("consentStatus").textContent = decision === "allow" ? "허용됨" : "거절됨";
      var a = api();
      if (a.sendFollowUpMessage) {
        await a.sendFollowUpMessage({ prompt: "C2CT 인라인 확인 테스트 결과를 확인해줘." });
      }
    } catch (_) {
      document.getElementById("consentStatus").textContent = "처리하지 못했습니다.";
      setConsentBusy(false);
    }
  }
  function shotList() {
    var shots = responseMeta()["${E2E_SCREENSHOT_META_KEY}"];
    if (Array.isArray(shots) && shots.length) return shots;
    var out = output();
    var set = Array.isArray(out.screenshotSet) ? out.screenshotSet : out.inlineUrl ? [out] : [];
    return set.map(function (s, i) {
      return { label: s.shotLabel || "E2E screenshot " + (i + 1), url: s.inlineUrl };
    });
  }
  function render() {
    var out = output();
    if (out.c2ctConsentProbe === true) {
      document.getElementById("consent").style.display = "block";
      document.getElementById("status").style.display = "none";
      document.getElementById("grid").style.display = "none";
      document.getElementById("consentPreview").textContent = out.preview || "무해한 C2CT 인라인 확인 테스트";
      return;
    }
    document.getElementById("consent").style.display = "none";
    document.getElementById("status").style.display = "block";
    document.getElementById("grid").style.display = "flex";
    var shots = shotList();
    var grid = document.getElementById("grid");
    grid.textContent = "";
    var shown = 0;
    shots.forEach(function (shot, i) {
      var src = shot.dataUri || shot.url;
      if (!src) return;
      var fig = document.createElement("figure");
      var img = document.createElement("img");
      img.alt = shot.label || "E2E screenshot " + (i + 1);
      img.src = src;
      if (shot.dataUri && shot.url) {
        img.onerror = function () {
          if (img.src !== shot.url) img.src = shot.url;
        };
      }
      fig.appendChild(img);
      var cap = document.createElement("figcaption");
      cap.textContent = shot.label || "E2E screenshot " + (i + 1);
      fig.appendChild(cap);
      grid.appendChild(fig);
      shown += 1;
    });
    document.getElementById("status").textContent = shown
      ? shown + " E2E screenshot" + (shown > 1 ? "s" : "")
      : "No screenshots returned.";
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
  document.getElementById("consentDeny").addEventListener("click", function () { void decideConsent("deny"); });
  document.getElementById("consentAllow").addEventListener("click", function () { void decideConsent("allow"); });
  window.addEventListener("openai:set_globals", render);
  render();
})();
</script>
</body>
</html>
`;
