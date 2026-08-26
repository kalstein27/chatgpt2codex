import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import { resolveInProject } from "../policy/paths.js";
import { BoundedOutputCollector } from "./bounded-output.js";
import { OUTPUT_ARTIFACT_STREAM_BYTES } from "./output-artifacts.js";
import { buildSafeChildEnv, killProcessTree } from "./command-runner.js";
import { detectCommandNotFound, type CommandNotFoundHint } from "./runtime-environment.js";
import { commandStatusFromExit, type ProcessExecutionResult } from "./process-result.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 900;
const OUTPUT_HEAD_BYTES = 12_000;
const OUTPUT_TAIL_BYTES = 6_000;

const SECRET_COMMAND_PATTERNS = [
  /(^|[\s/"'])\.env([\s/"'.]|$)/i,
  /(^|[\s/"'])\.ssh([\s/"']|$)/i,
  /(^|[\s/"'])\.npmrc([\s/"']|$)/i,
  /id_rsa|id_ed25519|private[_-]?key/i,
  /security\s+find-(generic|internet)-password/i,
  /keychain/i,
  /(^|[\s/"'])\.netrc([\s/"'.]|$)/i,
  /(^|[\s/"'])\.git-credentials([\s/"']|$)/i,
  /(^|[\s/"'])\.aws([\s/"']|$)/i,
  /(^|[\s/"'])\.gnupg([\s/"']|$)/i,
  /(^|[\s/"'])\.docker([\s/"']|$)/i,
  /(^|[\s/"'])\.kube([\s/"']|$)/i,
  /(^|[\s/"'])\.config[/\\]gcloud([\s/"']|$)/i,
  /(^|[\s/"'])credentials([\s/"'.]|$)/i,
];

const OS_DESTRUCTIVE_PATTERNS = [
  /\bsudo\b/i,
  // `rm -rf` / `rm -fr` in either flag order, with or without a trailing
  // slash on the target — the previous pattern required a literal `/`
  // after the flags, so `rm -rf *`, `rm -rf .`, and `rm -rf $DIR` (no
  // trailing slash) all slipped through.
  /\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b/i,
  /\bfind\b[^\n]*-delete\b/i,
  /\bgit\s+clean\b/i,
  // Redirecting into a block/char device (disk overwrite risk) — but not
  // `> /dev/null`, which is a common, harmless "discard output" idiom.
  />\s*\/dev\/(?!null\b)\S+/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\bdiskutil\s+erase/i,
  /\bmkfs\b/i,
  /\bshutdown\b|\breboot\b/i,
];

const NETWORK_COMMAND_PATTERNS = [
  /\b(curl|wget|nc|ncat|netcat|telnet|scp|sftp|ftp|ssh)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|update)\b/i,
  /\bgit\s+(pull|fetch|clone|push)\b/i,
];

export type ApprovedShellRisk = "network" | "destructive";

export function guardShellCommand(command: string, approvedRisk?: ApprovedShellRisk): void {
  for (const pattern of SECRET_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      throw new DomainError(
        ErrorCode.SECRET_BLOCKED,
        "local_shell_run blocked a command that appears to read secret-classified material",
      );
    }
  }
  for (const pattern of OS_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      if (approvedRisk === "destructive") continue;
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        "local_shell_run blocked an OS-level destructive command",
      );
    }
  }
  for (const pattern of NETWORK_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      if (approvedRisk === "network") continue;
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        "local_shell_run blocked a network/egress command that requires explicit approval",
      );
    }
  }
}

export async function runLocalShell(
  root: string,
  command: string,
  cwd?: string,
  timeoutSec?: number,
  approvedRisk?: ApprovedShellRisk,
): Promise<ProcessExecutionResult & {
  cwd: string;
  commandNotFound?: CommandNotFoundHint;
}> {
  guardShellCommand(command, approvedRisk);
  const baseRoot = await fs.realpath(root);
  const commandCwd = cwd
    ? await resolveInProject(baseRoot, cwd, { allowSymlink: false })
    : baseRoot;
  const stat = await fs.stat(commandCwd).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "cwd is not a project directory", {
      cwd,
    });
  }

  const requestedTimeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const effectiveTimeoutSec = Math.min(Math.max(requestedTimeout, 1), MAX_TIMEOUT_SEC);
  const start = Date.now();

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let spawnFailed = false;
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

    // execution-capability: guarded-project-shell
    const child = spawn(command, {
      cwd: commandCwd,
      env: buildSafeChildEnv(),
      detached: process.platform !== "win32",
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
      const commandNotFound = exitCode === null
        ? undefined
        : detectCommandNotFound(exitCode, outStd.text, outErr.text);
      finish(() =>
        resolve({
          cwd: path.relative(baseRoot, commandCwd) || ".",
          commandStatus: commandStatusFromExit(exitCode, spawnFailed),
          exitCode,
          terminationSignal: signal,
          cleanupStatus: "NOT_REQUIRED",
          stdoutSummary: redact(outStd.text),
          stderrSummary: redact(outErr.text),
          durationMs: Date.now() - start,
          outputTruncated,
          ...(commandNotFound ? { commandNotFound } : {}),
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
      killProcessTree(child.pid, (cleanupStatus) => {
        const outStd = stdout.summarize();
        const outErr = stderr.summarize();
        const artifactStd = stdoutArtifact.summarize();
        const artifactErr = stderrArtifact.summarize();
        const outputTruncated = outStd.truncated || outErr.truncated;
        finish(() => resolve({
          cwd: path.relative(baseRoot, commandCwd) || ".",
          commandStatus: "TIMEOUT",
          exitCode: null,
          terminationSignal: process.platform === "win32" ? null : "SIGKILL",
          cleanupStatus,
          stdoutSummary: redact(outStd.text),
          stderrSummary: redact(outErr.text),
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
