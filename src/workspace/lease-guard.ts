import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { requireLease } from "./project-select.js";
import { requireProjectLane } from "../state/project-lanes.js";
import { requireProjectPrivilege } from "../state/project-privilege-locks.js";
import { isChatGpt2CodexSourceProject, requireHostManagement } from "../state/host-management.js";
import type { SessionDocument } from "../state/store.js";

/**
 * Capability ceiling checked against the active project lease's preset.
 * Project leases authorize project-confined work only. Host-wide administration
 * is intentionally kept in the separate host-management grant model.
 */
export type LeaseCapability = "read" | "verify" | "write" | "image" | "remote" | "control";

export interface ProjectLeaseRequirementOptions {
  /** Serial leases remain available for explicitly serial-only admin tools.
   * Ordinary remote coding must never opt into this escape hatch. */
  allowRemoteSerial?: boolean;
}

/** Smallest lease preset that grants each project capability without widening access. */
export const RECOMMENDED_PRESET_BY_CAPABILITY: Readonly<Record<LeaseCapability, LeasePreset>> = {
  read: "read-only",
  verify: "tests-only",
  write: "full-write",
  image: "image-only",
  remote: "full-write",
  control: "control",
};

const ALLOWED_CAPABILITIES: Record<LeasePreset, ReadonlySet<LeaseCapability>> = {
  "read-only": new Set(["read"]),
  "tests-only": new Set(["read", "verify"]),
  "full-write": new Set(["read", "verify", "write", "image", "remote"]),
  "image-only": new Set(["read", "image"]),
  control: new Set(["read", "control"]),
};

function requireLeaseCapability(lease: Lease, capability: LeaseCapability): Lease {
  if (!ALLOWED_CAPABILITIES[lease.preset].has(capability)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Lease preset ${lease.preset} does not allow ${capability}`, {
      projectId: lease.projectId,
      preset: lease.preset,
      requiredCapability: capability,
      recommendedPreset: RECOMMENDED_PRESET_BY_CAPABILITY[capability],
    });
  }
  return lease;
}

async function requireSelfHostAdmin(
  ctx: ToolContext,
  project: ToolContext["registry"][number] | undefined,
  capability: LeaseCapability,
): Promise<void> {
  if (!project || capability === "read" || capability === "control") return;
  if (await isChatGpt2CodexSourceProject(project)) {
    await requireHostManagement(ctx, "admin");
  }
}

/**
 * Require an unexpired lease for `projectId` that permits `capability`.
 * Throws LEASE_REQUIRED (no/mismatched lease), LEASE_EXPIRED (matching lease
 * expired before the operation started), or PERMISSION_DENIED (lease exists
 * but its preset does not grant the requested capability).
 */
export async function requireProjectLease(
  ctx: ToolContext,
  projectId: string,
  capability: LeaseCapability = "read",
  workLaneId?: string,
  options: ProjectLeaseRequirementOptions = {},
): Promise<Lease> {
  const session = await ctx.store.getSession(ctx.sessionScope);
  const remoteIsolation = ctx.remote === true && ctx.config.multiProjectLanesEnabled === true;
  const project = ctx.registry.find((entry) => entry.projectId === projectId);
  if ((workLaneId !== undefined || remoteIsolation) && !project) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Unknown projectId: ${projectId}`);
  }
  if (workLaneId !== undefined) {
    if (ctx.config.multiProjectLanesEnabled !== true) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Multi-project work lanes are disabled", {
        projectId,
      });
    }
    const laneLease = await requireProjectLane({
      session: session as SessionDocument,
      project: project!,
      workLaneId,
      ownerScope: ctx.sessionScope ?? "local-default",
      allowContinuationActive: capability === "read",
    });
    const authorized = requireLeaseCapability(laneLease, capability);
    await requireSelfHostAdmin(ctx, project, capability);
    if (remoteIsolation) {
      await requireProjectPrivilege({
        stateDir: ctx.stateDir,
        project: project!,
        registry: ctx.registry,
        ownerScope: ctx.sessionScope,
        lease: authorized,
        kind: "lane",
      });
    }
    return authorized;
  }
  if (
    remoteIsolation &&
    capability !== "read" &&
    capability !== "control" &&
    options.allowRemoteSerial !== true
  ) {
    throw new DomainError(
      ErrorCode.LEASE_REQUIRED,
      "Explicit workLaneId is required for remote write/test/build work when multi-project lanes are enabled",
      {
        projectId,
        requiredCapability: capability,
        required: "workLaneId",
        leaseReason: "work-lane-required",
        recommendedAction: "project_lane_open",
      },
    );
  }
  const lease = requireLease(session, projectId);
  const authorized = requireLeaseCapability(lease, capability);
  await requireSelfHostAdmin(ctx, project, capability);
  if (remoteIsolation) {
    await requireProjectPrivilege({
      stateDir: ctx.stateDir,
      project: project!,
      registry: ctx.registry,
      ownerScope: ctx.sessionScope,
      lease: authorized,
      kind: "serial",
    });
  }
  return authorized;
}
