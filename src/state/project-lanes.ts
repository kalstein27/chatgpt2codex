import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  DomainError,
  ErrorCode,
  type Lease,
  type LeasePreset,
  type ProjectRegistryEntry,
} from "../types.js";
import {
  LEASE_RENEWAL_GRACE_MS,
  makeLease,
  renewLease,
} from "../workspace/project-select.js";
import {
  MAX_PROJECT_LANES,
  type ProjectLaneRecord,
  type ReleasedProjectLaneRecord,
  type SessionDocument,
} from "./store.js";

const WORK_LANE_ID_RE = /^lane_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANE_DIGEST_DOMAIN = "chatgpt2codex:project-lane:v1";
const ROOT_DIGEST_DOMAIN = "chatgpt2codex:canonical-project-root:v1";
const OWNER_SCOPE_DIGEST_DOMAIN = "chatgpt2codex:project-lane-owner:v1";

export type ProjectLanePreset = Exclude<LeasePreset, "control">;

export interface OpenProjectLaneInput {
  session: SessionDocument;
  project: ProjectRegistryEntry;
  preset: ProjectLanePreset;
  ttlMs: number;
  ownerScope?: string;
  bindProject?: boolean;
  now?: number;
  enabled?: boolean;
}

export interface ProjectLaneBinding {
  session: SessionDocument;
  project: ProjectRegistryEntry;
  workLaneId: string;
  ownerScope?: string;
  now?: number;
}

export interface SerialProjectLeaseCompatibilityInput {
  session: SessionDocument;
  project: ProjectRegistryEntry;
  preset: LeasePreset;
  now?: number;
}

function digest(domain: string, value: string): string {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

function ownerScopeDigest(ownerScope: string | undefined): string {
  return digest(OWNER_SCOPE_DIGEST_DOMAIN, ownerScope ?? "local-default");
}

export function projectLanesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHATGPT2CODEX_MULTI_PROJECT_LANES !== "0";
}

export function projectLaneDigest(workLaneId: string): string {
  if (!WORK_LANE_ID_RE.test(workLaneId)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid project work lane identifier");
  }
  return digest(LANE_DIGEST_DOMAIN, workLaneId);
}

async function canonicalProjectRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, "Registered project root is unavailable");
  }
}

async function canonicalRootDigest(root: string): Promise<string> {
  return digest(ROOT_DIGEST_DOMAIN, await canonicalProjectRoot(root));
}

function activeLanes(session: SessionDocument, now: number): ProjectLaneRecord[] {
  return (session.lanes ?? []).filter((lane) => lane.expiresAt >= now);
}

export async function assertSerialProjectLeaseCompatibleWithLanes(
  input: SerialProjectLeaseCompatibilityInput,
): Promise<void> {
  if (input.preset === "read-only") return;
  const now = input.now ?? Date.now();
  const rootDigest = await canonicalRootDigest(input.project.root);
  const conflicting = activeLanes(input.session, now).find(
    (lane) => lane.projectRootDigest === rootDigest && lane.preset !== "read-only",
  );
  if (!conflicting) return;
  throw new DomainError(
    ErrorCode.ACTIVE_PROJECT_LEASE_HELD,
    "The requested project already has an active privileged work lane",
    {
      projectId: input.project.projectId,
      conflictingPreset: conflicting.preset,
      conflictKind: "project-lane",
    },
  );
}

function version2Session(
  session: SessionDocument,
  lanes: ProjectLaneRecord[],
  boundProjectId = session.boundProjectId,
  releasedLanes = session.releasedLanes,
): SessionDocument {
  return {
    ...session,
    version: Math.max(2, session.version),
    ...(boundProjectId !== undefined ? { boundProjectId } : {}),
    lanes,
    ...(releasedLanes ? { releasedLanes } : {}),
  };
}

function releasedLaneTombstone(
  session: SessionDocument,
  record: ReleasedProjectLaneRecord,
): ReleasedProjectLaneRecord[] {
  return [
    record,
    ...(session.releasedLanes ?? []).filter((candidate) =>
      candidate.laneDigest !== record.laneDigest || candidate.leaseId !== record.leaseId,
    ),
  ].slice(0, 16);
}

export function wasProjectLaneReleased(input: {
  session: SessionDocument;
  projectId: string;
  workLaneId?: string;
  leaseId: string;
}): boolean {
  const laneDigest = input.workLaneId ? projectLaneDigest(input.workLaneId) : undefined;
  return (input.session.releasedLanes ?? []).some((record) =>
    record.projectId === input.projectId
    && (!laneDigest || record.laneDigest === laneDigest)
    && record.leaseId === input.leaseId,
  );
}

