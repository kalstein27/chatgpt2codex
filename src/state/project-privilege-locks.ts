import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { DomainError, ErrorCode, type Lease, type ProjectRegistryEntry } from "../types.js";

export type ProjectPrivilegeKind = "lane" | "serial";

interface ProjectPrivilegeLock {
  version: 1;
  projectId: string;
  rootDigest: string;
  ownerScopeDigest: string;
  leaseId: string;
  preset: Lease["preset"];
  kind: ProjectPrivilegeKind;
  expiresAt: number;
  updatedAt: number;
}

const ROOT_DOMAIN = "chatgpt2codex:privileged-project-root:v1";
const OWNER_DOMAIN = "chatgpt2codex:privileged-project-owner:v1";
const RECOVERY_GENERATION_DOMAIN = "chatgpt2codex:privileged-project-recovery:v1";
const lockQueues = new Map<string, Promise<void>>();

function digest(domain: string, value: string): string {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

export function projectPrivilegeOwnerDigest(ownerScope: string | undefined): string {
  return digest(OWNER_DOMAIN, ownerScope ?? "local-default");
}

async function canonicalProjectRoot(root: string): Promise<string> {
  return realpath(root).catch(() => {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, "Registered project root is unavailable");
  });
}

function rootDigest(canonicalRoot: string): string {
  return digest(ROOT_DOMAIN, canonicalRoot);
}

async function projectRootDigest(root: string): Promise<string> {
  return rootDigest(await canonicalProjectRoot(root));
}

function lockPath(stateDir: string, rootDigest: string): string {
  return path.join(stateDir, "project-locks", `${rootDigest}.json`);
}

async function withRootLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = lockQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  lockQueues.set(key, tail);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally {
    release();
    if (lockQueues.get(key) === tail) lockQueues.delete(key);
  }
}

