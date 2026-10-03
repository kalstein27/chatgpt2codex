import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode, type LeasePreset } from "../types.js";
import type { ArtifactStatus, CleanupStatus, CommandStatus } from "./process-result.js";

const STATE_SCHEMA_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HEARTBEAT_INTERVAL_MS = 5_000;
const LOST_WORKER_GRACE_MS = HEARTBEAT_INTERVAL_MS * 3;
const TERMINAL_RETENTION_MS = 60 * 60 * 1_000;
const MAX_TERMINAL_OPERATIONS = 20;
const MAX_GLOBAL_ACTIVE = 2;
const MAX_PROJECT_ACTIVE = 1;
const CROSS_PROCESS_LOCK_RETRY_MS = 10;
const CROSS_PROCESS_LOCK_TIMEOUT_MS = 15_000;

export type BackgroundOperationState =
  | "approval-wait"
  | "queued"
  | "spawning"
  | "running"
  | "cleanup"
  | "completed"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "denied"
  | "expired"
  | "interrupted-by-runtime-restart";

const ACTIVE_STATES = new Set<BackgroundOperationState>(["approval-wait", "queued", "spawning", "running", "cleanup"]);

const OperationRecordSchema = z.object({
  operationId: z.string().regex(/^bg_[0-9a-f-]{36}$/u),
  ownerDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  laneDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  projectId: z.string().min(1).max(120),
  projectRootDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  leaseId: z.string().min(1).max(160),
  leasePreset: z.enum(["read-only", "tests-only", "full-write", "image-only", "control"]),
  commandId: z.string().min(1).max(240),
  operationFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  approvalRequestId: z.string().regex(/^op_[0-9a-f-]{36}$/u).optional(),
  approvalExpiresAt: z.number().int().nonnegative().optional(),
  state: z.enum([
    "approval-wait",
    "queued",
    "spawning",
    "running",
    "cleanup",
    "completed",
    "failed",
    "timed-out",
    "cancelled",
    "denied",
    "expired",
    "interrupted-by-runtime-restart",
  ]),
  phase: z.string().min(1).max(40),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  lastHeartbeatAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  actionStarted: z.boolean().default(false),
  subprocessStarted: z.boolean(),
  subprocessStillRunning: z.boolean(),
  cleanupStarted: z.boolean(),
  cleanupCompleted: z.boolean(),
  subprocessStateUnknown: z.boolean().optional(),
  commandStatus: z.enum(["SUCCESS", "NONZERO_EXIT", "SPAWN_FAILED", "TIMEOUT", "CANCELLED"]).optional(),
  exitCode: z.number().int().nullable().optional(),
  terminationSignal: z.string().nullable().optional(),
  cleanupStatus: z.enum(["NOT_REQUIRED", "COMPLETED", "FAILED"]).optional(),
  artifactStatus: z.enum(["NOT_REQUIRED", "CREATED", "TRUNCATED", "FAILED"]).optional(),
  domainStatus: z.string().max(80).nullable().optional(),
  domainStatusSource: z.enum(["caller-contract", "not-provided"]).optional(),
  outputRef: z.string().regex(/^out_[a-z0-9]+_[a-f0-9]{16}$/u).optional(),
  resourceUri: z.string().startsWith("chatgpt2codex://outputs/").optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  artifactTruncated: z.boolean().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  errorCode: z.string().min(1).max(80).optional(),
  workerGenerationId: z.string().min(1).max(160).optional(),
  workerRuntimePid: z.number().int().positive().optional(),
});

type OperationRecord = z.infer<typeof OperationRecordSchema>;

const StateSchema = z.object({
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  operations: z.array(OperationRecordSchema),
});

type OperationStateFile = z.infer<typeof StateSchema>;

const CrossProcessLockSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  acquiredAt: z.number().int().nonnegative(),
});

export interface BackgroundOperationTerminal {
  state: Extract<BackgroundOperationState, "completed" | "failed" | "timed-out" | "cancelled">;
  commandStatus: CommandStatus;
  exitCode: number | null;
  terminationSignal: string | null;
  cleanupStatus: CleanupStatus;
  artifactStatus: ArtifactStatus;
  domainStatus: string | null;
  domainStatusSource: "caller-contract" | "not-provided";
  outputRef?: string;
  resourceUri?: string;
  outputBytes?: number;
  artifactTruncated?: boolean;
  durationMs: number;
  errorCode?: string;
}

export interface BackgroundOperationProgress {
  state?: Extract<BackgroundOperationState, "spawning" | "running" | "cleanup">;
  phase?: "spawn" | "running" | "cleanup" | "serialize";
  subprocessStarted?: boolean;
  subprocessStillRunning?: boolean;
  cleanupStarted?: boolean;
  cleanupCompleted?: boolean;
}

