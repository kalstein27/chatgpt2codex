import { createHash, randomUUID } from "node:crypto";

export type RuntimeTransport = "http" | "stdio";
export type RuntimeOperationState = "running" | "waiting-approval" | "completed" | "failed" | "idle";

export interface RuntimeSessionHandle {
  readonly internalId: string;
}

export interface RuntimeActivityContext {
  tracker: RuntimeActivityTracker;
  session: RuntimeSessionHandle;
}

interface OperationRecord {
  operationId: string;
  tool: string;
  startedAt: number;
  finishedAt?: number;
  state: Exclude<RuntimeOperationState, "idle">;
}

interface SessionRecord {
  handle: RuntimeSessionHandle;
  transport: RuntimeTransport;
  externalId?: string;
  clientName?: string;
  connectedAt: number;
  lastActiveAt: number;
  operations: OperationRecord[];
}

export interface RuntimeSessionSummary {
  sessionLabel: string;
  transport: RuntimeTransport;
  clientName?: string;
  connectedAt: number;
  lastActiveAt: number;
  state: RuntimeOperationState;
  operation?: {
    tool: string;
    state: Exclude<RuntimeOperationState, "idle">;
    startedAt: number;
    finishedAt?: number;
    elapsedMs: number;
  };
}

const RECENT_OPERATION_TTL_MS = 15_000;
const MAX_RECENT_OPERATIONS = 4;

function boundedLabel(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/[^\p{L}\p{N} ._:-]/gu, "").trim();
  return (normalized || fallback).slice(0, 80);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export class RuntimeActivityTracker {
  private readonly sessions = new Map<string, SessionRecord>();

  openSession(input: { transport: RuntimeTransport; clientName?: string; now?: number }): RuntimeSessionHandle {
    const now = input.now ?? Date.now();
    const handle = { internalId: randomUUID() };
    this.sessions.set(handle.internalId, {
      handle,
      transport: input.transport,
      clientName: input.clientName ? boundedLabel(input.clientName, "client") : undefined,
      connectedAt: now,
      lastActiveAt: now,
      operations: [],
    });
    return handle;
  }

  updateSession(
    handle: RuntimeSessionHandle,
    input: { externalId?: string; clientName?: string; now?: number },
  ): void {
    const session = this.sessions.get(handle.internalId);
    if (!session) return;
    if (input.externalId) session.externalId = input.externalId;
    if (input.clientName) session.clientName = boundedLabel(input.clientName, "client");
    session.lastActiveAt = input.now ?? Date.now();
  }

  touch(handle: RuntimeSessionHandle, now = Date.now()): void {
    const session = this.sessions.get(handle.internalId);
    if (session) session.lastActiveAt = now;
  }

  closeSession(handle: RuntimeSessionHandle): void {
    this.sessions.delete(handle.internalId);
  }

  startOperation(handle: RuntimeSessionHandle, tool: string, now = Date.now()): string | undefined {
    const session = this.sessions.get(handle.internalId);
    if (!session) return undefined;
    const operationId = randomUUID();
    session.lastActiveAt = now;
    session.operations.push({
      operationId,
      tool: boundedLabel(tool, "tool"),
      startedAt: now,
      state: "running",
    });
    if (session.operations.length > MAX_RECENT_OPERATIONS) {
      session.operations.splice(0, session.operations.length - MAX_RECENT_OPERATIONS);
    }
    return operationId;
  }

  finishOperation(
    handle: RuntimeSessionHandle,
    operationId: string | undefined,
    input: { errorCode?: string; now?: number } = {},
  ): void {
    if (!operationId) return;
    const session = this.sessions.get(handle.internalId);
    const operation = session?.operations.find((candidate) => candidate.operationId === operationId);
    if (!session || !operation) return;
    const now = input.now ?? Date.now();
    operation.finishedAt = now;
    operation.state =
      input.errorCode === "APPROVAL_REQUIRED" || input.errorCode === "CONFIRMATION_PENDING"
        ? "waiting-approval"
        : input.errorCode
          ? "failed"
          : "completed";
    session.lastActiveAt = now;
  }

  snapshot(now = Date.now()): RuntimeSessionSummary[] {
    const summaries: RuntimeSessionSummary[] = [];
    for (const session of this.sessions.values()) {
      session.operations = session.operations.filter(
        (operation) => operation.finishedAt === undefined || now - operation.finishedAt <= RECENT_OPERATION_TTL_MS,
      );
      const operation =
        [...session.operations].reverse().find((candidate) => candidate.finishedAt === undefined) ??
        session.operations.at(-1);
      const identity = session.externalId ?? session.handle.internalId;
      summaries.push({
        sessionLabel: `${session.transport.toUpperCase()}-${shortHash(identity)}`,
        transport: session.transport,
        clientName: session.clientName,
        connectedAt: session.connectedAt,
        lastActiveAt: session.lastActiveAt,
        state: operation?.state ?? "idle",
        ...(operation
          ? {
              operation: {
                tool: operation.tool,
                state: operation.state,
                startedAt: operation.startedAt,
                finishedAt: operation.finishedAt,
                elapsedMs: Math.max(0, (operation.finishedAt ?? now) - operation.startedAt),
              },
            }
          : {}),
      });
    }
    return summaries.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
}
