import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntimeManifest } from "./runtime-manifest.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const RECEIPT_FILE = "host-catalog-rebind.json";
const REVISION_PATTERN = /^sha256:[a-f0-9]{24}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const MARKER_TOOL_PATTERN = /^chatgpt_catalog_refresh_marker_[a-f0-9]{12}$/u;

export function hostCatalogRebindMarkerToolName(hostCatalogRevision: string | null | undefined): string | null {
  if (typeof hostCatalogRevision !== "string" || !REVISION_PATTERN.test(hostCatalogRevision)) return null;
  return `chatgpt_catalog_refresh_marker_${hostCatalogRevision.slice("sha256:".length, "sha256:".length + 12)}`;
}

export interface HostCatalogRebindReceipt {
  schemaVersion: 1;
  observedAt: string;
  runtimeHostCatalogRevision: string;
  runtimeFingerprint: string;
  markerToolName: string;
}

export function matchesHostCatalogRebindReceipt(
  receipt: HostCatalogRebindReceipt | null | undefined,
  input: {
    hostCatalogRevision: string | null | undefined;
    runtimeFingerprint: string | null | undefined;
    markerToolName?: string | null;
    observedAtOrAfter?: number;
  },
): boolean {
  if (!receipt) return false;
  const markerToolName = input.markerToolName ?? hostCatalogRebindMarkerToolName(input.hostCatalogRevision);
  if (!markerToolName || typeof input.hostCatalogRevision !== "string" || typeof input.runtimeFingerprint !== "string") return false;
  const observedAt = Date.parse(receipt.observedAt);
  if (!Number.isFinite(observedAt)) return false;
  if (input.observedAtOrAfter !== undefined) {
    if (!Number.isFinite(input.observedAtOrAfter) || observedAt < input.observedAtOrAfter) return false;
  }
  return receipt.runtimeHostCatalogRevision === input.hostCatalogRevision
    && receipt.runtimeFingerprint === input.runtimeFingerprint
    && receipt.markerToolName === markerToolName;
}

function receiptPath(stateDir: string): string {
  return path.join(stateDir, "runtime-schema", RECEIPT_FILE);
}

function normalize(value: unknown): HostCatalogRebindReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  if (typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt))) return null;
  if (typeof record.runtimeHostCatalogRevision !== "string" || !REVISION_PATTERN.test(record.runtimeHostCatalogRevision)) return null;
  if (typeof record.runtimeFingerprint !== "string" || !FINGERPRINT_PATTERN.test(record.runtimeFingerprint)) return null;
  if (typeof record.markerToolName !== "string" || !MARKER_TOOL_PATTERN.test(record.markerToolName)) return null;
  if (hostCatalogRebindMarkerToolName(record.runtimeHostCatalogRevision) !== record.markerToolName) return null;
  return {
    schemaVersion: 1,
    observedAt: record.observedAt,
    runtimeHostCatalogRevision: record.runtimeHostCatalogRevision,
    runtimeFingerprint: record.runtimeFingerprint,
    markerToolName: record.markerToolName,
  };
}

export async function recordHostCatalogRebind(
  stateDir: string,
  expectedHostCatalogRevision: string,
  markerToolName: string,
  now: Date = new Date(),
): Promise<HostCatalogRebindReceipt | null> {
  const manifest = getRuntimeManifest();
  if (!REVISION_PATTERN.test(expectedHostCatalogRevision)) return null;
  if (manifest.hostCatalogRevision !== expectedHostCatalogRevision) return null;
  if (hostCatalogRebindMarkerToolName(expectedHostCatalogRevision) !== markerToolName) return null;
  if (typeof manifest.runtimeFingerprint !== "string" || !FINGERPRINT_PATTERN.test(manifest.runtimeFingerprint)) return null;
  const receipt: HostCatalogRebindReceipt = {
    schemaVersion: 1,
    observedAt: now.toISOString(),
    runtimeHostCatalogRevision: expectedHostCatalogRevision,
    runtimeFingerprint: manifest.runtimeFingerprint,
    markerToolName,
  };
  const target = receiptPath(stateDir);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: DIR_MODE });
  await chmod(directory, DIR_MODE).catch(() => undefined);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    await chmod(temporary, FILE_MODE).catch(() => undefined);
    await rename(temporary, target);
    await chmod(target, FILE_MODE).catch(() => undefined);
    return receipt;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readHostCatalogRebind(stateDir: string): Promise<HostCatalogRebindReceipt | null> {
  try {
    return normalize(JSON.parse(await readFile(receiptPath(stateDir), "utf8")) as unknown);
  } catch {
    return null;
  }
}
