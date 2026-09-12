import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { BoundedOutputCollector } from "./bounded-output.js";
import { OUTPUT_ARTIFACT_STREAM_BYTES } from "./output-artifacts.js";
import { resolveNpmInvocation } from "./runtime-environment.js";
import {
  commandStatusFromExit,
  type CommandStatus,
  type CleanupStatus,
  type ProcessExecutionResult,
} from "./process-result.js";

/**
 * Command metadata as discovered from project manifests. `argv` is the
 * literal argv array used by `spawn` — never a shell string — so
 * discovered commands can be executed without ever invoking a shell.
 */
interface DiscoveredCommand {
  commandId: string;
  display: string;
  source: string;
  riskTier: string;
  lowRiskTier: "read" | "verify";
  hardNeedsNetwork: boolean;
  hardDestructive: boolean;
  sideEffects: CommandSideEffects;
  argProfiles: CommandArgProfile[];
  argv: string[];
}

export type CommandLocalApproval = "none" | "once";

export interface CommandSideEffects {
  needsNetwork: boolean;
  writesWorkspace: boolean;
  writesExternalLocalPath: boolean;
  launchesProcess: boolean;
  destructive: boolean;
  fixedDestination: boolean;
  localApproval: CommandLocalApproval;
}

export interface CommandArgProfile {
  id: string;
  whenArgsContainAll: string[];
  sideEffects: Partial<CommandSideEffects>;
}

interface CommandPolicyDeclaration {
  sideEffects?: Partial<CommandSideEffects>;
  argProfiles?: CommandArgProfile[];
}

export interface ResolvedCommandPolicy extends ListedCommand {
  matchedProfileId?: string;
}

export interface CommandLifecycleEvent {
  phase: "running" | "cleanup" | "completed";
  subprocessStarted: boolean;
  subprocessStillRunning: boolean;
  cleanupStarted: boolean;
  cleanupCompleted: boolean;
  durationMs?: number;
  commandStatus?: CommandStatus;
  cleanupStatus?: CleanupStatus;
}

export type CommandLifecycleObserver = (event: CommandLifecycleEvent) => void;

export interface CommandTimeoutControl {
  /** Pause consumption of the existing execution-time budget until this
   * absolute timestamp. Repeated calls may only extend the same bounded hold. */
  pauseUntil(untilMs: number): void;
}

export interface RunCommandOptions {
  signal?: AbortSignal;
  /** Preserve bounded stdout/stderr for a resumable artifact even when the
   * short inline summaries were not truncated. */
  captureOutput?: boolean;
  /** Background-operation hook used to pause the command timeout while a
   * one-shot local cancellation approval is pending. */
  onTimeoutControl?: (control: CommandTimeoutControl) => void;
}

function emitCommandLifecycle(observer: CommandLifecycleObserver | undefined, event: CommandLifecycleEvent): void {
  try {
    observer?.(event);
  } catch {
    // Observation must never be able to change process execution semantics.
  }
}

const MAX_TIMEOUT_SEC = 300;
const DEFAULT_TIMEOUT_SEC = 30;
/** Head+tail bytes kept per stream when truncating output. */
const OUTPUT_HEAD_BYTES = 4000;
const OUTPUT_TAIL_BYTES = 2000;

/** Env vars allowed to reach the child process (PRD §8.5 execution tools). */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "LOCALAPPDATA",
  "APPDATA",
];

export function buildSafeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const runtimeBin = dirname(process.execPath);
  const inheritedPath = env.PATH ?? "";
  const pathEntries = inheritedPath.split(delimiter).filter(Boolean);
  if (!pathEntries.includes(runtimeBin)) {
    env.PATH = [runtimeBin, ...pathEntries].join(delimiter);
  }
  return env;
}

/** Script/target name -> risk tier heuristics (PRD §8.5, §9.5). */
const VERIFY_NAME_PATTERN = /^(test|tests|typecheck|type-check|lint|analyze|analyse|check|verify|quick)$/i;
const BUILD_NAME_PATTERN = /^(build|compile|bundle)$/i;
const DESTRUCTIVE_NAME_SEGMENTS = new Set(["deploy", "release", "publish", "destroy", "clean", "reset"]);
const NETWORK_NAME_SEGMENTS = new Set(["install", "deps", "dependencies", "fetch", "pull"]);