async function readLock(filename: string): Promise<ProjectPrivilegeLock | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filename, "utf8")) as ProjectPrivilegeLock;
    return parsed?.version === 1 ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeLock(filename: string, value: ProjectPrivilegeLock): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const tmp = `${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, filename);
}

function matches(lock: ProjectPrivilegeLock, project: ProjectRegistryEntry, ownerScope: string | undefined, leaseId: string, kind: ProjectPrivilegeKind): boolean {
  return lock.projectId === project.projectId &&
    lock.ownerScopeDigest === projectPrivilegeOwnerDigest(ownerScope) &&
    lock.leaseId === leaseId && lock.kind === kind;
}

function containsRoot(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

type RootOverlapRelation = "ancestor" | "descendant";

async function activeOverlappingPrivilege(input: {
  stateDir: string;
  project: ProjectRegistryEntry;
  registry: readonly ProjectRegistryEntry[];
  requesterScope?: string;
  now: number;
}): Promise<{
  projectId: string;
  relation: RootOverlapRelation;
  preset: Lease["preset"];
  kind: ProjectPrivilegeKind;
  ownerRelation: "current" | "foreign";
} | undefined> {
  const targetRoot = await canonicalProjectRoot(input.project.root);
  for (const candidate of input.registry) {
    const candidateRoot = await canonicalProjectRoot(candidate.root).catch(() => undefined);
    if (!candidateRoot || candidateRoot === targetRoot) continue;
    const candidateContainsTarget = containsRoot(candidateRoot, targetRoot);
    const targetContainsCandidate = containsRoot(targetRoot, candidateRoot);
    if (!candidateContainsTarget && !targetContainsCandidate) continue;
    const current = await readLock(lockPath(input.stateDir, rootDigest(candidateRoot)));
    if (!current || current.expiresAt < input.now) continue;
    return {
      projectId: current.projectId,
      relation: candidateContainsTarget ? "ancestor" : "descendant",
      preset: current.preset,
      kind: current.kind,
      ownerRelation: current.ownerScopeDigest === projectPrivilegeOwnerDigest(input.requesterScope) ? "current" : "foreign",
    };
  }
  return undefined;
}

function overlappingPrivilegeError(project: ProjectRegistryEntry, overlap: {
  projectId: string;
  relation: RootOverlapRelation;
  preset: Lease["preset"];
  kind: ProjectPrivilegeKind;
  ownerRelation: "current" | "foreign";
}): DomainError {
  return new DomainError(
    ErrorCode.ACTIVE_PROJECT_LEASE_HELD,
    "The project root overlaps another active privileged project root",
    {
      projectId: project.projectId,
      conflictKind: "project-root-overlap",
      conflictingProjectId: overlap.projectId,
      overlapRelation: overlap.relation,
      blockingProjectId: overlap.projectId,
      rootRelation: overlap.relation,
      blockingPreset: overlap.preset,
      blockingKind: overlap.kind,
      ownerRelation: overlap.ownerRelation,
      recommendedAction: overlap.ownerRelation === "current"
        ? "release-current-blocking-lease"
        : "wait-for-blocking-owner-release",
    },
  );
}

export interface ProjectPrivilegeRecoveryTarget {
  projectId: string;
  ownerScopeDigest: string;
  leaseId: string;
  preset: Lease["preset"];
  kind: ProjectPrivilegeKind;
  expiresAt: number;
  generation: string;
  ownedByRequester: boolean;
}

function recoveryTarget(lock: ProjectPrivilegeLock, requesterScope: string | undefined): ProjectPrivilegeRecoveryTarget {
  const generation = digest(
    RECOVERY_GENERATION_DOMAIN,
    JSON.stringify([lock.projectId, lock.rootDigest, lock.ownerScopeDigest, lock.leaseId, lock.kind, lock.expiresAt]),
  );
  return {
    projectId: lock.projectId,
    ownerScopeDigest: lock.ownerScopeDigest,
    leaseId: lock.leaseId,
    preset: lock.preset,
    kind: lock.kind,
    expiresAt: lock.expiresAt,
    generation,
    ownedByRequester: lock.ownerScopeDigest === projectPrivilegeOwnerDigest(requesterScope),
  };
}

export async function inspectProjectPrivilegeForRecovery(input: {
  stateDir: string;
  project: ProjectRegistryEntry;
  requesterScope?: string;
  now?: number;
}): Promise<ProjectPrivilegeRecoveryTarget | undefined> {
  const now = input.now ?? Date.now();
  const rootDigest = await projectRootDigest(input.project.root);
  const filename = lockPath(input.stateDir, rootDigest);
  return withRootLock(filename, async () => {
    const current = await readLock(filename);
    if (!current || current.expiresAt < now) return undefined;
    return recoveryTarget(current, input.requesterScope);
  });
}

export async function retireForeignProjectPrivilegeForRecovery(input: {
  stateDir: string;
  project: ProjectRegistryEntry;
  requesterScope?: string;
  expectedGeneration: string;
  now?: number;
}): Promise<ProjectPrivilegeRecoveryTarget> {
  const now = input.now ?? Date.now();
  const rootDigest = await projectRootDigest(input.project.root);
  const filename = lockPath(input.stateDir, rootDigest);
  return withRootLock(filename, async () => {
    const current = await readLock(filename);
    if (!current || current.expiresAt < now) {
      throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active privileged project owner remains to recover", {
        projectId: input.project.projectId,
      });
    }
    const target = recoveryTarget(current, input.requesterScope);
    if (target.kind !== "lane") {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Only an abandoned work lane can be recovered", {
        projectId: input.project.projectId,
        conflictKind: target.kind,
      });
    }
    if (target.ownedByRequester) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "The active work lane already belongs to this session", {
        projectId: input.project.projectId,
      });
    }
    if (target.generation !== input.expectedGeneration) {
      throw new DomainError(ErrorCode.ACTIVE_PROJECT_LEASE_HELD, "Project ownership changed while recovery approval was pending", {
        projectId: input.project.projectId,
        conflictKind: "project-root-lock",
      });
    }
    await unlink(filename).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return target;
  });
}

export interface ProjectPrivilegeLockInspection extends ProjectPrivilegeRecoveryTarget {
  canonicalRoot: string;
  projectRootDigest: string;
  relation: "same-root" | RootOverlapRelation;
  expired: boolean;
  updatedAt: number;
}

/**
 * Inspect the exact target root and registered ancestor/descendant roots
 * without exposing raw owner/session identifiers. Expired lock files are
 * intentionally included so callers can diagnose and safely self-heal them.
 */
export async function inspectProjectPrivilegeLocks(input: {
  stateDir: string;
  project: ProjectRegistryEntry;
  registry: readonly ProjectRegistryEntry[];
  requesterScope?: string;
  now?: number;
}): Promise<ProjectPrivilegeLockInspection[]> {
  const now = input.now ?? Date.now();
  const targetRoot = await canonicalProjectRoot(input.project.root);
  const candidates = input.registry.length > 0 ? input.registry : [input.project];
  const inspected: ProjectPrivilegeLockInspection[] = [];
  const seenGenerations = new Set<string>();

  for (const candidate of candidates) {
    const candidateRoot = await canonicalProjectRoot(candidate.root).catch(() => undefined);
    if (!candidateRoot) continue;
    const sameRoot = candidateRoot === targetRoot;
    const candidateContainsTarget = !sameRoot && containsRoot(candidateRoot, targetRoot);
    const targetContainsCandidate = !sameRoot && containsRoot(targetRoot, candidateRoot);
    if (!sameRoot && !candidateContainsTarget && !targetContainsCandidate) continue;

    const candidateRootDigest = rootDigest(candidateRoot);
    const current = await readLock(lockPath(input.stateDir, candidateRootDigest));
    if (!current) continue;
    const target = recoveryTarget(current, input.requesterScope);
    if (seenGenerations.has(target.generation)) continue;
    seenGenerations.add(target.generation);
    inspected.push({
      ...target,
      canonicalRoot: candidateRoot,
      projectRootDigest: candidateRootDigest,
      relation: sameRoot ? "same-root" : candidateContainsTarget ? "ancestor" : "descendant",
      expired: current.expiresAt < now,
      updatedAt: current.updatedAt,
    });
  }

  return inspected.sort((left, right) => {
    const leftRank = left.relation === "same-root" ? 0 : 1;
    const rightRank = right.relation === "same-root" ? 0 : 1;
    return leftRank - rightRank || left.canonicalRoot.localeCompare(right.canonicalRoot);
  });
}

/**
 * Retire exactly one inspected root-lock generation. Policy decisions such as
 * live-owner protection and approval requirements stay with the caller; this
 * primitive only provides generation-CAS deletion so a changed owner is never
 * removed accidentally.
 */
export async function retireProjectPrivilegeGeneration(input: {
  stateDir: string;
  root: string;
  requesterScope?: string;
  expectedGeneration: string;
}): Promise<ProjectPrivilegeRecoveryTarget> {
  const canonicalRoot = await canonicalProjectRoot(input.root);
  const filename = lockPath(input.stateDir, rootDigest(canonicalRoot));
  return withRootLock(filename, async () => {
    const current = await readLock(filename);
    if (!current) {
      throw new DomainError(ErrorCode.LEASE_REQUIRED, "No privileged project owner remains at the inspected root");
    }
    const target = recoveryTarget(current, input.requesterScope);
    if (target.generation !== input.expectedGeneration) {
      throw new DomainError(
        ErrorCode.ACTIVE_PROJECT_LEASE_HELD,
        "Project ownership changed before the inspected lock could be retired",
        { projectId: current.projectId, conflictKind: "project-root-lock" },
      );
    }
    await unlink(filename).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return target;
  });
}

export async function claimProjectPrivilege(input: { stateDir: string; project: ProjectRegistryEntry; registry: readonly ProjectRegistryEntry[]; ownerScope?: string; lease: Lease; kind: ProjectPrivilegeKind; now?: number }): Promise<void> {
  if (input.lease.preset === "read-only") return;
  const now = input.now ?? Date.now();
  const registry = input.registry ?? [input.project];
  const rootDigest = await projectRootDigest(input.project.root);
  const filename = lockPath(input.stateDir, rootDigest);
  const claimQueueKey = path.join(input.stateDir, "project-locks", ".claim-transaction");
  await withRootLock(claimQueueKey, async () => {
    const overlap = await activeOverlappingPrivilege({
      stateDir: input.stateDir,
      project: input.project,
      registry,
      requesterScope: input.ownerScope,
      now,
    });
    if (overlap) throw overlappingPrivilegeError(input.project, overlap);
    await withRootLock(filename, async () => {
      const current = await readLock(filename);
      if (current && current.expiresAt >= now && !matches(current, input.project, input.ownerScope, input.lease.leaseId, input.kind)) {
        const ownedSameKindReplacement = current.projectId === input.project.projectId &&
          current.ownerScopeDigest === projectPrivilegeOwnerDigest(input.ownerScope) && current.kind === input.kind;
        if (!ownedSameKindReplacement) {
          throw new DomainError(ErrorCode.ACTIVE_PROJECT_LEASE_HELD, "The project root has an active privileged owner", {
            projectId: input.project.projectId,
            conflictKind: "project-root-lock",
          });
        }
      }
      await writeLock(filename, {
        version: 1,
        projectId: input.project.projectId,
        rootDigest,
        ownerScopeDigest: projectPrivilegeOwnerDigest(input.ownerScope),
        leaseId: input.lease.leaseId,
        preset: input.lease.preset,
        kind: input.kind,
        expiresAt: input.lease.expiresAt,
        updatedAt: now,
      });
    });
  });
}

export async function requireProjectPrivilege(input: { stateDir: string; project: ProjectRegistryEntry; registry: readonly ProjectRegistryEntry[]; ownerScope?: string; lease: Lease; kind: ProjectPrivilegeKind; now?: number; allowExpiredByMs?: number; enforceNoOverlap?: boolean }): Promise<void> {
  if (input.lease.preset === "read-only") return;
  const now = input.now ?? Date.now();
  const registry = input.registry ?? [input.project];
  const rootDigest = await projectRootDigest(input.project.root);
  const current = await readLock(lockPath(input.stateDir, rootDigest));
  const allowedExpiry = current ? current.expiresAt + Math.max(0, input.allowExpiredByMs ?? 0) : 0;
  if (!current || allowedExpiry < now || !matches(current, input.project, input.ownerScope, input.lease.leaseId, input.kind)) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "Privileged project ownership is not held by this session", {
      projectId: input.project.projectId,
      ownerMismatch: Boolean(current),
    });
  }
  if (input.enforceNoOverlap !== false) {
    const overlap = await activeOverlappingPrivilege({
      stateDir: input.stateDir,
      project: input.project,
      registry,
      requesterScope: input.ownerScope,
      now,
    });
    if (overlap) throw overlappingPrivilegeError(input.project, overlap);
  }
}

export async function releaseProjectPrivilege(input: { stateDir: string; project: ProjectRegistryEntry; ownerScope?: string; leaseId: string; kind: ProjectPrivilegeKind }): Promise<void> {
  const rootDigest = await projectRootDigest(input.project.root);
  const filename = lockPath(input.stateDir, rootDigest);
  await withRootLock(filename, async () => {
    const current = await readLock(filename);
    if (!current) return;
    if (!matches(current, input.project, input.ownerScope, input.leaseId, input.kind)) {
      throw new DomainError(ErrorCode.LEASE_REQUIRED, "Cannot release privileged ownership held by another session", { projectId: input.project.projectId, ownerMismatch: true });
    }
    await unlink(filename).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  });
}
