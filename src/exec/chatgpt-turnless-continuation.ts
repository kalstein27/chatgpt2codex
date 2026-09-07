import { createHash } from "node:crypto";
import { DomainError, ErrorCode } from "../types.js";

export interface ChatGptTurnlessContinuationResult {
  turnlessContinuation: true;
  continuationStarted: boolean;
  fallbackRequiresExactReplay: boolean;
  actionStarted: boolean;
  subprocessStarted: boolean;
  continuationReason?: string;
  operationId?: string;
  approvalRequestId?: string;
  sideEffects?: string;
  [key: string]: unknown;
}

interface RegisteredContinuation {
  requestId: string;
  tool: string;
  sessionScopeDigest: string;
  expiresAt: number;
  run: () => Promise<ChatGptTurnlessContinuationResult>;
  resultPromise?: Promise<ChatGptTurnlessContinuationResult>;
}

const continuations = new Map<string, RegisteredContinuation>();

function digestSessionScope(sessionScope: string): string {
  return createHash("sha256").update(sessionScope).digest("hex");
}

function prune(now = Date.now()): void {
  for (const [requestId, entry] of continuations) {
    if (entry.expiresAt <= now && !entry.resultPromise) continuations.delete(requestId);
  }
}

export function registerChatGptTurnlessContinuation(input: {
  requestId: string;
  tool: string;
  sessionScope: string;
  expiresAt: number;
  run: () => Promise<ChatGptTurnlessContinuationResult>;
}): void {
  prune();
  const existing = continuations.get(input.requestId);
  const sessionScopeDigest = digestSessionScope(input.sessionScope);
  if (existing) {
    if (existing.tool !== input.tool || existing.sessionScopeDigest !== sessionScopeDigest) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Turnless continuation request is already bound to another operation", {
        requestId: input.requestId,
        tool: input.tool,
      });
    }
    if (existing.resultPromise) return;
  }
  continuations.set(input.requestId, {
    requestId: input.requestId,
    tool: input.tool,
    sessionScopeDigest,
    expiresAt: input.expiresAt,
    run: input.run,
  });
}

export function hasChatGptTurnlessContinuation(input: {
  requestId: string;
  tool: string;
  sessionScope?: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  prune(now);
  const entry = continuations.get(input.requestId);
  if (!entry || entry.tool !== input.tool || entry.expiresAt <= now) return false;
  if (input.sessionScope && entry.sessionScopeDigest !== digestSessionScope(input.sessionScope)) return false;
  return true;
}

export async function continueRegisteredChatGptTurnlessOperation(input: {
  requestId: string;
  tool: string;
  sessionScope?: string;
  now?: number;
}): Promise<ChatGptTurnlessContinuationResult | undefined> {
  const now = input.now ?? Date.now();
  prune(now);
  const entry = continuations.get(input.requestId);
  if (!entry || entry.tool !== input.tool) return undefined;
  if (!input.sessionScope || entry.sessionScopeDigest !== digestSessionScope(input.sessionScope)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Turnless continuation belongs to another ChatGPT session", {
      requestId: input.requestId,
      tool: input.tool,
    });
  }
  if (entry.expiresAt <= now) {
    continuations.delete(input.requestId);
    return undefined;
  }
  entry.resultPromise ??= Promise.resolve().then(entry.run);
  return entry.resultPromise;
}

export function clearChatGptTurnlessContinuation(requestId: string): void {
  continuations.delete(requestId);
}
