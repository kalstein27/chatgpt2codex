import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

export const MUTATION_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type MutationToolName = "file_apply_patch" | "file_edit_lines" | "file_create";
export type MutationTransactionState =
  | "NOT_STARTED"
  | "APPLYING"
  | "APPLIED_ATOMICALLY"
  | "ROLLED_BACK"
  | "FAILED"
  | "UNKNOWN";

interface MutationTransactionRecord {
  schemaVersion: 1;
  transactionId: string;
  requestId: string;
  projectId: string;
  laneDigest?: string;
  tool: MutationToolName;
  runtimePid: number;
  operationFingerprint: string;
  state: MutationTransactionState;
  itemCount: number;
  partialApplyPossible: boolean;
  automaticRetrySafe: false;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedItemIndex?: number;
  failureCode?: string;
  checkpointId?: string;
}

export type MutationTransactionPublicReceipt = Omit<MutationTransactionRecord, "operationFingerprint" | "laneDigest"> & {
  laneBound: boolean;
};

const RECEIPT_DIR = "mutation-transactions";
const MAX_RECEIPTS = 256;
const ACTIVE_STATES = new Set<MutationTransactionState>(["NOT_STARTED", "APPLYING"]);

function receiptDir(stateDir: string): string {
  return path.join(stateDir, RECEIPT_DIR);
}

function requestReceiptPath(stateDir: string, requestId: string): string {
  const digest = createHash("sha256").update(requestId).digest("hex");
  return path.join(receiptDir(stateDir), `request-${digest}.json`);
}

function assertRequestId(requestId: string): void {
  if (!MUTATION_REQUEST_ID_PATTERN.test(requestId)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Mutation requestId has an invalid format");
  }
}

function toPublicReceipt(record: MutationTransactionRecord): MutationTransactionPublicReceipt {
  const { operationFingerprint: _operationFingerprint, laneDigest, ...publicReceipt } = record;
  return { ...publicReceipt, laneBound: laneDigest !== undefined };
}

async function readRecord(file: string): Promise<MutationTransactionRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as MutationTransactionRecord;
    if (parsed.schemaVersion !== 1 || !parsed.transactionId || !parsed.requestId) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeRecord(file: string, record: MutationTransactionRecord): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const temp = path.join(dir, `.mutation-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function normalizeInterruptedRecord(
  file: string,
  record: MutationTransactionRecord,
): Promise<MutationTransactionRecord> {
  if (record.runtimePid === process.pid || !ACTIVE_STATES.has(record.state)) return record;
  const now = new Date().toISOString();
  const next: MutationTransactionRecord = record.state === "NOT_STARTED"
    ? {
        ...record,
        state: "FAILED",
        partialApplyPossible: false,
        failureCode: "RUNTIME_RESTARTED_BEFORE_MUTATION",
        completedAt: now,
        updatedAt: now,
      }
    : {
        ...record,
        state: "UNKNOWN",
        partialApplyPossible: true,
        failureCode: "RUNTIME_RESTARTED_MUTATION_STATE_UNKNOWN",
        completedAt: now,
        updatedAt: now,
      };
  await writeRecord(file, next);
  return next;
}

async function listRecords(stateDir: string): Promise<Array<{ file: string; record: MutationTransactionRecord }>> {
  const dir = receiptDir(stateDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows = await Promise.all(
    names
      .filter((name) => /^request-[a-f0-9]{64}\.json$/.test(name))
      .map(async (name) => {
        const file = path.join(dir, name);
        const record = await readRecord(file);
        return record ? { file, record } : null;
      }),
  );
  return rows.filter((row): row is { file: string; record: MutationTransactionRecord } => row !== null);
}

async function pruneReceipts(stateDir: string): Promise<void> {
  const rows = await listRecords(stateDir);
  if (rows.length <= MAX_RECEIPTS) return;
  const removable = rows
    .filter(({ record }) => !ACTIVE_STATES.has(record.state))
    .sort((a, b) => a.record.updatedAt.localeCompare(b.record.updatedAt));
  const removeCount = Math.min(rows.length - MAX_RECEIPTS, removable.length);
  await Promise.all(removable.slice(0, removeCount).map(({ file }) => fs.rm(file, { force: true })));
}

export function mutationOperationFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function prepareMutationTransaction(input: {
  stateDir: string;
  requestId?: string;
  projectId: string;
  laneDigest?: string;
  tool: MutationToolName;
  operationFingerprint: string;
  itemCount: number;
}): Promise<{ receipt: MutationTransactionPublicReceipt; created: boolean }> {
  const requestId = input.requestId ?? `mutation-${randomUUID()}`;
  assertRequestId(requestId);
  const file = requestReceiptPath(input.stateDir, requestId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const record: MutationTransactionRecord = {
    schemaVersion: 1,
    transactionId: `mut_${randomUUID()}`,
    requestId,
    projectId: input.projectId,
    ...(input.laneDigest ? { laneDigest: input.laneDigest } : {}),
    tool: input.tool,
    runtimePid: process.pid,
    operationFingerprint: input.operationFingerprint,
    state: "NOT_STARTED",
    itemCount: input.itemCount,
    partialApplyPossible: false,
    automaticRetrySafe: false,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await fs.writeFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await pruneReceipts(input.stateDir).catch(() => undefined);
    return { receipt: toPublicReceipt(record), created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const loaded = await readRecord(file);
    const existing = loaded ? await normalizeInterruptedRecord(file, loaded) : null;
    if (!existing) {
      throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Mutation transaction receipt is unreadable");
    }
    if (
      existing.projectId !== input.projectId
      || existing.laneDigest !== input.laneDigest
      || existing.tool !== input.tool
      || existing.operationFingerprint !== input.operationFingerprint
    ) {
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Mutation requestId was already used for different input", {
        requestId,
      });
    }
    return { receipt: toPublicReceipt(existing), created: false };
  }
}

export async function updateMutationTransaction(
  stateDir: string,
  transactionId: string,
  update: Partial<Pick<
    MutationTransactionRecord,
    | "state"
    | "partialApplyPossible"
    | "startedAt"
    | "completedAt"
    | "failedItemIndex"
    | "failureCode"
    | "checkpointId"
  >>,
): Promise<MutationTransactionPublicReceipt> {
  const rows = await listRecords(stateDir);
  const row = rows.find(({ record }) => record.transactionId === transactionId);
  if (!row) throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Mutation transaction not found");
  const next: MutationTransactionRecord = {
    ...row.record,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  await writeRecord(row.file, next);
  return toPublicReceipt(next);
}

export async function getMutationTransaction(
  stateDir: string,
  query: { transactionId?: string; requestId?: string; laneDigest?: string },
): Promise<MutationTransactionPublicReceipt | null> {
  if (query.requestId) assertRequestId(query.requestId);
  if (query.requestId) {
    const file = requestReceiptPath(stateDir, query.requestId);
    const loaded = await readRecord(file);
    const record = loaded ? await normalizeInterruptedRecord(file, loaded) : null;
    return record && record.laneDigest === query.laneDigest ? toPublicReceipt(record) : null;
  }
  if (!query.transactionId) return null;
  const rows = await listRecords(stateDir);
  const row = rows.find((candidate) => candidate.record.transactionId === query.transactionId);
  const record = row ? await normalizeInterruptedRecord(row.file, row.record) : null;
  return record && record.laneDigest === query.laneDigest ? toPublicReceipt(record) : null;
}
