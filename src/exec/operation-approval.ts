import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode, type Lease } from "../types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_APPROVED_CONSUME_TTL_MS = 5 * 60 * 1000;
const MAX_RETAINED_REQUESTS = 100;

export type OperationRisk = "network" | "destructive" | "local-file-mutation";
export type OperationApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed";
export type OperationApprovalVia = "local-control-api" | "menu-bar-ui" | "mobile-ntfy" | "mobile-web" | "chatgpt-widget" | "chatgpt-widget-critical";
export type OperationApprovalSurface = "local" | "chatgpt-widget" | "chatgpt-widget-critical";

export function isChatGptWidgetApprovalSurface(surface: OperationApprovalSurface | undefined): boolean {
  return surface === "chatgpt-widget" || surface === "chatgpt-widget-critical";
}

const MOBILE_APPROVABLE_OPERATION_TOOLS = new Set([
  "command_run",
  "verified_local_file_apply",
]);

export function isMobileApprovableOperationTool(tool: string): boolean {
  return MOBILE_APPROVABLE_OPERATION_TOOLS.has(tool);
}

export interface OperationApprovalRequest {
  requestId: string;
  status: OperationApprovalStatus;
  projectId: string;
  projectRoot: string;
  leaseId: string;
  leaseExpiresAt: number;
  /** Capability preset held when this exact approval request was created. */
  leasePreset?: Lease["preset"];
  tool: string;
  risk: OperationRisk;
  operationFingerprint: string;
  preview: string;
  summary?: string;
  impact?: string;
  details?: string;
  originOperationId?: string;
  approvalSurface?: OperationApprovalSurface;
  chatGptSessionScopeDigest?: string;
  createdAt: number;
  expiresAt: number;
  consumeExpiresAt?: number;
  resolvedAt?: number;
  consumedAt?: number;
  approvedVia?: OperationApprovalVia;
}

function chatGptSessionScopeDigest(sessionScope: string): string {
  return createHash("sha256")
    .update("chatgpt-operation-approval-session\0")
    .update(sessionScope)
    .digest("hex");
}

export function operationApprovalBelongsToChatGptSession(
  request: OperationApprovalRequest,
  sessionScope: string,
): boolean {
  return request.chatGptSessionScopeDigest === chatGptSessionScopeDigest(sessionScope);
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
  originOperationId?: string;
  approvalSurface?: OperationApprovalSurface;
  /**
   * Exact persisted approval request already linked by an immutable operation
   * receipt. This is the only supported way to resume an approval after a
   * serial lease identity rotates. The operation is re-fingerprinted using the
   * original request lease id before the grant can match.
   */
  resumeRequestId?: string;
  /** Current ChatGPT session scope used only to verify an existing hashed binding. */
  resumeSessionScope?: string;
  ttlMs?: number;
  now?: number;
  requiredApprovalVia?: OperationApprovalVia;
}

