import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import { resolveInProject } from "../policy/paths.js";

// execution-capability: checkpoint-git-operations
const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_CHECKPOINT_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export interface MutationCheckpointFile {
  path: string;
  beforeContent: Buffer | null;
  beforeMode?: number;
  afterSha256: string | null;
}

interface StoredCheckpointFile {
  path: string;
  beforeContentBase64?: string;
  beforeMode?: number;
  afterSha256: string | null;
}

export interface CheckpointRecord {
  checkpointId: string;
  projectId: string;
  createdAt: number;
  reason: string;
  diff: string;
  restorable?: boolean;
  restoreMode?: "file-snapshot" | "reverse-diff" | "delete-created-file" | "none";
  restoreState?: "ready" | "restored";
  restoredAt?: number;
  /** Private local rollback payload. Never expose this through checkpoint_show/list. */
  restoreFiles?: StoredCheckpointFile[];
  createdFile?: {
    path: string;
    sha256: string;
  };
}

export type PublicCheckpointRecord = Omit<CheckpointRecord, "diff" | "restoreFiles" | "createdFile"> & {
  diff?: string;
  affectedFiles?: string[];
  createdFile?: { path: string };
};

function checkpointDir(root: string): string {
  return path.join(root, ".chatgpt2codex", "checkpoints");
}

function checkpointPath(root: string, checkpointId: string): string {
  if (!/^cp_[A-Za-z0-9_.-]+$/.test(checkpointId)) {
    throw new DomainError(ErrorCode.CHECKPOINT_NOT_FOUND, "Invalid checkpoint id", { checkpointId });
  }
  return path.join(checkpointDir(root), `${checkpointId}.json`);
}

