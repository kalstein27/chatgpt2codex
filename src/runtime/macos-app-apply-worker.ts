import { releaseRuntimeUpdateBarrier } from "./runtime-update-barrier.js";
import { runMacosAppApplyWorker } from "./macos-app-apply-transaction.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const stateDir = argument("--state-dir");
  const requestId = argument("--request-id");
  if (!stateDir || !requestId) {
    process.exitCode = 2;
    return;
  }
  try {
    const receipt = await runMacosAppApplyWorker(stateDir, requestId);
    if (receipt.state === "APPLY_FAILED_ROLLBACK_FAILED") process.exitCode = 1;
  } finally {
    const receiptOperationId = `app_${requestId}`;
    await releaseRuntimeUpdateBarrier(stateDir, receiptOperationId).catch(() => false);
  }
}

main().catch(() => {
  process.exitCode = 1;
});