const SECRET_SCRIPT_PATTERN =
  /(^|[\s/"'])\.(env|ssh|npmrc)([\s/"'.]|$)|id_rsa|id_ed25519|private[_-]?key|security\s+find-(generic|internet)-password|keychain/i;
// `rm -rf`/`rm -fr` in either flag order, with or without a trailing slash
// on the target (the previous pattern required a literal `/` after the
// flags, so `rm -rf *`/`rm -rf .`/`rm -rf $DIR` all slipped past it into a
// non-destructive riskTier). Also cover `find -delete` and `git clean`.
const DESTRUCTIVE_SCRIPT_PATTERN =
  /\bsudo\b|\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b|\bfind\b[^\n]*-delete\b|\bgit\s+clean\b|\bdiskutil\s+erase|\bmkfs\b|\bshutdown\b|\breboot\b/i;
const NETWORK_SCRIPT_PATTERN = /\b(npm|pnpm|yarn|bun)\s+(install|add|update)|\b(curl|wget)\b|\bgit\s+(pull|fetch|clone|push)\b/i;
const WORKSPACE_WRITE_SCRIPT_PATTERN =
  /\b(chmod|chown|chgrp)\b|\bgit\s+(add|rm|mv|restore|reset|checkout|switch|commit|merge|rebase|cherry-pick|revert|stash|tag|branch)\b/i;

function classifyByName(name: string): string {
  // Manifest command names are commonly composed with `:`, `-`, `_`, and
  // `.`. Match high-risk words only as complete segments so harmless names
  // such as `cleanup-*`, `cleanliness`, or `installer-check` are not promoted
  // merely by substring. Script-body scanners below remain authoritative.
  const segments = name.toLowerCase().split(/[:._-]+/u).filter(Boolean);
  if (segments.some((segment) => DESTRUCTIVE_NAME_SEGMENTS.has(segment))) return "destructive";
  if (segments.some((segment) => NETWORK_NAME_SEGMENTS.has(segment))) return "network";
  if (VERIFY_NAME_PATTERN.test(name)) return "verify";
  if (BUILD_NAME_PATTERN.test(name)) return "verify";
  return "read";
}

function lowRiskTierForName(name: string): "read" | "verify" {
  return VERIFY_NAME_PATTERN.test(name) || BUILD_NAME_PATTERN.test(name) ? "verify" : "read";
}

function normalizeDeclaredSideEffects(value: unknown): Partial<CommandSideEffects> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const normalized: Partial<CommandSideEffects> = {};
  for (const key of [
    "needsNetwork",
    "writesWorkspace",
    "writesExternalLocalPath",
    "launchesProcess",
    "destructive",
    "fixedDestination",
  ] as const) {
    if (typeof record[key] === "boolean") normalized[key] = record[key];
  }
  if (record.localApproval === "none" || record.localApproval === "once") {
    normalized.localApproval = record.localApproval;
  }
  return normalized;
}

function normalizeCommandDeclaration(value: unknown): CommandPolicyDeclaration | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sideEffects = normalizeDeclaredSideEffects(record.sideEffects);
  const argProfiles = Array.isArray(record.argProfiles)
    ? record.argProfiles.flatMap((candidate, index): CommandArgProfile[] => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const profile = candidate as Record<string, unknown>;
        const args = Array.isArray(profile.whenArgsContainAll)
          ? profile.whenArgsContainAll.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, 16)
          : [];
        const effects = normalizeDeclaredSideEffects(profile.sideEffects);
        if (args.length === 0 || !effects) return [];
        const rawId = typeof profile.id === "string" ? profile.id.trim() : "";
        return [{
          id: (rawId || `profile-${index + 1}`).slice(0, 80),
          whenArgsContainAll: args,
          sideEffects: effects,
        }];
      }).slice(0, 32)
    : undefined;
  if (!sideEffects && !argProfiles?.length) return undefined;
  return { sideEffects, argProfiles };
}

