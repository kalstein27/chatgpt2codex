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
  argv: string[];
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
const DESTRUCTIVE_NAME_PATTERN = /(deploy|release|publish|destroy|clean|reset)/i;
const NETWORK_NAME_PATTERN = /(install|deps|dependencies|fetch|pull)/i;

const SECRET_SCRIPT_PATTERN =
  /(^|[\s/"'])\.(env|ssh|npmrc)([\s/"'.]|$)|id_rsa|id_ed25519|private[_-]?key|security\s+find-(generic|internet)-password|keychain/i;
// `rm -rf`/`rm -fr` in either flag order, with or without a trailing slash
// on the target (the previous pattern required a literal `/` after the
// flags, so `rm -rf *`/`rm -rf .`/`rm -rf $DIR` all slipped past it into a
// non-destructive riskTier). Also cover `find -delete` and `git clean`.
const DESTRUCTIVE_SCRIPT_PATTERN =
  /\bsudo\b|\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b|\bfind\b[^\n]*-delete\b|\bgit\s+clean\b|\bdiskutil\s+erase|\bmkfs\b|\bshutdown\b|\breboot\b/i;
const NETWORK_SCRIPT_PATTERN = /\b(npm|pnpm|yarn|bun)\s+(install|add|update)|\b(curl|wget)\b|\bgit\s+(pull|fetch|clone|push)\b/i;

function classifyByName(name: string): string {
  if (DESTRUCTIVE_NAME_PATTERN.test(name)) return "destructive";
  if (NETWORK_NAME_PATTERN.test(name)) return "network";
  if (VERIFY_NAME_PATTERN.test(name)) return "verify";
  if (BUILD_NAME_PATTERN.test(name)) return "verify";
  return "read";
}

function classifyManifestCommand(name: string, script: string): string {
  if (SECRET_SCRIPT_PATTERN.test(script) || DESTRUCTIVE_SCRIPT_PATTERN.test(script)) return "destructive";
  if (NETWORK_SCRIPT_PATTERN.test(script)) return "network";
  return classifyByName(name);
}

async function discoverPackageJsonCommands(root: string): Promise<DiscoveredCommand[]> {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    return Object.entries(scripts).map(([name, script]) => ({
      commandId: `npm:${name}`,
      display: `npm run ${name}`,
      source: "package.json",
      riskTier: classifyManifestCommand(name, script),
      argv: npmRunArgv(name),
    }));
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
      targets.push({
        commandId: `make:${name}`,
        display: `make ${name}`,
        source: "Makefile",
        riskTier: classifyManifestCommand(name, recipeBody),
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
      argv: ["flutter", "test"],
    },
    {
      commandId: "flutter:analyze",
      display: "flutter analyze",
      source: "pubspec.yaml",
      riskTier: "verify",
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
  argForwarding?: "npm-script";
  requiresDoubleDashForOptionArgs?: boolean;
}

export async function listCommands(root: string): Promise<ListedCommand[]> {
  const commands = await discoverAllCommands(root);
  return commands.map(({ commandId, display, source, riskTier }) => {
    const npmScript = source === "package.json" && commandId.startsWith("npm:");
    return {
      commandId,
      display,
      source,
      riskTier,
      ...(npmScript
        ? {
            argForwarding: "npm-script" as const,
            requiresDoubleDashForOptionArgs: true,
          }
        : {}),
    };
  });
}

export function commandCatalogVersion(commands: readonly ListedCommand[]): string {
  const canonical = [...commands]
    .sort((left, right) => left.commandId.localeCompare(right.commandId))
    .map((command) => ({
      commandId: command.commandId,
      display: command.display,
      source: command.source,
      riskTier: command.riskTier,
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
    return {
      file: comspec,
      args: ["/d", "/s", "/c", [cmd, ...args].map(quoteCmdArg).join(" ")],
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

  if ((found.riskTier === "destructive" || found.riskTier === "network") && !approval?.granted) {
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      `command "${commandId}" requires explicit human approval (riskTier=${found.riskTier})`,
      { commandId, riskTier: found.riskTier },
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

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
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
      fn();
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
      if (timedOut) return;
      const outStd = stdout.summarize();
      const outErr = stderr.summarize();
      const artifactStd = stdoutArtifact.summarize();
      const artifactErr = stderrArtifact.summarize();
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
          ...(outputTruncated
            ? {
                capturedOutput: {
                  stdout: artifactStd.text,
                  stderr: artifactErr.text,
                  stdoutBytes: artifactStd.totalBytes,
                  stderrBytes: artifactErr.totalBytes,
                  artifactTruncated: artifactStd.truncated || artifactErr.truncated,
                },
              }
            : {}),
        }),
      );
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
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
        const artifactStd = stdoutArtifact.summarize();
        const artifactErr = stderrArtifact.summarize();
        const outputTruncated = outStd.truncated || outErr.truncated;
        emitCommandLifecycle(lifecycleObserver, {
          phase: "completed",
          subprocessStarted,
          subprocessStillRunning: false,
          cleanupStarted: true,
          cleanupCompleted: cleanupStatus === "COMPLETED",
          durationMs: Date.now() - start,
          commandStatus: "TIMEOUT",
          cleanupStatus,
        });
        finish(() => resolve({
          commandStatus: "TIMEOUT",
          exitCode: null,
          terminationSignal: process.platform === "win32" ? null : "SIGKILL",
          cleanupStatus,
          stdoutSummary: outStd.text,
          stderrSummary: outErr.text,
          durationMs: Date.now() - start,
          outputTruncated,
          ...(outputTruncated
            ? {
                capturedOutput: {
                  stdout: artifactStd.text,
                  stderr: artifactErr.text,
                  stdoutBytes: artifactStd.totalBytes,
                  stderrBytes: artifactErr.totalBytes,
                  artifactTruncated: artifactStd.truncated || artifactErr.truncated,
                },
              }
            : {}),
        }));
      });
    }, effectiveTimeoutSec * 1000);
  });
}
