import { randomUUID } from "node:crypto";
import {
  DomainError,
  ErrorCode,
  type Lease,
  type LeasePreset,
  type ProjectRegistryEntry,
} from "../types.js";

/** Default lease TTL when no config is threaded in (PRD §7 Project Lease). */
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** Results recommend renewal during the final five minutes of an active lease. */
export const LEASE_RENEWAL_WARNING_MS = 5 * 60 * 1000;
/** Non-control leases may be recovered briefly after expiry without changing scope. */
export const LEASE_RENEWAL_GRACE_MS = 10 * 60 * 1000;

export interface LeaseHealth {
  leaseExpiresAt: number;
  leaseExpiresInSec: number;
  leaseExpired: boolean;
  renewalRecommended: boolean;
  renewalTool: "project_renew_lease";
}

function normalizedLeaseTtlMs(ttlMs: number): number {
  return Number.isFinite(ttlMs) ? Math.max(1_000, Math.floor(ttlMs)) : DEFAULT_LEASE_TTL_MS;
}

export function leaseHealth(
  lease: Lease,
  now = Date.now(),
  warningMs = LEASE_RENEWAL_WARNING_MS,
): LeaseHealth {
  const remainingMs = lease.expiresAt - now;
  const leaseExpired = remainingMs < 0;
  return {
    leaseExpiresAt: lease.expiresAt,
    leaseExpiresInSec: Math.max(0, Math.ceil(remainingMs / 1_000)),
    leaseExpired,
    renewalRecommended: !leaseExpired && remainingMs <= Math.max(0, warningMs),
    renewalTool: "project_renew_lease",
  };
}

/**
 * Issue a new active project Lease (PRD §7 Project Lease / §8.2
 * project_select) for the given registry entry and preset.
 */
export function makeLease(
  entry: ProjectRegistryEntry,
  preset: LeasePreset,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  issuedAt = Date.now(),
): Lease {
  return {
    projectId: entry.projectId,
    leaseId: `lease_${randomUUID()}`,
    projectRoot: entry.root,
    preset,
    issuedAt,
    expiresAt: issuedAt + normalizedLeaseTtlMs(ttlMs),
  };
}

/** Renew only the time-bound identity; project root and capability preset stay unchanged. */
export function renewLease(lease: Lease, ttlMs = DEFAULT_LEASE_TTL_MS, issuedAt = Date.now()): Lease {
  return {
    ...lease,
    leaseId: `lease_${randomUUID()}`,
    issuedAt,
    expiresAt: issuedAt + normalizedLeaseTtlMs(ttlMs),
  };
}

/** Shape session state is expected to carry the active lease under (PRD §10 sessions.json). */
interface SessionWithLease {
  lease?: Lease;
  activeLease?: Lease;
}

function isSessionWithLease(session: unknown): session is SessionWithLease {
  return typeof session === "object" && session !== null;
}

/**
 * Look up and validate the active lease for `projectId` from session state.
 *
 * @throws {DomainError} LEASE_REQUIRED if no matching lease exists.
 * @throws {DomainError} LEASE_EXPIRED if the matching lease has expired.
 */
export function requireLease(session: unknown, projectId: string): Lease {
  if (!isSessionWithLease(session)) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active session/lease", { projectId });
  }

  const lease = session.lease ?? session.activeLease;
  if (!lease) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active lease for project", { projectId });
  }

  if (lease.projectId !== projectId) {
    throw new DomainError(
      ErrorCode.LEASE_REQUIRED,
      "Active lease is for a different project",
      { projectId, leaseProjectId: lease.projectId },
    );
  }

  if (Date.now() > lease.expiresAt) {
    throw new DomainError(ErrorCode.LEASE_EXPIRED, "Lease expired before the requested operation started", {
      projectId,
      leaseId: lease.leaseId,
      preset: lease.preset,
      expiresAt: lease.expiresAt,
      expiredBySec: Math.max(0, Math.ceil((Date.now() - lease.expiresAt) / 1_000)),
      renewalTool: "project_renew_lease",
      phase: "lease-preflight",
      actionStarted: false,
      receiptCreated: false,
      subprocessStarted: false,
    });
  }

  return lease;
}