function baselineSideEffects(name: string, script: string): {
  lowRiskTier: "read" | "verify";
  hardNeedsNetwork: boolean;
  hardDestructive: boolean;
  sideEffects: CommandSideEffects;
} {
  const hardDestructive = SECRET_SCRIPT_PATTERN.test(script) || DESTRUCTIVE_SCRIPT_PATTERN.test(script);
  const hardNeedsNetwork = NETWORK_SCRIPT_PATTERN.test(script);
  const writesWorkspace = WORKSPACE_WRITE_SCRIPT_PATTERN.test(script);
  const nameTier = classifyByName(name);
  const lowRiskTier = lowRiskTierForName(name);
  const sideEffects: CommandSideEffects = {
    needsNetwork: hardNeedsNetwork || nameTier === "network",
    writesWorkspace,
    writesExternalLocalPath: false,
    launchesProcess: false,
    destructive: hardDestructive || nameTier === "destructive",
    fixedDestination: false,
    localApproval: hardNeedsNetwork || hardDestructive || nameTier === "network" || nameTier === "destructive" ? "once" : "none",
  };
  return { lowRiskTier, hardNeedsNetwork, hardDestructive, sideEffects };
}

function mergeCommandSideEffects(
  base: CommandSideEffects,
  declared: Partial<CommandSideEffects> | undefined,
  hardNeedsNetwork: boolean,
  hardDestructive: boolean,
): CommandSideEffects {
  const merged: CommandSideEffects = { ...base, ...(declared ?? {}) };
  if (hardNeedsNetwork) merged.needsNetwork = true;
  if (hardDestructive) merged.destructive = true;
  if (merged.writesExternalLocalPath && !merged.fixedDestination) merged.destructive = true;
  if (merged.needsNetwork || merged.destructive || merged.writesExternalLocalPath) {
    merged.localApproval = "once";
  }
  return merged;
}

function riskTierForSideEffects(sideEffects: CommandSideEffects, lowRiskTier: "read" | "verify"): string {
  if (sideEffects.destructive) return "destructive";
  if (sideEffects.needsNetwork) return "network";
  if (sideEffects.writesExternalLocalPath) return "local-file-mutation";
  if (sideEffects.writesWorkspace) return "write";
  return lowRiskTier;
}

function resolveDiscoveredPolicy(command: DiscoveredCommand, args: readonly string[] = []): ResolvedCommandPolicy {
  const matchingProfiles = command.argProfiles.filter((candidate) => candidate.whenArgsContainAll.every((arg) => args.includes(arg)));
  const profile = matchingProfiles.length === 1 ? matchingProfiles[0] : undefined;
  const sideEffects = mergeCommandSideEffects(
    command.sideEffects,
    profile?.sideEffects,
    command.hardNeedsNetwork,
    command.hardDestructive,
  );
  return {
    commandId: command.commandId,
    display: command.display,
    source: command.source,
    riskTier: riskTierForSideEffects(sideEffects, command.lowRiskTier),
    sideEffects,
    argProfiles: command.argProfiles,
    ...(command.source === "package.json" && command.commandId.startsWith("npm:")
      ? { argForwarding: "npm-script" as const, requiresDoubleDashForOptionArgs: true }
      : {}),
    ...(profile ? { matchedProfileId: profile.id } : {}),
  };
}

async function discoverPackageJsonCommands(root: string): Promise<DiscoveredCommand[]> {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      c2ct?: { commands?: Record<string, unknown> };
    };
    const scripts = pkg.scripts ?? {};
    return Object.entries(scripts).map(([name, script]) => {
      const baseline = baselineSideEffects(name, script);
      const declaration = normalizeCommandDeclaration(pkg.c2ct?.commands?.[name]);
      const sideEffects = mergeCommandSideEffects(
        baseline.sideEffects,
        declaration?.sideEffects,
        baseline.hardNeedsNetwork,
        baseline.hardDestructive,
      );
      return {
        commandId: `npm:${name}`,
        display: `npm run ${name}`,
        source: "package.json",
        riskTier: riskTierForSideEffects(sideEffects, baseline.lowRiskTier),
        lowRiskTier: baseline.lowRiskTier,
        hardNeedsNetwork: baseline.hardNeedsNetwork,
        hardDestructive: baseline.hardDestructive,
        sideEffects,
        argProfiles: declaration?.argProfiles ?? [],
        argv: npmRunArgv(name),
      };
    });
  } catch {
    return [];
  }
}

