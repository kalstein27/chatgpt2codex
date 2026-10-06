import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRuntimeManifestForRoot } from "./runtime-manifest.js";
import {
  prepareRuntimeApply,
  probeRuntimeHealth,
  startLocallyConfirmedRuntimeApply,
} from "./runtime-apply.js";

const APPLY_RECEIPT_NAME = /^rt_[0-9a-f-]{36}\.json$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface StoredRuntimeApplyReceipt {
  state?: string;
  updatedAt?: string;
  targetFingerprint?: string;
  previousRuntimeRoot?: string;
  projectId?: string;
  operationId?: string;
  previousManifest?: { buildFingerprint?: string | null };
}

export interface PreviousRuntimeRollbackCandidate {
  available: boolean;
  reason:
    | "ready"
    | "current-runtime-unhealthy"
    | "current-runtime-identity-missing"
    | "no-matching-successful-apply"
    | "previous-runtime-outside-private-snapshots"
    | "previous-runtime-missing"
    | "previous-runtime-invalid"
    | "already-on-previous-runtime";
  projectId: string | null;
  sourceOperationId: string | null;
  currentRuntimeRoot: string | null;
  currentFingerprint: string | null;
  previousRuntimeRoot: string | null;
  previousFingerprint: string | null;
  previousUpdatedAt: string | null;
}

function unavailable(
  reason: PreviousRuntimeRollbackCandidate["reason"],
  partial: Partial<PreviousRuntimeRollbackCandidate> = {},
): PreviousRuntimeRollbackCandidate {
  return {
    available: false,
    reason,
    projectId: null,
    sourceOperationId: null,
    currentRuntimeRoot: null,
    currentFingerprint: null,
    previousRuntimeRoot: null,
    previousFingerprint: null,
    previousUpdatedAt: null,
    ...partial,
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readRuntimeApplyReceipts(stateDir: string): Promise<StoredRuntimeApplyReceipt[]> {
  const directory = path.join(stateDir, "runtime-updates", "receipts");
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const receipts: StoredRuntimeApplyReceipt[] = [];
  for (const name of names.filter((entry) => APPLY_RECEIPT_NAME.test(entry)).slice(-300)) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as StoredRuntimeApplyReceipt;
      if (typeof parsed.updatedAt === "string") receipts.push(parsed);
    } catch {
      // Historical/malformed receipts are ignored. A candidate is only exposed
      // when a complete successful receipt also matches the currently live
      // runtime fingerprint.
    }
  }
  return receipts.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export function selectPreviousAppliedReceipt(
  receipts: readonly StoredRuntimeApplyReceipt[],
  currentFingerprint: string,
): StoredRuntimeApplyReceipt | null {
  return receipts.find((receipt) =>
    receipt.state === "APPLIED"
    && receipt.targetFingerprint === currentFingerprint
    && typeof receipt.previousRuntimeRoot === "string"
    && typeof receipt.projectId === "string"
    && typeof receipt.operationId === "string"
  ) ?? null;
}

export async function inspectPreviousRuntimeRollback(
  stateDir: string,
  port = Number.parseInt(process.env.PORT ?? "7979", 10),
): Promise<PreviousRuntimeRollbackCandidate> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid runtime rollback health port");
  const health = await probeRuntimeHealth(port);
  if (!health.healthy) return unavailable("current-runtime-unhealthy");
  const currentFingerprint = health.manifest?.buildFingerprint ?? null;
  const currentRuntimeRoot = health.manifest?.runtimeRoot ?? null;
  if (!currentFingerprint || !SHA256_PATTERN.test(currentFingerprint) || !currentRuntimeRoot) {
    return unavailable("current-runtime-identity-missing", { currentRuntimeRoot, currentFingerprint });
  }

  const receipt = selectPreviousAppliedReceipt(await readRuntimeApplyReceipts(stateDir), currentFingerprint);
  if (!receipt) {
    return unavailable("no-matching-successful-apply", { currentRuntimeRoot, currentFingerprint });
  }

  const releaseRoot = await fs.realpath(path.join(stateDir, "local-runtime-releases")).catch(() => null);
  const previousRoot = await fs.realpath(String(receipt.previousRuntimeRoot)).catch(() => null);
  if (!releaseRoot || !previousRoot) {
    return unavailable("previous-runtime-missing", {
      projectId: String(receipt.projectId),
      sourceOperationId: String(receipt.operationId),
      currentRuntimeRoot,
      currentFingerprint,
    });
  }
  if (!isInside(releaseRoot, previousRoot)) {
    return unavailable("previous-runtime-outside-private-snapshots", {
      projectId: String(receipt.projectId),
      sourceOperationId: String(receipt.operationId),
      currentRuntimeRoot,
      currentFingerprint,
    });
  }
  if (path.resolve(previousRoot) === path.resolve(currentRuntimeRoot)) {
    return unavailable("already-on-previous-runtime", {
      projectId: String(receipt.projectId),
      sourceOperationId: String(receipt.operationId),
      currentRuntimeRoot,
      currentFingerprint,
      previousRuntimeRoot: previousRoot,
    });
  }

  const previousManifest = getRuntimeManifestForRoot(previousRoot);
  const previousFingerprint = previousManifest.buildFingerprint;
  if (!previousFingerprint || !SHA256_PATTERN.test(previousFingerprint) || previousFingerprint === currentFingerprint) {
    return unavailable("previous-runtime-invalid", {
      projectId: String(receipt.projectId),
      sourceOperationId: String(receipt.operationId),
      currentRuntimeRoot,
      currentFingerprint,
      previousRuntimeRoot: previousRoot,
      previousFingerprint,
    });
  }
  const recordedPrevious = receipt.previousManifest?.buildFingerprint;
  if (recordedPrevious && recordedPrevious !== previousFingerprint) {
    return unavailable("previous-runtime-invalid", {
      projectId: String(receipt.projectId),
      sourceOperationId: String(receipt.operationId),
      currentRuntimeRoot,
      currentFingerprint,
      previousRuntimeRoot: previousRoot,
      previousFingerprint,
    });
  }

  return {
    available: true,
    reason: "ready",
    projectId: String(receipt.projectId),
    sourceOperationId: String(receipt.operationId),
    currentRuntimeRoot,
    currentFingerprint,
    previousRuntimeRoot: previousRoot,
    previousFingerprint,
    previousUpdatedAt: String(receipt.updatedAt),
  };
}

