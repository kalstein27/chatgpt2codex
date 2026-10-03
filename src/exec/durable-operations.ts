import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";

export const REMOTE_FAST_PATH_BUDGET_MS = 1_000;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HEARTBEAT_INTERVAL_MS = 1_000;
const LOST_WORKER_GRACE_MS = HEARTBEAT_INTERVAL_MS * 3;
const MAX_RESULT_BYTES = 1024 * 1024;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const MALFORMED_LOCK_STALE_MS = 5_000;
const OPERATION_ID = /^rop_[a-f0-9]{32}$/u;
const RESULT_REF = /^rop_result_[a-f0-9]{32}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;

export type DurableOperationState =
  | "queued"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "interrupted-by-runtime-restart";

const ACTIVE_STATES = new Set<DurableOperationState>(["queued", "running", "finalizing"]);

export type DurableOperationBinding =
  | {
      ownerScope: string;
      scope: "host";
    }
  | {
      ownerScope: string;
      scope: "project";
      projectId: string;
      projectRoot: string;
      laneDigest?: string;
    };

export interface DurableOperationSnapshot {
  operationId: string;
  scope: "host" | "project";
  kind: string;
  projectId?: string;
  state: DurableOperationState;
  phase: string;
  createdAt: number;
  startedAt?: number;
  lastHeartbeatAt: number;
  finishedAt?: number;
  elapsedMs: number;
  resultRef?: string;
  resultBytes?: number;
  errorCode?: string;
  coalescedReplay?: boolean;
  automaticRetrySafe: false;
  assistantMayFinalize: boolean;
  turnContinuationRequired: boolean;
  pollAfterMs?: number;
  recommendedAction: "poll-operation-status" | "read-result" | "inspect-failure";
}

export interface DurableOperationStartInput {
  binding: DurableOperationBinding;
  kind: string;
  requestIdentity: string;
  operationFingerprint: string;
  execute: (
    signal: AbortSignal,
    updatePhase: (phase: string) => Promise<void>,
  ) => Promise<unknown>;
}

export interface DurableOperationFastPathResult {
  inlineTerminal: boolean;
  snapshot: DurableOperationSnapshot;
  result?: unknown;
}

export interface DurableOperationAccessHint {
  operationId: string;
  scope: "host" | "project";
  projectId?: string;
  originalWorkLaneRequired: boolean;
}

export interface DurableOperationManagerOptions {
  runtimeGenerationId?: string;
  runtimePid?: number;
  lostWorkerGraceMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().regex(OPERATION_ID),
  ownerDigest: z.string().regex(FINGERPRINT),
  scope: z.enum(["host", "project"]),
  projectId: z.string().min(1).max(120).optional(),
  projectRootDigest: z.string().regex(FINGERPRINT).optional(),
  laneDigest: z.string().regex(FINGERPRINT).optional(),
  kind: z.string().min(1).max(160),
  requestDigest: z.string().regex(FINGERPRINT),
  operationFingerprint: z.string().regex(FINGERPRINT),
  state: z.enum([
    "queued",
    "running",
    "finalizing",
    "completed",
    "failed",
    "timed-out",
    "cancelled",
    "interrupted-by-runtime-restart",
  ]),
  phase: z.string().min(1).max(80),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  lastHeartbeatAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  resultRef: z.string().regex(RESULT_REF).optional(),
  resultBytes: z.number().int().nonnegative().optional(),
  errorCode: z.string().min(1).max(120).optional(),
  workerGenerationId: z.string().min(1).max(160),
  workerRuntimePid: z.number().int().positive(),
  automaticRetrySafe: z.literal(false),
});

type DurableOperationReceipt = z.infer<typeof ReceiptSchema>;

const OperationLockSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  acquiredAt: z.number().int().nonnegative(),
});

type OperationLockRecord = z.infer<typeof OperationLockSchema>;