function npmRunArgv(name: string): string[] {
  const npm = resolveNpmInvocation();
  return npm ? [...npm.argvPrefix, "run", name] : [];
}

async function discoverMakefileCommands(root: string): Promise<DiscoveredCommand[]> {
  const makePath = join(root, "Makefile");
  if (!existsSync(makePath)) return [];
  try {
    const raw = await readFile(makePath, "utf8");
    const lines = raw.split("\n");
    const targets: DiscoveredCommand[] = [];
    const seen = new Set<string>();
    // Match top-level Makefile targets: `name:` (not indented, not a variable
    // assignment, not a special `.PHONY`-style target).
    const targetPattern = /^([A-Za-z0-9_.\-]+)\s*:(?!=)/gm;
    let match: RegExpExecArray | null;
    while ((match = targetPattern.exec(raw)) !== null) {
      const name = match[1];
      if (!name || name.startsWith(".") || seen.has(name)) continue;
      seen.add(name);
      // Package.json script discovery classifies by scanning the script
      // *body* (classifyManifestCommand), not just the script name, so a
      // secret/destructive/network recipe hiding under an innocuous script
      // name (e.g. "check") still gets a `destructive`/`network` riskTier.
      // Makefile targets previously only classified by target name
      // (classifyByName), so a target named `verify`/`test`/`check` whose
      // recipe ran `curl ... | sh` or `rm -rf /...` was tiered "verify" and
      // ran with no APPROVAL_REQUIRED gate. Collect the recipe body (the
      // tab-indented lines following the target line, skipping blank
      // lines, stopping at the first non-indented/non-blank line) and
      // classify on it exactly like package.json scripts do.
      const startLine = raw.slice(0, match.index).split("\n").length - 1;
      const recipeLines: string[] = [];
      for (let i = startLine + 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.trim().length === 0) continue;
        if (!line.startsWith("\t")) break;
        recipeLines.push(line.slice(1));
      }
      const recipeBody = recipeLines.join("\n");
      const baseline = baselineSideEffects(name, recipeBody);
      targets.push({
        commandId: `make:${name}`,
        display: `make ${name}`,
        source: "Makefile",
        riskTier: riskTierForSideEffects(baseline.sideEffects, baseline.lowRiskTier),
        lowRiskTier: baseline.lowRiskTier,
        hardNeedsNetwork: baseline.hardNeedsNetwork,
        hardDestructive: baseline.hardDestructive,
        sideEffects: baseline.sideEffects,
        argProfiles: [],
        argv: ["make", name],
      });
    }
    return targets;
  } catch {
    return [];
  }
}

async function discoverPubspecCommands(root: string): Promise<DiscoveredCommand[]> {
  const pubspecPath = join(root, "pubspec.yaml");
  if (!existsSync(pubspecPath)) return [];
  return [
    {
      commandId: "flutter:test",
      display: "flutter test",
      source: "pubspec.yaml",
      riskTier: "verify",
      lowRiskTier: "verify",
      hardNeedsNetwork: false,
      hardDestructive: false,
      sideEffects: {
        needsNetwork: false,
        writesWorkspace: false,
        writesExternalLocalPath: false,
        launchesProcess: false,
        destructive: false,
        fixedDestination: false,
        localApproval: "none",
      },
      argProfiles: [],
      argv: ["flutter", "test"],
    },
    {
      commandId: "flutter:analyze",
      display: "flutter analyze",
      source: "pubspec.yaml",
      riskTier: "verify",
      lowRiskTier: "verify",
      hardNeedsNetwork: false,
      hardDestructive: false,
      sideEffects: {
        needsNetwork: false,
        writesWorkspace: false,
        writesExternalLocalPath: false,
        launchesProcess: false,
        destructive: false,
        fixedDestination: false,
        localApproval: "none",
      },
      argProfiles: [],
      argv: ["flutter", "analyze"],
    },
  ];
}

