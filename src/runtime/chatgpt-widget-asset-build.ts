import {
  CHATGPT_CONSENT_WIDGET_HTML,
  CHATGPT_WIDGET_ASSET_PROTOCOL_VERSION,
} from "../server/chatgpt-consent-widget.js";
import { emitCandidateChatGptWidgetAsset } from "./chatgpt-widget-assets.js";

async function main(): Promise<void> {
  const meta = await emitCandidateChatGptWidgetAsset({
    projectRoot: process.cwd(),
    html: CHATGPT_CONSENT_WIDGET_HTML,
    protocolVersion: CHATGPT_WIDGET_ASSET_PROTOCOL_VERSION,
  });
  process.stdout.write(`chatgpt-widget-asset=${meta.revision}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