interface ActiveTask {
  controller: AbortController;
  done: Promise<void>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultRuntimeGenerationId(): string {
  const configured = process.env.CHATGPT2CODEX_RUNTIME_GENERATION_ID?.trim();
  return configured || `runtime-pid-${process.pid}`;
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function operationsRoot(stateDir: string): string {
  return path.join(stateDir, "remote-operations");
}

function operationDir(stateDir: string, operationId: string): string {
  if (!OPERATION_ID.test(operationId)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid durable operation identifier");
  }
  return path.join(operationsRoot(stateDir), operationId);
}

function receiptPath(stateDir: string, operationId: string): string {
  return path.join(operationDir(stateDir, operationId), "receipt.json");
}

function resultPath(stateDir: string, operationId: string): string {
  return path.join(operationDir(stateDir, operationId), "result.json");
}

function lockPath(stateDir: string, operationId: string): string {
  return path.join(operationDir(stateDir, operationId), ".lock");
}

function assertKind(kind: string): void {
  if (!kind || kind.length > 160 || kind.includes("\0") || /[\u0000-\u001f\u007f]/u.test(kind)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid durable operation kind");
  }
}

function assertRequestIdentity(requestIdentity: string): void {
  if (!requestIdentity || requestIdentity.length > 1024 || requestIdentity.includes("\0")) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid durable operation request identity");
  }
}

function assertFingerprint(operationFingerprint: string): void {
  if (!FINGERPRINT.test(operationFingerprint)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid durable operation fingerprint");
  }
}

function normalizedBinding(binding: DurableOperationBinding): {
  ownerDigest: string;
  scope: "host" | "project";
  projectId?: string;
  projectRootDigest?: string;
  laneDigest?: string;
} {
  const ownerDigest = digest(binding.ownerScope);
  if (binding.scope === "host") return { ownerDigest, scope: "host" };
  if (!binding.projectId || binding.projectId.length > 120 || !path.isAbsolute(binding.projectRoot)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid project durable operation binding");
  }
  if (binding.laneDigest !== undefined && !FINGERPRINT.test(binding.laneDigest)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid durable operation lane binding");
  }
  return {
    ownerDigest,
    scope: "project",
    projectId: binding.projectId,
    projectRootDigest: digest(path.resolve(binding.projectRoot)),
    ...(binding.laneDigest ? { laneDigest: binding.laneDigest } : {}),
  };
}

function isActive(state: DurableOperationState): boolean {
  return ACTIVE_STATES.has(state);
}

function pollAfterMs(receipt: DurableOperationReceipt, now: number): number | undefined {
  if (!isActive(receipt.state)) return undefined;
  if (receipt.state === "queued" || receipt.state === "finalizing") return 100;
  const elapsed = Math.max(0, now - (receipt.startedAt ?? receipt.createdAt));
  if (elapsed < 5_000) return 250;
  if (elapsed < 30_000) return 500;
  return 1_000;
}

function snapshot(receipt: DurableOperationReceipt, now = Date.now()): DurableOperationSnapshot {
  const active = isActive(receipt.state);
  const recommendedAction: DurableOperationSnapshot["recommendedAction"] = active
    ? "poll-operation-status"
    : receipt.state === "completed" && receipt.resultRef
      ? "read-result"
      : "inspect-failure";
  return {
    operationId: receipt.operationId,
    scope: receipt.scope,
    kind: receipt.kind,
    ...(receipt.projectId ? { projectId: receipt.projectId } : {}),
    state: receipt.state,
    phase: receipt.phase,
    createdAt: receipt.createdAt,
    ...(receipt.startedAt !== undefined ? { startedAt: receipt.startedAt } : {}),
    lastHeartbeatAt: receipt.lastHeartbeatAt,
    ...(receipt.finishedAt !== undefined ? { finishedAt: receipt.finishedAt } : {}),
    elapsedMs: Math.max(0, (receipt.finishedAt ?? now) - (receipt.startedAt ?? receipt.createdAt)),
    ...(receipt.resultRef ? { resultRef: receipt.resultRef } : {}),
    ...(receipt.resultBytes !== undefined ? { resultBytes: receipt.resultBytes } : {}),
    ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
    automaticRetrySafe: false,
    assistantMayFinalize: !active,
    turnContinuationRequired: active,
    ...(active ? { pollAfterMs: pollAfterMs(receipt, now) } : {}),
    recommendedAction,
  };
}

export class DurableOperationManager {
  private readonly runtimeGenerationId: string;
  private readonly runtimePid: number;
  private readonly lostWorkerGraceMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly tasks = new Map<string, ActiveTask>();

