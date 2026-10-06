import { randomUUID } from "node:crypto";
import { isRemoteTransientSessionScope } from "../state/session-scope.js";

interface PresenterReissueSource {
  sourceSessionScope: string;
  expiresAt: number;
  replacementRequestId?: string;
}

interface PresenterAlias {
  canonicalRequestId: string;
  expiresAt: number;
}

export interface ChatGptPresenterReissue {
  canonicalRequestId: string;
  presenterRequestId: string;
  sourceSessionScope: string;
}

const sources = new Map<string, PresenterReissueSource>();
const aliases = new Map<string, PresenterAlias>();

function prune(now: number): void {
  for (const [requestId, source] of sources) {
    if (source.expiresAt <= now) sources.delete(requestId);
  }
  for (const [requestId, alias] of aliases) {
    if (alias.expiresAt <= now || !sources.has(alias.canonicalRequestId)) aliases.delete(requestId);
  }
}

/**
 * Keep a bounded in-memory recovery handle only for ChatGPT transports that had
 * no stable conversation metadata and therefore received a one-request
 * remote-transient scope. No approval grant or operation payload is stored here.
 */
export function registerChatGptPresenterReissueSource(input: {
  requestId: string;
  sessionScope?: string;
  approvalExpiresAt: number;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const sessionScope = input.sessionScope;
  prune(now);
  if (typeof sessionScope !== "string" || !isRemoteTransientSessionScope(sessionScope) || input.approvalExpiresAt <= now) {
    sources.delete(input.requestId);
    return;
  }
  const existing = sources.get(input.requestId);
  sources.set(input.requestId, {
    sourceSessionScope: sessionScope,
    expiresAt: input.approvalExpiresAt,
    ...(existing?.replacementRequestId ? { replacementRequestId: existing.replacementRequestId } : {}),
  });
}

/**
 * Reissue only the presenter handle. The returned replacement id is never an
 * operation authorization id: callbacks still carry the canonical approval id.
 * This keeps the exact operation fingerprint, background receipt, and turnless
 * continuation bound to the original request while giving the host a fresh card
 * identity after the short presenter handoff has gone stale.
 */
export function resolveChatGptPresenterReissue(input: {
  requestId: string;
  callbackSessionScope?: string;
  now?: number;
}): ChatGptPresenterReissue | undefined {
  const now = input.now ?? Date.now();
  prune(now);
  if (!isRemoteTransientSessionScope(input.callbackSessionScope)) return undefined;

  const alias = aliases.get(input.requestId);
  const canonicalRequestId = alias?.canonicalRequestId ?? input.requestId;
  const source = sources.get(canonicalRequestId);
  if (!source || source.expiresAt <= now) return undefined;

  let presenterRequestId = source.replacementRequestId;
  if (!presenterRequestId || !aliases.has(presenterRequestId)) {
    presenterRequestId = `op_${randomUUID()}`;
    source.replacementRequestId = presenterRequestId;
    aliases.set(presenterRequestId, { canonicalRequestId, expiresAt: source.expiresAt });
  }

  return {
    canonicalRequestId,
    presenterRequestId,
    sourceSessionScope: source.sourceSessionScope,
  };
}

export function forgetChatGptPresenterReissue(requestId: string): void {
  const canonicalRequestId = aliases.get(requestId)?.canonicalRequestId ?? requestId;
  const source = sources.get(canonicalRequestId);
  if (source?.replacementRequestId) aliases.delete(source.replacementRequestId);
  sources.delete(canonicalRequestId);
  aliases.delete(requestId);
}
