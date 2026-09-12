import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError, ErrorCode } from "../types.js";

interface WidgetApprovalGrant {
  requestId: string;
  tokenHash: Buffer;
  sessionScope?: string;
  expiresAt: number;
}

const MAX_WIDGET_APPROVAL_GRANTS_PER_REQUEST = 8;
const grants = new Map<string, WidgetApprovalGrant[]>();

const CHATGPT_WIDGET_APPROVABLE_OPERATION_TOOLS = new Set([
  "command_request",
  "command_run",
  "e2e_run_command",
  "e2e_start_server",
  "local_shell_run",
  "operation_cancel",
  "runtime_snapshot_prune_local",
  "scheduled_goal_create",
  "verified_local_file_apply",
]);

const CHATGPT_WIDGET_CRITICAL_OPERATION_TOOLS = new Set([
  "runtime_apply_local",
  "macos_app_apply_local",
]);

export type ChatGptWidgetApprovalMode = "standard" | "critical";

export function chatGptWidgetApprovalMode(tool: string, risk?: string): ChatGptWidgetApprovalMode | null {
  if (tool === "command_request" && risk === "destructive-privileged") return "critical";
  if (CHATGPT_WIDGET_CRITICAL_OPERATION_TOOLS.has(tool)) return "critical";
  if (CHATGPT_WIDGET_APPROVABLE_OPERATION_TOOLS.has(tool)) return "standard";
  return null;
}

export function isChatGptWidgetApprovableOperationTool(tool: string): boolean {
  return CHATGPT_WIDGET_APPROVABLE_OPERATION_TOOLS.has(tool);
}

function grantKey(requestId: string): string {
  return requestId;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function prune(now = Date.now()): void {
  for (const [key, requestGrants] of grants) {
    const active = requestGrants.filter((grant) => grant.expiresAt > now);
    if (active.length === 0) grants.delete(key);
    else if (active.length !== requestGrants.length) grants.set(key, active);
  }
}

export function mintChatGptWidgetApprovalToken(input: {
  requestId: string;
  sessionScope?: string;
  expiresAt: number;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  prune(now);
  if (input.expiresAt <= now) {
    throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "Approval request already expired", {
      requestId: input.requestId,
      expiresAt: input.expiresAt,
    });
  }
  const token = randomBytes(32).toString("base64url");
  const key = grantKey(input.requestId);
  const requestGrants = grants.get(key) ?? [];
  const nextGrant: WidgetApprovalGrant = {
    requestId: input.requestId,
    tokenHash: hashToken(token),
    ...(input.sessionScope ? { sessionScope: input.sessionScope } : {}),
    expiresAt: input.expiresAt,
  };
  grants.set(key, [...requestGrants, nextGrant].slice(-MAX_WIDGET_APPROVAL_GRANTS_PER_REQUEST));
  return token;
}

function requireMatchingGrant(input: {
  requestId: string;
  token: string;
  sessionScope?: string;
  now?: number;
}): WidgetApprovalGrant {
  const now = input.now ?? Date.now();
  prune(now);
  const key = grantKey(input.requestId);
  const requestGrants = grants.get(key);
  if (!requestGrants || requestGrants.length === 0) {
    grants.delete(key);
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "ChatGPT approval widget token is missing or expired", {
      requestId: input.requestId,
    });
  }
  const scopedGrants = requestGrants.filter((grant) => !grant.sessionScope || grant.sessionScope === input.sessionScope);
  if (scopedGrants.length === 0) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "ChatGPT approval widget token belongs to another conversation", {
      requestId: input.requestId,
    });
  }
  const supplied = hashToken(input.token);
  const grant = scopedGrants.find((candidate) =>
    supplied.length === candidate.tokenHash.length && timingSafeEqual(supplied, candidate.tokenHash),
  );
  if (!grant) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Invalid ChatGPT approval widget token", {
      requestId: input.requestId,
    });
  }
  return grant;
}

export function consumeChatGptWidgetApprovalToken(input: {
  requestId: string;
  token: string;
  sessionScope?: string;
  now?: number;
}): void {
  requireMatchingGrant(input);
  grants.delete(grantKey(input.requestId));
}

export function validateChatGptWidgetApprovalToken(input: {
  requestId: string;
  token: string;
  sessionScope?: string;
  now?: number;
}): void {
  requireMatchingGrant(input);
}

export function clearChatGptWidgetApprovalToken(requestId: string): void {
  grants.delete(grantKey(requestId));
}