export interface WaitForOperationAuthorizationInput extends EnsureOperationApprovalInput {
  requestId: string;
  pollIntervalMs?: number;
  shouldAbort?: () => boolean;
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

function normalizeDetails(value: string, fallback: string, max: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim();
  return (normalized || fallback).slice(0, max);
}

function operationSummary(tool: string, projectId: string, operation?: unknown): string {
  const record = operation && typeof operation === "object" && !Array.isArray(operation)
    ? operation as Record<string, unknown>
    : undefined;
  const commandId = typeof record?.commandId === "string"
    ? normalizeText(record.commandId, "command", 80)
    : undefined;
  switch (tool) {
    case "command_run":
      return commandId
        ? `프로젝트 ${projectId} · 허용 명령 “${commandId}” 1회 실행`
        : `프로젝트 ${projectId} · 허용 명령 1회 실행`;
    case "e2e_run_command":
      return `프로젝트 ${projectId} · E2E 검증 명령 1회 실행`;
    case "e2e_start_server":
      return `프로젝트 ${projectId} · 로컬 E2E 서버 시작`;
    case "operation_cancel":
      return `프로젝트 ${projectId} · 실행 작업 취소`;
    case "verified_local_file_apply":
      return `프로젝트 ${projectId} · 검증 로컬 파일 고정 대상 적용`;
    case "runtime_apply_local":
      return `프로젝트 ${projectId} · 검증된 C2CT runtime 교체`;
    case "macos_app_apply_local":
      return `프로젝트 ${projectId} · 검증된 ChatGPT To Codex 앱 설치`;
    case "runtime_snapshot_prune_local":
      return `프로젝트 ${projectId} · 오래된 비보호 runtime snapshot 정리`;
    case "project_lane_recover":
      return `프로젝트 ${projectId} · 비활성 작업 lane 잠금 정리`;
    case "mobile_approval_setup":
      return `프로젝트 ${projectId} · 모바일 승인 연결 설정 변경`;
    default:
      return `프로젝트 ${projectId} · 보호 작업 “${normalizeText(tool, "operation", 80)}” 1회 수행`;
  }
}

function operationImpact(risk: OperationRisk): string {
  if (risk === "network") return "외부 네트워크 통신 가능";
  if (risk === "local-file-mutation") return "검증 범위 로컬 파일 변경";
  return "파일 교체·삭제·작업 취소 등 되돌리기 어려운 변경 가능";
}

function approvalDisplay(request: OperationApprovalRequest): { summary: string; impact: string; details: string } {
  return {
    summary: request.summary ?? operationSummary(request.tool, request.projectId),
    impact: request.impact ?? operationImpact(request.risk),
    details: request.details ?? request.preview,
  };
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
    (request.leasePreset === undefined ||
      request.leasePreset === "read-only" ||
      request.leasePreset === "tests-only" ||
      request.leasePreset === "full-write" ||
      request.leasePreset === "image-only" ||
      request.leasePreset === "control") &&
    typeof request.tool === "string" &&
    (request.risk === "network" || request.risk === "destructive" || request.risk === "local-file-mutation") &&
    typeof request.operationFingerprint === "string" &&
    typeof request.preview === "string" &&
    (request.summary === undefined || typeof request.summary === "string") &&
    (request.impact === undefined || typeof request.impact === "string") &&
    (request.details === undefined || typeof request.details === "string") &&
    (request.originOperationId === undefined || typeof request.originOperationId === "string") &&
    (request.approvalSurface === undefined || request.approvalSurface === "local" || request.approvalSurface === "chatgpt-widget" || request.approvalSurface === "chatgpt-widget-critical") &&
    (request.chatGptSessionScopeDigest === undefined || /^[a-f0-9]{64}$/u.test(request.chatGptSessionScopeDigest)) &&
    typeof request.createdAt === "number" &&
    typeof request.expiresAt === "number" &&
    (request.approvedVia === undefined ||
      request.approvedVia === "local-control-api" ||
      request.approvedVia === "menu-bar-ui" ||
      request.approvedVia === "mobile-ntfy" ||
      request.approvedVia === "mobile-web" ||
      request.approvedVia === "chatgpt-widget" ||
      request.approvedVia === "chatgpt-widget-critical")
  );
}

