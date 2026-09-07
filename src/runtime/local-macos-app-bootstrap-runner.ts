import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type LocalMacosAppBootstrapPhase = "begin" | "resume";

export interface LocalMacosAppBootstrapOutcome {
  phase: LocalMacosAppBootstrapPhase;
  requestId: string;
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

export interface LocalMacosAppBootstrapDependencies {
  openClient?: (input: {
    projectRoot: string;
    stateDir: string;
    port: number;
  }) => Promise<BootstrapToolClient>;
  platform?: NodeJS.Platform;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

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
    const message = typeof structured.error === "string" ? structured.error : `${tool} failed`;
    throw new Error(`${code}: ${message}`);
  }
  return structured;
}

async function activeRuntimeRoot(stateDir: string): Promise<string> {
  const releaseRoot = await fs.realpath(path.join(stateDir, "local-runtime-releases"));
  const rawPointer = (await fs.readFile(path.join(stateDir, "active-runtime"), "utf8")).trim();
  if (!rawPointer) throw new Error("macos-app-bootstrap-local active-runtime pointer is empty");
  const runtimeRoot = await fs.realpath(rawPointer);
  if (runtimeRoot !== releaseRoot && !runtimeRoot.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error("macos-app-bootstrap-local active runtime is outside the managed release root");
  }
  return runtimeRoot;
}

async function executableInRuntime(root: string): Promise<string> {
  for (const candidate of [path.join(root, "bin", "node"), path.join(root, "node", "bin", "node")]) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep checking the fixed bundled-node locations only.
    }
  }
  throw new Error(`Managed runtime does not contain an executable bundled Node.js: ${root}`);
}

async function defaultOpenClient(input: {
  projectRoot: string;
  stateDir: string;
  port: number;
}): Promise<BootstrapToolClient> {
  const projectRoot = await fs.realpath(input.projectRoot);
  const runtimeRoot = await activeRuntimeRoot(input.stateDir);
  const node = await executableInRuntime(runtimeRoot);
  const cli = path.join(runtimeRoot, "dist", "cli.js");
  await fs.access(cli, fsConstants.R_OK);
  const env = {
    ...getDefaultEnvironment(),
    CHATGPT2CODEX_STATE_DIR: input.stateDir,
    CHATGPT2CODEX_RUNTIME_ROOT: runtimeRoot,
    CHATGPT2CODEX_PORT: String(input.port),
    CHATGPT2CODEX_MULTI_PROJECT_LANES: "1",
  };
  // execution-capability: local-macos-app-bootstrap-stdio
  const transport = new StdioClientTransport({
    command: node,
    args: [cli, "serve", "--stdio", "--workspace", projectRoot],
    cwd: projectRoot,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "chatgpt2codex-macos-app-bootstrap", version: "1.0.0" });
  await client.connect(transport);
  return {
    callTool: (request) => client.callTool(request),
    close: () => client.close(),
  };
}

export async function runLocalMacosAppBootstrap(input: {
  projectId: string;
  projectRoot: string;
  stateDir: string;
  requestId: string;
  phase: LocalMacosAppBootstrapPhase;
  port: number;
}, dependencies: LocalMacosAppBootstrapDependencies = {}): Promise<LocalMacosAppBootstrapOutcome> {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("macos-app-bootstrap-local is supported only on macOS");
  }
  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new Error("macos-app-bootstrap-local requires a valid --request-id");
  }
  if (!input.projectId.trim()) {
    throw new Error("macos-app-bootstrap-local requires --project-id");
  }
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("macos-app-bootstrap-local requires a valid --port");
  }

  const openClient = dependencies.openClient ?? defaultOpenClient;
  const client = await openClient({ projectRoot: input.projectRoot, stateDir: input.stateDir, port: input.port });
  try {
    if (input.phase === "begin") {
      const selected = toolPayload(await client.callTool({
        name: "project_select",
        arguments: {
          projectId: input.projectId,
          reason: "maintenance",
          preset: "full-write",
        },
      }), "project_select");
      const lease = asRecord(selected.lease);
      if (!lease || lease.projectId !== input.projectId || lease.preset !== "full-write") {
        throw new Error("project_select did not establish the expected local full-write lease");
      }
    }

    const result = toolPayload(await client.callTool({
      name: "macos_app_apply_local",
      arguments: {
        projectId: input.projectId,
        requestId: input.requestId,
      },
    }), "macos_app_apply_local");
    const state = typeof result.state === "string" ? result.state : "UNKNOWN";
    const operationId = typeof result.operationId === "string" ? result.operationId : null;
    const approvalRequestId = typeof result.approvalRequestId === "string" ? result.approvalRequestId : null;
    const actionStarted = result.actionStarted === true;
    const subprocessStarted = result.subprocessStarted === true || typeof result.workerPid === "number";
    const recommendedAction = typeof result.recommendedAction === "string" ? result.recommendedAction : null;

    if (input.phase === "begin") {
      if (state !== "APPROVAL_REQUIRED" || !approvalRequestId || actionStarted || subprocessStarted) {
        throw new Error(`macos-app-bootstrap-local begin expected a local approval request, got ${state}`);
      }
    } else if (state === "APPROVAL_REQUIRED") {
      if (actionStarted || subprocessStarted) {
        throw new Error("macos-app-bootstrap-local resume reported approval pending after execution started");
      }
    } else if (state !== "ACTIVATION_REQUESTED" && state !== "ALREADY_APPLIED" && state !== "APPLIED") {
      throw new Error(`macos-app-bootstrap-local resume did not start or complete the approved apply: ${state}`);
    }

    return {
      phase: input.phase,
      requestId: input.requestId,
      projectId: input.projectId,
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
