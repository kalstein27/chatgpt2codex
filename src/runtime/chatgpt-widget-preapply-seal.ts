import { sealChatGptWidgetPreapplyBuildReceipt } from "./chatgpt-widget-preapply.js";

async function main(): Promise<void> {
  const receipt = await sealChatGptWidgetPreapplyBuildReceipt(process.cwd());
  process.stdout.write(`chatgpt-widget-preapply=${receipt.candidateFingerprint.slice(0, 12)}:${receipt.widgetAssetRevision.slice(0, 19)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
