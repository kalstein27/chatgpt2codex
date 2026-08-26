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
const TERMINAL_RETENTION_MS = 60 * 60 * 1_000;
const MAX_TERMINAL_OPERATIONS = 20;
const MAX_GLOBAL_ACTIVE = 2;
const MAX_PROJECT_ACTIVE = 1;

export type BackgroundOperationState =
  | "queued"
  | "spawning"
  | "running"
  | "cleanup"
  | "completed"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "interrupted-by-runtime-restart";

const ACTIVE_STATES = new Set<BackgroundOperationState>(["queued", "spawning", "running", "cleanup"]);

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
  state: z.enum([
    "queued",
    "spawning",
    "running",
    "cleanup",
    "completed",
    "failed",
    "timed-out",
    "cancelled",
    "interrupted-by-runtime-restart",
  ]),
  phase: z.string().min(1).max(40),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  lastHeartbeatAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
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
});

type OperationRecord = z.infer<typeof OperationRecordSchema>;

const StateSchema = z.object({
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  operations: z.array(OperationRecordSchema),
});

type OperationStateFile = z.infer<typeof StateSchema>;

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
  elapsedMs: number;
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
  execute: (
    operationId: string,
    signal: AbortSignal,
    update: (progress: BackgroundOperationProgress) => Promise<void>,
    registerTimeoutControl: (control: BackgroundOperationTimeoutControl) => void,
  ) => Promise<BackgroundOperationTerminal>;
}

interface ActiveTask {
  controller: AbortController;
  done: Promise<void>;
  timeoutControl?: BackgroundOperationTimeoutControl;
  timeoutPausedUntil?: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function statePath(stateDir: string): string {
  return path.join(stateDir, "background-operations.json");
}

function emptyState(): OperationStateFile {
  return { schemaVersion: STATE_SCHEMA_VERSION, operations: [] };
}

function isActive(record: OperationRecord): boolean {
  return ACTIVE_STATES.has(record.state);
}

function prune(state: OperationStateFile, now: number): void {
  const active = state.operations.filter(isActive);
  const terminal = state.operations
    .filter((record) => !isActive(record) && now - (record.finishedAt ?? record.lastHeartbeatAt) <= TERMINAL_RETENTION_MS)
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))
    .slice(0, MAX_TERMINAL_OPERATIONS);
  state.operations = [...active, ...terminal];
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
    elapsedMs: Math.max(0, (record.finishedAt ?? now) - (record.startedAt ?? record.createdAt)),
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
  private lock: Promise<void> = Promise.resolve();
  private initialized?: Promise<void>;

  constructor(private readonly stateDir: string) {}

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
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

  async initialize(now = Date.now()): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.withLock(async () => {
        const state = await this.readState();
        let changed = false;
        for (const record of state.operations) {
          if (!isActive(record)) continue;
          record.state = "interrupted-by-runtime-restart";
          record.phase = "interrupted";
          record.finishedAt = now;
          record.lastHeartbeatAt = now;
          record.subprocessStillRunning = false;
          record.subprocessStateUnknown = record.subprocessStarted;
          record.cleanupCompleted = false;
          record.errorCode = record.subprocessStarted
            ? "RUNTIME_RESTARTED_PROCESS_STATE_UNKNOWN"
            : "RUNTIME_RESTARTED";
          changed = true;
        }
        prune(state, now);
        if (changed || state.operations.length > 0) await this.writeState(state);
      });
    }
    await this.initialized;
  }

  async start(input: StartBackgroundOperationInput, now = Date.now()): Promise<BackgroundOperationSnapshot> {
    await this.initialize(now);
    const ownerDigest = digest(input.ownerScope);
    const projectRootDigest = digest(path.resolve(input.projectRoot));
    const record = await this.withLock(async () => {
      const state = await this.readState();
      prune(state, now);
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
        state: "queued",
        phase: "queued",
        createdAt: now,
        lastHeartbeatAt: now,
        subprocessStarted: false,
        subprocessStillRunning: false,
        cleanupStarted: false,
        cleanupCompleted: false,
        subprocessStateUnknown: false,
      };
      state.operations.push(created);
      await this.writeState(state);
      return created;
    });

    const controller = new AbortController();
    const task: ActiveTask = { controller, done: Promise.resolve() };
    this.tasks.set(record.operationId, task);
    const registerTimeoutControl = (control: BackgroundOperationTimeoutControl) => {
      task.timeoutControl = control;
      if (task.timeoutPausedUntil !== undefined) control.pauseUntil(task.timeoutPausedUntil);
    };
    const done = Promise.resolve().then(() => this.run(record.operationId, input.execute, controller, registerTimeoutControl));
    task.done = done;
    void done.finally(() => this.tasks.delete(record.operationId));
    return toSnapshot(record, now);
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
    });
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

  async status(binding: BackgroundOperationBinding & { operationId: string }, now = Date.now()): Promise<BackgroundOperationSnapshot> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      prune(state, now);
      const record = state.operations.find((candidate) => candidate.operationId === binding.operationId);
      if (!record) throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Background operation not found");
      this.assertBinding(record, binding);
      return toSnapshot(record, now);
    });
  }

  async active(binding: BackgroundOperationBinding, now = Date.now()): Promise<BackgroundOperationSnapshot[]> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      prune(state, now);
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

  /** Internal update gate only. Returns bounded safe snapshots across owners so
   * a runtime/app replacement cannot miss another session's active command. */
  async activeAll(now = Date.now()): Promise<BackgroundOperationSnapshot[]> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      prune(state, now);
      return state.operations.filter(isActive).map((record) => toSnapshot(record, now));
    });
  }

  /** Local-control UI only: bounded safe snapshots contain no owner/root
   * digests, lease IDs, fingerprints, argv, output, or environment values. */
  async recentForLocalUi(now = Date.now(), recentTerminalMs = 15_000): Promise<BackgroundOperationSnapshot[]> {
    await this.initialize(now);
    return this.withLock(async () => {
      const state = await this.readState();
      prune(state, now);
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
