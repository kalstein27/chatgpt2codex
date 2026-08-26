import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_LOG_BYTES = 512 * 1024;
// About one day of minute-level safe samples while keeping status reads cheap.
const MAX_PROBE_LOG_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 16 * 1024;
const DEFAULT_RECENT_PROBES = 12;
const MAX_RECENT_PROBES = 50;
const STATUS_CACHE_TTL_MS = 2_000;
const PROBE_STALE_AFTER_MS = 3 * 60_000;
const SAFE_STATUS = new Set(["healthy", "unhealthy", "unknown"]);
const SAFE_FAILURE_REASONS = new Set([
  "tailscale_offline",
  "funnel_config_missing",
  "public_funnel_unreachable",
  "local_runtime_unavailable",
  "internet_unavailable",
]);
const SAFE_PROBE_STATUSES = new Set([
  "healthy",
  "internet_unavailable",
  "local_runtime_unavailable",
  "tailscale_offline",
  "funnel_config_missing",
  "public_funnel_unreachable",
]);
const SAFE_PROBE_CLASSES = new Set([
  "healthy",
  "not_run",
  "tls_handshake",
  "certificate",
  "dns_no_a_records",
  "dns",
  "connect",
  "timeout",
  "edge_unreachable",
  "unknown",
]);

export interface ExternalWatchdogProbeSample {
  at: string;
  diagnosticId: string;
  status: string;
  internetOk: boolean;
  localRuntimeOk: boolean;
  tailscaleOk: boolean;
  funnelOk: boolean;
  publicFunnelOk: boolean;
  publicProbeClass: string;
  edgeCount: number;
  passedEdgeCount: number;
}

export interface ExternalWatchdogProbeWindow {
  available: boolean;
  requestedSince: string | null;
  requestedUntil: string | null;
  firstProbeAt: string | null;
  lastProbeAt: string | null;
  sampleCount: number;
  healthySampleCount: number;
  unhealthySampleCount: number;
  recentSamples: ExternalWatchdogProbeSample[];
}

export interface ExternalWatchdogFailureSummary {
  at: string;
  category: string;
  probeClass: string | null;
  diagnosticId: string | null;
}

export interface ExternalWatchdogStatus {
  available: boolean;
  watchdogVersion: number | null;
  status: "healthy" | "unhealthy" | "unknown";
  consecutiveFailures: number;
  lastFailureReason: string | null;
  lastRecoveryAt: string | null;
  lastProbeAt: string | null;
  probeAgeMs: number | null;
  probeFresh: boolean | null;
  lastEventAt: string | null;
  recentFailure: ExternalWatchdogFailureSummary | null;
  probeWindow: ExternalWatchdogProbeWindow;
  observationScope: "external-tunnel-probe";
  hostExceptionBodyObservable: false;
}

interface PrivateTail {
  raw: string;
  modifiedAt: string | null;
}

let statusCache: {
  homeDir: string;
  expiresAt: number;
  value: Promise<ExternalWatchdogStatus>;
} | null = null;

function rootDirectory(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", "ChatGPT To Codex", "TailscaleWatchdog");
}

function emptyProbeWindow(
  requestedSince: string | null = null,
  requestedUntil: string | null = null,
): ExternalWatchdogProbeWindow {
  return {
    available: false,
    requestedSince,
    requestedUntil,
    firstProbeAt: null,
    lastProbeAt: null,
    sampleCount: 0,
    healthySampleCount: 0,
    unhealthySampleCount: 0,
    recentSamples: [],
  };
}

async function readPrivateTail(file: string, maximumBytes: number): Promise<PrivateTail> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(file, fsConstants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) return { raw: "", modifiedAt: null };
  try {
    const info = await handle.stat();
    const uid = process.getuid?.();
    if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      return { raw: "", modifiedAt: null };
    }
    const length = Math.min(maximumBytes, info.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    return {
      raw: buffer.toString("utf8"),
      modifiedAt: Number.isFinite(info.mtimeMs) ? new Date(info.mtimeMs).toISOString() : null,
    };
  } finally {
    await handle.close();
  }
}

function parseState(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^([a-z_]+)=([A-Za-z0-9_.-]*)$/u.exec(line.trim());
    if (match?.[1]) values.set(match[1], match[2] ?? "");
  }
  return values;
}

function safeInteger(value: string | undefined): number {
  return value && /^\d+$/u.test(value) ? Number(value) : 0;
}

