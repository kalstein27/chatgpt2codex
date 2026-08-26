import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";
import { rangeHash } from "../util/hash.js";
import {
  MAX_CHECKPOINT_SNAPSHOT_BYTES,
  type MutationCheckpointFile,
} from "../state/checkpoints.js";

const MAX_PATCH_BYTES = 10 * 1024 * 1024; // 10MB (PRD §8.4 PATCH_TOO_LARGE)

type PatchAction = "add" | "update" | "delete" | "move";

interface AddOp {
  action: "add";
  path: string;
  content: string;
}

interface DeleteOp {
  action: "delete";
  path: string;
}

interface MoveOp {
  action: "move";
  path: string;
  newPath: string;
  hunks: Hunk[];
}

interface UpdateOp {
  action: "update";
  path: string;
  hunks: Hunk[];
}

type PatchOp = AddOp | DeleteOp | MoveOp | UpdateOp;

/** A single @@ context hunk: sequence of context/add/remove lines. */
interface Hunk {
  lines: { kind: "context" | "add" | "remove"; text: string }[];
}

/**
 * Parse a Codex-style `*** Begin Patch` / `*** End Patch` envelope into a
 * sequence of file operations. Format:
 *
 * ```
 * *** Begin Patch
 * *** Add File: path/to/new.ts
 * +line one
 * +line two
 * *** Update File: path/to/existing.ts
 * @@ optional context anchor
 *  unchanged line
 * -removed line
 * +added line
 * *** Move to: path/to/renamed.ts
 * *** Delete File: path/to/gone.ts
 * *** End Patch
 * ```
 *
 * @throws {DomainError} NULLBYTE_REJECTED, PATCH_TOO_LARGE
 */
function parsePatch(patch: string): PatchOp[] {
  const byteLength = Buffer.byteLength(patch, "utf8");
  if (byteLength > MAX_PATCH_BYTES) {
    throw new DomainError(ErrorCode.PATCH_TOO_LARGE, `Patch exceeds ${MAX_PATCH_BYTES} bytes`, {
      bytes: byteLength,
    });
  }
  if (patch.includes("\0")) {
    throw new DomainError(ErrorCode.NULLBYTE_REJECTED, "Patch contains a null byte");
  }

  const lines = patch.split(/\r\n|\n/);
  let i = 0;

  // Tolerate leading/trailing blank lines and require the envelope markers.
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  if (i >= lines.length || (lines[i] ?? "").trim() !== "*** Begin Patch") {
    throw new DomainError(ErrorCode.NULLBYTE_REJECTED, "Patch missing '*** Begin Patch' header", {
      reason: "malformed_envelope",
    });
  }
  i++;

  const ops: PatchOp[] = [];

  const ADD_RE = /^\*\*\* Add File: (.+)$/;
  const UPDATE_RE = /^\*\*\* Update File: (.+)$/;
  const DELETE_RE = /^\*\*\* Delete File: (.+)$/;
  const MOVE_RE = /^\*\*\* Move to: (.+)$/;
  const END_RE = /^\*\*\* End Patch$/;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (END_RE.test(line.trim())) {
      i++;
      break;
    }

    const addMatch = ADD_RE.exec(line.trim());
    const updateMatch = UPDATE_RE.exec(line.trim());
    const deleteMatch = DELETE_RE.exec(line.trim());

    if (addMatch) {
      const filePath = (addMatch[1] ?? "").trim();
      i++;
      const contentLines: string[] = [];
      while (i < lines.length && !isSectionHeader(lines[i] ?? "")) {
        const l = lines[i] ?? "";
        if (l.startsWith("+")) {
          contentLines.push(l.slice(1));
        } else if (l.trim() === "") {
          contentLines.push("");
        } else {
          contentLines.push(l);
        }
        i++;
      }
      ops.push({ action: "add", path: filePath, content: contentLines.join("\n") });
      continue;
    }

    if (updateMatch) {
      const filePath = (updateMatch[1] ?? "").trim();
      i++;
      let newPath: string | undefined;
      const moveHeaderMatch = i < lines.length ? MOVE_RE.exec((lines[i] ?? "").trim()) : null;
      if (moveHeaderMatch) {
        newPath = (moveHeaderMatch[1] ?? "").trim();
        i++;
      }
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < lines.length && !isSectionHeader(lines[i] ?? "")) {
        const l = lines[i] ?? "";
        if (l.startsWith("@@")) {
          current = { lines: [] };
          hunks.push(current);
          i++;
          continue;
        }
        if (!current) {
          current = { lines: [] };
          hunks.push(current);
        }
        if (l.startsWith("+")) {
          current.lines.push({ kind: "add", text: l.slice(1) });
        } else if (l.startsWith("-")) {
          current.lines.push({ kind: "remove", text: l.slice(1) });
        } else if (l.startsWith(" ")) {
          current.lines.push({ kind: "context", text: l.slice(1) });
        } else if (l.trim() === "") {
          current.lines.push({ kind: "context", text: "" });
        } else {
          current.lines.push({ kind: "context", text: l });
        }
        i++;
      }
      if (newPath) {
        ops.push({ action: "move", path: filePath, newPath, hunks });
      } else {
        ops.push({ action: "update", path: filePath, hunks });
      }
      continue;
    }

    if (deleteMatch) {
      const filePath = (deleteMatch[1] ?? "").trim();
      i++;
      // Delete sections carry no body, but tolerate stray blank lines.
      while (i < lines.length && !isSectionHeader(lines[i] ?? "") && (lines[i] ?? "").trim() === "") {
        i++;
      }
      ops.push({ action: "delete", path: filePath });
      continue;
    }

    // Unrecognized line outside any section: skip (blank/noise tolerance).
    i++;
  }

  return ops;
}

