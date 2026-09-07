import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntimeManifest } from "./runtime-manifest.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const RECEIPT_FILE = "host-catalog-rebind.json";
const REVISION_PATTERN = /^sha256:[a-f0-9]{24}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export interface HostCatalogRebindReceipt {
  schemaVersion: 1;
  observedAt: string;
  runtimeHostCatalogRevision: string;
  runtimeFingerprint: string;
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
  return {
    schemaVersion: 1,
    observedAt: record.observedAt,
    runtimeHostCatalogRevision: record.runtimeHostCatalogRevision,
    runtimeFingerprint: record.runtimeFingerprint,
  };
}

export async function recordHostCatalogRebind(
  stateDir: string,
  expectedHostCatalogRevision: string,
  now: Date = new Date(),
): Promise<HostCatalogRebindReceipt | null> {
  const manifest = getRuntimeManifest();
  if (!REVISION_PATTERN.test(expectedHostCatalogRevision)) return null;
  if (manifest.hostCatalogRevision !== expectedHostCatalogRevision) return null;
  if (typeof manifest.runtimeFingerprint !== "string" || !FINGERPRINT_PATTERN.test(manifest.runtimeFingerprint)) return null;
  const receipt: HostCatalogRebindReceipt = {
    schemaVersion: 1,
    observedAt: now.toISOString(),
    runtimeHostCatalogRevision: expectedHostCatalogRevision,
    runtimeFingerprint: manifest.runtimeFingerprint,
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
