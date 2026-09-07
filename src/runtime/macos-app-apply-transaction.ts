import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyVerifiedMacosApp,
  type MacosAppApplyPreflight,
  type MacosAppApplyResult,
  type MacosAppIdentity,
} from "./macos-app-apply.js";
import {
  readReplacementReconnectPlan,
  recordReplacementReconnectSample,
  type ReplacementReconnectPlan,
} from "./replacement-reconnect-timing.js";

const SCHEMA_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type MacosAppApplyState =
  | "APPROVAL_REQUIRED"
  | "ACTIVATION_REQUESTED"
  | "APPLIED"
  | "ALREADY_APPLIED"
  | "REQUEST_CONFLICT"
  | "APPLY_START_FAILED"
  | "APPLY_FAILED_ROLLED_BACK"
  | "APPLY_FAILED_ROLLBACK_FAILED";

export interface MacosAppApplyReceipt {
  schemaVersion: 1;
  requestId: string;
  operationId: string;
  projectId: string;
  projectRoot: string;
  state: MacosAppApplyState;
  createdAt: string;
  updatedAt: string;
  source: MacosAppIdentity;
  installedBefore: MacosAppIdentity | null;
  result: MacosAppApplyResult | null;
  workerPid?: number;
  approvalRequestId?: string;
  disconnectStartedAt?: string;
  reconnectObservedAt?: string;
  reconnectDurationMs?: number;
  reconnectPlan?: ReplacementReconnectPlan;
  failure: string | null;
  recommendedAction: string;
}

function receiptDirectory(stateDir: string): string {
  return path.join(stateDir, "macos-app-updates", "receipts");
}

function receiptFile(stateDir: string, requestId: string): string {
  const key = createHash("sha256").update(requestId).digest("hex");
  return path.join(receiptDirectory(stateDir), `${key}.json`);
}

async function writeReceipt(stateDir: string, receipt: MacosAppApplyReceipt): Promise<void> {
  const directory = receiptDirectory(stateDir);
  await fs.mkdir(directory, { recursive: true, mode: DIR_MODE });
  await fs.chmod(path.dirname(directory), DIR_MODE).catch(() => undefined);
  await fs.chmod(directory, DIR_MODE).catch(() => undefined);
  const target = receiptFile(stateDir, receipt.requestId);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: FILE_MODE });
  await fs.rename(temporary, target);
  await fs.chmod(target, FILE_MODE);
}

function isReceipt(value: unknown): value is MacosAppApplyReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<MacosAppApplyReceipt>;
  return receipt.schemaVersion === SCHEMA_VERSION &&
    typeof receipt.requestId === "string" &&
    typeof receipt.operationId === "string" &&
    typeof receipt.projectId === "string" &&
    typeof receipt.projectRoot === "string" &&
    typeof receipt.state === "string" &&
    Boolean(receipt.source && typeof receipt.source.mainExecutableSha256 === "string");
}

export async function getMacosAppApplyReceipt(stateDir: string, requestId: string): Promise<MacosAppApplyReceipt | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(receiptFile(stateDir, requestId), "utf8"));
    if (!isReceipt(parsed)) throw new Error("Malformed macOS app apply receipt");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function getMacosAppApplyReceiptByOperationId(
  stateDir: string,
  operationId: string,
): Promise<MacosAppApplyReceipt | null> {
  const directory = receiptDirectory(stateDir);
  const names = await fs.readdir(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names.filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry)).slice(-200)) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      if (isReceipt(parsed) && parsed.operationId === operationId) return parsed;
    } catch {
      // Ignore malformed unrelated receipts. Exact requestId lookup remains strict.
    }
  }
  return null;
}

export async function getLatestMacosAppApplyReceipt(stateDir: string): Promise<MacosAppApplyReceipt | null> {
  const directory = receiptDirectory(stateDir);
  const names = await fs.readdir(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const receipts: MacosAppApplyReceipt[] = [];
  for (const name of names.filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry)).slice(-200)) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      if (isReceipt(parsed)) receipts.push(parsed);
    } catch {
      // A malformed private receipt must not break connection_status. Exact
      // requestId lookup remains strict and will surface corruption directly.
    }
  }
  return receipts.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1) ?? null;
}

function sameSource(left: MacosAppIdentity, right: MacosAppIdentity): boolean {
  return left.bundleId === right.bundleId &&
    left.teamIdentifier === right.teamIdentifier &&
    left.designatedRequirementSha256 === right.designatedRequirementSha256 &&
    left.mainExecutableSha256 === right.mainExecutableSha256;
}