async function ensureCheckpointDir(root: string): Promise<void> {
  const dir = checkpointDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
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
  await ensureCheckpointDir(root);
  const checkpointId = `cp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const diff = await getWorkingDiff(root);
  const record: CheckpointRecord = {
    checkpointId,
    projectId,
    createdAt: Date.now(),
    reason,
    diff,
    // Historical workspace-wide diffs are useful for review, but restoring
    // one would also revert unrelated dirty worktree changes. New mutation
    // tools use createMutationCheckpoint instead.
    restorable: false,
    restoreMode: "none",
  };
  await writeFile(checkpointPath(root, checkpointId), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

export async function createMutationCheckpoint(
  root: string,
  projectId: string,
  reason: string,
  files: MutationCheckpointFile[],
): Promise<CheckpointRecord> {
  await ensureCheckpointDir(root);
  const uniquePaths = new Set<string>();
  let snapshotBytes = 0;
  const restoreFiles: StoredCheckpointFile[] = [];
  for (const file of files) {
    if (uniquePaths.has(file.path)) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, "Duplicate checkpoint path", { path: file.path });
    }
    uniquePaths.add(file.path);
    snapshotBytes += file.beforeContent?.byteLength ?? 0;
    if (snapshotBytes > MAX_CHECKPOINT_SNAPSHOT_BYTES) {
      throw new DomainError(ErrorCode.FILE_TOO_LARGE, "Checkpoint snapshot is too large", {
        bytes: snapshotBytes,
      });
    }
    restoreFiles.push({
      path: file.path,
      ...(file.beforeContent !== null
        ? { beforeContentBase64: file.beforeContent.toString("base64") }
        : {}),
      ...(file.beforeMode !== undefined ? { beforeMode: file.beforeMode & 0o7777 } : {}),
      afterSha256: file.afterSha256,
    });
  }
  const checkpointId = `cp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const record: CheckpointRecord = {
    checkpointId,
    projectId,
    createdAt: Date.now(),
    reason,
    diff: "",
    restorable: restoreFiles.length > 0,
    restoreMode: restoreFiles.length > 0 ? "file-snapshot" : "none",
    ...(restoreFiles.length > 0 ? { restoreState: "ready" as const } : {}),
    ...(restoreFiles.length > 0 ? { restoreFiles } : {}),
  };
  await writeFile(checkpointPath(root, checkpointId), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

export async function createFileCheckpoint(
  root: string,
  projectId: string,
  rel: string,
  createdNew: boolean,
): Promise<CheckpointRecord> {
  await ensureCheckpointDir(root);
  const checkpointId = `cp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const record: CheckpointRecord = {
    checkpointId,
    projectId,
    createdAt: Date.now(),
    reason: createdNew ? "create" : "overwrite",
    diff: "",
    restorable: createdNew,
    restoreMode: createdNew ? "delete-created-file" : "none",
    ...(createdNew ? { restoreState: "ready" as const } : {}),
  };
  if (createdNew) {
    const abs = await resolveInProject(root, rel, { allowSymlink: false, rejectRoot: true });
    const content = await readFile(abs);
    record.createdFile = {
      path: rel,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }
  await writeFile(checkpointPath(root, checkpointId), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

export function toPublicCheckpoint(record: CheckpointRecord): PublicCheckpointRecord {
  const { diff, restoreFiles, createdFile, ...meta } = record;
  const affectedFiles = restoreFiles?.map((file) => file.path) ?? (createdFile ? [createdFile.path] : []);
  return {
    ...meta,
    ...(diff.trim().length > 0 ? { diff: redact(diff) } : {}),
    ...(affectedFiles.length > 0 ? { affectedFiles } : {}),
    ...(createdFile ? { createdFile: { path: createdFile.path } } : {}),
  };
}

export async function listCheckpoints(root: string, projectId: string): Promise<PublicCheckpointRecord[]> {
  let names: string[] = [];
  try { names = await readdir(checkpointDir(root)); } catch { return []; }
  const out: PublicCheckpointRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort().reverse().slice(0, 50)) {
    try {
      const raw = await readFile(path.join(checkpointDir(root), name), "utf8");
      const rec = JSON.parse(raw) as CheckpointRecord;
      if (rec.projectId === projectId) {
        out.push(toPublicCheckpoint(rec));
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

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readCurrentFile(abs: string): Promise<{ content: Buffer | null; mode?: number }> {
  try {
    const stat = await lstat(abs);
    if (!stat.isFile()) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, "Checkpoint target is not a regular file");
    }
    return { content: await readFile(abs), mode: stat.mode & 0o7777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: null };
    throw error;
  }
}

async function writeFileAtomically(abs: string, content: Buffer, mode: number | undefined): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const temp = path.join(path.dirname(abs), `.chatgpt2codex.restore.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { mode: mode ?? 0o600 });
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, abs);
    if (mode !== undefined) await chmod(abs, mode);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function persistCheckpointRecord(root: string, record: CheckpointRecord): Promise<void> {
  await ensureCheckpointDir(root);
  const destination = checkpointPath(root, record.checkpointId);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, destination);
    await chmod(destination, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function markCheckpointRestored(root: string, rec: CheckpointRecord): Promise<void> {
  await persistCheckpointRecord(root, {
    ...rec,
    restorable: false,
    restoreState: "restored",
    restoredAt: rec.restoredAt ?? Date.now(),
  });
}

async function fileSnapshotsMatchRestoredState(root: string, rec: CheckpointRecord): Promise<boolean> {
  const restoreFiles = rec.restoreFiles;
  if (!restoreFiles || restoreFiles.length === 0) return false;
  for (const file of restoreFiles) {
    const abs = await resolveInProject(root, file.path, { allowSymlink: false, rejectRoot: true });
    const current = await readCurrentFile(abs);
    if (file.beforeContentBase64 === undefined) {
      if (current.content !== null) return false;
      continue;
    }
    const beforeContent = Buffer.from(file.beforeContentBase64, "base64");
    if (current.content === null || sha256(current.content) !== sha256(beforeContent)) return false;
    if (file.beforeMode !== undefined && current.mode !== file.beforeMode) return false;
  }
  return true;
}

async function restoreFileSnapshots(root: string, rec: CheckpointRecord): Promise<void> {
  const restoreFiles = rec.restoreFiles;
  if (!restoreFiles || restoreFiles.length === 0) {
    throw new DomainError(ErrorCode.CHECKPOINT_NOT_FOUND, "Checkpoint is missing scoped restore data");
  }

  const seen = new Set<string>();
  const staged: Array<{
    abs: string;
    beforeContent: Buffer | null;
    beforeMode?: number;
    currentContent: Buffer | null;
    currentMode?: number;
  }> = [];
  let snapshotBytes = 0;

  for (const file of restoreFiles) {
    const abs = await resolveInProject(root, file.path, { allowSymlink: false, rejectRoot: true });
    if (seen.has(abs)) {
      throw new DomainError(ErrorCode.CHECKPOINT_NOT_FOUND, "Checkpoint contains duplicate paths");
    }
    seen.add(abs);
    const current = await readCurrentFile(abs);
    if (file.afterSha256 === null) {
      if (current.content !== null) {
        throw new DomainError(ErrorCode.HASH_MISMATCH, "Checkpoint target changed after mutation");
      }
    } else if (current.content === null || sha256(current.content) !== file.afterSha256) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, "Checkpoint target changed after mutation");
    }
    const beforeContent = file.beforeContentBase64 === undefined
      ? null
      : Buffer.from(file.beforeContentBase64, "base64");
    snapshotBytes += beforeContent?.byteLength ?? 0;
    if (snapshotBytes > MAX_CHECKPOINT_SNAPSHOT_BYTES) {
      throw new DomainError(ErrorCode.FILE_TOO_LARGE, "Checkpoint snapshot is too large");
    }
    staged.push({
      abs,
      beforeContent,
      beforeMode: file.beforeMode,
      currentContent: current.content,
      currentMode: current.mode,
    });
  }

  const committed: typeof staged = [];
  try {
    for (const file of [...staged].reverse()) {
      if (file.beforeContent === null) {
        await unlink(file.abs);
      } else {
        await writeFileAtomically(file.abs, file.beforeContent, file.beforeMode);
      }
      committed.push(file);
    }
  } catch (error) {
    for (const file of committed.reverse()) {
      try {
        if (file.currentContent === null) {
          await rm(file.abs, { force: true });
        } else {
          await writeFileAtomically(file.abs, file.currentContent, file.currentMode);
        }
      } catch {
        // Best-effort transaction rollback; surface the original restore error.
      }
    }
    if (error instanceof DomainError) throw error;
    throw new DomainError(ErrorCode.HASH_MISMATCH, "Checkpoint restore failed");
  }
}

