import { createHash, randomUUID } from "node:crypto";
import { redact } from "../policy/secrets.js";

export type RuntimeTransport = "http" | "stdio";
export type RuntimeOperationState = "running" | "waiting-approval" | "completed" | "failed" | "idle";
export type RuntimeSemanticActivityKind =
  | "planning"
  | "inspecting"
  | "editing"
  | "verifying"
  | "building"
  | "installing"
  | "applying"
  | "connecting"
  | "controlling"
  | "waiting-approval"
  | "other";

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
  projectId?: string;
  startedAt: number;
  finishedAt?: number;
  state: Exclude<RuntimeOperationState, "idle">;
  phase?: string;
  message?: string;
  lastProgressAt?: number;
  progress?: number;
  clientCancelledAt?: number;
  activityHint?: string;
}

interface SessionRecord {
  handle: RuntimeSessionHandle;
  transport: RuntimeTransport;
  externalId?: string;
  capabilityScope?: string;
  conversationLabel?: string;
  clientName?: string;
  connectedAt: number;
  lastActiveAt: number;
  closedAt?: number;
  operations: OperationRecord[];
}

interface ConversationRecord {
  conversationLabel: string;
  taskLabel?: string;
  displayTitle?: string;
  displayTitleSource?: "host" | "dashboard";
  firstSeenAt: number;
  lastActiveAt: number;
  operations: OperationRecord[];
}

export interface RuntimeSessionSummary {
  sessionLabel: string;
  conversationLabel?: string;
  transport: RuntimeTransport;
  clientName?: string;
  connectedAt: number;
  lastActiveAt: number;
  state: RuntimeOperationState;
  operation?: {
    operationId: string;
    tool: string;
    projectId?: string;
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
  projectId?: string;
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

export interface RuntimeConversationSummary {
  conversationLabel: string;
  taskLabel?: string;
  displayTitle?: string;
  displayTitleSource?: "host" | "dashboard";
  firstSeenAt: number;
  lastActiveAt: number;
  state: RuntimeOperationState;
  dashboardVisibleUntil?: number;
  activityHighlights: Array<{
    kind: RuntimeSemanticActivityKind;
    state: Exclude<RuntimeOperationState, "idle">;
    startedAt: number;
    finishedAt?: number;
  }>;
  operations: Array<{
    operationId: string;
    tool: string;
    projectId?: string;
    state: Exclude<RuntimeOperationState, "idle">;
    startedAt: number;
    finishedAt?: number;
    elapsedMs: number;
    phase?: string;
    message?: string;
    activityHint?: string;
    lastProgressAt?: number;
    progress?: number;
    semanticKind: RuntimeSemanticActivityKind;
    clientCancellation?: {
      observedAt: number;
      operationContinues: boolean;
      automaticRetrySafe: false;
    };
  }>;
}

export interface RuntimeCancelledOperation {
  operationId: string;
  tool: string;
  startedAt: number;
  elapsedMs: number;
  phase?: string;
}

const RECENT_OPERATION_TTL_MS = 60_000;
const RECENT_ATTENTION_TTL_MS = 15_000;
const MAX_RECENT_OPERATIONS = 4;
const MAX_RECENT_CLOSED_SESSIONS = 16;
const CONVERSATION_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CONVERSATION_HISTORY = 16;
const MAX_CONVERSATION_OPERATIONS = 32;
export const DASHBOARD_COMPLETED_TTL_MS = 2 * 60 * 1000;
export const DASHBOARD_FAILED_TTL_MS = 5 * 60 * 1000;
const MAX_ACTIVITY_HIGHLIGHTS = 5;

function boundedLabel(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/[^\p{L}\p{N} ._:-]/gu, "").trim();
  return (normalized || fallback).slice(0, 80);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

const OPENAI_SESSION_META_KEY = "openai/session";
const MAX_OPENAI_SESSION_ID_LENGTH = 512;
const CONVERSATION_LABEL_PATTERN = /^CHAT-[A-F0-9]{10}$/;
const OPENAI_CONVERSATION_TITLE_META_KEYS = [
  "openai/conversation_title",
  "openai/conversationTitle",
  "openai/conversation/title",
  "openai/conversation_name",
  "openai/conversationName",
  "openai/conversation/name",
  "openai/chat_title",
  "openai/chatTitle",
  "openai/chat/title",
  "openai/chat_name",
  "openai/chatName",
  "openai/chat/name",
  "openai/thread_title",
  "openai/threadTitle",
  "openai/thread/title",
  "openai/thread_name",
  "openai/threadName",
  "openai/thread/name",
  "openai/title",
] as const;

function boundedTaskLabel(value: string): string | undefined {
  const normalized = redact(value)
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 80) : undefined;
}

function boundedDisplayTitle(value: string): string | undefined {
  const normalized = redact(value)
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 60) : undefined;
}

