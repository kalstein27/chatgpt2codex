import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, promises as fs } from "node:fs";
import path, { delimiter } from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";
import { BoundedOutputCollector } from "./bounded-output.js";
import { buildSafeChildEnv, killProcessTree, type CommandLifecycleObserver, type CommandSideEffects, type ListedCommand } from "./command-runner.js";
import { OUTPUT_ARTIFACT_STREAM_BYTES } from "./output-artifacts.js";
import { commandStatusFromExit, type ProcessExecutionResult } from "./process-result.js";

const STATE_SCHEMA_VERSION = 1;
const POLICY_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_GRANTS = 200;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4096;
const MAX_PURPOSE = 400;
const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 300;
const OUTPUT_HEAD_BYTES = 4000;
const OUTPUT_TAIL_BYTES = 2000;

export type CommandRequestRisk =
  | "read-only"
  | "workspace-write"
  | "external-local-write"
  | "network"
  | "process-system-state"
  | "destructive-privileged";

export interface CommandRequestIntent {
  writesWorkspace?: boolean;
  writesExternalLocalPath?: boolean;
  needsNetwork?: boolean;
  launchesPersistentProcess?: boolean;
  destructive?: boolean;
}

export interface EffectiveCommandRequestEffects {
  writesWorkspace: boolean;
  writesExternalLocalPath: boolean;
  needsNetwork: boolean;
  launchesPersistentProcess: boolean;
  destructive: boolean;
  changesSystemState: boolean;
}

export interface ValidatedCommandRequest {
  policyVersion: 1;
  requestedExecutable: string;
  discoveredExecutable: string;
  resolvedExecutable: string;
  argv: string[];
  cwd: string;
  cwdRelative: string;
  purpose: string;
  risk: CommandRequestRisk;
  effects: EffectiveCommandRequestEffects;
  declaredIntent: Required<CommandRequestIntent>;
  underDeclared: string[];
  requestFingerprint: string;
}

export interface ApprovedCommandGrant {
  grantId: string;
  commandId: string;
  projectId: string;
  projectRoot: string;
  policyVersion: 1;
  resolvedExecutable: string;
  discoveredExecutable: string;
  argv: string[];
  cwd: string;
  cwdRelative: string;
  purpose: string;
  risk: CommandRequestRisk;
  effects: EffectiveCommandRequestEffects;
  requestFingerprint: string;
  approvalRequestId: string;
  createdAt: number;
}

interface GrantState {
  schemaVersion: 1;
  grants: ApprovedCommandGrant[];
}

const stateLocks = new Map<string, Promise<void>>();

const SHELL_WRAPPERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);
const DISPATCH_WRAPPERS = new Set(["env", "xargs", "nohup"]);
const INLINE_CODE_INTERPRETERS = new Set([
  "python", "python2", "python3", "perl", "ruby", "node", "deno", "bun", "osascript",
]);
const NETWORK_TOOLS = new Set(["curl", "wget", "ssh", "scp", "sftp", "ftp", "nc", "ncat", "netcat", "telnet"]);
const PROCESS_STATE_TOOLS = new Set(["open", "kill", "killall", "pkill", "launchctl", "systemctl", "service"]);
const DESTRUCTIVE_TOOLS = new Set(["sudo", "rm", "rmdir", "installer", "softwareupdate", "diskutil", "mkfs", "shutdown", "reboot"]);
const SAFE_VERSION_TOOLS = new Set(["git", "swift", "clang", "clang++", "cmake", "make", "ninja"]);
const SHELL_OPERATOR_ARGS = new Set(["|", "||", "&", "&&", ";", ">", ">>", "<", "<<", "2>", "2>>"]);

function statePath(stateDir: string): string {
  return path.join(stateDir, "project-command-grants.json");
}

function emptyState(): GrantState {
  return { schemaVersion: STATE_SCHEMA_VERSION, grants: [] };
}

