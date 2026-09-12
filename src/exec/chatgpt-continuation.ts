export type ChatGptContinuationSource = "widget-shell" | "operation-approval";
export type ChatGptContinuationStatus = "pending" | "ready" | "denied";
export type ChatGptContinuationRecoveryMode = "status-only" | "resume-objective" | "exact-replay" | "stop";

export interface ChatGptContinuationRecovery {
  mode: ChatGptContinuationRecoveryMode;
  statusOnly: boolean;
  mutationReplayAllowed: boolean;
  maxStatusPolls: number;
  pollAfterMs: number;
}

export interface ChatGptContinuationOperation {
  requestId: string;
  tool: string;
  projectId?: string;
  originOperationId?: string;
}

export interface ChatGptContinuationSnapshot {
  source: ChatGptContinuationSource;
  status: ChatGptContinuationStatus;
  objective: string;
  instruction: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  cardId?: string;
  receiptId?: string;
  choiceId?: string;
  choiceLabel?: string;
  operation?: ChatGptContinuationOperation;
  continuationStarted?: boolean;
  continuationDeferred?: boolean;
  fallbackRequiresExactReplay?: boolean;
  reconnectPlan?: unknown;
  recovery: ChatGptContinuationRecovery;
}

type StoredContinuation = ChatGptContinuationSnapshot & {
  sessionScope: string;
  allowInstruction?: string;
  denyInstruction?: string;
};

const continuations = new Map<string, StoredContinuation>();

const PENDING_RECOVERY: ChatGptContinuationRecovery = Object.freeze({
  mode: "status-only",
  statusOnly: true,
  mutationReplayAllowed: false,
  maxStatusPolls: 3,
  pollAfterMs: 100,
});

const STATUS_ONLY_RECOVERY: ChatGptContinuationRecovery = Object.freeze({
  mode: "status-only",
  statusOnly: true,
  mutationReplayAllowed: false,
  maxStatusPolls: 0,
  pollAfterMs: 0,
});

const RESUME_RECOVERY: ChatGptContinuationRecovery = Object.freeze({
  mode: "resume-objective",
  statusOnly: false,
  mutationReplayAllowed: false,
  maxStatusPolls: 0,
  pollAfterMs: 0,
});

const STOP_RECOVERY: ChatGptContinuationRecovery = Object.freeze({
  mode: "stop",
  statusOnly: true,
  mutationReplayAllowed: false,
  maxStatusPolls: 0,
  pollAfterMs: 0,
});

const EXACT_REPLAY_RECOVERY: ChatGptContinuationRecovery = Object.freeze({
  mode: "exact-replay",
  statusOnly: false,
  mutationReplayAllowed: true,
  maxStatusPolls: 0,
  pollAfterMs: 0,
});

function trimmed(value: string): string {
  return value.trim();
}

function copyRecovery(recovery: ChatGptContinuationRecovery): ChatGptContinuationRecovery {
  return { ...recovery };
}

function publicSnapshot(state: StoredContinuation): ChatGptContinuationSnapshot {
  const {
    sessionScope: _sessionScope,
    allowInstruction: _allowInstruction,
    denyInstruction: _denyInstruction,
    ...snapshot
  } = state;
  return {
    ...snapshot,
    ...(snapshot.operation ? { operation: { ...snapshot.operation } } : {}),
    recovery: copyRecovery(snapshot.recovery),
  };
}

function current(sessionScope: string, now: number): StoredContinuation | undefined {
  const state = continuations.get(sessionScope);
  if (!state) return undefined;
  if (state.expiresAt < now) {
    continuations.delete(sessionScope);
    return undefined;
  }
  return state;
}

export function rememberChatGptShellContinuation(input: {
  sessionScope: string;
  cardId: string;
  objective: string;
  createdAt: number;
  expiresAt: number;
}): void {
  const objective = trimmed(input.objective);
  if (!input.sessionScope || !input.cardId || !objective) return;
  continuations.set(input.sessionScope, {
    sessionScope: input.sessionScope,
    source: "widget-shell",
    status: "pending",
    objective,
    instruction: "Wait for the exact Widget Shell receipt. Do not execute or replay any mutation while the receipt is pending.",
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    cardId: input.cardId,
    recovery: copyRecovery(PENDING_RECOVERY),
  });
}