export async function bindOperationApprovalToChatGptSession(input: {
  stateDir: string;
  requestId: string;
  sessionScope: string;
  now?: number;
}): Promise<OperationApprovalRequest> {
  return withStateLock(input.stateDir, async () => {
    const now = input.now ?? Date.now();
    const state = await readState(input.stateDir);
    const changed = cleanupState(state, now);
    const request = state.requests.find((entry) => entry.requestId === input.requestId);
    if (!request) {
      if (changed) await writeState(input.stateDir, state);
      throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, `Operation approval request not found: ${input.requestId}`);
    }
    const approvalSurface = request.approvalSurface ?? "local";
    if (request.status !== "pending" ||
        (approvalSurface !== "chatgpt-widget" && approvalSurface !== "chatgpt-widget-critical")) {
      if (changed) await writeState(input.stateDir, state);
      throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "Operation approval is not pending on a ChatGPT widget surface", {
        requestId: request.requestId,
        status: request.status,
        approvalSurface,
      });
    }
    const digest = chatGptSessionScopeDigest(input.sessionScope);
    if (request.chatGptSessionScopeDigest && request.chatGptSessionScopeDigest !== digest) {
      if (changed) await writeState(input.stateDir, state);
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Operation approval belongs to another ChatGPT session", {
        requestId: request.requestId,
      });
    }
    if (request.chatGptSessionScopeDigest !== digest) {
      request.chatGptSessionScopeDigest = digest;
      await writeState(input.stateDir, state);
    } else if (changed) {
      await writeState(input.stateDir, state);
    }
    return request;
  });
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
  let changed = false;
  for (const request of state.requests) {
    const activeDeadline = request.status === "approved"
      ? (request.consumeExpiresAt ?? request.expiresAt)
      : request.expiresAt;
    if ((request.status === "pending" || request.status === "approved") &&
        (activeDeadline <= now || request.leaseExpiresAt <= now)) {
      request.status = "expired";
      request.resolvedAt = now;
      changed = true;
    }
  }
  let ordered = true;
  for (let index = 1; index < state.requests.length; index += 1) {
    if (state.requests[index - 1]!.createdAt < state.requests[index]!.createdAt) {
      ordered = false;
      break;
    }
  }
  if (!ordered) {
    state.requests.sort((left, right) => right.createdAt - left.createdAt);
    changed = true;
  }
  if (state.requests.length > MAX_RETAINED_REQUESTS) {
    state.requests.length = MAX_RETAINED_REQUESTS;
    changed = true;
  }
  return changed;
}

function requestDetails(request: OperationApprovalRequest, created: boolean): Record<string, unknown> {
  const approvalSurface = request.approvalSurface ?? "local";
  const display = approvalDisplay(request);
  return {
    requestId: request.requestId,
    created,
    localApprovalRequired: approvalSurface === "local",
    approvalSurface,
    projectId: request.projectId,
    tool: request.tool,
    risk: request.risk,
    preview: display.summary,
    summary: display.summary,
    impact: display.impact,
    details: display.details,
    ...(request.originOperationId ? { originOperationId: request.originOperationId } : {}),
    createdAt: request.createdAt,
    expiresAt: request.status === "approved" ? (request.consumeExpiresAt ?? request.expiresAt) : request.expiresAt,
    pendingExpiresAt: request.expiresAt,
    consumeExpiresAt: request.consumeExpiresAt ?? null,
  };
}

