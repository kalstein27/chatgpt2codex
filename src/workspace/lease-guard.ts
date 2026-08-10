import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { requireLease } from "./project-select.js";

/**
 * Capability ceiling checked against the active project lease's preset.
 * Shared by src/server/tools.ts (file/command/git tools) and
 * src/control/tools.ts (desktop-control tools) so both enforce the same
 * preset -> capability table from a single source of truth.
 */
export type LeaseCapability = "read" | "verify" | "write" | "image" | "remote" | "control";

/** Smallest lease preset that grants each capability without widening access. */
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
): Promise<Lease> {
  const session = await ctx.store.getSession(ctx.sessionScope);
  const lease = requireLease(session, projectId);
  if (!ALLOWED_CAPABILITIES[lease.preset].has(capability)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Lease preset ${lease.preset} does not allow ${capability}`, {
      projectId,
      preset: lease.preset,
      requiredCapability: capability,
      recommendedPreset: RECOMMENDED_PRESET_BY_CAPABILITY[capability],
    });
  }
  return lease;
}