function laneLease(record: ProjectLaneRecord, projectRoot: string): Lease {
  return {
    projectId: record.projectId,
    projectRoot,
    leaseId: record.leaseId,
    preset: record.preset,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  };
}

async function findLaneRecord(
  binding: ProjectLaneBinding,
): Promise<{ lanes: ProjectLaneRecord[]; index: number; record: ProjectLaneRecord }> {
  const laneDigest = projectLaneDigest(binding.workLaneId);
  const rootDigest = await canonicalRootDigest(binding.project.root);
  const lanes = binding.session.lanes ?? [];
  const index = lanes.findIndex((lane) => lane.laneDigest === laneDigest);
  const record = index >= 0 ? lanes[index] : undefined;
  if (!record || record.projectId !== binding.project.projectId || record.projectRootDigest !== rootDigest) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active project lane lease for the requested project", {
      projectId: binding.project.projectId,
    });
  }
  if (
    record.ownerScopeDigest !== undefined &&
    record.ownerScopeDigest !== ownerScopeDigest(binding.ownerScope)
  ) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "Project lane belongs to another session", {
      projectId: binding.project.projectId,
      ownerMismatch: true,
    });
  }
  return { lanes, index, record };
}

async function resolveLaneRecord(
  binding: ProjectLaneBinding,
): Promise<{ lanes: ProjectLaneRecord[]; index: number; record: ProjectLaneRecord }> {
  const now = binding.now ?? Date.now();
  const found = await findLaneRecord(binding);
  if (found.record.expiresAt < now) {
    throw new DomainError(ErrorCode.LEASE_EXPIRED, "Project lane lease expired before the requested operation started", {
      projectId: found.record.projectId,
      leaseId: found.record.leaseId,
      preset: found.record.preset,
      expiresAt: found.record.expiresAt,
      expiredBySec: Math.max(0, Math.ceil((now - found.record.expiresAt) / 1_000)),
      renewalTool: "project_lane_renew",
      phase: "lease-preflight",
      actionStarted: false,
      receiptCreated: false,
      subprocessStarted: false,
    });
  }
  return found;
}

export async function openProjectLane(
  input: OpenProjectLaneInput,
): Promise<{ session: SessionDocument; workLaneId: string; lease: Lease }> {
  if (!(input.enabled ?? projectLanesEnabled())) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Multi-project work lanes are disabled");
  }
  const now = input.now ?? Date.now();
  const canonicalRoot = await canonicalProjectRoot(input.project.root);
  const rootDigest = digest(ROOT_DIGEST_DOMAIN, canonicalRoot);
  const lanes = activeLanes(input.session, now);
  if (
    input.bindProject === true &&
    input.preset !== "read-only" &&
    input.session.boundProjectId &&
    input.session.boundProjectId !== input.project.projectId
  ) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      "This session is already bound to another project for privileged work",
      {
        projectId: input.project.projectId,
        boundProjectId: input.session.boundProjectId,
      },
    );
  }
  if (lanes.length >= MAX_PROJECT_LANES) {
    throw new DomainError(ErrorCode.QUOTA_EXCEEDED, "Maximum active project work lanes reached", {
      maximum: MAX_PROJECT_LANES,
    });
  }
  if (
    input.preset !== "read-only" &&
    lanes.some((lane) => lane.projectRootDigest === rootDigest && lane.preset !== "read-only")
  ) {
    throw new DomainError(
      ErrorCode.ACTIVE_PROJECT_LEASE_HELD,
      "The requested project already has an active privileged work lane",
      { projectId: input.project.projectId },
    );
  }
  const serialLease = input.session.lease;
  if (
    input.preset !== "read-only" &&
    serialLease &&
    serialLease.expiresAt >= now &&
    serialLease.preset !== "read-only" &&
    await canonicalRootDigest(serialLease.projectRoot) === rootDigest
  ) {
    throw new DomainError(
      ErrorCode.ACTIVE_PROJECT_LEASE_HELD,
      "The requested project already has an active privileged serial lease",
      {
        projectId: input.project.projectId,
        conflictingPreset: serialLease.preset,
        conflictKind: "serial-lease",
      },
    );
  }

  const workLaneId = `lane_${randomUUID()}`;
  const lease = makeLease(
    { ...input.project, root: canonicalRoot },
    input.preset,
    input.ttlMs,
    now,
  );
  const record: ProjectLaneRecord = {
    laneDigest: projectLaneDigest(workLaneId),
    projectId: lease.projectId,
    projectRootDigest: rootDigest,
    ownerScopeDigest: ownerScopeDigest(input.ownerScope),
    leaseId: lease.leaseId,
    preset: input.preset,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    createdAt: now,
    lastUsedAt: now,
  };
  return {
    session: version2Session(
      input.session,
      [...lanes, record],
      input.bindProject !== true || input.preset === "read-only"
        ? input.session.boundProjectId
        : input.session.boundProjectId ?? lease.projectId,
    ),
    workLaneId,
    lease,
  };
}

