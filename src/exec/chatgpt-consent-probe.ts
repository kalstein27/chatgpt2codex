import { randomUUID } from "node:crypto";
import { DomainError, ErrorCode } from "../types.js";

export type ChatGptConsentProbeDecision = "allow" | "deny";
export type ChatGptConsentProbeStatus = "pending" | "allowed" | "denied" | "expired";

interface ChatGptConsentProbeRecord {
  requestId: string;
  sessionScope?: string;
  createdAt: number;
  expiresAt: number;
  status: ChatGptConsentProbeStatus;
  resolvedAt?: number;
}

const probes = new Map<string, ChatGptConsentProbeRecord>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

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

export function resolveChatGptConsentProbe(input: {
  requestId: string;
  decision: ChatGptConsentProbeDecision;
  sessionScope?: string;
  now?: number;
}): ChatGptConsentProbeRecord {
  const now = input.now ?? Date.now();
  const current = getChatGptConsentProbe({ requestId: input.requestId, sessionScope: input.sessionScope, now });
  if (current.status !== "pending") {
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
