import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";

// execution-capability: checkpoint-git-operations
const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export interface CheckpointRecord {
  checkpointId: string;
  projectId: string;
  createdAt: number;
  reason: string;
  diff: string;
}

function checkpointDir(root: string): string {
  return path.join(root, ".chatgpt2codex", "checkpoints");
}

function checkpointPath(root: string, checkpointId: string): string {
  if (!/^cp_[A-Za-z0-9_.-]+$/.test(checkpointId)) {
    throw new DomainError(ErrorCode.CHECKPOINT_NOT_FOUND, "Invalid checkpoint id", { checkpointId });
  }
  return path.join(checkpointDir(root), `${checkpointId}.json`);
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd: root, windowsHide: true, maxBuffer: MAX_DIFF_BYTES });
}

export async function getWorkingDiff(root: string): Promise<string> {
  try {
    const result = await git(root, ["diff", "--binary"]);
    return redact(result.stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not a git repository") || msg.includes("not a git repository") || msg.includes("unknown revision") || msg.includes("ambiguous argument")) {
      return "";
    }
    throw err;
  }
}

export async function createCheckpoint(root: string, projectId: string, reason: string): Promise<CheckpointRecord> {
  await mkdir(checkpointDir(root), { recursive: true, mode: 0o700 });
  const checkpointId = `cp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const record: CheckpointRecord = {
    checkpointId,
    projectId,
    createdAt: Date.now(),
    reason,
    diff: await getWorkingDiff(root),
  };
  await writeFile(checkpointPath(root, checkpointId), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

export async function listCheckpoints(root: string, projectId: string): Promise<Omit<CheckpointRecord, "diff">[]> {
  let names: string[] = [];
  try { names = await readdir(checkpointDir(root)); } catch { return []; }
  const out: Omit<CheckpointRecord, "diff">[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort().reverse().slice(0, 50)) {
    try {
      const raw = await readFile(path.join(checkpointDir(root), name), "utf8");
      const rec = JSON.parse(raw) as CheckpointRecord;
      if (rec.projectId === projectId) {
        const { diff: _diff, ...meta } = rec;
        out.push(meta);
      }
    } catch { /* skip corrupt checkpoint */ }
  }
  return out;
}

export async function readCheckpoint(root: string, checkpointId: string): Promise<CheckpointRecord> {
  try {
    return JSON.parse(await readFile(checkpointPath(root, checkpointId), "utf8")) as CheckpointRecord;
  } catch {
    throw new DomainError(ErrorCode.CHECKPOINT_NOT_FOUND, "Checkpoint not found", { checkpointId });
  }
}

export async function restoreCheckpoint(root: string, checkpointId: string): Promise<{ checkpointId: string; restored: boolean; stdout: string; stderr: string }> {
  const rec = await readCheckpoint(root, checkpointId);
  if (!rec.diff.trim()) return { checkpointId, restored: false, stdout: "", stderr: "No diff stored in checkpoint." };
  const child = await execFileAsync("git", ["apply", "--reverse", "--whitespace=nowarn", "-"], {
    cwd: root,
    windowsHide: true,
    input: rec.diff,
    maxBuffer: MAX_DIFF_BYTES,
  } as never);
  return { checkpointId, restored: true, stdout: redact(String(child.stdout)), stderr: redact(String(child.stderr)) };
}
