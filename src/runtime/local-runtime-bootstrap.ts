import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRuntimeManifestForRoot } from "./runtime-manifest.js";
import { getRuntimeUpdatePrepareReceipt } from "./runtime-update.js";

const PREPARE_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const PREPARE_OPERATION_ID_PATTERN = /^prep_[0-9a-f-]{36}$/u;

export interface LocalRuntimeBootstrapPlan {
  prepareRequestId: string;
  applyRequestId: string;
  projectId: string;
  projectRoot: string;
  currentRuntimeRoot: string;
  expectedCurrentFingerprint: string;
  targetFingerprint: string;
  targetRuntimeRoot: string;
  runtimeSnapshotId: string;
}

export function deriveLocalRuntimeBootstrapApplyRequestId(prepareRequestId: string): string {
  if (!PREPARE_REQUEST_ID_PATTERN.test(prepareRequestId)) {
    throw new Error("runtime-bootstrap-local requires a valid prepare request id");
  }
  const digest = createHash("sha256").update(prepareRequestId).digest("hex").slice(0, 24);
  return `local-bootstrap-${digest}`;
}

export async function loadLocalRuntimeBootstrapPlan(input: {
  stateDir: string;
  prepareRequestId?: string;
  prepareOperationId?: string;
}): Promise<LocalRuntimeBootstrapPlan> {
  const requestId = input.prepareRequestId?.trim() ?? "";
  const operationId = input.prepareOperationId?.trim() ?? "";
  if ((requestId ? 1 : 0) + (operationId ? 1 : 0) !== 1) {
    throw new Error("runtime-bootstrap-local requires exactly one prepared receipt identifier");
  }
  if (requestId && !PREPARE_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("runtime-bootstrap-local requires a valid --prepare-request id");
  }
  if (operationId && !PREPARE_OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("runtime-bootstrap-local requires a valid --prepare-operation id");
  }
  const receipt = await getRuntimeUpdatePrepareReceipt(
    input.stateDir,
    operationId ? { operationId } : { requestId },
  );
  if (!receipt) throw new Error(`Prepared runtime receipt not found: ${operationId || requestId}`);
  if (receipt.state !== "PREPARED" && receipt.state !== "ALREADY_PREPARED") {
    throw new Error(`Prepared runtime receipt is not usable: ${receipt.state}`);
  }
  if (!receipt.runtimeSnapshotId?.startsWith("sha256:") || !receipt.snapshotRuntimeRoot) {
    throw new Error("Prepared runtime receipt does not contain an immutable snapshot");
  }
  const snapshotDigest = receipt.runtimeSnapshotId.slice("sha256:".length);
  if (!/^[a-f0-9]{64}$/u.test(snapshotDigest)) {
    throw new Error("Prepared runtime receipt has an invalid snapshot identity");
  }

  const expectedSnapshotRoot = path.join(input.stateDir, "local-runtime-releases", `runtime-${snapshotDigest}`);
  const [snapshotRoot, expectedRoot, currentRuntimeRoot, projectRoot] = await Promise.all([
    fs.realpath(receipt.snapshotRuntimeRoot),
    fs.realpath(expectedSnapshotRoot),
    fs.realpath(receipt.currentManifest.runtimeRoot),
    fs.realpath(receipt.candidateManifest.runtimeRoot),
  ]);
  if (snapshotRoot !== expectedRoot) {
    throw new Error("Prepared runtime receipt snapshot path is outside the managed immutable release root");
  }
  const snapshotManifest = getRuntimeManifestForRoot(snapshotRoot);
  if (snapshotManifest.runtimeSnapshotId !== receipt.runtimeSnapshotId ||
      snapshotManifest.runtimeFingerprint !== receipt.expectedCandidateFingerprint) {
    throw new Error("Prepared runtime snapshot identity no longer matches its receipt");
  }
  const currentManifest = getRuntimeManifestForRoot(currentRuntimeRoot);
  if (receipt.currentManifest.runtimeFingerprint !== receipt.expectedCurrentFingerprint ||
      currentManifest.runtimeFingerprint !== receipt.expectedCurrentFingerprint) {
    throw new Error("Prepared runtime receipt current-runtime identity is inconsistent");
  }
  if (receipt.candidateManifest.runtimeFingerprint !== receipt.expectedCandidateFingerprint) {
    throw new Error("Prepared runtime receipt candidate identity is inconsistent");
  }

  return {
    prepareRequestId: receipt.requestId,
    applyRequestId: deriveLocalRuntimeBootstrapApplyRequestId(receipt.requestId),
    projectId: receipt.projectId,
    projectRoot,
    currentRuntimeRoot,
    expectedCurrentFingerprint: receipt.expectedCurrentFingerprint,
    targetFingerprint: receipt.expectedCandidateFingerprint,
    targetRuntimeRoot: snapshotRoot,
    runtimeSnapshotId: receipt.runtimeSnapshotId,
  };
}