function epochIso(value: string | undefined): string | null {
  const seconds = safeInteger(value);
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function parseTimestamp(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{4})$/u.exec(value);
  if (!match) return null;
  const zone = `${match[2]?.slice(0, 3)}:${match[2]?.slice(3)}`;
  const parsed = new Date(`${match[1]}${zone}`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function token(line: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`, "u").exec(line);
  return match?.[1]?.slice(0, 160) ?? null;
}

function safeProbeClass(value: string | null): string {
  if (!value) return "unknown";
  if (SAFE_PROBE_CLASSES.has(value)) return value;
  if (/^http_[0-9]{3}$/u.test(value)) return value;
  if (/^curl_[0-9]{1,3}$/u.test(value)) return value;
  return "unknown";
}

function binaryFlag(value: string | null): boolean | null {
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

function parseProbeSamples(raw: string): ExternalWatchdogProbeSample[] {
  const samples: ExternalWatchdogProbeSample[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const at = parseTimestamp(line.split(/\s+/u)[0] ?? "");
    const diagnosticId = token(line, "diag");
    const status = token(line, "status");
    const internetOk = binaryFlag(token(line, "internet"));
    const localRuntimeOk = binaryFlag(token(line, "local_runtime"));
    const tailscaleOk = binaryFlag(token(line, "tailscale"));
    const funnelOk = binaryFlag(token(line, "funnel"));
    const publicFunnelOk = binaryFlag(token(line, "public_funnel"));
    if (
      !at
      || !diagnosticId
      || !/^wd_[A-Za-z0-9_.-]{1,120}$/u.test(diagnosticId)
      || !status
      || !SAFE_PROBE_STATUSES.has(status)
      || internetOk === null
      || localRuntimeOk === null
      || tailscaleOk === null
      || funnelOk === null
      || publicFunnelOk === null
    ) continue;
    const edgeCount = Math.min(256, safeInteger(token(line, "edge_count") ?? undefined));
    const passedEdgeCount = Math.min(edgeCount, safeInteger(token(line, "edge_passed") ?? undefined));
    samples.push({
      at,
      diagnosticId,
      status,
      internetOk,
      localRuntimeOk,
      tailscaleOk,
      funnelOk,
      publicFunnelOk,
      publicProbeClass: safeProbeClass(token(line, "public_class")),
      edgeCount,
      passedEdgeCount,
    });
  }
  return samples.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

function probeWindow(
  samples: ExternalWatchdogProbeSample[],
  requestedSince: string | null,
  requestedUntil: string | null,
  maximumSamples: number,
): ExternalWatchdogProbeWindow {
  const sinceMs = requestedSince ? Date.parse(requestedSince) : Number.NEGATIVE_INFINITY;
  const untilMs = requestedUntil ? Date.parse(requestedUntil) : Number.POSITIVE_INFINITY;
  const filtered = samples.filter((sample) => {
    const at = Date.parse(sample.at);
    return Number.isFinite(at) && at >= sinceMs && at <= untilMs;
  });
  const boundedMaximum = Math.min(MAX_RECENT_PROBES, Math.max(1, Math.floor(maximumSamples)));
  return {
    available: samples.length > 0,
    requestedSince,
    requestedUntil,
    firstProbeAt: filtered.at(0)?.at ?? null,
    lastProbeAt: filtered.at(-1)?.at ?? null,
    sampleCount: filtered.length,
    healthySampleCount: filtered.filter((sample) => sample.status === "healthy").length,
    unhealthySampleCount: filtered.filter((sample) => sample.status !== "healthy").length,
    recentSamples: filtered.slice(-boundedMaximum),
  };
}

function probeClass(line: string): string | null {
  const publicDetail = token(line, "public");
  if (!publicDetail) return null;
  for (const value of ["tls_handshake", "certificate", "dns_no_a_records", "dns", "connect", "timeout"]) {
    if (publicDetail.includes(value)) return value;
  }
  const http = /failure-http_([0-9]{3})/u.exec(publicDetail)?.[1];
  if (http) return `http_${http}`;
  if (publicDetail.includes("passed-0")) return "edge_unreachable";
  if (publicDetail.includes("failure-none")) return "healthy";
  return "unknown";
}

function failureCategory(line: string): string | null {
  const reason = token(line, "reason");
  if (reason && SAFE_FAILURE_REASONS.has(reason)) return reason;
  if (line.includes("recovery=failed")) return `recovery_${token(line, "step") ?? "failed"}`;
  return null;
}

function parseLog(raw: string): { lastEventAt: string | null; recentFailure: ExternalWatchdogFailureSummary | null } {
  const lines = raw.split(/\r?\n/u).filter(Boolean);
  let recentFailure: ExternalWatchdogFailureSummary | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const at = parseTimestamp(line.split(/\s+/u)[0] ?? "");
    const category = failureCategory(line);
    if (at && category) {
      recentFailure = {
        at,
        category,
        probeClass: probeClass(line),
        diagnosticId: token(line, "diag"),
      };
      break;
    }
  }
  const lastEventAt = lines.length > 0 ? parseTimestamp(lines.at(-1)?.split(/\s+/u)[0] ?? "") : null;
  return { lastEventAt, recentFailure };
}

async function loadExternalWatchdogStatus(
  homeDir = os.homedir(),
): Promise<ExternalWatchdogStatus> {
  if (process.platform !== "darwin") {
    return {
      available: false,
      watchdogVersion: null,
      status: "unknown",
      consecutiveFailures: 0,
      lastFailureReason: null,
      lastRecoveryAt: null,
      lastProbeAt: null,
      probeAgeMs: null,
      probeFresh: null,
      lastEventAt: null,
      recentFailure: null,
      probeWindow: emptyProbeWindow(),
      observationScope: "external-tunnel-probe",
      hostExceptionBodyObservable: false,
    };
  }
  const root = rootDirectory(homeDir);
  const [stateFile, logFile, probeLogFile] = await Promise.all([
    readPrivateTail(path.join(root, "state"), MAX_STATE_BYTES),
    readPrivateTail(path.join(root, "watchdog.log"), MAX_LOG_BYTES),
    readPrivateTail(path.join(root, "probe-history.log"), MAX_PROBE_LOG_BYTES),
  ]);
  const stateRaw = stateFile.raw;
  const logRaw = logFile.raw;
  const state = parseState(stateRaw);
  const parsedLog = parseLog(logRaw);
  const probeSamples = parseProbeSamples(probeLogFile.raw);
  const recentProbeWindow = probeWindow(probeSamples, null, null, DEFAULT_RECENT_PROBES);
  const statusValue = state.get("last_status") ?? "unknown";
  const failureReason = state.get("last_failure_reason") ?? "";
  const lastProbeMs = stateFile.modifiedAt ? Date.parse(stateFile.modifiedAt) : Number.NaN;
  const probeAgeMs = Number.isFinite(lastProbeMs) ? Math.max(0, Date.now() - lastProbeMs) : null;
  return {
    available: stateRaw.length > 0 || logRaw.length > 0,
    watchdogVersion: state.has("watchdog_version") ? safeInteger(state.get("watchdog_version")) : null,
    status: SAFE_STATUS.has(statusValue) ? statusValue as ExternalWatchdogStatus["status"] : "unknown",
    consecutiveFailures: safeInteger(state.get("failures")),
    lastFailureReason: SAFE_FAILURE_REASONS.has(failureReason) ? failureReason : null,
    lastRecoveryAt: epochIso(state.get("last_recovery_epoch")),
    lastProbeAt: stateFile.modifiedAt,
    probeAgeMs,
    probeFresh: probeAgeMs === null ? null : probeAgeMs <= PROBE_STALE_AFTER_MS,
    lastEventAt: parsedLog.lastEventAt,
    recentFailure: parsedLog.recentFailure,
    probeWindow: recentProbeWindow,
    observationScope: "external-tunnel-probe",
    hostExceptionBodyObservable: false,
  };
}

export async function readExternalWatchdogProbeWindow(
  options: { since?: string; until?: string; maxSamples?: number } = {},
  homeDir = os.homedir(),
): Promise<ExternalWatchdogProbeWindow> {
  if (process.platform !== "darwin") {
    return emptyProbeWindow(options.since ?? null, options.until ?? null);
  }
  const file = await readPrivateTail(
    path.join(rootDirectory(homeDir), "probe-history.log"),
    MAX_PROBE_LOG_BYTES,
  );
  return probeWindow(
    parseProbeSamples(file.raw),
    options.since ?? null,
    options.until ?? null,
    options.maxSamples ?? 20,
  );
}

export async function readExternalWatchdogStatus(
  homeDir = os.homedir(),
): Promise<ExternalWatchdogStatus> {
  const now = Date.now();
  if (statusCache?.homeDir === homeDir && statusCache.expiresAt > now) {
    return statusCache.value;
  }
  const value = loadExternalWatchdogStatus(homeDir);
  statusCache = { homeDir, expiresAt: now + STATUS_CACHE_TTL_MS, value };
  try {
    return await value;
  } catch (error) {
    if (statusCache?.value === value) statusCache = null;
    throw error;
  }
}
