import { clearRuntimeApplyMaintenanceMarker, runRuntimeApplyWorker } from "./runtime-apply.js";
import { releaseRuntimeUpdateBarrier } from "./runtime-update-barrier.js";
import { markRuntimeApplyWorkerUnexpectedFailure, recordRuntimeApplyWorkerPid } from "./runtime-apply.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const stateDir = argument("--state-dir");
  const operationId = argument("--operation-id");
  const portValue = argument("--port");
  const port = portValue && /^\d{1,5}$/u.test(portValue) ? Number(portValue) : NaN;
  if (!stateDir || !operationId || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    process.exitCode = 2;
    return;
  }
  try {
    await recordRuntimeApplyWorkerPid(stateDir, operationId, process.pid);
    await runRuntimeApplyWorker({ stateDir, operationId, port, stabilityProbeCount: 7 });
  } catch {
    await markRuntimeApplyWorkerUnexpectedFailure(stateDir, operationId).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await clearRuntimeApplyMaintenanceMarker(stateDir, operationId).catch(() => undefined);
    await releaseRuntimeUpdateBarrier(stateDir, operationId).catch(() => false);
  }
}

main().catch(() => {
  process.exitCode = 1;
});
