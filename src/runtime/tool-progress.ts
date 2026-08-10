export type ToolProgressToken = string | number;

export type ToolProgressPhase =
  | "queued"
  | "approval"
  | "spawn"
  | "preparing"
  | "running"
  | "cleanup"
  | "serialize"
  | "completed"
  | "verifying"
  | "capturing"
  | "finalizing"
  | "reconnecting";

export interface ToolProgressEvent {
  phase: ToolProgressPhase;
  message: string;
  progress: number;
  at: number;
  heartbeat: boolean;
}

export interface ToolProgressHandlerExtra {
  _meta?: {
    progressToken?: unknown;
    [key: string]: unknown;
  };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: ToolProgressToken;
      progress: number;
      message?: string;
    };
  }) => Promise<void>;
}

export interface ToolProgressReporter {
  update(phase: ToolProgressPhase, message: string): Promise<void>;
  stop(message: string): Promise<void>;
}

interface StartToolProgressReporterOptions {
  extra?: ToolProgressHandlerExtra;
  initialPhase: ToolProgressPhase;
  initialMessage: string;
  heartbeatIntervalMs?: number;
  onProgress?: (event: ToolProgressEvent) => void;
  now?: () => number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_PROGRESS_MESSAGE_LENGTH = 180;

function boundedMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PROGRESS_MESSAGE_LENGTH);
}

function progressTokenFrom(extra: ToolProgressHandlerExtra | undefined): ToolProgressToken | undefined {
  const token = extra?._meta?.progressToken;
  if (typeof token === "string" && token.length > 0) return token;
  if (typeof token === "number" && Number.isFinite(token)) return token;
  return undefined;
}

export async function startToolProgressReporter(
  options: StartToolProgressReporterOptions,
): Promise<ToolProgressReporter> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const heartbeatIntervalMs = Math.max(1, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  const progressToken = progressTokenFrom(options.extra);
  let phase = options.initialPhase;
  let message = boundedMessage(options.initialMessage);
  let progress = 0;
  let stopped = false;
  let emittingHeartbeat = false;

  const emit = async (heartbeat: boolean): Promise<void> => {
    if (stopped) return;
    progress += 1;
    const at = now();
    const elapsedSeconds = Math.max(0, Math.floor((at - startedAt) / 1_000));
    const visibleMessage = boundedMessage(
      heartbeat && elapsedSeconds > 0 ? `${message} · ${elapsedSeconds}s elapsed` : message,
    );
    try {
      options.onProgress?.({ phase, message: visibleMessage, progress, at, heartbeat });
    } catch {
      // Local observation must never be able to fail the tool call.
    }
    if (progressToken === undefined || !options.extra?.sendNotification) return;
    try {
      await options.extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          message: visibleMessage,
        },
      });
    } catch {
      // Progress is best-effort. A client that ignores or rejects progress
      // notifications must not change the underlying tool result.
    }
  };

  await emit(false);
  const timer = setInterval(() => {
    if (emittingHeartbeat || stopped) return;
    emittingHeartbeat = true;
    void emit(true).finally(() => {
      emittingHeartbeat = false;
    });
  }, heartbeatIntervalMs);
  timer.unref?.();

  return {
    async update(nextPhase, nextMessage) {
      if (stopped) return;
      phase = nextPhase;
      message = boundedMessage(nextMessage);
      await emit(false);
    },
    async stop(finalMessage) {
      if (stopped) return;
      clearInterval(timer);
      phase = "completed";
      message = boundedMessage(finalMessage);
      await emit(false);
      stopped = true;
    },
  };
}
