import { createHash } from "node:crypto";
import { access, constants, mkdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { AgentGoalStore } from "../state/agent-goals.js";
import { ScheduledGoalController } from "./scheduled-goal-controller.js";
import { ScheduledLunaWorker, type SpawnAdapter, type SpawnedLunaProcess } from "./scheduled-luna-worker.js";
import { DomainError, ErrorCode } from "../types.js";

type PathResolver = (candidate: string) => Promise<string>;
export interface ExecutableResolverDeps {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  realpath?: PathResolver;
  stat?: (candidate: string) => Promise<{ isFile(): boolean; mode?: number }>;
  access?: (candidate: string, mode: number) => Promise<void>;
}

function invalid(message: string): DomainError { return new DomainError(ErrorCode.INVALID_ARGUMENT, message); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isAbsoluteSafe(value: string): boolean { return path.isAbsolute(value) && !value.includes("\0"); }

async function verifyExecutable(candidate: string, deps: Required<Pick<ExecutableResolverDeps, "realpath" | "stat" | "access">>): Promise<string> {
  if (!isAbsoluteSafe(candidate)) throw invalid("Codex executable candidate must be absolute");
  const resolved = await deps.realpath(candidate).catch(() => { throw invalid("Codex executable candidate is unavailable"); });
  const info = await deps.stat(resolved).catch(() => { throw invalid("Codex executable candidate is unavailable"); });
  if (!info.isFile()) throw invalid("Codex executable candidate is not a file");
  await deps.access(resolved, constants.X_OK).catch(() => { throw invalid("Codex executable candidate is not executable"); });
  return resolved;
}

/** Resolve only local installation candidates; callers cannot supply a path. */
export async function resolveScheduledCodexExecutable(deps: ExecutableResolverDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const realpathFn = deps.realpath ?? realpath;
  const statFn = deps.stat ?? stat;
  const accessFn = deps.access ?? access;
  const fsDeps = { realpath: realpathFn, stat: statFn, access: accessFn };
  const override = env.CHATGPT2CODEX_CODEX_PATH;
  if (override !== undefined) {
    if (!isAbsoluteSafe(override)) throw invalid("CHATGPT2CODEX_CODEX_PATH must be absolute");
    return verifyExecutable(override, fsDeps);
  }
  const candidates: string[] = [];
  if ((deps.platform ?? process.platform) === "darwin") candidates.push("/Applications/ChatGPT.app/Contents/Resources/codex");
  for (const entry of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (isAbsoluteSafe(entry)) candidates.push(path.join(entry, (deps.platform ?? process.platform) === "win32" ? "codex.exe" : "codex"));
  }
  for (const candidate of candidates) {
    try { return await verifyExecutable(candidate, fsDeps); } catch { /* try next local candidate */ }
  }
  throw invalid("No safe Codex executable was found");
}

function nodeSpawnAdapter(executablePath: string): SpawnAdapter {
  return (executable, argv, options): SpawnedLunaProcess => {
    // execution-capability: scheduled-goal-codex-worker
    const child = spawn(executable, [...argv], { cwd: options.cwd, env: options.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    // Drain both streams without retaining or persisting their content.
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    let settled = false;
    let resolveExit!: (value: { exitCode: number | null; signal: string | null }) => void;
    const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => { resolveExit = resolve; });
    const settle = (value: { exitCode: number | null; signal: string | null }) => { if (!settled) { settled = true; resolveExit(value); } };
    child.once("error", () => settle({ exitCode: null, signal: null }));
    child.once("exit", (code, signal) => settle({ exitCode: code, signal }));
    return { pid: child.pid, stdin: child.stdin!, exited, kill: (signal) => { child.kill(signal); } };
  };
}

export interface ScheduledGoalRuntime {
  executablePath: string;
  projectRoot: string;
  stateRoot: string;
  projectRootDigest: string;
  goals: AgentGoalStore;
  worker: ScheduledLunaWorker;
  controller: ScheduledGoalController;
}

const runtimeCache = new Map<string, ScheduledGoalRuntime>();

export async function getScheduledGoalRuntime(input: {
  stateDir: string;
  projectRoot: string;
  projectId: string;
  env?: Record<string, string | undefined>;
  executableResolver?: () => Promise<string>;
  spawnAdapterFactory?: (executablePath: string) => SpawnAdapter;
}): Promise<ScheduledGoalRuntime> {
  if (!isAbsoluteSafe(input.stateDir) || !isAbsoluteSafe(input.projectRoot)) throw invalid("Runtime roots must be absolute");
  const canonicalProjectRoot = await realpath(input.projectRoot).catch(() => { throw invalid("Project root is unavailable"); });
  const canonicalStateRoot = await mkdir(input.stateDir, { recursive: true }).then(() => realpath(input.stateDir)).catch(() => { throw invalid("State root is unavailable"); });
  const key = `${canonicalStateRoot}\0${canonicalProjectRoot}\0${input.projectId}`;
  const existing = runtimeCache.get(key); if (existing) return existing;
  const executablePath = await (input.executableResolver ?? (() => resolveScheduledCodexExecutable({ env: input.env })) )();
  const projectRootDigest = digest(canonicalProjectRoot);
  const goals = new AgentGoalStore(canonicalStateRoot);
  const worker = new ScheduledLunaWorker({ executablePath, projectRoot: canonicalProjectRoot, stateRoot: canonicalStateRoot, spawn: (input.spawnAdapterFactory ?? nodeSpawnAdapter)(executablePath), environment: input.env ?? process.env });
  const controller = new ScheduledGoalController({ goals, worker, projectId: input.projectId, projectRootDigest });
  const runtime = { executablePath, projectRoot: canonicalProjectRoot, stateRoot: canonicalStateRoot, projectRootDigest, goals, worker, controller };
  runtimeCache.set(key, runtime);
  return runtime;
}

export function clearScheduledGoalRuntimeCache(): void { runtimeCache.clear(); }
