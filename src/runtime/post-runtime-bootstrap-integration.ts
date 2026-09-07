import { DomainError, ErrorCode, type ToolContext } from "../types.js";
import { getRuntimeManifest } from "./runtime-manifest.js";
import {
  notePostRuntimeBootstrap,
  postRuntimeBootstrapSnapshot,
  type PostRuntimeBootstrapSnapshot,
} from "./post-runtime-bootstrap.js";

function scopeFor(ctx: ToolContext): string {
  return ctx.sessionScope ?? ctx.activity?.session.internalId ?? "remote-default";
}

function fingerprint(): string {
  return getRuntimeManifest().runtimeFingerprint ?? `runtime-pid-${process.pid}`;
}

export function noteBootstrapStage(
  ctx: ToolContext,
  stage: "connection-status" | "agent-guide" | "project-rules" | "project-status" | "lane-ready",
  projectId?: string,
): PostRuntimeBootstrapSnapshot {
  return notePostRuntimeBootstrap({
    scope: scopeFor(ctx),
    runtimeFingerprint: fingerprint(),
    stage,
    ...(projectId ? { projectId } : {}),
  });
}

export function bootstrapSnapshot(ctx: ToolContext, projectId: string | null = null): PostRuntimeBootstrapSnapshot {
  return postRuntimeBootstrapSnapshot(scopeFor(ctx), fingerprint(), projectId);
}

export function requireBootstrapStage(
  ctx: ToolContext,
  requirement: "connection" | "guide" | "project",
  projectId?: string,
): PostRuntimeBootstrapSnapshot {
  const snapshot = bootstrapSnapshot(ctx, projectId ?? null);
  if (ctx.remote !== true || ctx.config.multiProjectLanesEnabled !== true) return snapshot;
  const missing = requirement === "connection"
    ? snapshot.missing.filter((item) => item === "connection_status")
    : requirement === "guide"
      ? snapshot.missing.filter((item) => item === "connection_status" || item === "agent_guide")
      : snapshot.missing;
  if (missing.length > 0) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      "Post-runtime bootstrap is incomplete for this ChatGPT session",
      {
        postRuntimeBootstrapRequired: true,
        runtimeFingerprint: snapshot.runtimeFingerprint,
        projectId: projectId ?? null,
        missing,
        requiredOrder: ["connection_status", "agent_guide", "project_rules", "project_status", "project_lane_open"],
        recommendedAction: missing[0],
      },
    );
  }
  return snapshot;
}
