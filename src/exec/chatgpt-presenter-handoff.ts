import { isRemoteTransientSessionScope } from "../state/session-scope.js";

const PRESENTER_HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;

interface PresenterHandoff {
  sourceSessionScope: string;
  createdAt: number;
  expiresAt: number;
}

const handoffs = new Map<string, PresenterHandoff>();

function prune(now: number): void {
  for (const [requestId, handoff] of handoffs) {
    if (handoff.expiresAt <= now) handoffs.delete(requestId);
  }
}

/**
 * ChatGPT's stateless MCP transport can omit both an MCP session header and
 * openai/session metadata. In that case C2CT deliberately assigns a fresh
 * remote-transient scope to every HTTP request. The approval-producing call
 * and its immediately-following presenter call therefore cannot share the
 * same raw transient scope.
 *
 * Keep only a short-lived, exact-request handoff for that presenter hop. This
 * is not an approval grant: it carries no widget token and cannot resolve the
 * operation. The presenter still verifies the persisted approval request
 * against the original scope before minting a one-shot widget token.
 */
export function rememberChatGptOperationPresenterHandoff(input: {
  requestId: string;
  sessionScope?: string;
  approvalExpiresAt: number;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  prune(now);
  const sourceSessionScope = input.sessionScope;
  if (typeof sourceSessionScope !== "string" || !isRemoteTransientSessionScope(sourceSessionScope)) {
    handoffs.delete(input.requestId);
    return;
  }
  const expiresAt = Math.min(input.approvalExpiresAt, now + PRESENTER_HANDOFF_MAX_AGE_MS);
  if (expiresAt <= now) {
    handoffs.delete(input.requestId);
    return;
  }
  handoffs.set(input.requestId, {
    sourceSessionScope,
    createdAt: now,
    expiresAt,
  });
}

export function recoverChatGptOperationPresenterSessionScope(input: {
  requestId: string;
  callbackSessionScope?: string;
  now?: number;
}): string | undefined {
  const now = input.now ?? Date.now();
  prune(now);
  if (!isRemoteTransientSessionScope(input.callbackSessionScope)) return undefined;
  const handoff = handoffs.get(input.requestId);
  if (!handoff || !isRemoteTransientSessionScope(handoff.sourceSessionScope)) return undefined;
  return handoff.sourceSessionScope;
}

export function clearChatGptOperationPresenterHandoff(requestId: string): void {
  handoffs.delete(requestId);
}