export interface BackgroundOperationTimeoutControl {
  pauseUntil(untilMs: number): void;
}

export interface BackgroundOperationSnapshot {
  operationId: string;
  projectId: string;
  commandId: string;
  state: BackgroundOperationState;
  phase: string;
  createdAt: number;
  startedAt?: number;
  lastHeartbeatAt: number;
  finishedAt?: number;
  approvalExpiresAt?: number;
  elapsedMs: number;
  actionStarted: boolean;
  subprocessStarted: boolean;
  subprocessStillRunning: boolean;
  cleanupStarted: boolean;
  cleanupCompleted: boolean;
  subprocessStateUnknown?: boolean;
  commandStatus?: CommandStatus;
  exitCode?: number | null;
  terminationSignal?: string | null;
  cleanupStatus?: CleanupStatus;
  artifactStatus?: ArtifactStatus;
  domainStatus?: string | null;
  domainStatusSource?: "caller-contract" | "not-provided";
  outputRef?: string;
  resourceUri?: string;
  outputBytes?: number;
  artifactTruncated?: boolean;
  durationMs?: number;
  errorCode?: string;
  automaticRetrySafe: false;
  recommendedAction: "poll-operation-status" | "read-output" | "request-cancel-approval" | "inspect-failure";
}

export interface BackgroundOperationBinding {
  ownerScope: string;
  projectId: string;
  projectRoot: string;
  laneDigest?: string;
}

export interface StartBackgroundOperationInput extends BackgroundOperationBinding {
  leaseId: string;
  leasePreset: LeasePreset;
  commandId: string;
  operationFingerprint: string;
  requestDigest?: string;
  approvalRequestId?: string;
  execute: (
    operationId: string,
    signal: AbortSignal,
    update: (progress: BackgroundOperationProgress) => Promise<void>,
    registerTimeoutControl: (control: BackgroundOperationTimeoutControl) => void,
  ) => Promise<BackgroundOperationTerminal>;
  onTerminal?: (snapshot: BackgroundOperationSnapshot) => Promise<void> | void;
}

export interface PrepareBackgroundApprovalInput extends BackgroundOperationBinding {
  leaseId: string;
  leasePreset: LeasePreset;
  commandId: string;
  operationFingerprint: string;
  approvalRequestId: string;
  approvalExpiresAt?: number;
}

interface ActiveTask {
  controller: AbortController;
  done: Promise<void>;
  timeoutControl?: BackgroundOperationTimeoutControl;
  timeoutPausedUntil?: number;
}