export async function prepareMacosAppApply(input: {
  stateDir: string;
  projectId: string;
  projectRoot: string;
  requestId: string;
  preflight: MacosAppApplyPreflight;
}): Promise<{ receipt: MacosAppApplyReceipt; replayed: boolean; conflict: boolean }> {
  const existing = await getMacosAppApplyReceipt(input.stateDir, input.requestId);
  if (existing) {
    return {
      receipt: existing,
      replayed: true,
      conflict: existing.projectId !== input.projectId ||
        path.resolve(existing.projectRoot) !== path.resolve(input.projectRoot) ||
        !sameSource(existing.source, input.preflight.source),
    };
  }
  const now = new Date().toISOString();
  const receipt: MacosAppApplyReceipt = {
    schemaVersion: SCHEMA_VERSION,
    requestId: input.requestId,
    operationId: `app_${randomUUID()}`,
    projectId: input.projectId,
    projectRoot: path.resolve(input.projectRoot),
    state: input.preflight.alreadyApplied ? "ALREADY_APPLIED" : "APPROVAL_REQUIRED",
    createdAt: now,
    updatedAt: now,
    source: input.preflight.source,
    installedBefore: input.preflight.installed,
    result: null,
    failure: null,
    recommendedAction: input.preflight.alreadyApplied ? "none" : "approve-macos-app-apply-locally",
  };
  await writeReceipt(input.stateDir, receipt);
  return { receipt, replayed: false, conflict: false };
}

async function updateReceipt(
  stateDir: string,
  requestId: string,
  update: (receipt: MacosAppApplyReceipt) => MacosAppApplyReceipt,
): Promise<MacosAppApplyReceipt> {
  const current = await getMacosAppApplyReceipt(stateDir, requestId);
  if (!current) throw new Error(`macOS app apply receipt not found: ${requestId}`);
  const next = update(current);
  next.updatedAt = new Date().toISOString();
  await writeReceipt(stateDir, next);
  return next;
}

export async function bindMacosAppApplyApprovalRequest(
  stateDir: string,
  requestId: string,
  approvalRequestId: string,
): Promise<MacosAppApplyReceipt> {
  return updateReceipt(stateDir, requestId, (receipt) => ({
    ...receipt,
    approvalRequestId,
  }));
}

export async function markMacosAppApplyActivationRequested(stateDir: string, requestId: string): Promise<MacosAppApplyReceipt> {
  const reconnectPlan = await readReplacementReconnectPlan(stateDir, "macos-app").catch(() => undefined);
  return updateReceipt(stateDir, requestId, (receipt) => ({
    ...receipt,
    state: "ACTIVATION_REQUESTED",
    ...(reconnectPlan ? { reconnectPlan } : {}),
    recommendedAction: "wait-then-poll-macos-app-apply-status",
  }));
}

export async function markMacosAppApplyStartFailed(stateDir: string, requestId: string): Promise<MacosAppApplyReceipt> {
  return updateReceipt(stateDir, requestId, (receipt) => ({
    ...receipt,
    state: "APPLY_START_FAILED",
    failure: "fixed-worker-launch-failed",
    recommendedAction: "inspect-macos-app-worker-launch",
  }));
}

export async function recordMacosAppApplyWorkerPid(
  stateDir: string,
  requestId: string,
  workerPid: number,
): Promise<MacosAppApplyReceipt> {
  return updateReceipt(stateDir, requestId, (receipt) => ({ ...receipt, workerPid }));
}

