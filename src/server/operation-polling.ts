export interface OperationPollingSnapshot {
  state: string;
  elapsedMs: number;
  lastHeartbeatAt: number;
}

const HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 8_000;

export function recommendedOperationPollAfterMs(
  snapshot: OperationPollingSnapshot,
  now = Date.now(),
): number {
  switch (snapshot.state) {
    case "queued":
    case "spawning":
      return 1_000;
    case "cleanup":
      return 1_500;
    case "approval-wait":
      return 5_000;
    case "running": {
      const base = snapshot.elapsedMs < 5_000
        ? 1_500
        : snapshot.elapsedMs < 20_000
          ? 3_000
          : snapshot.elapsedMs < 60_000
            ? 5_000
            : MAX_POLL_MS;
      const heartbeatAgeMs = Math.max(0, now - snapshot.lastHeartbeatAt);
      const untilNextHeartbeatMs = heartbeatAgeMs < HEARTBEAT_INTERVAL_MS
        ? HEARTBEAT_INTERVAL_MS - heartbeatAgeMs + 250
        : 0;
      return Math.min(MAX_POLL_MS, Math.max(base, untilNextHeartbeatMs));
    }
    default:
      return 3_000;
  }
}
