import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DomainError, ErrorCode } from "../types.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { redact } from "../policy/secrets.js";

// execution-capability: managed-mcp-installer-subprocess
const execFileAsync = promisify(execFile);
const STATE_SCHEMA_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_SERVERS = 64;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_PROXY_JSON_BYTES = 1024 * 1024;
const MAX_PRESERVED_FILES = 10_000;
const MAX_PRESERVED_BYTES = 1024 * 1024 * 1024;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const REPOSITORY_PART_RE = /^[A-Za-z0-9_.-]{1,100}$/u;
const REF_RE = /^[A-Za-z0-9._/@+-]{1,200}$/u;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SHELL_COMMANDS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);
const GENERATED_REPO_DIRS = new Set([
  ".git", ".cache", ".next", ".parcel-cache", ".pytest_cache", ".ruff_cache", ".mypy_cache",
  "__pycache__", "build", "coverage", "dist", "node_modules", "target", "venv", ".venv",
]);
const GENERATED_REPO_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);

export interface ManagedMcpLaunchSpec {
  command: string;
  args: string[];
  cwdRelative: string;
  inheritEnvKeys: string[];
}

export interface ManagedMcpServiceHealthSpec {
  url: string;
  timeoutMs: number;
}

export interface ManagedMcpServiceSpec {
  launch: ManagedMcpLaunchSpec;
  health: ManagedMcpServiceHealthSpec;
}

export interface ManagedMcpRecord {
  id: string;
  name: string;
  repositoryUrl: string;
  ref: string | null;
  commit: string;
  installRoot: string;
  repoRoot: string;
  launch: ManagedMcpLaunchSpec;
  service?: ManagedMcpServiceSpec;
  runBuild?: boolean;
  installedAt: number;
  updatedAt: number;
  desiredRunning?: boolean;
  desiredServiceRunning?: boolean;
}

interface ManagedMcpState {
  schemaVersion: 1;
  updatedAt: number;
  servers: ManagedMcpRecord[];
}

export interface ManagedMcpInstallInput {
  stateDir: string;
  repositoryUrl: string;
  ref?: string;
  launch?: {
    command: string;
    args?: string[];
    cwdRelative?: string;
    inheritEnvKeys?: string[];
  };
  service?: {
    launch: {
      command: string;
      args?: string[];
      cwdRelative?: string;
      inheritEnvKeys?: string[];
    };
    health: {
      url: string;
      timeoutMs?: number;
    };
  };
  runBuild?: boolean;
}

interface ActiveManagedMcp {
  record: ManagedMcpRecord;
  client: Client;
  transport: StdioClientTransport;
  startedAt: number;
  stderr: string;
  expectedStop: boolean;
}

interface ActiveManagedMcpService {
  record: ManagedMcpRecord;
  child: ChildProcess;
  startedAt: number;
  stdout: string;
  stderr: string;
  expectedStop: boolean;
}

export interface ManagedMcpServiceExitDiagnostic {
  exitedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export type ManagedMcpServiceLifecycleReason =
  | "intentional-stop"
  | "unexpected-exit"
  | "generation-reconcile"
  | "reconcile-failed"
  | "spawn-failed"
  | "health-failed";

export interface ManagedMcpServiceHealthSnapshot {
  ok: boolean;
  status: number | null;
  checkedAt: number;
}

export interface ManagedMcpServiceLifecycleEvidence {
  reason: ManagedMcpServiceLifecycleReason;
  timestamp: number;
  previousPid: number | null;
  desiredRunning: boolean | null;
  desiredServiceRunning: boolean | null;
  lastKnownHealth: Omit<ManagedMcpServiceHealthSnapshot, "checkedAt"> | null;
}

export interface ManagedMcpExitDiagnostic {
  closedAt: number;
  stderr: string;
}

export type ManagedMcpRuntimeState = "stopped" | "starting" | "running" | "degraded" | "updating";

export interface ManagedMcpRuntimeSnapshot extends ManagedMcpRecord {
  status: ManagedMcpRuntimeState;
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  mcpLastExit: ManagedMcpExitDiagnostic | null;
  serviceConfigured: boolean;
  serviceRunning: boolean;
  servicePid: number | null;
  serviceStartedAt: number | null;
  serviceHealthUrl: string | null;
  serviceHealth: ManagedMcpServiceHealthSnapshot | null;
  serviceLastExit: ManagedMcpServiceExitDiagnostic | null;
  serviceLifecycle: ManagedMcpServiceLifecycleEvidence | null;
}

export interface ManagedMcpLogsSnapshot {
  serverId: string;
  status: ManagedMcpRuntimeState;
  maxBytes: number;
  mcp: {
    running: boolean;
    stderr: string;
    lastExit: ManagedMcpExitDiagnostic | null;
  };
  service: {
    configured: boolean;
    running: boolean;
    stdout: string;
    stderr: string;
    lastExit: ManagedMcpServiceExitDiagnostic | null;
    lifecycle: ManagedMcpServiceLifecycleEvidence[];
  };
}

const stateLocks = new Map<string, Promise<void>>();
const activeServers = new Map<string, ActiveManagedMcp>();
const activeServices = new Map<string, ActiveManagedMcpService>();
const mcpExitDiagnostics = new Map<string, ManagedMcpExitDiagnostic>();
const serviceExitDiagnostics = new Map<string, ManagedMcpServiceExitDiagnostic>();
const serviceLifecycleDiagnostics = new Map<string, ManagedMcpServiceLifecycleEvidence[]>();
const startPromises = new Map<string, Promise<ActiveManagedMcp>>();
const updatingServers = new Set<string>();
const MAX_LIFECYCLE_EVIDENCE = 8;

function managedRoot(stateDir: string): string {
  return path.join(stateDir, "managed-mcp");
}

function registryPath(stateDir: string): string {
  return path.join(managedRoot(stateDir), "registry.json");
}

function activeKey(stateDir: string, id: string): string {
  return `${path.resolve(stateDir)}\0${id}`;
}

function appendServiceLifecycleEvidence(
  stateDir: string,
  record: ManagedMcpRecord,
  reason: ManagedMcpServiceLifecycleReason,
  previousPid: number | null,
  lastKnownHealth: Omit<ManagedMcpServiceHealthSnapshot, "checkedAt"> | null = null,
): ManagedMcpServiceLifecycleEvidence {
  const key = activeKey(stateDir, record.id);
  const evidence: ManagedMcpServiceLifecycleEvidence = {
    reason,
    timestamp: Date.now(),
    previousPid,
    desiredRunning: record.desiredRunning ?? null,
    desiredServiceRunning: record.desiredServiceRunning ?? null,
    lastKnownHealth,
  };
  const history = [...(serviceLifecycleDiagnostics.get(key) ?? []), evidence].slice(-MAX_LIFECYCLE_EVIDENCE);
  serviceLifecycleDiagnostics.set(key, history);
  return evidence;
}

export function managedMcpLifecycleRestoreTargets(input: {
  desiredRunning?: boolean;
  desiredServiceRunning?: boolean;
  serviceConfigured: boolean;
  mcpWasRunning: boolean;
  serviceWasRunning: boolean;
}): { mcp: boolean; service: boolean } {
  return {
    mcp: input.desiredRunning ?? input.mcpWasRunning,
    service: input.serviceConfigured && (input.desiredServiceRunning ?? input.serviceWasRunning),
  };
}

function stableServerId(owner: string, repo: string): string {
  const slug = `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").slice(0, 56);
  const digest = createHash("sha256").update(`${owner}/${repo}`).digest("hex").slice(0, 10);
  return `${slug}-${digest}`;
}

export function normalizeGitHubRepositoryUrl(value: string): {
  canonicalUrl: string;
  owner: string;
  repo: string;
  id: string;
} {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP repositoryUrl must be a valid HTTPS GitHub URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP repositoryUrl must use https://github.com/<owner>/<repo>");
  }
  if (url.search || url.hash) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP repositoryUrl must not include query parameters or fragments");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP repositoryUrl must identify exactly one GitHub repository");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/iu, "");
  if (!REPOSITORY_PART_RE.test(owner) || !REPOSITORY_PART_RE.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP repository owner/name contains unsupported characters");
  }
  return {
    canonicalUrl: `https://github.com/${owner}/${repo}`,
    owner,
    repo,
    id: stableServerId(owner, repo),
  };
}

