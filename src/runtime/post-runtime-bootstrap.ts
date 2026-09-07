export type PostRuntimeBootstrapStage = "connection-status" | "agent-guide" | "project-rules" | "project-status" | "lane-ready";

interface ProjectBootstrapState {
  rulesAt?: number;
  statusAt?: number;
  laneReadyAt?: number;
}

interface BootstrapState {
  runtimeFingerprint: string;
  firstSeenAt: number;
  connectionStatusAt?: number;
  agentGuideAt?: number;
  projects: Map<string, ProjectBootstrapState>;
}

export interface PostRuntimeBootstrapSnapshot {
  runtimeFingerprint: string;
  firstSeenAt: number;
  connectionStatusAt: number | null;
  agentGuideAt: number | null;
  projectId: string | null;
  projectRulesAt: number | null;
  projectStatusAt: number | null;
  laneReadyAt: number | null;
  readyForLane: boolean;
  recoveryMs: number | null;
  missing: string[];
}

const states = new Map<string, BootstrapState>();

function stateFor(scope: string, runtimeFingerprint: string, now: number): BootstrapState {
  const existing = states.get(scope);
  if (existing && existing.runtimeFingerprint === runtimeFingerprint) return existing;
  const created: BootstrapState = {
    runtimeFingerprint,
    firstSeenAt: now,
    projects: new Map(),
  };
  states.set(scope, created);
  return created;
}

export function notePostRuntimeBootstrap(input: {
  scope: string;
  runtimeFingerprint: string;
  stage: PostRuntimeBootstrapStage;
  projectId?: string;
  now?: number;
}): PostRuntimeBootstrapSnapshot {
  const now = input.now ?? Date.now();
  const state = stateFor(input.scope, input.runtimeFingerprint, now);
  if (input.stage === "connection-status") state.connectionStatusAt ??= now;
  if (input.stage === "agent-guide") state.agentGuideAt ??= now;
  if (input.projectId) {
    const project = state.projects.get(input.projectId) ?? {};
    if (input.stage === "project-rules") project.rulesAt ??= now;
    if (input.stage === "project-status") project.statusAt ??= now;
    if (input.stage === "lane-ready") project.laneReadyAt ??= now;
    state.projects.set(input.projectId, project);
  }
  return postRuntimeBootstrapSnapshot(input.scope, input.runtimeFingerprint, input.projectId ?? null, now);
}

export function postRuntimeBootstrapSnapshot(
  scope: string,
  runtimeFingerprint: string,
  projectId: string | null = null,
  now = Date.now(),
): PostRuntimeBootstrapSnapshot {
  const state = stateFor(scope, runtimeFingerprint, now);
  const project = projectId ? state.projects.get(projectId) : undefined;
  const missing: string[] = [];
  if (!state.connectionStatusAt) missing.push("connection_status");
  if (!state.agentGuideAt) missing.push("agent_guide");
  if (projectId && !project?.rulesAt) missing.push("project_rules");
  if (projectId && !project?.statusAt) missing.push("project_status");
  const readyForLane = Boolean(
    state.connectionStatusAt && state.agentGuideAt && (!projectId || (project?.rulesAt && project?.statusAt)),
  );
  const recoveryEnd = project?.laneReadyAt;
  return {
    runtimeFingerprint: state.runtimeFingerprint,
    firstSeenAt: state.firstSeenAt,
    connectionStatusAt: state.connectionStatusAt ?? null,
    agentGuideAt: state.agentGuideAt ?? null,
    projectId,
    projectRulesAt: project?.rulesAt ?? null,
    projectStatusAt: project?.statusAt ?? null,
    laneReadyAt: recoveryEnd ?? null,
    readyForLane,
    recoveryMs: state.connectionStatusAt && recoveryEnd ? Math.max(0, recoveryEnd - state.connectionStatusAt) : null,
    missing,
  };
}

export function clearPostRuntimeBootstrapForTests(): void {
  states.clear();
}