export async function ensureOperationAuthorized(
  input: EnsureOperationApprovalInput,
): Promise<OperationAuthorization> {
  return withStateLock(input.stateDir, async () => {
    const now = input.now ?? Date.now();
    const state = await readState(input.stateDir);
    const changed = cleanupState(state, now);
    const approvalSurface = input.approvalSurface ?? "local";
    const fingerprint = operationFingerprint({
      projectId: input.lease.projectId,
      projectRoot: input.lease.projectRoot,
      leaseId: input.lease.leaseId,
      tool: input.tool,
      risk: input.risk,
      operation: input.operation,
    });

    let matching = state.requests.find((request) =>
      request.projectId === input.lease.projectId &&
      request.projectRoot === input.lease.projectRoot &&
      request.leaseId === input.lease.leaseId &&
      (request.approvalSurface ?? "local") === approvalSurface &&
      request.operationFingerprint === fingerprint,
    );

    if (!matching && input.resumeRequestId) {
      const resumeRequest = state.requests.find((request) => request.requestId === input.resumeRequestId);
      if (resumeRequest) {
        const resumeFingerprint = operationFingerprint({
          projectId: input.lease.projectId,
          projectRoot: input.lease.projectRoot,
          leaseId: resumeRequest.leaseId,
          tool: input.tool,
          risk: input.risk,
          operation: input.operation,
        });
        const sessionMatches = !resumeRequest.chatGptSessionScopeDigest ||
          (typeof input.resumeSessionScope === "string" &&
            resumeRequest.chatGptSessionScopeDigest === chatGptSessionScopeDigest(input.resumeSessionScope));
        const bindingMatches =
          resumeRequest.projectId === input.lease.projectId &&
          resumeRequest.projectRoot === input.lease.projectRoot &&
          resumeRequest.tool === input.tool &&
          resumeRequest.risk === input.risk &&
          (resumeRequest.approvalSurface ?? "local") === approvalSurface &&
          resumeRequest.operationFingerprint === resumeFingerprint &&
          sessionMatches;
        if (!bindingMatches) {
          if (changed) await writeState(input.stateDir, state);
          throw new DomainError(
            ErrorCode.PERMISSION_DENIED,
            `Receipt-bound approval no longer matches the exact ${input.tool} operation`,
            {
              requestId: resumeRequest.requestId,
              blockedAt: "c2ct-approval",
              actionStarted: false,
              subprocessStarted: false,
            },
          );
        }
        matching = resumeRequest;
      }
    }

    if (matching?.status === "approved" &&
        (!input.requiredApprovalVia || matching.approvedVia === input.requiredApprovalVia)) {
      matching.status = "consumed";
      matching.consumedAt = now;
      await writeState(input.stateDir, state);
      return { requestId: matching.requestId, scope: "once", operationFingerprint: fingerprint };
    }

    if (matching?.status === "approved") {
      if (changed) await writeState(input.stateDir, state);
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        `Approval for ${input.tool} did not come from the required local UI`,
        {
          ...requestDetails(matching, false),
          requiredApprovalVia: input.requiredApprovalVia,
          approvedVia: matching.approvedVia ?? null,
        },
      );
    }

    if (matching?.status === "pending") {
      if (changed) await writeState(input.stateDir, state);
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        `Approval is pending for ${input.tool}`,
        requestDetails(matching, false),
      );
    }

    const ttlMs = Math.min(DEFAULT_TTL_MS, Math.max(30_000, input.ttlMs ?? DEFAULT_TTL_MS));
    const summary = normalizeText(
      operationSummary(input.tool, input.lease.projectId, input.operation),
      "보호 작업 1회 수행",
      200,
    );
    const impact = normalizeText(operationImpact(input.risk), "승인 범위 시스템 상태 변경 가능", 200);
    const details = normalizeDetails(input.preview, "상세 정보 없음", 4096);
    const request: OperationApprovalRequest = {
      requestId: `op_${randomUUID()}`,
      status: "pending",
      projectId: normalizeText(input.lease.projectId, "project", 120),
      projectRoot: input.lease.projectRoot,
      leaseId: input.lease.leaseId,
      leaseExpiresAt: input.lease.expiresAt,
      leasePreset: input.lease.preset,
      tool: normalizeText(input.tool, "operation", 80),
      risk: input.risk,
      operationFingerprint: fingerprint,
      preview: summary,
      summary,
      impact,
      details,
      ...(input.originOperationId
        ? { originOperationId: normalizeText(input.originOperationId, "operation", 120) }
        : {}),
      approvalSurface,
      createdAt: now,
      expiresAt: Math.min(now + ttlMs, input.lease.expiresAt),
    };
    state.requests.unshift(request);
    state.requests = state.requests.slice(0, MAX_RETAINED_REQUESTS);
    await writeState(input.stateDir, state);
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      `Approval request created for ${input.tool}`,
      requestDetails(request, true),
    );
  });
}

function approvalFingerprint(input: EnsureOperationApprovalInput): string {
  return operationFingerprint({
    projectId: input.lease.projectId,
    projectRoot: input.lease.projectRoot,
    leaseId: input.lease.leaseId,
    tool: input.tool,
    risk: input.risk,
    operation: input.operation,
  });
}

