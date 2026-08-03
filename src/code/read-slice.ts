import { promises as fs } from "node:fs";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";
import { lineHashes, rangeHash } from "../util/hash.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB (PRD §8.3 FILE_TOO_LARGE)

export type ReadSliceHashMode = "none" | "file" | "range" | "lines";

interface ReadSliceBaseResult {
  path: string;
  start: number;
  end: number;
  content: string;
  hashMode: ReadSliceHashMode;
  eol: "lf" | "crlf";
}

export type ReadSliceNoneResult = ReadSliceBaseResult & { hashMode: "none" };
export type ReadSliceFileResult = ReadSliceBaseResult & { hashMode: "file"; fileHash: string };
export type ReadSliceRangeResult = ReadSliceBaseResult & {
  hashMode: "range";
  rangeHash: string;
  fileHash: string;
};
export type ReadSliceLinesResult = ReadSliceBaseResult & {
  hashMode: "lines";
  lineHashes: string[];
  rangeHash: string;
  fileHash: string;
};
export type ReadSliceResult =
  | ReadSliceNoneResult
  | ReadSliceFileResult
  | ReadSliceRangeResult
  | ReadSliceLinesResult;

/**
 * Read a line-range slice of a project file, returning line-numbered content
 * and the selected SHA-256 hash level (PRD §8.3 file_read_slice). The default
 * "lines" mode preserves the original response contract. Every mode that
 * includes fileHash computes it from the whole normalized file, so it remains
 * the precondition source for file_apply_patch (§9.2) after a partial read.
 *
 * @throws {DomainError} PATH_OUTSIDE_PROJECT, FILE_TOO_LARGE (>10MB), NOT_A_FILE
 */
export function readSlice(
  root: string,
  rel: string,
  start?: number,
  end?: number,
): Promise<ReadSliceLinesResult>;
export function readSlice(
  root: string,
  rel: string,
  start: number | undefined,
  end: number | undefined,
  hashMode: "none",
): Promise<ReadSliceNoneResult>;
export function readSlice(
  root: string,
  rel: string,
  start: number | undefined,
  end: number | undefined,
  hashMode: "file",
): Promise<ReadSliceFileResult>;
export function readSlice(
  root: string,
  rel: string,
  start: number | undefined,
  end: number | undefined,
  hashMode: "range",
): Promise<ReadSliceRangeResult>;
export function readSlice(
  root: string,
  rel: string,
  start: number | undefined,
  end: number | undefined,
  hashMode: "lines",
): Promise<ReadSliceLinesResult>;
export function readSlice(
  root: string,
  rel: string,
  start: number | undefined,
  end: number | undefined,
  hashMode: ReadSliceHashMode,
): Promise<ReadSliceResult>;
export async function readSlice(
  root: string,
  rel: string,
  start?: number,
  end?: number,
  hashMode: ReadSliceHashMode = "lines",
): Promise<ReadSliceResult> {
  const abs = await resolveInProject(root, rel, { allowSymlink: false });

  const stat = await fs.lstat(abs);
  if (!stat.isFile()) {
    throw new DomainError(ErrorCode.NOT_A_FILE, `Not a regular file: ${rel}`, { path: rel });
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, `File exceeds ${MAX_FILE_BYTES} bytes`, {
      path: rel,
      size: stat.size,
    });
  }

  const buf = await fs.readFile(abs);
  const raw = buf.toString("utf8");
  const eol = detectEol(raw);
  const normalized = raw.replace(/\r\n/g, "\n");
  // Split preserving a trailing empty "line" only if the file truly ends
  // without a final newline vs with one; we treat the file as an array of
  // logical lines split on \n.
  const allLines = normalized.split("\n");
  const totalLines = allLines.length;

  const startLine = clampStart(start);
  const endLine = clampEnd(end, totalLines);

  if (startLine > totalLines) {
    // Nothing to return; produce an empty but well-formed slice.
    return withSelectedHashes({
      path: rel,
      start: startLine,
      end: startLine - 1,
      content: "",
      hashMode,
      eol,
    }, hashMode, "", normalized);
  }

  const sliceLines = allLines.slice(startLine - 1, endLine);
  const rangeText = sliceLines.join("\n");

  const numbered = sliceLines
    .map((line, idx) => `${startLine + idx}\t${line}`)
    .join("\n");

  return withSelectedHashes({
    path: rel,
    start: startLine,
    end: startLine + sliceLines.length - 1,
    content: numbered,
    hashMode,
    eol,
  }, hashMode, rangeText, normalized);
}

function withSelectedHashes(
  base: ReadSliceBaseResult,
  hashMode: ReadSliceHashMode,
  rangeText: string,
  normalizedFile: string,
): ReadSliceResult {
  if (hashMode === "none") {
    return { ...base, hashMode };
  }

  const fileHash = rangeHash(normalizedFile);
  if (hashMode === "file") {
    return { ...base, hashMode, fileHash };
  }

  const selectedRangeHash = rangeHash(rangeText);
  if (hashMode === "range") {
    return { ...base, hashMode, rangeHash: selectedRangeHash, fileHash };
  }

  return {
    ...base,
    hashMode,
    lineHashes: lineHashes(rangeText),
    rangeHash: selectedRangeHash,
    fileHash,
  };
}

function clampStart(start?: number): number {
  if (start === undefined || start === null) return 1;
  return start < 1 ? 1 : Math.floor(start);
}

function clampEnd(end: number | undefined, totalLines: number): number {
  if (end === undefined || end === null) return totalLines;
  const e = Math.floor(end);
  return e > totalLines ? totalLines : e < 1 ? 1 : e;
}

function detectEol(raw: string): "lf" | "crlf" {
  return raw.includes("\r\n") ? "crlf" : "lf";
}