export async function requireProjectLane(binding: ProjectLaneBinding): Promise<Lease> {
  const { record } = await resolveLaneRecord(binding);
  return laneLease(record, await canonicalProjectRoot(binding.project.root));
}

export async function renewProjectLane(
  binding: ProjectLaneBinding & { ttlMs: number; expectedLeaseId?: string },
): Promise<{ session: SessionDocument; lease: Lease; previousLease: Lease }> {
  const now = binding.now ?? Date.now();
  const { lanes, index, record } = await findLaneRecord(binding);
  if (now > record.expiresAt + LEASE_RENEWAL_GRACE_MS) {
    throw new DomainError(ErrorCode.LEASE_EXPIRED, "Project lane lease is outside the renewal grace period", {
      projectId: record.projectId,
      expiresAt: record.expiresAt,
      renewalGraceMs: LEASE_RENEWAL_GRACE_MS,
    });
  }
  if (binding.expectedLeaseId && record.leaseId !== binding.expectedLeaseId) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "Lane lease identity changed; refresh status before renewing", {
      projectId: record.projectId,
      currentLeaseChanged: true,
    });
  }
  const previousLease = laneLease(record, await canonicalProjectRoot(binding.project.root));
  const renewed = renewLease(
    previousLease,
    binding.ttlMs,
    now,
  );
  const updated: ProjectLaneRecord = {
    ...record,
    leaseId: renewed.leaseId,
    issuedAt: renewed.issuedAt,
    expiresAt: renewed.expiresAt,
    lastUsedAt: now,
  };
  const next = [...lanes];
  next[index] = updated;
  return { session: version2Session(binding.session, next), lease: renewed, previousLease };
}

export async function releaseProjectLane(
  binding: ProjectLaneBinding,
): Promise<{ session: SessionDocument; releasedLeaseId: string }> {
  const { lanes, index, record } = await findLaneRecord(binding);
  const releasedAt = binding.now ?? Date.now();
  return {
    session: version2Session(
      binding.session,
      lanes.filter((_, candidate) => candidate !== index),
      binding.session.boundProjectId,
      releasedLaneTombstone(binding.session, {
        laneDigest: record.laneDigest,
        projectId: record.projectId,
        leaseId: record.leaseId,
        releasedAt,
      }),
    ),
    releasedLeaseId: record.leaseId,
  };
}

export async function releaseOwnedProjectLane(input: {
  session: SessionDocument;
  project: ProjectRegistryEntry;
  ownerScope?: string;
  now?: number;
  includeReadOnly?: boolean;
}): Promise<{ session: SessionDocument; releasedLease: Lease } | undefined> {
  const now = input.now ?? Date.now();
  const canonicalRoot = await canonicalProjectRoot(input.project.root);
  const rootDigest = digest(ROOT_DIGEST_DOMAIN, canonicalRoot);
  const ownerDigest = ownerScopeDigest(input.ownerScope);
  const lanes = input.session.lanes ?? [];
  const owned = lanes
    .map((record, index) => ({ record, index }))
    .filter(({ record }) =>
      record.projectId === input.project.projectId &&
      record.projectRootDigest === rootDigest &&
      (input.includeReadOnly === true || record.preset !== "read-only") &&
      record.expiresAt >= now &&
      record.ownerScopeDigest === ownerDigest,
    );

  if (owned.length === 0) return undefined;
  if (owned.length > 1) {
    throw new DomainError(
      ErrorCode.ACTIVE_PROJECT_LEASE_HELD,
      "Multiple active privileged work lanes belong to this session for the requested project",
      {
        projectId: input.project.projectId,
        conflictKind: "owned-project-lane-ambiguous",
        laneCount: owned.length,
      },
    );
  }

  const ownedLane = owned[0];
  if (!ownedLane) return undefined;
  const { record, index } = ownedLane;
  return {
    session: version2Session(
      input.session,
      lanes.filter((_, candidate) => candidate !== index),
      input.session.boundProjectId,
      releasedLaneTombstone(input.session, {
        laneDigest: record.laneDigest,
        projectId: record.projectId,
        leaseId: record.leaseId,
        releasedAt: now,
      }),
    ),
    releasedLease: laneLease(record, canonicalRoot),
  };
}