export async function waitForOperationAuthorization(
  input: WaitForOperationAuthorizationInput,
): Promise<OperationAuthorization> {
  const pollIntervalMs = Math.min(1_000, Math.max(10, input.pollIntervalMs ?? 100));
  const fingerprint = approvalFingerprint(input);

  for (;;) {
    if (input.shouldAbort?.()) {
      await withStateLock(input.stateDir, async () => {
        const now = Date.now();
        const state = await readState(input.stateDir);
        const changed = cleanupState(state, now);
        const request = state.requests.find((entry) => entry.requestId === input.requestId);
        const exactBinding = request &&
          request.projectId === input.lease.projectId &&
          request.projectRoot === input.lease.projectRoot &&
          request.leaseId === input.lease.leaseId &&
          request.tool === input.tool &&
          request.risk === input.risk &&
          request.operationFingerprint === fingerprint;
        if (exactBinding && (request.status === "pending" || request.status === "approved")) {
          request.status = "rejected";
          request.resolvedAt = now;
          await writeState(input.stateDir, state);
        } else if (changed) {
          await writeState(input.stateDir, state);
        }
      });
      throw new DomainError(
        ErrorCode.PERMISSION_DENIED,
        `Client cancelled ${input.tool} while local approval was pending`,
        {
          requestId: input.requestId,
          approvalStatus: "client-cancelled",
          blockedAt: "c2ct-approval",
          actionStarted: false,
          subprocessStarted: false,
        },
      );
    }

    const outcome = await withStateLock(input.stateDir, async () => {
      const now = Date.now();
      const state = await readState(input.stateDir);
      const changed = cleanupState(state, now);
      const request = state.requests.find((entry) => entry.requestId === input.requestId);
      if (!request) {
        if (changed) await writeState(input.stateDir, state);
        throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, `Operation approval request not found: ${input.requestId}`, {
          requestId: input.requestId,
          blockedAt: "c2ct-approval",
          actionStarted: false,
          subprocessStarted: false,
        });
      }
      if (
        request.projectId !== input.lease.projectId ||
        request.projectRoot !== input.lease.projectRoot ||
        request.leaseId !== input.lease.leaseId ||
        request.tool !== input.tool ||
        request.risk !== input.risk ||
        request.operationFingerprint !== fingerprint
      ) {
        if (changed) await writeState(input.stateDir, state);
        throw new DomainError(ErrorCode.PERMISSION_DENIED, "Operation approval binding changed while waiting", {
          requestId: input.requestId,
          approvalStatus: request.status,
          blockedAt: "c2ct-approval",
          actionStarted: false,
          subprocessStarted: false,
        });
      }
      if (request.status === "approved") {
        if (input.requiredApprovalVia && request.approvedVia !== input.requiredApprovalVia) {
          if (changed) await writeState(input.stateDir, state);
          throw new DomainError(
            ErrorCode.APPROVAL_REQUIRED,
            `Approval for ${input.tool} did not come from the required local UI`,
            {
              ...requestDetails(request, false),
              requiredApprovalVia: input.requiredApprovalVia,
              approvedVia: request.approvedVia ?? null,
            },
          );
        }
        request.status = "consumed";
        request.consumedAt = now;
        await writeState(input.stateDir, state);
        return {
          kind: "authorized" as const,
          authorization: { requestId: request.requestId, scope: "once" as const, operationFingerprint: fingerprint },
        };
      }
      if (request.status === "rejected") {
        if (changed) await writeState(input.stateDir, state);
        throw new DomainError(ErrorCode.PERMISSION_DENIED, `Local approval was rejected for ${input.tool}`, {
          ...requestDetails(request, false),
          approvalStatus: "rejected",
          blockedAt: "c2ct-approval",
          actionStarted: false,
          subprocessStarted: false,
        });
      }
      if (request.status === "expired") {
        if (changed) await writeState(input.stateDir, state);
        throw new DomainError(ErrorCode.APPROVAL_REQUIRED, `Local approval expired for ${input.tool}`, {
          ...requestDetails(request, false),
          approvalStatus: "expired",
          blockedAt: "c2ct-approval",
          actionStarted: false,
          subprocessStarted: false,
        });
      }
      if (request.status === "consumed") {
        if (changed) await writeState(input.stateDir, state);
        throw new DomainError(ErrorCode.PERMISSION_DENIED, `Local approval was already consumed for ${input.tool}`, {
          ...requestDetails(request, false),
          approvalStatus: "consumed",
          blockedAt: "c2ct-approval",
          actionStarted: false,
          subprocessStarted: false,
        });
      }
      if (changed) await writeState(input.stateDir, state);
      return { kind: "pending" as const, expiresAt: request.expiresAt };
    });

    if (outcome.kind === "authorized") return outcome.authorization;
    const delayMs = Math.max(1, Math.min(pollIntervalMs, outcome.expiresAt - Date.now()));
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
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
  approvedVia?: OperationApprovalVia;
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
    const approvalVia = input.approvedVia ?? "local-control-api";
    const approvalSurface = request.approvalSurface ?? "local";
    const widgetApprovalVia = approvalSurface === "chatgpt-widget-critical"
      ? "chatgpt-widget-critical"
      : approvalSurface === "chatgpt-widget"
        ? "chatgpt-widget"
        : null;
    const localOwnerReject = input.decision === "reject" && approvalVia === "local-control-api";
    const localRuntimeApplyApproval =
      input.decision === "approve" &&
      approvalVia === "menu-bar-ui" &&
      request.tool === "runtime_apply_local";
    if (widgetApprovalVia && approvalVia !== widgetApprovalVia && !localOwnerReject && !localRuntimeApplyApproval) {
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        "ChatGPT widget approval requests can only be approved from their bound ChatGPT widget surface, except the runtime_apply_local menu-bar fallback; the local owner may reject a pending request for recovery",
        {
          requestId: input.requestId,
          tool: request.tool,
          approvalSurface,
          approvedVia: approvalVia,
          requiredApprovalVia: widgetApprovalVia,
        },
      );
    }
    if ((approvalVia === "mobile-ntfy" || approvalVia === "mobile-web") &&
        !isMobileApprovableOperationTool(request.tool)) {
      throw new DomainError(
        ErrorCode.PERMISSION_DENIED,
        "Mobile approval is allowed only for explicitly mobile-approvable exact operations",
        { requestId: input.requestId, tool: request.tool },
      );
    }
    if (input.decision === "approve" &&
        request.tool === "runtime_apply_local" &&
        approvalVia !== "menu-bar-ui" &&
        approvalVia !== "chatgpt-widget-critical") {
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        "Runtime apply requires either the local menu-bar approval or the session-bound critical ChatGPT approval surface",
        {
          requestId: input.requestId,
          tool: request.tool,
          requiredApprovalVia: ["menu-bar-ui", "chatgpt-widget-critical"],
        },
      );
    }
    if (input.decision === "approve" &&
        approvalVia === "menu-bar-ui" &&
        request.tool !== "runtime_apply_local") {
      throw new DomainError(
        ErrorCode.INVALID_ARGUMENT,
        "The runtime-apply menu approval endpoint only accepts runtime_apply_local requests",
        { requestId: input.requestId, tool: request.tool },
      );
    }
    request.status = input.decision === "approve" ? "approved" : "rejected";
    if (input.decision === "approve") {
      request.approvedVia = approvalVia;
      request.consumeExpiresAt = Math.min(now + DEFAULT_APPROVED_CONSUME_TTL_MS, request.leaseExpiresAt);
    }
    request.resolvedAt = now;
    await writeState(input.stateDir, state);
    return request;
  });
}

export function operationApprovalSummary(request: OperationApprovalRequest): Record<string, unknown> {
  const display = approvalDisplay(request);
  return {
    requestId: request.requestId,
    status: request.status,
    projectId: request.projectId,
    tool: request.tool,
    risk: request.risk,
    preview: display.summary,
    summary: display.summary,
    impact: display.impact,
    details: display.details,
    approvalSurface: request.approvalSurface ?? "local",
    ...(request.originOperationId ? { originOperationId: request.originOperationId } : {}),
    createdAt: request.createdAt,
    expiresAt: request.status === "approved" ? (request.consumeExpiresAt ?? request.expiresAt) : request.expiresAt,
    pendingExpiresAt: request.expiresAt,
    consumeExpiresAt: request.consumeExpiresAt,
    resolvedAt: request.resolvedAt,
    approvedVia: request.approvedVia,
  };
}