export async function restoreCheckpoint(root: string, checkpointId: string): Promise<{
  checkpointId: string;
  restored: boolean;
  status: "RESTORED" | "ALREADY_RESTORED" | "NOT_RESTORABLE";
  restoreMode: "file-snapshot" | "reverse-diff" | "delete-created-file" | "none";
  stdout: string;
  stderr: string;
}> {
  const rec = await readCheckpoint(root, checkpointId);
  if (rec.restoreMode === "file-snapshot") {
    if (rec.restoreState === "restored") {
      return {
        checkpointId,
        restored: false,
        status: "ALREADY_RESTORED",
        restoreMode: "file-snapshot",
        stdout: "Checkpoint was already restored.",
        stderr: "",
      };
    }
    if (await fileSnapshotsMatchRestoredState(root, rec)) {
      await markCheckpointRestored(root, rec);
      return {
        checkpointId,
        restored: false,
        status: "ALREADY_RESTORED",
        restoreMode: "file-snapshot",
        stdout: "Checkpoint files already match the restored state.",
        stderr: "",
      };
    }
    await restoreFileSnapshots(root, rec);
    await markCheckpointRestored(root, rec);
    return {
      checkpointId,
      restored: true,
      status: "RESTORED",
      restoreMode: "file-snapshot",
      stdout: "Restored scoped checkpoint files.",
      stderr: "",
    };
  }
  if (rec.restoreMode === "delete-created-file") {
    if (rec.restoreState === "restored") {
      return {
        checkpointId,
        restored: false,
        status: "ALREADY_RESTORED",
        restoreMode: "delete-created-file",
        stdout: "Checkpoint was already restored.",
        stderr: "",
      };
    }
    if (!rec.createdFile) {
      throw new DomainError(ErrorCode.CHECKPOINT_NOT_FOUND, "Create checkpoint is missing file metadata", { checkpointId });
    }
    const abs = await resolveInProject(root, rec.createdFile.path, { allowSymlink: false, rejectRoot: true });
    let content: Buffer;
    try {
      content = await readFile(abs);
    } catch {
      await markCheckpointRestored(root, rec);
      return {
        checkpointId,
        restored: false,
        status: "ALREADY_RESTORED",
        restoreMode: "delete-created-file",
        stdout: "Created file is already absent; checkpoint marked restored.",
        stderr: "",
      };
    }
    const currentHash = createHash("sha256").update(content).digest("hex");
    if (currentHash !== rec.createdFile.sha256) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, "Created file changed since checkpoint; refusing reverse-delete", {
        checkpointId,
        path: rec.createdFile.path,
      });
    }
    await unlink(abs);
    await markCheckpointRestored(root, rec);
    return {
      checkpointId,
      restored: true,
      status: "RESTORED",
      restoreMode: "delete-created-file",
      stdout: `Deleted ${rec.createdFile.path}.`,
      stderr: "",
    };
  }
  if (!rec.diff.trim() || rec.restoreMode === "none") {
    return {
      checkpointId,
      restored: false,
      status: "NOT_RESTORABLE",
      restoreMode: "none",
      stdout: "",
      stderr: "Checkpoint is not restorable.",
    };
  }
  throw new DomainError(
    ErrorCode.NOT_IMPLEMENTED,
    "Legacy workspace-wide reverse-diff checkpoints cannot be restored safely; create a new scoped checkpoint",
  );
}