function normalizeRef(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const ref = value.trim();
  if (!REF_RE.test(ref) || ref.includes("..")) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP ref contains unsupported characters");
  }
  return ref;
}

function normalizeArgs(args: string[] | undefined): string[] {
  if (!args) return [];
  if (args.length > 64) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP launch args are limited to 64 entries");
  return args.map((arg, index) => {
    if (typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 4096) {
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP launch arg is invalid", { index });
    }
    return arg;
  });
}

function normalizeInheritEnvKeys(keys: string[] | undefined): string[] {
  if (!keys) return [];
  if (keys.length > 32) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP inheritEnvKeys is limited to 32 entries");
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean))).map((key) => {
    if (!ENV_KEY_RE.test(key)) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP inheritEnvKeys contains an invalid environment variable name", { key });
    return key;
  });
}

function normalizeCwdRelative(value: string | undefined): string {
  const raw = value?.trim() || ".";
  if (raw.includes("\0") || path.isAbsolute(raw)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP cwdRelative must be relative to the repository root");
  }
  const normalized = path.normalize(raw);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP cwdRelative cannot leave the repository root");
  }
  return normalized;
}

export function normalizeManagedMcpLaunch(input: ManagedMcpInstallInput["launch"]): ManagedMcpLaunchSpec | null {
  if (!input) return null;
  const command = input.command.normalize("NFKC").trim();
  if (!command || command.includes("\0")) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP launch command is required");
  const base = path.basename(command).toLowerCase();
  if (SHELL_COMMANDS.has(base)) {
    throw new DomainError(ErrorCode.ARBITRARY_SHELL_DENIED, "managed MCP launch rejects shell wrapper commands");
  }
  const args = normalizeArgs(input.args);
  if (args.some((arg) => arg === "-c" || arg === "/c" || arg === "-Command")) {
    throw new DomainError(ErrorCode.ARBITRARY_SHELL_DENIED, "managed MCP launch rejects inline shell/code dispatch arguments");
  }
  return {
    command,
    args,
    cwdRelative: normalizeCwdRelative(input.cwdRelative),
    inheritEnvKeys: normalizeInheritEnvKeys(input.inheritEnvKeys),
  };
}

export function normalizeManagedMcpService(input: ManagedMcpInstallInput["service"]): ManagedMcpServiceSpec | undefined {
  if (!input) return undefined;
  const launch = normalizeManagedMcpLaunch(input.launch);
  if (!launch) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP service launch is required");
  let url: URL;
  try {
    url = new URL(input.health.url);
  } catch {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP service health.url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP service health.url must use http or https");
  }
  if (url.username || url.password) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP service health.url must not contain credentials");
  }
  const timeoutMs = input.health.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120_000) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP service health.timeoutMs must be between 250 and 120000");
  }
  return { launch, health: { url: url.toString(), timeoutMs } };
}

interface PackageJsonLike {
  name?: unknown;
  bin?: unknown;
  scripts?: unknown;
  chatgpt2codex?: unknown;
}

interface PreparedManagedMcpRepository {
  commit: string;
  packageJson: PackageJsonLike | null;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function detectManagedMcpService(packageJson: PackageJsonLike): ManagedMcpServiceSpec | undefined {
  const root = packageJson.chatgpt2codex;
  if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
  const service = (root as Record<string, unknown>).managedService;
  if (!service || typeof service !== "object" || Array.isArray(service)) return undefined;
  const value = service as Record<string, unknown>;
  const launch = value.launch;
  const health = value.health;
  if (!launch || typeof launch !== "object" || Array.isArray(launch) || !health || typeof health !== "object" || Array.isArray(health)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP managedService declaration requires launch and health objects");
  }
  const l = launch as Record<string, unknown>;
  const h = health as Record<string, unknown>;
  return normalizeManagedMcpService({
    launch: {
      command: typeof l.command === "string" ? l.command : "",
      args: Array.isArray(l.args) && l.args.every((item) => typeof item === "string") ? l.args as string[] : undefined,
      cwdRelative: typeof l.cwdRelative === "string" ? l.cwdRelative : undefined,
      inheritEnvKeys: Array.isArray(l.inheritEnvKeys) && l.inheritEnvKeys.every((item) => typeof item === "string") ? l.inheritEnvKeys as string[] : undefined,
    },
    health: {
      url: typeof h.url === "string" ? h.url : "",
      timeoutMs: typeof h.timeoutMs === "number" ? h.timeoutMs : undefined,
    },
  });
}

export function detectNodeManagedMcpLaunch(packageJson: PackageJsonLike): ManagedMcpLaunchSpec | null {
  const bin = packageJson.bin;
  let binTarget: string | undefined;
  if (typeof bin === "string" && bin.trim()) {
    binTarget = bin.trim();
  } else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    const entries = Object.entries(bin as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
    const preferred = entries.find(([name]) => /mcp/iu.test(name)) ?? (entries.length === 1 ? entries[0] : undefined);
    binTarget = preferred?.[1].trim();
  }
  if (binTarget && !path.isAbsolute(binTarget) && !binTarget.includes("\0")) {
    const normalized = path.normalize(binTarget);
    if (normalized !== ".." && !normalized.startsWith(`..${path.sep}`)) {
      return { command: process.execPath, args: [normalized], cwdRelative: ".", inheritEnvKeys: [] };
    }
  }

  const scripts = packageJson.scripts && typeof packageJson.scripts === "object" && !Array.isArray(packageJson.scripts)
    ? packageJson.scripts as Record<string, unknown>
    : {};
  for (const name of ["mcp", "start:mcp", "start"]) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      return { command: npmCommand(), args: name === "start" ? ["start", "--silent"] : ["run", "--silent", name], cwdRelative: ".", inheritEnvKeys: [] };
    }
  }
  return null;
}

