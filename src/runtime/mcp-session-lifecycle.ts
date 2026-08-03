import type { ConnectionDiagnosticsSink } from "./connection-diagnostics.js";

export const MCP_REQUEST_SESSION_ROTATION_WINDOW_MS = 30_000;
export const MCP_SESSION_RECONNECT_WINDOW_MS = 2 * 60_000;

export type McpSessionCloseReason = "client" | "capacity" | "idle_ttl" | "shutdown" | "transport_error";

export interface McpSessionOpenedInput {
  clientName?: string;
  openedAtMs: number;
  sessionSetupMs: number;
  activeSessionCount: number;
}

export interface McpSessionClosedInput {
  clientName?: string;
  openedAtMs: number;
  closedAtMs: number;
  requestCount: number;
  reusedRequestCount: number;
  reason: McpSessionCloseReason;
  activeSessionCount: number;
  errorCode?: string;
}

interface PendingRotationClose {
  input: McpSessionClosedInput;
  timer: NodeJS.Timeout;
}

export interface McpSessionLifecycleOptions {
  rotationWindowMs?: number;
  reconnectWindowMs?: number;
}

function clientKey(clientName: string | undefined): string {
  const normalized = clientName?.trim().toLowerCase();
  return normalized || "unknown-client";
}

/**
 * Classifies legacy Streamable HTTP lifecycle events without pretending the
 * server controls client session reuse. A client close or capacity eviction
 * followed quickly by a same-client initialize is recorded as one normal
 * request-scoped rotation. An unpaired client close becomes a disconnect;
 * an unpaired capacity close remains an explicit server policy event.
 */
export class McpSessionLifecycleDiagnostics {
  private readonly pendingRotationCloses = new Map<string, PendingRotationClose>();
  private readonly disconnectedAtMs = new Map<string, number>();
  private readonly rotationWindowMs: number;
  private readonly reconnectWindowMs: number;
  private disposed = false;

  constructor(
    private readonly diagnostics: ConnectionDiagnosticsSink,
    options: McpSessionLifecycleOptions = {},
  ) {
    this.rotationWindowMs = Math.max(0, options.rotationWindowMs ?? MCP_REQUEST_SESSION_ROTATION_WINDOW_MS);
    this.reconnectWindowMs = Math.max(this.rotationWindowMs, options.reconnectWindowMs ?? MCP_SESSION_RECONNECT_WINDOW_MS);
  }

  async opened(input: McpSessionOpenedInput): Promise<void> {
    if (this.disposed) return;
    const key = clientKey(input.clientName);
    const pending = this.pendingRotationCloses.get(key);
    if (pending) {
      const reconnectDelayMs = Math.max(0, input.openedAtMs - pending.input.closedAtMs);
      if (reconnectDelayMs <= this.rotationWindowMs) {
        clearTimeout(pending.timer);
        this.pendingRotationCloses.delete(key);
        await this.diagnostics.record({
          event: "mcp.request_session_completed",
          outcome: "info",
          clientName: input.clientName,
          closeReason: pending.input.reason === "capacity" ? "capacity_rotation" : "client_rotation",
          sessionDurationMs: Math.max(0, pending.input.closedAtMs - pending.input.openedAtMs),
          reconnectDelayMs,
          sessionSetupMs: input.sessionSetupMs,
          requestCount: pending.input.requestCount,
          reusedRequestCount: pending.input.reusedRequestCount,
          activeSessionCount: input.activeSessionCount,
        });
        return;
      }
      clearTimeout(pending.timer);
      this.pendingRotationCloses.delete(key);
      await this.recordUnpairedClose(key, pending.input);
    }

    const disconnectedAt = this.disconnectedAtMs.get(key);
    if (disconnectedAt !== undefined) {
      const reconnectDelayMs = Math.max(0, input.openedAtMs - disconnectedAt);
      if (reconnectDelayMs <= this.reconnectWindowMs) {
        this.disconnectedAtMs.delete(key);
        await this.diagnostics.record({
          event: "mcp.session_reconnected",
          outcome: "success",
          clientName: input.clientName,
          reconnectDelayMs,
          sessionSetupMs: input.sessionSetupMs,
          activeSessionCount: input.activeSessionCount,
        });
        return;
      }
      this.disconnectedAtMs.delete(key);
    }

    await this.diagnostics.record({
      event: "mcp.session_opened",
      outcome: "success",
      clientName: input.clientName,
      sessionSetupMs: input.sessionSetupMs,
      activeSessionCount: input.activeSessionCount,
    });
  }

  async closed(input: McpSessionClosedInput): Promise<void> {
    if (this.disposed) return;
    if (input.reason === "transport_error") {
      await this.transportError(input);
      return;
    }
    if (input.reason !== "client" && input.reason !== "capacity") {
      await this.diagnostics.record({
        event: "mcp.session_closed",
        outcome: "info",
        clientName: input.clientName,
        closeReason: input.reason,
        sessionDurationMs: Math.max(0, input.closedAtMs - input.openedAtMs),
        requestCount: input.requestCount,
        reusedRequestCount: input.reusedRequestCount,
        activeSessionCount: input.activeSessionCount,
      });
      return;
    }

    const key = clientKey(input.clientName);
    const existing = this.pendingRotationCloses.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingRotationCloses.delete(key);
      await this.recordUnpairedClose(key, existing.input);
    }

    const pending = {} as PendingRotationClose;
    pending.input = input;
    pending.timer = setTimeout(() => {
      if (this.pendingRotationCloses.get(key) !== pending) return;
      this.pendingRotationCloses.delete(key);
      void this.recordUnpairedClose(key, input);
    }, this.rotationWindowMs);
    pending.timer.unref?.();
    this.pendingRotationCloses.set(key, pending);
  }

  async transportError(input: McpSessionClosedInput): Promise<void> {
    if (this.disposed) return;
    await this.diagnostics.record({
      event: "mcp.transport_error",
      outcome: "failure",
      errorCode: input.errorCode ?? "MCP_TRANSPORT_ERROR",
      clientName: input.clientName,
      closeReason: "transport_error",
      sessionDurationMs: Math.max(0, input.closedAtMs - input.openedAtMs),
      requestCount: input.requestCount,
      reusedRequestCount: input.reusedRequestCount,
      activeSessionCount: input.activeSessionCount,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingRotationCloses.values()) clearTimeout(pending.timer);
    this.pendingRotationCloses.clear();
    this.disconnectedAtMs.clear();
  }

  private async recordDisconnect(key: string, input: McpSessionClosedInput): Promise<void> {
    this.disconnectedAtMs.set(key, input.closedAtMs);
    await this.diagnostics.record({
      event: "mcp.session_disconnected",
      outcome: "info",
      clientName: input.clientName,
      closeReason: "client",
      sessionDurationMs: Math.max(0, input.closedAtMs - input.openedAtMs),
      requestCount: input.requestCount,
      reusedRequestCount: input.reusedRequestCount,
      activeSessionCount: input.activeSessionCount,
    });
  }

  private async recordUnpairedClose(key: string, input: McpSessionClosedInput): Promise<void> {
    if (input.reason === "client") {
      await this.recordDisconnect(key, input);
      return;
    }
    await this.diagnostics.record({
      event: "mcp.session_closed",
      outcome: "info",
      clientName: input.clientName,
      closeReason: input.reason,
      sessionDurationMs: Math.max(0, input.closedAtMs - input.openedAtMs),
      requestCount: input.requestCount,
      reusedRequestCount: input.reusedRequestCount,
      activeSessionCount: input.activeSessionCount,
    });
  }
}
