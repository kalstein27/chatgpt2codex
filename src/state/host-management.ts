import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DomainError, ErrorCode, type Lease, type ProjectRegistryEntry, type ToolContext } from "../types.js";

export type HostManagementLevel = "tools" | "admin";

export interface HostManagementGrant {
  grantId: string;
  level: HostManagementLevel;
  issuedAt: number;
  expiresAt: number;
}

interface SessionWithHostManagement {
  hostManagement?: HostManagementGrant | null;
  [key: string]: unknown;
}

function levelAllows(actual: HostManagementLevel, required: HostManagementLevel): boolean {
  return actual === "admin" || required === "tools";
}

function normalizedTtl(ttlMs: number): number {
  return Number.isFinite(ttlMs) ? Math.max(1_000, Math.floor(ttlMs)) : 30 * 60 * 1_000;
}

function sessionRecord(value: unknown): SessionWithHostManagement {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SessionWithHostManagement
    : {};
}

async function updateSession(
  ctx: ToolContext,
  updater: (current: SessionWithHostManagement) => SessionWithHostManagement,
): Promise<SessionWithHostManagement> {
  if (ctx.store.updateSession) {
    return await ctx.store.updateSession(ctx.sessionScope, (raw) => updater(sessionRecord(raw))) as SessionWithHostManagement;
  }
  const next = updater(sessionRecord(await ctx.store.getSession(ctx.sessionScope)));
  await ctx.store.setSession(next, ctx.sessionScope);
  return next;
}

export function hostManagementHealth(grant: HostManagementGrant, now = Date.now()): {
  expiresAt: number;
  expiresInSec: number;
  expired: boolean;
} {
  const remaining = grant.expiresAt - now;
  return {
    expiresAt: grant.expiresAt,
    expiresInSec: Math.max(0, Math.ceil(remaining / 1_000)),
    expired: remaining < 0,
  };
}

export async function acquireHostManagement(
  ctx: ToolContext,
  level: HostManagementLevel,
  now = Date.now(),
): Promise<HostManagementGrant> {
  const current = sessionRecord(await ctx.store.getSession(ctx.sessionScope)).hostManagement;
  if (current && current.expiresAt >= now && levelAllows(current.level, level)) return current;
  const grant: HostManagementGrant = {
    grantId: `hmg_${randomUUID()}`,
    level,
    issuedAt: now,
    expiresAt: now + normalizedTtl(ctx.config.defaultLeaseTtlMs),
  };
  await updateSession(ctx, (session) => ({ ...session, hostManagement: grant }));
  return grant;
}

export async function currentHostManagement(ctx: ToolContext): Promise<HostManagementGrant | null> {
  const grant = sessionRecord(await ctx.store.getSession(ctx.sessionScope)).hostManagement;
  return grant ?? null;
}

export async function requireHostManagement(
  ctx: ToolContext,
  requiredLevel: HostManagementLevel,
  now = Date.now(),
): Promise<HostManagementGrant> {
  const grant = await currentHostManagement(ctx);
  if (!grant) {
    throw new DomainError(ErrorCode.HOST_MANAGEMENT_REQUIRED, "Host management authorization is required", {
      requiredHostManagementLevel: requiredLevel,
      recommendedTool: "host_management_acquire",
    });
  }
  if (grant.expiresAt < now) {
    throw new DomainError(ErrorCode.HOST_MANAGEMENT_EXPIRED, "Host management authorization expired", {
      requiredHostManagementLevel: requiredLevel,
      grantId: grant.grantId,
      expiresAt: grant.expiresAt,
      recommendedTool: "host_management_acquire",
    });
  }
  if (!levelAllows(grant.level, requiredLevel)) {
    throw new DomainError(ErrorCode.HOST_MANAGEMENT_REQUIRED, "Host administrator authorization is required", {
      requiredHostManagementLevel: requiredLevel,
      currentHostManagementLevel: grant.level,
      recommendedTool: "host_management_acquire",
    });
  }
  return grant;
}

export async function releaseHostManagement(
  ctx: ToolContext,
  grantId: string,
): Promise<{ released: boolean; alreadyReleased: boolean }> {
  let released = false;
  let alreadyReleased = false;
  await updateSession(ctx, (session) => {
    const current = session.hostManagement;
    if (!current) {
      alreadyReleased = true;
      return session;
    }
    if (current.grantId !== grantId) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Host management grant identity does not match", {
        recommendedTool: "host_management_status",
      });
    }
    released = true;
    return { ...session, hostManagement: null };
  });
  return { released, alreadyReleased };
}

export function hostManagementApprovalLease(grant: HostManagementGrant): Lease {
  return {
    projectId: "c2ct-host",
    projectRoot: "@c2ct-host-management",
    leaseId: grant.grantId,
    preset: "full-write",
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  };
}

export async function isChatGpt2CodexSourceProject(project: ProjectRegistryEntry): Promise<boolean> {
  try {
    const marker = (await readFile(path.join(project.root, ".chatgpt2codex-source-root"), "utf8")).trim();
    if (marker !== "chatgpt2codex-source-v1") return false;
    const parsed = JSON.parse(await readFile(path.join(project.root, "package.json"), "utf8")) as Record<string, unknown>;
    if (parsed.name !== "chatgpt2codex") return false;
    const bin = parsed.bin;
    return Boolean(
      bin && typeof bin === "object" && !Array.isArray(bin)
      && (bin as Record<string, unknown>).chatgpt2codex === "dist/cli.js",
    );
  } catch {
    return false;
  }
}
