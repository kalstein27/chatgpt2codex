import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

export interface ScreenshotCaptureRequest {
  requestId: string;
  outputPath: string;
  region?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ScreenshotCaptureCompletion {
  requestId: string;
  ok: boolean;
  error?: string;
}

interface PendingCapture {
  request: ScreenshotCaptureRequest;
  resolve: (value: { path: string; bytes: number }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const TERMINAL_RETENTION_MS = 60_000;
const pending = new Map<string, PendingCapture>();
const terminal = new Map<string, { completedAt: number; ok: boolean }>();

function pruneTerminal(now = Date.now()): void {
  for (const [requestId, record] of terminal) {
    if (now - record.completedAt > TERMINAL_RETENTION_MS) terminal.delete(requestId);
  }
}

export function listPendingScreenshotCaptures(now = Date.now()): ScreenshotCaptureRequest[] {
  pruneTerminal(now);
  return [...pending.values()]
    .map((entry) => entry.request)
    .filter((request) => request.expiresAt > now)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export async function completeScreenshotCapture(
  completion: ScreenshotCaptureCompletion,
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
    entry.reject(new Error(completion.error || "menu-bar screenshot capture failed"));
    return { accepted: true, alreadyCompleted: false };
  }

  try {
    const stat = await fs.stat(entry.request.outputPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error("menu-bar screenshot capture completed without a non-empty PNG");
    }
    entry.resolve({ path: entry.request.outputPath, bytes: stat.size });
  } catch (error) {
    entry.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return { accepted: true, alreadyCompleted: false };
}

export function requestScreenshotCapture(input: {
  outputPath: string;
  region?: string;
  timeoutMs?: number;
}): Promise<{ path: string; bytes: number }> {
  const createdAt = Date.now();
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000));
  const request: ScreenshotCaptureRequest = {
    requestId: `shot_${randomUUID()}`,
    outputPath: input.outputPath,
    ...(input.region ? { region: input.region } : {}),
    createdAt,
    expiresAt: createdAt + timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.requestId);
      terminal.set(request.requestId, { completedAt: Date.now(), ok: false });
      reject(new Error("menu-bar screenshot capture timed out"));
    }, timeoutMs);
    timer.unref?.();
    pending.set(request.requestId, { request, resolve, reject, timer });
  });
}

export function resetScreenshotCaptureBridgeForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  terminal.clear();
}
