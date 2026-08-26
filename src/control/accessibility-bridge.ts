import { randomUUID } from "node:crypto";

export type AccessibilityBridgeKind =
  | "frontmost"
  | "windowregion"
  | "resolve"
  | "press"
  | "setvalue"
  | "click"
  | "doubleclick"
  | "move"
  | "drag"
  | "scroll"
  | "type"
  | "key"
  | "keypress"
  | "preflight";

export interface AccessibilityBridgePayload {
  appName?: string;
  role?: string;
  title?: string;
  description?: string;
  text?: string;
  x?: number;
  y?: number;
  keyCode?: number;
  button?: "left" | "right" | "middle";
  points?: Array<{ x: number; y: number }>;
  scrollX?: number;
  scrollY?: number;
  keyCodes?: number[];
  modifiers?: string[];
}

export interface AccessibilityBridgeRequest extends AccessibilityBridgePayload {
  requestId: string;
  kind: AccessibilityBridgeKind;
  createdAt: number;
  expiresAt: number;
}

export interface AccessibilityBridgeCompletion {
  requestId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

interface PendingRequest {
  request: AccessibilityBridgeRequest;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const TERMINAL_RETENTION_MS = 60_000;
const pending = new Map<string, PendingRequest>();
const terminal = new Map<string, { completedAt: number; ok: boolean }>();

function pruneTerminal(now = Date.now()): void {
  for (const [requestId, record] of terminal) {
    if (now - record.completedAt > TERMINAL_RETENTION_MS) terminal.delete(requestId);
  }
}

export function listPendingAccessibilityBridgeRequests(now = Date.now()): AccessibilityBridgeRequest[] {
  pruneTerminal(now);
  return [...pending.values()]
    .map((entry) => entry.request)
    .filter((request) => request.expiresAt > now)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export async function completeAccessibilityBridgeRequest(
  completion: AccessibilityBridgeCompletion,
): Promise<{ accepted: boolean; alreadyCompleted: boolean }> {
  pruneTerminal();
  const entry = pending.get(completion.requestId);
  if (!entry) {
    return { accepted: false, alreadyCompleted: terminal.has(completion.requestId) };
  }

  clearTimeout(entry.timer);
  pending.delete(completion.requestId);
  terminal.set(completion.requestId, { completedAt: Date.now(), ok: completion.ok });

  if (!completion.ok) {
    entry.reject(new Error(completion.error || "menu-bar accessibility bridge request failed"));
    return { accepted: true, alreadyCompleted: false };
  }

  entry.resolve(completion.result ?? {});
  return { accepted: true, alreadyCompleted: false };
}

export function requestAccessibilityBridge(input: {
  kind: AccessibilityBridgeKind;
  payload?: AccessibilityBridgePayload;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const createdAt = Date.now();
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000));
  const request: AccessibilityBridgeRequest = {
    requestId: `ax_${randomUUID()}`,
    kind: input.kind,
    ...(input.payload ?? {}),
    createdAt,
    expiresAt: createdAt + timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.requestId);
      terminal.set(request.requestId, { completedAt: Date.now(), ok: false });
      reject(new Error(`menu-bar accessibility bridge ${request.kind} timed out`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(request.requestId, { request, resolve, reject, timer });
  });
}

export function resetAccessibilityBridgeForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  terminal.clear();
}
