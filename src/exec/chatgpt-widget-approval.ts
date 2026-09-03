import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError, ErrorCode } from "../types.js";

interface WidgetApprovalGrant {
  requestId: string;
  tokenHash: Buffer;
  sessionScope?: string;
  expiresAt: number;
}

const grants = new Map<string, WidgetApprovalGrant>();

const CHATGPT_WIDGET_APPROVABLE_OPERATION_TOOLS = new Set([
  "command_run",
  "e2e_run_command",
  "e2e_start_server",
  "operation_cancel",
  "verified_local_file_apply",
]);

const CHATGPT_WIDGET_CRITICAL_OPERATION_TOOLS = new Set([
  "runtime_apply_local",
  "macos_app_apply_local",
]);

export type ChatGptWidgetApprovalMode = "standard" | "critical";

export function chatGptWidgetApprovalMode(tool: string): ChatGptWidgetApprovalMode | null {
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
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(key);
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
  grants.set(grantKey(input.requestId), {
    requestId: input.requestId,
    tokenHash: hashToken(token),
    ...(input.sessionScope ? { sessionScope: input.sessionScope } : {}),
    expiresAt: input.expiresAt,
  });
  return token;
}

export function consumeChatGptWidgetApprovalToken(input: {
  requestId: string;
  token: string;
  sessionScope?: string;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  prune(now);
  const key = grantKey(input.requestId);
  const grant = grants.get(key);
  if (!grant || grant.expiresAt <= now) {
    grants.delete(key);
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "ChatGPT approval widget token is missing or expired", {
      requestId: input.requestId,
    });
  }
  if (grant.sessionScope && grant.sessionScope !== input.sessionScope) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "ChatGPT approval widget token belongs to another conversation", {
      requestId: input.requestId,
    });
  }
  const supplied = hashToken(input.token);
  if (supplied.length !== grant.tokenHash.length || !timingSafeEqual(supplied, grant.tokenHash)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Invalid ChatGPT approval widget token", {
      requestId: input.requestId,
    });
  }
  grants.delete(key);
}

export function validateChatGptWidgetApprovalToken(input: {
  requestId: string;
  token: string;
  sessionScope?: string;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  prune(now);
  const key = grantKey(input.requestId);
  const grant = grants.get(key);
  if (!grant || grant.expiresAt <= now) {
    grants.delete(key);
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "ChatGPT approval widget token is missing or expired", {
      requestId: input.requestId,
    });
  }
  if (grant.sessionScope && grant.sessionScope !== input.sessionScope) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "ChatGPT approval widget token belongs to another conversation", {
      requestId: input.requestId,
    });
  }
  const supplied = hashToken(input.token);
  if (supplied.length !== grant.tokenHash.length || !timingSafeEqual(supplied, grant.tokenHash)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Invalid ChatGPT approval widget token", {
      requestId: input.requestId,
    });
  }
}

export function clearChatGptWidgetApprovalToken(requestId: string): void {
  grants.delete(grantKey(requestId));
}