async function withStateLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(stateDir);
  const previous = stateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  stateLocks.set(key, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (stateLocks.get(key) === queued) stateLocks.delete(key);
  }
}

function normalizeState(value: unknown): ManagedMcpState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { schemaVersion: 1, updatedAt: Date.now(), servers: [] };
  const record = value as Partial<ManagedMcpState>;
  if (record.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(record.servers)) {
    return { schemaVersion: 1, updatedAt: Date.now(), servers: [] };
  }
  const servers = record.servers.filter((item): item is ManagedMcpRecord => {
    if (!item || typeof item !== "object") return false;
    const server = item as Partial<ManagedMcpRecord>;
    return typeof server.id === "string" && typeof server.name === "string" && typeof server.repositoryUrl === "string" &&
      (server.ref === null || typeof server.ref === "string") && typeof server.commit === "string" &&
      typeof server.installRoot === "string" && typeof server.repoRoot === "string" &&
      !!server.launch && typeof server.launch.command === "string" && Array.isArray(server.launch.args) &&
      typeof server.launch.cwdRelative === "string" && Array.isArray(server.launch.inheritEnvKeys) &&
      typeof server.installedAt === "number" && typeof server.updatedAt === "number";
  });
  return { schemaVersion: 1, updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(), servers: servers.slice(0, MAX_SERVERS) };
}

async function readState(stateDir: string): Promise<ManagedMcpState> {
  try {
    return normalizeState(JSON.parse(await readFile(registryPath(stateDir), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, updatedAt: Date.now(), servers: [] };
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "managed MCP registry could not be read");
  }
}

async function writeState(stateDir: string, state: ManagedMcpState): Promise<void> {
  const root = managedRoot(stateDir);
  await mkdir(root, { recursive: true, mode: DIR_MODE });
  const destination = registryPath(stateDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
  try {
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function setDesiredState(stateDir: string, id: string, mcp: boolean, service: boolean): Promise<void> {
  await withStateLock(stateDir, async () => {
    const state = await readState(stateDir);
    const record = state.servers.find((server) => server.id === id);
    if (!record) throw new DomainError(ErrorCode.FILE_NOT_FOUND, "managed MCP server is not installed", { serverId: id });
    record.desiredRunning = mcp;
    record.desiredServiceRunning = !!record.service && service;
    state.updatedAt = Date.now();
    await writeState(stateDir, state);
  });
}

async function runFile(file: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? DEFAULT_INSTALL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: buildSafeChildEnv(),
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `managed MCP subprocess failed: ${path.basename(file)}`, {
      command: path.basename(file),
      exitCode: typeof code === "number" ? code : null,
    });
  }
}

async function readPackageJson(repoRoot: string): Promise<PackageJsonLike | null> {
  try {
    const value = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as PackageJsonLike : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP package.json is not valid JSON");
  }
}

async function prepareManagedMcpRepository(
  repositoryUrl: string,
  ref: string | null,
  repoRoot: string,
  runBuild: boolean,
): Promise<PreparedManagedMcpRepository> {
  const cloneArgs = ["-c", "protocol.file.allow=never", "clone", "--depth", "1", "--no-tags", "--filter=blob:none", "--single-branch"];
  if (ref) cloneArgs.push("--branch", ref);
  cloneArgs.push(repositoryUrl, repoRoot);
  await runFile("git", cloneArgs, { timeout: DEFAULT_INSTALL_TIMEOUT_MS });
  const commit = (await runFile("git", ["-C", repoRoot, "rev-parse", "HEAD"], { timeout: 10_000 })).stdout.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP clone did not produce a valid commit id");

  const packageJson = await readPackageJson(repoRoot);
  if (packageJson) {
    const hasPackageLock = await access(path.join(repoRoot, "package-lock.json")).then(() => true, () => false);
    await runFile(npmCommand(), [hasPackageLock ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: repoRoot,
      timeout: DEFAULT_INSTALL_TIMEOUT_MS,
    });
    const scripts = packageJson.scripts && typeof packageJson.scripts === "object" && !Array.isArray(packageJson.scripts)
      ? packageJson.scripts as Record<string, unknown>
      : {};
    if (runBuild && typeof scripts.build === "string" && scripts.build.trim()) {
      await runFile(npmCommand(), ["run", "build"], { cwd: repoRoot, timeout: DEFAULT_INSTALL_TIMEOUT_MS });
    }
  }
  return { commit, packageJson };
}

async function resolveRemoteManagedMcpCommit(record: ManagedMcpRecord): Promise<string> {
  const source = normalizeGitHubRepositoryUrl(record.repositoryUrl);
  const args = ["ls-remote", source.canonicalUrl];
  if (record.ref) {
    args.push(record.ref, `refs/heads/${record.ref}`, `refs/tags/${record.ref}`, `refs/tags/${record.ref}^{}`);
  } else {
    args.push("HEAD");
  }
  const output = (await runFile("git", args, { timeout: 30_000 })).stdout;
  const entries = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [commit, refName] = line.split(/\s+/u, 2);
    return { commit: commit?.toLowerCase() ?? "", refName: refName ?? "" };
  }).filter((entry) => /^[a-f0-9]{40,64}$/u.test(entry.commit));
  if (entries.length === 0) throw new DomainError(ErrorCode.FILE_NOT_FOUND, "managed MCP remote revision could not be resolved", { serverId: record.id });
  if (!record.ref) return entries.find((entry) => entry.refName === "HEAD")?.commit ?? entries[0]!.commit;
  const preferred = [
    `refs/tags/${record.ref}^{}`,
    `refs/heads/${record.ref}`,
    `refs/tags/${record.ref}`,
    record.ref,
  ];
  for (const refName of preferred) {
    const match = entries.find((entry) => entry.refName === refName);
    if (match) return match.commit;
  }
  return entries[0]!.commit;
}

export function shouldPreserveManagedMcpRepoPath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) return false;
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) return false;
  const segments = normalized.split(path.sep).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => GENERATED_REPO_DIRS.has(segment))) return false;
  if (GENERATED_REPO_FILES.has(path.basename(normalized).toLowerCase())) return false;
  return true;
}

