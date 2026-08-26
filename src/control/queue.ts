import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { clearAuto } from "./auto.js";

/**
 * Pending/approved/rejected/done control-action queue persisted under
 * `stateDir/control/**`, plus the session kill-switch flag file. This is the
 * only path by which a computer_request_action ever turns into a real
 * synthetic click/keystroke: enqueue() never executes anything, and only a
 * local human approval (CLI `control approve`, moved here to `approved/`)
 * lets src/control/executor.ts pick it up.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes to get local human approval

export type ControlActionKind =
  | "click"
  | "double_click"
  | "drag"
  | "scroll"
  | "move"
  | "type"
  | "key"
  | "keypress"
  | "wait";
export type ControlActionStatus = "pending" | "approved" | "rejected" | "done";
export type ControlMouseButton = "left" | "right" | "middle";

export interface ControlRelativePoint {
  xRel: number;
  yRel: number;
}

export interface ControlActionTarget {
  ax?: { role: string; title?: string; label?: string; description?: string };
  windowPoint?: ControlRelativePoint;
}

/** Non-secret dry-run preview of an accessibility resolve, computed
 * read-only (no activation/click) at request time by
 * src/control/mac-input.ts resolveAxElement and surfaced to the local
 * approver before executor.ts ever touches the element. `found:false`
 * means the AX tree had no match (e.g. an Electron/Chromium app that
 * hasn't been asked for its accessibility tree yet) — the approver should
 * expect a windowPoint fallback at execution time. */
export interface ResolvedTargetPreview {
  found: boolean;
  role?: string;
  title?: string;
  description?: string;
  frame?: { x: number; y: number; width: number; height: number };
  app?: string;
  bundleId?: string;
  window?: string;
  matchCount?: number;
  actions?: string[];
  source?: "menu-bar" | "ax-helper" | "system-events";
  reason?: string;
}

/** On-disk shape. `text` (raw synthetic-type payload) is local-only: it must
 * never be echoed back through a tool result or written to the ledger. */
export interface ControlActionRecord {
  actionId: string;
  appName: string;
  kind: ControlActionKind;
  target: ControlActionTarget;
  text?: string;
  keyCode?: number;
  keys?: string[];
  button?: ControlMouseButton;
  path?: ControlRelativePoint[];
  scrollX?: number;
  scrollY?: number;
  durationMs?: number;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: ControlActionStatus;
  result?: {
    ok: boolean;
    error?: string;
    executedAt?: number;
    /** Best-effort before/after screenshot evidence paths captured by
     * src/control/executor.ts around the actual synthetic input, when
     * available (darwin + an active project + a non-sensitive target app).
     * Absent whenever capture wasn't attempted or failed — never blocks
     * the action itself. */
    evidence?: { before?: string; after?: string };
  };
  /** Read-only AX resolve preview, not secret; always safe to surface via toSummary. */
  resolved?: ResolvedTargetPreview;
  /** Who moved this action from pending -> approved: a local human (CLI
   * `control approve`/`control approve-all`, default when unset), the
   * bounded auto-approve scope (src/control/auto.ts autoDecision, set by
   * src/control/executor.ts), or ChatGPT's own client-side Confirm/Deny
   * prompt (set by src/control/tools.ts handleComputerRequestAction when
   * isControlChatGptExposed() is on). Purely an audit-trail marker — it
   * never changes which gates executor.ts re-checks before actually
   * executing. */
  approvedVia?: "auto" | "human" | "chatgpt";
}

/** Redacted shape safe to return to a model/API caller: `text` is replaced
 * by a length + sha8 summary, never the original characters. */
export type ControlActionSummary = Omit<ControlActionRecord, "text"> & {
  textSummary?: { length: number; sha8: string };
};

function controlDir(stateDir: string): string {
  return path.join(stateDir, "control");
}

function statusDir(stateDir: string, status: ControlActionStatus): string {
  return path.join(controlDir(stateDir), status);
}