  constructor(
    private readonly stateDir: string,
    options: DurableOperationManagerOptions = {},
  ) {
    this.runtimeGenerationId = options.runtimeGenerationId ?? defaultRuntimeGenerationId();
    this.runtimePid = options.runtimePid ?? process.pid;
    this.lostWorkerGraceMs = options.lostWorkerGraceMs ?? LOST_WORKER_GRACE_MS;
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    if (!path.isAbsolute(stateDir)) {
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Durable operation state directory must be absolute");
    }
    if (!Number.isInteger(this.runtimePid) || this.runtimePid <= 0) {
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid durable operation runtime pid");
    }
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(dir, DIR_MODE).catch(() => undefined);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, content, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      await fs.chmod(temp, FILE_MODE).catch(() => undefined);
      await fs.rename(temp, file);
      await fs.chmod(file, FILE_MODE).catch(() => undefined);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async persist(receipt: DurableOperationReceipt): Promise<void> {
    await this.atomicWrite(receiptPath(this.stateDir, receipt.operationId), `${JSON.stringify(ReceiptSchema.parse(receipt), null, 2)}\n`);
  }

  private async readReceipt(operationId: string): Promise<DurableOperationReceipt> {
    try {
      return ReceiptSchema.parse(JSON.parse(await fs.readFile(receiptPath(this.stateDir, operationId), "utf8")));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Durable operation not found");
      }
      throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Durable operation receipt is unavailable");
    }
  }