export interface BackgroundOperationManagerOptions {
  runtimeGenerationId?: string;
  runtimePid?: number;
  lostWorkerGraceMs?: number;
  isProcessAlive?: (pid: number) => boolean;
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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function statePath(stateDir: string): string {
  return path.join(stateDir, "background-operations.json");
}

function crossProcessLockPath(stateDir: string): string {
  return path.join(stateDir, "background-operations.lock");
}

function crossProcessLockIdentity(raw: string, stat: { dev: number; ino: number; size: number; mtimeMs: number }): string {
  return digest(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${raw}`);
}

function crossProcessReclaimPath(lockFile: string, identity: string): string {
  return `${lockFile}.reclaim.${identity.slice(0, 32)}`;
}

function emptyState(): OperationStateFile {
  return { schemaVersion: STATE_SCHEMA_VERSION, operations: [] };
}

function isActive(record: OperationRecord): boolean {
  return ACTIVE_STATES.has(record.state);
}

function prune(state: OperationStateFile, now: number): boolean {
  let changed = false;
  const before = state.operations;
  for (const record of state.operations) {
    if (record.state !== "approval-wait" || record.approvalExpiresAt === undefined || record.approvalExpiresAt > now) continue;
    record.state = "expired";
    record.phase = "expired";
    record.finishedAt = now;
    record.lastHeartbeatAt = now;
    record.actionStarted = false;
    record.subprocessStarted = false;
    record.subprocessStillRunning = false;
    record.cleanupStarted = false;
    record.cleanupCompleted = true;
    record.subprocessStateUnknown = false;
    record.errorCode = "APPROVAL_EXPIRED";
    changed = true;
  }
  const active = state.operations.filter(isActive);
  const terminal = state.operations
    .filter((record) => !isActive(record) && now - (record.finishedAt ?? record.lastHeartbeatAt) <= TERMINAL_RETENTION_MS)
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))
    .slice(0, MAX_TERMINAL_OPERATIONS);
  const next = [...active, ...terminal];
  if (next.length !== before.length || next.some((record, index) => record !== before[index])) changed = true;
  state.operations = next;
  return changed;
}

function recommendedAction(record: OperationRecord): BackgroundOperationSnapshot["recommendedAction"] {
  if (isActive(record)) return "poll-operation-status";
  if (record.outputRef) return "read-output";
  if (record.state === "interrupted-by-runtime-restart" || record.state === "failed" || record.state === "timed-out") {
    return "inspect-failure";
  }
  return "request-cancel-approval";
}

function toSnapshot(record: OperationRecord, now = Date.now()): BackgroundOperationSnapshot {
  return {
    operationId: record.operationId,
    projectId: record.projectId,
    commandId: record.commandId,
    state: record.state,
    phase: record.phase,
    createdAt: record.createdAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    lastHeartbeatAt: record.lastHeartbeatAt,
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.approvalExpiresAt !== undefined ? { approvalExpiresAt: record.approvalExpiresAt } : {}),
    elapsedMs: Math.max(0, (record.finishedAt ?? now) - (record.startedAt ?? record.createdAt)),
    actionStarted: record.actionStarted,
    subprocessStarted: record.subprocessStarted,
    subprocessStillRunning: record.subprocessStillRunning,
    cleanupStarted: record.cleanupStarted,
    cleanupCompleted: record.cleanupCompleted,
    ...(record.subprocessStateUnknown !== undefined ? { subprocessStateUnknown: record.subprocessStateUnknown } : {}),
    ...(record.commandStatus !== undefined ? { commandStatus: record.commandStatus } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.terminationSignal !== undefined ? { terminationSignal: record.terminationSignal } : {}),
    ...(record.cleanupStatus !== undefined ? { cleanupStatus: record.cleanupStatus } : {}),
    ...(record.artifactStatus !== undefined ? { artifactStatus: record.artifactStatus } : {}),
    ...(record.domainStatus !== undefined ? { domainStatus: record.domainStatus } : {}),
    ...(record.domainStatusSource !== undefined ? { domainStatusSource: record.domainStatusSource } : {}),
    ...(record.outputRef !== undefined ? { outputRef: record.outputRef } : {}),
    ...(record.resourceUri !== undefined ? { resourceUri: record.resourceUri } : {}),
    ...(record.outputBytes !== undefined ? { outputBytes: record.outputBytes } : {}),
    ...(record.artifactTruncated !== undefined ? { artifactTruncated: record.artifactTruncated } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
    automaticRetrySafe: false,
    recommendedAction: recommendedAction(record),
  };
}

export class BackgroundOperationManager {
  private readonly tasks = new Map<string, ActiveTask>();
  private readonly terminalCallbacks = new Map<string, NonNullable<StartBackgroundOperationInput["onTerminal"]>>();
  private lock: Promise<void> = Promise.resolve();
  private initialized?: Promise<void>;
  private readonly runtimeGenerationId: string;
  private readonly runtimePid: number;
  private readonly lostWorkerGraceMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(private readonly stateDir: string, options: BackgroundOperationManagerOptions = {}) {
    this.runtimeGenerationId = options.runtimeGenerationId ?? defaultRuntimeGenerationId();
    this.runtimePid = options.runtimePid ?? process.pid;
    this.lostWorkerGraceMs = options.lostWorkerGraceMs ?? LOST_WORKER_GRACE_MS;
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  }

  private async clearStaleFileLock(lockFile: string, now: number): Promise<boolean> {
    let raw: string;
    try {
      raw = await fs.readFile(lockFile, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    let lockRecord: z.infer<typeof CrossProcessLockSchema> | undefined;
    try {
      const parsed = CrossProcessLockSchema.safeParse(JSON.parse(raw || "null"));
      if (parsed.success) lockRecord = parsed.data;
    } catch {
      // A creator can die between O_EXCL creation and writing metadata.
    }
    const observedStat = await fs.stat(lockFile).catch(() => undefined);
    if (!observedStat) return true;
    if (!lockRecord) {
      // Ownership/liveness cannot be proven from malformed metadata. Never
      // reclaim solely because the path is old: an older live runtime may be
      // stalled between creating the canonical lock and publishing metadata.
      // New runtimes publish complete metadata before linking the canonical
      // path, so malformed canonical locks require explicit/manual recovery.
      return false;
    }
    if (defaultProcessAlive(lockRecord.pid)) return false;

    const identity = crossProcessLockIdentity(raw, observedStat);
    const reclaimPath = crossProcessReclaimPath(lockFile, identity);
    try {
      await fs.mkdir(reclaimPath, { mode: DIR_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }

    const quarantine = `${lockFile}.stale.${process.pid}.${randomUUID()}`;
    try {
      const [currentRaw, currentStat] = await Promise.all([
        fs.readFile(lockFile, "utf8").catch(() => undefined),
        fs.stat(lockFile).catch(() => undefined),
      ]);
      if (currentRaw === undefined || !currentStat) return true;
      if (crossProcessLockIdentity(currentRaw, currentStat) !== identity) return false;

      let currentRecord: z.infer<typeof CrossProcessLockSchema> | undefined;
      try {
        const parsed = CrossProcessLockSchema.safeParse(JSON.parse(currentRaw || "null"));
        if (parsed.success) currentRecord = parsed.data;
      } catch {
        // Malformed ownership remains fail-closed because liveness is unknown.
      }
      if (!currentRecord) return false;
      if (defaultProcessAlive(currentRecord.pid)) return false;

      // Never unlink the canonical path after stale authorization. The rename
      // transfers the exact revalidated stale identity to a unique quarantine
      // while the identity-scoped reclaim guard serializes competing cleaners.
      // A later cleaner must revalidate the canonical path after the guard and
      // therefore cannot delete a successor owner's replacement lock.
      await fs.rename(lockFile, quarantine);
      await fs.unlink(quarantine).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    } finally {
      await fs.rm(reclaimPath, { recursive: true, force: true }).catch(() => undefined);
      await fs.unlink(quarantine).catch(() => undefined);
    }
  }

  private async tryCreateCrossProcessLock(lockFile: string, token: string): Promise<boolean> {
    const candidate = `${lockFile}.candidate.${process.pid}.${token}`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(candidate, "wx", FILE_MODE);
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token, acquiredAt: Date.now() })}\n`,
        "utf8",
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.link(candidate, lockFile);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(candidate).catch(() => undefined);
    }
  }