function killFlagPath(stateDir: string): string {
  return path.join(controlDir(stateDir), "KILL");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    // Non-fatal: filesystem may not support POSIX permission bits.
  }
}

async function writeRecord(dir: string, record: ControlActionRecord): Promise<void> {
  await ensureDir(dir);
  const file = path.join(dir, `${record.actionId}.json`);
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
  try {
    await fs.chmod(file, FILE_MODE);
  } catch {
    // Non-fatal.
  }
}

/** actionId must be a bare filename matching the format enqueue() issues
 * (`ctl_<uuid>`) — never a path with separators or traversal segments.
 * Every reader of the on-disk queue funnels through readRecord, so this is
 * the single chokepoint that prevents a caller-supplied actionId (e.g. via
 * computer_action_status) from escaping the control state directory and
 * reading/deleting an arbitrary file elsewhere on disk. */
const ACTION_ID_RE = /^ctl_[0-9a-fA-F-]{36}$/;

function isValidActionId(actionId: string): boolean {
  return ACTION_ID_RE.test(actionId) && actionId === path.basename(actionId);
}

async function readRecord(dir: string, actionId: string): Promise<ControlActionRecord | null> {
  if (!isValidActionId(actionId)) return null;
  try {
    const raw = await fs.readFile(path.join(dir, `${actionId}.json`), "utf8");
    return JSON.parse(raw) as ControlActionRecord;
  } catch {
    return null;
  }
}

const ALL_STATUSES: readonly ControlActionStatus[] = ["pending", "approved", "rejected", "done"];

async function findRecord(stateDir: string, actionId: string): Promise<{ record: ControlActionRecord; dir: string } | null> {
  for (const status of ALL_STATUSES) {
    const dir = statusDir(stateDir, status);
    const record = await readRecord(dir, actionId);
    if (record) return { record, dir };
  }
  return null;
}

async function moveRecord(
  stateDir: string,
  actionId: string,
  fromDir: string,
  toStatus: ControlActionStatus,
  patch: Partial<ControlActionRecord>,
  fallback: ControlActionRecord,
): Promise<ControlActionRecord> {
  const next: ControlActionRecord = { ...fallback, ...patch };
  await writeRecord(statusDir(stateDir, toStatus), next);
  if (path.resolve(fromDir) !== path.resolve(statusDir(stateDir, toStatus))) {
    await fs.unlink(path.join(fromDir, `${actionId}.json`)).catch(() => undefined);
  }
  return next;
}

export function textSummaryFor(text: string): { length: number; sha8: string } {
  return { length: text.length, sha8: createHash("sha256").update(text).digest("hex").slice(0, 8) };
}

/** Strip the raw `text` field, replacing it with a length+hash summary. */
export function toSummary(record: ControlActionRecord): ControlActionSummary {
  const { text, ...rest } = record;
  return { ...rest, textSummary: text !== undefined ? textSummaryFor(text) : undefined };
}

export async function isKilled(stateDir: string): Promise<boolean> {
  return fs
    .stat(killFlagPath(stateDir))
    .then(() => true)
    .catch(() => false);
}

/** Set the session kill flag, immediately disable any auto-approve scope
 * (src/control/auto.ts), and reject every pending action. */
export async function setKill(stateDir: string): Promise<void> {
  await ensureDir(controlDir(stateDir));
  await fs.writeFile(killFlagPath(stateDir), String(Date.now()), { mode: FILE_MODE });
  try {
    await fs.chmod(killFlagPath(stateDir), FILE_MODE);
  } catch {
    // Non-fatal.
  }
  await clearAuto(stateDir);
  const pendingDir = statusDir(stateDir, "pending");
  const files = await fs.readdir(pendingDir).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    await rejectAction(stateDir, file.slice(0, -5), "killed").catch(() => undefined);
  }
}

/** Resume control after a kill: only called when a fresh `control` lease is granted. */
export async function clearKill(stateDir: string): Promise<void> {
  await fs.unlink(killFlagPath(stateDir)).catch(() => undefined);
}

