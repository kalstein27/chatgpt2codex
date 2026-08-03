import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode, type Lease } from "../types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_RETAINED_REQUESTS = 100;

export type OperationRisk = "network" | "destructive";
export type OperationApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed";

export interface OperationApprovalRequest {
  requestId: string;
  status: OperationApprovalStatus;
  projectId: string;
  projectRoot: string;
  leaseId: string;
  leaseExpiresAt: number;
  tool: string;
  risk: OperationRisk;
  operationFingerprint: string;
  preview: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  consumedAt?: number;
}

interface OperationApprovalState {
  schemaVersion: 1;
  requests: OperationApprovalRequest[];
}

export interface EnsureOperationApprovalInput {
  stateDir: string;
  lease: Lease;
  tool: string;
  risk: OperationRisk;
  operation: unknown;
  preview: string;
  ttlMs?: number;
  now?: number;
}

export interface OperationAuthorization {
  requestId: string;
  scope: "once";
  operationFingerprint: string;
}

const locks = new Map<string, Promise<void>>();

function statePath(stateDir: string): string {
  return path.join(stateDir, "operation-approvals.json");
}

function emptyState(): OperationApprovalState {
  return { schemaVersion: STATE_SCHEMA_VERSION, requests: [] };
}

function normalizeText(value: string, fallback: string, max: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (normalized || fallback).slice(0, max);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function operationFingerprint(input: {
  projectId: string;
  projectRoot: string;
  leaseId: string;
  tool: string;
  risk: OperationRisk;
  operation: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify(stableValue(input))).digest("hex");
}

function validRequest(value: unknown): value is OperationApprovalRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<OperationApprovalRequest>;
  return (
    typeof request.requestId === "string" &&
    request.requestId.startsWith("op_") &&
    (request.status === "pending" || request.status === "approved" || request.status === "rejected" || request.status === "expired" || request.status === "consumed") &&
    typeof request.projectId === "string" &&
    typeof request.projectRoot === "string" &&
    typeof request.leaseId === "string" &&
    typeof request.leaseExpiresAt === "number" &&
    typeof request.tool === "string" &&
    (request.risk === "network" || request.risk === "destructive") &&
    typeof request.operationFingerprint === "string" &&
    typeof request.preview === "string" &&
    typeof request.createdAt === "number" &&
    typeof request.expiresAt === "number"
  );
}

function normalizeState(value: unknown): OperationApprovalState {
  if (!value || typeof value !== "object") return emptyState();
  const candidate = value as Partial<OperationApprovalState>;
  if (candidate.schemaVersion !== STATE_SCHEMA_VERSION) return emptyState();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    requests: Array.isArray(candidate.requests) ? candidate.requests.filter(validRequest) : [],
  };
}

async function readState(stateDir: string): Promise<OperationApprovalState> {
  try {
    return normalizeState(JSON.parse(await fs.readFile(statePath(stateDir), "utf8")));
  } catch {
    return emptyState();
  }
}

