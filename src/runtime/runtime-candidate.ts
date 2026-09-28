import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateOwnerToken, hasOwnerToken, storeOwnerToken } from "../auth/owner-token.js";
import { hashToken, JsonOAuthStore } from "../auth/oauth-store.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_PROBE_INTERVAL_MS = 100;
const MAX_LOG_TAIL_BYTES = 16 * 1024;
const CANDIDATE_PROBE_TOKEN_TTL_SECONDS = 120;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SCHEMA_REVISION_PATTERN = /^sha256:[a-f0-9]{24}$/u;

export interface RuntimeCandidateExpectation {
  runtimeRoot: string;
  workspaceRoot: string;
  stateDir: string;
  expectedRuntimeFingerprint: string;
  expectedToolSchemaRevision: string;
  expectedCatalogSchemaRevision?: string;
  startupTimeoutMs?: number;
}

export interface RuntimeCandidateHealthEvidence {
  ok: boolean;
  runtimePid: number;
  runtimeFingerprint: string;
  toolSchemaRevision: string;
}

export interface RuntimeCandidateMcpEvidence {
  initializeOk: true;
  toolsListOk: true;
  toolCount: number;
  catalogSchemaRevision: string | null;
  transport: "http";
  endpoint: string;
  candidatePid: number;
}

export interface RuntimeCandidateReadiness {
  ready: true;
  generationId: string;
  pid: number;
  port: number;
  runtimeRoot: string;
  health: RuntimeCandidateHealthEvidence;
  mcp: RuntimeCandidateMcpEvidence;
}

export interface RuntimeCandidateHandle extends RuntimeCandidateReadiness {
  stop(): Promise<void>;
}

interface CandidateProcess {
  pid: number;
  process: ChildProcess;
  stderrTail: () => string;
}

interface CandidateDependencies {
  allocatePort(): Promise<number>;
  launch(input: {
    node: string;
    cli: string;
    runtimeRoot: string;
    workspaceRoot: string;
    stateDir: string;
    generationId: string;
    port: number;
  }): CandidateProcess;
  fetchHealth(port: number): Promise<unknown>;
  probeMcp(input: {
    port: number;
    candidatePid: number;
    accessToken: string;
  }): Promise<RuntimeCandidateMcpEvidence>;
  stop(candidate: CandidateProcess): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedTail(previous: string, chunk: Buffer | string): string {
  return (previous + Buffer.from(chunk).toString("utf8")).slice(-MAX_LOG_TAIL_BYTES);
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isSafeInteger(port) || port < 1) reject(new Error("failed to allocate private candidate port"));
        else resolve(port);
      });
    });
  });
}

async function executableInRuntime(runtimeRoot: string): Promise<string> {
  for (const candidate of [
    path.join(runtimeRoot, "bin", "node"),
    path.join(runtimeRoot, "node", "bin", "node"),
    process.execPath,
  ]) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep checking fixed candidates.
    }
  }
  throw new Error(`candidate runtime does not contain an executable Node.js: ${runtimeRoot}`);
}

function privateCandidateEnv(input: {
  runtimeRoot: string;
  stateDir: string;
  generationId: string;
  port: number;
}): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    CHATGPT2CODEX_STATE_DIR: input.stateDir,
    CHATGPT2CODEX_RUNTIME_ROOT: input.runtimeRoot,
    CHATGPT2CODEX_RUNTIME_GENERATION_ID: input.generationId,
    CHATGPT2CODEX_PORT: String(input.port),
    CHATGPT2CODEX_MULTI_PROJECT_LANES: "1",
    CHATGPT2CODEX_PRIVATE_CANDIDATE: "1",
    CHATGPT2CODEX_E2E_CHILD: "1",
    CHATGPT2CODEX_CONTROL_CHATGPT: "0",
  };
}

function launchCandidate(input: {
  node: string;
  cli: string;
  runtimeRoot: string;
  workspaceRoot: string;
  stateDir: string;
  generationId: string;
  port: number;
}): CandidateProcess {
  // execution-capability: runtime-candidate-http-child
  const child = spawn(input.node, [
    input.cli,
    "serve",
    "--http",
    "--host",
    "127.0.0.1",
    "--port",
    String(input.port),
    "--public-url",
    `http://127.0.0.1:${input.port}`,
    "--workspace",
    input.workspaceRoot,
  ], {
    cwd: input.workspaceRoot,
    env: privateCandidateEnv(input),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = boundedTail(stderr, chunk); });
  if (!child.pid) throw new Error("private candidate process did not expose a pid");
  return { pid: child.pid, process: child, stderrTail: () => stderr };
}