function isSectionHeader(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("*** Add File:") ||
    t.startsWith("*** Update File:") ||
    t.startsWith("*** Delete File:") ||
    t.startsWith("*** End Patch")
  );
}

/** Apply a sequence of hunks against existing file text, returning new text. */
function applyHunks(original: string, hunks: Hunk[]): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const srcLines = original.replace(/\r\n/g, "\n").split("\n");
  const outLines: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    // Build the "search" sequence (context + remove) to locate this hunk in
    // the source, then splice in the resulting (context + add) sequence.
    const searchLines = hunk.lines
      .filter((l) => l.kind === "context" || l.kind === "remove")
      .map((l) => l.text);

    let matchAt = -1;
    if (searchLines.length === 0) {
      matchAt = cursor;
    } else {
      for (let start = cursor; start <= srcLines.length - searchLines.length; start++) {
        let ok = true;
        for (let k = 0; k < searchLines.length; k++) {
          if (srcLines[start + k] !== searchLines[k]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          matchAt = start;
          break;
        }
      }
    }

    if (matchAt === -1) {
      const containsRedactedContext = searchLines.some((line) => line.includes("[REDACTED]"));
      throw new DomainError(
        containsRedactedContext ? ErrorCode.PATCH_CONTEXT_REDACTED : ErrorCode.PATCH_CONTEXT_NOT_FOUND,
        containsRedactedContext
          ? "Patch hunk contains redacted context; use file_edit_lines with a fresh whole-file hash"
          : "Patch hunk context did not match file content",
        {
          reason: containsRedactedContext ? "patch_context_redacted" : "patch_context_not_found",
          recommendedTool: containsRedactedContext ? "file_edit_lines" : "file_read_slice",
        },
      );
    }

    // Copy any untouched lines before this hunk.
    for (let k = cursor; k < matchAt; k++) {
      const l = srcLines[k];
      if (l !== undefined) outLines.push(l);
    }

    for (const l of hunk.lines) {
      if (l.kind === "context" || l.kind === "add") outLines.push(l.text);
    }

    cursor = matchAt + searchLines.length;
  }

  for (let k = cursor; k < srcLines.length; k++) {
    const l = srcLines[k];
    if (l !== undefined) outLines.push(l);
  }

  return outLines.join(eol);
}

interface StagedWrite {
  abs: string;
  content: string | null; // null => delete
  /** Whole-file hash observed while the edit was staged. */
  baselineHash?: string;
  /** Existing/source mode to preserve across temp-file replacement or moves. */
  mode?: number;
  tempPath?: string;
}

interface AppliedEntry {
  path: string;
  action: string;
  added: number;
  removed: number;
}

function countDelta(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      if (l.kind === "add") added++;
      if (l.kind === "remove") removed++;
    }
  }
  return { added, removed };
}

/**
 * Apply a Codex-style `*** Begin Patch/End Patch` patch to files under
 * `root`, enforcing hash preconditions per-path (PRD §9.2), transactional
 * staging (stage-all-then-write, temp+rename), and rejecting escapes,
 * nullbytes, and oversized payloads.
 *
 * @throws {DomainError} PATH_OUTSIDE_PROJECT, HASH_MISMATCH,
 *   PATCH_TOO_LARGE (>10MB), NULLBYTE_REJECTED, LEASE_REQUIRED
 */
