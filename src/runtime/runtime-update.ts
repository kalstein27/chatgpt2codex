import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRuntimeManifestForRoot, type RuntimeManifest } from "./runtime-manifest.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const PREPARE_SCHEMA_VERSION = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export type RuntimeUpdatePrepareState =
  | "PREPARED"
  | "ALREADY_PREPARED"
  | "PRECONDITION_FAILED"
  | "CANDIDATE_INVALID"
  | "REQUEST_CONFLICT";

export interface RuntimeUpdateCheckResult {
  currentManifest: RuntimeManifest;
  candidateManifest: RuntimeManifest;
  currentFingerprint: string | null;
  candidateFingerprint: string | null;
  updateAvailable: boolean;
  candidateReady: boolean;
  candidateWarnings: string[];
  recommendedAction: "none" | "build-candidate" | "runtime_update_prepare";
}

export interface RuntimeUpdatePrepareReceipt {
  schemaVersion: typeof PREPARE_SCHEMA_VERSION;
  requestId: string;
  operationId: string;
  projectId: string;
  state: RuntimeUpdatePrepareState;
  createdAt: string;
  updatedAt: string;
  expectedCurrentFingerprint: string;
  expectedCandidateFingerprint: string;
  runtimeSnapshotId: string | null;
  snapshotRuntimeRoot: string | null;
  currentManifest: RuntimeManifest;
  candidateManifest: RuntimeManifest;
  reusedSnapshot: boolean;
  recommendedAction: string;
}

export function runtimeIdentityWarnings(manifest: RuntimeManifest): string[] {
  return [
    ...(manifest.sourceRevision ? [] : ["sourceRevision-unavailable"]),
    ...(manifest.sourceFingerprint ? [] : ["sourceFingerprint-unavailable"]),
    ...(manifest.buildFingerprint ? [] : ["buildFingerprint-unavailable"]),
    ...(manifest.runtimeFingerprint ? [] : ["runtimeFingerprint-unavailable"]),
    ...(manifest.buildTimestamp ? [] : ["buildTimestamp-unavailable"]),
    ...(manifest.cliSha256 ? [] : ["cliSha256-unavailable"]),
    ...(manifest.toolSchemaRevision ? [] : ["toolSchemaRevision-unavailable"]),
    ...(manifest.runtimeSnapshotId ? [] : ["runtimeSnapshotId-unavailable"]),
  ];
}

export function checkRuntimeUpdate(input: {
  currentRuntimeRoot: string;
  candidateRuntimeRoot: string;
}): RuntimeUpdateCheckResult {
  const currentManifest = getRuntimeManifestForRoot(input.currentRuntimeRoot);
  const candidateManifest = getRuntimeManifestForRoot(input.candidateRuntimeRoot);
  const candidateWarnings = runtimeIdentityWarnings(candidateManifest);
  const currentFingerprint = currentManifest.runtimeFingerprint;
  const candidateFingerprint = candidateManifest.runtimeFingerprint;
  const candidateReady = candidateWarnings.length === 0;
  const updateAvailable = Boolean(currentFingerprint && candidateFingerprint && currentFingerprint !== candidateFingerprint);
  return {
    currentManifest,
    candidateManifest,
    currentFingerprint,
    candidateFingerprint,
    updateAvailable,
    candidateReady,
    candidateWarnings,
    recommendedAction: !candidateReady ? "build-candidate" : updateAvailable ? "runtime_update_prepare" : "none",
  };
}

function prepareRoot(stateDir: string): string {
  return path.join(stateDir, "runtime-updates", "prepares");
}

function snapshotRoot(stateDir: string): string {
  return path.join(stateDir, "local-runtime-releases");
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: DIR_MODE });
  await fs.chmod(directory, DIR_MODE).catch(() => undefined);
}

async function atomicWriteJson(destination: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(destination));
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
  await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
  try {
    await fs.rename(temporary, destination);
    await fs.chmod(destination, FILE_MODE).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function isPrepareReceipt(value: unknown): value is RuntimeUpdatePrepareReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<RuntimeUpdatePrepareReceipt>;
  return receipt.schemaVersion === PREPARE_SCHEMA_VERSION &&
    typeof receipt.requestId === "string" &&
    typeof receipt.operationId === "string" &&
    typeof receipt.projectId === "string" &&
    typeof receipt.state === "string" &&
    typeof receipt.expectedCurrentFingerprint === "string" &&
    typeof receipt.expectedCandidateFingerprint === "string" &&
    Boolean(receipt.currentManifest) &&
    Boolean(receipt.candidateManifest);
}

