import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";

/** Persistent state for a bounded GPT scheduled-cycle goal.
 *
 * This module deliberately has no worker, MCP, scheduler, or runtime imports.
 * `stateRoot` is injected so callers and tests cannot accidentally write the
 * operator's home directory or a live runtime state tree.
 */

const MAX_OBJECTIVE = 2_000;
const MAX_CONSTRAINT = 512;
const MAX_LIST = 32;
const MAX_REF = 512;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_MS = 7 * 24 * 60 * 60 * 1_000;
const GOAL_ID_RE = /^goal_[A-Za-z0-9-]{16,80}$/;
const REF_RE = /^[A-Za-z0-9._:/-]+$/;
const SAFE_TEXT_RE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

export const AGENT_GOAL_STATES = [
  "READY", "WORKER_RUNNING", "REVIEW_READY", "WAITING_USER", "PAUSED", "COMPLETED", "FAILED",
] as const;
export type AgentGoalState = (typeof AGENT_GOAL_STATES)[number];
export type WorkerStatus = "IDLE" | "RUNNING" | "COMPLETED" | "FAILED" | "UNKNOWN";
export type GoalReviewDecision = "continue" | "complete" | "waiting-user" | "pause" | "fail";

export interface CycleClaim {
  ownerRunId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface AgentGoal {
  goalId: string;
  objective: string;
  stopConditions: string[];
  constraints: string[];
  state: AgentGoalState;
  cycle: number;
  currentMilestone: string | null;
  workerOperationId: string | null;
  workerStatus: WorkerStatus;
  lastResultRef: string | null;
  noProgressCount: number;
  createdAt: number;
  updatedAt: number;
  cycleClaim: CycleClaim | null;
  projectId: string;
  projectRootDigest: string;
  authorization: GoalAuthorization;
  requestDigest: string;
  definitionDigest: string;
}

export interface GoalAuthorization {
  policyVersion: 1;
  approvalRequestId: string;
  authorizedAt: number;
  expiresAt: number;
  maxCycles: number;
  maxNoProgress: number;
}

export interface AgentGoalCreateInput {
  requestId: string;
  objective: string;
  stopConditions: string[];
  constraints?: string[];
  currentMilestone?: string | null;
  projectId: string;
  projectRootDigest: string;
  authorization: GoalAuthorization;
}

export interface CompactAgentGoalStatus {
  goalId: string;
  state: AgentGoalState;
  cycle: number;
  currentMilestone: string | null;
  workerOperationId: string | null;
  workerStatus: WorkerStatus;
  lastResultRef: string | null;
  noProgressCount: number;
  updatedAt: number;
  cycleClaimed: boolean;
  projectId: string;
  expiresAt: number;
  maxCycles: number;
  maxNoProgress: number;
}

const CycleClaimSchema = z.object({
  ownerRunId: z.string().min(1).max(160).regex(REF_RE),
  acquiredAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
const AgentGoalSchema = z.object({
  goalId: z.string().regex(GOAL_ID_RE),
  objective: z.string().min(1).max(MAX_OBJECTIVE),
  stopConditions: z.array(z.string().min(1).max(MAX_CONSTRAINT)).min(1).max(MAX_LIST),
  constraints: z.array(z.string().max(MAX_CONSTRAINT)).max(MAX_LIST),
  state: z.enum(AGENT_GOAL_STATES),
  cycle: z.number().int().nonnegative(),
  currentMilestone: z.string().max(MAX_CONSTRAINT).nullable(),
  workerOperationId: z.string().max(MAX_REF).regex(REF_RE).nullable(),
  workerStatus: z.enum(["IDLE", "RUNNING", "COMPLETED", "FAILED", "UNKNOWN"]),
  lastResultRef: z.string().max(MAX_REF).regex(REF_RE).nullable(),
  noProgressCount: z.number().int().nonnegative().max(1000),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  cycleClaim: CycleClaimSchema.nullable(),
  projectId: z.string().min(1).max(120).regex(REF_RE),
  projectRootDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authorization: z.object({ policyVersion: z.literal(1), approvalRequestId: z.string().min(1).max(160).regex(REF_RE), authorizedAt: z.number().int().positive(), expiresAt: z.number().int().positive(), maxCycles: z.number().int().min(1).max(50), maxNoProgress: z.number().int().min(1).max(10) }),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

const TRANSITIONS: Record<AgentGoalState, readonly AgentGoalState[]> = {
  READY: ["WORKER_RUNNING", "PAUSED", "FAILED"],
  WORKER_RUNNING: ["REVIEW_READY", "WAITING_USER", "PAUSED", "FAILED"],
  REVIEW_READY: ["WORKER_RUNNING", "WAITING_USER", "COMPLETED", "PAUSED", "FAILED"],
  WAITING_USER: ["READY", "PAUSED", "FAILED"],
  PAUSED: ["READY", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(ErrorCode.INVALID_ARGUMENT, message, details);
}

function validateText(value: string, field: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && value.trim().length === 0) || !SAFE_TEXT_RE.test(value)) {
    throw invalid(`Invalid ${field}`);
  }
  // Persisted goal metadata must not become a transport for secrets or raw execution payloads.
  if (/(?:bearer\s+|(?:api|access|refresh)[_-]?token\s*[:=]|(?:api[_-]?key|secret|password|private[_-]?key)\s*[:=]|https?:\/\/)/i.test(value)) {
    throw invalid(`Unsafe ${field}`);
  }
  return value;
}

function validateRef(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (value.length > MAX_REF || !REF_RE.test(value)) throw invalid(`Invalid ${field}`);
  return value;
}

function validateGoal(goal: AgentGoal): AgentGoal {
  const safe = AgentGoalSchema.safeParse(goal);
  if (!safe.success) throw invalid("Invalid persisted agent goal");
  validateText(safe.data.objective, "objective", MAX_OBJECTIVE, true);
  safe.data.stopConditions.forEach((v) => validateText(v, "stop condition", MAX_CONSTRAINT, true));
  safe.data.constraints.forEach((v) => validateText(v, "constraint", MAX_CONSTRAINT));
  if (safe.data.currentMilestone !== null) validateText(safe.data.currentMilestone, "current milestone", MAX_CONSTRAINT);
  validateRef(safe.data.workerOperationId, "worker operation id");
  validateRef(safe.data.lastResultRef, "result reference");
  if (safe.data.authorization.expiresAt <= safe.data.authorization.authorizedAt) throw invalid("Invalid authorization expiry");
  if (safe.data.authorization.expiresAt - safe.data.authorization.authorizedAt > MAX_AUTHORIZATION_MS) throw invalid("Authorization duration exceeds seven days");
  if (safe.data.state === "WORKER_RUNNING" && safe.data.workerStatus !== "RUNNING") throw invalid("WORKER_RUNNING requires a running worker");
  if (safe.data.state === "REVIEW_READY" && !["COMPLETED", "FAILED", "UNKNOWN"].includes(safe.data.workerStatus)) throw invalid("Review goal requires a terminal worker");
  if (safe.data.state === "COMPLETED" && safe.data.workerStatus !== "COMPLETED") throw invalid("Completed goal requires a completed worker");
  if (safe.data.state === "READY" && safe.data.workerStatus !== "IDLE") throw invalid("READY requires an idle worker");
  if (safe.data.state === "WAITING_USER" && safe.data.workerStatus === "RUNNING") throw invalid("WAITING_USER cannot have a running worker");
  if (safe.data.state === "FAILED" && safe.data.workerStatus === "RUNNING") throw invalid("Failed goal cannot have a running worker");
  return safe.data;
}

function goalPath(stateRoot: string, goalId: string): string {
  if (!GOAL_ID_RE.test(goalId)) throw invalid("Invalid goal id");
  return path.join(stateRoot, "agent-goals", goalId, "state.json");
}

function goalDir(stateRoot: string, goalId: string): string { return path.dirname(goalPath(stateRoot, goalId)); }

function createIdentity(input: AgentGoalCreateInput): {
  requestDigest: string;
  definitionDigest: string;
  goalId: string;
} {
  if (!REF_RE.test(input.requestId) || input.requestId.length > 160) throw invalid("Invalid goal request id");
  const durationMs = input.authorization.expiresAt - input.authorization.authorizedAt;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_AUTHORIZATION_MS) {
    throw invalid("Invalid goal authorization duration");
  }
  const requestDigest = createHash("sha256").update(input.requestId).digest("hex");
  // Approval receipt identity and wall-clock timestamps are deliberately not
  // part of the semantic definition.  A response-loss retry occurs later and
  // may observe the already-consumed approval, but it must still resolve the
  // exact goal created by the first call.  The bounded authorization policy
  // and its requested duration remain part of the definition.
  const definition = {
    projectId: input.projectId,
    projectRootDigest: input.projectRootDigest,
    objective: input.objective,
    stopConditions: input.stopConditions,
    constraints: input.constraints ?? [],
    currentMilestone: input.currentMilestone ?? null,
    authorization: {
      policyVersion: input.authorization.policyVersion,
      durationMs,
      maxCycles: input.authorization.maxCycles,
      maxNoProgress: input.authorization.maxNoProgress,
    },
  };
  const definitionDigest = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
  return { requestDigest, definitionDigest, goalId: `goal_${requestDigest.slice(0, 32)}` };
}

export class AgentGoalStore {
  private readonly stateRoot: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(stateRoot: string) {
    if (typeof stateRoot !== "string" || stateRoot.length === 0 || !path.isAbsolute(stateRoot)) throw invalid("stateRoot must be absolute");
    this.stateRoot = stateRoot;
  }

  private async atomicWrite(goal: AgentGoal): Promise<void> {
    const dir = goalDir(this.stateRoot, goal.goalId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    const target = path.join(dir, "state.json");
    const tmp = path.join(dir, `.state.${process.pid}.${randomUUID()}.tmp`);
    const json = JSON.stringify(goal, null, 2);
    if (Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) throw invalid("Agent goal state is too large");
    try {
      const handle = await open(tmp, "wx", 0o600);
      try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async read(goalId: string): Promise<AgentGoal> {
    try {
      const raw = await readFile(goalPath(this.stateRoot, goalId), "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) throw invalid("Agent goal state is too large");
      return validateGoal(JSON.parse(raw) as AgentGoal);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DomainError(ErrorCode.FILE_NOT_FOUND, "Agent goal not found", { goalId });
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Agent goal state is corrupt", { goalId });
    }
  }

  private async withLock<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(goalId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.locks.set(goalId, tail);
    await previous.catch(() => undefined);
    try { return await this.withFilesystemLock(goalId, fn); } finally { release(); if (this.locks.get(goalId) === tail) this.locks.delete(goalId); }
  }

  /** mkdir is an atomic cross-process lock primitive on the same filesystem. */
  private async withFilesystemLock<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
    const lock = path.join(goalDir(this.stateRoot, goalId), ".write-lock");
    await mkdir(goalDir(this.stateRoot, goalId), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalid("Agent goal state is busy");
        const info = await stat(lock).catch(() => null);
        if (!info) continue;
        if (Date.now() - info.mtimeMs > 30_000) {
          // Never delete the shared lock path directly: another process could
          // acquire a fresh lock between stat() and rm().  Atomically move the
          // observed stale lock to a unique tombstone first, then remove only
          // that tombstone.
          const stale = `${lock}.stale.${process.pid}.${randomUUID()}`;
          try {
            await rename(lock, stale);
            await rm(stale, { recursive: true, force: true });
          } catch (reclaimError) {
            if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw invalid("Agent goal state lock recovery failed");
            }
          }
          continue;
        }
        if (Date.now() >= deadline) throw invalid("Agent goal state is busy");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
  }

  async findCreate(input: AgentGoalCreateInput): Promise<AgentGoal | null> {
    const identity = createIdentity(input);
    try {
      const existing = await this.read(identity.goalId);
      if (existing.requestDigest !== identity.requestDigest || existing.definitionDigest !== identity.definitionDigest) {
        throw invalid("Goal request id was reused with different definition");
      }
      return existing;
    } catch (error) {
      if (error instanceof DomainError && error.code === ErrorCode.FILE_NOT_FOUND) return null;
      throw error;
    }
  }

  async create(input: AgentGoalCreateInput): Promise<AgentGoal> {
    const now = Date.now();
    const { requestDigest, definitionDigest, goalId } = createIdentity(input);
    const dir = goalDir(this.stateRoot, goalId);
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    try { await mkdir(dir, { recursive: false, mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const existing = await this.read(goalId);
          if (existing.requestDigest !== requestDigest || existing.definitionDigest !== definitionDigest) throw invalid("Goal request id was reused with different definition");
          return existing;
        } catch (readError) {
          if (readError instanceof DomainError && readError.code === ErrorCode.FILE_NOT_FOUND) { await new Promise((resolve) => setTimeout(resolve, 5)); continue; }
          throw readError;
        }
      }
      throw invalid("Goal create is busy");
    }
    const goal: AgentGoal = {
      goalId,
      objective: validateText(input.objective, "objective", MAX_OBJECTIVE, true),
      stopConditions: input.stopConditions.map((v) => validateText(v, "stop condition", MAX_CONSTRAINT, true)),
      constraints: (input.constraints ?? []).map((v) => validateText(v, "constraint", MAX_CONSTRAINT)),
      state: "READY", cycle: 0,
      currentMilestone: input.currentMilestone === undefined || input.currentMilestone === null ? null : validateText(input.currentMilestone, "current milestone", MAX_CONSTRAINT),
      workerOperationId: null, workerStatus: "IDLE", lastResultRef: null, noProgressCount: 0,
      createdAt: now, updatedAt: now, cycleClaim: null,
      projectId: input.projectId, projectRootDigest: input.projectRootDigest, authorization: input.authorization,
      requestDigest, definitionDigest,
    };
    if (goal.stopConditions.length === 0 || goal.stopConditions.length > MAX_LIST || goal.constraints.length > MAX_LIST) throw invalid("Invalid goal lists");
    await this.atomicWrite(validateGoal(goal));
    return goal;
  }

  async get(goalId: string): Promise<AgentGoal> { return this.read(goalId); }

  /** Apply bounded metadata changes without allowing terminal edits or cycle rollback. */
  async update(goalId: string, patch: Partial<Pick<AgentGoal, "objective" | "stopConditions" | "constraints" | "cycle" | "currentMilestone" | "workerOperationId" | "workerStatus" | "lastResultRef" | "noProgressCount">>): Promise<AgentGoal> {
    return this.withLock(goalId, async () => {
      const current = await this.read(goalId);
      if (current.state === "COMPLETED" || current.state === "FAILED") throw invalid("Terminal agent goal cannot be modified");
      if (patch.objective !== undefined) current.objective = validateText(patch.objective, "objective", MAX_OBJECTIVE, true);
      if (patch.stopConditions !== undefined) current.stopConditions = patch.stopConditions.map((v) => validateText(v, "stop condition", MAX_CONSTRAINT, true));
      if (patch.constraints !== undefined) current.constraints = patch.constraints.map((v) => validateText(v, "constraint", MAX_CONSTRAINT));
      if (patch.cycle !== undefined) throw invalid("Cycle can only be incremented by the cycle owner");
      if (patch.currentMilestone !== undefined) current.currentMilestone = patch.currentMilestone === null ? null : validateText(patch.currentMilestone, "current milestone", MAX_CONSTRAINT);
      if (patch.workerOperationId !== undefined) current.workerOperationId = validateRef(patch.workerOperationId, "worker operation id");
      if (patch.lastResultRef !== undefined) current.lastResultRef = validateRef(patch.lastResultRef, "result reference");
      if (patch.workerStatus !== undefined) current.workerStatus = patch.workerStatus;
      if (patch.noProgressCount !== undefined) { if (!Number.isInteger(patch.noProgressCount) || patch.noProgressCount < 0 || patch.noProgressCount > 1000) throw invalid("Invalid no-progress count"); current.noProgressCount = patch.noProgressCount; }
      if (current.stopConditions.length === 0 || current.stopConditions.length > MAX_LIST || current.constraints.length > MAX_LIST) throw invalid("Invalid goal lists");
      current.updatedAt = Date.now();
      await this.atomicWrite(validateGoal(current));
      return current;
    });
  }

  async transition(goalId: string, nextState: AgentGoalState, patch: Partial<Pick<AgentGoal, "currentMilestone" | "workerOperationId" | "workerStatus" | "lastResultRef" | "noProgressCount">> = {}): Promise<AgentGoal> {
    return this.withLock(goalId, async () => {
      const current = await this.read(goalId);
      if (!TRANSITIONS[current.state].includes(nextState)) throw invalid("Illegal agent goal state transition", { from: current.state, to: nextState });
      if (patch.workerOperationId !== undefined) current.workerOperationId = validateRef(patch.workerOperationId, "worker operation id");
      if (patch.lastResultRef !== undefined) current.lastResultRef = validateRef(patch.lastResultRef, "result reference");
      if (patch.currentMilestone !== undefined) current.currentMilestone = patch.currentMilestone === null ? null : validateText(patch.currentMilestone, "current milestone", MAX_CONSTRAINT);
      if (patch.workerStatus !== undefined) current.workerStatus = patch.workerStatus;
      if (patch.noProgressCount !== undefined) { if (!Number.isInteger(patch.noProgressCount) || patch.noProgressCount < 0 || patch.noProgressCount > 1000) throw invalid("Invalid no-progress count"); current.noProgressCount = patch.noProgressCount; }
      if (patch.workerStatus === undefined) {
        if (nextState === "WORKER_RUNNING") current.workerStatus = "RUNNING";
        else if (nextState === "REVIEW_READY" || nextState === "COMPLETED") current.workerStatus = "COMPLETED";
        else if (nextState === "WAITING_USER") current.workerStatus = "COMPLETED";
        else if (nextState === "READY") current.workerStatus = "IDLE";
        else if (nextState === "FAILED") current.workerStatus = "FAILED";
      }
      if (nextState === "READY") current.workerOperationId = null;
      current.state = nextState;
      if (nextState === "COMPLETED" || nextState === "FAILED") current.cycleClaim = null;
      current.updatedAt = Date.now();
      await this.atomicWrite(validateGoal(current));
      return current;
    });
  }

  async claimCycle(goalId: string, ownerRunId: string, ttlMs: number, now = Date.now()): Promise<CycleClaim> {
    if (!REF_RE.test(ownerRunId) || ownerRunId.length > 160 || !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 86_400_000) throw invalid("Invalid cycle claim");
    return this.withLock(goalId, async () => {
      const goal = await this.read(goalId);
      if (goal.state === "COMPLETED" || goal.state === "FAILED") throw invalid("Terminal agent goal cannot be claimed");
      if (now < goal.authorization.authorizedAt) throw invalid("Agent goal authorization is not active yet");
      // An expired authorization never permits a supervisor claim. A running
      // cycle may still be reconciled at the cycle/no-progress limit, but only
      // READY may be claimed for a new dispatch.
      if (now >= goal.authorization.expiresAt) throw invalid("Agent goal authorization expired");
      if (goal.state === "READY" && goal.cycle >= goal.authorization.maxCycles) throw invalid("Agent goal cycle limit reached");
      if (goal.state === "READY" && goal.noProgressCount >= goal.authorization.maxNoProgress) throw invalid("Agent goal no-progress limit reached");
      const existing = goal.cycleClaim;
      if (existing && existing.expiresAt > now && existing.ownerRunId !== ownerRunId) throw invalid("Cycle is already claimed");
      if (existing && existing.expiresAt > now && existing.ownerRunId === ownerRunId) return existing;
      const claim = { ownerRunId, acquiredAt: now, expiresAt: now + ttlMs };
      goal.cycleClaim = claim; goal.updatedAt = now;
      await this.atomicWrite(validateGoal(goal));
      return claim;
    });
  }

  async assertCycleOwner(goalId: string, ownerRunId: string, now = Date.now()): Promise<AgentGoal> {
    const goal = await this.read(goalId);
    if (!goal.cycleClaim || goal.cycleClaim.ownerRunId !== ownerRunId || goal.cycleClaim.expiresAt <= now) throw invalid("Cycle claim owner mismatch");
    return goal;
  }

  async assertDispatchable(goalId: string, now = Date.now()): Promise<AgentGoal> {
    const goal = await this.read(goalId);
    if (goal.state !== "READY") throw invalid("Agent goal is not ready to dispatch");
    if (now < goal.authorization.authorizedAt) throw invalid("Agent goal authorization is not active yet");
    if (now >= goal.authorization.expiresAt) throw invalid("Agent goal authorization expired");
    if (goal.cycle >= goal.authorization.maxCycles) throw invalid("Agent goal cycle limit reached");
    if (goal.noProgressCount >= goal.authorization.maxNoProgress) throw invalid("Agent goal no-progress limit reached");
    return goal;
  }

  async incrementCycle(goalId: string, ownerRunId: string, now = Date.now()): Promise<AgentGoal> {
    return this.withLock(goalId, async () => {
      const goal = await this.assertCycleOwner(goalId, ownerRunId, now);
      if (now < goal.authorization.authorizedAt) throw invalid("Agent goal authorization is not active yet");
      if (now >= goal.authorization.expiresAt) throw invalid("Agent goal authorization expired");
      if (goal.cycle >= goal.authorization.maxCycles) throw invalid("Agent goal cycle limit reached");
      if (goal.noProgressCount >= goal.authorization.maxNoProgress) throw invalid("Agent goal no-progress limit reached");
      goal.cycle += 1; goal.updatedAt = now;
      await this.atomicWrite(validateGoal(goal));
      return goal;
    });
  }

  /** Atomically bind one dispatched worker operation to the next scheduled cycle. */
  async startWorkerCycle(goalId: string, ownerRunId: string, operationId: string, now = Date.now()): Promise<AgentGoal> {
    return this.withLock(goalId, async () => {
      const goal = await this.assertCycleOwner(goalId, ownerRunId, now);
      if (goal.state !== "READY") {
        if (goal.state === "WORKER_RUNNING" && goal.workerOperationId === operationId) return goal;
        throw invalid("Agent goal is not ready for worker dispatch");
      }
      if (now < goal.authorization.authorizedAt || now >= goal.authorization.expiresAt || goal.cycle >= goal.authorization.maxCycles || goal.noProgressCount >= goal.authorization.maxNoProgress) throw invalid("Agent goal dispatch limit reached");
      if (!REF_RE.test(operationId) || operationId.length > MAX_REF) throw invalid("Invalid worker operation id");
      goal.cycle += 1;
      goal.state = "WORKER_RUNNING";
      goal.workerStatus = "RUNNING";
      goal.workerOperationId = operationId;
      goal.updatedAt = now;
      await this.atomicWrite(validateGoal(goal));
      return goal;
    });
  }

  /** Apply one GPT review decision as a single persisted state transition. */
  async applyReviewDecision(input: {
    goalId: string;
    ownerRunId: string;
    decision: GoalReviewDecision;
    progressMade?: boolean;
    milestone?: string;
    now?: number;
  }): Promise<AgentGoal> {
    return this.withLock(input.goalId, async () => {
      const now = input.now ?? Date.now();
      const goal = await this.read(input.goalId);
      if (!goal.cycleClaim || goal.cycleClaim.ownerRunId !== input.ownerRunId || goal.cycleClaim.expiresAt <= now) {
        throw invalid("Cycle claim owner mismatch");
      }
      if (goal.state !== "REVIEW_READY") throw invalid("Goal is not ready for review");
      if (input.milestone !== undefined) goal.currentMilestone = validateText(input.milestone, "current milestone", MAX_CONSTRAINT);

      if (input.decision === "continue") {
        goal.noProgressCount = input.progressMade ? 0 : goal.noProgressCount + 1;
        const limitReached = goal.noProgressCount >= goal.authorization.maxNoProgress
          || goal.cycle >= goal.authorization.maxCycles
          || now >= goal.authorization.expiresAt;
        goal.state = limitReached ? "PAUSED" : "READY";
        if (!limitReached) {
          goal.workerOperationId = null;
          goal.workerStatus = "IDLE";
        }
      } else if (input.decision === "complete") {
        if (goal.workerStatus !== "COMPLETED") throw invalid("Only a completed worker can complete the goal");
        goal.state = "COMPLETED";
      } else if (input.decision === "waiting-user") {
        goal.state = "WAITING_USER";
      } else if (input.decision === "pause") {
        goal.state = "PAUSED";
      } else {
        goal.state = "FAILED";
      }
      goal.cycleClaim = null;
      goal.updatedAt = now;
      await this.atomicWrite(validateGoal(goal));
      return goal;
    });
  }

  async releaseCycle(goalId: string, ownerRunId: string, now = Date.now()): Promise<AgentGoal> {
    return this.withLock(goalId, async () => {
      const goal = await this.read(goalId);
      if (goal.cycleClaim && goal.cycleClaim.ownerRunId !== ownerRunId && goal.cycleClaim.expiresAt > now) throw invalid("Cycle claim belongs to another owner");
      goal.cycleClaim = null; goal.updatedAt = now;
      await this.atomicWrite(validateGoal(goal));
      return goal;
    });
  }

  compactStatus(goal: AgentGoal): CompactAgentGoalStatus {
    const checked = validateGoal(goal);
    return { goalId: checked.goalId, state: checked.state, cycle: checked.cycle, currentMilestone: checked.currentMilestone, workerOperationId: checked.workerOperationId, workerStatus: checked.workerStatus, lastResultRef: checked.lastResultRef, noProgressCount: checked.noProgressCount, updatedAt: checked.updatedAt, cycleClaimed: checked.cycleClaim !== null && checked.cycleClaim.expiresAt > Date.now(), projectId: checked.projectId, expiresAt: checked.authorization.expiresAt, maxCycles: checked.authorization.maxCycles, maxNoProgress: checked.authorization.maxNoProgress };
  }
}