function normalizeState(value: unknown): GrantState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState();
  const record = value as Partial<GrantState>;
  if (record.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(record.grants)) return emptyState();
  const grants = record.grants.filter((grant): grant is ApprovedCommandGrant => {
    if (!grant || typeof grant !== "object") return false;
    return typeof grant.grantId === "string" && typeof grant.commandId === "string" &&
      typeof grant.projectId === "string" && typeof grant.projectRoot === "string" &&
      grant.policyVersion === POLICY_VERSION && typeof grant.resolvedExecutable === "string" &&
      typeof grant.discoveredExecutable === "string" && Array.isArray(grant.argv) && grant.argv.every((arg) => typeof arg === "string") &&
      typeof grant.cwd === "string" && typeof grant.cwdRelative === "string" && typeof grant.purpose === "string" &&
      typeof grant.risk === "string" && typeof grant.requestFingerprint === "string" &&
      typeof grant.approvalRequestId === "string" && typeof grant.createdAt === "number";
  });
  return { schemaVersion: STATE_SCHEMA_VERSION, grants: grants.slice(0, MAX_GRANTS) };
}

async function readState(stateDir: string): Promise<GrantState> {
  try {
    return normalizeState(JSON.parse(await fs.readFile(statePath(stateDir), "utf8")));
  } catch {
    return emptyState();
  }
}

async function writeState(stateDir: string, state: GrantState): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(stateDir, DIR_MODE).catch(() => undefined);
  const destination = statePath(stateDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
  await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
  try {
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function withStateLock<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(stateDir);
  const previous = stateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  stateLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (stateLocks.get(key) === queued) stateLocks.delete(key);
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function normalizePurpose(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "command_request purpose is required");
  return normalized.slice(0, MAX_PURPOSE);
}

function normalizeIntent(value: CommandRequestIntent | undefined): Required<CommandRequestIntent> {
  return {
    writesWorkspace: value?.writesWorkspace === true,
    writesExternalLocalPath: value?.writesExternalLocalPath === true,
    needsNetwork: value?.needsNetwork === true,
    launchesPersistentProcess: value?.launchesPersistentProcess === true,
    destructive: value?.destructive === true,
  };
}

function validateArgv(argv: readonly string[]): string[] {
  if (argv.length > MAX_ARGS) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, `command_request argv is limited to ${MAX_ARGS} entries`);
  }
  return argv.map((arg, index) => {
    if (arg.includes("\0") || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(arg)) {
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "command_request argv contains control characters", { index });
    }
    if (Buffer.byteLength(arg, "utf8") > MAX_ARG_BYTES) {
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "command_request argv entry is too large", { index });
    }
    if (SHELL_OPERATOR_ARGS.has(arg.trim())) {
      throw new DomainError(ErrorCode.ARBITRARY_SHELL_DENIED, "command_request rejects shell pipe/redirection/control operators", { index });
    }
    return arg;
  });
}

async function executableCandidate(pathname: string): Promise<{ discovered: string; resolved: string } | null> {
  try {
    const stat = await fs.stat(pathname);
    if (!stat.isFile()) return null;
    if (process.platform !== "win32") await fs.access(pathname, fsConstants.X_OK);
    const resolved = await fs.realpath(pathname);
    return { discovered: pathname, resolved };
  } catch {
    return null;
  }
}

