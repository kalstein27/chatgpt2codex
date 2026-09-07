import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export const DEFAULT_ARM_REQUEST_TTL_MS = 5 * 60 * 1000;
const ARM_LOCK_STALE_MS = 30_000;
const ARM_LOCK_OWNER_FILE = "owner.json";
const ARM_LOCK_INSTANCE_ID = randomUUID();

export type ArmRequestStatus = "pending" | "approved" | "rejected" | "expired";

export interface ArmRequestRecord {
  requestId: string;
  projectId: string;
  projectName: string;
  sessionKey: string;
  /** Opaque hashed owner scope used to deliver an approved lease back to the requester. */
  sessionScope?: string;
  sessionLabel: string;
  clientLabel: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: ArmRequestStatus;
  resolvedAt?: number;
  resolution?: "approved-by-local-user" | "rejected-by-local-user" | "expired";
}

export interface CreateArmRequestInput {
  projectId: string;
  projectName: string;
  sessionIdentity: string;
  sessionScope?: string;
  sessionLabel?: string;
  clientLabel?: string;
  reason: string;
  ttlMs?: number;
  now?: number;
}

export interface CreateArmRequestResult {
  request: ArmRequestRecord;
  created: boolean;
  deduplicated: boolean;
  expired: ArmRequestRecord[];
}

const REQUEST_ID_RE = /^arm_[0-9a-fA-F-]{36}$/;
const SESSION_SCOPE_RE = /^[a-z0-9-]{1,40}:[0-9a-f]{64}$/;
// Terminal states precede pending so a crash after writing the destination
// but before unlinking the source cannot make an already-resolved request
// appear actionable again.
const STATUSES: readonly ArmRequestStatus[] = ["approved", "rejected", "expired", "pending"];

interface ArmLockOwner {
  pid: number;
  instanceId: string;
  createdAt: number;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readArmLockOwner(lockDir: string): Promise<ArmLockOwner | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(lockDir, ARM_LOCK_OWNER_FILE), "utf8")) as Partial<ArmLockOwner>;
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 || typeof parsed.instanceId !== "string") return null;
    return {
      pid: Number(parsed.pid),
      instanceId: parsed.instanceId,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
    };
  } catch {
    return null;
  }
}

async function writeArmLockOwner(lockDir: string): Promise<void> {
  const owner: ArmLockOwner = {
    pid: process.pid,
    instanceId: ARM_LOCK_INSTANCE_ID,
    createdAt: Date.now(),
  };
  await fs.writeFile(path.join(lockDir, ARM_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
    mode: FILE_MODE,
    flag: "wx",
  });
}

function armRoot(stateDir: string): string {
  return path.join(stateDir, "control", "arm-requests");
}

function statusDir(stateDir: string, status: ArmRequestStatus): string {
  return path.join(armRoot(stateDir), status);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => undefined);
}

async function withArmLock<T>(
  stateDir: string,
  lockName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const root = armRoot(stateDir);
  await ensureDir(root);
  const lockDir = path.join(root, lockName);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.mkdir(lockDir, { mode: DIR_MODE });
      try {
        await writeArmLockOwner(lockDir);
        return await operation();
      } finally {
        await fs.rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const owner = await readArmLockOwner(lockDir);
      if (owner && !processAlive(owner.pid)) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      const lockStat = await fs.stat(lockDir).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > ARM_LOCK_STALE_MS) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "Arm request store is busy; retry the request.");
}

async function withCreateLock<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  return withArmLock(stateDir, ".create.lock", operation);
}

async function withRequestLock<T>(
  stateDir: string,
  requestId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = createHash("sha256").update(requestId).digest("hex").slice(0, 24);
  return withArmLock(stateDir, `.request-${lockKey}.lock`, operation);
}

function boundedText(value: string | undefined, fallback: string, max: number): string {
  const normalized = value
    ?.normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, max);
}

export function sanitizeArmReason(value: string): string {
  return boundedText(value, "Remote client requested desktop control", 240);
}

export function sanitizeArmClientLabel(value: string | undefined): string {
  return boundedText(value, "remote-client", 80);
}

export function armSessionKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

/**
 * Accept only the opaque, hashed scope format produced by session-scope.ts.
 * Raw credentials, transport IDs, and path-like values must never reach the
 * persisted Arm request or Store filename resolver.
 */
export function sanitizeArmSessionScope(value: string | undefined): string | undefined {
  const normalized = value?.normalize("NFKC").trim();
  return normalized && SESSION_SCOPE_RE.test(normalized) ? normalized : undefined;
}

