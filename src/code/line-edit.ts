import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveInProject } from "../policy/paths.js";
import { DomainError, ErrorCode } from "../types.js";
import { rangeHash } from "../util/hash.js";
import {
  MAX_CHECKPOINT_SNAPSHOT_BYTES,
  type MutationCheckpointFile,
} from "../state/checkpoints.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EDIT_BYTES = 10 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/i;

export interface LineEdit {
  path: string;
  /** 1-based line index, using the same logical-line model as file_read_slice. */
  startLine: number;
  /** Number of existing logical lines to remove from startLine. Zero inserts. */
  deleteCount: number;
  /** Replacement logical lines. Each item must not contain CR, LF, or NUL. */
  lines: string[];
  /** Whole-file fileHash returned by file_read_slice before response redaction. */
  fileHash: string;
}

export interface AppliedLineEdit {
  path: string;
  startLine: number;
  deletedLines: number;
  insertedLines: number;
  beforeHash: string;
  afterHash: string;
  changed: boolean;
}

interface StagedLineEdit {
  abs: string;
  content: string;
  previous: Buffer;
  mode: number;
  result: AppliedLineEdit;
}

function validateEdit(edit: LineEdit): void {
  if (!Number.isInteger(edit.startLine) || edit.startLine < 1) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "startLine must be a positive integer", {
      path: edit.path,
      startLine: edit.startLine,
      reason: "invalid_line_range",
    });
  }
  if (!Number.isInteger(edit.deleteCount) || edit.deleteCount < 0) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "deleteCount must be a non-negative integer", {
      path: edit.path,
      deleteCount: edit.deleteCount,
      reason: "invalid_line_range",
    });
  }
  if (!SHA256_RE.test(edit.fileHash)) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "fileHash must be a SHA-256 hash", {
      path: edit.path,
      reason: "invalid_file_hash",
    });
  }
  for (const [index, line] of edit.lines.entries()) {
    if (line.includes("\0")) {
      throw new DomainError(ErrorCode.NULLBYTE_REJECTED, "Line edit contains a null byte", {
        path: edit.path,
        lineIndex: index,
      });
    }
    if (line.includes("\n") || line.includes("\r")) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, "Each replacement item must contain exactly one logical line", {
        path: edit.path,
        lineIndex: index,
        reason: "embedded_newline",
      });
    }
  }
}