export interface EnqueueInput {
  appName: string;
  kind: ControlActionKind;
  target: ControlActionTarget;
  text?: string;
  keyCode?: number;
  keys?: string[];
  button?: ControlMouseButton;
  path?: ControlRelativePoint[];
  scrollX?: number;
  scrollY?: number;
  durationMs?: number;
  reason: string;
  ttlMs?: number;
  resolved?: ResolvedTargetPreview;
}

export async function enqueue(stateDir: string, input: EnqueueInput): Promise<ControlActionRecord> {
  if (await isKilled(stateDir)) {
    throw new DomainError(ErrorCode.CONTROL_KILLED, "Control session is killed; grant a new control lease to resume");
  }
  const now = Date.now();
  const record: ControlActionRecord = {
    actionId: `ctl_${randomUUID()}`,
    appName: input.appName,
    kind: input.kind,
    target: input.target,
    text: input.text,
    keyCode: input.keyCode,
    keys: input.keys,
    button: input.button,
    path: input.path,
    scrollX: input.scrollX,
    scrollY: input.scrollY,
    durationMs: input.durationMs,
    reason: input.reason,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    status: "pending",
    resolved: input.resolved,
  };
  await writeRecord(statusDir(stateDir, "pending"), record);
  return record;
}

async function expireIfNeeded(stateDir: string, found: { record: ControlActionRecord; dir: string }): Promise<ControlActionRecord> {
  if (found.record.status === "pending" && Date.now() > found.record.expiresAt) {
    return moveRecord(stateDir, found.record.actionId, found.dir, "rejected", { status: "rejected", result: { ok: false, error: "expired" } }, found.record);
  }
  return found.record;
}

export async function getAction(stateDir: string, actionId: string): Promise<ControlActionRecord | null> {
  const found = await findRecord(stateDir, actionId);
  if (!found) return null;
  return expireIfNeeded(stateDir, found);
}

export async function listActions(stateDir: string): Promise<ControlActionRecord[]> {
  const out: ControlActionRecord[] = [];
  for (const status of ALL_STATUSES) {
    const dir = statusDir(stateDir, status);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const record = await readRecord(dir, file.slice(0, -5));
      if (record) out.push(await expireIfNeeded(stateDir, { record, dir }));
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export async function approveAction(
  stateDir: string,
  actionId: string,
  opts: { approvedVia?: "auto" | "human" | "chatgpt" } = {},
): Promise<ControlActionRecord> {
  if (await isKilled(stateDir)) {
    throw new DomainError(ErrorCode.CONTROL_KILLED, "Control session is killed; grant a new control lease to resume");
  }
  const found = await findRecord(stateDir, actionId);
  const record = found ? await expireIfNeeded(stateDir, found) : null;
  if (!record || record.status !== "pending") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `No pending control action: ${actionId}`);
  }
  return moveRecord(
    stateDir,
    actionId,
    found!.dir,
    "approved",
    { status: "approved", approvedVia: opts.approvedVia ?? "human" },
    record,
  );
}

export async function rejectAction(stateDir: string, actionId: string, reasonCode = "rejected"): Promise<ControlActionRecord> {
  const found = await findRecord(stateDir, actionId);
  if (!found) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Control action not found: ${actionId}`);
  }
  return moveRecord(stateDir, actionId, found.dir, "rejected", { status: "rejected", result: { ok: false, error: reasonCode } }, found.record);
}

export async function markDone(
  stateDir: string,
  actionId: string,
  result: { ok: boolean; error?: string; evidence?: { before?: string; after?: string } },
): Promise<ControlActionRecord> {
  const found = await findRecord(stateDir, actionId);
  if (!found) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Control action not found: ${actionId}`);
  }
  return moveRecord(stateDir, actionId, found.dir, "done", { status: "done", result: { ...result, executedAt: Date.now() } }, found.record);
}