async function writeState(stateDir: string, state: OperationApprovalState): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(stateDir, DIR_MODE).catch(() => undefined);
  const destination = statePath(stateDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
  await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
  try {
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function withStateLock<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(stateDir);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

function cleanupState(state: OperationApprovalState, now: number): boolean {
  const before = JSON.stringify(state);
  for (const request of state.requests) {
    if ((request.status === "pending" || request.status === "approved") &&
        (request.expiresAt <= now || request.leaseExpiresAt <= now)) {
      request.status = "expired";
      request.resolvedAt = now;
    }
  }
  state.requests = state.requests
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_RETAINED_REQUESTS);
  return before !== JSON.stringify(state);
}

function requestDetails(request: OperationApprovalRequest, created: boolean): Record<string, unknown> {
  return {
    requestId: request.requestId,
    created,
    localApprovalRequired: true,
    projectId: request.projectId,
    tool: request.tool,
    risk: request.risk,
    preview: request.preview,
    expiresAt: request.expiresAt,
  };
}

export async function ensureOperationAuthorized(
  input: EnsureOperationApprovalInput,
): Promise<OperationAuthorization> {
  return withStateLock(input.stateDir, async () => {
    const now = input.now ?? Date.now();
    const state = await readState(input.stateDir);
    const changed = cleanupState(state, now);
    const fingerprint = operationFingerprint({
      projectId: input.lease.projectId,
      projectRoot: input.lease.projectRoot,
      leaseId: input.lease.leaseId,
      tool: input.tool,
      risk: input.risk,
      operation: input.operation,
    });

    const matching = state.requests.find((request) =>
      request.projectId === input.lease.projectId &&
      request.projectRoot === input.lease.projectRoot &&
      request.leaseId === input.lease.leaseId &&
      request.operationFingerprint === fingerprint,
    );

    if (matching?.status === "approved") {
      matching.status = "consumed";
      matching.consumedAt = now;
      await writeState(input.stateDir, state);
      return { requestId: matching.requestId, scope: "once", operationFingerprint: fingerprint };
    }

    if (matching?.status === "pending") {
      if (changed) await writeState(input.stateDir, state);
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        `Local approval is pending for ${input.tool}`,
        requestDetails(matching, false),
      );
    }

    const ttlMs = Math.min(DEFAULT_TTL_MS, Math.max(30_000, input.ttlMs ?? DEFAULT_TTL_MS));
    const request: OperationApprovalRequest = {
      requestId: `op_${randomUUID()}`,
      status: "pending",
      projectId: normalizeText(input.lease.projectId, "project", 120),
      projectRoot: input.lease.projectRoot,
      leaseId: input.lease.leaseId,
      leaseExpiresAt: input.lease.expiresAt,
      tool: normalizeText(input.tool, "operation", 80),
      risk: input.risk,
      operationFingerprint: fingerprint,
      preview: normalizeText(input.preview, "Protected operation", 320),
      createdAt: now,
      expiresAt: Math.min(now + ttlMs, input.lease.expiresAt),
    };
    state.requests.unshift(request);
    state.requests = state.requests.slice(0, MAX_RETAINED_REQUESTS);
    await writeState(input.stateDir, state);
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      `Local approval request created for ${input.tool}`,
      requestDetails(request, true),
    );
  });
}

export async function listOperationApprovalRequests(
  stateDir: string,
  now = Date.now(),
): Promise<OperationApprovalRequest[]> {
  return withStateLock(stateDir, async () => {
    const state = await readState(stateDir);
    if (cleanupState(state, now)) await writeState(stateDir, state);
    return [...state.requests].sort((left, right) => left.createdAt - right.createdAt);
  });
}

export async function resolveOperationApprovalRequest(input: {
  stateDir: string;
  requestId: string;
  decision: "approve" | "reject";
  now?: number;
}): Promise<OperationApprovalRequest> {
  return withStateLock(input.stateDir, async () => {
    const now = input.now ?? Date.now();
    const state = await readState(input.stateDir);
    cleanupState(state, now);
    const request = state.requests.find((entry) => entry.requestId === input.requestId);
    if (!request) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Operation approval request not found: ${input.requestId}`);
    if (request.status !== "pending") {
      throw new DomainError(ErrorCode.APPROVAL_REQUIRED, `Operation approval request is not pending: ${input.requestId}`, {
        requestId: input.requestId,
        status: request.status,
      });
    }
    request.status = input.decision === "approve" ? "approved" : "rejected";
    request.resolvedAt = now;
    await writeState(input.stateDir, state);
    return request;
  });
}

export function operationApprovalSummary(request: OperationApprovalRequest): Record<string, unknown> {
  return {
    requestId: request.requestId,
    status: request.status,
    projectId: request.projectId,
    tool: request.tool,
    risk: request.risk,
    preview: request.preview,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    resolvedAt: request.resolvedAt,
  };
}
