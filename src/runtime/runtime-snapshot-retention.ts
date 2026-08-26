import { promises as fs } from "node:fs";
import path from "node:path";
import { readActiveRuntimePointer } from "./runtime-apply.js";
import { getRuntimeManifest } from "./runtime-manifest.js";

const SNAPSHOT_NAME = /^runtime-([a-f0-9]{64})$/u;
const APPLY_RECEIPT_NAME = /^rt_[0-9a-f-]{36}\.json$/u;
const ACTIVE_APPLY_STATES = new Set(["APPROVAL_REQUIRED", "ACTIVATION_REQUESTED", "HEALTH_CHECK_FAILED"]);

export interface RuntimeSnapshotRetentionPolicy {
  keepNewest: number;
  minAgeDays: number;
  keepRecentApplyReceipts: number;
}

export interface RuntimeSnapshotInventoryEntry {
  snapshotName: string;
  snapshotId: string;
  modifiedAt: string;
  ageDays: number;
  protected: boolean;
  protectedReasons: string[];
  eligibleForPrune: boolean;
}

export interface RuntimeSnapshotInventory {
  policy: RuntimeSnapshotRetentionPolicy;
  snapshotCount: number;
  protectedCount: number;
  eligibleCount: number;
  snapshots: RuntimeSnapshotInventoryEntry[];
}

function releaseRoot(stateDir: string): string {
  return path.join(stateDir, "local-runtime-releases");
}

async function canonicalPrivateReleaseRoot(stateDir: string): Promise<string | null> {
  const root = releaseRoot(stateDir);
  const info = await fs.lstat(root).catch(() => null);
  if (!info) return null;
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (uid !== undefined && info.uid !== uid) ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Invalid private runtime snapshot release root");
  }
  return fs.realpath(root);
}

function normalizedPolicy(policy: Partial<RuntimeSnapshotRetentionPolicy> = {}): RuntimeSnapshotRetentionPolicy {
  return {
    keepNewest: Math.min(20, Math.max(2, Math.floor(policy.keepNewest ?? 3))),
    minAgeDays: Math.min(365, Math.max(1, Math.floor(policy.minAgeDays ?? 7))),
    keepRecentApplyReceipts: Math.min(20, Math.max(1, Math.floor(policy.keepRecentApplyReceipts ?? 2))),
  };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function protect(roots: Map<string, string[]>, root: string, reason: string): void {
  roots.set(root, [...new Set([...(roots.get(root) ?? []), reason])]);
}

async function receiptProtectedRoots(stateDir: string, keepRecent: number): Promise<Map<string, string[]>> {
  const directory = path.join(stateDir, "runtime-updates", "receipts");
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const receipts: Array<Record<string, unknown>> = [];
  for (const name of names.filter((entry) => APPLY_RECEIPT_NAME.test(entry)).slice(-200)) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as Record<string, unknown>;
      if (typeof parsed.updatedAt === "string" && typeof parsed.state === "string") receipts.push(parsed);
    } catch {
      // Ignore malformed historical receipts for inventory; active/current
      // pointers remain independently protected and prune validates again.
    }
  }
  receipts.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const selected = receipts.filter((receipt, index) =>
    index < keepRecent || ACTIVE_APPLY_STATES.has(String(receipt.state)),
  );
  const protectedRoots = new Map<string, string[]>();
  for (const receipt of selected) {
    const target = receipt.targetManifest && typeof receipt.targetManifest === "object"
      ? (receipt.targetManifest as Record<string, unknown>).runtimeRoot
      : null;
    for (const [reason, value] of [
      ["recent-apply-previous", receipt.previousRuntimeRoot],
      ["recent-apply-target", target],
      ["recent-apply-pointer", receipt.previousPointerValue],
    ] as const) {
      if (typeof value !== "string" || !path.isAbsolute(value)) continue;
      const resolved = await fs.realpath(value).catch(() => path.resolve(value));
      protect(protectedRoots, resolved, reason);
    }
  }
  return protectedRoots;
}

