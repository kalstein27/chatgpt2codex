import path from "node:path";
import {
  activateRuntimeGenerationCandidate,
  clearRuntimeGenerationCandidate,
  initializeRuntimeGenerationRoutingState,
  readRuntimeGenerationRoutingState,
  stageRuntimeGenerationCandidate,
  type RuntimeGenerationEndpoint,
} from "./runtime-generation-router.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function endpointFromFlags(): RuntimeGenerationEndpoint {
  const generationId = flag("--generation-id");
  const rawRuntimeRoot = flag("--runtime-root");
  const rawPid = flag("--pid");
  const rawPort = flag("--port");
  if (!generationId || !rawRuntimeRoot || !rawPid || !rawPort) {
    throw new Error("runtime-router-control endpoint commands require --generation-id --runtime-root --pid --port");
  }
  const pid = Number(rawPid);
  const port = Number(rawPort);
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("runtime-router-control endpoint pid/port is invalid");
  }
  return { generationId, runtimeRoot: path.resolve(rawRuntimeRoot), pid, port };
}

const command = process.argv[2] ?? "";
const stateDir = flag("--state-dir");
if (!stateDir) throw new Error("runtime-router-control requires --state-dir <path>");

let result;
switch (command) {
  case "init":
    result = await initializeRuntimeGenerationRoutingState(stateDir, endpointFromFlags());
    break;
  case "stage":
    result = await stageRuntimeGenerationCandidate(stateDir, endpointFromFlags());
    break;
  case "activate": {
    const generationId = flag("--generation-id") ?? "";
    result = await activateRuntimeGenerationCandidate(stateDir, generationId);
    break;
  }
  case "clear-candidate": {
    const generationId = flag("--generation-id") ?? "";
    result = await clearRuntimeGenerationCandidate(stateDir, generationId);
    break;
  }
  case "status":
    result = await readRuntimeGenerationRoutingState(stateDir);
    break;
  default:
    throw new Error("runtime-router-control requires init|stage|activate|clear-candidate|status");
}

process.stdout.write(`${JSON.stringify(result)}\n`);
