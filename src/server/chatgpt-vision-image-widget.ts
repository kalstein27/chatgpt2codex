export const CHATGPT_VISION_IMAGE_WIDGET_URI = "ui://widget/c2ct-vision-image.html";
export const CHATGPT_VISION_IMAGE_WIDGET_MIME = "text/html;profile=mcp-app";
export const CHATGPT_VISION_IMAGE_META_KEY = "chatgpt2codex/vision-image";

export const CHATGPT_VISION_IMAGE_WIDGET_RESOURCE_META = {
  "openai/widgetDescription": "Transfers one project image into the current ChatGPT conversation so the model can inspect the actual pixels.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
} as const;

export const CHATGPT_VISION_IMAGE_WIDGET_TOOL_META = {
  "openai/outputTemplate": CHATGPT_VISION_IMAGE_WIDGET_URI,
  ui: { visibility: ["model"], resourceUri: CHATGPT_VISION_IMAGE_WIDGET_URI },
} as const;

export const CHATGPT_VISION_IMAGE_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: transparent; }
  #card { padding: 10px 12px; }
  #status { font-size: 14px; line-height: 1.35; font-weight: 600; }
  #detail { display: none; }
</style>
</head>
<body>
<div id="card">
  <div id="status">이미지 준비 중…</div>
  <div id="detail"></div>
</div>
<script>
(function () {
  var latestToolOutput = null;
  var latestToolMeta = null;
  var bridgeInFlight = false;
  var followUpInFlight = false;
  var META_KEY = ${JSON.stringify(CHATGPT_VISION_IMAGE_META_KEY)};

  function api() { return window.openai || {}; }
  function output() { return latestToolOutput || api().toolOutput || {}; }
  function responseMeta() { return latestToolMeta || api().toolResponseMetadata || {}; }
  function text(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value || "";
  }
  function payload() {
    var meta = responseMeta();
    var value = meta && meta[META_KEY];
    return value && typeof value === "object" ? value : null;
  }
  function currentBridgeState() {
    var state = api().widgetState;
    if (!state || typeof state !== "object") return null;
    var privateContent = state.privateContent;
    if (!privateContent || typeof privateContent !== "object") return null;
    var bridge = privateContent.c2ctVisionBridge;
    return bridge && typeof bridge === "object" ? bridge : null;
  }
  function writeState(p, fileId, status, followUpSent) {
    var a = api();
    if (typeof a.setWidgetState !== "function") return false;
    a.setWidgetState({
      modelContent: p.prompt || "C2CT에서 전달한 이미지를 실제 픽셀 기준으로 분석하세요.",
      privateContent: {
        c2ctVisionBridge: {
          version: 1,
          sha256: p.sha256,
          fileId: fileId || null,
          fileName: p.fileName,
          mime: p.mime,
          status: status,
          followUpSent: !!followUpSent
        }
      },
      imageIds: fileId ? [fileId] : []
    });
    return true;
  }
  function dataUrlToFile(p) {
    if (!p.dataUrl || typeof p.dataUrl !== "string") throw new Error("missing image data");
    var expectedPrefix = "data:" + p.mime + ";base64,";
    if (p.dataUrl.indexOf(expectedPrefix) !== 0) throw new Error("image MIME mismatch");
    var raw = atob(p.dataUrl.slice(expectedPrefix.length));
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return new File([bytes], p.fileName || "c2ct-image", { type: p.mime });
  }
  async function sendFollowUp(p, fileId) {
    if (followUpInFlight) return;
    var a = api();
    if (typeof a.sendFollowUpMessage !== "function") {
      text("status", "이미지 연결 완료");
      writeState(p, fileId, "attached", false);
      return;
    }
    followUpInFlight = true;
    try {
      await a.sendFollowUpMessage({
        prompt: p.prompt || "C2CT가 방금 전달한 이미지를 실제 픽셀 기준으로 확인해줘. 파일 경로나 메타데이터가 아니라 이미지 내용 자체를 보고 설명해줘.",
        scrollToBottom: true
      });
      writeState(p, fileId, "attached", true);
      text("status", "이미지 전달 완료");
    } catch (_) {
      writeState(p, fileId, "attached", false);
      text("status", "이미지 연결됨 · 분석 요청 필요");
    } finally {
      followUpInFlight = false;
    }
  }
  async function bridge() {
    if (bridgeInFlight) return;
    var p = payload();
    if (!p) {
      text("status", "이미지 대기 중…");
      return;
    }
    var a = api();
    if (typeof a.uploadFile !== "function" || typeof a.setWidgetState !== "function") {
      text("status", "Vision 전달 미지원");
      return;
    }
    var existing = currentBridgeState();
    if (existing && existing.sha256 === p.sha256 && existing.fileId) {
      text("status", existing.followUpSent ? "이미지 전달 완료" : "연결 복구 중…");
      if (!existing.followUpSent) await sendFollowUp(p, existing.fileId);
      return;
    }
    bridgeInFlight = true;
    try {
      text("status", "이미지 연결 중…");
      var file = dataUrlToFile(p);
      var uploaded = await a.uploadFile(file);
      var fileId = uploaded && uploaded.fileId;
      if (!fileId) throw new Error("upload did not return fileId");
      writeState(p, fileId, "attached", false);
      text("status", "분석 요청 중…");
      await sendFollowUp(p, fileId);
    } catch (_) {
      text("status", "이미지 전달 실패");
    } finally {
      bridgeInFlight = false;
    }
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/tool-result") {
      var params = message.params || {};
      latestToolOutput = params.structuredContent || {};
      latestToolMeta = params._meta || latestToolMeta;
      void bridge();
    }
  }, { passive: true });
  window.addEventListener("openai:set_globals", function () { void bridge(); });
  void bridge();
})();
</script>
</body>
</html>
`;