export async function rollbackToPreviousRuntimeLocally(input: {
  stateDir: string;
  expectedCurrentFingerprint: string;
  port?: number;
}): Promise<{
  ok: boolean;
  candidate: PreviousRuntimeRollbackCandidate;
  operationId: string | null;
  state: string;
  workerStarted: boolean;
}> {
  const expected = input.expectedCurrentFingerprint.trim().toLowerCase();
  if (!SHA256_PATTERN.test(expected)) throw new Error("Manual runtime rollback requires the exact current fingerprint");
  const candidate = await inspectPreviousRuntimeRollback(input.stateDir, input.port);
  if (!candidate.available || !candidate.projectId || !candidate.currentRuntimeRoot || !candidate.currentFingerprint
      || !candidate.previousRuntimeRoot || !candidate.previousFingerprint) {
    return { ok: false, candidate, operationId: null, state: candidate.reason, workerStarted: false };
  }
  if (candidate.currentFingerprint !== expected) {
    throw new Error("Current runtime changed after rollback confirmation; refusing stale rollback request");
  }

  const requestId = `manual-rollback:${Date.now()}:${randomUUID()}`;
  const prepared = await prepareRuntimeApply({
    stateDir: input.stateDir,
    projectId: candidate.projectId,
    projectRoot: candidate.currentRuntimeRoot,
    requestId,
    expectedCurrentFingerprint: candidate.currentFingerprint,
    targetRuntimeRoot: candidate.previousRuntimeRoot,
    targetFingerprint: candidate.previousFingerprint,
    preserveConnector: true,
  });
  if (prepared.conflict || prepared.receipt.state !== "APPROVAL_REQUIRED") {
    return {
      ok: false,
      candidate,
      operationId: prepared.receipt.operationId,
      state: prepared.receipt.state,
      workerStarted: false,
    };
  }

  const started = await startLocallyConfirmedRuntimeApply(input.stateDir, prepared.receipt.operationId);
  return {
    ok: started.workerStarted,
    candidate,
    operationId: started.receipt.operationId,
    state: started.receipt.state,
    workerStarted: started.workerStarted,
  };
}
