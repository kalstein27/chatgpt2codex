import { DomainError, ErrorCode, type Lease, type ToolContext } from "../types.js";
import { findProject } from "./registry.js";

/**
 * Single source of truth for "which project is currently active" (the
 * project/lease set by `project_select`), shared by:
 *  - save_image_from_url / save_chatgpt_image (src/server/tools.ts)
 *
 * Image-intake callers need the same answer to "what project, if any, is
 * active right now" so active-project routing stays consistent.
 */

/** Literal value meaning "use whatever project is currently active", i.e.
 * the same as omitting an explicit project id entirely. */
export const ACTIVE_PROJECT_SENTINEL = "@active";

export interface ActiveProject {
  projectId: string;
  root: string;
  lease: Lease | null;
}

/** Resolve a project's filesystem root by projectId, refreshing from the
 * persisted registry if the in-memory ctx.registry is empty. */
async function resolveProjectRoot(ctx: ToolContext, projectId: string): Promise<string> {
  let entries = ctx.registry;
  if (entries.length === 0) {
    entries = await ctx.store.loadProjects();
  }
  const result = findProject(entries, { projectId });
  if (!result.ok) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project not found: ${projectId}`);
  }
  return result.entry.root;
}

/** Read the active project lease from the session store (set by
 * project_select), ignoring it if expired. Returns null if there is no
 * active project/lease at all. */
async function getActiveLease(ctx: ToolContext): Promise<{ projectId: string; lease: Lease | null } | null> {
  const session = (await ctx.store.getSession(ctx.sessionScope)) as
    | { activeProjectId?: string | null; lease?: Lease | null }
    | undefined;
  const activeProjectId = session?.activeProjectId ?? null;
  if (!activeProjectId) return null;
  const lease = session?.lease ?? null;
  if (lease && (lease.projectId !== activeProjectId || Date.now() > lease.expiresAt)) {
    return { projectId: activeProjectId, lease: null };
  }
  return { projectId: activeProjectId, lease: lease ?? null };
}

/**
 * Resolve the currently active project (the one selected via
 * `project_select`), including its filesystem root and current lease (if
 * any, and if unexpired). Returns `null` when no project is active.
 */
export async function resolveActiveProject(ctx: ToolContext): Promise<ActiveProject | null> {
  const active = await getActiveLease(ctx);
  if (!active) return null;
  const root = await resolveProjectRoot(ctx, active.projectId);
  return { projectId: active.projectId, root, lease: active.lease };
}
