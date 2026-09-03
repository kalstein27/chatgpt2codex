import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getRuntimeManifest,
  getRuntimeManifestForRoot,
  type RuntimeManifest,
} from "./runtime-manifest.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const RECEIPT_SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 5_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export type RuntimeApplyState =
  | "APPROVAL_REQUIRED"
  | "APPROVAL_EXPIRED"
  | "ACTIVATION_REQUESTED"
  | "APPLIED"
  | "ALREADY_APPLIED"
  | "PRECONDITION_FAILED"
  | "TARGET_INVALID"
  | "REQUEST_CONFLICT"
  | "APPLY_START_FAILED"
  | "APPLY_FAILED_ROLLED_BACK"
  | "APPLY_FAILED_ROLLBACK_FAILED"
  | "HEALTH_CHECK_FAILED"
  | "ACTIVE_OPERATION_BLOCKED";

export type RuntimeApplyPhase =
  | "preflight"
  | "approval"
  | "activation"
  | "health"
  | "rollback"
  | "complete";

export interface RuntimeExternalIdentity {
  supervisorPid: number | null;
  cloudflaredPid: number | null;
  tunnelMode: string | null;
  connectorPublicOrigin: string | null;
}

export interface RuntimeHealthSnapshot {
  healthy: boolean;
  checkedAt: string;
  runtimePid: number | null;
  supervisorPid: number | null;
  manifest: RuntimeManifest | null;
  externalIdentity: RuntimeExternalIdentity | null;
}

export interface RuntimeApplyHistoryEntry {
  at: string;
  state: RuntimeApplyState;
  phase: RuntimeApplyPhase;
}

export interface RuntimeApplyReceipt {
  schemaVersion: 1;
  requestId: string;
  operationId: string;
  projectId: string;
  state: RuntimeApplyState;
  phase: RuntimeApplyPhase;
  createdAt: string;
  updatedAt: string;
  expectedCurrentFingerprint: string;
  targetFingerprint: string;
  preserveConnector: true;
  previousRuntimePid: number | null;
  currentRuntimePid: number | null;
  supervisorPid: number | null;
  supervisorPreserved: boolean | null;
  previousRuntimeRoot: string;
  currentRuntimeRoot: string;
  previousManifest: RuntimeManifest;
  targetManifest: RuntimeManifest;
  activeRuntimePointer: string | null;
  previousPointerValue: string | null;
  preApplyHealth: RuntimeHealthSnapshot;
  postApplyHealth: RuntimeHealthSnapshot | null;
  connectorPublicOrigin: string | null;
  connectorPreserved: boolean | null;
  tunnelProcessesPreserved: boolean | null;
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean | null;
  previousRuntimeRestored: boolean | null;
  finalHealthy: boolean | null;
  diagnosticId: string;
  failurePhase: RuntimeApplyPhase | null;
  recommendedAction: string;
  approvalRequestId?: string;
  workerPid?: number;
  externalIdentityBefore: RuntimeExternalIdentity;
  history: RuntimeApplyHistoryEntry[];
}

export interface PrepareRuntimeApplyInput {
  stateDir: string;
  projectId: string;
  projectRoot: string;
  requestId: string;
  expectedCurrentFingerprint: string;
  targetRuntimeRoot: string;
  targetFingerprint: string;
  preserveConnector: true;
  activeOperationCount?: number;
  unrelatedPendingApprovalCount?: number;
}

export interface PrepareRuntimeApplyResult {
  receipt: RuntimeApplyReceipt;
  replayed: boolean;
  conflict: boolean;
}

export interface PrepareRuntimeApplyDependencies {
  probeHealth?: (port: number) => Promise<RuntimeHealthSnapshot>;
}

