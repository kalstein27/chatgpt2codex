import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";
import { isSecretPath, redact } from "../policy/secrets.js";

// execution-capability: git-readonly-argv
const execFileAsync = promisify(execFile);

/** Options threaded to execFile for every git invocation in this module. */
const EXEC_OPTS = {
  // Never shell:true — args are passed as an argv array, not interpolated.
  windowsHide: true,
  maxBuffer: 10 * 1024 * 1024,
} as const;

/**
 * Run `git <args>` in `cwd` via execFile (array argv, never shell:true).
 * Returns stdout on success. Callers decide how to interpret failures.
 */
async function runGit(
  cwd: string,
  args: string[],
  gitExecutable = "git",
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(gitExecutable, args, { ...EXEC_OPTS, cwd });
}

/** True if `err` looks like "not a git repository" / git missing, vs a real failure. */
function isNonGitError(err: unknown): boolean {
  const e = err as { code?: string; stderr?: string; message?: string } | undefined;
  if (!e) return false;
  if (e.code === "ENOENT") return true; // git binary not found
  const text = `${e.stderr ?? ""} ${e.message ?? ""}`.toLowerCase();
  return (
    text.includes("not a git repository") ||
    text.includes("not a git repo") ||
    text.includes("no such file or directory")
  );
}

function isGitUnavailableError(err: unknown): boolean {
  return (err as { code?: unknown } | undefined)?.code === "ENOENT";
}