async function preserveManagedMcpRepoLocalData(oldRepo: string, newRepo: string): Promise<{ files: number; bytes: number }> {
  const [untrackedOutput, ignoredOutput, trackedOutput] = await Promise.all([
    runFile("git", ["-C", oldRepo, "ls-files", "--others", "--exclude-standard", "-z"], { timeout: 15_000 }),
    runFile("git", ["-C", oldRepo, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { timeout: 15_000 }),
    runFile("git", ["-C", newRepo, "ls-files", "-z"], { timeout: 15_000 }),
  ]);
  const split = (value: string) => value.split("\0").filter((entry) => entry.length > 0);
  const tracked = new Set(split(trackedOutput.stdout).map((entry) => path.normalize(entry)));
  const candidates = Array.from(new Set([...split(untrackedOutput.stdout), ...split(ignoredOutput.stdout)]));
  const oldResolved = await realpath(oldRepo);
  const newResolved = await realpath(newRepo);
  let files = 0;
  let bytes = 0;

  for (const candidate of candidates) {
    if (!shouldPreserveManagedMcpRepoPath(candidate)) continue;
    const normalized = path.normalize(candidate);
    if (tracked.has(normalized)) continue;
    const source = path.resolve(oldResolved, normalized);
    const destination = path.resolve(newResolved, normalized);
    if (!source.startsWith(`${oldResolved}${path.sep}`) || !destination.startsWith(`${newResolved}${path.sep}`)) continue;
    const info = await lstat(source).catch(() => null);
    if (!info?.isFile()) continue;
    files += 1;
    bytes += info.size;
    if (files > MAX_PRESERVED_FILES || bytes > MAX_PRESERVED_BYTES) {
      throw new DomainError(ErrorCode.QUOTA_EXCEEDED, "managed MCP repo-local data exceeds the safe update preservation limit", {
        maxFiles: MAX_PRESERVED_FILES,
        maxBytes: MAX_PRESERVED_BYTES,
      });
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: DIR_MODE });
    await copyFile(source, destination);
  }
  return { files, bytes };
}

export function updatedManagedMcpRecord(record: ManagedMcpRecord, commit: string, updatedAt: number): ManagedMcpRecord {
  const normalizedCommit = commit.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(normalizedCommit)) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP update commit is invalid");
  return { ...record, commit: normalizedCommit, updatedAt };
}

async function validateLaunchAgainstRepository(repoRoot: string, launch: ManagedMcpLaunchSpec): Promise<ManagedMcpLaunchSpec> {
  const cwd = path.resolve(repoRoot, launch.cwdRelative);
  const repoResolved = await realpath(repoRoot);
  const cwdResolved = await realpath(cwd).catch(() => cwd);
  if (cwdResolved !== repoResolved && !cwdResolved.startsWith(`${repoResolved}${path.sep}`)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "managed MCP launch cwd leaves its installed repository");
  }
  let command = launch.command;
  if (command.startsWith(`.${path.sep}`) || command.startsWith("./") || command.startsWith(".\\")) {
    const resolved = path.resolve(cwdResolved, command);
    if (resolved !== repoResolved && !resolved.startsWith(`${repoResolved}${path.sep}`)) {
      throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "managed MCP relative launch command leaves its installed repository");
    }
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) throw new DomainError(ErrorCode.FILE_NOT_FOUND, "managed MCP relative launch command does not exist");
    command = resolved;
  } else if (path.isAbsolute(command)) {
    const resolvedCommand = path.resolve(command);
    if (resolvedCommand === path.resolve(process.execPath) || isManagedRuntimeNodeExecutable(resolvedCommand)) {
      command = process.execPath;
    } else {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "managed MCP absolute launch commands are restricted; use a bare executable name, ./repo-binary, or node");
    }
  }
  if (command === "node") command = process.execPath;
  return { ...launch, command };
}