function semanticActivityKind(
  operation: Pick<OperationRecord, "tool" | "state" | "phase" | "activityHint">,
): RuntimeSemanticActivityKind {
  if (operation.state === "waiting-approval" || operation.phase === "approval") return "waiting-approval";
  const tool = operation.tool.toLowerCase();
  const hint = operation.activityHint?.toLowerCase() ?? "";
  const combined = `${tool} ${hint}`;
  if (tool === "goal_intake" || tool === "goal_loop") return "planning";
  if (tool.includes("macos_app_apply") || tool.includes("install_managed") || /\binstall(?:ing)?\b/u.test(hint)) return "installing";
  if (tool.includes("runtime_apply") || /\bapply(?:ing)?\b/u.test(hint)) return "applying";
  if (tool.includes("runtime_update_prepare") || /\bprepar(?:e|ing)\b/u.test(hint)) return "building";
  if (tool.startsWith("computer_") || tool.includes("control")) return "controlling";
  if (tool.includes("connection") || tool.includes("connector") || tool.includes("health")) return "connecting";
  if (tool.startsWith("file_apply") || tool.startsWith("file_edit") || tool === "file_create" || tool === "checkpoint_restore") return "editing";
  if (/\b(build|compile|package|bundle|seal)\b/u.test(combined)) return "building";
  if (tool.startsWith("e2e_") || /\b(test|typecheck|lint|verify|validation|check)\b/u.test(combined)) return "verifying";
  if (
    tool.includes("search")
    || tool.startsWith("file_read")
    || tool.endsWith("_status")
    || tool.includes("diff")
    || tool.includes("audit")
    || tool.includes("rules")
    || tool.includes("list")
    || tool.includes("show")
  ) return "inspecting";
  return "other";
}

function dashboardVisibleUntil(
  state: RuntimeOperationState,
  latest: OperationRecord | undefined,
): number | undefined {
  if (!latest?.finishedAt || state === "running" || state === "waiting-approval") return undefined;
  if (state === "completed") return latest.finishedAt + DASHBOARD_COMPLETED_TTL_MS;
  if (state === "failed") return latest.finishedAt + DASHBOARD_FAILED_TTL_MS;
  return undefined;
}

/**
 * Convert ChatGPT's optional anonymized conversation identifier into a
 * bounded local display label. The opaque source identifier is never stored
 * in the activity tracker or returned by its snapshots.
 */
export function conversationLabelFromRequestMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const value = (meta as Record<string, unknown>)[OPENAI_SESSION_META_KEY];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_OPENAI_SESSION_ID_LENGTH) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update("chatgpt2codex:chat-session:v1\0")
    .update(value)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  return `CHAT-${digest}`;
}

/**
 * Read only explicitly allowlisted ChatGPT title metadata. Unknown metadata is
 * ignored so request bodies are never copied into activity state while future
 * clients can still provide a human-readable conversation title safely.
 */
export function chatGptConversationDisplayTitleFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const record = meta as Record<string, unknown>;
  for (const key of OPENAI_CONVERSATION_TITLE_META_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const bounded = boundedDisplayTitle(value);
    if (bounded) return bounded;
  }
  return undefined;
}

export class RuntimeActivityTracker {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly conversations = new Map<string, ConversationRecord>();

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
    input: { externalId?: string; capabilityScope?: string; conversationLabel?: string; clientName?: string; now?: number },
  ): void {
    const session = this.sessions.get(handle.internalId);
    if (!session) return;
    if (input.externalId) session.externalId = input.externalId;
    if (input.capabilityScope) session.capabilityScope = input.capabilityScope;
    if (input.conversationLabel && CONVERSATION_LABEL_PATTERN.test(input.conversationLabel)) {
      session.conversationLabel = input.conversationLabel;
      for (const operation of session.operations) {
        this.attachConversationOperation(session.conversationLabel, operation);
      }
    }
    if (input.clientName) session.clientName = boundedLabel(input.clientName, "client");
    session.lastActiveAt = input.now ?? Date.now();
  }

  touch(handle: RuntimeSessionHandle, now = Date.now()): void {
    const session = this.sessions.get(handle.internalId);
    if (session) session.lastActiveAt = now;
  }

  setConversationTaskLabel(
    handle: RuntimeSessionHandle,
    taskLabel: string,
    now = Date.now(),
  ): { conversationLabel: string; taskLabel: string } | undefined {
    const session = this.sessions.get(handle.internalId);
    const bounded = boundedTaskLabel(taskLabel);
    if (!session?.conversationLabel || !bounded) return undefined;
    let conversation = this.conversations.get(session.conversationLabel);
    if (!conversation) {
      conversation = {
        conversationLabel: session.conversationLabel,
        taskLabel: bounded,
        firstSeenAt: now,
        lastActiveAt: now,
        operations: [],
      };
      this.conversations.set(session.conversationLabel, conversation);
    } else {
      conversation.taskLabel = bounded;
      conversation.lastActiveAt = Math.max(conversation.lastActiveAt, now);
    }
    this.pruneConversationHistory(now);
    return { conversationLabel: session.conversationLabel, taskLabel: bounded };
  }

  setConversationDisplayTitle(
    handle: RuntimeSessionHandle,
    displayTitle: string,
    now = Date.now(),
  ): { conversationLabel: string; displayTitle: string } | undefined {
    const session = this.sessions.get(handle.internalId);
    const bounded = boundedDisplayTitle(displayTitle);
    if (!session?.conversationLabel || !bounded) return undefined;
    let conversation = this.conversations.get(session.conversationLabel);
    if (!conversation) {
      conversation = {
        conversationLabel: session.conversationLabel,
        displayTitle: bounded,
        displayTitleSource: "host",
        firstSeenAt: now,
        lastActiveAt: now,
        operations: [],
      };
      this.conversations.set(session.conversationLabel, conversation);
    } else {
      conversation.displayTitle = bounded;
      conversation.displayTitleSource = "host";
      conversation.lastActiveAt = Math.max(conversation.lastActiveAt, now);
    }
    this.pruneConversationHistory(now);
    return { conversationLabel: session.conversationLabel, displayTitle: bounded };
  }

  setConversationDashboardTitle(
    handle: RuntimeSessionHandle,
    displayTitle: string,
    now = Date.now(),
  ): { conversationLabel: string; displayTitle: string; displayTitleSource: "dashboard" | "host" } | undefined {
    const session = this.sessions.get(handle.internalId);
    const bounded = boundedDisplayTitle(displayTitle);
    if (!session?.conversationLabel || !bounded) return undefined;
    let conversation = this.conversations.get(session.conversationLabel);
    if (!conversation) {
      conversation = {
        conversationLabel: session.conversationLabel,
        displayTitle: bounded,
        displayTitleSource: "dashboard",
        firstSeenAt: now,
        lastActiveAt: now,
        operations: [],
      };
      this.conversations.set(session.conversationLabel, conversation);
    } else if (conversation.displayTitleSource !== "host") {
      conversation.displayTitle = bounded;
      conversation.displayTitleSource = "dashboard";
      conversation.lastActiveAt = Math.max(conversation.lastActiveAt, now);
    }
    this.pruneConversationHistory(now);
    return {
      conversationLabel: session.conversationLabel,
      displayTitle: conversation.displayTitle ?? bounded,
      displayTitleSource: conversation.displayTitleSource ?? "dashboard",
    };
  }

  conversationTitleState(
    handle: RuntimeSessionHandle,
  ): { conversationLabel?: string; displayTitle?: string; displayTitleSource?: "host" | "dashboard"; taskLabel?: string } {
    const session = this.sessions.get(handle.internalId);
    if (!session?.conversationLabel) return {};
    const conversation = this.conversations.get(session.conversationLabel);
    return {
      conversationLabel: session.conversationLabel,
      ...(conversation?.displayTitle ? { displayTitle: conversation.displayTitle } : {}),
      ...(conversation?.displayTitleSource ? { displayTitleSource: conversation.displayTitleSource } : {}),
      ...(conversation?.taskLabel ? { taskLabel: conversation.taskLabel } : {}),
    };
  }

  closeSession(handle: RuntimeSessionHandle, now = Date.now()): void {
    const session = this.sessions.get(handle.internalId);
    if (!session) return;
    if (session.operations.length === 0) {
      this.sessions.delete(handle.internalId);
      return;
    }
    // Short MCP calls are still meaningful activity. Keep them briefly so the
    // status UI does not look idle between sub-second tool calls. Memory stays
    // bounded by MAX_RECENT_CLOSED_SESSIONS and RECENT_OPERATION_TTL_MS.
    session.closedAt = now;
    session.lastActiveAt = now;
    this.pruneClosedSessions(now);
  }

  startOperation(
    handle: RuntimeSessionHandle,
    tool: string,
    now = Date.now(),
    projectId?: string,
    activityHint?: string,
  ): string | undefined {
    const session = this.sessions.get(handle.internalId);
    if (!session) return undefined;
    const operationId = randomUUID();
    session.lastActiveAt = now;
    const operation: OperationRecord = {
      operationId,
      tool: boundedLabel(tool, "tool"),
      ...(projectId ? { projectId: boundedLabel(projectId, "project") } : {}),
      ...(activityHint ? { activityHint: boundedTaskLabel(activityHint) } : {}),
      startedAt: now,
      state: "running",
    };
    session.operations.push(operation);
    if (session.conversationLabel) {
      this.attachConversationOperation(session.conversationLabel, operation);
    }
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
    this.touchConversation(session.conversationLabel, now);
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
    this.touchConversation(session.conversationLabel, now);
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
    input: { excludeTools?: readonly string[]; session?: RuntimeSessionHandle; capabilityScope?: string; now?: number } = {},
  ): RuntimeActiveOperation[] {
    const now = input.now ?? Date.now();
    const excluded = new Set(input.excludeTools ?? []);
    const active: RuntimeActiveOperation[] = [];
    for (const session of this.sessions.values()) {
      if (input.session && session.handle.internalId !== input.session.internalId) continue;
      if (input.capabilityScope && session.capabilityScope !== input.capabilityScope) continue;
      const identity = session.externalId ?? session.handle.internalId;
      const sessionLabel = `${session.transport.toUpperCase()}-${shortHash(identity)}`;
      for (const operation of session.operations) {
        if (operation.finishedAt !== undefined || excluded.has(operation.tool)) continue;
        active.push({
          sessionLabel,
          operationId: operation.operationId,
          tool: operation.tool,
          ...(operation.projectId ? { projectId: operation.projectId } : {}),
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

  /**
   * Secret-safe ownership liveness probe. Callers provide a digest matcher so
   * raw capability scopes never leave the tracker; only bounded activity
   * booleans/timestamps are returned.
   */
  capabilityScopeActivity(input: {
    matchesScope: (scope: string) => boolean;
    now?: number;
    recentWithinMs?: number;
    excludeTools?: readonly string[];
  }): { present: boolean; active: boolean; recent: boolean; lastActiveAt?: number } {
    const now = input.now ?? Date.now();
    const recentWithinMs = Math.max(0, input.recentWithinMs ?? RECENT_OPERATION_TTL_MS);
    const excludedTools = new Set(input.excludeTools ?? []);
    this.pruneClosedSessions(now);
    let present = false;
    let active = false;
    let recent = false;
    let lastActiveAt: number | undefined;
    for (const session of this.sessions.values()) {
      if (!session.capabilityScope || !input.matchesScope(session.capabilityScope)) continue;
      present = true;
      active ||= session.operations.some(
        (operation) => operation.finishedAt === undefined && !excludedTools.has(operation.tool),
      );
      recent ||= now - session.lastActiveAt <= recentWithinMs;
      lastActiveAt = Math.max(lastActiveAt ?? 0, session.lastActiveAt);
    }
    return {
      present,
      active,
      recent,
      ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
    };
  }

  snapshot(now = Date.now()): RuntimeSessionSummary[] {
    this.pruneClosedSessions(now);
    const summaries: RuntimeSessionSummary[] = [];
    for (const session of this.sessions.values()) {
      session.operations = session.operations.filter((operation) => {
        if (operation.finishedAt === undefined) return true;
        const ttl = operation.state === "waiting-approval" ? RECENT_ATTENTION_TTL_MS : RECENT_OPERATION_TTL_MS;
        return now - operation.finishedAt <= ttl;
      });
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
        ...(session.conversationLabel ? { conversationLabel: session.conversationLabel } : {}),
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
                ...(operation.projectId ? { projectId: operation.projectId } : {}),
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

  /**
   * Return bounded, secret-safe activity grouped by ChatGPT conversation.
   * Operations are chronological within each group; groups are most-recent
   * first. This history is intentionally separate from the short-lived
   * transport-session snapshot used by the existing status menu.
   */
  conversationSnapshot(now = Date.now()): RuntimeConversationSummary[] {
    this.pruneConversationHistory(now);
    return [...this.conversations.values()]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.conversationLabel.localeCompare(b.conversationLabel))
      .map((conversation) => {
        const operations = [...conversation.operations]
          .sort((a, b) => a.startedAt - b.startedAt || a.operationId.localeCompare(b.operationId));
        const active = [...operations].reverse().find((operation) => operation.finishedAt === undefined);
        const latest = operations.at(-1);
        const state = active?.state ?? latest?.state ?? "idle";
        const activityHighlights: RuntimeConversationSummary["activityHighlights"] = [];
        for (const operation of operations) {
          const kind = semanticActivityKind(operation);
          if (kind === "other") continue;
          const highlight = {
            kind,
            state: operation.state,
            startedAt: operation.startedAt,
            ...(operation.finishedAt !== undefined ? { finishedAt: operation.finishedAt } : {}),
          };
          if (activityHighlights.at(-1)?.kind === kind) {
            activityHighlights[activityHighlights.length - 1] = highlight;
          } else {
            activityHighlights.push(highlight);
          }
        }
        if (activityHighlights.length > MAX_ACTIVITY_HIGHLIGHTS) {
          activityHighlights.splice(0, activityHighlights.length - MAX_ACTIVITY_HIGHLIGHTS);
        }
        const visibleUntil = dashboardVisibleUntil(state, latest);
        return {
          conversationLabel: conversation.conversationLabel,
          ...(conversation.taskLabel ? { taskLabel: conversation.taskLabel } : {}),
          ...(conversation.displayTitle ? { displayTitle: conversation.displayTitle } : {}),
          ...(conversation.displayTitleSource ? { displayTitleSource: conversation.displayTitleSource } : {}),
          firstSeenAt: conversation.firstSeenAt,
          lastActiveAt: conversation.lastActiveAt,
          state,
          ...(visibleUntil !== undefined ? { dashboardVisibleUntil: visibleUntil } : {}),
          activityHighlights,
          operations: operations.map((operation) => ({
            operationId: operation.operationId,
            tool: operation.tool,
            ...(operation.projectId ? { projectId: operation.projectId } : {}),
            state: operation.state,
            startedAt: operation.startedAt,
            ...(operation.finishedAt !== undefined ? { finishedAt: operation.finishedAt } : {}),
            elapsedMs: Math.max(0, (operation.finishedAt ?? now) - operation.startedAt),
            ...(operation.phase ? { phase: operation.phase } : {}),
            ...(operation.message ? { message: operation.message } : {}),
            ...(operation.activityHint ? { activityHint: operation.activityHint } : {}),
            ...(operation.lastProgressAt !== undefined ? { lastProgressAt: operation.lastProgressAt } : {}),
            ...(operation.progress !== undefined ? { progress: operation.progress } : {}),
            ...(operation.clientCancelledAt !== undefined
              ? {
                  clientCancellation: {
                    observedAt: operation.clientCancelledAt,
                    operationContinues: operation.finishedAt === undefined,
                    automaticRetrySafe: false as const,
                  },
                }
              : {}),
            semanticKind: semanticActivityKind(operation),
          })),
        };
      });
  }

  private attachConversationOperation(conversationLabel: string, operation: OperationRecord): void {
    let conversation = this.conversations.get(conversationLabel);
    if (!conversation) {
      conversation = {
        conversationLabel,
        firstSeenAt: operation.startedAt,
        lastActiveAt: operation.startedAt,
        operations: [],
      };
      this.conversations.set(conversationLabel, conversation);
    }
    if (!conversation.operations.some((candidate) => candidate.operationId === operation.operationId)) {
      conversation.operations.push(operation);
    }
    conversation.firstSeenAt = Math.min(conversation.firstSeenAt, operation.startedAt);
    conversation.lastActiveAt = Math.max(conversation.lastActiveAt, operation.lastProgressAt ?? operation.finishedAt ?? operation.startedAt);
    if (conversation.operations.length > MAX_CONVERSATION_OPERATIONS) {
      conversation.operations.splice(0, conversation.operations.length - MAX_CONVERSATION_OPERATIONS);
      conversation.firstSeenAt = conversation.operations[0]?.startedAt ?? conversation.lastActiveAt;
    }
    this.pruneConversationHistory(operation.lastProgressAt ?? operation.finishedAt ?? operation.startedAt);
  }

  private touchConversation(conversationLabel: string | undefined, now: number): void {
    if (!conversationLabel) return;
    const conversation = this.conversations.get(conversationLabel);
    if (conversation) conversation.lastActiveAt = Math.max(conversation.lastActiveAt, now);
  }

  private pruneConversationHistory(now: number): void {
    for (const [label, conversation] of this.conversations) {
      conversation.operations = conversation.operations.filter(
        (operation) => operation.finishedAt === undefined || now - operation.finishedAt <= CONVERSATION_HISTORY_TTL_MS,
      );
      if (conversation.operations.length === 0) {
        if (now - conversation.lastActiveAt > CONVERSATION_HISTORY_TTL_MS) {
          this.conversations.delete(label);
        }
        continue;
      }
      conversation.firstSeenAt = conversation.operations[0]?.startedAt ?? conversation.firstSeenAt;
    }
    const ordered = [...this.conversations.values()]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.conversationLabel.localeCompare(b.conversationLabel));
    for (const conversation of ordered.slice(MAX_CONVERSATION_HISTORY)) {
      this.conversations.delete(conversation.conversationLabel);
    }
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