export async function resolveRequestedExecutable(executable: string): Promise<{ discoveredExecutable: string; resolvedExecutable: string }> {
  const requested = executable.normalize("NFKC").trim();
  if (!requested || requested.includes("\0")) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "command_request executable is required");
  if (requested.includes("/") || requested.includes("\\")) {
    if (!path.isAbsolute(requested)) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "command_request executable paths must be absolute; bare names may use the internal PATH resolver", { executable: requested });
    }
    const candidate = await executableCandidate(path.normalize(requested));
    if (!candidate) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "command_request executable does not exist or is not executable", { executable: requested });
    return { discoveredExecutable: candidate.discovered, resolvedExecutable: candidate.resolved };
  }
  const safePath = buildSafeChildEnv().PATH ?? "";
  const extensions = process.platform === "win32"
    ? (buildSafeChildEnv().PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of safePath.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidatePath = path.join(directory, process.platform === "win32" && !path.extname(requested) ? requested + extension : requested);
      if (!existsSync(candidatePath)) continue;
      const candidate = await executableCandidate(candidatePath);
      if (candidate) return { discoveredExecutable: candidate.discovered, resolvedExecutable: candidate.resolved };
    }
  }
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "command_request executable was not found in the verified PATH", { executable: requested });
}

async function assertNotScriptWrapper(resolvedExecutable: string): Promise<void> {
  try {
    const handle = await fs.open(resolvedExecutable, "r");
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0] ?? "";
      if (/^#!.*\b(?:ba|z|da|k|fi|c|tc)?sh\b/iu.test(firstLine)) {
        throw new DomainError(ErrorCode.ARBITRARY_SHELL_DENIED, "command_request rejects shell-script executables");
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    // Failure to inspect an otherwise executable binary is not authorization to shell-wrap it;
    // the direct exec path still remains shell-free.
  }
}

function basenameLower(executable: string): string {
  return path.basename(executable).toLowerCase();
}

