import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { summarizeAuditInput } from "../policy/audit-input.js";
import { DomainError, ErrorCode } from "../types.js";

/**
 * Append-only Evidence Ledger (PRD §15).
 *
 * `audit.jsonl` is the immutable legacy ledger. New records are deliberately
 * written to the v2 ledger so legacy raw records are never moved, deleted, or
 * rewritten as part of normal runtime startup. v2 segments form one hash chain
 * across rotation boundaries.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LEGACY_LEDGER_FILE = "audit.jsonl";
const ACTIVE_LEDGER_FILE = "audit-v2.jsonl";
const SEGMENT_DIR = "audit-segments";
const DEFAULT_MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 32;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export interface LedgerOptions {
  maxSegmentBytes?: number;
  maxSegments?: number;
}

function recordHash(record: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex");
}

function segmentBoundary(text: string): { firstPrev: string | null; lastHash: string; lastTs: number } | undefined {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  let firstPrev: string | null | undefined;
  let lastHash: string | undefined;
  let lastTs = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { recordHash?: unknown; prevRecordHash?: unknown; ts?: unknown };
      if (typeof parsed.recordHash !== "string" || !HASH_PATTERN.test(parsed.recordHash)) continue;
      if (firstPrev === undefined) {
        firstPrev = typeof parsed.prevRecordHash === "string" && HASH_PATTERN.test(parsed.prevRecordHash)
          ? parsed.prevRecordHash
          : null;
      }
      lastHash = parsed.recordHash;
      lastTs = typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : lastTs;
    } catch {
      // Ignore partial/corrupt records while recovering the retained chain.
    }
  }
  return lastHash ? { firstPrev: firstPrev ?? null, lastHash, lastTs } : undefined;
}

export class Ledger {
  private readonly stateDir: string;
  private readonly maxSegmentBytes: number;
  private readonly maxSegments: number;
  private queue: Promise<unknown> = Promise.resolve();
  private previousHash: string | null | undefined;

  constructor(stateDir: string, options: LedgerOptions = {}) {
    this.stateDir = stateDir;
    this.maxSegmentBytes = Math.max(1, Math.floor(options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES));
    this.maxSegments = Math.max(1, Math.floor(options.maxSegments ?? DEFAULT_MAX_SEGMENTS));
  }

  get legacyPath(): string {
    return join(this.stateDir, LEGACY_LEDGER_FILE);
  }

  get activePath(): string {
    return join(this.stateDir, ACTIVE_LEDGER_FILE);
  }

  get segmentDir(): string {
    return join(this.stateDir, SEGMENT_DIR);
  }

  private async ensureReady(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    await chmod(this.stateDir, DIR_MODE).catch(() => undefined);
    const fh = await open(this.activePath, "a", FILE_MODE);
    await fh.close();
    await chmod(this.activePath, FILE_MODE).catch(() => undefined);
    if (this.previousHash === undefined) this.previousHash = await this.recoverPreviousHash();
  }

  private async recoverPreviousHash(): Promise<string | null> {
    const active = await readFile(this.activePath, "utf8").catch(() => "");
    const activeBoundary = segmentBoundary(active);
    if (activeBoundary) return activeBoundary.lastHash;
    const segments = (await readdir(this.segmentDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && /^audit-segment-.*\.jsonl$/u.test(entry.name))
      .map((entry) => entry.name);
    const boundaries: Array<{ firstPrev: string | null; lastHash: string; lastTs: number }> = [];
    for (const filename of segments) {
      const text = await readFile(join(this.segmentDir, filename), "utf8").catch(() => "");
      const boundary = segmentBoundary(text);
      if (boundary) boundaries.push(boundary);
    }
    if (boundaries.length === 0) return null;
    const referenced = new Set(boundaries.map((boundary) => boundary.firstPrev).filter((value): value is string => Boolean(value)));
    const endpoints = boundaries.filter((boundary) => !referenced.has(boundary.lastHash));
    return (endpoints.length > 0 ? endpoints : boundaries)
      .sort((left, right) => right.lastTs - left.lastTs)[0]?.lastHash ?? null;
  }

  async append(event: { type: string; [k: string]: unknown }): Promise<void> {
    if (!event || typeof event.type !== "string" || event.type.length === 0) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        "Ledger.append requires a non-empty event.type",
      );
    }
    const write = this.queue.then(async () => {
      await this.ensureReady();
      const safe = summarizeAuditInput(event);
      const safeEvent = safe && typeof safe === "object" && !Array.isArray(safe)
        ? safe as Record<string, unknown>
        : { type: event.type, input: { truncated: true, reason: "audit-summary-invalid" } };
      const unsigned: Record<string, unknown> = {
        ...safeEvent,
        type: event.type,
        ledgerSchemaVersion: 2,
        ts: Date.now(),
        prevRecordHash: this.previousHash ?? null,
      };
      const hash = recordHash(unsigned);
      const record = { ...unsigned, recordHash: hash };
      await appendFile(this.activePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: FILE_MODE });
      await chmod(this.activePath, FILE_MODE).catch(() => undefined);
      this.previousHash = hash;

      // Rotation is housekeeping after the evidence record is durable. A
      // rotation failure must never turn an already-completed tool mutation
      // into a reported failure; the active segment simply keeps growing and
      // a later append can retry rotation.
      await this.rotateIfNeeded().catch(() => undefined);
    });
    this.queue = write.catch(() => undefined);
    return write;
  }

  private async rotateIfNeeded(): Promise<void> {
    const info = await stat(this.activePath).catch(() => undefined);
    if (!info || info.size <= this.maxSegmentBytes) return;
    await mkdir(this.segmentDir, { recursive: true, mode: DIR_MODE });
    await chmod(this.segmentDir, DIR_MODE).catch(() => undefined);
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const chain = (this.previousHash ?? "nohash").slice(0, 16);
    const destination = join(this.segmentDir, `audit-segment-${timestamp}-${chain}-${randomUUID().slice(0, 8)}.jsonl`);
    await rename(this.activePath, destination);
    await chmod(destination, FILE_MODE).catch(() => undefined);
    const fh = await open(this.activePath, "a", FILE_MODE);
    await fh.close();
    await chmod(this.activePath, FILE_MODE).catch(() => undefined);
    await this.pruneSegments();
  }

  private async pruneSegments(): Promise<void> {
    const entries = await readdir(this.segmentDir, { withFileTypes: true });
    const segments = await Promise.all(entries
      .filter((entry) => entry.isFile() && /^audit-segment-.*\.jsonl$/u.test(entry.name))
      .map(async (entry) => ({ name: entry.name, mtimeMs: (await stat(join(this.segmentDir, entry.name))).mtimeMs })));
    segments.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    const overflow = segments.slice(0, Math.max(0, segments.length - this.maxSegments));
    for (const segment of overflow) {
      await unlink(join(this.segmentDir, segment.name));
    }
  }
}