async function discoverAllCommands(root: string): Promise<DiscoveredCommand[]> {
  const [pkg, make, pubspec] = await Promise.all([
    discoverPackageJsonCommands(root),
    discoverMakefileCommands(root),
    discoverPubspecCommands(root),
  ]);
  return [...pkg, ...make, ...pubspec];
}

/**
 * Detect safe, allowlist-eligible commands from project manifests
 * (package.json scripts, Makefile, pubspec.yaml, etc.) (PRD §8.5 command_list).
 */
export interface ListedCommand {
  commandId: string;
  display: string;
  source: string;
  riskTier: string;
  sideEffects: CommandSideEffects;
  argProfiles: CommandArgProfile[];
  argForwarding?: "npm-script";
  requiresDoubleDashForOptionArgs?: boolean;
}

export async function listCommands(root: string): Promise<ListedCommand[]> {
  const commands = await discoverAllCommands(root);
  return commands.map((command) => resolveDiscoveredPolicy(command));
}

export async function resolveCommandPolicy(
  root: string,
  commandId: string,
  args: readonly string[] = [],
): Promise<ResolvedCommandPolicy | null> {
  const commands = await discoverAllCommands(root);
  const command = commands.find((candidate) => candidate.commandId === commandId);
  return command ? resolveDiscoveredPolicy(command, args) : null;
}