  private async waitForPreparedReceipt(operationId: string): Promise<DurableOperationReceipt> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return await this.readReceipt(operationId);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== ErrorCode.OPERATION_NOT_FOUND) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Durable operation preparation was interrupted");
  }

  private async clearStaleLock(operationId: string, now: number): Promise<boolean> {
    const file = lockPath(this.stateDir, operationId);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    let parsed: OperationLockRecord | undefined;
    try {
      const candidate = OperationLockSchema.safeParse(JSON.parse(raw || "null"));
      if (candidate.success) parsed = candidate.data;
    } catch {
      // A process can disappear between creating the lock file and writing metadata.
    }
    if (parsed) {
      if (defaultProcessAlive(parsed.pid)) return false;
      const confirmation = await fs.readFile(file, "utf8").catch(() => "");
      if (confirmation !== raw) return false;
      await fs.rm(file, { force: true });
      return true;
    }
    const info = await fs.stat(file).catch(() => undefined);
    if (!info || now - info.mtimeMs < MALFORMED_LOCK_STALE_MS) return false;
    const confirmation = await fs.readFile(file, "utf8").catch(() => "");
    if (confirmation !== raw) return false;
    await fs.rm(file, { force: true });
    return true;
  }

  private async acquireLock(operationId: string): Promise<string> {
    const file = lockPath(this.stateDir, operationId);
    const token = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(file, "wx", FILE_MODE);
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, token, acquiredAt: Date.now() })}\n`, "utf8");
        await handle.sync();
        await handle.close();
        return token;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.clearStaleLock(operationId, Date.now())) continue;
        if (Date.now() >= deadline) {
          throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Durable operation persistence lock timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  private async releaseLock(operationId: string, token: string): Promise<void> {
    const file = lockPath(this.stateDir, operationId);
    const raw = await fs.readFile(file, "utf8").catch(() => undefined);
    if (raw === undefined) return;
    let parsed: OperationLockRecord | undefined;
    try {
      const candidate = OperationLockSchema.safeParse(JSON.parse(raw || "null"));
      if (candidate.success) parsed = candidate.data;
    } catch {
      // Fail closed below when ownership cannot be proven.
    }
    if (!parsed || parsed.pid !== process.pid || parsed.token !== token) {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Durable operation persistence lock ownership changed unexpectedly");
    }
    await fs.unlink(file);
  }

  private async withLock<T>(operationId: string, run: () => Promise<T>): Promise<T> {
    const token = await this.acquireLock(operationId);
    try {
      return await run();
    } finally {
      await this.releaseLock(operationId, token);
    }
  }

  private assertBinding(receipt: DurableOperationReceipt, binding: DurableOperationBinding): void {
    const normalized = normalizedBinding(binding);
    if (
      receipt.ownerDigest !== normalized.ownerDigest
      || receipt.scope !== normalized.scope
      || receipt.projectId !== normalized.projectId
      || receipt.projectRootDigest !== normalized.projectRootDigest
      || receipt.laneDigest !== normalized.laneDigest
    ) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Durable operation does not belong to this owner/scope");
    }
  }

  private reconcileLostWorker(receipt: DurableOperationReceipt, now: number): boolean {
    if (!isActive(receipt.state)) return false;
    if (this.tasks.has(receipt.operationId)) return false;
    if (now - receipt.lastHeartbeatAt <= this.lostWorkerGraceMs) return false;
    if (this.isProcessAlive(receipt.workerRuntimePid)) return false;
    receipt.state = "interrupted-by-runtime-restart";
    receipt.phase = "worker-lost";
    receipt.finishedAt = now;
    receipt.lastHeartbeatAt = now;
    receipt.errorCode = "DURABLE_WORKER_PROCESS_LOST";
    return true;
  }

  private async readBoundReceipt(
    binding: DurableOperationBinding & { operationId: string },
    now = Date.now(),
  ): Promise<DurableOperationReceipt> {
    return this.withLock(binding.operationId, async () => {
      const receipt = await this.readReceipt(binding.operationId);
      this.assertBinding(receipt, binding);
      if (this.reconcileLostWorker(receipt, now)) await this.persist(receipt);
      return receipt;
    });
  }

  async accessHint(
    input: { ownerScope: string; operationId: string },
    now = Date.now(),
  ): Promise<DurableOperationAccessHint> {
    return this.withLock(input.operationId, async () => {
      const receipt = await this.readReceipt(input.operationId);
      if (receipt.ownerDigest !== digest(input.ownerScope)) {
        throw new DomainError(ErrorCode.PERMISSION_DENIED, "Durable operation does not belong to this owner");
      }
      if (this.reconcileLostWorker(receipt, now)) await this.persist(receipt);
      return {
        operationId: receipt.operationId,
        scope: receipt.scope,
        ...(receipt.projectId ? { projectId: receipt.projectId } : {}),
        originalWorkLaneRequired: Boolean(receipt.laneDigest),
      };
    });
  }

  async start(input: DurableOperationStartInput, now = Date.now()): Promise<DurableOperationSnapshot> {
    assertKind(input.kind);
    assertRequestIdentity(input.requestIdentity);
    assertFingerprint(input.operationFingerprint);
    const binding = normalizedBinding(input.binding);
    const requestDigest = digest(input.requestIdentity);
    const operationId = `rop_${digest(`${binding.ownerDigest}:${requestDigest}`).slice(0, 32)}`;
    const root = operationsRoot(this.stateDir);
    await fs.mkdir(root, { recursive: true, mode: DIR_MODE });
    await fs.chmod(root, DIR_MODE).catch(() => undefined);

    let preparedHere = false;
    try {
      await fs.mkdir(operationDir(this.stateDir, operationId), { mode: DIR_MODE });
      preparedHere = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (!preparedHere) {
      const existing = await this.waitForPreparedReceipt(operationId);
      this.assertBinding(existing, input.binding);
      if (
        existing.requestDigest !== requestDigest
        || existing.kind !== input.kind
        || existing.operationFingerprint !== input.operationFingerprint
      ) {
        throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Durable request identity was already used for different input");
      }
      const observed = await this.status({ ...input.binding, operationId }, now);
      return { ...observed, coalescedReplay: true };
    }

    const receipt: DurableOperationReceipt = {
      schemaVersion: 1,
      operationId,
      ownerDigest: binding.ownerDigest,
      scope: binding.scope,
      ...(binding.projectId ? { projectId: binding.projectId } : {}),
      ...(binding.projectRootDigest ? { projectRootDigest: binding.projectRootDigest } : {}),
      ...(binding.laneDigest ? { laneDigest: binding.laneDigest } : {}),
      kind: input.kind,
      requestDigest,
      operationFingerprint: input.operationFingerprint,
      state: "queued",
      phase: "queued",
      createdAt: now,
      lastHeartbeatAt: now,
      workerGenerationId: this.runtimeGenerationId,
      workerRuntimePid: this.runtimePid,
      automaticRetrySafe: false,
    };
    await this.persist(receipt);

    const controller = new AbortController();
    const task: ActiveTask = { controller, done: Promise.resolve() };
    this.tasks.set(operationId, task);
    const done = Promise.resolve().then(() => this.run(operationId, input.execute, controller));
    task.done = done;
    void done.finally(() => this.tasks.delete(operationId));
    return { ...snapshot(receipt, now), coalescedReplay: false };
  }

  async startWithFastPath(
    input: DurableOperationStartInput,
    budgetMs = REMOTE_FAST_PATH_BUDGET_MS,
  ): Promise<DurableOperationFastPathResult> {
    if (!Number.isInteger(budgetMs) || budgetMs < 0 || budgetMs > REMOTE_FAST_PATH_BUDGET_MS) {
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid durable operation fast-path budget");
    }
    const started = await this.start(input);
    const query = { ...input.binding, operationId: started.operationId } as DurableOperationBinding & { operationId: string };
    const terminal = isActive(started.state) && budgetMs > 0
      ? await this.waitForTerminal(query, budgetMs)
      : started;
    if (isActive(terminal.state)) return { inlineTerminal: false, snapshot: terminal };
    if (terminal.state === "completed" && terminal.resultRef) {
      return { inlineTerminal: true, snapshot: terminal, result: await this.result(query) };
    }
    return { inlineTerminal: true, snapshot: terminal };
  }

  private async run(
    operationId: string,
    execute: DurableOperationStartInput["execute"],
    controller: AbortController,
  ): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.heartbeat(operationId);
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    try {
      await this.markRunning(operationId, "running");
      const value = await execute(controller.signal, (phase) => this.updatePhase(operationId, phase));
      if (!(await this.markFinalizing(operationId))) return;
      const serialized = JSON.stringify(value === undefined ? null : value);
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_RESULT_BYTES) {
        throw new DomainError(ErrorCode.FILE_TOO_LARGE, "Durable operation result exceeds the sidecar limit");
      }
      await this.atomicWrite(resultPath(this.stateDir, operationId), `${serialized}\n`);
      await this.finish(operationId, "completed", {
        resultRef: `rop_result_${operationId.slice(4)}`,
        resultBytes: bytes,
      });
    } catch (error) {
      await this.finish(
        operationId,
        controller.signal.aborted ? "cancelled" : "failed",
        { errorCode: error instanceof DomainError ? error.code : "DURABLE_OPERATION_FAILED" },
      ).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async markRunning(operationId: string, phase: string): Promise<void> {
    await this.withLock(operationId, async () => {
      const receipt = await this.readReceipt(operationId);
      if (!isActive(receipt.state)) return;
      const now = Date.now();
      receipt.state = "running";
      receipt.phase = phase;
      receipt.startedAt ??= now;
      receipt.lastHeartbeatAt = now;
      await this.persist(receipt);
    });
  }

  private async updatePhase(operationId: string, phase: string): Promise<void> {
    if (!phase || phase.length > 80 || phase.includes("\0") || /[\u0000-\u001f\u007f]/u.test(phase)) {
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid durable operation phase");
    }
    await this.markRunning(operationId, phase);
  }

  private async heartbeat(operationId: string): Promise<void> {
    await this.withLock(operationId, async () => {
      const receipt = await this.readReceipt(operationId);
      if (!isActive(receipt.state)) return;
      receipt.lastHeartbeatAt = Date.now();
      await this.persist(receipt);
    }).catch(() => undefined);
  }

  private async markFinalizing(operationId: string): Promise<boolean> {
    return this.withLock(operationId, async () => {
      const receipt = await this.readReceipt(operationId);
      if (!isActive(receipt.state)) return false;
      receipt.state = "finalizing";
      receipt.phase = "serialize";
      receipt.lastHeartbeatAt = Date.now();
      await this.persist(receipt);
      return true;
    });
  }

  private async finish(
    operationId: string,
    state: Extract<DurableOperationState, "completed" | "failed" | "timed-out" | "cancelled">,
    extra: { resultRef?: string; resultBytes?: number; errorCode?: string } = {},
  ): Promise<void> {
    await this.withLock(operationId, async () => {
      const receipt = await this.readReceipt(operationId);
      if (!isActive(receipt.state)) return;
      const now = Date.now();
      receipt.state = state;
      receipt.phase = state === "completed" ? "completed" : state;
      receipt.finishedAt = now;
      receipt.lastHeartbeatAt = now;
      if (extra.resultRef) receipt.resultRef = extra.resultRef;
      if (extra.resultBytes !== undefined) receipt.resultBytes = extra.resultBytes;
      if (extra.errorCode) receipt.errorCode = extra.errorCode;
      await this.persist(receipt);
    });
  }

  async status(
    binding: DurableOperationBinding & { operationId: string },
    now = Date.now(),
  ): Promise<DurableOperationSnapshot> {
    return snapshot(await this.readBoundReceipt(binding, now), now);
  }

  async waitForTerminal(
    binding: DurableOperationBinding & { operationId: string },
    timeoutMs: number,
  ): Promise<DurableOperationSnapshot> {
    const initial = await this.status(binding);
    if (!isActive(initial.state) || timeoutMs <= 0) return initial;
    const task = this.tasks.get(binding.operationId);
    if (!task) return initial;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        task.done.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.status(binding);
  }

  async result(binding: DurableOperationBinding & { operationId: string }): Promise<unknown> {
    const receipt = await this.readBoundReceipt(binding);
    if (receipt.state !== "completed" || !receipt.resultRef || receipt.resultRef !== `rop_result_${receipt.operationId.slice(4)}`) {
      throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Durable operation has no completed result");
    }
    const file = resultPath(this.stateDir, receipt.operationId);
    const info = await fs.stat(file).catch(() => undefined);
    if (!info || !info.isFile() || info.size > MAX_RESULT_BYTES + 1) {
      throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Durable operation result is unavailable");
    }
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    } catch {
      throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Durable operation result is unreadable");
    }
  }

  async shutdown(): Promise<void> {
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.done));
  }
}

const managers = new Map<string, DurableOperationManager>();

export function durableOperationManager(stateDir: string): DurableOperationManager {
  const key = path.resolve(stateDir);
  let manager = managers.get(key);
  if (!manager) {
    manager = new DurableOperationManager(key);
    managers.set(key, manager);
  }
  return manager;
}