export function launchMacosAppApplyWorker(stateDir: string, requestId: string): number {
  const worker = fileURLToPath(new URL("./macos-app-apply-worker.js", import.meta.url));
  // execution-capability: macos-app-apply-fixed-worker
  const child = spawn(process.execPath, [worker, "--state-dir", stateDir, "--request-id", requestId], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  if (!child.pid) throw new Error("macOS app apply worker did not start");
  child.unref();
  return child.pid;
}

export async function startMacosAppApplyWorkerAfterApproval(
  stateDir: string,
  requestId: string,
): Promise<{ receipt: MacosAppApplyReceipt; workerStarted: boolean }> {
  const reconnectPlan = await readReplacementReconnectPlan(stateDir, "macos-app").catch(() => undefined);
  const activation = await updateReceipt(stateDir, requestId, (receipt) => {
    if (receipt.state !== "APPROVAL_REQUIRED") {
      throw new Error(`macOS app apply ${receipt.operationId} is not awaiting approval continuation`);
    }
    return {
      ...receipt,
      state: "ACTIVATION_REQUESTED",
      ...(reconnectPlan ? { reconnectPlan } : {}),
      recommendedAction: "wait-then-poll-macos-app-apply-status",
    };
  });
  try {
    const workerPid = launchMacosAppApplyWorker(stateDir, requestId);
    const started = await recordMacosAppApplyWorkerPid(stateDir, requestId, workerPid).catch(() => ({
      ...activation,
      workerPid,
    }));
    return { receipt: started, workerStarted: true };
  } catch {
    return {
      receipt: await markMacosAppApplyStartFailed(stateDir, requestId),
      workerStarted: false,
    };
  }
}

export async function runMacosAppApplyWorker(
  stateDir: string,
  requestId: string,
  dependencies: { apply?: typeof applyVerifiedMacosApp; activationDelayMs?: number; now?: () => Date } = {},
): Promise<MacosAppApplyReceipt> {
  let receipt = await getMacosAppApplyReceipt(stateDir, requestId);
  if (!receipt) throw new Error(`macOS app apply receipt not found: ${requestId}`);
  if (receipt.state !== "ACTIVATION_REQUESTED") return receipt;

  // Allow the initiating HTTP/MCP response to flush before the app-owned
  // supervisor and runtime are intentionally handed off.
  await new Promise((resolve) => setTimeout(resolve, dependencies.activationDelayMs ?? 750));
  const now = dependencies.now ?? (() => new Date());
  const disconnectStartedAt = now().toISOString();
  receipt = await updateReceipt(stateDir, requestId, (value) => ({
    ...value,
    disconnectStartedAt,
  }));
  try {
    const apply = dependencies.apply ?? applyVerifiedMacosApp;
    const result = await apply(receipt.projectRoot, receipt.source);
    const reconnectObservedAt = now().toISOString();
    const reconnectDurationMs = Math.max(0, Date.parse(reconnectObservedAt) - Date.parse(disconnectStartedAt));
    const reconnectPlan = await recordReplacementReconnectSample(stateDir, {
      at: reconnectObservedAt,
      kind: "macos-app",
      durationMs: reconnectDurationMs,
      outcome: "healthy",
    }).catch(() => receipt.reconnectPlan);
    return updateReceipt(stateDir, requestId, (value) => ({
      ...value,
      state: result.status === "ALREADY_APPLIED" ? "ALREADY_APPLIED" : "APPLIED",
      result,
      reconnectObservedAt,
      reconnectDurationMs,
      ...(reconnectPlan ? { reconnectPlan } : {}),
      failure: null,
      recommendedAction: "none",
    }));
  } catch (error) {
    const rollbackAttempted = Boolean((error as { rollbackAttempted?: unknown }).rollbackAttempted);
    const rollbackSucceeded = (error as { rollbackSucceeded?: unknown }).rollbackSucceeded === true;
    const reconnectObservedAt = now().toISOString();
    const reconnectDurationMs = Math.max(0, Date.parse(reconnectObservedAt) - Date.parse(disconnectStartedAt));
    const reconnectPlan = await recordReplacementReconnectSample(stateDir, {
      at: reconnectObservedAt,
      kind: "macos-app",
      durationMs: reconnectDurationMs,
      outcome: rollbackSucceeded ? "rolled-back" : "failed",
    }).catch(() => receipt.reconnectPlan);
    return updateReceipt(stateDir, requestId, (value) => ({
      ...value,
      state: rollbackAttempted && rollbackSucceeded ? "APPLY_FAILED_ROLLED_BACK" : "APPLY_FAILED_ROLLBACK_FAILED",
      reconnectObservedAt,
      reconnectDurationMs,
      ...(reconnectPlan ? { reconnectPlan } : {}),
      failure: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      recommendedAction: rollbackSucceeded ? "inspect-candidate-app-and-runtime-handoff" : "restore-installed-app-locally",
    }));
  }
}

export function macosAppApplyPublicReceipt(receipt: MacosAppApplyReceipt): Record<string, unknown> {
  return {
    requestId: receipt.requestId,
    operationId: receipt.operationId,
    state: receipt.state,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    workerPid: receipt.workerPid ?? null,
    source: {
      bundleId: receipt.source.bundleId,
      teamIdentifier: receipt.source.teamIdentifier,
      authority: receipt.source.authority,
      designatedRequirementSha256: receipt.source.designatedRequirementSha256,
      mainExecutableSha256: receipt.source.mainExecutableSha256,
    },
    result: receipt.result,
    disconnectStartedAt: receipt.disconnectStartedAt ?? null,
    reconnectObservedAt: receipt.reconnectObservedAt ?? null,
    reconnectDurationMs: receipt.reconnectDurationMs ?? null,
    reconnectPlan: receipt.reconnectPlan ?? null,
    failure: receipt.failure,
    recommendedAction: receipt.recommendedAction,
  };
}
