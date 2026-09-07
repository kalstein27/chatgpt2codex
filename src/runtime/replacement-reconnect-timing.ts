import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const HISTORY_LIMIT = 64;
const MIN_SAMPLES_FOR_PREDICTION = 3;
const DEFAULT_PREDICTED_WAIT_MS = 5_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_RUNTIME_MAX_WINDOW_MS = 20_000;
const DEFAULT_MACOS_APP_MAX_WINDOW_MS = 30_000;
const MAX_DURATION_MS = 2 * 60_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

export type ReplacementReconnectKind = "runtime" | "macos-app";
export type ReplacementReconnectOutcome = "healthy" | "rolled-back" | "failed";

export interface ReplacementReconnectSample {
  at: string;
  kind: ReplacementReconnectKind;
  durationMs: number;
  outcome: ReplacementReconnectOutcome;
}

export interface ReplacementReconnectPlan {
  predictedWaitMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  maxWindowMs: number;
  sampleCount: number;
  basis: "default-5s" | "p90-plus-margin";
  statusOnly: true;
  automaticMutationReplay: false;
  p50Ms?: number;
  p90Ms?: number;
  p95Ms?: number;
  marginMs?: number;
}

interface ReplacementReconnectHistory {
  schemaVersion: 1;
  samples: ReplacementReconnectSample[];
}

function historyFile(stateDir: string): string {
  return path.join(stateDir, "replacement-reconnect-timing.json");
}

function lockDirectory(stateDir: string): string {
  return path.join(stateDir, ".replacement-reconnect-timing.lock");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index] ?? 0);
}

function validSample(value: unknown): ReplacementReconnectSample | null {
  if (!value || typeof value !== "object") return null;
  const sample = value as Partial<ReplacementReconnectSample>;
  if (sample.kind !== "runtime" && sample.kind !== "macos-app") return null;
  if (sample.outcome !== "healthy" && sample.outcome !== "rolled-back" && sample.outcome !== "failed") return null;
  if (typeof sample.at !== "string" || !Number.isFinite(Date.parse(sample.at))) return null;
  if (!Number.isFinite(sample.durationMs)) return null;
  return {
    at: sample.at,
    kind: sample.kind,
    durationMs: clamp(sample.durationMs ?? 0, 0, MAX_DURATION_MS),
    outcome: sample.outcome,
  };
}

async function readHistory(stateDir: string): Promise<ReplacementReconnectHistory> {
  try {
    const parsed = JSON.parse(await fs.readFile(historyFile(stateDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { schemaVersion: SCHEMA_VERSION, samples: [] };
    const candidate = parsed as { schemaVersion?: unknown; samples?: unknown };
    if (candidate.schemaVersion !== SCHEMA_VERSION || !Array.isArray(candidate.samples)) {
      return { schemaVersion: SCHEMA_VERSION, samples: [] };
    }
    const samples = candidate.samples
      .map(validSample)
      .filter((sample): sample is ReplacementReconnectSample => sample !== null)
      .slice(-HISTORY_LIMIT);
    return { schemaVersion: SCHEMA_VERSION, samples };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, samples: [] };
    return { schemaVersion: SCHEMA_VERSION, samples: [] };
  }
}

async function atomicWriteHistory(stateDir: string, history: ReplacementReconnectHistory): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  const target = historyFile(stateDir);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
  await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
  try {
    await fs.rename(temporary, target);
    await fs.chmod(target, FILE_MODE).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function withHistoryLock<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  const lock = lockDirectory(stateDir);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lock, { mode: DIR_MODE });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await fs.stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("replacement reconnect timing state is busy");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function replacementReconnectPlanFromSamples(
  samples: readonly ReplacementReconnectSample[],
  kind: ReplacementReconnectKind,
): ReplacementReconnectPlan {
  const healthyDurations = samples
    .filter((sample) => sample.kind === kind && sample.outcome === "healthy")
    .map((sample) => clamp(sample.durationMs, 0, MAX_DURATION_MS))
    .slice(-HISTORY_LIMIT);
  const sampleCount = healthyDurations.length;
  if (sampleCount < MIN_SAMPLES_FOR_PREDICTION) {
    const maxWindowMs = kind === "macos-app"
      ? DEFAULT_MACOS_APP_MAX_WINDOW_MS
      : DEFAULT_RUNTIME_MAX_WINDOW_MS;
    return {
      predictedWaitMs: DEFAULT_PREDICTED_WAIT_MS,
      retryIntervalMs: DEFAULT_RETRY_INTERVAL_MS,
      maxAttempts: Math.floor((maxWindowMs - DEFAULT_PREDICTED_WAIT_MS) / DEFAULT_RETRY_INTERVAL_MS) + 1,
      maxWindowMs,
      sampleCount,
      basis: "default-5s",
      statusOnly: true,
      automaticMutationReplay: false,
    };
  }

  const p50Ms = percentile(healthyDurations, 0.50);
  const p90Ms = percentile(healthyDurations, 0.90);
  const p95Ms = percentile(healthyDurations, 0.95);
  const marginMs = clamp(Math.max(500, p95Ms * 0.20), 500, 5_000);
  const predictedWaitMs = clamp(p90Ms + marginMs, 1_000, 15_000);
  const retryIntervalMs = clamp(Math.max(750, p50Ms / 2), 750, 2_500);
  const maxWindowMs = clamp(Math.max(15_000, predictedWaitMs * 3, p95Ms + marginMs * 4), 15_000, 60_000);
  const maxAttempts = Math.max(1, Math.floor(Math.max(0, maxWindowMs - predictedWaitMs) / retryIntervalMs) + 1);
  return {
    predictedWaitMs,
    retryIntervalMs,
    maxAttempts,
    maxWindowMs,
    sampleCount,
    basis: "p90-plus-margin",
    statusOnly: true,
    automaticMutationReplay: false,
    p50Ms,
    p90Ms,
    p95Ms,
    marginMs,
  };
}

export async function readReplacementReconnectPlan(
  stateDir: string,
  kind: ReplacementReconnectKind,
): Promise<ReplacementReconnectPlan> {
  const history = await readHistory(stateDir);
  return replacementReconnectPlanFromSamples(history.samples, kind);
}

export async function recordReplacementReconnectSample(
  stateDir: string,
  sample: ReplacementReconnectSample,
): Promise<ReplacementReconnectPlan> {
  return withHistoryLock(stateDir, async () => {
    const history = await readHistory(stateDir);
    const normalized = validSample(sample);
    if (!normalized) throw new Error("invalid replacement reconnect timing sample");
    const next: ReplacementReconnectHistory = {
      schemaVersion: SCHEMA_VERSION,
      samples: [...history.samples, normalized].slice(-HISTORY_LIMIT),
    };
    await atomicWriteHistory(stateDir, next);
    return replacementReconnectPlanFromSamples(next.samples, normalized.kind);
  });
}