  private async acquireCrossProcessLock(): Promise<string> {
    await fs.mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(this.stateDir, DIR_MODE).catch(() => undefined);
    const lockFile = crossProcessLockPath(this.stateDir);
    const token = randomUUID();
    const deadline = Date.now() + CROSS_PROCESS_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        if (await this.tryCreateCrossProcessLock(lockFile, token)) return token;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
      if (await this.clearStaleFileLock(lockFile, Date.now())) continue;
      if (Date.now() >= deadline) {
        throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Background operation persistence lock timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, CROSS_PROCESS_LOCK_RETRY_MS));
    }
  }

  private async releaseCrossProcessLock(token: string): Promise<void> {
    const lockFile = crossProcessLockPath(this.stateDir);
    const raw = await fs.readFile(lockFile, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw === undefined) return;
    let lockRecord: z.infer<typeof CrossProcessLockSchema> | undefined;
    try {
      const parsed = CrossProcessLockSchema.safeParse(JSON.parse(raw || "null"));
      if (parsed.success) lockRecord = parsed.data;
    } catch {
      // Treat malformed ownership metadata as a fail-closed release failure.
    }
    if (!lockRecord || lockRecord.pid !== process.pid || lockRecord.token !== token) {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Background operation persistence lock ownership changed unexpectedly");
    }
    await fs.unlink(lockFile);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let crossProcessToken: string | undefined;
    try {
      crossProcessToken = await this.acquireCrossProcessLock();
      return await operation();
    } finally {
      try {
        if (crossProcessToken) await this.releaseCrossProcessLock(crossProcessToken);
      } finally {
        release();
      }
    }
  }

  private async readState(): Promise<OperationStateFile> {
    try {
      const raw = await fs.readFile(statePath(this.stateDir), "utf8");
      const parsed = StateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Background operation state failed validation");
      }
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      if (error instanceof DomainError) throw error;
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Background operation state could not be read");
    }
  }

  private async writeState(state: OperationStateFile): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(this.stateDir, DIR_MODE).catch(() => undefined);
    const destination = statePath(this.stateDir);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(StateSchema.parse(state), null, 2)}\n`, {
      mode: FILE_MODE,
      flag: "wx",
    });
    await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
    try {
      await fs.rename(temporary, destination);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private reconcileLostWorkers(state: OperationStateFile, now: number): boolean {
    let changed = false;
    for (const record of state.operations) {
      if (!isActive(record) || record.state === "approval-wait" || !record.actionStarted) continue;
      if (this.tasks.has(record.operationId)) continue;
      if (now - record.lastHeartbeatAt <= this.lostWorkerGraceMs) continue;
      if (record.workerRuntimePid !== undefined && this.isProcessAlive(record.workerRuntimePid)) continue;

      record.state = "interrupted-by-runtime-restart";
      record.phase = "worker-lost";
      record.finishedAt = now;
      record.lastHeartbeatAt = now;
      record.subprocessStillRunning = false;
      record.subprocessStateUnknown = record.subprocessStarted;
      record.cleanupCompleted = false;
      record.errorCode = record.workerRuntimePid === undefined
        ? "BACKGROUND_WORKER_OWNERSHIP_UNKNOWN"
        : "BACKGROUND_WORKER_PROCESS_LOST";
      changed = true;
    }
    return changed;
  }

  async initialize(now = Date.now()): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.withLock(async () => {
        const state = await this.readState();
        const changed = this.reconcileLostWorkers(state, now);
        const pruned = prune(state, now);
        if (changed || pruned) await this.writeState(state);
      });
    }
    await this.initialized;
  }

  async start(input: StartBackgroundOperationInput, now = Date.now()): Promise<BackgroundOperationSnapshot> {
    await this.initialize(now);
    const ownerDigest = digest(input.ownerScope);
    const projectRootDigest = digest(path.resolve(input.projectRoot));
    const transition = await this.withLock(async () => {
      const state = await this.readState();
      const reconciled = this.reconcileLostWorkers(state, now);
      const pruned = prune(state, now);
      if (input.requestDigest) {
        const existing = state.operations.find((candidate) => candidate.requestDigest === input.requestDigest);
        if (existing) {
          this.assertOwnerProjectBinding(existing, input);
          if (existing.commandId !== input.commandId || existing.operationFingerprint !== input.operationFingerprint) {
            throw new DomainError(
              ErrorCode.PERMISSION_DENIED,
              "Background request identity no longer matches the original command",
            );
          }
          if (reconciled || pruned) await this.writeState(state);
          return { record: existing, shouldStart: false };
        }
      }
      const active = state.operations.filter(isActive);
      if (active.length >= MAX_GLOBAL_ACTIVE || active.some((candidate) => candidate.projectId === input.projectId)) {
        throw new DomainError(ErrorCode.QUOTA_EXCEEDED, "Background command concurrency limit reached", {
          globalActive: active.length,
          maxGlobalActive: MAX_GLOBAL_ACTIVE,
          projectActive: active.filter((candidate) => candidate.projectId === input.projectId).length,
          maxProjectActive: MAX_PROJECT_ACTIVE,
        });
      }
      const created: OperationRecord = {
        operationId: `bg_${randomUUID()}`,
        ownerDigest,
        ...(input.laneDigest ? { laneDigest: input.laneDigest } : {}),
        projectId: input.projectId,
        projectRootDigest,
        leaseId: input.leaseId,
        leasePreset: input.leasePreset,
        commandId: input.commandId,
        operationFingerprint: input.operationFingerprint,
        ...(input.requestDigest ? { requestDigest: input.requestDigest } : {}),
        ...(input.approvalRequestId ? { approvalRequestId: input.approvalRequestId } : {}),
        state: "queued",
        phase: "queued",
        createdAt: now,
        lastHeartbeatAt: now,
        actionStarted: true,
        subprocessStarted: false,
        subprocessStillRunning: false,
        cleanupStarted: false,
        cleanupCompleted: false,
        subprocessStateUnknown: false,
        workerGenerationId: this.runtimeGenerationId,
        workerRuntimePid: this.runtimePid,
      };
      state.operations.push(created);
      await this.writeState(state);
      return { record: created, shouldStart: true };
    });

    if (!transition.shouldStart) return toSnapshot(transition.record, now);
    const record = transition.record;

    const controller = new AbortController();
    const task: ActiveTask = { controller, done: Promise.resolve() };
    this.tasks.set(record.operationId, task);
    if (input.onTerminal) this.terminalCallbacks.set(record.operationId, input.onTerminal);
    const registerTimeoutControl = (control: BackgroundOperationTimeoutControl) => {
      task.timeoutControl = control;
      if (task.timeoutPausedUntil !== undefined) control.pauseUntil(task.timeoutPausedUntil);
    };
    const done = Promise.resolve().then(() => this.run(record.operationId, input.execute, controller, registerTimeoutControl));
    task.done = done;
    void done.finally(() => this.tasks.delete(record.operationId));
    return toSnapshot(record, now);
  }

  async waitForTerminal(
    binding: BackgroundOperationBinding & { operationId: string },
    timeoutMs: number,
    now = Date.now(),
  ): Promise<BackgroundOperationSnapshot> {
    const initial = await this.status(binding, now);
    if (!ACTIVE_STATES.has(initial.state) || timeoutMs <= 0) return initial;
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

  async prepareApprovalWait(input: PrepareBackgroundApprovalInput, now = Date.now()): Promise<BackgroundOperationSnapshot> {
    await this.initialize(now);
    const ownerDigest = digest(input.ownerScope);
    const projectRootDigest = digest(path.resolve(input.projectRoot));
    return this.withLock(async () => {
      const state = await this.readState();
      const reconciled = this.reconcileLostWorkers(state, now);
      const pruned = prune(state, now);
      const existing = state.operations.find((candidate) => candidate.approvalRequestId === input.approvalRequestId);
      if (existing) {
        this.assertOwnerProjectBinding(existing, input);
        if (existing.commandId !== input.commandId || existing.operationFingerprint !== input.operationFingerprint) {
          throw new DomainError(ErrorCode.PERMISSION_DENIED, "Approval-bound operation no longer matches the exact captured command");
        }
        if (reconciled || pruned) await this.writeState(state);
        return toSnapshot(existing, now);
      }
      const active = state.operations.filter(isActive);
      if (active.length >= MAX_GLOBAL_ACTIVE || active.some((candidate) => candidate.projectId === input.projectId)) {
        throw new DomainError(ErrorCode.QUOTA_EXCEEDED, "Background command concurrency limit reached", {
          globalActive: active.length,
          maxGlobalActive: MAX_GLOBAL_ACTIVE,
          projectActive: active.filter((candidate) => candidate.projectId === input.projectId).length,
          maxProjectActive: MAX_PROJECT_ACTIVE,
        });
      }
      const created: OperationRecord = {
        operationId: `bg_${randomUUID()}`,
        ownerDigest,
        ...(input.laneDigest ? { laneDigest: input.laneDigest } : {}),
        projectId: input.projectId,
        projectRootDigest,
        leaseId: input.leaseId,
        leasePreset: input.leasePreset,
        commandId: input.commandId,
        operationFingerprint: input.operationFingerprint,
        approvalRequestId: input.approvalRequestId,
        ...(input.approvalExpiresAt !== undefined ? { approvalExpiresAt: input.approvalExpiresAt } : {}),
        state: "approval-wait",
        phase: "approval",
        createdAt: now,
        lastHeartbeatAt: now,
        actionStarted: false,
        subprocessStarted: false,
        subprocessStillRunning: false,
        cleanupStarted: false,
        cleanupCompleted: false,
        subprocessStateUnknown: false,
      };
      state.operations.push(created);
      await this.writeState(state);
      return toSnapshot(created, now);
    });
  }

  async resumeApprovalWait(
    input: PrepareBackgroundApprovalInput & Pick<StartBackgroundOperationInput, "execute" | "onTerminal">,
    now = Date.now(),
  ): Promise<BackgroundOperationSnapshot> {
    await this.initialize(now);
    const transition = await this.withLock(async () => {
      const state = await this.readState();
      prune(state, now);
      const record = state.operations.find((candidate) => candidate.approvalRequestId === input.approvalRequestId);
      if (!record) throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Background operation not found for approval request");
      this.assertOwnerProjectBinding(record, input);
      if (record.commandId !== input.commandId || record.operationFingerprint !== input.operationFingerprint) {
        throw new DomainError(ErrorCode.PERMISSION_DENIED, "Approval-bound operation no longer matches the exact captured command");
      }
      if (record.state !== "approval-wait") {
        return { record, shouldStart: false };
      }
      record.state = "queued";
      record.phase = "queued";
      record.actionStarted = true;
      record.lastHeartbeatAt = now;
      record.workerGenerationId = this.runtimeGenerationId;
      record.workerRuntimePid = this.runtimePid;
      await this.writeState(state);
      return { record, shouldStart: true };
    });

    if (!transition.shouldStart) return toSnapshot(transition.record, now);
    const controller = new AbortController();
    const task: ActiveTask = { controller, done: Promise.resolve() };
    this.tasks.set(transition.record.operationId, task);
    if (input.onTerminal) this.terminalCallbacks.set(transition.record.operationId, input.onTerminal);
    const registerTimeoutControl = (control: { pauseUntil(untilMs: number): void }) => {
      task.timeoutControl = control;
      if (task.timeoutPausedUntil !== undefined) control.pauseUntil(task.timeoutPausedUntil);
    };
    const done = Promise.resolve().then(() => this.run(
      transition.record.operationId,
      input.execute,
      controller,
      registerTimeoutControl,
    ));
    task.done = done;
    void done.finally(() => this.tasks.delete(transition.record.operationId));
    return toSnapshot(transition.record, now);
  }

  async resolveApprovalWait(
    binding: Omit<BackgroundOperationBinding, "laneDigest"> & { approvalRequestId: string },
    outcome: "denied" | "expired" | "failed",
    now = Date.now(),
    errorCode?: string,
  ): Promise<BackgroundOperationSnapshot> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      prune(state, now);
      const record = state.operations.find((candidate) => candidate.approvalRequestId === binding.approvalRequestId);
      if (!record) throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Background operation not found for approval request");
      this.assertOwnerProjectBinding(record, binding);
      if (record.state !== "approval-wait") return toSnapshot(record, now);
      record.state = outcome;
      record.phase = outcome;
      record.finishedAt = now;
      record.lastHeartbeatAt = now;
      record.actionStarted = false;
      record.subprocessStarted = false;
      record.subprocessStillRunning = false;
      record.cleanupStarted = false;
      record.cleanupCompleted = true;
      record.subprocessStateUnknown = false;
      record.errorCode = errorCode ?? (outcome === "denied"
        ? "APPROVAL_DENIED"
        : outcome === "expired"
          ? "APPROVAL_EXPIRED"
          : "TURNLESS_CONTINUATION_FAILED");
      prune(state, now);
      await this.writeState(state);
      return toSnapshot(record, now);
    });
  }

  private async run(
    operationId: string,
    execute: StartBackgroundOperationInput["execute"],
    controller: AbortController,
    registerTimeoutControl: (control: BackgroundOperationTimeoutControl) => void,
  ): Promise<void> {
    const update = (progress: BackgroundOperationProgress) => this.update(operationId, progress);
    const heartbeat = setInterval(() => {
      void this.heartbeat(operationId);
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    try {
      await update({ state: "spawning", phase: "spawn" });
      const terminal = await execute(operationId, controller.signal, update, registerTimeoutControl);
      await this.finish(operationId, terminal);
    } catch {
      await this.finish(operationId, {
        state: controller.signal.aborted ? "cancelled" : "failed",
        commandStatus: controller.signal.aborted ? "CANCELLED" : "SPAWN_FAILED",
        exitCode: null,
        terminationSignal: controller.signal.aborted && process.platform !== "win32" ? "SIGKILL" : null,
        cleanupStatus: controller.signal.aborted ? "COMPLETED" : "NOT_REQUIRED",
        artifactStatus: "FAILED",
        domainStatus: null,
        domainStatusSource: "not-provided",
        durationMs: 0,
        errorCode: controller.signal.aborted ? "CANCELLED" : "BACKGROUND_EXECUTION_FAILED",
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async update(operationId: string, progress: BackgroundOperationProgress): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState();
      const record = state.operations.find((candidate) => candidate.operationId === operationId);
      if (!record || !isActive(record)) return;
      const now = Date.now();
      if (progress.state) record.state = progress.state;
      if (progress.phase) record.phase = progress.phase;
      if (progress.state === "running" && record.startedAt === undefined) record.startedAt = now;
      if (progress.subprocessStarted !== undefined) record.subprocessStarted = progress.subprocessStarted;
      if (progress.subprocessStillRunning !== undefined) record.subprocessStillRunning = progress.subprocessStillRunning;
      if (progress.cleanupStarted !== undefined) record.cleanupStarted = progress.cleanupStarted;
      if (progress.cleanupCompleted !== undefined) record.cleanupCompleted = progress.cleanupCompleted;
      if (progress.subprocessStillRunning !== undefined) record.subprocessStateUnknown = false;
      record.lastHeartbeatAt = now;
      await this.writeState(state);
    });
  }

  private async heartbeat(operationId: string): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState();
      const record = state.operations.find((candidate) => candidate.operationId === operationId);
      if (!record || !isActive(record)) return;
      record.lastHeartbeatAt = Date.now();
      await this.writeState(state);
    });
  }

  private async finish(operationId: string, terminal: BackgroundOperationTerminal): Promise<void> {
    let terminalSnapshot: BackgroundOperationSnapshot | undefined;
    await this.withLock(async () => {
      const state = await this.readState();
      const record = state.operations.find((candidate) => candidate.operationId === operationId);
      if (!record || !isActive(record)) return;
      const now = Date.now();
      Object.assign(record, terminal, {
        phase: "completed",
        finishedAt: now,
        lastHeartbeatAt: now,
        subprocessStillRunning: false,
        subprocessStateUnknown: false,
      });
      prune(state, now);
      await this.writeState(state);
      terminalSnapshot = toSnapshot(record, now);
    });
    const callback = this.terminalCallbacks.get(operationId);
    this.terminalCallbacks.delete(operationId);
    if (terminalSnapshot && callback) {
      await Promise.resolve(callback(terminalSnapshot)).catch(() => undefined);
    }
  }

  private assertBinding(record: OperationRecord, binding: BackgroundOperationBinding): void {
    if (
      record.ownerDigest !== digest(binding.ownerScope)
      || record.laneDigest !== binding.laneDigest
      || record.projectId !== binding.projectId
      || record.projectRootDigest !== digest(path.resolve(binding.projectRoot))
    ) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Background operation does not belong to this owner/project");
    }
  }

  private assertOwnerProjectBinding(record: OperationRecord, binding: Omit<BackgroundOperationBinding, "laneDigest">): void {
    if (
      record.ownerDigest !== digest(binding.ownerScope)
      || record.projectId !== binding.projectId
      || record.projectRootDigest !== digest(path.resolve(binding.projectRoot))
    ) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Background operation does not belong to this owner/project");
    }
  }

  async status(binding: BackgroundOperationBinding & { operationId: string }, now = Date.now()): Promise<BackgroundOperationSnapshot> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      const reconciled = this.reconcileLostWorkers(state, now);
      const pruned = prune(state, now);
      const record = state.operations.find((candidate) => candidate.operationId === binding.operationId);
      if (!record) {
        if (pruned || reconciled) await this.writeState(state);
        throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Background operation not found");
      }
      this.assertBinding(record, binding);
      if (pruned || reconciled) await this.writeState(state);
      return toSnapshot(record, now);
    });
  }

  async statusByApproval(
    binding: Omit<BackgroundOperationBinding, "laneDigest"> & { approvalRequestId: string },
    now = Date.now(),
  ): Promise<BackgroundOperationSnapshot> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      const reconciled = this.reconcileLostWorkers(state, now);
      const pruned = prune(state, now);
      const record = state.operations.find((candidate) => candidate.approvalRequestId === binding.approvalRequestId);
      if (!record) {
        if (pruned || reconciled) await this.writeState(state);
        throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Background operation not found for approval request");
      }
      this.assertOwnerProjectBinding(record, binding);
      if (pruned || reconciled) await this.writeState(state);
      return toSnapshot(record, now);
    });
  }

  async active(binding: BackgroundOperationBinding, now = Date.now()): Promise<BackgroundOperationSnapshot[]> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      const changed = this.reconcileLostWorkers(state, now);
      const pruned = prune(state, now);
      if (changed || pruned) await this.writeState(state);
      return state.operations
        .filter(isActive)
        .filter((record) => {
          try {
            this.assertBinding(record, binding);
            return true;
          } catch {
            return false;
          }
        })
        .map((record) => toSnapshot(record, now));
    });
  }

  async activeForOwnerProject(
    binding: Omit<BackgroundOperationBinding, "laneDigest">,
    now = Date.now(),
  ): Promise<BackgroundOperationSnapshot[]> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      const changed = this.reconcileLostWorkers(state, now);
      const pruned = prune(state, now);
      if (changed || pruned) await this.writeState(state);
      return state.operations
        .filter(isActive)
        .filter((record) => {
          try {
            this.assertOwnerProjectBinding(record, binding);
            return true;
          } catch {
            return false;
          }
        })
        .map((record) => toSnapshot(record, now));
    });
  }

  /** Internal update gate only. Returns bounded safe snapshots across owners so
   * a runtime/app replacement cannot miss another session's active command. */
  async activeAll(now = Date.now()): Promise<BackgroundOperationSnapshot[]> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      const changed = this.reconcileLostWorkers(state, now);
      const pruned = prune(state, now);
      if (changed || pruned) await this.writeState(state);
      return state.operations.filter(isActive).map((record) => toSnapshot(record, now));
    });
  }

  /** Local-control UI only: bounded safe snapshots contain no owner/root
   * digests, lease IDs, fingerprints, argv, output, or environment values. */
  async recentForLocalUi(now = Date.now(), recentTerminalMs = 15_000): Promise<BackgroundOperationSnapshot[]> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      const changed = this.reconcileLostWorkers(state, now);
      const pruned = prune(state, now);
      if (changed || pruned) await this.writeState(state);
      return state.operations
        .filter((record) => isActive(record) || now - (record.finishedAt ?? 0) <= recentTerminalMs)
        .map((record) => toSnapshot(record, now));
    });
  }

  async cancel(binding: BackgroundOperationBinding & { operationId: string }): Promise<BackgroundOperationSnapshot> {
    const snapshot = await this.status(binding);
    if (!ACTIVE_STATES.has(snapshot.state)) return snapshot;
    const task = this.tasks.get(binding.operationId);
    if (!task) {
      throw new DomainError(ErrorCode.OPERATION_NOT_ACTIVE, "Background operation is not owned by this runtime");
    }
    await this.update(binding.operationId, {
      state: "cleanup",
      phase: "cleanup",
      cleanupStarted: true,
    });
    task.controller.abort();
    return this.status(binding);
  }

  async pauseTimeoutUntil(
    binding: BackgroundOperationBinding & { operationId: string },
    untilMs: number,
  ): Promise<BackgroundOperationSnapshot> {
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Background timeout hold must use a future timestamp");
    }
    const snapshot = await this.status(binding);
    if (!ACTIVE_STATES.has(snapshot.state)) return snapshot;
    const task = this.tasks.get(binding.operationId);
    if (!task) {
      throw new DomainError(ErrorCode.OPERATION_NOT_ACTIVE, "Background operation is not owned by this runtime");
    }
    // The first approval request fixes the bounded hold deadline. Repeated
    // polling of the same pending request must never extend process lifetime.
    task.timeoutPausedUntil ??= Math.floor(untilMs);
    task.timeoutControl?.pauseUntil(task.timeoutPausedUntil);
    return this.status(binding);
  }

  async shutdown(): Promise<void> {
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.done));
  }
}

const managers = new Map<string, BackgroundOperationManager>();

export function backgroundOperationManager(stateDir: string): BackgroundOperationManager {
  const key = path.resolve(stateDir);
  let manager = managers.get(key);
  if (!manager) {
    manager = new BackgroundOperationManager(key);
    managers.set(key, manager);
  }
  return manager;
}