function assertWrapperSafe(executable: string, argv: readonly string[]): void {
  const base = basenameLower(executable);
  if (SHELL_WRAPPERS.has(base) || DISPATCH_WRAPPERS.has(base)) {
    throw new DomainError(ErrorCode.ARBITRARY_SHELL_DENIED, "command_request rejects shell and generic command-dispatch wrappers", { executable });
  }
  if (INLINE_CODE_INTERPRETERS.has(base) && argv.some((arg) => arg === "-c" || arg === "-e" || arg === "--eval" || arg === "--execute")) {
    throw new DomainError(ErrorCode.ARBITRARY_SHELL_DENIED, "command_request rejects caller-supplied inline code interpreters", { executable });
  }
  if ((base === "find" || base === "busybox") && argv.some((arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir")) {
    throw new DomainError(ErrorCode.ARBITRARY_SHELL_DENIED, "command_request rejects argv forms that dispatch arbitrary child commands", { executable });
  }
}

function exactArgs(argv: readonly string[], expected: readonly string[]): boolean {
  return argv.length === expected.length && argv.every((arg, index) => arg === expected[index]);
}

export function classifyCommandRequestProfile(executable: string, argv: readonly string[]): { risk: CommandRequestRisk; effects: EffectiveCommandRequestEffects } {
  const base = basenameLower(executable);
  const first = (argv[0] ?? "").toLowerCase();
  const effects: EffectiveCommandRequestEffects = {
    writesWorkspace: false,
    writesExternalLocalPath: false,
    needsNetwork: false,
    launchesPersistentProcess: false,
    destructive: false,
    changesSystemState: false,
  };

  const readOnlyKnown =
    (base === "xcode-select" && exactArgs(argv, ["-p"])) ||
    (base === "xcodebuild" && exactArgs(argv, ["-version"])) ||
    (base === "xcodes" && exactArgs(argv, ["installed"])) ||
    (SAFE_VERSION_TOOLS.has(base) && (exactArgs(argv, ["--version"]) || exactArgs(argv, ["-version"]))) ||
    (base === "swift" && exactArgs(argv, ["-version"]));
  if (readOnlyKnown) return { risk: "read-only", effects };

  if (DESTRUCTIVE_TOOLS.has(base)) {
    effects.writesExternalLocalPath = true;
    effects.destructive = true;
    effects.changesSystemState = true;
    return { risk: "destructive-privileged", effects };
  }
  if (base === "xcode-select" && (first === "--switch" || first === "-s" || first === "--reset" || first === "-r")) {
    effects.writesExternalLocalPath = true;
    effects.changesSystemState = true;
    return { risk: "process-system-state", effects };
  }
  if (PROCESS_STATE_TOOLS.has(base)) {
    effects.changesSystemState = true;
    effects.launchesPersistentProcess = base === "open" || base === "launchctl" || base === "systemctl" || base === "service";
    return { risk: "process-system-state", effects };
  }
  if (NETWORK_TOOLS.has(base) ||
      (base === "git" && ["fetch", "pull", "push", "clone"].includes(first)) ||
      (["npm", "pnpm", "yarn", "bun"].includes(base) && ["install", "add", "update"].includes(first)) ||
      (base === "xcodes" && ["install", "download", "update"].includes(first))) {
    effects.needsNetwork = true;
    if (base === "xcodes" && ["install", "download", "update"].includes(first)) effects.writesExternalLocalPath = true;
    return { risk: "network", effects };
  }
  if (base === "git" && ["add", "rm", "mv", "restore", "reset", "checkout", "switch", "commit", "merge", "rebase", "cherry-pick", "revert", "stash", "tag", "branch"].includes(first)) {
    effects.writesWorkspace = true;
    return { risk: "workspace-write", effects };
  }

  // Unknown external executables are deliberately not assumed read-only. They remain
  // requestable, but use the strongest class unless C2CT has an exact verified profile.
  effects.writesExternalLocalPath = true;
  effects.destructive = true;
  effects.changesSystemState = true;
  return { risk: "destructive-privileged", effects };
}

function riskRank(risk: CommandRequestRisk): number {
  return ({
    "read-only": 0,
    "workspace-write": 1,
    "external-local-write": 2,
    "network": 3,
    "process-system-state": 4,
    "destructive-privileged": 5,
  })[risk];
}

function riskFromDeclared(intent: Required<CommandRequestIntent>): CommandRequestRisk {
  if (intent.destructive) return "destructive-privileged";
  if (intent.launchesPersistentProcess) return "process-system-state";
  if (intent.needsNetwork) return "network";
  if (intent.writesExternalLocalPath) return "external-local-write";
  if (intent.writesWorkspace) return "workspace-write";
  return "read-only";
}

function mergeEffects(staticEffects: EffectiveCommandRequestEffects, intent: Required<CommandRequestIntent>): EffectiveCommandRequestEffects {
  return {
    writesWorkspace: staticEffects.writesWorkspace || intent.writesWorkspace,
    writesExternalLocalPath: staticEffects.writesExternalLocalPath || intent.writesExternalLocalPath,
    needsNetwork: staticEffects.needsNetwork || intent.needsNetwork,
    launchesPersistentProcess: staticEffects.launchesPersistentProcess || intent.launchesPersistentProcess,
    destructive: staticEffects.destructive || intent.destructive,
    changesSystemState: staticEffects.changesSystemState || intent.launchesPersistentProcess || intent.destructive,
  };
}

export async function validateCommandRequest(input: {
  projectId: string;
  projectRoot: string;
  executable: string;
  argv?: string[];
  cwd?: string;
  purpose: string;
  intent?: CommandRequestIntent;
}): Promise<ValidatedCommandRequest> {
  const projectRoot = await fs.realpath(input.projectRoot);
  const args = validateArgv(input.argv ?? []);
  const { discoveredExecutable, resolvedExecutable } = await resolveRequestedExecutable(input.executable);
  assertWrapperSafe(resolvedExecutable, args);
  await assertNotScriptWrapper(resolvedExecutable);
  const commandCwd = input.cwd
    ? await resolveInProject(projectRoot, input.cwd, { allowSymlink: false })
    : projectRoot;
  const cwdStat = await fs.stat(commandCwd).catch(() => null);
  if (!cwdStat?.isDirectory()) throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "command_request cwd is not a project directory", { cwd: input.cwd });
  const purpose = normalizePurpose(input.purpose);
  const declaredIntent = normalizeIntent(input.intent);
  const classified = classifyCommandRequestProfile(resolvedExecutable, args);
  const declaredRisk = riskFromDeclared(declaredIntent);
  const risk = riskRank(declaredRisk) > riskRank(classified.risk) ? declaredRisk : classified.risk;
  const effects = mergeEffects(classified.effects, declaredIntent);
  const underDeclared: string[] = [];
  if (classified.effects.writesWorkspace && !declaredIntent.writesWorkspace) underDeclared.push("writesWorkspace");
  if (classified.effects.writesExternalLocalPath && !declaredIntent.writesExternalLocalPath) underDeclared.push("writesExternalLocalPath");
  if (classified.effects.needsNetwork && !declaredIntent.needsNetwork) underDeclared.push("needsNetwork");
  if (classified.effects.launchesPersistentProcess && !declaredIntent.launchesPersistentProcess) underDeclared.push("launchesPersistentProcess");
  if (classified.effects.destructive && !declaredIntent.destructive) underDeclared.push("destructive");
  const cwdRelative = path.relative(projectRoot, commandCwd) || ".";
  const fingerprintMaterial = {
    projectId: input.projectId,
    projectRoot,
    resolvedExecutable,
    argv: args,
    cwd: commandCwd,
    risk,
    effects,
    policyVersion: POLICY_VERSION,
  };
  return {
    policyVersion: POLICY_VERSION,
    requestedExecutable: input.executable,
    discoveredExecutable,
    resolvedExecutable,
    argv: args,
    cwd: commandCwd,
    cwdRelative,
    purpose,
    risk,
    effects,
    declaredIntent,
    underDeclared,
    requestFingerprint: digest(fingerprintMaterial),
  };
}

export function riskDisplayName(risk: CommandRequestRisk): string {
  switch (risk) {
    case "read-only": return "Read-only";
    case "workspace-write": return "Workspace write";
    case "external-local-write": return "External local write";
    case "network": return "Network";
    case "process-system-state": return "Process / system state";
    case "destructive-privileged": return "Destructive / privileged";
  }
}

export function commandRequestApprovalDetails(request: ValidatedCommandRequest): string {
  const argvText = request.argv.length ? request.argv.map((arg) => JSON.stringify(arg)).join(" ") : "(없음)";
  const effects = [
    `파일 변경: ${request.effects.writesWorkspace || request.effects.writesExternalLocalPath ? "가능" : "없음"}`,
    `네트워크: ${request.effects.needsNetwork ? "사용" : "없음"}`,
    `시스템/프로세스 상태 변경: ${request.effects.changesSystemState || request.effects.launchesPersistentProcess ? "가능" : "없음"}`,
    `파괴적 동작: ${request.effects.destructive ? "가능" : "없음"}`,
  ];
  return [
    "도구", request.resolvedExecutable,
    "인자", argvText,
    "작업 디렉터리", request.cwd,
    "목적", request.purpose,
    "위험도", riskDisplayName(request.risk),
    "영향", ...effects,
    ...(request.underDeclared.length ? ["C2CT 재분류", `caller 선언보다 강하게 판정: ${request.underDeclared.join(", ")}`] : []),
  ].join("\n");
}

function grantCommandId(requestFingerprint: string): string {
  return `approved:${requestFingerprint.slice(0, 24)}`;
}

export async function persistApprovedCommandGrant(input: {
  stateDir: string;
  projectId: string;
  projectRoot: string;
  request: ValidatedCommandRequest;
  approvalRequestId: string;
  now?: number;
}): Promise<ApprovedCommandGrant> {
  return withStateLock(input.stateDir, async () => {
    const projectRoot = await fs.realpath(input.projectRoot);
    const state = await readState(input.stateDir);
    const existing = state.grants.find((grant) =>
      grant.projectId === input.projectId && grant.projectRoot === projectRoot &&
      grant.requestFingerprint === input.request.requestFingerprint && grant.policyVersion === POLICY_VERSION,
    );
    if (existing) return existing;
    const grant: ApprovedCommandGrant = {
      grantId: `pcg_${randomUUID()}`,
      commandId: grantCommandId(input.request.requestFingerprint),
      projectId: input.projectId,
      projectRoot,
      policyVersion: POLICY_VERSION,
      resolvedExecutable: input.request.resolvedExecutable,
      discoveredExecutable: input.request.discoveredExecutable,
      argv: [...input.request.argv],
      cwd: input.request.cwd,
      cwdRelative: input.request.cwdRelative,
      purpose: input.request.purpose,
      risk: input.request.risk,
      effects: { ...input.request.effects },
      requestFingerprint: input.request.requestFingerprint,
      approvalRequestId: input.approvalRequestId,
      createdAt: input.now ?? Date.now(),
    };
    state.grants.unshift(grant);
    state.grants = state.grants.slice(0, MAX_GRANTS);
    await writeState(input.stateDir, state);
    return grant;
  });
}

function grantSideEffects(grant: ApprovedCommandGrant): CommandSideEffects {
  return {
    needsNetwork: grant.effects.needsNetwork,
    writesWorkspace: grant.effects.writesWorkspace,
    writesExternalLocalPath: grant.effects.writesExternalLocalPath,
    launchesProcess: grant.effects.launchesPersistentProcess || grant.effects.changesSystemState,
    destructive: grant.effects.destructive,
    fixedDestination: false,
    // The exact executable+argv+cwd profile was explicitly project-approved.
    localApproval: "none",
  };
}

export function approvedGrantAsListedCommand(grant: ApprovedCommandGrant): ListedCommand & {
  executable: string;
  fixedArgs: string[];
  cwd: string;
  requestFingerprint: string;
} {
  return {
    commandId: grant.commandId,
    display: [grant.resolvedExecutable, ...grant.argv].join(" "),
    source: "approved-project-grant",
    riskTier: grant.risk,
    sideEffects: grantSideEffects(grant),
    argProfiles: [],
    executable: grant.resolvedExecutable,
    fixedArgs: [...grant.argv],
    cwd: grant.cwdRelative,
    requestFingerprint: grant.requestFingerprint,
  };
}

export async function listApprovedCommandGrants(input: {
  stateDir: string;
  projectId: string;
  projectRoot: string;
}): Promise<ApprovedCommandGrant[]> {
  return withStateLock(input.stateDir, async () => {
    const root = await fs.realpath(input.projectRoot);
    const state = await readState(input.stateDir);
    return state.grants.filter((grant) => grant.projectId === input.projectId && grant.projectRoot === root && grant.policyVersion === POLICY_VERSION);
  });
}

export async function listAllApprovedCommandGrants(input: {
  stateDir: string;
}): Promise<ApprovedCommandGrant[]> {
  return withStateLock(input.stateDir, async () => {
    const state = await readState(input.stateDir);
    return state.grants
      .filter((grant) => grant.policyVersion === POLICY_VERSION)
      .map((grant) => ({ ...grant, argv: [...grant.argv], effects: { ...grant.effects } }));
  });
}

export async function revokeApprovedCommandGrant(input: {
  stateDir: string;
  projectId: string;
  grantId: string;
  projectRoot?: string;
}): Promise<ApprovedCommandGrant | null> {
  return withStateLock(input.stateDir, async () => {
    const root = input.projectRoot ? await fs.realpath(input.projectRoot) : undefined;
    const state = await readState(input.stateDir);
    const index = state.grants.findIndex((grant) =>
      grant.policyVersion === POLICY_VERSION &&
      grant.projectId === input.projectId &&
      grant.grantId === input.grantId &&
      (root === undefined || grant.projectRoot === root),
    );
    if (index < 0) return null;
    const [revoked] = state.grants.splice(index, 1);
    if (!revoked) return null;
    await writeState(input.stateDir, state);
    return { ...revoked, argv: [...revoked.argv], effects: { ...revoked.effects } };
  });
}

export async function resolveApprovedCommandGrant(input: {
  stateDir: string;
  projectId: string;
  projectRoot: string;
  commandId: string;
}): Promise<ApprovedCommandGrant | null> {
  const grants = await listApprovedCommandGrants(input);
  return grants.find((grant) => grant.commandId === input.commandId) ?? null;
}

export async function runRequestedCommand(
  request: Pick<ValidatedCommandRequest, "resolvedExecutable" | "argv" | "cwd"> | Pick<ApprovedCommandGrant, "resolvedExecutable" | "argv" | "cwd">,
  timeoutSec?: number,
  lifecycleObserver?: CommandLifecycleObserver,
  options: { signal?: AbortSignal; captureOutput?: boolean } = {},
): Promise<ProcessExecutionResult> {
  const requestedTimeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const effectiveTimeoutSec = Math.min(Math.max(requestedTimeout, 1), MAX_TIMEOUT_SEC);
  const start = Date.now();
  if (options.signal?.aborted) {
    return {
      commandStatus: "CANCELLED", exitCode: null, terminationSignal: null, cleanupStatus: "NOT_REQUIRED",
      stdoutSummary: "", stderrSummary: "", durationMs: 0, outputTruncated: false,
    };
  }
  return await new Promise((resolve) => {
    let settled = false;
    let forcedStop: "timeout" | "cancel" | undefined;
    let spawnFailed = false;
    let subprocessStarted = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const stdout = new BoundedOutputCollector(OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES);
    const stderr = new BoundedOutputCollector(OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES);
    const stdoutArtifact = new BoundedOutputCollector(OUTPUT_ARTIFACT_STREAM_BYTES, 0);
    const stderrArtifact = new BoundedOutputCollector(OUTPUT_ARTIFACT_STREAM_BYTES, 0);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", abortListener);
      fn();
    };
    const capturedOutput = () => {
      const out = stdoutArtifact.summarize();
      const err = stderrArtifact.summarize();
      return { stdout: out.text, stderr: err.text, stdoutBytes: out.totalBytes, stderrBytes: err.totalBytes, artifactTruncated: out.truncated || err.truncated };
    };
    // execution-capability: approved-project-command-profile
    const child = spawn(request.resolvedExecutable, request.argv, {
      cwd: request.cwd,
      env: buildSafeChildEnv(),
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("spawn", () => {
      subprocessStarted = true;
      lifecycleObserver?.({ phase: "running", subprocessStarted: true, subprocessStillRunning: true, cleanupStarted: false, cleanupCompleted: false });
    });
    child.stdout.on("data", (chunk: Buffer) => { stdout.append(chunk); stdoutArtifact.append(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr.append(chunk); stderrArtifact.append(chunk); });
    child.on("error", (error) => { spawnFailed = true; stderr.append(Buffer.from(error instanceof Error ? error.message : String(error))); });
    child.on("close", (code, signal) => {
      if (forcedStop) return;
      const out = stdout.summarize();
      const err = stderr.summarize();
      const exitCode = spawnFailed ? null : (code ?? 1);
      const status = commandStatusFromExit(exitCode, spawnFailed);
      lifecycleObserver?.({ phase: "completed", subprocessStarted, subprocessStillRunning: false, cleanupStarted: false, cleanupCompleted: true, durationMs: Date.now() - start, commandStatus: status, cleanupStatus: "NOT_REQUIRED" });
      finish(() => resolve({
        commandStatus: status, exitCode, terminationSignal: signal, cleanupStatus: "NOT_REQUIRED",
        stdoutSummary: out.text, stderrSummary: err.text, durationMs: Date.now() - start,
        outputTruncated: out.truncated || err.truncated,
        ...((out.truncated || err.truncated || options.captureOutput) ? { capturedOutput: capturedOutput() } : {}),
      }));
    });
    const stop = (reason: "timeout" | "cancel") => {
      if (settled || forcedStop) return;
      forcedStop = reason;
      lifecycleObserver?.({ phase: "cleanup", subprocessStarted, subprocessStillRunning: subprocessStarted, cleanupStarted: true, cleanupCompleted: false });
      killProcessTree(child.pid, (cleanupStatus) => {
        const out = stdout.summarize();
        const err = stderr.summarize();
        const status = reason === "timeout" ? "TIMEOUT" : "CANCELLED";
        lifecycleObserver?.({ phase: "completed", subprocessStarted, subprocessStillRunning: false, cleanupStarted: true, cleanupCompleted: cleanupStatus === "COMPLETED", durationMs: Date.now() - start, commandStatus: status, cleanupStatus });
        finish(() => resolve({
          commandStatus: status, exitCode: null, terminationSignal: process.platform === "win32" ? null : "SIGKILL", cleanupStatus,
          stdoutSummary: out.text, stderrSummary: err.text, durationMs: Date.now() - start,
          outputTruncated: out.truncated || err.truncated,
          ...((out.truncated || err.truncated || options.captureOutput) ? { capturedOutput: capturedOutput() } : {}),
        }));
      });
    };
    const abortListener = () => stop("cancel");
    options.signal?.addEventListener("abort", abortListener, { once: true });
    timeoutHandle = setTimeout(() => stop("timeout"), effectiveTimeoutSec * 1000);
    if (options.signal?.aborted) abortListener();
  });
}

export interface CommandRequestContinuationResult {
  turnlessContinuation: true;
  continuationStarted: true;
  fallbackRequiresExactReplay: false;
  actionStarted: boolean;
  subprocessStarted: boolean;
  operationId: string;
  approvalRequestId: string;
  sideEffects: "background-operation-started";
}

interface CommandRequestContinuationEntry {
  requestId: string;
  sessionScope: string;
  expiresAt: number;
  run: () => Promise<CommandRequestContinuationResult>;
  resultPromise?: Promise<CommandRequestContinuationResult>;
}

const commandRequestContinuations = new Map<string, CommandRequestContinuationEntry>();

function pruneCommandRequestContinuations(now = Date.now()): void {
  for (const [requestId, entry] of commandRequestContinuations) {
    if (entry.expiresAt <= now && !entry.resultPromise) commandRequestContinuations.delete(requestId);
  }
}

export function registerCommandRequestContinuation(input: {
  requestId: string;
  sessionScope: string;
  expiresAt: number;
  run: () => Promise<CommandRequestContinuationResult>;
}): void {
  pruneCommandRequestContinuations();
  const existing = commandRequestContinuations.get(input.requestId);
  if (existing) {
    if (existing.sessionScope !== input.sessionScope) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Command request continuation is already bound to another ChatGPT session", {
        requestId: input.requestId,
      });
    }
    return;
  }
  commandRequestContinuations.set(input.requestId, { ...input });
}

export function hasCommandRequestContinuation(input: {
  requestId: string;
  tool: string;
}): boolean {
  pruneCommandRequestContinuations();
  return input.tool === "command_request" && commandRequestContinuations.has(input.requestId);
}

export async function runCommandRequestContinuation(input: {
  requestId: string;
  sessionScope: string;
}): Promise<CommandRequestContinuationResult | undefined> {
  pruneCommandRequestContinuations();
  const entry = commandRequestContinuations.get(input.requestId);
  if (!entry || entry.sessionScope !== input.sessionScope) return undefined;
  entry.resultPromise ??= Promise.resolve().then(entry.run);
  const resultPromise = entry.resultPromise;
  try {
    return await resultPromise;
  } finally {
    if (commandRequestContinuations.get(input.requestId)?.resultPromise === resultPromise) {
      commandRequestContinuations.delete(input.requestId);
    }
  }
}

export function forgetCommandRequestContinuation(requestId: string): void {
  commandRequestContinuations.delete(requestId);
}