export function resolveChatGptShellContinuation(input: {
  sessionScope: string;
  cardId: string;
  receiptId: string;
  choiceId: string;
  choiceLabel: string;
  resolvedAt: number;
}): boolean {
  const state = current(input.sessionScope, input.resolvedAt);
  if (!state || state.source !== "widget-shell" || state.cardId !== input.cardId) return false;
  state.status = "ready";
  state.receiptId = input.receiptId;
  state.choiceId = input.choiceId;
  state.choiceLabel = input.choiceLabel;
  state.resolvedAt = input.resolvedAt;
  state.instruction = "Resume the stored objective immediately in this assistant turn. Do not answer with an acknowledgement only and do not ask the user to repeat the objective.";
  state.recovery = copyRecovery(RESUME_RECOVERY);
  return true;
}

export function rememberChatGptApprovalContinuation(input: {
  sessionScope: string;
  requestId: string;
  operationTool: string;
  objective: string;
  allowInstruction: string;
  denyInstruction: string;
  createdAt: number;
  expiresAt: number;
  projectId?: string;
  originOperationId?: string;
}): void {
  const objective = trimmed(input.objective);
  const allowInstruction = trimmed(input.allowInstruction);
  const denyInstruction = trimmed(input.denyInstruction);
  if (!input.sessionScope || !input.requestId || !input.operationTool || !objective || !allowInstruction || !denyInstruction) return;
  continuations.set(input.sessionScope, {
    sessionScope: input.sessionScope,
    source: "operation-approval",
    status: "pending",
    objective,
    instruction: "Wait for the exact approval decision receipt. Do not execute or replay the protected mutation while approval resolution is pending.",
    allowInstruction,
    denyInstruction,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    operation: {
      requestId: input.requestId,
      tool: input.operationTool,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.originOperationId ? { originOperationId: input.originOperationId } : {}),
    },
    recovery: copyRecovery(PENDING_RECOVERY),
  });
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function resolveChatGptApprovalContinuation(input: {
  sessionScope: string;
  requestId: string;
  decision: "allow" | "deny";
  resolvedAt: number;
  continuation?: Record<string, unknown> | null;
}): boolean {
  const state = current(input.sessionScope, input.resolvedAt);
  if (!state || state.source !== "operation-approval" || state.operation?.requestId !== input.requestId) return false;

  state.resolvedAt = input.resolvedAt;
  if (input.decision === "deny") {
    state.status = "denied";
    state.instruction = state.denyInstruction || "The protected operation was denied. Do not execute it.";
    state.recovery = copyRecovery(STOP_RECOVERY);
    return true;
  }

  const continuation = input.continuation ?? {};
  const continuationStarted = booleanField(continuation.continuationStarted);
  const continuationDeferred = booleanField(continuation.continuationDeferred);
  const fallbackRequiresExactReplay = booleanField(continuation.fallbackRequiresExactReplay);
  state.status = "ready";
  state.instruction = state.allowInstruction || "Resume the approved operation using its exact recovery contract.";
  if (continuationStarted !== undefined) state.continuationStarted = continuationStarted;
  if (continuationDeferred !== undefined) state.continuationDeferred = continuationDeferred;
  if (fallbackRequiresExactReplay !== undefined) state.fallbackRequiresExactReplay = fallbackRequiresExactReplay;
  if (continuation.reconnectPlan !== undefined) state.reconnectPlan = continuation.reconnectPlan;

  if (continuationStarted === true || continuationDeferred === true || fallbackRequiresExactReplay === false) {
    state.recovery = copyRecovery(STATUS_ONLY_RECOVERY);
  } else {
    state.recovery = copyRecovery(EXACT_REPLAY_RECOVERY);
  }
  return true;
}

export function getChatGptContinuation(input: {
  sessionScope: string;
  now?: number;
}): ChatGptContinuationSnapshot | undefined {
  if (!input.sessionScope) return undefined;
  const state = current(input.sessionScope, input.now ?? Date.now());
  return state ? publicSnapshot(state) : undefined;
}

export function clearChatGptContinuationForTests(): void {
  continuations.clear();
}