function detectEol(raw: string): "\n" | "\r\n" {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function assertConsistentEol(raw: string, rel: string): void {
  if (!raw.includes("\r\n")) return;
  const withoutCrLf = raw.replace(/\r\n/g, "");
  if (withoutCrLf.includes("\n")) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Mixed LF and CRLF line endings are not editable safely: ${rel}`, {
      path: rel,
      reason: "mixed_eol",
    });
  }
}

/**
 * Apply redaction-safe, line-addressed edits without requiring old line text.
 * Coordinates match file_read_slice: normalized content is split on `\n`, so a
 * file ending in a newline has a final empty logical line.
 */
export async function editFileLines(
  root: string,
  edits: LineEdit[],
): Promise<{ applied: AppliedLineEdit[]; checkpointFiles: MutationCheckpointFile[] }> {
  if (edits.length === 0) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "At least one line edit is required", {
      reason: "empty_line_edits",
    });
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify(edits), "utf8");
  if (payloadBytes > MAX_EDIT_BYTES) {
    throw new DomainError(ErrorCode.PATCH_TOO_LARGE, `Line edits exceed ${MAX_EDIT_BYTES} bytes`, {
      bytes: payloadBytes,
    });
  }

  const seen = new Set<string>();
  const staged: StagedLineEdit[] = [];

  for (const edit of edits) {
    validateEdit(edit);

    const abs = await resolveInProject(root, edit.path, { allowSymlink: false, rejectRoot: true });
    if (seen.has(abs)) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, "Only one line edit per file is allowed in a transaction", {
        path: edit.path,
        reason: "duplicate_edit_path",
      });
    }
    seen.add(abs);

    const stat = await fs.lstat(abs);
    if (!stat.isFile()) {
      throw new DomainError(ErrorCode.NOT_A_FILE, `Not a regular file: ${edit.path}`, { path: edit.path });
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new DomainError(ErrorCode.FILE_TOO_LARGE, `File exceeds ${MAX_FILE_BYTES} bytes`, {
        path: edit.path,
        size: stat.size,
      });
    }

    const previous = await fs.readFile(abs);
    if (!isUtf8(previous)) {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Only valid UTF-8 text files can be edited safely: ${edit.path}`, {
        path: edit.path,
        reason: "invalid_utf8",
      });
    }
    const raw = previous.toString("utf8");
    assertConsistentEol(raw, edit.path);
    const normalized = raw.replace(/\r\n/g, "\n");
    const beforeHash = rangeHash(normalized);
    if (beforeHash !== edit.fileHash) {
      throw new DomainError(ErrorCode.STALE_FILE_HASH, `Hash precondition failed for ${edit.path}`, {
        path: edit.path,
        expected: edit.fileHash,
        actual: beforeHash,
        reason: "stale_file_hash",
        recommendedTool: "file_read_slice",
      });
    }

    const logicalLines = normalized.split("\n");
    const insertionIndex = edit.startLine - 1;
    if (insertionIndex > logicalLines.length) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, `startLine is beyond the editable range for ${edit.path}`, {
        path: edit.path,
        startLine: edit.startLine,
        lineCount: logicalLines.length,
        reason: "invalid_line_range",
      });
    }
    if (edit.deleteCount > logicalLines.length - insertionIndex) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, `deleteCount exceeds the remaining lines for ${edit.path}`, {
        path: edit.path,
        startLine: edit.startLine,
        deleteCount: edit.deleteCount,
        lineCount: logicalLines.length,
        reason: "invalid_line_range",
      });
    }

    const nextLines = [...logicalLines];
    nextLines.splice(insertionIndex, edit.deleteCount, ...edit.lines);
    const normalizedNext = nextLines.join("\n");
    const eol = detectEol(raw);
    const content = eol === "\r\n" ? normalizedNext.replace(/\n/g, "\r\n") : normalizedNext;
    const afterHash = rangeHash(normalizedNext);

    staged.push({
      abs,
      content,
      previous,
      mode: stat.mode & 0o7777,
      result: {
        path: edit.path,
        startLine: edit.startLine,
        deletedLines: edit.deleteCount,
        insertedLines: edit.lines.length,
        beforeHash,
        afterHash,
        changed: content !== raw,
      },
    });
  }

  for (const item of staged) {
    let current: Buffer;
    try {
      current = await fs.readFile(item.abs);
    } catch {
      throw new DomainError(ErrorCode.CONCURRENT_MUTATION, "File disappeared while the line edit was being prepared", {
        reason: "concurrent_mutation",
        recommendedTool: "file_read_slice",
      });
    }
    if (!current.equals(item.previous)) {
      throw new DomainError(ErrorCode.CONCURRENT_MUTATION, "File changed while the line edit was being prepared", {
        reason: "concurrent_mutation",
        recommendedTool: "file_read_slice",
      });
    }
  }

  const checkpointBytes = staged.reduce(
    (total, item) => total + (item.result.changed ? item.previous.byteLength : 0),
    0,
  );
  if (checkpointBytes > MAX_CHECKPOINT_SNAPSHOT_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, "Line edit rollback snapshot is too large", {
      bytes: checkpointBytes,
    });
  }

  const committed: StagedLineEdit[] = [];
  try {
    for (const item of staged) {
      if (!item.result.changed) continue;
      const dir = path.dirname(item.abs);
      const temp = path.join(dir, `.chatgpt2codex.line-edit.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, item.content, { encoding: "utf8", mode: item.mode });
        await fs.chmod(temp, item.mode);
        await fs.rename(temp, item.abs);
      } catch (err) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw err;
      }
      committed.push(item);
    }
  } catch (err) {
    for (const item of committed.reverse()) {
      await fs.writeFile(item.abs, item.previous, { mode: item.mode }).catch(() => undefined);
      await fs.chmod(item.abs, item.mode).catch(() => undefined);
    }
    throw err;
  }

  return {
    applied: staged.map((item) => item.result),
    checkpointFiles: staged
      .filter((item) => item.result.changed)
      .map((item) => ({
        path: item.result.path,
        beforeContent: item.previous,
        beforeMode: item.mode,
        afterSha256: createHash("sha256").update(Buffer.from(item.content, "utf8")).digest("hex"),
      })),
  };
}
