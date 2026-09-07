import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { LocalRuntimeBootstrapPlan } from "./local-runtime-bootstrap.js";

export type LocalRuntimeBootstrapPhase = "begin" | "resume";

export interface LocalRuntimeBootstrapOutcome {
  phase: LocalRuntimeBootstrapPhase;
  prepareRequestId: string;
  applyRequestId: string;
  projectId: string;
  state: string;
  operationId: string | null;
  approvalRequestId: string | null;
  actionStarted: boolean;
  subprocessStarted: boolean;
  recommendedAction: string | null;
}

interface BootstrapToolClient {
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export interface LocalRuntimeBootstrapRunnerDependencies {
  openClient?: (input: {
    plan: LocalRuntimeBootstrapPlan;
    stateDir: string;
    port: number;
  }) => Promise<BootstrapToolClient>;
  platform?: NodeJS.Platform;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolPayload(result: unknown, tool: string): Record<string, unknown> {
  const record = asRecord(result);
  if (!record) throw new Error(`${tool} returned a non-object result`);
  const structured = asRecord(record.structuredContent) ?? record;
  if (record.isError === true) {
    const code = typeof structured.code === "string" ? structured.code : "TOOL_ERROR";
    const message = typeof structured.error === "string"
      ? structured.error
      : `${tool} failed`;
    throw new Error(`${code}: ${message}`);
  }
  return structured;
}

async function executableInCurrentRuntime(root: string): Promise<string> {
  for (const candidate of [path.join(root, "bin", "node"), path.join(root, "node", "bin", "node")]) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep checking the fixed bundled-node locations only.
    }
  }
  throw new Error(`Current managed runtime does not contain an executable bundled Node.js: ${root}`);
}

async function defaultOpenClient(input: {
  plan: LocalRuntimeBootstrapPlan;
  stateDir: string;
  port: number;
}): Promise<BootstrapToolClient> {
  const node = await executableInCurrentRuntime(input.plan.currentRuntimeRoot);
  const cli = path.join(input.plan.currentRuntimeRoot, "dist", "cli.js");
  await fs.access(cli, fsConstants.R_OK);
  const env = {
    ...getDefaultEnvironment(),
    CHATGPT2CODEX_STATE_DIR: input.stateDir,
    CHATGPT2CODEX_RUNTIME_ROOT: input.plan.currentRuntimeRoot,
    CHATGPT2CODEX_PORT: String(input.port),
    CHATGPT2CODEX_MULTI_PROJECT_LANES: "1",
  };
  // execution-capability: local-runtime-bootstrap-stdio
  const transport = new StdioClientTransport({
    command: node,
    args: [cli, "serve", "--stdio", "--workspace", input.plan.projectRoot],
    cwd: input.plan.projectRoot,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "chatgpt2codex-runtime-bootstrap", version: "1.0.0" });
  await client.connect(transport);
  return {
    callTool: (request) => client.callTool(request),
    close: () => client.close(),
  };
}

function runtimeApplyArguments(plan: LocalRuntimeBootstrapPlan): Record<string, unknown> {
  return {
    projectId: plan.projectId,
    expectedCurrentFingerprint: plan.expectedCurrentFingerprint,
    targetRuntimeRoot: plan.targetRuntimeRoot,
    targetFingerprint: plan.targetFingerprint,
    requestId: plan.applyRequestId,
    preserveConnector: true,
  };
}

export async function runLocalRuntimeBootstrap(input: {
  plan: LocalRuntimeBootstrapPlan;
  stateDir: string;
  phase: LocalRuntimeBootstrapPhase;
  port: number;
}, dependencies: LocalRuntimeBootstrapRunnerDependencies = {}): Promise<LocalRuntimeBootstrapOutcome> {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("runtime-bootstrap-local is supported only on macOS");
  }
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("runtime-bootstrap-local requires a valid --port");
  }
  const openClient = dependencies.openClient ?? defaultOpenClient;
  const client = await openClient({ plan: input.plan, stateDir: input.stateDir, port: input.port });
  try {
    if (input.phase === "begin") {
      const selected = toolPayload(await client.callTool({
        name: "project_select",
        arguments: {
          projectId: input.plan.projectId,
          reason: "maintenance",
          preset: "full-write",
          confirmSwitch: true,
        },
      }), "project_select");
      const lease = asRecord(selected.lease);
      if (!lease || lease.projectId !== input.plan.projectId || lease.preset !== "full-write") {
        throw new Error("project_select did not establish the expected local full-write lease");
      }
    }

    const result = toolPayload(await client.callTool({
      name: "runtime_apply_local",
      arguments: runtimeApplyArguments(input.plan),
    }), "runtime_apply_local");
    const state = typeof result.state === "string" ? result.state : "UNKNOWN";
    const operationId = typeof result.operationId === "string" ? result.operationId : null;
    const approvalRequestId = typeof result.approvalRequestId === "string" ? result.approvalRequestId : null;
    const actionStarted = result.actionStarted === true;
    const subprocessStarted = result.subprocessStarted === true || typeof result.workerPid === "number";
    const recommendedAction = typeof result.recommendedAction === "string" ? result.recommendedAction : null;

    if (input.phase === "begin") {
      if (state !== "APPROVAL_REQUIRED" || !approvalRequestId || actionStarted || subprocessStarted) {
        throw new Error(`runtime-bootstrap-local begin expected a local approval request, got ${state}`);
      }
    } else if (state === "APPROVAL_REQUIRED") {
      if (actionStarted || subprocessStarted) {
        throw new Error("runtime-bootstrap-local resume reported approval pending after execution started");
      }
    } else if (state !== "ACTIVATION_REQUESTED" && state !== "ALREADY_APPLIED" && state !== "APPLIED") {
      throw new Error(`runtime-bootstrap-local resume did not start or complete the approved apply: ${state}`);
    }

    return {
      phase: input.phase,
      prepareRequestId: input.plan.prepareRequestId,
      applyRequestId: input.plan.applyRequestId,
      projectId: input.plan.projectId,
      state,
      operationId,
      approvalRequestId,
      actionStarted,
      subprocessStarted,
      recommendedAction,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
