import { randomUUID } from "node:crypto";
import { DomainError, ErrorCode } from "../types.js";
import {
  classifyTerminalState,
  normalizeCardState,
  type ChatGptCardLifecycleState,
} from "./chatgpt-card-lifecycle.js";

export type ChatGptConsentProbeDecision = "allow" | "deny";
export type ChatGptConsentProbeStatus = "pending" | "allowed" | "denied" | "expired";

export interface ChatGptConsentProbeRecord {
  requestId: string;
  sessionScope?: string;
  createdAt: number;
  expiresAt: number;
  status: ChatGptConsentProbeStatus;
  resolvedAt?: number;
}

const probes = new Map<string, ChatGptConsentProbeRecord>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

const CONSENT_PROBE_TERMINAL_STATUSES = {
  allowed: "allowed",
  denied: "denied",
  expired: "expired",
  missing: "missing",
} as const;

export function chatGptConsentProbeCardLifecycle(
  record:
    | Pick<ChatGptConsentProbeRecord, "requestId" | "status" | "expiresAt">
    | { requestId: string; status: "missing"; expiresAt: null },
  input: { presented?: boolean; resolving?: boolean; now?: number } = {},
): ChatGptCardLifecycleState {
  const now = input.now ?? Date.now();
  const expired = record.status === "pending" && record.expiresAt !== null && record.expiresAt <= now;
  const terminalReason = expired
    ? "expired"
    : classifyTerminalState(record.status, CONSENT_PROBE_TERMINAL_STATUSES);
  const phase = input.resolving ? "resolving" : input.presented ? "waiting-user" : "presentable";
  return normalizeCardState({
    identityKey: `consent-probe:${record.requestId}`,
    phase,
    terminalReason,
    expiresAt: record.expiresAt,
    statusSource: "server-authoritative",
    presentationRequired: phase === "presentable",
    pollMode: phase === "resolving" ? "bounded-status-only" : "none",
  });
}

function prune(now = Date.now()): void {
  for (const [requestId, record] of probes) {
    if (record.status === "pending" && record.expiresAt <= now) {
      record.status = "expired";
      record.resolvedAt = now;
    }
    if (record.expiresAt + DEFAULT_TTL_MS <= now) probes.delete(requestId);
  }
}

export function createChatGptConsentProbe(input: {
  sessionScope?: string;
  now?: number;
  ttlMs?: number;
}): ChatGptConsentProbeRecord {
  const now = input.now ?? Date.now();
  prune(now);
  const ttlMs = Math.min(DEFAULT_TTL_MS, Math.max(30_000, input.ttlMs ?? DEFAULT_TTL_MS));
  const record: ChatGptConsentProbeRecord = {
    requestId: `consent_${randomUUID()}`,
    ...(input.sessionScope ? { sessionScope: input.sessionScope } : {}),
    createdAt: now,
    expiresAt: now + ttlMs,
    status: "pending",
  };
  probes.set(record.requestId, record);
  return { ...record };
}

export function getChatGptConsentProbe(input: {
  requestId: string;
  sessionScope?: string;
  now?: number;
}): ChatGptConsentProbeRecord {
  const now = input.now ?? Date.now();
  prune(now);
  if (!/^consent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.requestId)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid confirmation probe identifier");
  }
  const record = probes.get(input.requestId);
  if (!record) {
    throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "C2CT in-chat confirmation probe not found", {
      requestId: input.requestId,
    });
  }
  if (record.sessionScope && record.sessionScope !== input.sessionScope) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "C2CT in-chat confirmation probe belongs to another conversation", {
      requestId: input.requestId,
    });
  }
  return { ...record };
}

/** A missing process-local probe is no evidence of consent, including after restart. */
export function readChatGptConsentProbeStatus(input: Parameters<typeof getChatGptConsentProbe>[0]):
  | ChatGptConsentProbeRecord
  | { requestId: string; status: "missing"; expiresAt: null } {
  try {
    return getChatGptConsentProbe(input);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== ErrorCode.OPERATION_NOT_FOUND) throw error;
    return { requestId: input.requestId, status: "missing", expiresAt: null };
  }
}

export function resolveChatGptConsentProbe(input: {
  requestId: string;
  decision: ChatGptConsentProbeDecision;
  sessionScope?: string;
  now?: number;
}): ChatGptConsentProbeRecord {
  const now = input.now ?? Date.now();
  const current = getChatGptConsentProbe({ requestId: input.requestId, sessionScope: input.sessionScope, now });
  const lifecycle = chatGptConsentProbeCardLifecycle(current, { now });
  if (lifecycle.phase === "terminal") {
    throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "C2CT in-chat confirmation probe is not pending", {
      requestId: input.requestId,
      status: current.status,
    });
  }
  const record = probes.get(input.requestId)!;
  record.status = input.decision === "allow" ? "allowed" : "denied";
  record.resolvedAt = now;
  return { ...record };
}