function validRequestId(requestId: string): boolean {
  return REQUEST_ID_RE.test(requestId) && requestId === path.basename(requestId);
}

async function writeRecord(stateDir: string, record: ArmRequestRecord): Promise<void> {
  const dir = statusDir(stateDir, record.status);
  await ensureDir(dir);
  const file = path.join(dir, `${record.requestId}.json`);
  const temporary = path.join(dir, `.${record.requestId}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    mode: FILE_MODE,
    flag: "wx",
  });
  await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function readRecord(dir: string, requestId: string): Promise<ArmRequestRecord | null> {
  if (!validRequestId(requestId)) return null;
  try {
    const raw = await fs.readFile(path.join(dir, `${requestId}.json`), "utf8");
    return JSON.parse(raw) as ArmRequestRecord;
  } catch {
    return null;
  }
}

async function findRecord(
  stateDir: string,
  requestId: string,
): Promise<{ record: ArmRequestRecord; dir: string } | null> {
  for (const status of STATUSES) {
    const dir = statusDir(stateDir, status);
    const record = await readRecord(dir, requestId);
    if (record) return { record, dir };
  }
  return null;
}

async function moveRecord(
  stateDir: string,
  found: { record: ArmRequestRecord; dir: string },
  status: ArmRequestStatus,
  patch: Partial<ArmRequestRecord>,
): Promise<ArmRequestRecord> {
  const next: ArmRequestRecord = { ...found.record, ...patch, status };
  await writeRecord(stateDir, next);
  const destination = statusDir(stateDir, status);
  if (path.resolve(found.dir) !== path.resolve(destination)) {
    await fs.unlink(path.join(found.dir, `${found.record.requestId}.json`)).catch(() => undefined);
  }
  return next;
}

async function expirePending(
  stateDir: string,
  found: { record: ArmRequestRecord; dir: string },
  now: number,
): Promise<{ record: ArmRequestRecord; expired: boolean }> {
  if (found.record.status !== "pending" || now <= found.record.expiresAt) {
    return { record: found.record, expired: false };
  }
  const record = await moveRecord(stateDir, found, "expired", {
    resolvedAt: now,
    resolution: "expired",
  });
  return { record, expired: true };
}

export async function listArmRequests(
  stateDir: string,
  now = Date.now(),
): Promise<{ requests: ArmRequestRecord[]; expired: ArmRequestRecord[] }> {
  const requestIds = new Set<string>();
  for (const status of STATUSES) {
    const dir = statusDir(stateDir, status);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (file.endsWith(".json")) requestIds.add(file.slice(0, -5));
    }
  }

  const requests: ArmRequestRecord[] = [];
  const expired: ArmRequestRecord[] = [];
  for (const requestId of requestIds) {
    const resolved = await getArmRequest(stateDir, requestId, now);
    if (!resolved.request) continue;
    requests.push(resolved.request);
    if (resolved.expired) expired.push(resolved.request);
  }
  requests.sort((a, b) => a.createdAt - b.createdAt);
  return { requests, expired };
}

/**
 * Fast status path for callers that only need currently actionable requests.
 * Avoid scanning terminal status directories, whose history can grow over the
 * lifetime of the local control service. Expired pending requests are still
 * transitioned atomically so polling preserves the same lifecycle semantics.
 */
export async function listPendingArmRequests(
  stateDir: string,
  now = Date.now(),
): Promise<{ requests: ArmRequestRecord[]; expired: ArmRequestRecord[] }> {
  const dir = statusDir(stateDir, "pending");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const requests: ArmRequestRecord[] = [];
  const expired: ArmRequestRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const requestId = file.slice(0, -5);
    const resolved = await getArmRequest(stateDir, requestId, now);
    if (!resolved.request) continue;
    if (resolved.expired) {
      expired.push(resolved.request);
    } else if (resolved.request.status === "pending") {
      requests.push(resolved.request);
    }
  }
  requests.sort((a, b) => a.createdAt - b.createdAt);
  return { requests, expired };
}

export async function createArmRequest(
  stateDir: string,
  input: CreateArmRequestInput,
): Promise<CreateArmRequestResult> {
  return withCreateLock(stateDir, async () => {
    const now = input.now ?? Date.now();
    const ttlMs = Math.min(
      10 * 60 * 1000,
      Math.max(30_000, input.ttlMs ?? DEFAULT_ARM_REQUEST_TTL_MS),
    );
    const sessionKey = armSessionKey(input.sessionIdentity);
    const sessionScope = sanitizeArmSessionScope(input.sessionScope);
    const listed = await listArmRequests(stateDir, now);
    const existing = listed.requests.find(
      (request) =>
        request.status === "pending" &&
        request.projectId === input.projectId &&
        request.sessionKey === sessionKey,
    );
    if (existing) {
      return { request: existing, created: false, deduplicated: true, expired: listed.expired };
    }

    const request: ArmRequestRecord = {
      requestId: `arm_${randomUUID()}`,
      projectId: boundedText(input.projectId, "project", 120),
      projectName: boundedText(input.projectName, "project", 120),
      sessionKey,
      ...(sessionScope ? { sessionScope } : {}),
      sessionLabel: boundedText(input.sessionLabel, "REMOTE", 80),
      clientLabel: sanitizeArmClientLabel(input.clientLabel),
      reason: sanitizeArmReason(input.reason),
      createdAt: now,
      expiresAt: now + ttlMs,
      status: "pending",
    };
    await writeRecord(stateDir, request);
    return { request, created: true, deduplicated: false, expired: listed.expired };
  });
}

export async function getArmRequest(
  stateDir: string,
  requestId: string,
  now = Date.now(),
): Promise<{ request: ArmRequestRecord | null; expired: boolean }> {
  return withRequestLock(stateDir, requestId, async () => {
    const found = await findRecord(stateDir, requestId);
    if (!found) return { request: null, expired: false };
    const resolved = await expirePending(stateDir, found, now);
    return { request: resolved.record, expired: resolved.expired };
  });
}

export interface PendingArmRequestResolution {
  request: ArmRequestRecord;
  transition(status: "approved" | "rejected"): Promise<ArmRequestRecord>;
}

export async function withPendingArmRequestLock<T>(
  stateDir: string,
  requestId: string,
  operation: (resolution: PendingArmRequestResolution) => Promise<T>,
  now = Date.now(),
): Promise<T> {
  return withRequestLock(stateDir, requestId, async () => {
    const found = await findRecord(stateDir, requestId);
    if (!found) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Arm request not found: ${requestId}`);
    const resolved = await expirePending(stateDir, found, now);
    if (resolved.record.status !== "pending") {
      throw new DomainError(ErrorCode.APPROVAL_REQUIRED, `Arm request is not pending: ${requestId}`, {
        requestId,
        status: resolved.record.status,
      });
    }

    let transitioned = false;
    return operation({
      request: resolved.record,
      transition: async (status) => {
        if (transitioned) {
          throw new DomainError(ErrorCode.APPROVAL_REQUIRED, `Arm request already transitioned: ${requestId}`);
        }
        const record = await moveRecord(stateDir, found, status, {
          resolvedAt: now,
          resolution: status === "approved" ? "approved-by-local-user" : "rejected-by-local-user",
        });
        transitioned = true;
        return record;
      },
    });
  });
}