export async function runtimeSnapshotInventory(
  stateDir: string,
  policyInput: Partial<RuntimeSnapshotRetentionPolicy> = {},
  now = Date.now(),
): Promise<RuntimeSnapshotInventory> {
  const policy = normalizedPolicy(policyInput);
  const root = releaseRoot(stateDir);
  const canonicalRoot = await canonicalPrivateReleaseRoot(stateDir);
  if (!canonicalRoot) {
    return { policy, snapshotCount: 0, protectedCount: 0, eligibleCount: 0, snapshots: [] };
  }
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const protectedRoots = await receiptProtectedRoots(stateDir, policy.keepRecentApplyReceipts);
  const activePointer = await readActiveRuntimePointer(stateDir).catch(() => null);
  if (activePointer) {
    const canonicalActive = await fs.realpath(activePointer).catch(() => path.resolve(activePointer));
    protect(protectedRoots, canonicalActive, "active-runtime-pointer");
  }
  const currentRoot = getRuntimeManifest().runtimeRoot;
  if (currentRoot) {
    const canonicalCurrent = await fs.realpath(currentRoot).catch(() => path.resolve(currentRoot));
    protect(protectedRoots, canonicalCurrent, "current-runtime-process");
  }

  const candidates: Array<{ name: string; root: string; mtimeMs: number }> = [];
  for (const name of names.filter((entry) => SNAPSHOT_NAME.test(entry))) {
    const candidate = path.join(root, name);
    const info = await fs.lstat(candidate).catch(() => null);
    const uid = process.getuid?.();
    if (!info?.isDirectory() || info.isSymbolicLink() ||
        (uid !== undefined && info.uid !== uid) ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)) continue;
    const canonical = await fs.realpath(candidate).catch(() => null);
    if (!canonical || !inside(canonicalRoot, canonical)) continue;
    candidates.push({ name, root: canonical, mtimeMs: info.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  const newest = new Set(candidates.slice(0, policy.keepNewest).map((entry) => entry.root));
  const minimumAgeMs = policy.minAgeDays * 24 * 60 * 60 * 1000;
  const snapshots = candidates.map((entry): RuntimeSnapshotInventoryEntry => {
    const reasons = [...(protectedRoots.get(entry.root) ?? [])];
    if (newest.has(entry.root)) reasons.push("newest-retention");
    const ageMs = Math.max(0, now - entry.mtimeMs);
    if (ageMs < minimumAgeMs) reasons.push("minimum-age");
    const protectedReasons = [...new Set(reasons)].sort();
    return {
      snapshotName: entry.name,
      snapshotId: `sha256:${SNAPSHOT_NAME.exec(entry.name)?.[1] ?? ""}`,
      modifiedAt: new Date(entry.mtimeMs).toISOString(),
      ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      protected: protectedReasons.length > 0,
      protectedReasons,
      eligibleForPrune: protectedReasons.length === 0,
    };
  });
  return {
    policy,
    snapshotCount: snapshots.length,
    protectedCount: snapshots.filter((entry) => entry.protected).length,
    eligibleCount: snapshots.filter((entry) => entry.eligibleForPrune).length,
    snapshots,
  };
}

export async function pruneRuntimeSnapshots(
  stateDir: string,
  policyInput: Partial<RuntimeSnapshotRetentionPolicy> = {},
): Promise<{ before: RuntimeSnapshotInventory; removed: string[]; after: RuntimeSnapshotInventory }> {
  const before = await runtimeSnapshotInventory(stateDir, policyInput);
  const root = releaseRoot(stateDir);
  const canonicalRoot = await canonicalPrivateReleaseRoot(stateDir);
  if (!canonicalRoot) return { before, removed: [], after: before };
  const removed: string[] = [];
  for (const entry of before.snapshots.filter((candidate) => candidate.eligibleForPrune)) {
    const fresh = await runtimeSnapshotInventory(stateDir, policyInput);
    if (!fresh.snapshots.some((candidate) =>
      candidate.snapshotName === entry.snapshotName && candidate.eligibleForPrune,
    )) continue;
    const candidate = path.join(root, entry.snapshotName);
    const info = await fs.lstat(candidate).catch(() => null);
    const canonical = info?.isDirectory() && !info.isSymbolicLink()
      ? await fs.realpath(candidate).catch(() => null)
      : null;
    if (!canonical || !inside(canonicalRoot, canonical) || path.basename(canonical) !== entry.snapshotName) continue;
    await fs.rm(canonical, { recursive: true, force: false });
    removed.push(entry.snapshotName);
  }
  return { before, removed, after: await runtimeSnapshotInventory(stateDir, policyInput) };
}
