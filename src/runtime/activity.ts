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
  phase?: string;
  message?: string;
  lastProgressAt?: number;
  progress?: number;
  clientCancelledAt?: number;
}

interface SessionRecord {
  handle: RuntimeSessionHandle;
  transport: RuntimeTransport;
  externalId?: string;
  clientName?: string;
  connectedAt: number;
  lastActiveAt: number;
  closedAt?: number;
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
    operationId: string;
    tool: string;
    state: Exclude<RuntimeOperationState, "idle">;
    startedAt: number;
    finishedAt?: number;
    elapsedMs: number;
    phase?: string;
    message?: string;
    lastProgressAt?: number;
    progress?: number;
    clientCancellation?: {
      observedAt: number;
      operationContinues: boolean;
      automaticRetrySafe: false;
    };
  };
}

export interface RuntimeActiveOperation {
  sessionLabel: string;
  operationId: string;
  tool: string;
  startedAt: number;
  elapsedMs: number;
  phase?: string;
  lastProgressAt?: number;
  progress?: number;
  clientCancellation?: {
    observedAt: number;
    operationContinues: true;
    automaticRetrySafe: false;
    recommendedAction: "wait-and-recheck-connection-status";
  };
}

export interface RuntimeCancelledOperation {
  operationId: string;
  tool: string;
  startedAt: number;
  elapsedMs: number;
  phase?: string;
}

const RECENT_OPERATION_TTL_MS = 15_000;
const MAX_RECENT_OPERATIONS = 4;
const MAX_RECENT_CLOSED_SESSIONS = 16;
const RECENT_COMPLETED_DISPLAY_THRESHOLD_MS = 1_000;

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

  closeSession(handle: RuntimeSessionHandle, now = Date.now()): void {
    const session = this.sessions.get(handle.internalId);
    if (!session) return;
    if (session.operations.length === 0) {
      this.sessions.delete(handle.internalId);
      return;
    }
    const displayWorthy = session.operations.some((operation) =>
      operation.finishedAt === undefined
      || operation.clientCancelledAt !== undefined
      || operation.finishedAt - operation.startedAt >= RECENT_COMPLETED_DISPLAY_THRESHOLD_MS,
    );
    if (!displayWorthy) {
      this.sessions.delete(handle.internalId);
      return;
    }
    session.closedAt = now;
    session.lastActiveAt = now;
    this.pruneClosedSessions(now);
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

  progressOperation(
    handle: RuntimeSessionHandle,
    operationId: string | undefined,
    input: { phase?: string; message?: string; progress?: number; now?: number },
  ): void {
    if (!operationId) return;
    const session = this.sessions.get(handle.internalId);
    const operation = session?.operations.find((candidate) => candidate.operationId === operationId);
    if (!session || !operation || operation.finishedAt !== undefined) return;
    const now = input.now ?? Date.now();
    if (input.phase) operation.phase = boundedLabel(input.phase, "running");
    if (input.message) operation.message = boundedLabel(input.message, "Working");
    if (typeof input.progress === "number" && Number.isFinite(input.progress)) {
      operation.progress = Math.max(operation.progress ?? 0, Math.max(0, input.progress));
    }
    operation.lastProgressAt = now;
    session.lastActiveAt = now;
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

  markClientCancelled(
    handle: RuntimeSessionHandle,
    tool: string | undefined,
    now = Date.now(),
  ): RuntimeCancelledOperation | undefined {
    const session = this.sessions.get(handle.internalId);
    if (!session) return undefined;
    const candidates = session.operations.filter(
      (candidate) => candidate.finishedAt === undefined && (!tool || candidate.tool === tool),
    );
    // A guessed correlation is worse than an unknown recovery state: clients
    // may issue concurrent calls for the same tool on one stateful session.
    if (candidates.length !== 1) return undefined;
    const operation = candidates[0];
    if (!operation) return undefined;
    operation.clientCancelledAt = now;
    session.lastActiveAt = now;
    return {
      operationId: operation.operationId,
      tool: operation.tool,
      startedAt: operation.startedAt,
      elapsedMs: Math.max(0, now - operation.startedAt),
      ...(operation.phase ? { phase: operation.phase } : {}),
    };
  }

  activeOperations(
    input: { excludeTools?: readonly string[]; now?: number } = {},
  ): RuntimeActiveOperation[] {
    const now = input.now ?? Date.now();
    const excluded = new Set(input.excludeTools ?? []);
    const active: RuntimeActiveOperation[] = [];
    for (const session of this.sessions.values()) {
      const identity = session.externalId ?? session.handle.internalId;
      const sessionLabel = `${session.transport.toUpperCase()}-${shortHash(identity)}`;
      for (const operation of session.operations) {
        if (operation.finishedAt !== undefined || excluded.has(operation.tool)) continue;
        active.push({
          sessionLabel,
          operationId: operation.operationId,
          tool: operation.tool,
          startedAt: operation.startedAt,
          elapsedMs: Math.max(0, now - operation.startedAt),
          ...(operation.phase ? { phase: operation.phase } : {}),
          ...(operation.lastProgressAt !== undefined ? { lastProgressAt: operation.lastProgressAt } : {}),
          ...(operation.progress !== undefined ? { progress: operation.progress } : {}),
          ...(operation.clientCancelledAt !== undefined
            ? {
                clientCancellation: {
                  observedAt: operation.clientCancelledAt,
                  operationContinues: true,
                  automaticRetrySafe: false,
                  recommendedAction: "wait-and-recheck-connection-status" as const,
                },
              }
            : {}),
        });
      }
    }
    return active.sort((a, b) => a.startedAt - b.startedAt || a.tool.localeCompare(b.tool));
  }

  snapshot(now = Date.now()): RuntimeSessionSummary[] {
    this.pruneClosedSessions(now);
    const summaries: RuntimeSessionSummary[] = [];
    for (const session of this.sessions.values()) {
      session.operations = session.operations.filter(
        (operation) => operation.finishedAt === undefined || now - operation.finishedAt <= RECENT_OPERATION_TTL_MS,
      );
      const operation =
        [...session.operations].reverse().find((candidate) => candidate.finishedAt === undefined) ??
        session.operations.at(-1);
      if (!operation && session.closedAt !== undefined) {
        this.sessions.delete(session.handle.internalId);
        continue;
      }
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
                operationId: operation.operationId,
                tool: operation.tool,
                state: operation.state,
                startedAt: operation.startedAt,
                finishedAt: operation.finishedAt,
                elapsedMs: Math.max(0, (operation.finishedAt ?? now) - operation.startedAt),
                phase: operation.phase,
                message: operation.message,
                lastProgressAt: operation.lastProgressAt,
                progress: operation.progress,
                ...(operation.clientCancelledAt !== undefined
                  ? {
                      clientCancellation: {
                        observedAt: operation.clientCancelledAt,
                        operationContinues: operation.finishedAt === undefined,
                        automaticRetrySafe: false as const,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      });
    }
    return summaries.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  private pruneClosedSessions(now: number): void {
    const closed = [...this.sessions.values()]
      .filter((session) => session.closedAt !== undefined)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    for (const [index, session] of closed.entries()) {
      const finished = session.operations.every((operation) => operation.finishedAt !== undefined);
      const expired = finished && now - (session.closedAt ?? now) > RECENT_OPERATION_TTL_MS;
      if (expired || index >= MAX_RECENT_CLOSED_SESSIONS) {
        this.sessions.delete(session.handle.internalId);
      }
    }
  }
}
