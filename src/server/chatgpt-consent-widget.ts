import { createHash } from "node:crypto";
import {
  CHATGPT_OPERATION_APPROVAL_USER_PROMPTS,
  CHATGPT_STANDARD_CONSENT_USER_PROMPTS,
} from "./chatgpt-card-prompts.js";

// Shared card HTML is embedded in both the loader fallback and the immutable
// approval document. Keep their host resource identities in sync when that
// bundled document changes; its content hash remains the asset revision.
export const CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION = 31;
export const CHATGPT_OPERATION_APPROVAL_PRESENTER_TOOL =
  `chatgpt_operation_approval_presenter_v${CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION}`;
export const CHATGPT_OPERATION_APPROVAL_WIDGET_URI =
  `ui://widget/c2ct-operation-approval-v${CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION}.html`;
export const CHATGPT_OPERATION_APPROVAL_WIDGET_RESOURCE_NAME =
  `c2ct-operation-approval-widget-v${CHATGPT_OPERATION_APPROVAL_WIDGET_VERSION}`;

export const CHATGPT_WIDGET_PREAPPLY_PRESENTER_VERSION = 2;
export const CHATGPT_WIDGET_PREAPPLY_PRESENTER_TOOL =
  `chatgpt_widget_preapply_presenter_v${CHATGPT_WIDGET_PREAPPLY_PRESENTER_VERSION}`;
export const CHATGPT_WIDGET_PREAPPLY_WIDGET_URI =
  `ui://widget/c2ct-widget-preapply-v${CHATGPT_WIDGET_PREAPPLY_PRESENTER_VERSION}.html`;
export const CHATGPT_WIDGET_PREAPPLY_WIDGET_RESOURCE_NAME =
  `c2ct-widget-preapply-v${CHATGPT_WIDGET_PREAPPLY_PRESENTER_VERSION}`;
export const CHATGPT_CONSENT_WIDGET_LAB_VERSION = 9;
export const CHATGPT_CONSENT_WIDGET_LOADER_VERSION = 15;
// Keep previous loader-mounted addresses available as stale-host compatibility
// aliases. The current shared Widget Shell/consent presenter also uses a
// versioned loader so hot-applied card HTML is fetched at mount.
export const CHATGPT_CONSENT_WIDGET_PREVIOUS_LOADER_URI = "ui://widget/c2ct-consent-loader-v14.html";
export const CHATGPT_CONSENT_WIDGET_LEGACY_LOADER_URI = "ui://widget/c2ct-consent-loader-v13.html";
export const CHATGPT_CONSENT_WIDGET_LEGACY_URI = "ui://widget/c2ct-consent-v8.html";
export const CHATGPT_CONSENT_WIDGET_LAB_LEGACY_URI =
  `ui://widget/c2ct-consent-v${CHATGPT_CONSENT_WIDGET_LAB_VERSION}.html`;
export const CHATGPT_CONSENT_WIDGET_MIME = "text/html;profile=mcp-app";
export const CHATGPT_CONSENT_META_KEY = "chatgpt2codex/consent";
export const CHATGPT_WIDGET_ASSET_PROTOCOL_VERSION = 1;
export const CHATGPT_WIDGET_ASSET_GET_TOOL = "chatgpt_widget_asset_get";
export const CHATGPT_APPROVAL_CLIENT_PHASES = [
  "mounted", "click", "duplicate_click_ignored", "bridge_selected", "bridge_unavailable",
  "promise_created", "bridge_threw", "bridge_resolved", "bridge_rejected", "bridge_pending_timeout",
  "authoritative_pending", "authoritative_allowed", "authoritative_denied", "authoritative_consumed",
  "authoritative_expired", "authoritative_missing", "recovered_pending", "server_received_unresolved",
  "remount_reconcile", "status_unavailable", "gesture_armed", "gesture_consumed",
  "gesture_blocked_untrusted", "gesture_blocked_unarmed", "gesture_blocked_inactive",
] as const;
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