export async function applyPatch(
  root: string,
  patch: string,
  preconditionHashes?: Record<string, string>,
): Promise<{ applied: AppliedEntry[]; checkpointFiles: MutationCheckpointFile[] }> {
  const ops = parsePatch(patch);

  const staged: StagedWrite[] = [];
  const applied: AppliedEntry[] = [];

  for (const op of ops) {
    if (op.action === "add") {
      const abs = await resolveInProject(root, op.path, { allowSymlink: false, rejectRoot: true });
      staged.push({ abs, content: op.content });
      applied.push({ path: op.path, action: "add", added: op.content.split("\n").length, removed: 0 });
      continue;
    }

    if (op.action === "delete") {
      const abs = await resolveInProject(root, op.path, { allowSymlink: false, rejectRoot: true });
      const original = await readMutationSource(abs, op.path, preconditionHashes);
      const stat = await fs.lstat(abs);
      staged.push({ abs, content: null, baselineHash: rangeHash(original), mode: stat.mode & 0o7777 });
      applied.push({ path: op.path, action: "delete", added: 0, removed: 0 });
      continue;
    }

    if (op.action === "update") {
      const abs = await resolveInProject(root, op.path, { allowSymlink: false, rejectRoot: true });
      const original = await readMutationSource(abs, op.path, preconditionHashes);
      const next = applyHunks(original, op.hunks);
      const stat = await fs.lstat(abs);
      staged.push({ abs, content: next, baselineHash: rangeHash(original), mode: stat.mode & 0o7777 });
      const delta = countDelta(op.hunks);
      applied.push({ path: op.path, action: "update", added: delta.added, removed: delta.removed });
      continue;
    }

    if (op.action === "move") {
      const abs = await resolveInProject(root, op.path, { allowSymlink: false, rejectRoot: true });
      const newAbs = await resolveInProject(root, op.newPath, { allowSymlink: false, rejectRoot: true });
      const original = await readMutationSource(abs, op.path, preconditionHashes);
      const next = op.hunks.length > 0 ? applyHunks(original, op.hunks) : original;
      const stat = await fs.lstat(abs);
      const mode = stat.mode & 0o7777;
      staged.push({ abs, content: null, baselineHash: rangeHash(original), mode }); // remove old location
      staged.push({ abs: newAbs, content: next, mode }); // write new location
      const delta = countDelta(op.hunks);
      applied.push({ path: op.path, action: "move", added: delta.added, removed: delta.removed });
      continue;
    }
  }

  const checkpointBefore = new Map<string, { path: string; content: Buffer | null; mode?: number }>();
  const checkpointAfter = new Map<string, Buffer | null>();
  for (const write of staged) {
    if (!checkpointBefore.has(write.abs)) {
      try {
        const stat = await fs.lstat(write.abs);
        if (!stat.isFile()) {
          throw new DomainError(ErrorCode.NOT_A_FILE, "Patch target is not a regular file");
        }
        checkpointBefore.set(write.abs, {
          path: path.relative(root, write.abs).split(path.sep).join("/"),
          content: await fs.readFile(write.abs),
          mode: stat.mode & 0o7777,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        checkpointBefore.set(write.abs, {
          path: path.relative(root, write.abs).split(path.sep).join("/"),
          content: null,
        });
      }
    }
    checkpointAfter.set(write.abs, write.content === null ? null : Buffer.from(write.content, "utf8"));
  }
  const checkpointBytes = [...checkpointBefore.values()].reduce(
    (total, file) => total + (file.content?.byteLength ?? 0),
    0,
  );
  if (checkpointBytes > MAX_CHECKPOINT_SNAPSHOT_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, "Patch rollback snapshot is too large", {
      bytes: checkpointBytes,
    });
  }

  // Transactional commit: write every staged change to a temp file first,
  // then rename into place. If any write fails, roll back everything that
  // already landed.
  await assertStagedSourcesUnchanged(staged);
  const committed: { finalPath: string; hadPrevious: boolean; prevContent: Buffer | null; prevMode?: number }[] = [];
  try {
    for (const write of staged) {
      if (write.content === null) {
        // Deletion: capture previous content for rollback, then unlink.
        let prevContent: Buffer | null = null;
        try {
          prevContent = await fs.readFile(write.abs);
        } catch {
          prevContent = null;
        }
        await fs.unlink(write.abs);
        committed.push({
          finalPath: write.abs,
          hadPrevious: prevContent !== null,
          prevContent,
          prevMode: checkpointBefore.get(write.abs)?.mode,
        });
        continue;
      }

      const dir = path.dirname(write.abs);
      await fs.mkdir(dir, { recursive: true });
      const tempPath = path.join(dir, `.chatgpt2codex.tmp.${randomUUID()}`);

      let prevContent: Buffer | null = null;
      let hadPrevious = false;
      try {
        prevContent = await fs.readFile(write.abs);
        hadPrevious = true;
      } catch {
        hadPrevious = false;
      }

      await fs.writeFile(tempPath, write.content, {
        encoding: "utf8",
        ...(write.mode !== undefined ? { mode: write.mode } : {}),
      });
      if (write.mode !== undefined) await fs.chmod(tempPath, write.mode);
      await fs.rename(tempPath, write.abs);
      committed.push({
        finalPath: write.abs,
        hadPrevious,
        prevContent,
        prevMode: checkpointBefore.get(write.abs)?.mode,
      });
    }
  } catch (err) {
    // Roll back everything already committed, best-effort, in reverse order.
    for (const c of committed.reverse()) {
      try {
        if (c.hadPrevious && c.prevContent !== null) {
          await fs.writeFile(c.finalPath, c.prevContent, c.prevMode !== undefined ? { mode: c.prevMode } : undefined);
          if (c.prevMode !== undefined) await fs.chmod(c.finalPath, c.prevMode);
        } else {
          await fs.rm(c.finalPath, { force: true });
        }
      } catch {
        // best-effort rollback; nothing further we can do here.
      }
    }
    if (err instanceof DomainError) throw err;
    throw new DomainError(ErrorCode.HASH_MISMATCH, `Patch apply failed: ${(err as Error).message}`);
  }

  const checkpointFiles: MutationCheckpointFile[] = [];
  for (const [abs, before] of checkpointBefore) {
    const after = checkpointAfter.get(abs) ?? null;
    if (before.content === null ? after === null : after !== null && before.content.equals(after)) continue;
    checkpointFiles.push({
      path: before.path,
      beforeContent: before.content,
      beforeMode: before.mode,
      afterSha256: after === null ? null : createHash("sha256").update(after).digest("hex"),
    });
  }
  return { applied, checkpointFiles };
}

async function readMutationSource(
  abs: string,
  relPath: string,
  preconditionHashes?: Record<string, string>,
): Promise<string> {
  const expected = preconditionHashes?.[relPath];
  let current: string;
  try {
    current = await fs.readFile(abs, "utf8");
  } catch {
    throw new DomainError(ErrorCode.FILE_NOT_FOUND, `File missing for mutation: ${relPath}`, { path: relPath });
  }
  if (!expected) return current;
  const actualHash = rangeHash(current);
  if (actualHash !== expected) {
    throw new DomainError(ErrorCode.STALE_FILE_HASH, `Hash precondition failed for ${relPath}`, {
      path: relPath,
      expected,
      actual: actualHash,
      reason: "stale_file_hash",
      recommendedTool: "file_read_slice",
    });
  }
  return current;
}

async function assertStagedSourcesUnchanged(staged: StagedWrite[]): Promise<void> {
  for (const item of staged) {
    if (!item.baselineHash) continue;
    let current: string;
    try {
      current = await fs.readFile(item.abs, "utf8");
    } catch {
      throw new DomainError(ErrorCode.CONCURRENT_MUTATION, "File disappeared while the patch was being prepared", {
        reason: "concurrent_mutation",
        recommendedTool: "file_read_slice",
      });
    }
    if (rangeHash(current) !== item.baselineHash) {
      throw new DomainError(ErrorCode.CONCURRENT_MUTATION, "File changed while the patch was being prepared", {
        reason: "concurrent_mutation",
        recommendedTool: "file_read_slice",
      });
    }
  }
}

/**
 * Create a new file under `root` at `rel` with `content`.
 *
 * @throws {DomainError} FILE_EXISTS (overwrite=false), PATH_OUTSIDE_PROJECT
 */
export async function createFile(
  root: string,
  rel: string,
  content: string,
  overwrite?: boolean,
): Promise<{ path: string; bytes: number; createdNew: boolean }> {
  if (content.includes("\0")) {
    throw new DomainError(ErrorCode.NULLBYTE_REJECTED, "Content contains a null byte");
  }

  const abs = await resolveInProject(root, rel, { allowSymlink: false, rejectRoot: true });

  const existed = await fileExists(abs);
  if (!overwrite) {
    if (existed) {
      throw new DomainError(ErrorCode.FILE_EXISTS, `File already exists: ${rel}`, { path: rel });
    }
  }

  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.chatgpt2codex.tmp.${randomUUID()}`);
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, abs);

  const bytes = Buffer.byteLength(content, "utf8");
  return { path: rel, bytes, createdNew: !existed };
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}