export function commandCatalogVersion(commands: readonly ListedCommand[]): string {
  const canonical = [...commands]
    .sort((left, right) => left.commandId.localeCompare(right.commandId))
    .map((command) => ({
      commandId: command.commandId,
      display: command.display,
      source: command.source,
      riskTier: command.riskTier,
      sideEffects: command.sideEffects,
      argProfiles: command.argProfiles,
      argForwarding: command.argForwarding ?? null,
      requiresDoubleDashForOptionArgs: command.requiresDoubleDashForOptionArgs ?? null,
    }));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 24)}`;
}

function buildChildEnv(): NodeJS.ProcessEnv {
  return buildSafeChildEnv();
}

function quoteCmdArg(value: string): string {
  if (!/[\s"&|<>^%]/.test(value)) return value;
  return '"' + value.replace(/(["&|<>^])/g, "^$1").replace(/%/g, "%%") + '"';
}

function buildSpawnInvocation(cmd: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32" && /\.cmd$/i.test(cmd)) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    const commandLine = [cmd, ...args].map(quoteCmdArg).join(" ");
    return {
      file: comspec,
      // cmd.exe /s /c has special handling when the command itself starts with
      // a quoted path. Wrap the entire command line so a path such as
      // C:\Program Files\nodejs\npm.cmd keeps its opening/closing quotes instead
      // of being parsed as literal filename characters.
      args: ["/d", "/s", "/c", `"${commandLine}"`],
    };
  }
  return { file: cmd, args };
}

export function killProcessTree(
  pid: number | undefined,
  done: (cleanupStatus: CleanupStatus) => void,
): void {
  if (!pid) {
    done("FAILED");
    return;
  }
  if (process.platform === "win32") {
    // execution-capability: windows-process-tree-cleanup
    execFile(
      "taskkill.exe",
      ["/pid", String(pid), "/t", "/f"],
      { windowsHide: true },
      (error) => done(error ? "FAILED" : "COMPLETED"),
    );
    return;
  }
  try {
    // Children are spawned in a dedicated Unix process group (`detached`
    // below), so a timeout also terminates descendants created by npm/make.
    process.kill(-pid, "SIGKILL");
    done("COMPLETED");
    return;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      done("COMPLETED");
      return;
    } catch {
      // The process may already have exited.
    }
  }
  done("FAILED");
}

/**
 * Run an allowlisted command by id (never an arbitrary shell string) with a
 * hard timeout and output truncation (PRD §8.5 command_run, §9.5 Two-key).
 *
 * @throws {DomainError} COMMAND_NOT_ALLOWED, ARBITRARY_SHELL_DENIED,
 *   APPROVAL_REQUIRED, TIMEOUT
 */
export async function runCommand(
  root: string,
  commandId: string,
  args?: string[],
  timeoutSec?: number,
  approval?: { granted: boolean },
  lifecycleObserver?: CommandLifecycleObserver,
  options: RunCommandOptions = {},
): Promise<ProcessExecutionResult> {
  const discovered = await discoverAllCommands(root);
  const found = discovered.find((c) => c.commandId === commandId);
  if (!found) {
    // Any commandId not produced by discovery is treated as an arbitrary
    // shell invocation attempt and denied outright — never shell-executed.
    throw new DomainError(
      ErrorCode.ARBITRARY_SHELL_DENIED,
      `commandId "${commandId}" is not an allowlisted discovered command`,
      { commandId },
    );
  }

  const resolvedPolicy = resolveDiscoveredPolicy(found, args ?? []);

  if (resolvedPolicy.sideEffects.localApproval !== "none" && !approval?.granted) {
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      `command "${commandId}" requires explicit human approval (riskTier=${resolvedPolicy.riskTier})`,
      { commandId, riskTier: resolvedPolicy.riskTier, sideEffects: resolvedPolicy.sideEffects },
    );
  }

  const requestedTimeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const effectiveTimeoutSec = Math.min(Math.max(requestedTimeout, 1), MAX_TIMEOUT_SEC);

  const [cmd, ...baseArgs] = found.argv;
  if (!cmd) {
    const missingBinary = commandId.startsWith("npm:") ? "npm" : "command runtime";
    throw new DomainError(
      ErrorCode.COMMAND_NOT_ALLOWED,
      `commandId "${commandId}" cannot run because ${missingBinary} is unavailable in the verified runtime`,
      {
        commandId,
        missingBinary,
        alternatives: ["command_list", "local_shell_run"],
      },
    );
  }
  const extraArgs = args ?? [];
  const fullArgs = [...baseArgs, ...extraArgs];
  const invocation = buildSpawnInvocation(cmd, fullArgs);

  const start = Date.now();

  if (options.signal?.aborted) {
    return {
      commandStatus: "CANCELLED",
      exitCode: null,
      terminationSignal: null,
      cleanupStatus: "NOT_REQUIRED",
      stdoutSummary: "",
      stderrSummary: "",
      durationMs: 0,
      outputTruncated: false,
      ...(options.captureOutput
        ? {
            capturedOutput: {
              stdout: "",
              stderr: "",
              stdoutBytes: 0,
              stderrBytes: 0,
              artifactTruncated: false,
            },
          }
        : {}),
    };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let forcedStop: "timeout" | "cancel" | undefined;
    let cleanupRequested = false;
    let spawnFailed = false;
    let subprocessStarted = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timeoutRemainingMs = effectiveTimeoutSec * 1000;
    let timeoutRunningSince = Date.now();
    let timeoutPausedUntil: number | undefined;
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
      const artifactStd = stdoutArtifact.summarize();
      const artifactErr = stderrArtifact.summarize();
      return {
        stdout: artifactStd.text,
        stderr: artifactErr.text,
        stdoutBytes: artifactStd.totalBytes,
        stderrBytes: artifactErr.totalBytes,
        artifactTruncated: artifactStd.truncated || artifactErr.truncated,
      };
    };

    // execution-capability: allowlisted-project-command
    const child = spawn(
      invocation.file,
      invocation.args,
      {
        cwd: root,
        env: buildChildEnv(),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.once("spawn", () => {
      subprocessStarted = true;
      emitCommandLifecycle(lifecycleObserver, {
        phase: "running",
        subprocessStarted: true,
        subprocessStillRunning: true,
        cleanupStarted: false,
        cleanupCompleted: false,
      });
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      stdoutArtifact.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      stderrArtifact.append(chunk);
    });
    child.on("error", (error) => {
      // Match execFile's previous contract: launch failures resolve with a
      // non-zero exit rather than escaping as an unclassified exception.
      spawnFailed = true;
      stderr.append(Buffer.from(error instanceof Error ? error.message : String(error)));
    });
    child.on("close", (code, signal) => {
      if (forcedStop) return;
      const outStd = stdout.summarize();
      const outErr = stderr.summarize();
      const outputTruncated = outStd.truncated || outErr.truncated;
      const exitCode = spawnFailed ? null : (code ?? 1);
      const commandStatus = commandStatusFromExit(exitCode, spawnFailed);
      emitCommandLifecycle(lifecycleObserver, {
        phase: "completed",
        subprocessStarted,
        subprocessStillRunning: false,
        cleanupStarted: false,
        cleanupCompleted: true,
        durationMs: Date.now() - start,
        commandStatus,
        cleanupStatus: "NOT_REQUIRED",
      });
      finish(() =>
        resolve({
          commandStatus,
          exitCode,
          terminationSignal: signal,
          cleanupStatus: "NOT_REQUIRED",
          stdoutSummary: outStd.text,
          stderrSummary: outErr.text,
          durationMs: Date.now() - start,
          outputTruncated,
          ...(outputTruncated || options.captureOutput ? { capturedOutput: capturedOutput() } : {}),
        }),
      );
    });

    const requestCleanup = (reason: "timeout" | "cancel") => {
      if (settled || cleanupRequested) return;
      cleanupRequested = true;
      forcedStop = reason;
      emitCommandLifecycle(lifecycleObserver, {
        phase: "cleanup",
        subprocessStarted,
        subprocessStillRunning: subprocessStarted,
        cleanupStarted: true,
        cleanupCompleted: false,
      });
      killProcessTree(child.pid, (cleanupStatus) => {
        const outStd = stdout.summarize();
        const outErr = stderr.summarize();
        const outputTruncated = outStd.truncated || outErr.truncated;
        const commandStatus = reason === "timeout" ? "TIMEOUT" : "CANCELLED";
        emitCommandLifecycle(lifecycleObserver, {
          phase: "completed",
          subprocessStarted,
          subprocessStillRunning: false,
          cleanupStarted: true,
          cleanupCompleted: cleanupStatus === "COMPLETED",
          durationMs: Date.now() - start,
          commandStatus,
          cleanupStatus,
        });
        finish(() => resolve({
          commandStatus,
          exitCode: null,
          terminationSignal: process.platform === "win32" ? null : "SIGKILL",
          cleanupStatus,
          stdoutSummary: outStd.text,
          stderrSummary: outErr.text,
          durationMs: Date.now() - start,
          outputTruncated,
          ...(outputTruncated || options.captureOutput ? { capturedOutput: capturedOutput() } : {}),
        }));
      });
    };

    const armTimeoutBudget = () => {
      if (settled || cleanupRequested) return;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutPausedUntil = undefined;
      if (timeoutRemainingMs <= 0) {
        requestCleanup("timeout");
        return;
      }
      timeoutRunningSince = Date.now();
      timeoutHandle = setTimeout(() => {
        timeoutRemainingMs = 0;
        requestCleanup("timeout");
      }, timeoutRemainingMs);
    };

    const timeoutControl: CommandTimeoutControl = {
      pauseUntil(untilMs) {
        const now = Date.now();
        if (settled || cleanupRequested || !Number.isFinite(untilMs) || untilMs <= now) return;
        if (timeoutPausedUntil === undefined) {
          timeoutRemainingMs = Math.max(0, timeoutRemainingMs - (now - timeoutRunningSince));
        }
        timeoutPausedUntil = Math.max(timeoutPausedUntil ?? 0, Math.floor(untilMs));
        if (timeoutHandle) clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(() => armTimeoutBudget(), Math.max(1, timeoutPausedUntil - now));
      },
    };

    const abortListener = () => requestCleanup("cancel");
    options.signal?.addEventListener("abort", abortListener, { once: true });
    armTimeoutBudget();
    options.onTimeoutControl?.(timeoutControl);
    if (options.signal?.aborted) abortListener();
  });
}