export async function approveArmRequestRecord(
  stateDir: string,
  requestId: string,
  now = Date.now(),
): Promise<ArmRequestRecord> {
  return withPendingArmRequestLock(stateDir, requestId, ({ transition }) => transition("approved"), now);
}

export async function rejectArmRequestRecord(
  stateDir: string,
  requestId: string,
  now = Date.now(),
): Promise<ArmRequestRecord> {
  return withPendingArmRequestLock(stateDir, requestId, ({ transition }) => transition("rejected"), now);
}

export function armRequestSummary(record: ArmRequestRecord): Record<string, unknown> {
  return {
    requestId: record.requestId,
    projectId: record.projectId,
    projectName: record.projectName,
    sessionLabel: record.sessionLabel,
    clientName: record.clientLabel,
    clientLabel: record.clientLabel,
    reason: record.reason,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: record.status,
    resolvedAt: record.resolvedAt,
    resolution: record.resolution,
  };
}

/**
 * Find the controlling request for one project and stable requester identity.
 * An approved record wins over newer terminal noise so callers can first
 * verify whether its scoped control lease is still active. An approved record
 * is not itself a reusable grant: if that lease is missing or expired, the
 * caller must create a fresh pending request and require local approval again.
 */
export function findArmRequestForSession(
  requests: ArmRequestRecord[],
  projectId: string,
  sessionIdentity: string,
): ArmRequestRecord | undefined {
  const sessionKey = armSessionKey(sessionIdentity);
  const matches = [...requests]
    .filter((request) => request.projectId === projectId && request.sessionKey === sessionKey)
    .sort((a, b) => b.createdAt - a.createdAt);
  return matches.find((request) => request.status === "approved") ?? matches[0];
}