async function fetchCandidateHealth(port: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(1_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`candidate health returned HTTP ${response.status}`);
  return await response.json();
}

async function provisionCandidateProbeAccessToken(stateDir: string, port: number): Promise<string> {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const resource = `http://127.0.0.1:${port}/mcp`;
  const store = new JsonOAuthStore(stateDir);
  try {
    const saved = await store.saveTokenPair({
      accessTokenHash: hashToken(accessToken),
      accessToken: {
        clientId: "runtime-candidate-readiness",
        scopes: ["chatgpt2codex"],
        expiresAt: now + CANDIDATE_PROBE_TOKEN_TTL_SECONDS,
        resource,
      },
      refreshTokenHash: hashToken(refreshToken),
      refreshToken: {
        clientId: "runtime-candidate-readiness",
        scopes: ["chatgpt2codex"],
        expiresAt: now + CANDIDATE_PROBE_TOKEN_TTL_SECONDS,
        resource,
      },
    });
    if (!saved) throw new Error("failed to provision candidate readiness credential");
    return accessToken;
  } finally {
    store.close();
  }
}

async function probeCandidateMcp(input: {
  port: number;
  candidatePid: number;
  accessToken: string;
}): Promise<RuntimeCandidateMcpEvidence> {
  const endpoint = `http://127.0.0.1:${input.port}/mcp`;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(5_000),
    },
  });
  const client = new Client({ name: "chatgpt2codex-runtime-candidate-readiness", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const record = listed as unknown as Record<string, unknown>;
    const tools = Array.isArray(record.tools) ? record.tools : [];
    if (tools.length === 0) throw new Error("candidate tools/list returned no tools");
    const catalogSchemaRevision = typeof record.schemaRevision === "string" ? record.schemaRevision : null;
    return {
      initializeOk: true,
      toolsListOk: true,
      toolCount: tools.length,
      catalogSchemaRevision,
      transport: "http",
      endpoint,
      candidatePid: input.candidatePid,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function stopCandidate(candidate: CandidateProcess): Promise<void> {
  if (candidate.process.exitCode !== null || candidate.process.signalCode !== null) return;
  candidate.process.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => candidate.process.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (exited) return;
  candidate.process.kill("SIGKILL");
  await new Promise<void>((resolve) => candidate.process.once("exit", () => resolve()));
}

const defaultDependencies: CandidateDependencies = {
  allocatePort: allocateLoopbackPort,
  launch: launchCandidate,
  fetchHealth: fetchCandidateHealth,
  probeMcp: probeCandidateMcp,
  stop: stopCandidate,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export function evaluateRuntimeCandidateHealth(
  payload: unknown,
  expectedRuntimeFingerprint: string,
  expectedToolSchemaRevision: string,
): RuntimeCandidateHealthEvidence {
  const health = asRecord(payload);
  const manifest = asRecord(health?.runtimeManifest);
  const runtimePid = health?.runtimePid;
  const runtimeFingerprint = manifest?.runtimeFingerprint;
  const toolSchemaRevision = manifest?.toolSchemaRevision;
  if (health?.ok !== true) throw new Error("candidate health is not ready");
  if (!Number.isSafeInteger(runtimePid) || Number(runtimePid) <= 0) throw new Error("candidate health did not expose runtimePid");
  if (runtimeFingerprint !== expectedRuntimeFingerprint) {
    throw new Error("candidate runtime fingerprint does not match the prepared generation");
  }
  if (toolSchemaRevision !== expectedToolSchemaRevision) {
    throw new Error("candidate tool-schema revision does not match the prepared generation");
  }
  return {
    ok: true,
    runtimePid: Number(runtimePid),
    runtimeFingerprint: String(runtimeFingerprint),
    toolSchemaRevision: String(toolSchemaRevision),
  };
}

export async function startPrivateRuntimeCandidate(
  expectation: RuntimeCandidateExpectation,
  dependencies: Partial<CandidateDependencies> = {},
): Promise<RuntimeCandidateHandle> {
  const runtimeRoot = path.resolve(expectation.runtimeRoot);
  const workspaceRoot = path.resolve(expectation.workspaceRoot);
  const stateDir = path.resolve(expectation.stateDir);
  if (!SHA256_PATTERN.test(expectation.expectedRuntimeFingerprint)) {
    throw new Error("candidate expected runtime fingerprint is invalid");
  }
  if (!SCHEMA_REVISION_PATTERN.test(expectation.expectedToolSchemaRevision)) {
    throw new Error("candidate expected tool-schema revision is invalid");
  }
  if (
    expectation.expectedCatalogSchemaRevision !== undefined
    && !SCHEMA_REVISION_PATTERN.test(expectation.expectedCatalogSchemaRevision)
  ) {
    throw new Error("candidate expected catalog schema revision is invalid");
  }
  const cli = path.join(runtimeRoot, "dist", "cli.js");
  await fs.access(cli, fsConstants.R_OK);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (!(await hasOwnerToken(stateDir))) {
    await storeOwnerToken(stateDir, generateOwnerToken());
  }
  const node = await executableInRuntime(runtimeRoot);
  const deps: CandidateDependencies = { ...defaultDependencies, ...dependencies };
  const generationId = `candidate-${randomUUID()}`;
  const port = await deps.allocatePort();
  const accessToken = await provisionCandidateProbeAccessToken(stateDir, port);
  const candidate = deps.launch({ node, cli, runtimeRoot, workspaceRoot, stateDir, generationId, port });
  const timeoutMs = Math.max(1_000, expectation.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
  const deadline = deps.now() + timeoutMs;
  let healthEvidence: RuntimeCandidateHealthEvidence | undefined;
  try {
    while (deps.now() < deadline) {
      if (candidate.process.exitCode !== null || candidate.process.signalCode !== null) {
        throw new Error(`private candidate exited before readiness: ${candidate.stderrTail()}`);
      }
      try {
        healthEvidence = evaluateRuntimeCandidateHealth(
          await deps.fetchHealth(port),
          expectation.expectedRuntimeFingerprint,
          expectation.expectedToolSchemaRevision,
        );
        break;
      } catch (error) {
        if (deps.now() + DEFAULT_PROBE_INTERVAL_MS >= deadline) throw error;
        await deps.sleep(DEFAULT_PROBE_INTERVAL_MS);
      }
    }
    if (!healthEvidence) throw new Error("private candidate health readiness timed out");
    if (healthEvidence.runtimePid !== candidate.pid) {
      throw new Error("private candidate health pid does not match the launched process");
    }
    const mcp = await deps.probeMcp({ port, candidatePid: candidate.pid, accessToken });
    if (!mcp.initializeOk || !mcp.toolsListOk || mcp.toolCount < 1) {
      throw new Error("private candidate MCP readiness failed");
    }
    if (
      mcp.transport !== "http"
      || mcp.endpoint !== `http://127.0.0.1:${port}/mcp`
      || mcp.candidatePid !== candidate.pid
    ) {
      throw new Error("private candidate MCP evidence does not match the launched HTTP upstream");
    }
    if (!mcp.catalogSchemaRevision || !SCHEMA_REVISION_PATTERN.test(mcp.catalogSchemaRevision)) {
      throw new Error("private candidate tools/list did not expose a valid schema revision");
    }
    if (
      expectation.expectedCatalogSchemaRevision !== undefined
      && mcp.catalogSchemaRevision !== expectation.expectedCatalogSchemaRevision
    ) {
      throw new Error("private candidate tools/list schema revision does not match the prepared generation");
    }
    const postMcpHealth = evaluateRuntimeCandidateHealth(
      await deps.fetchHealth(port),
      expectation.expectedRuntimeFingerprint,
      expectation.expectedToolSchemaRevision,
    );
    if (postMcpHealth.runtimePid !== candidate.pid) {
      throw new Error("private candidate health pid changed during HTTP MCP readiness");
    }
    return {
      ready: true,
      generationId,
      pid: candidate.pid,
      port,
      runtimeRoot,
      health: postMcpHealth,
      mcp,
      stop: () => deps.stop(candidate),
    };
  } catch (error) {
    await deps.stop(candidate).catch(() => undefined);
    throw error;
  }
}
