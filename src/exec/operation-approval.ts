import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode, type Lease } from "../types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_RETAINED_REQUESTS = 100;

export type OperationRisk = "network" | "destructive" | "local-file-mutation";
export type OperationApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed";
export type OperationApprovalVia = "local-control-api" | "menu-bar-ui" | "mobile-ntfy" | "mobile-web" | "chatgpt-widget";
export type OperationApprovalSurface = "local" | "chatgpt-widget";

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
  tool: string;
  risk: OperationRisk;
  operationFingerprint: string;
  preview: string;
  summary?: string;
  impact?: string;
  details?: string;
  originOperationId?: string;
  approvalSurface?: OperationApprovalSurface;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  consumedAt?: number;
  approvedVia?: OperationApprovalVia;
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
        ? `프로젝트 ${projectId}에서 허용된 명령 “${commandId}”을 1회 실행합니다.`
        : `프로젝트 ${projectId}에서 허용된 명령을 1회 실행합니다.`;
    case "e2e_run_command":
      return `프로젝트 ${projectId}에서 E2E 검증 명령을 1회 실행합니다.`;
    case "e2e_start_server":
      return `프로젝트 ${projectId}의 로컬 E2E 서버를 시작합니다.`;
    case "operation_cancel":
      return `프로젝트 ${projectId}에서 실행 중인 작업을 취소합니다.`;
    case "verified_local_file_apply":
      return `프로젝트 ${projectId}의 검증된 로컬 파일을 고정된 대상 위치에 적용합니다.`;
    case "runtime_apply_local":
      return `프로젝트 ${projectId}의 검증된 C2CT 런타임으로 교체합니다.`;
    case "macos_app_apply_local":
      return `프로젝트 ${projectId}에서 검증된 ChatGPT To Codex 앱을 설치합니다.`;
    case "runtime_snapshot_prune_local":
      return `프로젝트 ${projectId}의 보호 대상이 아닌 오래된 런타임 스냅샷을 정리합니다.`;
    case "project_lane_recover":
      return `프로젝트 ${projectId}의 비활성 작업 lane 잠금을 안전하게 정리합니다.`;
    case "mobile_approval_setup":
      return `프로젝트 ${projectId}의 모바일 승인 연결 설정을 변경합니다.`;
    default:
      return `프로젝트 ${projectId}에서 보호 작업 “${normalizeText(tool, "operation", 80)}”을 1회 수행합니다.`;
  }
}

function operationImpact(risk: OperationRisk): string {
  if (risk === "network") return "외부 네트워크 통신이 발생할 수 있습니다.";
  if (risk === "local-file-mutation") return "검증된 범위의 로컬 파일이 변경됩니다.";
  return "파일 교체·삭제·작업 취소 등 되돌리기 어려운 변경이 발생할 수 있습니다.";
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
    typeof request.tool === "string" &&
    (request.risk === "network" || request.risk === "destructive" || request.risk === "local-file-mutation") &&
    typeof request.operationFingerprint === "string" &&
    typeof request.preview === "string" &&
    (request.summary === undefined || typeof request.summary === "string") &&
    (request.impact === undefined || typeof request.impact === "string") &&
    (request.details === undefined || typeof request.details === "string") &&
    (request.originOperationId === undefined || typeof request.originOperationId === "string") &&
    (request.approvalSurface === undefined || request.approvalSurface === "local" || request.approvalSurface === "chatgpt-widget") &&
    typeof request.createdAt === "number" &&
    typeof request.expiresAt === "number" &&
    (request.approvedVia === undefined ||
      request.approvedVia === "local-control-api" ||
      request.approvedVia === "menu-bar-ui" ||
      request.approvedVia === "mobile-ntfy" ||
      request.approvedVia === "mobile-web" ||
      request.approvedVia === "chatgpt-widget")
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
    const approvalSurface = input.approvalSurface ?? "local";
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
      (request.approvalSurface ?? "local") === approvalSurface &&
      request.operationFingerprint === fingerprint,
    );

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
      "보호 작업을 1회 수행합니다.",
      200,
    );
    const impact = normalizeText(operationImpact(input.risk), "승인된 범위에서 시스템 상태가 변경될 수 있습니다.", 200);
    const details = normalizeDetails(input.preview, "상세 정보 없음", 4096);
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
    if (approvalSurface === "chatgpt-widget" && approvalVia !== "chatgpt-widget") {
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        "ChatGPT widget approval requests can only be resolved from the ChatGPT widget",
        {
          requestId: input.requestId,
          tool: request.tool,
          approvalSurface,
          approvedVia: approvalVia,
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
        approvalVia !== "menu-bar-ui") {
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        "Runtime apply must be approved from the ChatGPT To Codex menu-bar UI",
        {
          requestId: input.requestId,
          tool: request.tool,
          requiredApprovalVia: "menu-bar-ui",
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
    if (input.decision === "approve") request.approvedVia = approvalVia;
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
    expiresAt: request.expiresAt,
    resolvedAt: request.resolvedAt,
    approvedVia: request.approvedVia,
  };
}