async function readPrepareReceipts(stateDir: string): Promise<RuntimeUpdatePrepareReceipt[]> {
  const root = prepareRoot(stateDir);
  const names = await fs.readdir(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const receipts: RuntimeUpdatePrepareReceipt[] = [];
  for (const name of names.filter((entry) => /^prep_[0-9a-f-]{36}\.json$/u.test(entry)).slice(-200)) {
    const parsed = JSON.parse(await fs.readFile(path.join(root, name), "utf8")) as unknown;
    if (isPrepareReceipt(parsed)) receipts.push(parsed);
  }
  return receipts;
}

export async function getRuntimeUpdatePrepareReceipt(
  stateDir: string,
  lookup: { operationId?: string; requestId?: string },
): Promise<RuntimeUpdatePrepareReceipt | null> {
  if ((lookup.operationId ? 1 : 0) + (lookup.requestId ? 1 : 0) !== 1) {
    throw new Error("Exactly one of operationId or requestId is required");
  }
  if (lookup.operationId) {
    if (!/^prep_[0-9a-f-]{36}$/u.test(lookup.operationId)) return null;
    const parsed = await fs.readFile(path.join(prepareRoot(stateDir), `${lookup.operationId}.json`), "utf8")
      .then((raw) => JSON.parse(raw) as unknown)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    return parsed !== null && isPrepareReceipt(parsed) ? parsed : null;
  }
  if (!lookup.requestId || !REQUEST_ID_PATTERN.test(lookup.requestId)) return null;
  return (await readPrepareReceipts(stateDir)).find((entry) => entry.requestId === lookup.requestId) ?? null;
}

async function writePrepareReceipt(stateDir: string, receipt: RuntimeUpdatePrepareReceipt): Promise<void> {
  await atomicWriteJson(path.join(prepareRoot(stateDir), `${receipt.operationId}.json`), receipt);
}

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await fs.access(source);
  } catch {
    return false;
  }
  await fs.cp(source, destination, { recursive: true, preserveTimestamps: true });
  return true;
}