const CHATGPT_CONSENT_WIDGET_LOADER_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { box-sizing: border-box; padding: 8px 10px; font-family: -apple-system, system-ui, sans-serif; color: #111827; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f5; } }
  body[data-host-theme="light"] { color: #111827; }
  body[data-host-theme="dark"] { color: #f5f5f5; }
  #status { box-sizing: border-box; min-height: 28px; display: flex; align-items: center; padding: 0; background: transparent; border: 0; border-radius: 0; font-size: 12.5px; line-height: 1.4; opacity: .78; }
</style>
</head>
<body>
<div id="status">카드 로딩 중</div>
<script>
(function () {
  var initialHostTheme = window.openai && window.openai.theme;
  if (initialHostTheme === "light" || initialHostTheme === "dark") document.body.setAttribute("data-host-theme", initialHostTheme);
  var pending = new Map();
  var nextId = 1;
  var presenterBootstrap = null;
  var bundledFallbackBase64 = "__C2CT_BUNDLED_FALLBACK_BASE64__";
  var bundledFallbackRevision = "__C2CT_BUNDLED_FALLBACK_REVISION__";
  var assetLoadStarted = false;
  var expectedActiveRevision = "";
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
  function presenterBootstrapTerminalLabel(out) {
    if (!out || typeof out !== "object") return "";
    var presentationKind = typeof out.presentationKind === "string" ? out.presentationKind : "";
    // Preapply exists specifically to prove that the active card asset can load.
    // Capability Lab likewise needs its dedicated full resource. Neither may be
    // short-circuited by cached presenter metadata.
    if (presentationKind === "widget-preapply-load-only" || presentationKind === "widget-capability-lab") return "";
    var status = typeof out.status === "string" ? out.status : "";
    if (status === "allowed" || status === "approved") return "승인 완료";
    if (status === "denied" || status === "rejected") return "거절 완료";
    if (status === "consumed" || status === "completed") return "처리 완료";
    if (status === "expired") return "카드 만료 · 새 요청이 필요합니다.";
    if (status === "missing") return "승인 기록 없음 · 새 요청이 필요합니다.";
    var card = out.card && typeof out.card === "object" ? out.card : null;
    if (card && card.status === "resolved") return "처리 완료";
    var pendingLike = status === "pending" || Boolean(card && card.status === "pending");
    if (!pendingLike) return "";
    var expiresAt = Number(card && card.expiresAt ? card.expiresAt : out.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return "";
    var serverNow = Number(out.serverNow || 0);
    if (Number.isFinite(serverNow) && serverNow > 0 && serverNow >= expiresAt) {
      return "카드 만료 · 새 요청이 필요합니다.";
    }
    // Client-clock expiry is display-only and never authorizes a mutation. The
    // same grace used by the full card absorbs ordinary clock skew while still
    // avoiding asset/bridge work for clearly stale cached cards.
    var clientNow = Date.now();
    if (Number.isFinite(clientNow) && clientNow >= expiresAt + 30000) {
      return "카드 만료 · 새 요청이 필요합니다.";
    }
    return "";
  }
  function renderPresenterBootstrapTerminal() {
    var out = presenterBootstrap && presenterBootstrap.toolOutput;
    var label = presenterBootstrapTerminalLabel(out);
    if (!label) return false;
    var status = document.getElementById("status");
    if (status) status.textContent = label;
    return true;
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
  function bundledFallbackHtml() {
    try {
      var binary = atob(bundledFallbackBase64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      if (typeof TextDecoder === "function") return new TextDecoder("utf-8").decode(bytes);
      var encoded = "";
      for (var j = 0; j < bytes.length; j += 1) {
        var hex = bytes[j].toString(16);
        encoded += "%" + (hex.length === 1 ? "0" + hex : hex);
      }
      return decodeURIComponent(encoded);
    } catch (_) {
      return "";
    }
  }
  function installCardHtml(html) {
    if (typeof html !== "string" || !html) throw new Error("widget asset HTML unavailable");
    captureOpenAiBootstrap();
    if (presenterBootstrap) window.__c2ctPresenterBootstrapV1 = presenterBootstrap;
    var loaderStatus = document.getElementById("status");
    if (loaderStatus && loaderStatus.style) loaderStatus.style.display = "none";
    document.open();
    document.write(html);
    document.close();
  }
  function isIosLikeLoaderClient() {
    var nav = typeof navigator === "object" && navigator ? navigator : null;
    if (!nav) return false;
    var ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
    var platform = typeof nav.platform === "string" ? nav.platform : "";
    var uaPlatform = nav.userAgentData && typeof nav.userAgentData.platform === "string" ? nav.userAgentData.platform : "";
    var maxTouchPoints = Number(nav.maxTouchPoints || 0);
    return /iPhone|iPad|iPod/i.test(ua)
      || /iPhone|iPad|iPod/i.test(platform)
      || /iOS/i.test(uaPlatform)
      || (platform === "MacIntel" && maxTouchPoints > 1);
  }
  async function loadThroughMcpApps(attempt) {
    var initialized = await request("ui/initialize", {
      appInfo: { name: "C2CT Widget Loader", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26"
    });
    if (attempt.cancelled) throw new Error("widget asset MCP attempt cancelled before dispatch");
    notify("ui/notifications/initialized", {});
    var capabilities = initialized && initialized.hostCapabilities ? initialized.hostCapabilities : {};
    if (!capabilities.serverTools) throw new Error("MCP Apps serverTools unavailable");
    if (attempt.cancelled) throw new Error("widget asset MCP attempt cancelled before dispatch");
    attempt.dispatched = true;
    return request("tools/call", { name: "${CHATGPT_WIDGET_ASSET_GET_TOOL}", arguments: {} });
  }
  function loadThroughNative(a, attempt) {
    var pendingResult = a.callTool("${CHATGPT_WIDGET_ASSET_GET_TOOL}", {});
    attempt.dispatched = true;
    return Promise.resolve(pendingResult);
  }
  async function load() {
    if (assetLoadStarted) return;
    assetLoadStarted = true;
    var result;
    // Snapshot the original presenter payload before the private asset_get call.
    // Host implementations may update window.openai.toolOutput to asset_get's
    // result, and document.write replaces the script that could otherwise hear
    // the one-shot presenter tool-result notification.
    captureOpenAiBootstrap();
    if (renderPresenterBootstrapTerminal()) return;
    var bootstrapOut = presenterBootstrap && presenterBootstrap.toolOutput;
    var bootstrapKind = bootstrapOut && typeof bootstrapOut.presentationKind === "string" ? bootstrapOut.presentationKind : "";
    var activeRevision = bootstrapOut && typeof bootstrapOut.widgetAssetRevision === "string" ? bootstrapOut.widgetAssetRevision : "";
    expectedActiveRevision = activeRevision;
    if (bootstrapKind !== "widget-preapply-load-only" && bootstrapKind !== "widget-capability-lab" && activeRevision && activeRevision === bundledFallbackRevision) {
      var bundledHtml = bundledFallbackHtml();
      if (bundledHtml) {
        installCardHtml(bundledHtml);
        return;
      }
    }
    var a = window.openai || {};
    var preferNative = isIosLikeLoaderClient() && typeof a.callTool === "function";
    if (preferNative) {
      var nativeAttempt = { dispatched: false, cancelled: false };
      try {
        result = await withTimeout(loadThroughNative(a, nativeAttempt), 5000);
      } catch (error) {
        if (nativeAttempt.dispatched) throw error;
        nativeAttempt.cancelled = true;
        var nativeFallbackMcpAttempt = { dispatched: false, cancelled: false };
        result = await withTimeout(loadThroughMcpApps(nativeFallbackMcpAttempt), 5000).catch(function (mcpError) {
          nativeFallbackMcpAttempt.cancelled = true;
          throw mcpError;
        });
      }
    } else {
      var mcpAttempt = { dispatched: false, cancelled: false };
      try {
        result = await withTimeout(loadThroughMcpApps(mcpAttempt), 5000);
      } catch (error) {
        if (mcpAttempt.dispatched || typeof a.callTool !== "function") throw error;
        mcpAttempt.cancelled = true;
        var mcpFallbackNativeAttempt = { dispatched: false, cancelled: false };
        result = await withTimeout(loadThroughNative(a, mcpFallbackNativeAttempt), 5000);
      }
    }
    var out = structured(result);
    installCardHtml(out.html);
  }
  void load().catch(function () {
    var bundledMatchesExpected = !expectedActiveRevision || expectedActiveRevision === bundledFallbackRevision;
    if (bundledMatchesExpected) {
      var fallbackHtml = bundledFallbackHtml();
      if (fallbackHtml) {
        try {
          installCardHtml(fallbackHtml);
          return;
        } catch (_) {}
      }
    }
    var status = document.getElementById("status");
    if (status) status.textContent = expectedActiveRevision
      ? "새 카드 자산 로딩 실패 · 이전 UI fallback 차단됨"
      : "카드 로딩 실패 · presenter/runtime 확인 필요";
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
  html, body { margin: 0; padding: 0; width: 100%; max-width: 100%; min-width: 0; background: transparent; }
  body { --c2ct-surface: #ffffff; --c2ct-critical-surface: #fff4f1; --c2ct-control-surface: #f8fafc; --c2ct-control-fg: #0a63c9; display: block; box-sizing: border-box; padding: 6px 4px 4px; font-family: -apple-system, system-ui, sans-serif; color: #111827; }
  @media (prefers-color-scheme: dark) { body { --c2ct-surface: #1c1c1e; --c2ct-critical-surface: #2b1d1b; --c2ct-control-surface: #2a2a2c; --c2ct-control-fg: #62a9ff; color: #f5f5f5; } }
  body[data-host-theme="light"] { --c2ct-surface: #ffffff; --c2ct-critical-surface: #fff4f1; --c2ct-control-surface: #f8fafc; --c2ct-control-fg: #0a63c9; color: #111827; }
  body[data-host-theme="dark"] { --c2ct-surface: #1c1c1e; --c2ct-critical-surface: #2b1d1b; --c2ct-control-surface: #2a2a2c; --c2ct-control-fg: #62a9ff; color: #f5f5f5; }
  .card { box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; overflow: hidden; border: 1px solid rgba(128,128,128,.35); border-radius: 13px; padding: 14px 15px 15px; margin: 0; color: inherit; background: var(--c2ct-surface); }
  .card.critical { border-color: rgba(220,72,48,.78); background: var(--c2ct-critical-surface); box-shadow: inset 0 0 0 1px rgba(220,72,48,.12); }
  .title-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 9px; }
  .title { min-width: 0; font-weight: 760; font-size: 16px; line-height: 1.35; }
  .title-state { flex: none; border-radius: 999px; padding: 4px 8px; background: rgba(128,128,128,.10); font-size: 12.5px; font-weight: 720; line-height: 1.35; opacity: .9; white-space: nowrap; }
  .card.preapply-minimal { padding: 10px 12px; }
  .card.preapply-minimal .title-row { margin-bottom: 0; }
  .card.preapply-minimal .title-state { padding: 0; background: transparent; font-size: 13.5px; opacity: .72; }
  .card.preapply-minimal #approval { display: none; }
  .critical-badge { display: inline-block; margin-bottom: 8px; border: 1px solid rgba(220,72,48,.72); border-radius: 999px; padding: 5px 9px; font-size: 12.5px; font-weight: 760; letter-spacing: .01em; }
  .critical-warning { margin-bottom: 10px; border-radius: 9px; padding: 10px 11px; background: rgba(220,72,48,.12); font-size: 13.5px; font-weight: 680; line-height: 1.5; overflow-wrap: anywhere; word-break: break-word; }
  .critical-meta { min-width: 0; margin: 8px 0 10px; border: 1px solid rgba(220,72,48,.24); border-radius: 9px; padding: 9px 10px; background: rgba(220,72,48,.05); font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; word-break: break-word; }
  .critical-meta-row { display: flex; min-width: 0; gap: 8px; align-items: flex-start; justify-content: space-between; }
  .critical-meta-key { opacity: .68; }
  .critical-meta-value { min-width: 0; max-width: 72%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 650; text-align: right; overflow-wrap: anywhere; word-break: break-word; }
  .entry-head { display: flex; min-width: 0; max-width: 100%; gap: 8px; align-items: flex-start; justify-content: space-between; }
  .preview { min-width: 0; max-width: 100%; font-size: 15.5px; font-weight: 700; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  .state { flex: none; font-size: 12px; font-weight: 650; opacity: .78; white-space: nowrap; }
  .approval-time { margin-top: 7px; font-size: 12.5px; line-height: 1.45; opacity: .66; overflow-wrap: anywhere; word-break: break-word; }
  .impact { margin-top: 8px; border-radius: 8px; padding: 8px 10px; background: rgba(128,128,128,.08); font-size: 13.5px; font-weight: 600; line-height: 1.5; opacity: .9; overflow-wrap: anywhere; word-break: break-word; }
  .approval-details { box-sizing: border-box; min-width: 0; max-width: 100%; margin-top: 9px; border: 1px solid rgba(128,128,128,.20); border-radius: 10px; padding: 0 10px; background: rgba(128,128,128,.035); }
  .approval-details summary { cursor: pointer; user-select: none; min-height: 44px; display: flex; align-items: center; list-style: none; padding: 9px 0; font-size: 13px; font-weight: 650; line-height: 1.4; opacity: .76; }
  .approval-details summary::-webkit-details-marker { display: none; }
  .approval-details summary::before { content: "›"; flex: 0 0 auto; margin-right: 7px; font-size: 20px; font-weight: 500; line-height: 1; transform: rotate(0deg); transform-origin: center; transition: transform 180ms ease; }
  .approval-details[open] summary::before { transform: rotate(90deg); }
  .detail-command { box-sizing: border-box; min-width: 0; max-width: 100%; max-height: 240px; overflow-y: auto; overflow-x: hidden; margin: 0 0 9px; padding: 9px 10px; border-radius: 7px; background: rgba(128,128,128,.10); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  button { flex: 1; min-height: 46px; border-radius: 10px; border: 1px solid rgba(128,128,128,.35); background: var(--c2ct-control-surface); color: var(--c2ct-control-fg); font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
  button.critical-allow { border-color: rgba(220,72,48,.85); background: rgba(220,72,48,.16); font-weight: 760; }
  button:disabled { opacity: .5; cursor: default; }
  .status { font-size: 13px; line-height: 1.45; opacity: .74; margin-top: 8px; overflow-wrap: anywhere; word-break: break-word; }
  .shell-prompt { font-size: 13px; line-height: 1.5; opacity: .86; white-space: pre-wrap; }
  .shell-options { display: grid; gap: 8px; margin-top: 11px; }
  .shell-option { display: block; width: 100%; min-height: 48px; padding: 9px 11px; text-align: left; background: var(--c2ct-control-surface); color: var(--c2ct-control-fg); }
  .shell-option-title { display: block; font-size: 13px; font-weight: 650; line-height: 1.35; }
  .shell-option-description { display: block; margin-top: 3px; font-size: 11px; line-height: 1.35; opacity: .65; }
  .card.shell-compact { border-color: transparent; padding: 2px 0; }
  .card.shell-compact #shell-status { display: none; }
  .card.shell-compact .shell-options { margin: 8px 0 0; }
  .card.shell-compact .shell-option {
    min-height: 44px;
    padding: 10px 12px;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    text-align: center;
  }
  .card.shell-compact .shell-option-title { font-size: clamp(20px, 2.2vw, 22px); font-weight: 740; line-height: 1.22; }
  .card.shell-compact .shell-option:active:not(:disabled) { opacity: .68; }
  .card.shell-compact .shell-option.shell-resolved:disabled { opacity: 1; }
  .card.shell-compact.shell-auto {
    --shell-auto-pad-y: clamp(14px, 2vw, 22px);
    border-color: rgba(128,128,128,.22);
    border-radius: clamp(15px, 1.8vw, 19px);
    padding: var(--shell-auto-pad-y) clamp(14px, 2vw, 20px) calc(var(--shell-auto-pad-y) - 4px);
  }
  .card.shell-compact.shell-auto .shell-options { gap: clamp(10px, 1.35vw, 14px); }
  .card.shell-compact.shell-auto .shell-option { min-height: 44px; padding: 10px 12px; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  .card.shell-compact.shell-auto .shell-option-title { font-size: clamp(20px, 2.2vw, 22px); font-weight: 740; line-height: 1.22; }
  .card.shell-compact.shell-auto #shell-status { display: none; }
  .card.shell-compact.shell-auto .shell-options.shell-auto-pair { grid-template-columns: minmax(0, 1fr); }
  .card.shell-compact.shell-auto .shell-cancel { color: inherit; opacity: .76; }
  @media (min-width: 600px) {
    .card.shell-compact.shell-auto { padding-left: clamp(18px, 2.3vw, 26px); padding-right: clamp(18px, 2.3vw, 26px); }
  }
  .shell-debug { margin-top: 7px; font-size: 10px; line-height: 1.4; opacity: .56; text-align: center; overflow-wrap: anywhere; }
  .card.reentry-compact { padding: 12px 13px 13px; }
  .card.reentry-compact .title-row { display: none; }
  .reentry-note { font-size: 13px; line-height: 1.55; opacity: .84; white-space: pre-wrap; }
  .reentry-token { width: 100%; box-sizing: border-box; margin-top: 10px; border: 1px solid rgba(128,128,128,.28); border-radius: 10px; padding: 10px 12px; background: rgba(128,128,128,.08); color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 15px; font-weight: 760; text-align: center; letter-spacing: .01em; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
  .reentry-token.copied { background: rgba(128,128,128,.16); }
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
    <div class="shell-debug" id="shell-debug"></div>
  </div>
  <div id="reentry" hidden>
    <div class="reentry-note" id="reentry-note"></div>
    <button type="button" class="reentry-token" id="reentry-token">@C2CT</button>
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
  var readOnlyToolBridge = null;
  var heightFrame = 0;
  var lastReportedHeight = 0;
  var presentationKind = null;
  var shellBusy = false;
  var reentryCopyFeedbackUntil = 0;
  var shellUnlockTimer = null;
  var shellUnlockCardId = null;
  var shellAutoContinueTimer = null;
  var shellAutoContinueCardId = null;
  var shellAutoContinuePaintArmCardId = null;
  var shellAutoContinuePaintArmGeneration = 0;
  var shellAutoContinuePaintStartedAtByCard = Object.create(null);
  var shellAutoContinueVisibilityObserver = null;
  var shellAutoContinueVisibilityCardId = null;
  var shellAutoContinueRenderCardId = null;
  var shellAutoContinueRenderStartedAt = null;
  var shellAutoContinueCancelledCardId = null;
  var shellAutoForegroundCardId = null;
  var shellAutoForegroundNotBefore = 0;
  var shellAutoForegroundSawHidden = false;
  var shellAutoForegroundArmedThisMount = false;
  var shellAutoViewportVisible = false;
  var shellAutoViewportSawHidden = false;
  var shellAutoContinueLastTickAt = null;
  var shellRemountResetStartedAtByCard = Object.create(null);
  var shellVisibilityPauseStoppedCardId = null;
  var shellPhase3IntersectionStoppedCardId = null;
  var shellSubmittedCardId = null;
  var approvalContinuationRequestId = null;
  var operationObserveTimer = null;
  var operationObserveInFlight = false;
  var operationObserveRequestId = null;
  var statusRefreshInFlight = false;
  var statusRefreshedRequestId = null;
  var statusRefreshAttempts = Object.create(null);
  var hydrationExhausted = false;
  var paintTelemetrySent = false;
  var openAiSetGlobalsCount = 0;
  var widgetStateWriteQueue = Promise.resolve();
  var approvalTrace = [];
  var localApprovalDecision = null;
  var localApprovalInteraction = null;
  var localFollowUpDiagnostic = null;
  var approvalAttemptSequence = 0;
  var previewMode = window.__C2CT_CARD_PREVIEW__ === true;
  function api() { return window.openai || {}; }
  function output() { return latestToolOutput || api().toolOutput || {}; }
  function responseMeta() { return latestToolMeta || api().toolResponseMetadata || {}; }
  function queueWidgetStateWrite(buildNext) {
    // setWidgetState is a synchronous snapshot API, not a transport/commit ack.
    // Invoke now (also preserving remount latches in the click stack). An
    // undocumented returned promise must never poison all subsequent writes.
    try {
      var a = api();
      if (typeof a.setWidgetState !== "function") return Promise.resolve();
      var current = a.widgetState && typeof a.widgetState === "object" && !Array.isArray(a.widgetState)
        ? a.widgetState
        : {};
      var next = buildNext(current);
      if (!next) return Promise.resolve();
      widgetStateWriteQueue = withTimeout(Promise.resolve(a.setWidgetState(next)), 250).catch(function () {});
    } catch (_) { widgetStateWriteQueue = Promise.resolve(); }
    return widgetStateWriteQueue;
  }
  function approvalEvent(target, phase, transport) {
    // Fixed phase/transport labels only: never record tokens, arguments, error
    // messages, chat text or host payloads. This is client evidence, NOT proof
    // of host dispatch; only the authenticated server receipt proves arrival.
    var trace = {
      event: "approval.client." + phase,
      attempt: target && target.attempt || 0,
      at: Date.now(),
      transport: transport || "none",
      userActivation: !!(navigator.userActivation && navigator.userActivation.isActive)
    };
    approvalTrace.push(trace);
    approvalTrace = approvalTrace.slice(-32);
    // Keep transport diagnostics in iframe-local memory on the hot path. The
    // bounded trace is piggy-backed onto the two remount-critical snapshots
    // (working interaction + authoritative terminal decision) instead of
    // writing widgetState for every click/bridge/status phase. Preserve a tiny
    // set of diagnostic checkpoints that existing integration/recovery tooling
    // needs to observe even when there is no decision latch yet.
    var checkpoint = phase === "mounted"
      || phase === "recovered_pending"
      || phase === "server_received_unresolved"
      || phase === "status_unavailable"
      || phase === "gesture_blocked_untrusted"
      || phase === "gesture_blocked_unarmed"
      || phase === "gesture_blocked_inactive";
    if (checkpoint) {
      void queueWidgetStateWrite(function (current) {
        return Object.assign({}, current, { c2ctApprovalTransport: {
          version: 1,
          requestId: target && target.requestId,
          events: approvalTrace.slice()
        } });
      });
    }
  }
  function armApprovalDecision(button, target, decision, event) {
    if (!target || target.status !== "pending") return;
    if (!event || event.isTrusted !== true) {
      approvalEvent(target, "gesture_blocked_untrusted");
      return;
    }
    var kind = "";
    if (event.type === "pointerdown") {
      if (typeof event.button === "number" && event.button !== 0) return;
      kind = "pointer";
    } else if (event.type === "keydown") {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      kind = "keyboard";
    }
    if (!kind) return;
    button.__c2ctApprovalArm = {
      requestId: target.requestId,
      decision: decision,
      kind: kind,
      armedAt: Date.now()
    };
    approvalEvent(target, "gesture_armed", kind);
  }
  function consumeApprovalDecision(button, target, decision, event) {
    var arm = button.__c2ctApprovalArm || null;
    button.__c2ctApprovalArm = null;
    if (!event || event.isTrusted !== true) {
      approvalEvent(target, "gesture_blocked_untrusted");
      return null;
    }
    var activation = !!(navigator.userActivation && navigator.userActivation.isActive);
    if (!activation) {
      approvalEvent(target, "gesture_blocked_inactive");
      return null;
    }
    var decidedAt = Date.now();
    if (!arm
      || arm.requestId !== target.requestId
      || arm.decision !== decision
      || decidedAt < arm.armedAt
      || decidedAt - arm.armedAt > 5000) {
      approvalEvent(target, "gesture_blocked_unarmed");
      return null;
    }
    approvalEvent(target, "gesture_consumed", arm.kind);
    return {
      version: 1,
      kind: arm.kind,
      trusted: true,
      userActivation: true,
      armedAt: arm.armedAt,
      decidedAt: decidedAt
    };
  }
  function bindApprovalDecisionButton(button, target, decision) {
    button.type = "button";
    button.addEventListener("pointerdown", function (event) { armApprovalDecision(button, target, decision, event); });
    button.addEventListener("keydown", function (event) { armApprovalDecision(button, target, decision, event); });
    button.addEventListener("click", function (event) {
      var interactionProof = consumeApprovalDecision(button, target, decision, event);
      if (!interactionProof) return;
      void decide(target, decision, interactionProof);
    });
  }
  function request(method, params) {
    var id = nextRequestId++;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pendingRequests.delete(id);
        reject(new Error("MCP Apps request timeout"));
      }, 5000);
      pendingRequests.set(id, {
        resolve: function (value) { clearTimeout(timer); resolve(value); },
        reject: function (error) { clearTimeout(timer); reject(error); }
      });
      try {
        window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(error);
      }
    });
  }
  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }
  function withTimeout(promise, timeoutMs) {
    var timer;
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(new Error("MCP Apps bridge timeout")); }, timeoutMs);
      })
    ]).finally(function () { clearTimeout(timer); });
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
    var previousLocal = localFollowUpDiagnostic && localFollowUpDiagnostic.requestId === requestId
      ? localFollowUpDiagnostic
      : {};
    localFollowUpDiagnostic = Object.assign({}, previousLocal, detail || {}, {
      version: 1,
      requestId: requestId,
      updatedAt: Date.now()
    });
    var phase = localFollowUpDiagnostic.phase || "";
    var terminalPhase = phase === "ack"
      || phase === "is-error"
      || phase === "rejected"
      || phase === "dispatch-error"
      || phase === "official-message-unavailable"
      || phase === "unavailable";
    if (!terminalPhase) return Promise.resolve();
    return queueWidgetStateWrite(function (current) {
      var previous = current.c2ctFollowUpDiagnostic && current.c2ctFollowUpDiagnostic.requestId === requestId
        ? current.c2ctFollowUpDiagnostic
        : {};
      return Object.assign({}, current, {
        c2ctFollowUpDiagnostic: Object.assign({}, previous, localFollowUpDiagnostic)
      });
    });
  }
  function beginFollowUpTurn(requestId, prompt, options) {
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
    if (options && options.officialOnly === true) {
      persistFollowUpDiagnostic(requestId, {
        transport: "none",
        phase: "official-message-unavailable",
        userActivation: activation,
        messageCapability: messageSupported
      });
      return Promise.resolve(false);
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
        return withTimeout(Promise.resolve(legacyPromise), 2000).then(function () {
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
    if (document.hidden === true) {
      reportIntrinsicHeight();
      return;
    }
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
    var mcpState = "initialize-not-attempted";
    var mcpError = null;
    var openaiTried = false;
    var openaiError = null;
    if (allowCrossBridgeFallback && readOnlyToolBridge === "openai" && a.callTool) {
      openaiTried = true;
      try {
        return await withTimeout(Promise.resolve(a.callTool(name, args || {})), 5000);
      } catch (error) {
        openaiError = error;
        readOnlyToolBridge = null;
      }
    }
    try {
      var capabilities = await withTimeout(ensureMcpAppsReady(), 2500);
      if (capabilities && capabilities.serverTools) {
        mcpState = "tools/call";
        try {
          // Regression guard: keep this await. On 2026-08-31 iOS, returning the
          // Promise directly skipped this catch on async rejection and silently
          // prevented the OpenAI bridge fallback from running.
          var mcpResult = await withTimeout(request("tools/call", { name: name, arguments: args || {} }), 5000);
          if (allowCrossBridgeFallback) readOnlyToolBridge = "mcp";
          return mcpResult;
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
    if (a.callTool && !openaiTried) {
      try {
        // Keep await here too so a rejected OpenAI fallback can be classified
        // separately from the MCP Apps failure instead of collapsing to one UI error.
        var openaiResult = await withTimeout(Promise.resolve(a.callTool(name, args || {})), 5000);
        if (allowCrossBridgeFallback) readOnlyToolBridge = "openai";
        return openaiResult;
      } catch (error) {
        throw bridgeFailureError(mcpState, mcpError, "callTool-rejected", error);
      }
    }
    if (openaiTried) throw bridgeFailureError(mcpState, mcpError, "callTool-rejected", openaiError);
    throw bridgeFailureError(mcpState, mcpError, "callTool-unavailable", null);
  }
  function stateLabel(status) {
    if (status === "allowed") return "승인 완료";
    if (status === "denied") return "거절 완료";
    if (status === "consumed") return "처리 완료";
    if (status === "expired") return "만료";
    if (status === "unavailable" || status === "missing") return "확인 불가";
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
  function mapPersistedStatus(status) {
    if (status === "approved" || status === "allowed") return "allowed";
    if (status === "rejected" || status === "denied") return "denied";
    if (status === "consumed") return "consumed";
    if (status === "expired") return "expired";
    if (status === "missing") return "missing";
    if (status === "pending") return "pending";
    return null;
  }
  function persistedStatusMessage(status) {
    if (status === "allowed") return "승인 완료 · 요청이 허용되었습니다.";
    if (status === "denied") return "거절 완료 · 요청은 실행되지 않았습니다.";
    if (status === "consumed") return "처리 완료 · 승인된 요청이 처리되었습니다.";
    if (status === "expired") return "승인 만료 · 이 카드는 더 이상 사용할 수 없습니다. 새 요청이 필요합니다.";
    if (status === "missing") return "승인 기록 없음 · 상태를 확인할 수 없습니다. 새 요청이 필요합니다.";
    return "";
  }
  function turnlessContinuationStallMessage(result) {
    var reason = result && typeof result.continuationReason === "string" ? result.continuationReason : "";
    var errorCode = result && typeof result.continuationErrorCode === "string" ? result.continuationErrorCode : "";
    var key = reason || errorCode;
    var reasonLabel = "자동 진행 조건을 충족하지 못함";
    var nextAction = "상태를 확인한 뒤 안전하게 다시 진행하세요";
    if (key === "another-approval-is-active") {
      reasonLabel = "다른 승인 처리 중";
      nextAction = "진행 중인 승인을 마친 뒤 상태를 다시 확인하세요";
    } else if (key === "another-session-capability-is-active") {
      reasonLabel = "이 대화의 다른 작업 활성";
      nextAction = "다른 작업이 끝난 뒤 상태를 다시 확인하세요";
    } else if (key === "another-project-capability-is-active") {
      reasonLabel = "프로젝트 작업권 사용 중";
      nextAction = "기존 프로젝트 작업이 끝난 뒤 상태를 다시 확인하세요";
    } else if (key === "approval-session-binding-mismatch") {
      reasonLabel = "승인 세션 연결 만료";
      nextAction = "새 승인 요청을 시작하세요";
    } else if (key === "original-approval-capability-expired") {
      reasonLabel = "승인 실행 권한 만료";
      nextAction = "새 승인 요청을 시작하세요";
    } else if (key === "drain-timeout" || key === "runtime-drain-timeout") {
      reasonLabel = "기존 작업 종료 대기 시간 초과";
      nextAction = "현재 상태를 확인한 뒤 새 요청을 시작하세요";
    }
    return "승인 완료 · 자동 진행 중단 · 원인: " + reasonLabel + " · 다음: " + nextAction;
  }
  function presenterOutputIsExpired(out) {
    if (!out || (out.status && out.status !== "pending")) return false;
    var expiresAt = Number(out.expiresAt || 0);
    var serverNow = Number(out.serverNow || 0);
    return Number.isFinite(expiresAt) && expiresAt > 0
      && Number.isFinite(serverNow) && serverNow > 0
      && serverNow >= expiresAt;
  }
  function presenterOutputIsLocallyPastExpiry(out) {
    if (!out || (out.status && out.status !== "pending")) return false;
    var expiresAt = Number(out.expiresAt || 0);
    var clientNow = Date.now();
    // Display-only fail-closed suppression for stale/cached presenter payloads.
    // This never persists an authoritative approval decision and never permits
    // a mutation. A small grace absorbs ordinary client/server clock skew.
    var graceMs = 30000;
    return Number.isFinite(expiresAt) && expiresAt > 0
      && Number.isFinite(clientNow) && clientNow >= expiresAt + graceMs;
  }
  function restoredWidgetDecision(requestId) {
    if (localApprovalDecision && localApprovalDecision.requestId === requestId) {
      var localMapped = mapPersistedStatus(localApprovalDecision.status);
      if (localMapped && localMapped !== "pending") return localMapped;
    }
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctApprovalDecision;
    if (!saved || typeof saved !== "object" || saved.requestId !== requestId) return null;
    // Only v2 decisions are local terminal latches. They are written strictly
    // after an authoritative server decision/expiry, so remounts can render the
    // terminal state without another status request. Older/unmarked snapshots
    // stay hints and are reconciled with the server once for migration safety.
    if (saved.version !== 2 || saved.authoritative !== true) return null;
    var mapped = mapPersistedStatus(saved.status);
    if (!mapped || mapped === "pending") return null;
    localApprovalDecision = { requestId: requestId, status: mapped };
    localApprovalInteraction = null;
    return mapped;
  }
  function hasLegacyWidgetDecisionHint(requestId) {
    if (localApprovalDecision && localApprovalDecision.requestId === requestId) return false;
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return false;
    var saved = state.c2ctApprovalDecision;
    if (!saved || typeof saved !== "object" || saved.requestId !== requestId) return false;
    var mapped = mapPersistedStatus(saved.status);
    return mapped !== null && mapped !== "pending" && (saved.version !== 2 || saved.authoritative !== true);
  }
  function restoredApprovalInteraction(requestId) {
    if (localApprovalDecision && localApprovalDecision.requestId === requestId) return null;
    if (localApprovalInteraction && localApprovalInteraction.requestId === requestId) return localApprovalInteraction.status;
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctApprovalInteraction;
    if (!saved || typeof saved !== "object" || saved.requestId !== requestId) return null;
    if (saved.status === "working") {
      localApprovalInteraction = { requestId: requestId, status: "working" };
      return "working";
    }
    return null;
  }
  function persistApprovalInteraction(requestId, status) {
    if (status !== "working") return;
    if (localApprovalDecision && localApprovalDecision.requestId === requestId) return;
    localApprovalInteraction = { requestId: requestId, status: status };
    return queueWidgetStateWrite(function (current) {
      var savedDecision = current.c2ctApprovalDecision;
      if (savedDecision && savedDecision.requestId === requestId && mapPersistedStatus(savedDecision.status) && mapPersistedStatus(savedDecision.status) !== "pending") {
        localApprovalInteraction = null;
        return null;
      }
      return Object.assign({}, current, {
        c2ctApprovalInteraction: {
          version: 1,
          requestId: requestId,
          status: status,
          updatedAt: Date.now()
        },
        c2ctApprovalTransport: {
          version: 1,
          requestId: requestId,
          events: approvalTrace.slice()
        }
      });
    });
  }
  function clearApprovalInteraction(requestId) {
    if (localApprovalInteraction && localApprovalInteraction.requestId === requestId) localApprovalInteraction = null;
    return queueWidgetStateWrite(function (current) {
      var saved = current.c2ctApprovalInteraction;
      if (!saved || saved.requestId !== requestId) return null;
      return Object.assign({}, current, { c2ctApprovalInteraction: null });
    });
  }
  function persistWidgetDecision(requestId, status) {
    if (status === "pending" || status === "working" || status === "error" || status === "unavailable") return;
    localApprovalDecision = { requestId: requestId, status: status };
    localApprovalInteraction = null;
    return queueWidgetStateWrite(function (current) {
      return Object.assign({}, current, {
        c2ctApprovalDecision: {
          version: 2,
          requestId: requestId,
          status: status,
          authoritative: true,
          updatedAt: Date.now()
        },
        c2ctApprovalInteraction: null,
        c2ctApprovalTransport: {
          version: 1,
          requestId: requestId,
          events: approvalTrace.slice()
        }
      });
    });
  }
  function restoredApprovalContinuation(requestId) {
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctApprovalContinuation;
    if (!saved || typeof saved !== "object" || saved.requestId !== requestId) return null;
    if (saved.status !== "dispatching" && saved.status !== "sent" && saved.status !== "failed") return null;
    return saved;
  }
  function persistApprovalContinuation(requestId, status) {
    return queueWidgetStateWrite(function (current) {
      var saved = current.c2ctApprovalContinuation;
      if (saved && saved.requestId === requestId && (saved.status === "dispatching" || saved.status === "sent" || saved.status === "failed")) {
        if (status === "dispatching") return null;
      }
      return Object.assign({}, current, {
        c2ctApprovalContinuation: {
          version: 1,
          requestId: requestId,
          status: status,
          updatedAt: Date.now()
        }
      });
    });
  }
  async function beginApprovalContinuationOnce(entry, prompt) {
    if (!entry || !entry.requestId || !prompt) return false;
    var restored = restoredApprovalContinuation(entry.requestId);
    if (restored) return restored.status !== "failed";
    if (approvalContinuationRequestId === entry.requestId) return true;
    approvalContinuationRequestId = entry.requestId;
    // setWidgetState is invoked synchronously by this call. Do not await its
    // optional promise before dispatching the host-native message or the fresh
    // user click's transient activation can be lost.
    var dispatchPersistence = persistApprovalContinuation(entry.requestId, "dispatching");
    approvalEvent(entry, "status_continuation_dispatching");
    var followUpPromise;
    try {
      followUpPromise = beginFollowUpTurn(entry.requestId, prompt);
    } catch (_) {
      followUpPromise = Promise.resolve(false);
    }
    await dispatchPersistence;
    var succeeded = false;
    try {
      succeeded = await followUpPromise;
    } catch (_) {
      succeeded = false;
    }
    await persistApprovalContinuation(entry.requestId, succeeded ? "sent" : "failed");
    approvalEvent(entry, succeeded ? "status_continuation_dispatched" : "status_continuation_failed");
    return succeeded;
  }
  function autoResumeApprovedOperationOnce(target, prompt) {
    if (!target || !target.requestId || !prompt) return;
    var restored = restoredApprovalContinuation(target.requestId);
    if (restored || approvalContinuationRequestId === target.requestId) return;
    var resumePromise = beginApprovalContinuationOnce(target, prompt);
    void resumePromise.then(function (ok) {
      if (entry !== target || ok) return;
      target.message = "승인 완료 · 대화 자동 재개 실패 · 승인된 작업은 재실행하지 않습니다.";
      render();
    });
  }
  function terminalOperationFollowUpPrompt(target) {
    if (!target || !target.requestId || !target.exactOperationId) return "";
    return "C2CT 승인 작업의 terminal 상태를 카드가 확인했습니다. mutation tool은 재호출하지 마. approvalRequestId=" + target.requestId
      + ", operationId=" + target.exactOperationId
      + (target.operationState ? ", state=" + target.operationState : "")
      + (target.operationOutputRef ? ", outputRef=" + target.operationOutputRef : "")
      + (target.projectId ? ", projectId=" + target.projectId : "")
      + ". 정상 terminal 경로에서는 operation_status를 다시 호출하지 마. outputRef가 있으면 같은 approvalRequestId binding으로 output_read만 읽고 기존 작업을 이어가. 승인된 mutation을 재실행하거나 새 operation을 만들지 마.";
  }
  function usesCommandTerminalObserver(target) {
    var tool = target && target.operationTool;
    return tool === "command_request" || tool === "command_run" || tool === "e2e_run_command";
  }
  function operationStateIsActive(state) {
    return state === "approval-wait" || state === "queued" || state === "spawning" || state === "running" || state === "cleanup";
  }
  function operationStateMessage(state) {
    if (state === "approval-wait") return "승인 완료 · 작업 연결 대기 중";
    if (state === "queued" || state === "spawning") return "승인 완료 · 작업 시작 중";
    if (state === "running") return "승인 완료 · 작업 실행 중";
    if (state === "cleanup") return "작업 마무리 중";
    if (state === "completed") return "작업 완료 · 결과 확인 가능";
    if (state === "failed") return "작업 실패 · 결과 확인 가능";
    if (state === "timed-out") return "작업 시간 초과 · 결과 확인 가능";
    if (state === "cancelled") return "작업 취소됨 · 결과 확인 가능";
    if (state === "interrupted-by-runtime-restart") return "작업 중단됨 · 결과 확인 가능";
    return "작업 종료 · 결과 확인 가능";
  }
  function restoredOperationObservation(requestId) {
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctOperationObservation;
    if (!saved || typeof saved !== "object" || saved.requestId !== requestId) return null;
    if (saved.status !== "active" && saved.status !== "terminal" && saved.status !== "observer-failed") return null;
    return saved;
  }
  function persistOperationObservation(target, status) {
    if (!target || !target.requestId) return Promise.resolve();
    return queueWidgetStateWrite(function (current) {
      return Object.assign({}, current, {
        c2ctOperationObservation: {
          version: 1,
          requestId: target.requestId,
          status: status,
          operationId: target.exactOperationId || "",
          operationState: target.operationState || "",
          outputRef: target.operationOutputRef || "",
          startedAt: target.operationObservationStartedAt || Date.now(),
          updatedAt: Date.now()
        }
      });
    });
  }
  function clearOperationObserveTimer() {
    if (operationObserveTimer) clearTimeout(operationObserveTimer);
    operationObserveTimer = null;
  }
  function applyOperationObservation(target, result) {
    if (!target || !result || typeof result !== "object") return false;
    var state = typeof result.state === "string" ? result.state : (typeof result.operationState === "string" ? result.operationState : "");
    var exactOperationId = result.exactOperationId || result.operationId || target.exactOperationId || "";
    if (exactOperationId) target.exactOperationId = exactOperationId;
    if (typeof result.outputRef === "string" && result.outputRef) target.operationOutputRef = result.outputRef;
    if (!state) return false;
    target.operationState = state;
    target.operationObservationStartedAt = target.operationObservationStartedAt || Date.now();
    target.message = operationStateMessage(state);
    if (operationStateIsActive(state)) {
      target.operationTerminal = false;
      if (target.persistedOperationState !== state) {
        target.persistedOperationState = state;
        void persistOperationObservation(target, "active");
      }
      return false;
    }
    target.operationTerminal = Boolean(target.exactOperationId);
    target.persistedOperationState = state;
    clearOperationObserveTimer();
    operationObserveRequestId = target.requestId;
    void persistOperationObservation(target, "terminal");
    return target.operationTerminal;
  }
  function scheduleApprovedOperationObservation(target, delayMs) {
    if (!target || target.requestId.indexOf("op_") !== 0 || target.operationTerminal) return;
    if (target.status !== "allowed" && target.status !== "consumed") return;
    var saved = restoredOperationObservation(target.requestId);
    if (saved && Number.isFinite(Number(saved.startedAt)) && Number(saved.startedAt) > 0) {
      target.operationObservationStartedAt = target.operationObservationStartedAt || Number(saved.startedAt);
    }
    if (saved && saved.status === "terminal" && saved.operationId) {
      target.exactOperationId = saved.operationId;
      target.operationState = saved.operationState || target.operationState || "completed";
      target.operationOutputRef = saved.outputRef || target.operationOutputRef || "";
      target.operationTerminal = true;
      target.message = operationStateMessage(target.operationState);
      return;
    }
    if (saved && saved.status === "observer-failed") {
      target.operationObserverFailed = true;
      target.message = "작업 상태 자동 확인 중단 · 재실행 없이 채팅에서 상태 확인이 필요합니다.";
      return;
    }
    if (operationObserveTimer && operationObserveRequestId === target.requestId) return;
    clearOperationObserveTimer();
    operationObserveRequestId = target.requestId;
    operationObserveTimer = setTimeout(function () {
      operationObserveTimer = null;
      void observeApprovedOperation(target);
    }, Math.max(0, Number(delayMs) || 0));
  }
  async function observeApprovedOperation(target, seed) {
    if (!target || target !== entry || target.requestId.indexOf("op_") !== 0) return;
    if (!usesCommandTerminalObserver(target)) return;
    if (target.status !== "allowed" && target.status !== "consumed") return;
    target.operationObservationStartedAt = target.operationObservationStartedAt || Date.now();
    if (operationObserveRequestId === target.requestId) clearOperationObserveTimer();
    if (seed && applyOperationObservation(target, seed)) {
      autoResumeApprovedOperationOnce(target, terminalOperationFollowUpPrompt(target));
      render();
      return;
    }
    if (Date.now() - target.operationObservationStartedAt > 20 * 60 * 1000) {
      target.operationObserverFailed = true;
      target.message = "작업 상태 자동 확인 제한 도달 · mutation 재실행 없이 채팅에서 상태 확인이 필요합니다.";
      void persistOperationObservation(target, "observer-failed");
      render();
      return;
    }
    if (operationObserveInFlight) return;
    operationObserveInFlight = true;
    operationObserveRequestId = target.requestId;
    try {
      var raw = await callServerTool("operation_status", {
        projectId: target.projectId,
        approvalRequestId: target.requestId
      }, { allowCrossBridgeFallback: true });
      if (!raw || raw.isError === true) throw new Error("operation status unavailable");
      if (target !== entry) return;
      var result = structured(raw);
      target.operationObserveFailures = 0;
      var terminal = applyOperationObservation(target, result);
      render();
      if (terminal) {
        autoResumeApprovedOperationOnce(target, terminalOperationFollowUpPrompt(target));
        return;
      }
      var pollAfterMs = Number(result.pollAfterMs);
      scheduleApprovedOperationObservation(target, Number.isFinite(pollAfterMs) && pollAfterMs > 0 ? Math.max(250, pollAfterMs) : 1000);
    } catch (_) {
      if (target !== entry) return;
      target.operationObserveFailures = (target.operationObserveFailures || 0) + 1;
      if (target.operationObserveFailures >= 8) {
        target.operationObserverFailed = true;
        target.message = "작업 상태 자동 확인 실패 · mutation 재실행 없이 채팅에서 상태 확인이 필요합니다.";
        void persistOperationObservation(target, "observer-failed");
        render();
      } else {
        target.message = "승인 완료 · 작업 상태 확인 재시도 중";
        render();
        scheduleApprovedOperationObservation(target, Math.min(8000, 500 * Math.pow(2, target.operationObserveFailures - 1)));
      }
    } finally {
      operationObserveInFlight = false;
    }
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
  async function persistShellChoice(card, choiceId) {
    await queueWidgetStateWrite(function (current) {
      var matched = (Array.isArray(card.options) ? card.options : []).find(function (option) { return option.id === choiceId; });
      return Object.assign({}, current, {
        c2ctShellChoice: {
          version: 1,
          cardId: card.cardId,
          choiceId: choiceId,
          choiceLabel: matched && matched.label ? matched.label : choiceId,
          status: "resolved",
          updatedAt: Date.now()
        }
      });
    });
  }
  function restoredShellAutoContinue(cardId) {
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctShellAutoContinue;
    if (!saved || typeof saved !== "object" || saved.cardId !== cardId) return null;
    if (saved.status !== "attempting" && saved.status !== "sent" && saved.status !== "cancelled" && saved.status !== "ready") return null;
    return saved;
  }
  function persistShellAutoContinue(cardId, status) {
    return queueWidgetStateWrite(function (current) {
      return Object.assign({}, current, {
        c2ctShellAutoContinue: {
          version: 1,
          cardId: cardId,
          status: status,
          updatedAt: Date.now()
        }
      });
    });
  }
  function restoredShellAutoContinueRenderStart(cardId) {
    var state = api().widgetState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    var saved = state.c2ctShellAutoContinueRender;
    if (!saved || typeof saved !== "object" || saved.cardId !== cardId) return null;
    return Number.isFinite(saved.startedAt) && saved.startedAt > 0 ? saved.startedAt : null;
  }
  function persistShellAutoContinueRenderStart(cardId, startedAt) {
    return queueWidgetStateWrite(function (current) {
      return Object.assign({}, current, {
        c2ctShellAutoContinueRender: {
          version: 1,
          cardId: cardId,
          startedAt: startedAt
        }
      });
    });
  }
  function isAutoContinuationCard(card) {
    return !!(card && card.compact === true && Array.isArray(card.options) && card.options.length === 1 &&
      card.options[0] && card.options[0].id === "continue" && typeof card.autoContinueAt === "number");
  }
  function isIosLikeShellClient() {
    if (previewMode && window.__C2CT_CARD_PREVIEW_PLATFORM__ === "ios") return true;
    if (previewMode && window.__C2CT_CARD_PREVIEW_PLATFORM__ === "desktop") return false;
    var nav = typeof navigator === "object" && navigator ? navigator : null;
    if (!nav) return false;
    var ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
    var platform = typeof nav.platform === "string" ? nav.platform : "";
    var uaPlatform = nav.userAgentData && typeof nav.userAgentData.platform === "string" ? nav.userAgentData.platform : "";
    var maxTouchPoints = Number(nav.maxTouchPoints || 0);
    return /iPhone|iPad|iPod/i.test(ua)
      || /iPhone|iPad|iPod/i.test(platform)
      || /iOS/i.test(uaPlatform)
      || (platform === "MacIntel" && maxTouchPoints > 1);
  }
  function isPhase22RemountResetCard(card) {
    return isAutoContinuationCard(card) && card.title === "2.2단계 · remount reset";
  }
  function isBaselineAutoContinueCard(card) {
    return isAutoContinuationCard(card) && (card.title === "15초 베이스라인" || card.title === "2.2단계 · remount reset" || card.title === "3단계 · intersection");
  }
  function isPhase3IntersectionCard(card) {
    return isAutoContinuationCard(card) && card.title === "3단계 · intersection";
  }
  function isVisibilityPauseAutoContinueCard(card) {
    return isAutoContinuationCard(card) && card.title === "2단계 · visibility";
  }
  function isSimpleAutoContinueCard(card) {
    return isBaselineAutoContinueCard(card) || isVisibilityPauseAutoContinueCard(card);
  }
  function shellAutoContinueDelayMs(card) {
    if (!isAutoContinuationCard(card)) return 0;
    var anchor = typeof card.availableAt === "number" ? card.availableAt : card.createdAt;
    var delay = card.autoContinueAt - anchor;
    return Number.isFinite(delay) && delay > 0 ? delay : 15000;
  }
  function shellAutoContinueRenderStart(card) {
    if (!card) return null;
    if (isPhase22RemountResetCard(card) || (isAutoContinuationCard(card) && isIosLikeShellClient())) {
      var remountStartedAt = shellRemountResetStartedAtByCard[card.cardId];
      if (Number.isFinite(remountStartedAt)) return remountStartedAt;
      if (shellAutoContinueRenderCardId !== card.cardId) {
        var remountState = api().widgetState;
        var savedRender = remountState && typeof remountState === "object" && !Array.isArray(remountState)
          ? remountState.c2ctShellAutoContinueRender
          : null;
        if (savedRender && savedRender.cardId === card.cardId && Number.isFinite(savedRender.startedAt) && savedRender.startedAt > 0) {
          var restartedAt = Date.now();
          shellAutoContinueRenderCardId = card.cardId;
          shellRemountResetStartedAtByCard[card.cardId] = restartedAt;
          void queueWidgetStateWrite(function (current) {
            return Object.assign({}, current, {
              c2ctShellAutoContinueRender: { version: 1, cardId: card.cardId, startedAt: restartedAt }
            });
          });
          return restartedAt;
        }
      }
    }
    if (shellAutoContinueRenderCardId === card.cardId && Number.isFinite(shellAutoContinueRenderStartedAt)) {
      return shellAutoContinueRenderStartedAt;
    }
    var restored = restoredShellAutoContinueRenderStart(card.cardId);
    if (restored === null) return null;
    shellAutoContinueRenderCardId = card.cardId;
    shellAutoContinueRenderStartedAt = restored;
    return restored;
  }
  function markShellAutoContinueRendered(card) {
    if (!isAutoContinuationCard(card)) return null;
    var newlyArmed = !shellAutoForegroundArmedThisMount;
    if (newlyArmed) {
      var armedAt = Date.now();
      shellAutoForegroundNotBefore = armedAt;
      shellAutoContinueLastTickAt = armedAt;
    }
    shellAutoForegroundArmedThisMount = true;
    var existing = shellAutoContinueRenderStart(card);
    if (existing !== null) return existing;
    var startedAt = Date.now();
    shellAutoContinueRenderCardId = card.cardId;
    shellAutoContinueRenderStartedAt = startedAt;
    void persistShellAutoContinueRenderStart(card.cardId, startedAt);
    return startedAt;
  }
  function usesIosActionablePaintGate(card) {
    return isAutoContinuationCard(card) && isIosLikeShellClient();
  }
  function clearShellAutoContinuePaintState(cardId) {
    shellAutoContinuePaintArmGeneration += 1;
    if (!cardId || shellAutoContinuePaintArmCardId === cardId) shellAutoContinuePaintArmCardId = null;
    if (cardId) delete shellAutoContinuePaintStartedAtByCard[cardId];
    else shellAutoContinuePaintStartedAtByCard = Object.create(null);
  }
  function shellContinueIsActionable(card) {
    if (!card || document.hidden === true) return false;
    var shell = document.getElementById("shell");
    var button = document.getElementById("shell-continue-button");
    if (!shell || shell.hidden === true || !button || button.disabled === true) return false;
    return true;
  }
  function armShellAutoContinueAfterActionablePaint(card) {
    if (!usesIosActionablePaintGate(card) || card.status === "resolved" || restoredShellSubmission(card.cardId)) return;
    var autoState = restoredShellAutoContinue(card.cardId);
    if (autoState && (autoState.status === "sent" || autoState.status === "cancelled" || autoState.status === "attempting" || autoState.status === "ready")) return;
    if (Number.isFinite(shellAutoContinuePaintStartedAtByCard[card.cardId])) return;
    if (shellAutoContinuePaintArmCardId === card.cardId) return;
    shellAutoContinuePaintArmGeneration += 1;
    var generation = shellAutoContinuePaintArmGeneration;
    shellAutoContinuePaintArmCardId = card.cardId;
    if (typeof requestAnimationFrame !== "function") {
      shellAutoContinuePaintArmCardId = null;
      return;
    }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (generation !== shellAutoContinuePaintArmGeneration || shellAutoContinuePaintArmCardId !== card.cardId) return;
        shellAutoContinuePaintArmCardId = null;
        var currentOut = output();
        var currentCard = currentOut && currentOut.card && currentOut.card.kind === "choice" ? currentOut.card : null;
        if (!currentCard || currentCard.cardId !== card.cardId || !shellContinueIsActionable(currentCard)) return;
        if (restoredShellSubmission(currentCard.cardId) || currentCard.status === "resolved") return;
        shellAutoContinuePaintStartedAtByCard[currentCard.cardId] = Date.now();
        markShellAutoContinueRendered(currentCard);
        refreshShellAutoContinueStatus(currentCard);
        scheduleShellAutoContinue(currentCard);
      });
    });
  }
  function shellAutoContinueDeadline(card) {
    if (usesIosActionablePaintGate(card)) {
      if (document.hidden === true) return null;
      var paintStartedAt = shellAutoContinuePaintStartedAtByCard[card.cardId];
      return Number.isFinite(paintStartedAt) ? paintStartedAt + shellAutoContinueDelayMs(card) : null;
    }
    if (isSimpleAutoContinueCard(card) || (isAutoContinuationCard(card) && isIosLikeShellClient())) {
      if (isVisibilityPauseAutoContinueCard(card) && (document.hidden === true || shellVisibilityPauseStoppedCardId === card.cardId)) return null;
      if (isPhase3IntersectionCard(card) && shellPhase3IntersectionStoppedCardId === card.cardId) return null;
      var simpleStartedAt = shellAutoContinueRenderStart(card);
      return simpleStartedAt === null ? null : simpleStartedAt + shellAutoContinueDelayMs(card);
    }
    if (!shellAutoForegroundArmedThisMount || !shellAutoViewportVisible || document.hidden === true || shellAutoForegroundSawHidden) return null;
    var startedAt = shellAutoContinueRenderStart(card);
    if (startedAt === null) return null;
    var effectiveStartedAt = shellAutoForegroundNotBefore > startedAt ? shellAutoForegroundNotBefore : startedAt;
    return effectiveStartedAt + shellAutoContinueDelayMs(card);
  }
  function clearShellAutoContinueVisibilityObserver() {
    if (shellAutoContinueVisibilityObserver && typeof shellAutoContinueVisibilityObserver.disconnect === "function") {
      shellAutoContinueVisibilityObserver.disconnect();
    }
    shellAutoContinueVisibilityObserver = null;
    shellAutoContinueVisibilityCardId = null;
    shellAutoViewportVisible = false;
    shellAutoViewportSawHidden = false;
  }
  function armShellAutoContinueVisibility(card) {
    if (!isAutoContinuationCard(card)) {
      clearShellAutoContinueVisibilityObserver();
      return;
    }
    if (shellAutoContinueVisibilityObserver && shellAutoContinueVisibilityCardId === card.cardId) return;
    clearShellAutoContinueVisibilityObserver();
    if (typeof IntersectionObserver !== "function") return;
    var target = document.getElementById("shell");
    if (!target) return;
    shellAutoContinueVisibilityCardId = card.cardId;
    shellAutoContinueVisibilityObserver = new IntersectionObserver(function (entries) {
      var visible = Array.isArray(entries) && entries.some(function (item) {
        return item && item.isIntersecting === true && Number(item.intersectionRatio || 0) > 0;
      });
      var currentOut = output();
      var currentCard = currentOut && currentOut.card && currentOut.card.kind === "choice" ? currentOut.card : null;
      if (!currentCard || currentCard.cardId !== card.cardId) {
        clearShellAutoContinueVisibilityObserver();
        return;
      }
      if (isPhase3IntersectionCard(currentCard)) {
        if (!visible) {
          shellPhase3IntersectionStoppedCardId = currentCard.cardId;
          shellAutoViewportVisible = false;
          clearShellAutoContinueTimer();
          renderShellChoice(currentOut);
          return;
        }
        shellAutoViewportVisible = true;
        return;
      }
      if (!visible || document.hidden === true) {
        shellAutoViewportVisible = false;
        shellAutoViewportSawHidden = true;
        shellAutoForegroundSawHidden = true;
        shellAutoForegroundArmedThisMount = false;
        shellAutoForegroundNotBefore = 0;
        clearShellAutoContinueTimer();
        void persistShellAutoForegroundGate(currentCard.cardId, "waiting-viewport", "viewport-hidden");
        renderShellChoice(currentOut);
        return;
      }
      if (shellAutoViewportVisible) return;
      shellAutoViewportVisible = true;
      if (!shellAutoViewportSawHidden) {
        clearShellAutoContinueTimer();
        void persistShellAutoForegroundGate(currentCard.cardId, "waiting-viewport", "viewport-visible-without-prior-hidden");
        renderShellChoice(currentOut);
        return;
      }
      shellAutoViewportSawHidden = false;
      if (!shellAutoForegroundHasUserActivation()) {
        shellAutoForegroundArmedThisMount = false;
        shellAutoForegroundNotBefore = 0;
        clearShellAutoContinueTimer();
        void persistShellAutoForegroundGate(currentCard.cardId, "waiting-user-entry", "viewport-visible-without-user-activation");
        renderShellChoice(currentOut);
        return;
      }
      shellAutoForegroundSawHidden = false;
      shellAutoForegroundNotBefore = Date.now();
      markShellAutoContinueRendered(currentCard);
      void persistShellAutoForegroundGate(currentCard.cardId, "armed", "viewport-visible-with-user-activation");
      renderShellChoice(currentOut);
    }, { threshold: [0.01] });
    shellAutoContinueVisibilityObserver.observe(target);
  }
  function persistShellAutoForegroundGate(cardId, status, signal) {
    return queueWidgetStateWrite(function (current) {
      return Object.assign({}, current, {
        c2ctShellAutoContinueGate: {
          version: 1,
          cardId: cardId,
          status: status,
          signal: signal || null,
          displayMode: typeof api().displayMode === "string" ? api().displayMode.slice(0, 32) : null,
          maxHeight: Number.isFinite(Number(api().maxHeight)) ? Number(api().maxHeight) : null,
          updatedAt: Date.now()
        }
      });
    });
  }
  function isVisibilityDiagnosticCard(card) {
    return !!(card && card.kind === "choice" && card.title === "2.1단계 · iPad 이벤트 진단");
  }
  function restoredShellVisibilityDiagnostic(cardId) {
    var a = api();
    var current = a.widgetState && typeof a.widgetState === "object" && !Array.isArray(a.widgetState) ? a.widgetState : null;
    var diag = current && current.c2ctShellVisibilityDiag;
    if (!diag || diag.version !== 1 || diag.cardId !== cardId || !Array.isArray(diag.events)) return null;
    return diag;
  }
  function recordShellVisibilityDiagnostic(signal) {
    var currentOut = output();
    var currentCard = currentOut && currentOut.card && currentOut.card.kind === "choice" ? currentOut.card : null;
    if (!isVisibilityDiagnosticCard(currentCard)) return;
    var hidden = document && document.hidden === true;
    var hasFocus = document && typeof document.hasFocus === "function" ? document.hasFocus() : null;
    void queueWidgetStateWrite(function (current) {
      var previous = current && current.c2ctShellVisibilityDiag && current.c2ctShellVisibilityDiag.cardId === currentCard.cardId
        ? current.c2ctShellVisibilityDiag
        : null;
      var events = previous && Array.isArray(previous.events) ? previous.events.slice(-7) : [];
      events.push({ signal: signal, hidden: hidden, hasFocus: hasFocus, at: Date.now() });
      return Object.assign({}, current, {
        c2ctShellVisibilityDiag: { version: 1, cardId: currentCard.cardId, events: events, updatedAt: Date.now() }
      });
    }).then(function () { renderShellChoice(output()); });
  }
  function formatShellVisibilityDiagnostic(card) {
    var diag = restoredShellVisibilityDiagnostic(card && card.cardId);
    var events = diag && Array.isArray(diag.events) ? diag.events : [];
    if (!events.length) return "STEP 2.1 · VIS-DIAG · events: none";
    var labels = events.slice(-6).map(function (event) {
      return String(event.signal || "?") + "(h=" + (event.hidden ? "1" : "0") + ",f=" + (event.hasFocus === null ? "?" : (event.hasFocus ? "1" : "0")) + ")";
    });
    return "STEP 2.1 · VIS-DIAG · " + labels.join(" › ");
  }
  function prepareShellAutoForegroundGate(card) {
    if (!isAutoContinuationCard(card) || (shellAutoForegroundArmedThisMount && shellAutoContinueRenderStart(card) !== null)) return;
    if (shellAutoForegroundCardId === card.cardId) return;
    shellAutoForegroundCardId = card.cardId;
    shellAutoForegroundSawHidden = document.hidden === true;
    shellAutoForegroundArmedThisMount = false;
    shellAutoForegroundNotBefore = 0;
    void persistShellAutoForegroundGate(
      card.cardId,
      shellAutoForegroundSawHidden ? "waiting-visible" : "waiting-hidden",
      shellAutoForegroundSawHidden ? "initial-hidden" : "initial-visible"
    );
  }
  function shellAutoForegroundHasUserActivation() {
    var activation = typeof navigator === "object" && navigator ? navigator.userActivation : null;
    return !!(activation && activation.isActive === true);
  }
  function noteShellAutoForegroundSignal(signal) {
    var currentOut = output();
    var currentCard = currentOut && currentOut.card && currentOut.card.kind === "choice" ? currentOut.card : null;
    if (!isAutoContinuationCard(currentCard)) return;
    if (isBaselineAutoContinueCard(currentCard)) return;
    if (isVisibilityPauseAutoContinueCard(currentCard)) {
      if (signal === "visibility-hidden" || document.hidden === true) {
        shellVisibilityPauseStoppedCardId = currentCard.cardId;
        clearShellAutoContinueTimer();
        renderShellChoice(currentOut);
      }
      return;
    }
    prepareShellAutoForegroundGate(currentCard);
    if (shellAutoForegroundArmedThisMount && shellAutoContinueRenderStart(currentCard) !== null) return;
    if (signal === "visibility-hidden" || document.hidden === true) {
      shellAutoForegroundSawHidden = true;
      shellAutoForegroundArmedThisMount = false;
      shellAutoForegroundNotBefore = 0;
      shellAutoViewportVisible = false;
      clearShellAutoContinueTimer();
      void persistShellAutoForegroundGate(currentCard.cardId, "waiting-visible", "visibility-hidden");
      return;
    }
    if (signal !== "visibility-visible" || !shellAutoForegroundSawHidden) return;
    if (!shellAutoViewportVisible) {
      void persistShellAutoForegroundGate(currentCard.cardId, "waiting-viewport", "visibility-visible-without-viewport");
      return;
    }
    if (!shellAutoForegroundHasUserActivation()) {
      void persistShellAutoForegroundGate(currentCard.cardId, "waiting-user-entry", "visibility-hidden-to-visible-without-user-activation");
      return;
    }
    shellAutoForegroundSawHidden = false;
    shellAutoForegroundNotBefore = Date.now();
    markShellAutoContinueRendered(currentCard);
    void persistShellAutoForegroundGate(currentCard.cardId, "armed", "visibility-hidden-to-visible-with-user-activation");
    renderShellChoice(currentOut);
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
  function collectAppearanceTelemetry() {
    function styleValue(node, key) {
      if (!node || typeof getComputedStyle !== "function") return undefined;
      try {
        var style = getComputedStyle(node);
        var value = style && style[key];
        return typeof value === "string" ? value.slice(0, 128) : undefined;
      } catch (_) {
        return undefined;
      }
    }
    var a = api();
    var card = document.querySelector(".card");
    var actionButtons = document.querySelectorAll(".actions button");
    var deny = actionButtons && actionButtons.length > 0 ? actionButtons[0] : null;
    var allow = actionButtons && actionButtons.length > 1 ? actionButtons[1] : null;
    var telemetry = {
      version: 1,
      mediaDark: typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)").matches : undefined,
      documentHidden: document.hidden === true,
      openAiSetGlobalsCount: openAiSetGlobalsCount
    };
    if (typeof a.theme === "string") telemetry.hostTheme = a.theme.slice(0, 32);
    if (typeof a.displayMode === "string") telemetry.displayMode = a.displayMode.slice(0, 32);
    if (typeof document.visibilityState === "string") telemetry.visibilityState = document.visibilityState.slice(0, 32);
    telemetry.htmlColorScheme = styleValue(document.documentElement, "colorScheme");
    telemetry.bodyColor = styleValue(document.body, "color");
    telemetry.bodyBackgroundColor = styleValue(document.body, "backgroundColor");
    telemetry.bodyOpacity = styleValue(document.body, "opacity");
    telemetry.bodyFilter = styleValue(document.body, "filter");
    telemetry.cardColor = styleValue(card, "color");
    telemetry.cardBackgroundColor = styleValue(card, "backgroundColor");
    telemetry.cardOpacity = styleValue(card, "opacity");
    telemetry.cardFilter = styleValue(card, "filter");
    telemetry.denyColor = styleValue(deny, "color");
    telemetry.denyBackgroundColor = styleValue(deny, "backgroundColor");
    telemetry.denyOpacity = styleValue(deny, "opacity");
    telemetry.allowColor = styleValue(allow, "color");
    telemetry.allowBackgroundColor = styleValue(allow, "backgroundColor");
    telemetry.allowOpacity = styleValue(allow, "opacity");
    return telemetry;
  }
  function maybeRefreshPersistedStatus() {
    if (previewMode) return;
    if (!entry || presentationKind === "widget-capability-lab" || presentationKind === "widget-shell-choice" || presentationKind === "widget-preapply-load-only") return;
    if (entry.status !== "checking" && entry.status !== "pending" && entry.status !== "error" && entry.status !== "working") return;
    if (statusRefreshedRequestId === entry.requestId || statusRefreshInFlight) return;
    var attempts = statusRefreshAttempts[entry.requestId] || 0;
    var maxAttempts = entry.status === "working" || entry.status === "checking" ? 8 : 3;
    if (attempts >= maxAttempts) return;
    var requestId = entry.requestId;
    var token = entry.token;
    var target = entry;
    var attempt = target.attempt;
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
          var paintTelemetry = paintTelemetrySent || target.statusTool ? null : collectPaintTelemetry();
          if (paintTelemetry) statusArgs.paintTelemetry = paintTelemetry;
          // Keep approval callback payloads compatible with the previous live
          // runtime generation. This widget asset can be hot-applied before the
          // matching runtime schema is replaced, so new optional fields must not
          // be sent to an older additionalProperties:false callback schema.
          if (target.statusTool) {
            delete statusArgs.decision;
            statusArgs.clientPhases = approvalTrace.slice(-16).map(function (trace) { return trace.event.replace("approval.client.", ""); });
          }
          result = await callServerTool(target.statusTool || target.decisionTool, statusArgs, { allowCrossBridgeFallback: true });
          if (paintTelemetry) paintTelemetrySent = true;
        } else if (requestId.indexOf("consent_") === 0) {
          result = await callServerTool("chatgpt_consent_probe_status", { requestId: requestId }, { allowCrossBridgeFallback: true });
        } else {
          return;
        }
        if (entry !== target || target.attempt !== attempt || presentationKind === "widget-preapply-load-only") return;
        if (entry.status === "allowed" || entry.status === "denied" || entry.status === "consumed") {
          statusRefreshedRequestId = requestId;
          return;
        }
        if (!result || result.isError === true) throw new Error("Approval status rejected");
        var mapped = mapPersistedStatus(structured(result).status);
        if (!mapped) throw new Error("Approval status unavailable");
        approvalEvent(target, "authoritative_" + mapped);
        if (mapped === "pending" && (entry.status === "working" || entry.status === "checking")) {
          var workingAttemptCount = statusRefreshAttempts[requestId] || 0;
          if (workingAttemptCount < 8) {
            setTimeout(maybeRefreshPersistedStatus, 350 * Math.max(1, workingAttemptCount));
            return;
          }
          // The server has authoritatively remained pending through the bounded
          // reconciliation window. Approval resolution is serialized by requestId,
          // so a retried click cannot approve the same operation twice. Clear the
          // stale local working latch and make the same bound approval actionable again.
          // Receipt evidence is separate from host promise state. If a verified
          // decision reached the handler but could not be applied, do not invite
          // another mutation. A null receipt means 'not observed at this read',
          // never proof that an in-flight host request cannot arrive later.
          var received = structured(result).decisionReceipt;
          entry.reconciled = true;
          entry.attempt = null;
          statusRefreshedRequestId = requestId;
          entry.status = received ? "unavailable" : "pending";
          entry.message = received
            ? "서버가 요청을 수신했지만 승인 미완료 · 상태 확인만 가능합니다."
            : "서버 승인 기록이 아직 없습니다 · 버튼이 복구되었습니다. 자동 재전송하지 않습니다.";
          void clearApprovalInteraction(requestId);
          approvalEvent(target, received ? "server_received_unresolved" : "recovered_pending");
          render();
          return;
        }
        statusRefreshedRequestId = requestId;
        entry.status = mapped;
        entry.reconciled = true;
        entry.message = persistedStatusMessage(mapped);
        if (mapped !== "pending") entry.token = null;
        if (mapped !== "pending") void persistWidgetDecision(requestId, mapped);
        else void clearApprovalInteraction(requestId);
        render();
        if (requestId.indexOf("op_") === 0 && (mapped === "allowed" || mapped === "consumed")) {
          autoResumeApprovedOperationOnce(entry, entry.allowFollowUpPrompt || ${JSON.stringify(CHATGPT_OPERATION_APPROVAL_USER_PROMPTS.allow)});
          if (usesCommandTerminalObserver(entry)) {
            entry.operationObservationStartedAt = entry.operationObservationStartedAt || Date.now();
            scheduleApprovedOperationObservation(entry, 0);
          }
        }
        render();
        render();
      } catch (error) {
        if (entry === target && target.attempt === attempt && presentationKind !== "widget-preapply-load-only") {
          if (entry.status === "allowed" || entry.status === "denied" || entry.status === "consumed") {
            statusRefreshedRequestId = requestId;
            return;
          }
          var attemptCount = statusRefreshAttempts[requestId] || 0;
          var retryLimit = entry.status === "working" || entry.status === "checking" ? 8 : 3;
          if (attemptCount < retryLimit) {
            setTimeout(maybeRefreshPersistedStatus, 300 * Math.max(1, attemptCount));
          } else {
            // A failed read must neither invent a terminal decision nor unlock
            // a card whose exact mutation may already have been dispatched.
            entry.status = "unavailable";
            entry.reconciled = true;
            entry.message = "서버 기록 확인 불가 · 승인 재전송 없이 상태만 다시 확인할 수 있습니다.";
            approvalEvent(target, "status_unavailable");
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
    if (
      presentationKind === "widget-capability-lab"
      || presentationKind === "widget-shell-choice"
    ) return;
    if (presentationKind === "widget-preapply-load-only") {
      entry = null;
      statusRefreshedRequestId = null;
      statusRefreshAttempts = Object.create(null);
      return;
    }
    if (!out.requestId) return;
    // Collapse stale approval cards before copying consequential details into
    // local widget state or enabling a decision bridge. A fresh server-authored
    // expiry is authoritative and may be persisted. A client-clock expiry is
    // display-only: it suppresses a cached card without claiming the server
    // already terminalized the request.
    var serverExpired = presenterOutputIsExpired(out);
    var locallyPastExpiry = presenterOutputIsLocallyPastExpiry(out);
    if (serverExpired) {
      entry = {
        requestId: out.requestId,
        createdAt: out.createdAt || null,
        expiresAt: out.expiresAt,
        serverNow: out.serverNow,
        token: null,
        status: "expired",
        message: "승인 만료 · 새 요청이 필요합니다."
      };
      statusRefreshedRequestId = out.requestId;
      if (serverExpired) void persistWidgetDecision(out.requestId, "expired");
      return;
    }
    var sec = secret();
    var restored = restoredWidgetDecision(out.requestId);
    var legacyDecisionHint = hasLegacyWidgetDecisionHint(out.requestId);
    var interaction = restoredApprovalInteraction(out.requestId);
    if (locallyPastExpiry && !restored && !interaction && !legacyDecisionHint) {
      entry = {
        requestId: out.requestId,
        projectId: out.projectId || "",
        originOperationId: out.originOperationId || "",
        exactOperationId: out.exactOperationId || out.operationId || "",
        createdAt: out.createdAt || null,
        expiresAt: out.expiresAt || null,
        serverNow: out.serverNow || null,
        approvalSeverity: out.approvalSeverity || "standard",
        criticalBadge: out.criticalBadge || "Mac 시스템 변경",
        criticalWarning: out.criticalWarning || "",
        criticalIdentityBefore: out.criticalIdentityBefore || "",
        criticalIdentityAfter: out.criticalIdentityAfter || "",
        criticalRollback: out.criticalRollback || "",
        criticalPostApply: out.criticalPostApply || "",
        decisionTool: out.decisionTool || "chatgpt_consent_probe_decide",
        operationTool: out.operationTool || "",
        allowFollowUpPrompt: out.allowFollowUpPrompt,
        denyFollowUpPrompt: out.denyFollowUpPrompt,
        projectScopeAllowed: out.projectScopeAllowed === true,
        statusTool: out.statusTool || null,
        interactionProofRequired: out.interactionProofRequired === true,
        token: sec.token || null,
        status: sec.token ? "checking" : "unavailable",
        reconciled: false,
        message: sec.token ? "승인 상태 확인 중" : "승인 연결 정보가 없습니다 · 상태를 확인할 수 없습니다."
      };
      statusRefreshedRequestId = null;
      approvalEvent(entry, "remount_reconcile");
      if (sec.token) maybeRefreshPersistedStatus();
      return;
    }
    if (!sec.token && !restored && !interaction && !legacyDecisionHint) return;
    if (!entry || entry.requestId !== out.requestId) {
      entry = {
        requestId: out.requestId,
        projectId: out.projectId || "",
        originOperationId: out.originOperationId || "",
        exactOperationId: out.exactOperationId || out.operationId || "",
        preview: out.summary || out.preview || "C2CT 작업 승인",
        impact: out.impact || "",
        details: out.details || "",
        createdAt: out.createdAt || null,
        expiresAt: out.expiresAt || null,
        serverNow: out.serverNow || null,
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
        projectScopeAllowed: out.projectScopeAllowed === true,
        statusTool: out.statusTool || null,
        interactionProofRequired: out.interactionProofRequired === true,
        token: restored ? null : sec.token,
        status: restored ? restored : (!sec.token ? "unavailable" : (interaction || (legacyDecisionHint ? "checking" : "pending"))),
        reconciled: Boolean(restored),
        message: !sec.token ? "승인 연결 정보가 없습니다 · 새 카드가 필요합니다." : ""
      };
      approvalEvent(entry, "mounted");
      if (restored) {
        statusRefreshedRequestId = out.requestId;
        entry.message = persistedStatusMessage(restored);
        approvalEvent(entry, "restored_terminal");
        void clearApprovalInteraction(out.requestId);
      } else if (sec.token && (interaction || legacyDecisionHint)) {
        statusRefreshedRequestId = null;
        approvalEvent(entry, legacyDecisionHint ? "legacy_terminal_hint_reconcile" : "remount_reconcile");
        maybeRefreshPersistedStatus();
      }
      return;
    }
    // Current server-confirmed state wins over an older queued widget-state write.
    if (entry.status === "allowed" || entry.status === "denied" || entry.status === "consumed" || entry.status === "expired" || entry.status === "missing") return;
    if (!entry.token && sec.token) {
      entry.token = sec.token;
      entry.status = "checking";
      statusRefreshedRequestId = null;
      maybeRefreshPersistedStatus();
      return;
    }
    // Widget-state snapshots are hints, never authoritative decisions. Do not
    // re-latch a locally recovered card when a stale host snapshot arrives.
    if (interaction === "working" && !entry.reconciled) {
      entry.status = "working";
      entry.token = sec.token;
      maybeRefreshPersistedStatus();
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
      entry.exactOperationId = out.exactOperationId || out.operationId || entry.exactOperationId;
      entry.turnlessContinuationAfterApproval = out.turnlessContinuationAfterApproval === true;
      entry.allowFollowUpPrompt = out.allowFollowUpPrompt || entry.allowFollowUpPrompt;
      entry.denyFollowUpPrompt = out.denyFollowUpPrompt || entry.denyFollowUpPrompt;
      entry.interactionProofRequired = out.interactionProofRequired === true;
      entry.token = sec.token;
      if (out.serverNow && out.serverNow !== entry.serverNow) {
        entry.serverNow = out.serverNow;
      }
      if (entry.status === "error") entry.status = "pending";
    }
  }
  function renderShellChoice(out) {
    var card = out && out.card && out.card.kind === "choice" ? out.card : null;
    var prompt = document.getElementById("shell-prompt");
    var options = document.getElementById("shell-options");
    var status = document.getElementById("shell-status");
    var debug = document.getElementById("shell-debug");
    options.replaceChildren();
    if (!card) {
      prompt.textContent = "선택 카드 없음";
      clearShellUnlockTimer();
      clearShellAutoContinueTimer();
      clearShellAutoContinuePaintState();
      clearShellAutoContinueVisibilityObserver();
      return;
    }
    var submitted = restoredShellSubmission(card.cardId);
    var restored = submitted && submitted.status === "resolved" ? submitted : null;
    var resolved = card.status === "resolved" || Boolean(restored);
    var submittedForCard = shellSubmittedCardId === card.cardId || Boolean(submitted);
    var remainingMs = typeof card.availableAt === "number" ? Math.max(0, card.availableAt - Date.now()) : 0;
    var locked = remainingMs > 0;
    var compact = card.compact === true && Array.isArray(card.options) && card.options.length === 1;
    var autoContinuation = isAutoContinuationCard(card);
    var iosPaintGatedAuto = usesIosActionablePaintGate(card);
    var baselineAuto = isBaselineAutoContinueCard(card);
    var visibilityPauseAuto = isVisibilityPauseAutoContinueCard(card);
    var intersectionPauseAuto = isPhase3IntersectionCard(card);
    var simpleAuto = baselineAuto || visibilityPauseAuto || (autoContinuation && isIosLikeShellClient());
    if (simpleAuto && !iosPaintGatedAuto && !submittedForCard && !resolved && shellVisibilityPauseStoppedCardId !== card.cardId) markShellAutoContinueRendered(card);
    var autoState = autoContinuation ? restoredShellAutoContinue(card.cardId) : null;
    var autoCancelLatched = autoContinuation && cancelShellAutoContinue.pendingCardId === card.cardId;
    var showAutoCancel = Boolean(autoContinuation && !submittedForCard && !resolved &&
      (!autoState || (autoState.status !== "sent" && autoState.status !== "attempting")));
    var autoDeadline = autoContinuation ? shellAutoContinueDeadline(card) : null;
    var autoRemainingMs = autoContinuation
      ? (autoDeadline === null ? shellAutoContinueDelayMs(card) : Math.max(0, autoDeadline - Date.now()))
      : 0;
    options.classList.toggle("shell-auto-pair", showAutoCancel);
    prompt.textContent = card.prompt || "선택 필요";
    (Array.isArray(card.options) ? card.options : []).forEach(function (option) {
      var button = document.createElement("button");
      button.className = "shell-option";
      if (compact && resolved) button.classList.add("shell-resolved");
      if (option.id === "continue") button.id = "shell-continue-button";
      button.disabled = shellBusy || submittedForCard || resolved || locked;
      var title = document.createElement("span");
      title.className = "shell-option-title";
      if (option.id === "continue") title.id = "shell-continue-title";
      if (compact && resolved) {
        title.textContent = "완료 ✓";
      } else {
        title.textContent = simpleAuto ? (option.label || option.id || "선택") : (autoContinuation && option.id === "continue" ? "지금 계속" : (option.label || option.id || "선택"));
        if (simpleAuto && option.id === "continue" && !autoCancelLatched && !autoState) {
          title.textContent = (option.label || "계속 진행하기") + " · " + Math.max(0, Math.ceil(autoRemainingMs / 1000)) + "초";
        }
        if (locked && compact) title.textContent += " · " + formatShellDelay(remainingMs) + " 후";
        if (restored && restored.choiceId === option.id) title.textContent += " ✓";
      }
      button.appendChild(title);
      if (option.description && !(compact && resolved)) {
        var description = document.createElement("span");
        description.className = "shell-option-description";
        description.textContent = option.description;
        button.appendChild(description);
      }
      button.addEventListener("click", function () { void submitShellChoice(option.id, button); });
      options.appendChild(button);
    });
    if (showAutoCancel) {
      var cancel = document.createElement("button");
      cancel.className = "shell-option shell-cancel";
      cancel.disabled = shellBusy || autoCancelLatched || (autoState && autoState.status === "cancelled");
      var cancelTitle = document.createElement("span");
      cancelTitle.className = "shell-option-title";
      cancelTitle.textContent = autoCancelLatched || (autoState && autoState.status === "cancelled") ? "자동 진행 취소됨" : "자동 진행 취소";
      cancel.appendChild(cancelTitle);
      var cancelRequested = false;
      var requestAutoCancel = function (event) {
        if (cancel.disabled || cancelRequested) return;
        cancelRequested = true;
        cancelShellAutoContinue.pendingCardId = card.cardId;
        cancel.disabled = true;
        cancelTitle.textContent = "자동 진행 취소됨";
        var continueTitle = document.getElementById("shell-continue-title");
        if (continueTitle) continueTitle.textContent = (card.options && card.options[0] && card.options[0].label) || "계속 진행하기";
        clearShellAutoContinueTimer();
        void cancelShellAutoContinue(card);
      };
      cancel.addEventListener("pointerdown", requestAutoCancel);
      cancel.addEventListener("click", requestAutoCancel);
      options.appendChild(cancel);
    }
    if (restored) {
      status.textContent = "✅ 선택 완료 · " + (restored.choiceLabel || restored.choiceId);
    } else if (submittedForCard) {
      status.textContent = "⏳ 진행 요청됨";
    } else if (visibilityPauseAuto && shellVisibilityPauseStoppedCardId === card.cardId && !shellBusy) {
      status.textContent = "다른 채팅 이동 감지 · 자동 진행 중지됨.";
    } else if (intersectionPauseAuto && shellPhase3IntersectionStoppedCardId === card.cardId && !shellBusy) {
      status.textContent = "카드 비가시 감지 · 자동 진행 중지됨.";
    } else if (autoCancelLatched || (autoContinuation && autoState && autoState.status === "cancelled")) {
      status.textContent = "자동 진행 취소됨 · 필요하면 지금 계속을 눌러 주세요.";
    } else if (autoContinuation && autoState && autoState.status === "ready") {
      status.textContent = "자동 진행이 차단됨 · 지금 계속을 눌러 주세요.";
    } else if (autoContinuation && autoState && autoState.status === "attempting") {
      status.textContent = "자동 진행 요청 중";
    } else if (simpleAuto && !shellBusy) {
      status.textContent = Math.max(0, Math.ceil(autoRemainingMs / 1000)) + "초 후 자동으로 계속합니다.";
    } else if (autoContinuation && !shellBusy) {
      status.textContent = autoDeadline === null
        ? "실제 채팅 진입 신호(hidden→visible + 사용자 활성화)가 확인되면 15초 카운트다운을 시작합니다. 확인되지 않으면 자동 진행하지 않습니다."
        : Math.max(0, Math.ceil(autoRemainingMs / 1000)) + "초 후 자동으로 계속합니다.";
    } else if (locked && !compact) {
      status.textContent = formatShellDelay(remainingMs) + " 후 사용 가능";
    } else if (!shellBusy) {
      status.textContent = "";
    }
    if (debug) {
      if (isVisibilityDiagnosticCard(card)) debug.textContent = formatShellVisibilityDiagnostic(card);
      else if (isPhase22RemountResetCard(card)) debug.textContent = "STEP 2.2 · REMOUNT-RESET · R1 · " + (Number.isFinite(shellRemountResetStartedAtByCard[card.cardId]) ? "remount→15s" : "initial");
      else if (visibilityPauseAuto) debug.textContent = "STEP 2.0 · VIS-HIDDEN";
      else if (intersectionPauseAuto) debug.textContent = "STEP 3.0 · INTERSECTION";
      else if (baselineAuto) debug.textContent = "STEP 1.0 · BASELINE";
      else debug.textContent = "";
    }
    if ((intersectionPauseAuto && !submittedForCard && !resolved && shellPhase3IntersectionStoppedCardId !== card.cardId) || (!simpleAuto && autoContinuation && !submittedForCard && !resolved && !autoState)) {
      prepareShellAutoForegroundGate(card);
      armShellAutoContinueVisibility(card);
    } else {
      clearShellAutoContinueVisibilityObserver();
    }
    scheduleShellUnlock(card);
    scheduleShellAutoContinue(card);
    if (iosPaintGatedAuto && !submittedForCard && !resolved && !autoState) {
      armShellAutoContinueAfterActionablePaint(card);
    } else if (iosPaintGatedAuto && (submittedForCard || resolved || autoState)) {
      clearShellAutoContinuePaintState(card.cardId);
    }
  }
  function formatShellDelay(ms) {
    var totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    if (totalSeconds < 60) return totalSeconds + "초";
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return seconds ? minutes + "분 " + seconds + "초" : minutes + "분";
  }
  function refreshShellAutoContinueStatus(card) {
    if (!isAutoContinuationCard(card)) return;
    var continueTitle = document.getElementById("shell-continue-title");
    if (!continueTitle) return;
    var baseLabel = (card.options && card.options[0] && card.options[0].label) || "계속 진행하기";
    var autoState = restoredShellAutoContinue(card.cardId);
    if (autoState && autoState.status === "cancelled") {
      continueTitle.textContent = baseLabel;
      return;
    }
    if (autoState && autoState.status === "ready") {
      continueTitle.textContent = baseLabel;
      return;
    }
    if (autoState && autoState.status === "attempting") {
      continueTitle.textContent = "계속 진행 중…";
      return;
    }
    var deadline = shellAutoContinueDeadline(card);
    if (deadline === null) {
      continueTitle.textContent = baseLabel;
      return;
    }
    continueTitle.textContent = baseLabel + " · " + Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) + "초";
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
  function clearShellAutoContinueTimer() {
    if (shellAutoContinueTimer !== null) clearInterval(shellAutoContinueTimer);
    shellAutoContinueTimer = null;
    shellAutoContinueCardId = null;
  }
  function noteShellAutoContinueTick(card, now) {
    if (!isAutoContinuationCard(card)) {
      shellAutoContinueLastTickAt = null;
      return false;
    }
    var observedAt = Number.isFinite(now) ? now : Date.now();
    var active = shellAutoForegroundArmedThisMount && shellAutoViewportVisible && document.hidden !== true && !shellAutoForegroundSawHidden;
    if (!active) {
      shellAutoContinueLastTickAt = null;
      return false;
    }
    var previousAt = shellAutoContinueLastTickAt;
    shellAutoContinueLastTickAt = observedAt;
    if (!Number.isFinite(previousAt) || observedAt - previousAt <= 2500) return false;
    shellAutoForegroundNotBefore = observedAt;
    shellAutoContinueRenderCardId = card.cardId;
    shellAutoContinueRenderStartedAt = observedAt;
    void persistShellAutoContinueRenderStart(card.cardId, observedAt);
    void persistShellAutoForegroundGate(card.cardId, "armed", "event-loop-resume-gap");
    return true;
  }
  function submitShellAutoContinueAfterPaint(card) {
    if (!isAutoContinuationCard(card)) return;
    if (typeof requestAnimationFrame !== "function") {
      void persistShellAutoForegroundGate(card.cardId, "waiting-paint", "animation-frame-unavailable");
      return;
    }
    var requestedAt = Date.now();
    requestAnimationFrame(function () {
      var paintedAt = Date.now();
      if (paintedAt - requestedAt > 500) {
        shellAutoForegroundNotBefore = paintedAt;
        shellAutoContinueLastTickAt = paintedAt;
        void persistShellAutoForegroundGate(card.cardId, "armed", "animation-frame-resume-gap");
        renderShellChoice(output());
        scheduleShellAutoContinue(card);
        return;
      }
      void submitShellAutoContinue(card);
    });
  }
  function shellAutoContinueClientAllowsTimer() {
    var nav = typeof navigator === "object" && navigator ? navigator : null;
    if (!nav) return true;
    var ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
    var platform = typeof nav.platform === "string" ? nav.platform : "";
    var uaPlatform = nav.userAgentData && typeof nav.userAgentData.platform === "string" ? nav.userAgentData.platform : "";
    var maxTouchPoints = Number(nav.maxTouchPoints || 0);
    var isiOS = /iPhone|iPad|iPod/i.test(ua)
      || /iPhone|iPad|iPod/i.test(platform)
      || /iOS/i.test(uaPlatform)
      || (platform === "MacIntel" && maxTouchPoints > 1);
    return !isiOS;
  }
  function scheduleBaselineAutoContinue(card) {
    if (!(isSimpleAutoContinueCard(card) || (isAutoContinuationCard(card) && isIosLikeShellClient())) || card.status === "resolved" || restoredShellSubmission(card.cardId)) {
      clearShellAutoContinueTimer();
      return;
    }
    if (isVisibilityPauseAutoContinueCard(card) && (document.hidden === true || shellVisibilityPauseStoppedCardId === card.cardId)) {
      clearShellAutoContinueTimer();
      return;
    }
    var autoState = restoredShellAutoContinue(card.cardId);
    if (autoState && (autoState.status === "sent" || autoState.status === "cancelled" || autoState.status === "attempting" || autoState.status === "ready")) {
      clearShellAutoContinueTimer();
      return;
    }
    if (usesIosActionablePaintGate(card) && (document.hidden === true || !Number.isFinite(shellAutoContinuePaintStartedAtByCard[card.cardId]))) {
      if (document.hidden === true) clearShellAutoContinuePaintState(card.cardId);
      clearShellAutoContinueTimer();
      return;
    }
    var deadline = shellAutoContinueDeadline(card);
    if (deadline === null) {
      markShellAutoContinueRendered(card);
      deadline = shellAutoContinueDeadline(card);
    }
    if (deadline === null) {
      clearShellAutoContinueTimer();
      return;
    }
    if (Date.now() >= deadline) {
      clearShellAutoContinueTimer();
      void submitBaselineAutoContinue(card);
      return;
    }
    if (shellAutoContinueTimer !== null && shellAutoContinueCardId === card.cardId) return;
    clearShellAutoContinueTimer();
    shellAutoContinueCardId = card.cardId;
    shellAutoContinueTimer = setInterval(function () {
      var currentOut = output();
      var currentCard = currentOut && currentOut.card && currentOut.card.kind === "choice" ? currentOut.card : null;
      if (!currentCard || currentCard.cardId !== shellAutoContinueCardId) {
        clearShellAutoContinueTimer();
        return;
      }
      if (usesIosActionablePaintGate(currentCard) && document.hidden === true) {
        clearShellAutoContinuePaintState(currentCard.cardId);
        clearShellAutoContinueTimer();
        renderShellChoice(currentOut);
        return;
      }
      if (isVisibilityPauseAutoContinueCard(currentCard) && document.hidden === true) {
        shellVisibilityPauseStoppedCardId = currentCard.cardId;
        clearShellAutoContinueTimer();
        renderShellChoice(currentOut);
        return;
      }
      var currentState = restoredShellAutoContinue(currentCard.cardId);
      if (currentState || restoredShellSubmission(currentCard.cardId) || currentCard.status === "resolved") {
        clearShellAutoContinueTimer();
        renderShellChoice(currentOut);
        return;
      }
      var currentDeadline = shellAutoContinueDeadline(currentCard);
      if (currentDeadline !== null && Date.now() >= currentDeadline) {
        clearShellAutoContinueTimer();
        void submitBaselineAutoContinue(currentCard);
        return;
      }
      refreshShellAutoContinueStatus(currentCard);
    }, 1000);
  }
  function scheduleShellAutoContinue(card) {
    if (previewMode) {
      clearShellAutoContinueTimer();
      return;
    }
    if (isSimpleAutoContinueCard(card) || (isAutoContinuationCard(card) && isIosLikeShellClient())) {
      scheduleBaselineAutoContinue(card);
      return;
    }
    if (!isAutoContinuationCard(card) || card.status === "resolved" || restoredShellSubmission(card.cardId)) {
      clearShellAutoContinueTimer();
      return;
    }
    if (!shellAutoContinueClientAllowsTimer()) {
      clearShellAutoContinueTimer();
      void persistShellAutoForegroundGate(card.cardId, "manual-only", "ios-no-reliable-chat-visibility");
      return;
    }
    var autoState = restoredShellAutoContinue(card.cardId);
    if (autoState && (autoState.status === "sent" || autoState.status === "cancelled" || autoState.status === "attempting" || autoState.status === "ready")) {
      clearShellAutoContinueTimer();
      return;
    }
    var now = Date.now();
    noteShellAutoContinueTick(card, now);
    var deadline = shellAutoContinueDeadline(card);
    if (deadline === null) {
      clearShellAutoContinueTimer();
      return;
    }
    if (now >= deadline) {
      clearShellAutoContinueTimer();
      submitShellAutoContinueAfterPaint(card);
      return;
    }
    if (shellAutoContinueTimer !== null && shellAutoContinueCardId === card.cardId) return;
    clearShellAutoContinueTimer();
    shellAutoContinueCardId = card.cardId;
    shellAutoContinueTimer = setInterval(function () {
      var currentOut = output();
      var currentCard = currentOut && currentOut.card && currentOut.card.kind === "choice" ? currentOut.card : null;
      if (!currentCard || currentCard.cardId !== shellAutoContinueCardId) {
        clearShellAutoContinueTimer();
        return;
      }
      var currentState = restoredShellAutoContinue(currentCard.cardId);
      if (currentState || restoredShellSubmission(currentCard.cardId) || currentCard.status === "resolved") {
        clearShellAutoContinueTimer();
        renderShellChoice(currentOut);
        return;
      }
      var currentNow = Date.now();
      var resumedFromGap = noteShellAutoContinueTick(currentCard, currentNow);
      if (resumedFromGap) {
        renderShellChoice(currentOut);
        return;
      }
      var currentDeadline = shellAutoContinueDeadline(currentCard);
      if (currentDeadline !== null && currentNow >= currentDeadline) {
        clearShellAutoContinueTimer();
        submitShellAutoContinueAfterPaint(currentCard);
        return;
      }
      refreshShellAutoContinueStatus(currentCard);
    }, 1000);
  }
  async function cancelShellAutoContinue(card) {
    if (!isAutoContinuationCard(card) || restoredShellSubmission(card.cardId)) return;
    var state = restoredShellAutoContinue(card.cardId);
    if (state && (state.status === "sent" || state.status === "attempting")) return;
    shellAutoContinueCancelledCardId = card.cardId;
    await persistShellAutoContinue(card.cardId, "cancelled");
    clearShellAutoContinueTimer();
    renderShellChoice(output());
  }
  function shellContinuationInput(card, selectedOption) {
    var label = selectedOption && selectedOption.label === "고고" ? "고고" : "계속 진행";
    var nextStep = selectedOption && selectedOption.description
      ? selectedOption.description
      : (card && card.prompt ? card.prompt : "");
    var prompt = label + ". 이 메시지는 Widget Shell의 일반 선택 입력입니다. 별도 continuation receipt나 숨은 continuation 상태를 조회하지 말고, 현재 대화에서 이미 정해진 다음 작업을 바로 이어서 수행해.";
    if (nextStep) prompt += " 다음 작업: " + nextStep;
    return prompt;
  }
  async function submitBaselineAutoContinue(card) {
    if (shellBusy || !(isSimpleAutoContinueCard(card) || (isAutoContinuationCard(card) && isIosLikeShellClient())) || restoredShellSubmission(card.cardId)) return;
    var deadline = shellAutoContinueDeadline(card);
    if (deadline === null || Date.now() < deadline || (typeof card.availableAt === "number" && Date.now() < card.availableAt)) return;
    if (typeof card.expiresAt === "number" && Date.now() >= card.expiresAt) return;
    var currentOut = output();
    var currentCard = currentOut && currentOut.card && currentOut.card.kind === "choice" ? currentOut.card : null;
    if (!currentCard || currentCard.cardId !== card.cardId) return;
    var autoState = restoredShellAutoContinue(card.cardId);
    if (autoState) return;
    shellBusy = true;
    shellSubmittedCardId = card.cardId;
    await persistShellAutoContinue(card.cardId, "attempting");
    var followUpSucceeded = await beginFollowUpTurn(card.cardId, shellContinuationInput(card, card.options && card.options[0]), { officialOnly: true });
    if (!followUpSucceeded) {
      await persistShellAutoContinue(card.cardId, "ready");
      shellSubmittedCardId = null;
      shellBusy = false;
      renderShellChoice(output());
      return;
    }
    await persistShellSubmission(card, "continue");
    await persistShellChoice(card, "continue");
    await persistShellAutoContinue(card.cardId, "sent");
    shellBusy = false;
    renderShellChoice(output());
  }
  async function submitShellAutoContinue(card) {
    if (!shellAutoContinueClientAllowsTimer()) return;
    if (shellBusy || !isAutoContinuationCard(card) || restoredShellSubmission(card.cardId)) return;
    if (shellAutoContinueCancelledCardId === card.cardId) return;
    var deadline = shellAutoContinueDeadline(card);
    if (deadline === null || Date.now() < deadline || (typeof card.availableAt === "number" && Date.now() < card.availableAt)) return;
    if (typeof card.expiresAt === "number" && Date.now() >= card.expiresAt) return;
    var currentOut = output();
    var currentCard = currentOut && currentOut.card && currentOut.card.kind === "choice" ? currentOut.card : null;
    if (!currentCard || currentCard.cardId !== card.cardId) return;
    var autoState = restoredShellAutoContinue(card.cardId);
    if (autoState) return;
    shellBusy = true;
    shellSubmittedCardId = card.cardId;
    await persistShellAutoContinue(card.cardId, "attempting");
    var followUpSucceeded = await beginFollowUpTurn(card.cardId, shellContinuationInput(card, card.options && card.options[0]), { officialOnly: true });
    if (!followUpSucceeded) {
      await persistShellAutoContinue(card.cardId, "ready");
      shellSubmittedCardId = null;
      shellBusy = false;
      renderShellChoice(output());
      return;
    }
    await persistShellSubmission(card, "continue");
    await persistShellChoice(card, "continue");
    await persistShellAutoContinue(card.cardId, "sent");
    shellBusy = false;
    renderShellChoice(output());
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
    var selectedOption = (Array.isArray(card.options) ? card.options : []).find(function (option) { return option.id === choiceId; });
    var compactSingleChoice = card.compact === true && Array.isArray(card.options) && card.options.length === 1;
    var compactContinuation = compactSingleChoice && choiceId === "continue";
    var userFollowUpPrompt = compactContinuation
      ? shellContinuationInput(card, selectedOption)
      : ((selectedOption && selectedOption.label) || "선택 완료");
    var followUpPromise = beginFollowUpTurn(card.cardId, userFollowUpPrompt);
    try {
      await persistShellChoice(card, choiceId);
      if (clickedButton) {
        var clickedTitle = clickedButton.querySelector(".shell-option-title");
        if (clickedTitle) clickedTitle.textContent = compactSingleChoice ? "완료 ✓" : clickedTitle.textContent + " ✓";
        if (compactSingleChoice) {
          clickedButton.classList.add("shell-resolved");
          var clickedDescription = clickedButton.querySelector(".shell-option-description");
          if (clickedDescription) clickedDescription.remove();
        }
      }
    } catch (_) {
      shellBusy = false;
      document.getElementById("shell-status").textContent = "❌ 선택 상태 저장 실패 · 버튼 잠금 유지 · 새 카드 필요";
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
    if (compactContinuation && isAutoContinuationCard(card)) {
      await persistShellAutoContinue(card.cardId, followUpSucceeded ? "sent" : "ready");
      clearShellAutoContinueTimer();
    }
    document.getElementById("shell-status").textContent = followUpSucceeded
      ? "✅ 선택 완료 · 후속 대화 요청 전송"
      : "✅ 선택 완료 · 후속 대화 요청 실패";
    scheduleIntrinsicHeight();
  }
  async function copyReentryToken() {
    var tokenNode = document.getElementById("reentry-token");
    var text = (tokenNode && tokenNode.dataset.copyText) || "@C2CT";
    var copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch (_) {}
    if (!copied) {
      try {
        var scratch = document.createElement("textarea");
        scratch.value = text;
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.opacity = "0";
        document.body.appendChild(scratch);
        scratch.select();
        copied = document.execCommand("copy");
        scratch.remove();
      } catch (_) {
        copied = false;
      }
    }
    if (copied) reentryCopyFeedbackUntil = Date.now() + 1800;
    if (tokenNode) {
      tokenNode.classList.toggle("copied", copied);
      tokenNode.textContent = copied ? "✓ 복사완료" : text;
    }
    if (copied) {
      setTimeout(function () {
        if (Date.now() < reentryCopyFeedbackUntil) return;
        if (tokenNode) {
          tokenNode.classList.remove("copied");
          tokenNode.textContent = tokenNode.dataset.copyText || "@C2CT";
        }
        scheduleIntrinsicHeight();
      }, 1850);
    }
    scheduleIntrinsicHeight();
  }
  function render() {
    syncCurrentRequest();
    var out = output();
    var hostTheme = api().theme;
    if (hostTheme === "light" || hostTheme === "dark") document.body.setAttribute("data-host-theme", hostTheme);
    var labMode = presentationKind === "widget-capability-lab";
    var shellMode = presentationKind === "widget-shell-choice";
    var preapplyMode = presentationKind === "widget-preapply-load-only";
    var reentryMode = presentationKind === "catalog-host-reentry";
    // Keep the widget visible while iOS hydrates toolOutput/toolResponseMetadata.
    // Some iOS hosts mount the iframe before exposing the presenter result;
    // hiding body here leaves a permanent blank host frame if no later globals
    // event is delivered. A visible loading state plus bounded polling makes that
    // race recoverable and gives us observable evidence when hydration fails.
    document.body.style.display = "block";
    // Only an authoritative server status may terminalize an approval as
    // expired. A client-side clock estimate must never close a still-pending
    // operation card.
    var approvalStillNeeded = Boolean(entry && (
      entry.status === "checking" || entry.status === "pending" || entry.status === "working" || entry.status === "error"
    ));
    var minimalApprovalMode = Boolean(entry && !labMode && !shellMode && !preapplyMode && !approvalStillNeeded);
    if (reentryMode) minimalApprovalMode = false;
    var cardNode = document.querySelector(".card");
    var criticalSurfaceMode = Boolean(entry && entry.approvalSeverity === "critical" && !labMode && !shellMode && !preapplyMode && !reentryMode);
    var criticalMode = Boolean(criticalSurfaceMode && !minimalApprovalMode);
    var shellCompactMode = Boolean(shellMode && out.card && out.card.compact === true && Array.isArray(out.card.options) && out.card.options.length === 1);
    var shellAutoMode = Boolean(shellMode && isAutoContinuationCard(out.card));
    if (cardNode) cardNode.classList.toggle("critical", criticalSurfaceMode);
    if (cardNode) cardNode.classList.toggle("shell-compact", shellCompactMode);
    if (cardNode) cardNode.classList.toggle("shell-auto", shellAutoMode);
    if (cardNode) cardNode.classList.toggle("preapply-minimal", preapplyMode);
    if (cardNode) cardNode.classList.toggle("reentry-compact", reentryMode);
    if (cardNode) cardNode.hidden = false;
    document.getElementById("card-title").textContent = reentryMode
      ? "C2CT 다시 연결"
      : shellMode
      ? ((out.card && out.card.title) || "선택")
      : (labMode
        ? "Widget Capability Lab"
        : (preapplyMode
          ? "Runtime 교체 사전준비"
          : (minimalApprovalMode ? "승인 상태" : (criticalMode ? "⚠️ 고위험 승인" : "확인"))));
    document.getElementById("card-title-state").textContent =
      reentryMode
        ? "직접 전송"
        : preapplyMode
        ? "승인 UI 확인 완료"
        : (!labMode && !shellMode ? (entry ? stateLabel(entry.status) : (hydrationExhausted ? "확인 불가" : "")) : "");
    var approval = document.getElementById("approval");
    var shell = document.getElementById("shell");
    var reentry = document.getElementById("reentry");
    var lab = document.getElementById("lab");
    approval.replaceChildren();
    approval.hidden = labMode || shellMode || reentryMode;
    shell.hidden = !shellMode;
    reentry.hidden = !reentryMode;
    lab.hidden = !labMode;
    if (reentryMode) {
      // Keep this short client copy authoritative so a hot-applied widget does
      // not resurrect verbose guidance from an older still-running presenter.
      document.getElementById("reentry-note").textContent = "탭해서 복사 후 입력창에 붙여넣고 도구 선택, 전송";
      var reentryToken = document.getElementById("reentry-token");
      reentryToken.dataset.copyText = out.hostToolMention || "@C2CT";
      if (reentryToken.dataset.copyBound !== "true") {
        reentryToken.addEventListener("click", copyReentryToken);
        reentryToken.dataset.copyBound = "true";
      }
      var reentryCopyFeedbackActive = Date.now() < reentryCopyFeedbackUntil;
      reentryToken.classList.toggle("copied", reentryCopyFeedbackActive);
      reentryToken.textContent = reentryCopyFeedbackActive ? "✓ 복사완료" : reentryToken.dataset.copyText;
      scheduleIntrinsicHeight();
      return;
    }
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
    if (preapplyMode) {
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
      var terminalOperationApproval = entry.requestId.indexOf("op_") === 0
        && usesCommandTerminalObserver(entry)
        && (entry.status === "allowed" || entry.status === "consumed");
      if (terminalOperationApproval && !entry.operationTerminal && !entry.operationObserverFailed) {
        entry.message = entry.message || "승인 완료 · 작업 상태 확인 중";
        if (!operationObserveInFlight || operationObserveRequestId !== entry.requestId) {
          scheduleApprovedOperationObservation(entry, 0);
        }
      }
      if (entry.message) {
        var minimalMessage = document.createElement("div");
        minimalMessage.className = "status";
        minimalMessage.textContent = entry.message;
        approval.appendChild(minimalMessage);
      }
      if (terminalOperationApproval && entry.operationTerminal && entry.exactOperationId) {
        var continuation = restoredApprovalContinuation(entry.requestId);
        if (!continuation && approvalContinuationRequestId !== entry.requestId) {
          autoResumeApprovedOperationOnce(entry, terminalOperationFollowUpPrompt(entry));
          continuation = restoredApprovalContinuation(entry.requestId);
        }
        var resumeStatus = document.createElement("div");
        resumeStatus.className = "status";
        resumeStatus.textContent = continuation && continuation.status === "failed"
          ? "대화 자동 재개 실패 · 승인된 작업은 재실행하지 않습니다."
          : (continuation && continuation.status === "sent" ? "현재 채팅 자동 재개됨" : "현재 채팅 자동 재개 중");
        approval.appendChild(resumeStatus);
      }
      if (entry.status === "unavailable" && entry.token) {
        var checkStatus = document.createElement("button");
        checkStatus.textContent = "상태만 다시 확인";
        checkStatus.addEventListener("click", function () {
          entry.status = "checking";
          entry.reconciled = true;
          statusRefreshedRequestId = null;
          statusRefreshAttempts[entry.requestId] = 0;
          maybeRefreshPersistedStatus();
          render();
        });
        approval.appendChild(checkStatus);
      }
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
        warningText = "실행 중인 runtime을 실제로 교체합니다. 정상 적용 후 ChatGPT 설정에서 C2CT를 수동 새로고침합니다.";
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
      allow.textContent = entry.projectScopeAllowed ? "이번만 허용" : (criticalMode ? "위험을 이해하고 승인" : "허용");
      if (criticalMode) allow.className = "critical-allow";
      var allowProject = entry.projectScopeAllowed ? document.createElement("button") : null;
      if (allowProject) allowProject.textContent = "이 프로젝트에서 허용";
      var disabled = entry.status !== "pending";
      deny.disabled = disabled;
      allow.disabled = disabled;
      if (allowProject) allowProject.disabled = disabled;
      bindApprovalDecisionButton(deny, entry, "deny");
      bindApprovalDecisionButton(allow, entry, "allow");
      if (allowProject) bindApprovalDecisionButton(allowProject, entry, "allow-project");
      if (allowProject) actions.append(deny, allow, allowProject);
      else actions.append(deny, allow);
      approval.appendChild(actions);
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
  function beginDecision(entry, decision, interactionProof) {
    var args = { requestId: entry.requestId, token: entry.token, decision: decision };
    // This widget asset can be hot-applied before the matching runtime. Only
    // send the v29 callback field when the server presenter explicitly says it
    // supports it, otherwise an older additionalProperties:false callback
    // schema would reject an otherwise valid human approval.
    if (entry.interactionProofRequired === true && interactionProof) args.interactionProof = interactionProof;
    var a = api();
    var transport = mcpHostCapabilities && mcpHostCapabilities.serverTools ? "mcp.tools/call"
      : (typeof a.callTool === "function" ? "openai.callTool" : "none");
    approvalEvent(entry, "bridge_selected", transport);
    // Prefer the already-initialized MCP Apps serverTools bridge. Initialization
    // is warmed on mount, so this still dispatches synchronously in the click stack.
    // If MCP Apps is not ready at click time, use native callTool as the single
    // mutation bridge. Never try a second bridge after any dispatch attempt.
    var promise;
    try {
      if (transport === "openai.callTool") promise = a.callTool(entry.decisionTool, args);
      else if (transport === "mcp.tools/call") promise = request("tools/call", { name: entry.decisionTool, arguments: args });
      else {
        approvalEvent(entry, "bridge_unavailable");
        return Promise.reject(new Error("Approval bridge unavailable"));
      }
      approvalEvent(entry, "promise_created", transport);
    } catch (_) {
      approvalEvent(entry, "bridge_threw", transport);
      return Promise.reject(new Error("Approval bridge invocation failed"));
    }
    var settled = false;
    var observed = Promise.resolve(promise).then(function (value) {
      settled = true;
      approvalEvent(entry, "bridge_resolved", transport);
      return value;
    }, function () {
      settled = true;
      approvalEvent(entry, "bridge_rejected", transport);
      throw new Error("Approval bridge rejected");
    });
    return withTimeout(observed, 5000).catch(function (error) {
      if (!settled) approvalEvent(entry, "bridge_pending_timeout", transport);
      throw error;
    });
  }
  async function decide(entry, decision, interactionProof) {
    approvalEvent(entry, "click");
    if (entry.status !== "pending") {
      approvalEvent(entry, "duplicate_click_ignored");
      return;
    }
    if (!entry.requestId || !entry.token) {
      entry.status = "error";
      entry.message = "확인 채널 사용 불가";
      render();
      return;
    }
    entry.status = "working";
    entry.reconciled = false;
    var attempt = ++approvalAttemptSequence;
    entry.attempt = attempt;
    entry.message = "";
    statusRefreshedRequestId = null;
    statusRefreshAttempts[entry.requestId] = 0;
    // Neither rendering nor persistence is on the critical mutation path.
    var decisionPromise = beginDecision(entry, decision, interactionProof);
    void persistApprovalInteraction(entry.requestId, "working");
    render();
    // Start authoritative status reconciliation immediately, independently of
    // the decision transport promise. On iOS the host bridge can remain
    // unresolved after the tap while the server receipt is still pending;
    // without this watchdog the card stays disabled in local "working" state
    // and the user has no way to recover it.
    setTimeout(maybeRefreshPersistedStatus, 500);
    var isAllowDecision = decision === "allow" || decision === "allow-project";
    var operationApproval = entry.requestId.indexOf("op_") === 0;
    var userFollowUpPrompt = operationApproval
      ? (isAllowDecision
        ? (entry.allowFollowUpPrompt || ${JSON.stringify(CHATGPT_OPERATION_APPROVAL_USER_PROMPTS.allow)})
        : (entry.denyFollowUpPrompt || ${JSON.stringify(CHATGPT_OPERATION_APPROVAL_USER_PROMPTS.deny)}))
      : (decision === "allow-project"
        ? ${JSON.stringify(CHATGPT_STANDARD_CONSENT_USER_PROMPTS.allowProject)}
        : (decision === "allow"
          ? ${JSON.stringify(CHATGPT_STANDARD_CONSENT_USER_PROMPTS.allow)}
          : ${JSON.stringify(CHATGPT_STANDARD_CONSENT_USER_PROMPTS.deny)}));
    try {
      // Never create a conversation continuation until the authoritative
      // decision response (or the bounded status recovery below) proves Allow.
      var turnlessApproval = entry.turnlessContinuationAfterApproval === true;
      var followUpAttempted = false;
      var followUpPromise = Promise.resolve(true);
      var rawDecisionResult = await decisionPromise;
      if (entry.attempt !== attempt || presentationKind === "widget-preapply-load-only") return;
      if (rawDecisionResult && rawDecisionResult.isError === true) {
        var rejectedDecision = structured(rawDecisionResult);
        var rejectedError = new Error("approval decision rejected");
        rejectedError.code = rejectedDecision.code || "TOOL_RESULT_ERROR";
        throw rejectedError;
      }
      var decisionResult = structured(rawDecisionResult);
      var resolvedStatus = mapPersistedStatus(decisionResult.status);
      if (isAllowDecision ? (resolvedStatus !== "allowed" && resolvedStatus !== "consumed") : resolvedStatus !== "denied") {
        throw new Error("Approval decision was not confirmed");
      }
      approvalEvent(entry, "authoritative_" + resolvedStatus);
      entry.exactOperationId = decisionResult.exactOperationId || decisionResult.operationId || entry.exactOperationId || "";
      if (turnlessApproval && isAllowDecision && decisionResult.executionLinkPending === true) {
        entry.status = resolvedStatus;
        entry.message = "승인 완료 · 작업 연결 확인 중";
      } else if (turnlessApproval && isAllowDecision && decisionResult.operationState === "completed") {
        entry.status = resolvedStatus;
        entry.message = "작업 완료";
      } else if (turnlessApproval && isAllowDecision && (decisionResult.operationState === "queued" || decisionResult.operationState === "spawning")) {
        entry.status = resolvedStatus;
        entry.message = "승인 완료 · 작업 시작 중";
      } else if (turnlessApproval && isAllowDecision && (decisionResult.operationState === "running" || decisionResult.operationState === "cleanup")) {
        entry.status = resolvedStatus;
        entry.message = "승인 완료 · 작업 실행 중";
      } else if (turnlessApproval && isAllowDecision && decisionResult.continuationDeferred === true) {
        entry.status = resolvedStatus;
        entry.message = "승인 완료 · 기존 작업 종료 대기 중";
      } else if (turnlessApproval && isAllowDecision && decisionResult.continuationStarted === true) {
        entry.status = resolvedStatus;
        entry.message = "승인 완료 · 작업 시작됨";
      } else if (turnlessApproval && isAllowDecision && decisionResult.fallbackRequiresExactReplay === false) {
        entry.status = resolvedStatus;
        entry.message = turnlessContinuationStallMessage(decisionResult);
      } else {
        entry.status = isAllowDecision ? "allowed" : "denied";
        entry.message = "";
      }
      entry.token = null;
      persistWidgetDecision(entry.requestId, entry.status);
      if (operationApproval && isAllowDecision && decisionResult.fallbackRequiresExactReplay === true) {
        entry.message = "승인 완료 · exact operation 자동 실행 실패 · mutation은 재실행하지 않습니다.";
        render();
        return;
      }
      render();
      if (operationApproval && isAllowDecision) {
        autoResumeApprovedOperationOnce(entry, userFollowUpPrompt);
        if (usesCommandTerminalObserver(entry)) {
          entry.operationObservationStartedAt = entry.operationObservationStartedAt || Date.now();
          void observeApprovedOperation(entry, decisionResult);
        }
        return;
        return;
      }
      if (!operationApproval) {
        followUpAttempted = true;
        followUpPromise = beginFollowUpTurn(entry.requestId, userFollowUpPrompt);
        var followUpFailed = !(await followUpPromise);
        if (followUpFailed) {
          entry.message = "후속 대화 자동 열기 실패";
          render();
        }
      }
    } catch (_) {
      if (entry.attempt !== attempt || entry.reconciled || presentationKind === "widget-preapply-load-only") return;
      if (entry.status === "allowed" || entry.status === "consumed") {
        autoResumeApprovedOperationOnce(entry, userFollowUpPrompt);
        if (usesCommandTerminalObserver(entry)) {
          entry.message = "승인 완료 · 작업 상태 확인 중";
          scheduleApprovedOperationObservation(entry, 0);
        }
        render();
        render();
        return;
      }
      if (entry.status === "denied") {
        render();
        return;
      }
      statusRefreshedRequestId = null;
      entry.status = "working";
      entry.message = "승인 응답 확인 중 · 서버 기록을 자동 확인합니다.";
      render();
      setTimeout(maybeRefreshPersistedStatus, 500);
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
  window.addEventListener("openai:set_globals", function () {
    openAiSetGlobalsCount += 1;
    render();
  });
  if (document && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", function () {
      var signal = document.hidden ? "visibility-hidden" : "visibility-visible";
      if (document.hidden === true) {
        var visibilityOut = output();
        var visibilityCard = visibilityOut && visibilityOut.card && visibilityOut.card.kind === "choice" ? visibilityOut.card : null;
        if (visibilityCard && usesIosActionablePaintGate(visibilityCard)) clearShellAutoContinuePaintState(visibilityCard.cardId);
      }
      recordShellVisibilityDiagnostic(signal);
      noteShellAutoForegroundSignal(signal);
      render();
    }, { passive: true });
  }
  window.addEventListener("blur", function () { recordShellVisibilityDiagnostic("window-blur"); }, { passive: true });
  window.addEventListener("focus", function () { recordShellVisibilityDiagnostic("window-focus"); }, { passive: true });
  window.addEventListener("pagehide", function () { clearOperationObserveTimer(); recordShellVisibilityDiagnostic("pagehide"); }, { passive: true });
  window.addEventListener("pageshow", function () { recordShellVisibilityDiagnostic("pageshow"); }, { passive: true });
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
  if (!previewMode) void ensureMcpAppsReady().catch(function () {});
  render();
  recordShellVisibilityDiagnostic("mount");
  // iOS can hydrate window.openai globals after the iframe's first script turn
  // without emitting openai:set_globals. Poll briefly so the approval payload
  // can still become visible; stop once the request is hydrated.
  var hydrationPolls = 0;
  var hydrationTimer = 0;
  var fastHydrationDelays = [16, 16, 18, 25, 25, 25];
  function pollHydration() {
    hydrationPolls += 1;
    render();
    if (entry || presentationKind === "widget-preapply-load-only" || hydrationPolls >= 40) {
      if (!entry && presentationKind !== "widget-preapply-load-only") hydrationExhausted = true;
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

const CHATGPT_CONSENT_WIDGET_FALLBACK_BASE64 =
  Buffer.from(CHATGPT_CONSENT_WIDGET_HTML, "utf8").toString("base64");
export const CHATGPT_CONSENT_WIDGET_BUNDLED_ASSET_REVISION =
  `sha256:${createHash("sha256").update(CHATGPT_CONSENT_WIDGET_HTML, "utf8").digest("hex")}`;
export const CHATGPT_CONSENT_WIDGET_LOADER_HTML =
  CHATGPT_CONSENT_WIDGET_LOADER_TEMPLATE.replace(
    "__C2CT_BUNDLED_FALLBACK_BASE64__",
    CHATGPT_CONSENT_WIDGET_FALLBACK_BASE64,
  ).replace(
    "__C2CT_BUNDLED_FALLBACK_REVISION__",
    CHATGPT_CONSENT_WIDGET_BUNDLED_ASSET_REVISION,
  );

export function chatGptWidgetResourceRevision(html: string): string {
  return `sha256:${createHash("sha256").update(html).digest("hex").slice(0, 24)}`;
}

// Keep a content-addressed direct document for diagnostics/cache-bust probes,
// but do not use it as the normal Widget Shell presenter. The normal presenter
// must go through the loader so chatgpt_widget_asset_apply can take effect
// without replacing the runtime.
export const CHATGPT_CONSENT_WIDGET_RESOURCE_REVISION =
  chatGptWidgetResourceRevision(CHATGPT_CONSENT_WIDGET_HTML);
const CHATGPT_CONSENT_WIDGET_RESOURCE_KEY =
  CHATGPT_CONSENT_WIDGET_RESOURCE_REVISION.slice("sha256:".length);
export const CHATGPT_CONSENT_WIDGET_DIRECT_URI =
  `ui://widget/c2ct-consent-${CHATGPT_CONSENT_WIDGET_RESOURCE_KEY}.html`;
export const CHATGPT_CONSENT_WIDGET_URI =
  `ui://widget/c2ct-consent-loader-v${CHATGPT_CONSENT_WIDGET_LOADER_VERSION}.html`;
export const CHATGPT_CONSENT_WIDGET_LAB_URI =
  `ui://widget/c2ct-consent-lab-${CHATGPT_CONSENT_WIDGET_RESOURCE_KEY}.html`;

// Operation approvals use one immutable self-contained document as the host
// cache boundary. This deliberately avoids the loader -> private asset_get
// round-trip on the critical approval path, because some iOS hosts can defer
// iframe/tool-bridge startup long after the presenter itself has returned.
// Shared Widget Shell/consent cards keep the hot-applied loader path above.
export const CHATGPT_OPERATION_APPROVAL_WIDGET_HTML = CHATGPT_CONSENT_WIDGET_HTML;