export interface RuntimeApplyWorkerDependencies {
  probeHealth?: (port: number) => Promise<RuntimeHealthSnapshot>;
  probeActivationHealth?: (port: number) => Promise<RuntimeHealthSnapshot>;
  requestReload?: (stateDir: string, operationId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  pidAlive?: (pid: number) => boolean;
  now?: () => Date;
}

function runtimeSchemaRefreshRequired(previous: RuntimeManifest, target: RuntimeManifest): boolean {
  const uiResourceChanged =
    typeof previous.uiResourceRevision === "string"
    && typeof target.uiResourceRevision === "string"
    && previous.uiResourceRevision !== target.uiResourceRevision;
  return previous.toolSchemaRevision !== target.toolSchemaRevision || uiResourceChanged;
}

function receiptRoot(stateDir: string): string {
  return path.join(stateDir, "runtime-updates");
}

function receiptsDirectory(stateDir: string): string {
  return path.join(receiptRoot(stateDir), "receipts");
}

function lockDirectory(stateDir: string): string {
  return path.join(receiptRoot(stateDir), ".lock");
}

function receiptPath(stateDir: string, operationId: string): string {
  if (!/^rt_[0-9a-f-]{36}$/u.test(operationId)) throw new Error("Invalid runtime apply operationId");
  return path.join(receiptsDirectory(stateDir), `${operationId}.json`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function withRuntimeUpdateLock<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  const root = receiptRoot(stateDir);
  await ensurePrivateDirectory(root);
  const lock = lockDirectory(stateDir);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lock, { mode: DIR_MODE });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Runtime update state is busy");
      await delay(25);
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isRuntimeApplyReceipt(value: unknown): value is RuntimeApplyReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<RuntimeApplyReceipt>;
  return receipt.schemaVersion === RECEIPT_SCHEMA_VERSION &&
    typeof receipt.requestId === "string" &&
    typeof receipt.operationId === "string" &&
    typeof receipt.projectId === "string" &&
    typeof receipt.state === "string" &&
    typeof receipt.phase === "string" &&
    typeof receipt.expectedCurrentFingerprint === "string" &&
    typeof receipt.targetFingerprint === "string" &&
    typeof receipt.previousRuntimeRoot === "string" &&
    typeof receipt.currentRuntimeRoot === "string" &&
    Boolean(receipt.previousManifest) &&
    Boolean(receipt.targetManifest) &&
    Array.isArray(receipt.history);
}

async function readReceiptFile(file: string): Promise<RuntimeApplyReceipt | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!isRuntimeApplyReceipt(parsed)) throw new Error("Malformed runtime apply receipt");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listReceiptsUnlocked(stateDir: string): Promise<RuntimeApplyReceipt[]> {
  const directory = receiptsDirectory(stateDir);
  const names = await fs.readdir(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const receipts: RuntimeApplyReceipt[] = [];
  for (const name of names.filter((entry) => /^rt_[0-9a-f-]{36}\.json$/u.test(entry)).slice(-200)) {
    const receipt = await readReceiptFile(path.join(directory, name));
    if (receipt) receipts.push(receipt);
  }
  return receipts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function getRuntimeApplyReceipt(
  stateDir: string,
  lookup: { operationId?: string; requestId?: string },
): Promise<RuntimeApplyReceipt | null> {
  if (lookup.operationId) return readReceiptFile(receiptPath(stateDir, lookup.operationId));
  if (!lookup.requestId) throw new Error("operationId or requestId is required");
  const receipts = await listReceiptsUnlocked(stateDir);
  return receipts.find((entry) => entry.requestId === lookup.requestId) ?? null;
}

async function writeReceiptUnlocked(stateDir: string, receipt: RuntimeApplyReceipt): Promise<void> {
  await atomicWriteJson(receiptPath(stateDir, receipt.operationId), receipt);
}

function timestamp(now = new Date()): string {
  return now.toISOString();
}

function transition(
  receipt: RuntimeApplyReceipt,
  state: RuntimeApplyState,
  phase: RuntimeApplyPhase,
  now = new Date(),
): RuntimeApplyReceipt {
  const at = timestamp(now);
  return {
    ...receipt,
    state,
    phase,
    updatedAt: at,
    history: [...receipt.history, { at, state, phase }].slice(-32),
  };
}

export async function updateRuntimeApplyReceipt(
  stateDir: string,
  operationId: string,
  update: (receipt: RuntimeApplyReceipt) => RuntimeApplyReceipt,
): Promise<RuntimeApplyReceipt> {
  return withRuntimeUpdateLock(stateDir, async () => {
    const current = await readReceiptFile(receiptPath(stateDir, operationId));
    if (!current) throw new Error(`Runtime apply receipt not found: ${operationId}`);
    const next = update(current);
    await writeReceiptUnlocked(stateDir, next);
    return next;
  });
}

function positivePid(value: string | undefined): number | null {
  if (!value || !/^\d{1,10}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function currentRuntimeExternalIdentity(env: NodeJS.ProcessEnv = process.env): RuntimeExternalIdentity {
  return {
    supervisorPid: positivePid(env.CHATGPT2CODEX_SUPERVISOR_PID),
    cloudflaredPid: positivePid(env.CHATGPT2CODEX_CLOUDFLARED_PID),
    tunnelMode: env.CHATGPT2CODEX_TUNNEL_MODE?.trim().slice(0, 40) || null,
    connectorPublicOrigin: safeOrigin(env.CHATGPT2CODEX_PUBLIC_ORIGIN ?? env.CHATGPT2CODEX_PUBLIC_URL),
  };
}

function runtimePort(): number {
  const configured = process.env.CHATGPT2CODEX_PORT?.trim();
  if (configured && /^\d{1,5}$/u.test(configured)) {
    const parsed = Number(configured);
    if (parsed > 0 && parsed <= 65_535) return parsed;
  }
  const index = process.argv.lastIndexOf("--port");
  const argument = index >= 0 ? process.argv[index + 1] : undefined;
  if (argument && /^\d{1,5}$/u.test(argument)) {
    const parsed = Number(argument);
    if (parsed > 0 && parsed <= 65_535) return parsed;
  }
  return 7979;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalIfPresent(candidate: string): Promise<string> {
  return fs.realpath(candidate).catch(() => path.resolve(candidate));
}

async function allowedRuntimeRoots(stateDir: string, projectRoot: string): Promise<string[]> {
  const candidates = [
    projectRoot,
    path.join(stateDir, "local-runtime-releases"),
    path.join(os.homedir(), "Library", "Application Support", "ChatGPT To Codex", "Runtime"),
  ];
  const configured = process.env.CHATGPT2CODEX_MANAGED_RUNTIME_ROOT?.trim();
  if (configured) candidates.push(configured);
  return Promise.all(candidates.map(canonicalIfPresent));
}

export async function validateRuntimeTarget(input: {
  stateDir: string;
  projectRoot: string;
  targetRuntimeRoot: string;
  targetFingerprint: string;
}): Promise<{ runtimeRoot: string; manifest: RuntimeManifest }> {
  if (!path.isAbsolute(input.targetRuntimeRoot) || input.targetRuntimeRoot.includes("\0")) {
    throw new Error("TARGET_INVALID: target runtime root must be an absolute local path");
  }
  if (!SHA256_PATTERN.test(input.targetFingerprint)) throw new Error("TARGET_INVALID: invalid target fingerprint");
  const target = await fs.realpath(input.targetRuntimeRoot).catch(() => null);
  if (!target) throw new Error("TARGET_INVALID: target runtime root does not exist");
  const roots = await allowedRuntimeRoots(input.stateDir, input.projectRoot);
  if (!roots.some((root) => isWithin(root, target))) {
    throw new Error("TARGET_INVALID: target runtime root is outside approved runtime roots");
  }
  const requiredFiles = [path.join(target, "package.json"), path.join(target, "dist", "cli.js")];
  for (const required of requiredFiles) {
    const resolved = await fs.realpath(required).catch(() => null);
    if (!resolved || !isWithin(target, resolved)) {
      throw new Error("TARGET_INVALID: runtime files are missing or escape through a symlink");
    }
  }
  const manifest = getRuntimeManifestForRoot(target);
  if (!manifest.buildFingerprint || manifest.buildFingerprint !== input.targetFingerprint.toLowerCase()) {
    throw new Error("TARGET_INVALID: target build fingerprint mismatch");
  }
  return { runtimeRoot: target, manifest };
}

export async function readActiveRuntimePointer(stateDir: string): Promise<string | null> {
  try {
    const value = (await fs.readFile(path.join(stateDir, "active-runtime"), "utf8")).trim();
    return value ? path.resolve(value) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeActiveRuntimePointer(stateDir: string, runtimeRoot: string | null): Promise<void> {
  await ensurePrivateDirectory(stateDir);
  const destination = path.join(stateDir, "active-runtime");
  if (runtimeRoot === null) {
    await fs.unlink(destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return;
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${runtimeRoot}\n`, { mode: FILE_MODE, flag: "wx" });
  await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
  try {
    await fs.rename(temporary, destination);
    await fs.chmod(destination, FILE_MODE).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function requestRuntimeReload(stateDir: string, operationId: string): Promise<void> {
  await ensurePrivateDirectory(stateDir);
  const marker = path.join(stateDir, "runtime-reload-request");
  const temporary = `${marker}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${operationId}\n`, { mode: FILE_MODE, flag: "wx" });
  try {
    await fs.rename(temporary, marker);
    await fs.chmod(marker, FILE_MODE).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function writeRuntimeApplyMaintenanceMarker(
  stateDir: string,
  operationId: string,
  supervisorPid: number,
): Promise<void> {
  if (!/^rt_[0-9a-f-]{36}$/u.test(operationId) || !Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) {
    throw new Error("INVALID_RUNTIME_MAINTENANCE_IDENTITY");
  }
  await ensurePrivateDirectory(stateDir);
  const marker = path.join(stateDir, "runtime-apply-maintenance");
  const temporary = `${marker}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${supervisorPid} ${operationId}\n`, { mode: FILE_MODE, flag: "wx" });
  try {
    await fs.rename(temporary, marker);
    await fs.chmod(marker, FILE_MODE).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function clearRuntimeApplyMaintenanceMarker(stateDir: string, operationId: string): Promise<void> {
  const marker = path.join(stateDir, "runtime-apply-maintenance");
  const raw = await fs.readFile(marker, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return;
  const currentOperationId = raw.trim().split(/\s+/u)[1] ?? "";
  if (currentOperationId !== operationId) return;
  await fs.unlink(marker).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

function newReceipt(input: {
  projectId: string;
  requestId: string;
  expectedCurrentFingerprint: string;
  targetFingerprint: string;
  currentManifest: RuntimeManifest;
  targetManifest: RuntimeManifest;
  previousPointerValue: string | null;
  preApplyHealth: RuntimeHealthSnapshot;
  state: RuntimeApplyState;
  phase: RuntimeApplyPhase;
  recommendedAction: string;
}): RuntimeApplyReceipt {
  const now = timestamp();
  const externalIdentityBefore = input.preApplyHealth.externalIdentity ?? currentRuntimeExternalIdentity();
  const previousRuntimePid = input.preApplyHealth.runtimePid;
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    requestId: input.requestId,
    operationId: `rt_${randomUUID()}`,
    projectId: input.projectId,
    state: input.state,
    phase: input.phase,
    createdAt: now,
    updatedAt: now,
    expectedCurrentFingerprint: input.expectedCurrentFingerprint,
    targetFingerprint: input.targetFingerprint,
    preserveConnector: true,
    previousRuntimePid,
    currentRuntimePid: previousRuntimePid,
    supervisorPid: externalIdentityBefore.supervisorPid ?? input.preApplyHealth.supervisorPid,
    supervisorPreserved: null,
    previousRuntimeRoot: input.currentManifest.runtimeRoot,
    currentRuntimeRoot: input.currentManifest.runtimeRoot,
    previousManifest: input.currentManifest,
    targetManifest: input.targetManifest,
    activeRuntimePointer: input.previousPointerValue,
    previousPointerValue: input.previousPointerValue,
    preApplyHealth: {
      ...input.preApplyHealth,
      externalIdentity: externalIdentityBefore,
    },
    postApplyHealth: null,
    connectorPublicOrigin: externalIdentityBefore.connectorPublicOrigin,
    connectorPreserved: null,
    tunnelProcessesPreserved: null,
    rollbackAttempted: false,
    rollbackSucceeded: null,
    previousRuntimeRestored: null,
    finalHealthy: null,
    diagnosticId: `diag_runtime_${randomUUID()}`,
    failurePhase: null,
    recommendedAction: input.recommendedAction,
    externalIdentityBefore,
    history: [{ at: now, state: input.state, phase: input.phase }],
  };
}

const ACTIVE_APPLY_STATES = new Set<RuntimeApplyState>([
  "APPROVAL_REQUIRED",
  "ACTIVATION_REQUESTED",
  "HEALTH_CHECK_FAILED",
]);

export async function prepareRuntimeApply(
  input: PrepareRuntimeApplyInput,
  dependencies: PrepareRuntimeApplyDependencies = {},
): Promise<PrepareRuntimeApplyResult> {
  if (!REQUEST_ID_PATTERN.test(input.requestId)) throw new Error("TARGET_INVALID: invalid requestId");
  if (!SHA256_PATTERN.test(input.expectedCurrentFingerprint)) throw new Error("PRECONDITION_FAILED: invalid expected fingerprint");
  if (!SHA256_PATTERN.test(input.targetFingerprint)) throw new Error("TARGET_INVALID: invalid target fingerprint");

  return withRuntimeUpdateLock(input.stateDir, async () => {
    const receipts = await listReceiptsUnlocked(input.stateDir);
    const existing = receipts.find((entry) => entry.requestId === input.requestId);
    const requestedRuntimeRoot = await fs.realpath(input.targetRuntimeRoot).catch(() => path.resolve(input.targetRuntimeRoot));
    if (existing && (
      existing.targetFingerprint !== input.targetFingerprint.toLowerCase() ||
      existing.targetManifest.runtimeRoot !== requestedRuntimeRoot
    )) {
      return { receipt: existing, replayed: true, conflict: true };
    }
    if (existing && existing.state !== "ACTIVE_OPERATION_BLOCKED") {
      return { receipt: existing, replayed: true, conflict: false };
    }

    const preApplyHealth = await (dependencies.probeHealth ?? probeRuntimeHealth)(runtimePort());
    const currentManifest = preApplyHealth.manifest ?? getRuntimeManifest();
    const previousPointerValue = await readActiveRuntimePointer(input.stateDir);
    let target: { runtimeRoot: string; manifest: RuntimeManifest };
    try {
      target = await validateRuntimeTarget({
        stateDir: input.stateDir,
        projectRoot: input.projectRoot,
        targetRuntimeRoot: input.targetRuntimeRoot,
        targetFingerprint: input.targetFingerprint,
      });
    } catch {
      const receipt = existing ?? newReceipt({
        projectId: input.projectId,
        requestId: input.requestId,
        expectedCurrentFingerprint: input.expectedCurrentFingerprint.toLowerCase(),
        targetFingerprint: input.targetFingerprint.toLowerCase(),
        currentManifest,
        targetManifest: getRuntimeManifestForRoot(input.projectRoot),
        previousPointerValue,
        preApplyHealth,
        state: "TARGET_INVALID",
        phase: "preflight",
        recommendedAction: "inspect-target-runtime",
      });
      const next = transition(receipt, "TARGET_INVALID", "complete");
      next.failurePhase = "preflight";
      next.finalHealthy = preApplyHealth.healthy;
      await writeReceiptUnlocked(input.stateDir, next);
      return { receipt: next, replayed: Boolean(existing), conflict: false };
    }

    const base = existing ?? newReceipt({
      projectId: input.projectId,
      requestId: input.requestId,
      expectedCurrentFingerprint: input.expectedCurrentFingerprint.toLowerCase(),
      targetFingerprint: input.targetFingerprint.toLowerCase(),
      currentManifest,
      targetManifest: target.manifest,
      previousPointerValue,
      preApplyHealth,
      state: "APPROVAL_REQUIRED",
      phase: "approval",
      recommendedAction: "approve-runtime-apply-locally",
    });
    base.targetManifest = target.manifest;

    if (!base.preApplyHealth.healthy ||
        base.preApplyHealth.runtimePid === null ||
        base.preApplyHealth.manifest?.buildFingerprint !== input.expectedCurrentFingerprint.toLowerCase()) {
      const next = transition(base, "PRECONDITION_FAILED", "complete");
      next.failurePhase = "preflight";
      next.finalHealthy = base.preApplyHealth.healthy;
      next.recommendedAction = "refresh-live-runtime-identity";
      await writeReceiptUnlocked(input.stateDir, next);
      return { receipt: next, replayed: Boolean(existing), conflict: false };
    }

    if (base.externalIdentityBefore.supervisorPid === null) {
      const next = transition(base, "PRECONDITION_FAILED", "complete");
      next.failurePhase = "preflight";
      next.finalHealthy = true;
      next.recommendedAction = "run-under-managed-runtime-supervisor";
      await writeReceiptUnlocked(input.stateDir, next);
      return { receipt: next, replayed: Boolean(existing), conflict: false };
    }

    if (!currentManifest.buildFingerprint || currentManifest.buildFingerprint !== input.expectedCurrentFingerprint.toLowerCase()) {
      const next = transition(base, "PRECONDITION_FAILED", "complete");
      next.failurePhase = "preflight";
      next.finalHealthy = true;
      next.recommendedAction = "refresh-live-runtime-identity";
      await writeReceiptUnlocked(input.stateDir, next);
      return { receipt: next, replayed: Boolean(existing), conflict: false };
    }

    if (currentManifest.buildFingerprint === target.manifest.buildFingerprint && currentManifest.runtimeRoot === target.runtimeRoot) {
      const next = transition(base, "ALREADY_APPLIED", "complete");
      next.currentRuntimeRoot = currentManifest.runtimeRoot;
      next.currentRuntimePid = base.preApplyHealth.runtimePid;
      next.postApplyHealth = base.preApplyHealth;
      next.connectorPreserved = true;
      next.tunnelProcessesPreserved = true;
      next.supervisorPreserved = true;
      next.finalHealthy = true;
      next.recommendedAction = "none";
      await writeReceiptUnlocked(input.stateDir, next);
      return { receipt: next, replayed: Boolean(existing), conflict: false };
    }

    const anotherActive = receipts.find((entry) => entry.requestId !== input.requestId && ACTIVE_APPLY_STATES.has(entry.state));
    const blocked = Boolean(anotherActive) ||
      (input.activeOperationCount ?? 0) > 0 ||
      (input.unrelatedPendingApprovalCount ?? 0) > 0;
    if (blocked) {
      const next = transition(base, "ACTIVE_OPERATION_BLOCKED", "preflight");
      next.recommendedAction = "retry-after-active-operations-complete";
      await writeReceiptUnlocked(input.stateDir, next);
      return { receipt: next, replayed: Boolean(existing), conflict: false };
    }

    const next = transition(base, "APPROVAL_REQUIRED", "approval");
    next.recommendedAction = "approve-runtime-apply-locally";
    await writeReceiptUnlocked(input.stateDir, next);
    return { receipt: next, replayed: Boolean(existing), conflict: false };
  });
}

export async function getLatestRuntimeApplyReceipt(stateDir: string): Promise<RuntimeApplyReceipt | null> {
  const receipts = await listReceiptsUnlocked(stateDir);
  return receipts.at(-1) ?? null;
}

export function latestAppliedSchemaChangingRuntimeApplyReceipt(
  receipts: readonly RuntimeApplyReceipt[],
): RuntimeApplyReceipt | null {
  return [...receipts].reverse().find((receipt) =>
    (receipt.state === "APPLIED" || receipt.state === "ALREADY_APPLIED")
    && receipt.previousManifest.toolSchemaRevision !== receipt.targetManifest.toolSchemaRevision,
  ) ?? null;
}

export async function getLatestAppliedSchemaChangingRuntimeApplyReceipt(
  stateDir: string,
): Promise<RuntimeApplyReceipt | null> {
  return latestAppliedSchemaChangingRuntimeApplyReceipt(await listReceiptsUnlocked(stateDir));
}

/**
 * Reconcile persisted APPROVAL_REQUIRED receipts with operation approval state.
 * Missing, expired, rejected, or consumed approvals are terminalized so they
 * cannot block future runtime applies indefinitely.
 */
export async function reconcileRuntimeApplyApprovalReceipts(
  stateDir: string,
  liveApprovalRequestIds: ReadonlySet<string>,
): Promise<RuntimeApplyReceipt[]> {
  return withRuntimeUpdateLock(stateDir, async () => {
    const receipts = await listReceiptsUnlocked(stateDir);
    const reconciled: RuntimeApplyReceipt[] = [];
    for (const receipt of receipts) {
      if (receipt.state !== "APPROVAL_REQUIRED") continue;
      if (receipt.approvalRequestId && liveApprovalRequestIds.has(receipt.approvalRequestId)) continue;
      const next = transition(receipt, "APPROVAL_EXPIRED", "complete");
      next.failurePhase = "approval";
      next.finalHealthy = receipt.preApplyHealth.healthy;
      next.recommendedAction = "retry-runtime-apply-with-new-requestId";
      await writeReceiptUnlocked(stateDir, next);
      reconciled.push(next);
    }
    return reconciled;
  });
}


export async function markRuntimeApplyBlocked(
  stateDir: string,
  operationId: string,
  recommendedAction = "retry-after-active-operations-complete",
): Promise<RuntimeApplyReceipt> {
  return updateRuntimeApplyReceipt(stateDir, operationId, (receipt) => {
    const next = transition(receipt, "ACTIVE_OPERATION_BLOCKED", "preflight");
    next.recommendedAction = recommendedAction;
    return next;
  });
}

export async function markRuntimeApplyApprovalRequired(
  stateDir: string,
  operationId: string,
  approvalRequestId: string,
): Promise<RuntimeApplyReceipt> {
  return updateRuntimeApplyReceipt(stateDir, operationId, (receipt) => {
    const next = transition(receipt, "APPROVAL_REQUIRED", "approval");
    next.approvalRequestId = approvalRequestId;
    next.recommendedAction = "approve-runtime-apply-locally";
    return next;
  });
}

export async function attachRuntimeApplyApprovalRequest(
  stateDir: string,
  operationId: string,
  approvalRequestId: string,
): Promise<RuntimeApplyReceipt> {
  return updateRuntimeApplyReceipt(stateDir, operationId, (receipt) => {
    const next = transition(receipt, "APPROVAL_REQUIRED", "approval");
    next.approvalRequestId = approvalRequestId;
    next.recommendedAction = "approve-runtime-apply-locally";
    return next;
  });
}

export async function markRuntimeApplyActivationRequested(
  stateDir: string,
  operationId: string,
): Promise<RuntimeApplyReceipt> {
  return updateRuntimeApplyReceipt(stateDir, operationId, (receipt) => {
    if (receipt.state === "ACTIVATION_REQUESTED") return receipt;
    const next = transition(receipt, "ACTIVATION_REQUESTED", "activation");
    next.recommendedAction = "poll-runtime-apply-status";
    return next;
  });
}

export async function markRuntimeApplyStartFailed(
  stateDir: string,
  operationId: string,
): Promise<RuntimeApplyReceipt> {
  return updateRuntimeApplyReceipt(stateDir, operationId, (receipt) => {
    const next = transition(receipt, "APPLY_START_FAILED", "complete");
    next.failurePhase = "activation";
    next.postApplyHealth = receipt.preApplyHealth;
    next.finalHealthy = true;
    next.recommendedAction = "inspect-runtime-worker-launch";
    return next;
  });
}

export function launchRuntimeApplyWorker(stateDir: string, operationId: string): number {
  const worker = fileURLToPath(new URL("./runtime-apply-worker.js", import.meta.url));
  // execution-capability: runtime-apply-fixed-worker
  const child = spawn(process.execPath, [worker, "--state-dir", stateDir, "--operation-id", operationId, "--port", String(runtimePort())], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  if (!child.pid) throw new Error("Runtime apply worker did not start");
  child.unref();
  return child.pid;
}

export async function recordRuntimeApplyWorkerPid(
  stateDir: string,
  operationId: string,
  workerPid: number,
): Promise<RuntimeApplyReceipt> {
  return updateRuntimeApplyReceipt(stateDir, operationId, (receipt) => ({ ...receipt, workerPid, updatedAt: timestamp() }));
}

function manifestFromHealth(value: unknown): RuntimeManifest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RuntimeManifest>;
  if (typeof candidate.packageVersion !== "string" ||
      typeof candidate.runtimeRoot !== "string" ||
      typeof candidate.platform !== "string" ||
      typeof candidate.architecture !== "string") return null;
  return candidate as RuntimeManifest;
}

function externalIdentityFromHealth(value: unknown): RuntimeExternalIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const numericPid = (entry: unknown): number | null =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0 ? entry : null;
  const tunnelMode = typeof candidate.tunnelMode === "string" ? candidate.tunnelMode.slice(0, 40) : null;
  const connectorPublicOrigin = typeof candidate.connectorPublicOrigin === "string"
    ? safeOrigin(candidate.connectorPublicOrigin)
    : null;
  return {
    supervisorPid: numericPid(candidate.supervisorPid),
    cloudflaredPid: numericPid(candidate.cloudflaredPid),
    tunnelMode,
    connectorPublicOrigin,
  };
}

export async function probeRuntimeHealth(port: number): Promise<RuntimeHealthSnapshot> {
  const checkedAt = timestamp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1_500),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { healthy: false, checkedAt, runtimePid: null, supervisorPid: null, manifest: null, externalIdentity: null };
    const payload = await response.json() as Record<string, unknown>;
    const runtimePid = typeof payload.runtimePid === "number" && Number.isSafeInteger(payload.runtimePid) ? payload.runtimePid : null;
    const supervisorPid = typeof payload.supervisorPid === "number" && Number.isSafeInteger(payload.supervisorPid) ? payload.supervisorPid : null;
    const manifest = manifestFromHealth(payload.runtimeManifest);
    const externalIdentity = externalIdentityFromHealth(payload.runtimeExternalIdentity);
    return { healthy: Boolean(manifest), checkedAt, runtimePid, supervisorPid, manifest, externalIdentity };
  } catch {
    return { healthy: false, checkedAt, runtimePid: null, supervisorPid: null, manifest: null, externalIdentity: null };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function preservation(receipt: RuntimeApplyReceipt, health: RuntimeHealthSnapshot | null, pidAlive: (pid: number) => boolean): {
  supervisorPreserved: boolean;
  connectorPreserved: boolean;
  tunnelProcessesPreserved: boolean;
} {
  const before = receipt.externalIdentityBefore;
  const after = health?.externalIdentity ?? null;
  const supervisorPreserved = before.supervisorPid !== null &&
    after?.supervisorPid === before.supervisorPid &&
    pidAlive(before.supervisorPid);
  const connectorPreserved = Boolean(after) &&
    after?.connectorPublicOrigin === before.connectorPublicOrigin &&
    supervisorPreserved;
  const tunnelProcessesPreserved = Boolean(after) &&
    after?.tunnelMode === before.tunnelMode &&
    after?.cloudflaredPid === before.cloudflaredPid &&
    (before.cloudflaredPid === null || pidAlive(before.cloudflaredPid));
  return {
    supervisorPreserved,
    connectorPreserved,
    tunnelProcessesPreserved,
  };
}

export async function runRuntimeApplyWorker(input: {
  stateDir: string;
  operationId: string;
  port: number;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  stabilityProbeCount?: number;
  dependencies?: RuntimeApplyWorkerDependencies;
}): Promise<RuntimeApplyReceipt> {
  const dependencies = input.dependencies ?? {};
  const probe = dependencies.probeHealth ?? probeRuntimeHealth;
  const probeActivationHealth = dependencies.probeActivationHealth ?? probe;
  const reload = dependencies.requestReload ?? requestRuntimeReload;
  const sleep = dependencies.sleep ?? delay;
  const pidAlive = dependencies.pidAlive ?? processAlive;
  const now = dependencies.now ?? (() => new Date());
  const healthTimeoutMs = input.healthTimeoutMs ?? 45_000;
  const pollIntervalMs = input.pollIntervalMs ?? 500;
  const requiredStableTargetProbes = Math.max(1, Math.min(20, input.stabilityProbeCount ?? 1));

  let receipt = await getRuntimeApplyReceipt(input.stateDir, { operationId: input.operationId });
  if (!receipt) throw new Error(`Runtime apply receipt not found: ${input.operationId}`);
  if (receipt.state !== "ACTIVATION_REQUESTED") return receipt;

  const current = getRuntimeManifest();
  if (!current.buildFingerprint || current.buildFingerprint !== receipt.expectedCurrentFingerprint) {
    return updateRuntimeApplyReceipt(input.stateDir, input.operationId, (value) => {
      const next = transition(value, "PRECONDITION_FAILED", "complete", now());
      next.failurePhase = "preflight";
      next.finalHealthy = true;
      next.recommendedAction = "refresh-live-runtime-identity";
      return next;
    });
  }
  const target = getRuntimeManifestForRoot(receipt.targetManifest.runtimeRoot);
  if (!target.buildFingerprint || target.buildFingerprint !== receipt.targetFingerprint) {
    return updateRuntimeApplyReceipt(input.stateDir, input.operationId, (value) => {
      const next = transition(value, "TARGET_INVALID", "complete", now());
      next.failurePhase = "preflight";
      next.finalHealthy = true;
      next.recommendedAction = "rebuild-and-reverify-target";
      return next;
    });
  }

  // Approval and worker activation are separated in time. The menu-bar app can
  // be replaced during that gap, taking its managed supervisor (and the live
  // runtime) with it. Re-check the exact managed supervisor immediately before
  // changing the active-runtime pointer so a stale worker fails closed instead
  // of mutating the pointer and waiting through a doomed health timeout.
  const activationHealth = await probeActivationHealth(input.port);
  const expectedSupervisorPid = receipt.externalIdentityBefore.supervisorPid;
  const activationSupervisorPid = activationHealth.externalIdentity?.supervisorPid ?? activationHealth.supervisorPid;
  const activationFingerprint = activationHealth.manifest?.buildFingerprint ?? null;
  if (!activationHealth.healthy ||
      expectedSupervisorPid === null ||
      activationSupervisorPid !== expectedSupervisorPid ||
      !pidAlive(expectedSupervisorPid) ||
      activationFingerprint !== receipt.expectedCurrentFingerprint) {
    return updateRuntimeApplyReceipt(input.stateDir, input.operationId, (value) => {
      const next = transition(value, "PRECONDITION_FAILED", "complete", now());
      next.failurePhase = "preflight";
      next.postApplyHealth = activationHealth;
      next.finalHealthy = activationHealth.healthy;
      next.supervisorPreserved = false;
      next.recommendedAction = "refresh-managed-runtime-topology-before-retry";
      return next;
    });
  }

  await writeRuntimeApplyMaintenanceMarker(input.stateDir, input.operationId, expectedSupervisorPid);
  await writeActiveRuntimePointer(input.stateDir, receipt.targetManifest.runtimeRoot);
  receipt = await updateRuntimeApplyReceipt(input.stateDir, input.operationId, (value) => ({
    ...transition(value, "ACTIVATION_REQUESTED", "activation", now()),
    activeRuntimePointer: value.targetManifest.runtimeRoot,
  }));
  await reload(input.stateDir, input.operationId);

  const deadline = Date.now() + healthTimeoutMs;
  let stableTargetPid: number | null = null;
  let stableTargetProbes = 0;
  let unstableTargetProbes = 0;
  let targetObserved = false;
  let stabilityFailureAction = "rollback-in-progress";
  while (Date.now() < deadline) {
    const health = await probe(input.port);
    const pointer = await readActiveRuntimePointer(input.stateDir);
    const targetPidAlive = health.runtimePid !== null && pidAlive(health.runtimePid);
    const targetActivated = health.healthy &&
      health.manifest?.buildFingerprint === receipt.targetFingerprint &&
      health.manifest.runtimeRoot === receipt.targetManifest.runtimeRoot &&
      pointer === receipt.targetManifest.runtimeRoot &&
      targetPidAlive &&
      health.runtimePid !== receipt.previousRuntimePid;
    if (targetActivated) {
      targetObserved = true;
      unstableTargetProbes = 0;
      if (stableTargetPid === health.runtimePid) {
        stableTargetProbes += 1;
      } else {
        stableTargetPid = health.runtimePid;
        stableTargetProbes = 1;
      }
      if (stableTargetProbes >= requiredStableTargetProbes) {
        const preserved = preservation(receipt, health, pidAlive);
        return updateRuntimeApplyReceipt(input.stateDir, input.operationId, (value) => {
          const next = transition(value, "APPLIED", "complete", now());
          next.currentRuntimePid = health.runtimePid;
          next.currentRuntimeRoot = health.manifest?.runtimeRoot ?? value.targetManifest.runtimeRoot;
          next.activeRuntimePointer = pointer;
          next.postApplyHealth = health;
          next.supervisorPreserved = preserved.supervisorPreserved;
          next.connectorPreserved = preserved.connectorPreserved;
          next.tunnelProcessesPreserved = preserved.tunnelProcessesPreserved;
          next.rollbackAttempted = false;
          next.rollbackSucceeded = null;
          next.previousRuntimeRestored = false;
          next.finalHealthy = true;
          next.recommendedAction = runtimeSchemaRefreshRequired(value.previousManifest, value.targetManifest)
            ? "refresh-hosted-tool-snapshot-and-bootstrap"
            : "none";
          return next;
        });
      }
    } else {
      stableTargetProbes = 0;
      if (targetObserved) {
        const observedPidDied = stableTargetPid !== null && !pidAlive(stableTargetPid);
        unstableTargetProbes += 1;
        if (observedPidDied || unstableTargetProbes >= 3) {
          stabilityFailureAction = observedPidDied
            ? "candidate-runtime-exited-during-stability-window"
            : "candidate-runtime-unstable-during-stability-window";
          break;
        }
      }
    }
    const previousRuntimeRestored = health.healthy &&
      health.manifest?.buildFingerprint === receipt.expectedCurrentFingerprint &&
      health.manifest.runtimeRoot === receipt.previousRuntimeRoot &&
      pointer === receipt.previousPointerValue;
    if (previousRuntimeRestored) {
      const preserved = preservation(receipt, health, pidAlive);
      return updateRuntimeApplyReceipt(input.stateDir, input.operationId, (value) => {
        let next = transition(value, "HEALTH_CHECK_FAILED", "health", now());
        next.rollbackAttempted = true;
        next.failurePhase = "health";
        next = transition(next, "APPLY_FAILED_ROLLED_BACK", "complete", now());
        next.currentRuntimePid = health.runtimePid;
        next.currentRuntimeRoot = health.manifest?.runtimeRoot ?? value.previousRuntimeRoot;
        next.activeRuntimePointer = pointer;
        next.postApplyHealth = health;
        next.supervisorPreserved = preserved.supervisorPreserved;
        next.connectorPreserved = preserved.connectorPreserved;
        next.tunnelProcessesPreserved = preserved.tunnelProcessesPreserved;
        next.rollbackSucceeded = true;
        next.previousRuntimeRestored = true;
        next.finalHealthy = true;
        next.recommendedAction = "inspect-candidate-health-failure";
        return next;
      });
    }
    await sleep(pollIntervalMs);
  }

  await updateRuntimeApplyReceipt(input.stateDir, input.operationId, (value) => {
    const next = transition(value, "HEALTH_CHECK_FAILED", "health", now());
    next.rollbackAttempted = true;
    next.failurePhase = "health";
    next.recommendedAction = stabilityFailureAction;
    return next;
  });
  await writeActiveRuntimePointer(input.stateDir, receipt.previousPointerValue);
  await reload(input.stateDir, input.operationId);

  const rollbackDeadline = Date.now() + healthTimeoutMs;
  while (Date.now() < rollbackDeadline) {
    const health = await probe(input.port);
    const pointer = await readActiveRuntimePointer(input.stateDir);
    if (health.healthy &&
        health.manifest?.buildFingerprint === receipt.expectedCurrentFingerprint &&
        health.manifest.runtimeRoot === receipt.previousRuntimeRoot &&
        pointer === receipt.previousPointerValue) {
      const preserved = preservation(receipt, health, pidAlive);
      return updateRuntimeApplyReceipt(input.stateDir, input.operationId, (value) => {
        const next = transition(value, "APPLY_FAILED_ROLLED_BACK", "complete", now());
        next.currentRuntimePid = health.runtimePid;
        next.currentRuntimeRoot = health.manifest?.runtimeRoot ?? value.previousRuntimeRoot;
        next.activeRuntimePointer = pointer;
        next.postApplyHealth = health;
        next.supervisorPreserved = preserved.supervisorPreserved;
        next.connectorPreserved = preserved.connectorPreserved;
        next.tunnelProcessesPreserved = preserved.tunnelProcessesPreserved;
        next.rollbackAttempted = true;
        next.rollbackSucceeded = true;
        next.previousRuntimeRestored = true;
        next.finalHealthy = true;
        next.recommendedAction = "inspect-candidate-health-failure";
        return next;
      });
    }
    await sleep(pollIntervalMs);
  }

  const preserved = preservation(receipt, null, pidAlive);
  return updateRuntimeApplyReceipt(input.stateDir, input.operationId, (value) => {
    const next = transition(value, "APPLY_FAILED_ROLLBACK_FAILED", "complete", now());
    next.activeRuntimePointer = value.previousPointerValue;
    next.postApplyHealth = { healthy: false, checkedAt: timestamp(now()), runtimePid: null, supervisorPid: null, manifest: null, externalIdentity: null };
    next.supervisorPreserved = preserved.supervisorPreserved;
    next.connectorPreserved = preserved.connectorPreserved;
    next.tunnelProcessesPreserved = preserved.tunnelProcessesPreserved;
    next.rollbackAttempted = true;
    next.rollbackSucceeded = false;
    next.previousRuntimeRestored = false;
    next.finalHealthy = false;
    next.failurePhase = "rollback";
    next.recommendedAction = "inspect-supervisor-and-previous-runtime";
    return next;
  });
}

export function runtimeApplyPublicReceipt(receipt: RuntimeApplyReceipt): Record<string, unknown> {
  const schemaRefreshRequired =
    (receipt.state === "APPLIED" || receipt.state === "ALREADY_APPLIED")
    && runtimeSchemaRefreshRequired(receipt.previousManifest, receipt.targetManifest);
  return {
    requestId: receipt.requestId,
    operationId: receipt.operationId,
    state: receipt.state,
    phase: receipt.phase,
    previousRuntimePid: receipt.previousRuntimePid,
    currentRuntimePid: receipt.currentRuntimePid,
    supervisorPid: receipt.supervisorPid,
    supervisorPreserved: receipt.supervisorPreserved,
    previousRuntimeRoot: receipt.previousRuntimeRoot,
    currentRuntimeRoot: receipt.currentRuntimeRoot,
    previousManifest: receipt.previousManifest,
    targetManifest: receipt.targetManifest,
    activeRuntimePointer: receipt.activeRuntimePointer,
    preApplyHealth: receipt.preApplyHealth,
    postApplyHealth: receipt.postApplyHealth,
    connectorPublicOrigin: receipt.connectorPublicOrigin,
    connectorPreserved: receipt.connectorPreserved,
    tunnelProcessesPreserved: receipt.tunnelProcessesPreserved,
    rollbackAttempted: receipt.rollbackAttempted,
    rollbackSucceeded: receipt.rollbackSucceeded,
    previousRuntimeRestored: receipt.previousRuntimeRestored,
    finalHealthy: receipt.finalHealthy,
    diagnosticId: receipt.diagnosticId,
    failurePhase: receipt.failurePhase,
    recommendedAction: receipt.recommendedAction,
    schemaRefreshRequired,
    previousToolSchemaRevision: receipt.previousManifest.toolSchemaRevision,
    targetToolSchemaRevision: receipt.targetManifest.toolSchemaRevision,
    previousUiResourceRevision: receipt.previousManifest.uiResourceRevision ?? null,
    targetUiResourceRevision: receipt.targetManifest.uiResourceRevision ?? null,
    connectorReregistrationRequired: false,
    connectorEndpointPolicy: "stable-bare-mcp",
    hostCatalogRebindVerified: null,
    hostCatalogRefreshRequired: schemaRefreshRequired,
    hostCatalogRefresh: schemaRefreshRequired
      ? {
          surface: "host-app-server",
          method: "app/installed",
          params: { forceRefresh: true },
          requiresFreshChatVerification: false,
          verificationTarget: "direct-named-tool-mount",
        }
      : null,
    schemaRefreshFallback: schemaRefreshRequired
      ? "keep the registered bare /mcp endpoint; refresh the host's committed connector runtime snapshot with app/installed(forceRefresh=true), then re-query the direct named mount in the current chat; a successful catalog refresh can update the current chat, with a fresh chat used only as fallback when the mount remains stale; refresh plugin/package inventory separately only when plugin metadata itself changed; use tool_schema_get plus stable c2ct_invoke only as the backend correctness fallback while the host catalog is stale; presenter/widget UI still requires the direct named host mount"
      : "none",
    approvalRequestId: receipt.approvalRequestId ?? null,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
  };
}