function isNotRepositoryError(err: unknown): boolean {
  const e = err as { stderr?: string; message?: string } | undefined;
  const text = `${e?.stderr ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return text.includes("not a git repository") || text.includes("not a git repo");
}

function statusErrorMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string } | undefined;
  const message = (e?.stderr?.trim() || e?.message || String(err)).replace(/\s+/g, " ");
  return redact(message).slice(0, 1_000);
}

export type GitHeadState = "branch" | "detached" | "unborn" | "unavailable";

export interface GitStatus {
  /** Compatibility field. Empty for detached/unavailable, branch name otherwise. */
  branch: string;
  isGitRepository: boolean;
  headState: GitHeadState;
  branchName: string | null;
  headCommit: string | null;
  statusError: string | null;
  dirtyFiles: string[];
  staged: string[];
}

export interface GitReadOptions {
  /** Test/embedded override. Public tools always use the default verified PATH lookup. */
  gitExecutable?: string;
}

function unavailableStatus(statusError: string, isGitRepository = false): GitStatus {
  return {
    branch: "",
    isGitRepository,
    headState: "unavailable",
    branchName: null,
    headCommit: null,
    statusError,
    dirtyFiles: [],
    staged: [],
  };
}

/** Git status summary for a project (PRD §8.6 git_status). */
export async function gitStatus(
  root: string,
  options: GitReadOptions = {},
): Promise<GitStatus> {
  const gitExecutable = options.gitExecutable ?? "git";
  try {
    const repository = await runGit(root, ["rev-parse", "--is-inside-work-tree"], gitExecutable);
    if (repository.stdout.trim() !== "true") {
      return unavailableStatus("not a Git work tree");
    }

    let branchName: string | null = null;
    try {
      const symbolic = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], gitExecutable);
      branchName = symbolic.stdout.trim() || null;
    } catch {
      // Detached HEAD intentionally has no symbolic branch. Unborn branches
      // still return their symbolic name, so no error inference is required.
    }

    let headCommit: string | null = null;
    try {
      const commit = await runGit(root, ["rev-parse", "--verify", "HEAD"], gitExecutable);
      headCommit = commit.stdout.trim() || null;
    } catch {
      // A valid symbolic branch with no commit is an unborn repository.
    }

    const headState: GitHeadState = headCommit
      ? (branchName ? "branch" : "detached")
      : (branchName ? "unborn" : "unavailable");
    const branch = branchName ?? "";

    let statusResult: { stdout: string; stderr: string };
    try {
      statusResult = await runGit(root, ["status", "--porcelain=v1"], gitExecutable);
    } catch (err) {
      return {
        branch,
        isGitRepository: true,
        headState,
        branchName,
        headCommit,
        statusError: statusErrorMessage(err),
        dirtyFiles: [],
        staged: [],
      };
    }
    const dirtyFiles: string[] = [];
    const staged: string[] = [];

    for (const rawLine of statusResult.stdout.split("\n")) {
      if (rawLine.length === 0) continue;
      // Porcelain v1 format: XY PATH  (XY = 2 status chars, then space, then path)
      // For renames the path is "old -> new"; take the destination path.
      const indexStatus = rawLine[0] ?? " ";
      const worktreeStatus = rawLine[1] ?? " ";
      let path = rawLine.slice(3);
      const arrow = path.indexOf(" -> ");
      if (arrow !== -1) {
        path = path.slice(arrow + 4);
      }

      if (indexStatus === "?" && worktreeStatus === "?") {
        // Untracked file: counts as dirty, not staged.
        dirtyFiles.push(path);
        continue;
      }
      if (indexStatus !== " " && indexStatus !== "?") {
        staged.push(path);
      }
      if (worktreeStatus !== " " && worktreeStatus !== "?") {
        dirtyFiles.push(path);
      }
    }

    return {
      branch,
      isGitRepository: true,
      headState,
      branchName,
      headCommit,
      statusError: headState === "unavailable" ? "Git HEAD state could not be resolved" : null,
      dirtyFiles,
      staged,
    };
  } catch (err) {
    if (isGitUnavailableError(err)) return unavailableStatus("git executable unavailable");
    if (isNotRepositoryError(err)) return unavailableStatus("not a git repository");
    return unavailableStatus(`git status unavailable: ${statusErrorMessage(err)}`);
  }
}

export interface GitRepositoryStatus {
  branch: string;
  isGitRepository: boolean;
  headState: GitHeadState;
  branchName: string | null;
  headCommit: string | null;
  statusError: string | null;
  dirtyFiles: string[];
  staged: string[];
  remotes: Array<{ name: string; url: string }>;
  upstream: string | null;
  ahead: number;
  behind: number;
  syncState: "unknown" | "up-to-date" | "ahead" | "behind" | "diverged";
}

/** Read-only repository state plus already-known upstream relation; never fetches. */
export async function gitRepositoryStatus(
  root: string,
  options: GitReadOptions = {},
): Promise<GitRepositoryStatus> {
  const status = await gitStatus(root, options);
  if (!status.isGitRepository) {
    return {
      ...status,
      remotes: [],
      upstream: null,
      ahead: 0,
      behind: 0,
      syncState: "unknown",
    };
  }
  const gitExecutable = options.gitExecutable ?? "git";
  const [remotes, upstream, counts] = await Promise.all([
    listGitRemotes(root, gitExecutable),
    readGitUpstream(root, gitExecutable),
    readGitAheadBehind(root, gitExecutable),
  ]);
  return {
    ...status,
    remotes,
    upstream,
    ahead: counts.ahead,
    behind: counts.behind,
    syncState: syncState(upstream, counts.ahead, counts.behind),
  };
}

async function listGitRemotes(root: string, gitExecutable = "git"): Promise<Array<{ name: string; url: string }>> {
  try {
    const result = await runGit(root, ["remote", "-v"], gitExecutable);
    const remotes = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match || match[3] !== "fetch") continue;
      remotes.set(match[1] ?? "", redact(match[2] ?? ""));
    }
    return Array.from(remotes, ([name, url]) => ({ name, url })).filter((remote) => remote.name.length > 0);
  } catch (err) {
    if (isNonGitError(err)) return [];
    return [];
  }
}

async function readGitUpstream(root: string, gitExecutable = "git"): Promise<string | null> {
  try {
    const result = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], gitExecutable);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readGitAheadBehind(root: string, gitExecutable = "git"): Promise<{ ahead: number; behind: number }> {
  try {
    const result = await runGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], gitExecutable);
    const [aheadRaw, behindRaw] = result.stdout.trim().split(/\s+/);
    return {
      ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
      behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

function syncState(
  upstream: string | null,
  ahead: number,
  behind: number,
): GitRepositoryStatus["syncState"] {
  if (!upstream) return "unknown";
  if (ahead > 0 && behind > 0) return "diverged";
  if (ahead > 0) return "ahead";
  if (behind > 0) return "behind";
  return "up-to-date";
}

/**
 * Git diff summary with secret redaction applied (PRD §8.6
 * git_diff_summary, §9.4 outputGuard).
 */
export async function gitDiffSummary(
  root: string,
): Promise<{
  status: "OK" | "NOT_A_GIT_REPOSITORY";
  isGitRepository: boolean;
  files: { path: string; added: number; removed: number }[];
  summary: string;
}> {
  let files: { path: string; added: number; removed: number }[];
  try {
    const result = await runGit(root, ["diff", "--numstat"]);
    files = parseNumstat(result.stdout);
  } catch (err) {
    if (isNonGitError(err)) {
      return {
        status: "NOT_A_GIT_REPOSITORY",
        isGitRepository: false,
        files: [],
        summary: "Git diff unavailable: project is not a git repository.",
      };
    }
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `gitDiffSummary failed: ${(err as Error).message ?? String(err)}`,
    );
  }
  const summary = redact(buildSummary(files));
  return { status: "OK", isGitRepository: true, files, summary };
}

export async function gitStageAndCommit(
  root: string,
  message: string,
  paths?: string[],
): Promise<{ commit: string; branch: string; stagedFiles: string[]; stdout: string; stderr: string }> {
  const addArgs = paths && paths.length > 0 ? ["add", "--", ...paths] : ["add", "-A"];
  await runGit(root, addArgs);

  const stagedResult = await runGit(root, ["diff", "--cached", "--name-only"]);
  const stagedFiles = stagedResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const secretFiles = stagedFiles.filter((file) => isSecretPath(path.resolve(root, file)));
  if (secretFiles.length > 0) {
    await runGit(root, ["reset", "--", ...secretFiles]).catch(() => ({ stdout: "", stderr: "" }));
    throw new DomainError(ErrorCode.SECRET_BLOCKED, "Refusing to commit secret-classified paths", {
      paths: secretFiles,
    });
  }

  if (stagedFiles.length === 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No staged changes to commit");
  }

  const commitResult = await runGit(root, ["commit", "-m", message]);
  const head = await runGit(root, ["rev-parse", "--short", "HEAD"]);
  const branch = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    commit: head.stdout.trim(),
    branch: branch.stdout.trim(),
    stagedFiles,
    stdout: redact(commitResult.stdout),
    stderr: redact(commitResult.stderr),
  };
}

export async function gitPush(
  root: string,
  remote = "origin",
  branch?: string,
): Promise<{ remote: string; branch: string; stdout: string; stderr: string }> {
  const targetBranch = branch || (await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const result = await runGit(root, ["push", "-u", remote, targetBranch]);
  return {
    remote,
    branch: targetBranch,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  };
}

/**
 * Parse `git diff --numstat` output into structured file entries.
 * Format per line: "<added>\t<removed>\t<path>" (binary files use "-\t-\tpath").
 * Exported for testing.
 */
export function parseNumstat(
  numstat: string,
): { path: string; added: number; removed: number }[] {
  const files: { path: string; added: number; removed: number }[] = [];
  for (const rawLine of numstat.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const addedRaw = parts[0] ?? "0";
    const removedRaw = parts[1] ?? "0";
    // path may contain tabs in exotic cases; rejoin remainder defensively.
    let path = parts.slice(2).join("\t");
    const arrow = path.indexOf(" => ");
    if (arrow !== -1) {
      // Rename/copy with common-prefix compression, e.g. "src/{old => new}.ts"
      // or plain "old => new". Prefer the destination side.
      path = resolveRenamePath(path);
    }
    const added = addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10) || 0;
    const removed = removedRaw === "-" ? 0 : Number.parseInt(removedRaw, 10) || 0;
    files.push({ path, added, removed });
  }
  return files;
}

/** Resolve a numstat rename path like "a/{b => c}/d" or "a/b => a/c" to the destination. */
function resolveRenamePath(path: string): string {
  const braceMatch = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, , to, suffix] = braceMatch;
    return `${prefix ?? ""}${to ?? ""}${suffix ?? ""}`;
  }
  const plainArrow = path.split(" => ");
  if (plainArrow.length === 2) {
    return plainArrow[1] ?? path;
  }
  return path;
}

/** Build a short human-readable diff summary line, pre-redaction. */
function buildSummary(
  files: { path: string; added: number; removed: number }[],
): string {
  if (files.length === 0) return "No changes.";
  const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.removed, 0);
  const fileList = files
    .map((f) => `${f.path} (+${f.added}/-${f.removed})`)
    .join(", ");
  return `${files.length} file(s) changed, +${totalAdded}/-${totalRemoved}: ${fileList}`;
}