function isManagedRuntimeNodeExecutable(command: string, currentExecutablePath = process.execPath): boolean {
  const currentExecutable = path.resolve(currentExecutablePath);
  const currentRuntimeRoot = path.dirname(path.dirname(path.dirname(currentExecutable)));
  const runtimeReleaseRoot = path.dirname(currentRuntimeRoot);
  const candidate = path.resolve(command);
  const relative = path.relative(runtimeReleaseRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  if (!/^runtime-[a-f0-9]{64}$/u.test(parts[0] ?? "")) return false;
  const currentExecutableSuffix = path.relative(currentRuntimeRoot, currentExecutable);
  return parts.slice(1).join(path.sep) === currentExecutableSuffix;
}

export function normalizeManagedRuntimeNodeLaunch(
  launch: ManagedMcpLaunchSpec,
  currentExecutablePath = process.execPath,
): ManagedMcpLaunchSpec {
  if (!path.isAbsolute(launch.command) || !isManagedRuntimeNodeExecutable(launch.command, currentExecutablePath)) return launch;
  return { ...launch, command: "node" };
}

export async function installManagedMcp(input: ManagedMcpInstallInput): Promise<{ record: ManagedMcpRecord; reusedExisting: boolean; autoDetected: boolean }> {
  const source = normalizeGitHubRepositoryUrl(input.repositoryUrl);
  const ref = normalizeRef(input.ref);
  const explicitLaunch = normalizeManagedMcpLaunch(input.launch);
  const service = normalizeManagedMcpService(input.service);
  const root = managedRoot(input.stateDir);
  const finalRoot = path.join(root, "servers", source.id);
  const finalRepo = path.join(finalRoot, "repo");

  return withStateLock(input.stateDir, async () => {
    const state = await readState(input.stateDir);
    const existing = state.servers.find((server) => server.id === source.id);
    if (existing) {
      if (existing.repositoryUrl !== source.canonicalUrl || existing.ref !== ref) {
        throw new DomainError(ErrorCode.FILE_EXISTS, "managed MCP server id already exists with different source metadata", { serverId: source.id });
      }
      return { record: existing, reusedExisting: true, autoDetected: input.launch === undefined };
    }
    if (state.servers.length >= MAX_SERVERS) throw new DomainError(ErrorCode.QUOTA_EXCEEDED, `managed MCP registry is limited to ${MAX_SERVERS} servers`);

    await mkdir(path.join(root, "servers"), { recursive: true, mode: DIR_MODE });
    const temporaryRoot = path.join(root, `.install-${source.id}-${randomUUID()}`);
    const temporaryRepo = path.join(temporaryRoot, "repo");
    try {
      const prepared = await prepareManagedMcpRepository(source.canonicalUrl, ref, temporaryRepo, input.runBuild !== false);
      const { commit, packageJson } = prepared;

      const detected = explicitLaunch ?? (packageJson ? detectNodeManagedMcpLaunch(packageJson) : null);
      if (!detected) {
        throw new DomainError(
          ErrorCode.INVALID_ARGUMENT,
          "managed MCP could not auto-detect a stdio launch command; provide launch.command/args/cwdRelative for this repository",
          { serverId: source.id, nodeProjectDetected: packageJson !== null },
        );
      }
      const validatedTemporaryLaunch = await validateLaunchAgainstRepository(temporaryRepo, detected);
      const detectedService = service ?? (packageJson ? detectManagedMcpService(packageJson) : undefined);
      const validatedTemporaryService = detectedService
        ? { ...detectedService, launch: await validateLaunchAgainstRepository(temporaryRepo, detectedService.launch) }
        : undefined;
      await mkdir(path.dirname(finalRoot), { recursive: true, mode: DIR_MODE });
      await rename(temporaryRoot, finalRoot).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
          throw new DomainError(ErrorCode.FILE_EXISTS, "managed MCP install directory already exists", { serverId: source.id });
        }
        throw error;
      });

      const launch: ManagedMcpLaunchSpec = {
        ...validatedTemporaryLaunch,
        command: validatedTemporaryLaunch.command.startsWith(temporaryRepo)
          ? `.${path.sep}${path.relative(temporaryRepo, validatedTemporaryLaunch.command)}`
          : validatedTemporaryLaunch.command,
      };
      const installedService = validatedTemporaryService ? {
        ...validatedTemporaryService,
        launch: {
          ...validatedTemporaryService.launch,
          command: validatedTemporaryService.launch.command.startsWith(temporaryRepo)
            ? `.${path.sep}${path.relative(temporaryRepo, validatedTemporaryService.launch.command)}`
            : validatedTemporaryService.launch.command,
        },
      } : undefined;
      const now = Date.now();
      const name = typeof packageJson?.name === "string" && packageJson.name.trim() ? packageJson.name.trim().slice(0, 120) : `${source.owner}/${source.repo}`;
      const record: ManagedMcpRecord = {
        id: source.id,
        name,
        repositoryUrl: source.canonicalUrl,
        ref,
        commit: commit.toLowerCase(),
        installRoot: finalRoot,
        repoRoot: finalRepo,
        launch,
        service: installedService,
        runBuild: input.runBuild !== false,
        installedAt: now,
        updatedAt: now,
      };
      state.servers.push(record);
      state.updatedAt = now;
      await writeState(input.stateDir, state);
      return { record, reusedExisting: false, autoDetected: explicitLaunch === null };
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function checkManagedMcpUpdate(stateDir: string, id: string): Promise<{
  serverId: string;
  currentCommit: string;
  latestCommit: string;
  updateAvailable: boolean;
  ref: string | null;
}> {
  const record = await getRecord(stateDir, id);
  const latestCommit = await resolveRemoteManagedMcpCommit(record);
  return {
    serverId: id,
    currentCommit: record.commit,
    latestCommit,
    updateAvailable: latestCommit !== record.commit,
    ref: record.ref,
  };
}

export async function updateManagedMcp(stateDir: string, id: string): Promise<{
  record: ManagedMcpRecord;
  previousCommit: string;
  updated: boolean;
  restarted: boolean;
  mcpRestarted: boolean;
  serviceRestarted: boolean;
  preservedFiles: number;
  preservedBytes: number;
}> {
  return withStateLock(stateDir, async () => {
    const state = await readState(stateDir);
    const index = state.servers.findIndex((server) => server.id === id);
    if (index < 0) throw new DomainError(ErrorCode.FILE_NOT_FOUND, "managed MCP server is not installed", { serverId: id });
    const record = state.servers[index]!;
    const source = normalizeGitHubRepositoryUrl(record.repositoryUrl);
    const root = managedRoot(stateDir);
    const temporaryRoot = path.join(root, `.update-${record.id}-${randomUUID()}`);
    const temporaryRepo = path.join(temporaryRoot, "repo");
    const backupRepo = path.join(record.installRoot, `.repo-backup-${randomUUID()}`);
    let oldRepoMoved = false;
    let newRepoMoved = false;
    let stoppedForUpdate = false;
    let mcpWasRunning = false;
    let serviceWasRunning = false;
    let restoreTargets = { mcp: false, service: false };
    let preservedFiles = 0;
    let preservedBytes = 0;
    const key = activeKey(stateDir, record.id);

    try {
      const prepared = await prepareManagedMcpRepository(source.canonicalUrl, record.ref, temporaryRepo, record.runBuild !== false);
      const normalizedLaunch = path.isAbsolute(record.launch.command) && isManagedRuntimeNodeExecutable(record.launch.command) ? { ...record.launch, command: "node" } : record.launch;
      await validateLaunchAgainstRepository(temporaryRepo, normalizedLaunch);
      const declaredService = prepared.packageJson ? detectManagedMcpService(prepared.packageJson) : undefined;
      const serviceForUpdate = declaredService ?? record.service;
      const normalizedService = serviceForUpdate ? { ...serviceForUpdate, launch: path.isAbsolute(serviceForUpdate.launch.command) && isManagedRuntimeNodeExecutable(serviceForUpdate.launch.command) ? { ...serviceForUpdate.launch, command: "node" } : serviceForUpdate.launch } : undefined;
      if (normalizedService) await validateLaunchAgainstRepository(temporaryRepo, normalizedService.launch);
      if (prepared.commit === record.commit) {
        return { record, previousCommit: record.commit, updated: false, restarted: false, mcpRestarted: false, serviceRestarted: false, preservedFiles: 0, preservedBytes: 0 };
      }

      updatingServers.add(key);
      mcpWasRunning = activeServers.has(key);
      serviceWasRunning = activeServices.has(key);
      restoreTargets = managedMcpLifecycleRestoreTargets({
        desiredRunning: record.desiredRunning,
        desiredServiceRunning: record.desiredServiceRunning,
        serviceConfigured: !!record.service,
        mcpWasRunning,
        serviceWasRunning,
      });
      if (mcpWasRunning || serviceWasRunning) {
        await stopManagedMcp(stateDir, record.id);
        stoppedForUpdate = true;
      }
      const preserved = await preserveManagedMcpRepoLocalData(record.repoRoot, temporaryRepo);
      preservedFiles = preserved.files;
      preservedBytes = preserved.bytes;
      await rename(record.repoRoot, backupRepo);
      oldRepoMoved = true;
      await rename(temporaryRepo, record.repoRoot);
      newRepoMoved = true;

      const updatedRecord = { ...updatedManagedMcpRecord(record, prepared.commit, Date.now()), launch: normalizedLaunch, service: normalizedService };
      state.servers[index] = updatedRecord;
      state.updatedAt = updatedRecord.updatedAt;
      await writeState(stateDir, state);

      updatingServers.delete(key);
      if (restoreTargets.mcp || restoreTargets.service) {
        await startManagedMcpForLifecycle(stateDir, updatedRecord, restoreTargets);
        if (restoreTargets.mcp) await listManagedMcpTools(stateDir, record.id);
      }
      await rm(backupRepo, { recursive: true, force: true });
      oldRepoMoved = false;
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      return {
        record: updatedRecord,
        previousCommit: record.commit,
        updated: true,
        restarted: restoreTargets.mcp,
        mcpRestarted: restoreTargets.mcp,
        serviceRestarted: !!updatedRecord.service && restoreTargets.service,
        preservedFiles,
        preservedBytes,
      };
    } catch (error) {
      let rollbackError: unknown = null;
      if (oldRepoMoved) {
        try {
          updatingServers.add(key);
          await stopManagedMcp(stateDir, record.id).catch(() => ({ serverId: record.id, stopped: false, serviceStopped: false }));
          if (newRepoMoved) await rm(record.repoRoot, { recursive: true, force: true });
          await rename(backupRepo, record.repoRoot);
          oldRepoMoved = false;
          state.servers[index] = record;
          state.updatedAt = Date.now();
          await writeState(stateDir, state);
          updatingServers.delete(key);
          if (restoreTargets.mcp || restoreTargets.service) await startManagedMcpForLifecycle(stateDir, record, restoreTargets);
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
      } else if (stoppedForUpdate) {
        try {
          updatingServers.delete(key);
          if (restoreTargets.mcp || restoreTargets.service) await startManagedMcpForLifecycle(stateDir, record, restoreTargets);
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
      }
      if (rollbackError) {
        throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "managed MCP update failed and rollback could not be completed", {
          serverId: record.id,
          previousCommit: record.commit,
        });
      }
      throw error;
    } finally {
      updatingServers.delete(key);
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      if (!oldRepoMoved) await rm(backupRepo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

function managedMcpRuntimeSnapshot(stateDir: string, record: ManagedMcpRecord): ManagedMcpRuntimeSnapshot {
  const key = activeKey(stateDir, record.id);
  const active = activeServers.get(key);
  const service = activeServices.get(key);
  const mcpExpected = record.desiredRunning === true;
  const serviceExpected = !!record.service && record.desiredServiceRunning !== false;
  const desiredDegraded = (mcpExpected && !active) || (record.desiredServiceRunning === true && !service);
  const status: ManagedMcpRuntimeState = updatingServers.has(key)
    ? "updating"
    : startPromises.has(key)
      ? "starting"
      : desiredDegraded
        ? "degraded"
        : active && (!serviceExpected || service)
        ? "running"
        : active || service
          ? "degraded"
          : "stopped";
  return {
    ...record,
    status,
    running: !!active,
    pid: active?.transport.pid ?? null,
    startedAt: active?.startedAt ?? null,
    mcpLastExit: mcpExitDiagnostics.get(key) ?? null,
    serviceConfigured: !!record.service,
    serviceRunning: !!service,
    servicePid: service?.child.pid ?? null,
    serviceStartedAt: service?.startedAt ?? null,
    serviceHealthUrl: record.service?.health.url ?? null,
    serviceHealth: null,
    serviceLastExit: serviceExitDiagnostics.get(key) ?? null,
    serviceLifecycle: serviceLifecycleDiagnostics.get(key)?.at(-1) ?? null,
  };
}

export async function listManagedMcps(stateDir: string): Promise<ManagedMcpRuntimeSnapshot[]> {
  const state = await readState(stateDir);
  return Promise.all(state.servers.map(async (record) => {
    const snapshot = managedMcpRuntimeSnapshot(stateDir, record);
    return { ...snapshot, serviceHealth: await probeManagedMcpServiceHealth(record, activeServices.get(activeKey(stateDir, record.id))) };
  }));
}

export async function getManagedMcpStatus(stateDir: string, id: string): Promise<ManagedMcpRuntimeSnapshot> {
  const record = await getRecord(stateDir, id);
  const snapshot = managedMcpRuntimeSnapshot(stateDir, record);
  return { ...snapshot, serviceHealth: await probeManagedMcpServiceHealth(record, activeServices.get(activeKey(stateDir, id))) };
}

export async function readManagedMcpLogs(stateDir: string, id: string, maxBytes = MAX_STDERR_BYTES): Promise<ManagedMcpLogsSnapshot> {
  if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > MAX_STDERR_BYTES) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, `managed MCP maxBytes must be between 512 and ${MAX_STDERR_BYTES}`);
  }
  const record = await getRecord(stateDir, id);
  const key = activeKey(stateDir, id);
  const active = activeServers.get(key);
  const service = activeServices.get(key);
  const tail = (value: string): string => redact(value).slice(-maxBytes);
  const lastExit = serviceExitDiagnostics.get(key) ?? null;
  return {
    serverId: id,
    status: managedMcpRuntimeSnapshot(stateDir, record).status,
    maxBytes,
    mcp: {
      running: !!active,
      stderr: tail(active?.stderr ?? ""),
      lastExit: mcpExitDiagnostics.get(key) ?? null,
    },
    service: {
      configured: !!record.service,
      running: !!service,
      stdout: tail(service?.stdout ?? ""),
      stderr: tail(service?.stderr ?? ""),
      lastExit,
      lifecycle: serviceLifecycleDiagnostics.get(key) ?? [],
    },
  };
}

export function createManagedMcpServiceExitDiagnostic(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
  exitedAt = Date.now(),
): ManagedMcpServiceExitDiagnostic {
  return {
    exitedAt,
    exitCode,
    signal,
    stderr: redact(stderr).slice(-MAX_STDERR_BYTES),
  };
}

async function getRecord(stateDir: string, id: string): Promise<ManagedMcpRecord> {
  const state = await readState(stateDir);
  const record = state.servers.find((server) => server.id === id);
  if (!record) throw new DomainError(ErrorCode.FILE_NOT_FOUND, "managed MCP server is not installed", { serverId: id });
  return record;
}

function childEnvForKeys(keys: string[]): Record<string, string> {
  const safe = buildSafeChildEnv();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(safe)) if (value !== undefined) env[key] = value;
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function childEnv(record: ManagedMcpRecord): Record<string, string> {
  return childEnvForKeys(record.launch.inheritEnvKeys);
}

async function waitForManagedServiceHealth(record: ManagedMcpRecord, child: ChildProcess): Promise<{ ok: true; status: number }> {
  const health = record.service?.health;
  if (!health) return { ok: true, status: 200 };
  const deadline = Date.now() + health.timeoutMs;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await fetch(health.url, { signal: AbortSignal.timeout(Math.min(2_000, Math.max(250, deadline - Date.now()))) });
      lastStatus = response.status;
      if (response.ok) {
        // A stale listener can answer the health URL before this newly spawned
        // child has finished binding its own port. Give the child a short
        // survival window so EADDRINUSE cannot be mistaken for healthy start.
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (child.exitCode === null && child.signalCode === null) return { ok: true, status: response.status };
        break;
      }
    } catch { /* retry until bounded deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new DomainError(ErrorCode.TIMEOUT, "managed MCP service health check timed out", { serverId: record.id, status: lastStatus });
}

async function probeManagedMcpServiceHealth(
  record: ManagedMcpRecord,
  active: ActiveManagedMcpService | undefined,
): Promise<ManagedMcpServiceHealthSnapshot | null> {
  if (!record.service) return null;
  const checkedAt = Date.now();
  if (!active || active.child.exitCode !== null || active.child.signalCode !== null) return { ok: false, status: null, checkedAt };
  try {
    const response = await fetch(record.service.health.url, { signal: AbortSignal.timeout(1_500) });
    return { ok: response.ok, status: response.status, checkedAt };
  } catch {
    return { ok: false, status: null, checkedAt };
  }
}

async function startManagedMcpService(stateDir: string, record: ManagedMcpRecord): Promise<ActiveManagedMcpService | null> {
  if (!record.service) return null;
  const key = activeKey(stateDir, record.id);
  const existing = activeServices.get(key);
  if (existing) return existing;
  const launch = await validateLaunchAgainstRepository(record.repoRoot, record.service.launch);
  const cwd = await realpath(path.resolve(record.repoRoot, launch.cwdRelative));
  // execution-capability: managed-mcp-service
  let child: ChildProcess;
  try {
    child = spawn(launch.command, launch.args, { cwd, env: childEnvForKeys(launch.inheritEnvKeys), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    appendServiceLifecycleEvidence(stateDir, record, "spawn-failed", null);
    throw error;
  }
  const active: ActiveManagedMcpService = { record, child, startedAt: Date.now(), stdout: "", stderr: "", expectedStop: false };
  child.stdout?.on("data", (chunk) => { active.stdout = (active.stdout + Buffer.from(chunk).toString("utf8")).slice(-MAX_STDERR_BYTES); });
  child.stderr?.on("data", (chunk) => { active.stderr = (active.stderr + Buffer.from(chunk).toString("utf8")).slice(-MAX_STDERR_BYTES); });
  child.once("exit", (code, signal) => {
    if (!active.expectedStop) {
      serviceExitDiagnostics.set(key, createManagedMcpServiceExitDiagnostic(code, signal, active.stderr));
      appendServiceLifecycleEvidence(stateDir, record, "unexpected-exit", child.pid ?? null, { ok: false, status: null });
    }
    if (activeServices.get(key) === active) activeServices.delete(key);
  });
  const spawnFailure = new Promise<never>((_, reject) => child.once("error", reject));
  try {
    await Promise.race([waitForManagedServiceHealth(record, child), spawnFailure]);
    activeServices.set(key, active);
    return active;
  } catch (error) {
    const reason: ManagedMcpServiceLifecycleReason = error instanceof DomainError && error.code === ErrorCode.TIMEOUT ? "health-failed" : "spawn-failed";
    const status = error instanceof DomainError && typeof error.details?.status === "number" ? error.details.status : null;
    appendServiceLifecycleEvidence(stateDir, record, reason, child.pid ?? null, { ok: false, status });
    active.expectedStop = true;
    child.kill("SIGTERM");
    throw error;
  }
}

async function stopManagedMcpService(stateDir: string, id: string, recordEvidence = true): Promise<boolean> {
  const key = activeKey(stateDir, id);
  const active = activeServices.get(key);
  if (!active) return false;
  if (recordEvidence) appendServiceLifecycleEvidence(stateDir, active.record, "intentional-stop", active.child.pid ?? null);
  active.expectedStop = true;
  activeServices.delete(key);
  if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => active.child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill("SIGKILL");
  return true;
}

async function startManagedMcpForLifecycle(
  stateDir: string,
  record: ManagedMcpRecord,
  targets: { mcp: boolean; service: boolean },
): Promise<{ active: ActiveManagedMcp | null; service: ActiveManagedMcpService | null }> {
  const service = targets.service ? await startManagedMcpService(stateDir, record) : null;
  try {
    const active = targets.mcp ? await startRecord(stateDir, record) : null;
    return { active, service };
  } catch (error) {
    if (service) await stopManagedMcpService(stateDir, record.id, false).catch(() => undefined);
    throw error;
  }
}

async function startRecord(stateDir: string, record: ManagedMcpRecord): Promise<ActiveManagedMcp> {
  const key = activeKey(stateDir, record.id);
  if (updatingServers.has(key)) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "managed MCP update is in progress", { serverId: record.id });
  const existing = activeServers.get(key);
  if (existing) return existing;
  const pending = startPromises.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const launch = await validateLaunchAgainstRepository(record.repoRoot, record.launch);
    const cwd = await realpath(path.resolve(record.repoRoot, launch.cwdRelative));
    // execution-capability: managed-mcp-stdio-child
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd,
      env: childEnv(record),
      stderr: "pipe",
      maxBufferSize: 10 * 1024 * 1024,
    });
    const client = new Client({ name: `chatgpt2codex-managed-${record.id}`, version: "1.0.0" }, { capabilities: {} });
    const active: ActiveManagedMcp = { record, client, transport, startedAt: Date.now(), stderr: "", expectedStop: false };
    const stderr = transport.stderr;
    stderr?.on("data", (chunk) => {
      active.stderr = (active.stderr + Buffer.from(chunk).toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    transport.onclose = () => {
      if (!active.expectedStop) {
        mcpExitDiagnostics.set(key, { closedAt: Date.now(), stderr: redact(active.stderr).slice(-MAX_STDERR_BYTES) });
      }
      if (activeServers.get(key) === active) activeServers.delete(key);
    };
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => setTimeout(() => reject(new DomainError(ErrorCode.TIMEOUT, "managed MCP server initialization timed out")), 15_000)),
      ]);
      activeServers.set(key, active);
      return active;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  })();
  startPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    startPromises.delete(key);
  }
}

export async function startManagedMcp(stateDir: string, id: string): Promise<Record<string, unknown>> {
  const record = await getRecord(stateDir, id);
  const service = await startManagedMcpService(stateDir, record);
  let active: ActiveManagedMcp;
  try {
    active = await startRecord(stateDir, record);
  } catch (error) {
    if (service) await stopManagedMcpService(stateDir, id).catch(() => undefined);
    throw error;
  }
  if (!updatingServers.has(activeKey(stateDir, id))) await setDesiredState(stateDir, id, true, !!record.service);
  return {
    serverId: record.id,
    name: record.name,
    running: true,
    pid: active.transport.pid,
    startedAt: active.startedAt,
    serverVersion: active.client.getServerVersion() ?? null,
    capabilities: active.client.getServerCapabilities() ?? {},
    serviceRunning: !!service,
    servicePid: service?.child.pid ?? null,
  };
}

export async function stopManagedMcp(stateDir: string, id: string): Promise<{ serverId: string; stopped: boolean; serviceStopped: boolean }> {
  const key = activeKey(stateDir, id);
  const active = activeServers.get(key);
  if (active) {
    active.expectedStop = true;
    activeServers.delete(key);
    await active.client.close().catch(() => active.transport.close().catch(() => undefined));
  }
  const serviceStopped = await stopManagedMcpService(stateDir, id, !updatingServers.has(key));
  if (!updatingServers.has(key)) await setDesiredState(stateDir, id, false, false);
  return { serverId: id, stopped: !!active, serviceStopped };
}

export async function reconcileManagedMcpDesiredState(stateDir: string): Promise<Array<Record<string, unknown>>> {
  const state = await readState(stateDir);
  const results: Array<Record<string, unknown>> = [];
  for (const record of state.servers) {
    const wantMcp = record.desiredRunning === true;
    const wantService = !!record.service && record.desiredServiceRunning === true;
    if (!wantMcp && !wantService) continue;
    try {
      if (wantService) appendServiceLifecycleEvidence(stateDir, record, "generation-reconcile", null);
      const service = wantService ? await startManagedMcpService(stateDir, record) : null;
      const active = wantMcp ? await startRecord(stateDir, record) : null;
      if (service) appendServiceLifecycleEvidence(stateDir, record, "generation-reconcile", service.child.pid ?? null, { ok: true, status: 200 });
      results.push({ serverId: record.id, reconciled: true, running: !!active, serviceRunning: !!service });
    } catch (error) {
      const lifecycle = wantService
        ? appendServiceLifecycleEvidence(stateDir, record, "reconcile-failed", activeServices.get(activeKey(stateDir, record.id))?.child.pid ?? null)
        : null;
      results.push({
        serverId: record.id,
        reconciled: false,
        running: activeServers.has(activeKey(stateDir, record.id)),
        serviceRunning: activeServices.has(activeKey(stateDir, record.id)),
        error: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
        reason: "reconcile-failed",
        lifecycle,
      });
    }
  }
  return results;
}

export async function drainManagedMcpOwnedChildren(stateDir: string): Promise<Array<{
  serverId: string;
  mcpPid: number | null;
  servicePid: number | null;
  mcpStopped: boolean;
  serviceStopped: boolean;
}>> {
  const prefix = `${path.resolve(stateDir)}\0`;
  const ids = new Set<string>();
  for (const key of activeServers.keys()) if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  for (const key of activeServices.keys()) if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  const results: Array<{ serverId: string; mcpPid: number | null; servicePid: number | null; mcpStopped: boolean; serviceStopped: boolean }> = [];

  for (const id of ids) {
    const key = activeKey(stateDir, id);
    const active = activeServers.get(key);
    const service = activeServices.get(key);
    const mcpPid = active?.transport.pid ?? null;
    const servicePid = service?.child.pid ?? null;
    let mcpStopped = false;
    if (active) {
      active.expectedStop = true;
      activeServers.delete(key);
      await Promise.race([
        active.client.close().catch(() => active.transport.close().catch(() => undefined)),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      await active.transport.close().catch(() => undefined);
      mcpStopped = true;
    }
    const serviceStopped = await stopManagedMcpService(stateDir, id, true);
    results.push({ serverId: id, mcpPid, servicePid, mcpStopped, serviceStopped });
  }
  return results;
}

export async function restartManagedMcp(stateDir: string, id: string): Promise<Record<string, unknown>> {
  const previous = await stopManagedMcp(stateDir, id);
  const started = await startManagedMcp(stateDir, id);
  return {
    ...started,
    restarted: true,
    previousStopped: previous.stopped,
    previousServiceStopped: previous.serviceStopped,
  };
}

async function activeClient(stateDir: string, id: string): Promise<ActiveManagedMcp> {
  const record = await getRecord(stateDir, id);
  return startRecord(stateDir, record);
}

function assertBoundedProxyResult(value: unknown): void {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP returned a non-JSON-compatible result");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_PROXY_JSON_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, "managed MCP result exceeded the 1 MiB proxy limit");
  }
}

export async function listManagedMcpTools(stateDir: string, id: string): Promise<Record<string, unknown>> {
  const active = await activeClient(stateDir, id);
  const tools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const result = await active.client.listTools(cursor ? { cursor } : undefined);
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor || tools.length >= 500) break;
  }
  const out = { serverId: id, tools: tools.slice(0, 500), truncated: tools.length > 500 || !!cursor };
  assertBoundedProxyResult(out);
  return out;
}

export async function callManagedMcpTool(stateDir: string, id: string, toolName: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const active = await activeClient(stateDir, id);
  if (!toolName || toolName.length > 200 || toolName.includes("\0")) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP toolName is invalid");
  }
  const result = await active.client.callTool({ name: toolName, arguments: args });
  assertBoundedProxyResult(result);
  return { serverId: id, toolName, result };
}

export async function managedMcpToolIsReadOnly(stateDir: string, id: string, toolName: string): Promise<boolean> {
  const active = await activeClient(stateDir, id);
  if (!toolName || toolName.length > 200 || toolName.includes("\0")) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP toolName is invalid");
  }
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const result = await active.client.listTools(cursor ? { cursor } : undefined);
    const tool = result.tools.find((candidate) => candidate.name === toolName);
    if (tool) return tool.annotations?.readOnlyHint === true;
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP tool is not advertised by the upstream server", { serverId: id, toolName });
}

export function managedMcpAdvertisesResources(capabilities: unknown): boolean {
  return Boolean(
    capabilities
    && typeof capabilities === "object"
    && !Array.isArray(capabilities)
    && (capabilities as Record<string, unknown>).resources,
  );
}

export async function listManagedMcpResources(stateDir: string, id: string): Promise<Record<string, unknown>> {
  const active = await activeClient(stateDir, id);
  if (!managedMcpAdvertisesResources(active.client.getServerCapabilities())) {
    const out = { serverId: id, resources: [], truncated: false };
    assertBoundedProxyResult(out);
    return out;
  }
  const resources: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const result = await active.client.listResources(cursor ? { cursor } : undefined);
    resources.push(...result.resources);
    cursor = result.nextCursor;
    if (!cursor || resources.length >= 500) break;
  }
  const out = { serverId: id, resources: resources.slice(0, 500), truncated: resources.length > 500 || !!cursor };
  assertBoundedProxyResult(out);
  return out;
}

export async function readManagedMcpResource(stateDir: string, id: string, uri: string): Promise<Record<string, unknown>> {
  const active = await activeClient(stateDir, id);
  if (!uri || uri.length > 4096 || uri.includes("\0")) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "managed MCP resource uri is invalid");
  if (!managedMcpAdvertisesResources(active.client.getServerCapabilities())) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "managed MCP server does not advertise the resources capability", { serverId: id });
  }
  const result = await active.client.readResource({ uri });
  assertBoundedProxyResult(result);
  return { serverId: id, uri, result };
}

export async function removeManagedMcp(stateDir: string, id: string): Promise<{ serverId: string; removed: boolean }> {
  await stopManagedMcp(stateDir, id);
  return withStateLock(stateDir, async () => {
    const state = await readState(stateDir);
    const index = state.servers.findIndex((server) => server.id === id);
    if (index < 0) return { serverId: id, removed: false };
    const [record] = state.servers.splice(index, 1);
    state.updatedAt = Date.now();
    await writeState(stateDir, state);
    const key = activeKey(stateDir, id);
    mcpExitDiagnostics.delete(key);
    serviceExitDiagnostics.delete(key);
    if (record) await rm(record.installRoot, { recursive: true, force: true });
    return { serverId: id, removed: true };
  });
}