async function prepareSnapshot(input: {
  stateDir: string;
  currentRuntimeRoot: string;
  candidateRuntimeRoot: string;
  candidateManifest: RuntimeManifest;
}): Promise<{ snapshotRuntimeRoot: string; reusedSnapshot: boolean }> {
  const snapshotId = input.candidateManifest.runtimeSnapshotId;
  if (!snapshotId) throw new Error("Candidate runtime snapshot identity is incomplete");
  const digest = snapshotId.slice("sha256:".length);
  const root = snapshotRoot(input.stateDir);
  await ensurePrivateDirectory(root);
  const finalRoot = path.join(root, `runtime-${digest}`);
  const existing = await fs.realpath(finalRoot).catch(() => null);
  if (existing) {
    const manifest = getRuntimeManifestForRoot(existing);
    if (manifest.runtimeSnapshotId !== snapshotId || manifest.runtimeFingerprint !== input.candidateManifest.runtimeFingerprint) {
      throw new Error("Existing runtime snapshot path contains a different artifact");
    }
    return { snapshotRuntimeRoot: existing, reusedSnapshot: true };
  }

  const temporary = `${finalRoot}.tmp-${process.pid}-${randomUUID()}`;
  await fs.mkdir(temporary, { mode: DIR_MODE });
  try {
    for (const support of ["bin", "node", "npm"]) {
      await copyIfPresent(path.join(input.currentRuntimeRoot, support), path.join(temporary, support));
    }
    for (const required of ["package.json", "dist", "node_modules"]) {
      const copied = await copyIfPresent(path.join(input.candidateRuntimeRoot, required), path.join(temporary, required));
      if (!copied) throw new Error(`Candidate runtime is missing required snapshot input: ${required}`);
    }
    await copyIfPresent(path.join(input.candidateRuntimeRoot, "package-lock.json"), path.join(temporary, "package-lock.json"));
    const preparedManifest = getRuntimeManifestForRoot(temporary);
    if (preparedManifest.runtimeSnapshotId !== snapshotId ||
        preparedManifest.runtimeFingerprint !== input.candidateManifest.runtimeFingerprint) {
      throw new Error("Prepared runtime snapshot identity does not match candidate");
    }
    try {
      await fs.rename(temporary, finalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const racedManifest = getRuntimeManifestForRoot(finalRoot);
      if (racedManifest.runtimeSnapshotId !== snapshotId) throw error;
      await fs.rm(temporary, { recursive: true, force: true });
      return { snapshotRuntimeRoot: finalRoot, reusedSnapshot: true };
    }
    await fs.chmod(finalRoot, DIR_MODE).catch(() => undefined);
    return { snapshotRuntimeRoot: await fs.realpath(finalRoot), reusedSnapshot: false };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function receipt(input: {
  requestId: string;
  projectId: string;
  state: RuntimeUpdatePrepareState;
  expectedCurrentFingerprint: string;
  expectedCandidateFingerprint: string;
  currentManifest: RuntimeManifest;
  candidateManifest: RuntimeManifest;
  runtimeSnapshotId?: string | null;
  snapshotRuntimeRoot?: string | null;
  reusedSnapshot?: boolean;
  recommendedAction: string;
}): RuntimeUpdatePrepareReceipt {
  const now = new Date().toISOString();
  return {
    schemaVersion: PREPARE_SCHEMA_VERSION,
    requestId: input.requestId,
    operationId: `prep_${randomUUID()}`,
    projectId: input.projectId,
    state: input.state,
    createdAt: now,
    updatedAt: now,
    expectedCurrentFingerprint: input.expectedCurrentFingerprint,
    expectedCandidateFingerprint: input.expectedCandidateFingerprint,
    runtimeSnapshotId: input.runtimeSnapshotId ?? input.candidateManifest.runtimeSnapshotId,
    snapshotRuntimeRoot: input.snapshotRuntimeRoot ?? null,
    currentManifest: input.currentManifest,
    candidateManifest: input.candidateManifest,
    reusedSnapshot: input.reusedSnapshot ?? false,
    recommendedAction: input.recommendedAction,
  };
}

export async function prepareRuntimeUpdateSnapshot(input: {
  stateDir: string;
  projectId: string;
  currentRuntimeRoot: string;
  candidateRuntimeRoot: string;
  expectedCurrentFingerprint: string;
  expectedCandidateFingerprint: string;
  requestId: string;
}): Promise<RuntimeUpdatePrepareReceipt> {
  if (!REQUEST_ID_PATTERN.test(input.requestId)) throw new Error("Invalid runtime prepare requestId");
  if (!SHA256_PATTERN.test(input.expectedCurrentFingerprint) || !SHA256_PATTERN.test(input.expectedCandidateFingerprint)) {
    throw new Error("Invalid runtime prepare fingerprint");
  }
  const existing = (await readPrepareReceipts(input.stateDir)).find((entry) => entry.requestId === input.requestId);
  if (existing) {
    if (existing.expectedCurrentFingerprint !== input.expectedCurrentFingerprint ||
        existing.expectedCandidateFingerprint !== input.expectedCandidateFingerprint ||
        existing.projectId !== input.projectId) {
      return { ...existing, state: "REQUEST_CONFLICT", recommendedAction: "use-a-new-requestId" };
    }
    return existing;
  }

  const currentRuntimeRoot = await fs.realpath(input.currentRuntimeRoot);
  const candidateRuntimeRoot = await fs.realpath(input.candidateRuntimeRoot);
  const currentManifest = getRuntimeManifestForRoot(currentRuntimeRoot);
  const candidateManifest = getRuntimeManifestForRoot(candidateRuntimeRoot);

  if (currentManifest.runtimeFingerprint !== input.expectedCurrentFingerprint.toLowerCase()) {
    const result = receipt({
      requestId: input.requestId,
      projectId: input.projectId,
      state: "PRECONDITION_FAILED",
      expectedCurrentFingerprint: input.expectedCurrentFingerprint.toLowerCase(),
      expectedCandidateFingerprint: input.expectedCandidateFingerprint.toLowerCase(),
      currentManifest,
      candidateManifest,
      recommendedAction: "refresh-runtime-update-check",
    });
    await writePrepareReceipt(input.stateDir, result);
    return result;
  }

  if (candidateManifest.runtimeFingerprint !== input.expectedCandidateFingerprint.toLowerCase() ||
      runtimeIdentityWarnings(candidateManifest).length > 0) {
    const result = receipt({
      requestId: input.requestId,
      projectId: input.projectId,
      state: "CANDIDATE_INVALID",
      expectedCurrentFingerprint: input.expectedCurrentFingerprint.toLowerCase(),
      expectedCandidateFingerprint: input.expectedCandidateFingerprint.toLowerCase(),
      currentManifest,
      candidateManifest,
      recommendedAction: "rebuild-canonical-runtime-candidate",
    });
    await writePrepareReceipt(input.stateDir, result);
    return result;
  }

  const snapshot = await prepareSnapshot({ stateDir: input.stateDir, currentRuntimeRoot, candidateRuntimeRoot, candidateManifest });
  const result = receipt({
    requestId: input.requestId,
    projectId: input.projectId,
    state: snapshot.reusedSnapshot ? "ALREADY_PREPARED" : "PREPARED",
    expectedCurrentFingerprint: input.expectedCurrentFingerprint.toLowerCase(),
    expectedCandidateFingerprint: input.expectedCandidateFingerprint.toLowerCase(),
    currentManifest,
    candidateManifest,
    runtimeSnapshotId: candidateManifest.runtimeSnapshotId,
    snapshotRuntimeRoot: snapshot.snapshotRuntimeRoot,
    reusedSnapshot: snapshot.reusedSnapshot,
    recommendedAction: "runtime_apply_local",
  });
  await writePrepareReceipt(input.stateDir, result);
  return result;
}
