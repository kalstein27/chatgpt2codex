import { createHash } from "node:crypto";
import { DomainError, ErrorCode } from "../types.js";
import type { AgentGoal, AgentGoalStore, CompactAgentGoalStatus, GoalReviewDecision } from "../state/agent-goals.js";
import type { LunaCompactStatus, LunaResult, LunaWorkerState } from "./scheduled-luna-worker.js";

export interface ScheduledWorker {
  start(input: { requestId: string; prompt: string; safeLabel: string; timeoutMs: number }): Promise<{ operationId: string }>;
  status(operationId: string): Promise<LunaCompactStatus>;
  result(operationId: string): Promise<LunaResult>;
}

export type ControllerAction = "TERMINAL" | "DISPATCH" | "WAIT" | "REVIEW" | "WAITING_USER" | "PAUSED";
export interface ControllerTick { action: ControllerAction; goal: CompactAgentGoalStatus; worker?: LunaCompactStatus; result?: LunaResult; }

function invalid(message: string): DomainError { return new DomainError(ErrorCode.INVALID_ARGUMENT, message); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export class ScheduledGoalController {
  private readonly goals: AgentGoalStore;
  private readonly worker: ScheduledWorker;
  private readonly projectId: string;
  private readonly projectRootDigest: string;

  constructor(input: { goals: AgentGoalStore; worker: ScheduledWorker; projectId: string; projectRootDigest: string }) {
    if (!input.projectId || input.projectId.length > 120 || !/^[A-Za-z0-9._:/-]+$/u.test(input.projectId)) throw invalid("Invalid controller project id");
    if (!/^[a-f0-9]{64}$/u.test(input.projectRootDigest)) throw invalid("Invalid controller project root digest");
    this.goals = input.goals; this.worker = input.worker; this.projectId = input.projectId; this.projectRootDigest = input.projectRootDigest;
  }

  private bind(goal: AgentGoal): void {
    if (goal.projectId !== this.projectId || goal.projectRootDigest !== this.projectRootDigest) throw invalid("Agent goal project binding mismatch");
  }

  async tick(goalId: string, ownerRunId: string, claimTtlMs: number): Promise<ControllerTick> {
    const initial = await this.goals.get(goalId); this.bind(initial);
    if (["COMPLETED", "FAILED"].includes(initial.state)) return { action: "TERMINAL", goal: this.goals.compactStatus(initial) };
    await this.goals.claimCycle(goalId, ownerRunId, claimTtlMs);
    const goal = await this.goals.get(goalId);
    if (goal.state === "READY") return { action: "DISPATCH", goal: this.goals.compactStatus(goal) };
    if (goal.state === "WAITING_USER" || goal.state === "PAUSED") {
      await this.goals.releaseCycle(goalId, ownerRunId);
      return { action: goal.state === "WAITING_USER" ? "WAITING_USER" : "PAUSED", goal: this.goals.compactStatus(await this.goals.get(goalId)) };
    }
    if (goal.state === "REVIEW_READY") {
      let result: LunaResult | undefined;
      if (goal.workerOperationId && goal.workerStatus === "COMPLETED") result = await this.worker.result(goal.workerOperationId).catch(() => undefined);
      return { action: "REVIEW", goal: this.goals.compactStatus(goal), ...(result ? { result } : {}) };
    }
    if (goal.state !== "WORKER_RUNNING" || !goal.workerOperationId) {
      await this.goals.releaseCycle(goalId, ownerRunId);
      return { action: "WAIT", goal: this.goals.compactStatus(await this.goals.get(goalId)) };
    }
    // Keep the claim while reconciling and reviewing. If the injected status
    // call throws, no blind retry or release occurs; the TTL is the recovery
    // boundary for the next scheduled supervisor run.
    const worker = await this.worker.status(goal.workerOperationId);
    if (["QUEUED", "RUNNING"].includes(worker.state)) {
      await this.goals.releaseCycle(goalId, ownerRunId);
      return { action: "WAIT", goal: this.goals.compactStatus(await this.goals.get(goalId)), worker };
    }
    if (worker.state === "COMPLETED") {
      const result = await this.worker.result(goal.workerOperationId);
      const reviewed = await this.goals.transition(goalId, "REVIEW_READY", { workerStatus: "COMPLETED", lastResultRef: worker.resultRef ?? null });
      return { action: "REVIEW", goal: this.goals.compactStatus(reviewed), worker, result };
    }
    const terminalWorkerStatus = worker.state === "UNKNOWN" ? "UNKNOWN" : "FAILED";
    const reviewed = await this.goals.transition(goalId, "REVIEW_READY", { workerStatus: terminalWorkerStatus });
    return { action: "REVIEW", goal: this.goals.compactStatus(reviewed), worker };
  }

  async dispatch(goalId: string, ownerRunId: string, taskPrompt: string, safeLabel: string, timeoutMs: number): Promise<{ operationId: string; goal: CompactAgentGoalStatus }> {
    const goal = await this.goals.get(goalId); this.bind(goal);
    // A prior response may have been lost after the atomic store write. Claim
    // the existing running cycle (or verify its current owner), return the
    // existing operation, and release it; never spawn again.
    if (goal.state === "WORKER_RUNNING" && goal.workerOperationId) {
      await this.goals.claimCycle(goalId, ownerRunId, 30_000);
      await this.goals.assertCycleOwner(goalId, ownerRunId);
      await this.goals.releaseCycle(goalId, ownerRunId);
      return { operationId: goal.workerOperationId, goal: this.goals.compactStatus(goal) };
    }
    await this.goals.assertDispatchable(goalId);
    await this.goals.assertCycleOwner(goalId, ownerRunId);
    if (goal.state !== "READY") throw invalid("Agent goal is not ready for dispatch");
    const requestId = `scheduled-${digest(`${goal.goalId}:${goal.cycle + 1}`).slice(0, 48)}`;
    const started = await this.worker.start({ requestId, prompt: taskPrompt, safeLabel, timeoutMs });
    const running = await this.goals.startWorkerCycle(goalId, ownerRunId, started.operationId);
    await this.goals.releaseCycle(goalId, ownerRunId);
    return { operationId: started.operationId, goal: this.goals.compactStatus(running) };
  }

  async review(goalId: string, ownerRunId: string, decision: GoalReviewDecision, progressMade = false, milestone?: string): Promise<CompactAgentGoalStatus> {
    const goal = await this.goals.get(goalId); this.bind(goal);
    await this.goals.assertCycleOwner(goalId, ownerRunId);
    if (goal.state !== "REVIEW_READY") throw invalid("Goal is not ready for review");
    const updated = await this.goals.applyReviewDecision({
      goalId,
      ownerRunId,
      decision,
      progressMade,
      ...(milestone !== undefined ? { milestone } : {}),
    });
    return this.goals.compactStatus(updated);
  }

  async status(goalId: string): Promise<{ goal: CompactAgentGoalStatus; worker?: LunaCompactStatus; result?: LunaResult }> {
    const goal = await this.goals.get(goalId); this.bind(goal);
    if (!goal.workerOperationId) return { goal: this.goals.compactStatus(goal) };
    const worker = await this.worker.status(goal.workerOperationId);
    if (worker.state !== "COMPLETED") return { goal: this.goals.compactStatus(goal), worker };
    return { goal: this.goals.compactStatus(goal), worker, result: await this.worker.result(goal.workerOperationId) };
  }
}
