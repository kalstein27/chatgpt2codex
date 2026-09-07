import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

const BarrierSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().min(8).max(160),
  projectId: z.string().min(1).max(120),
  kind: z.enum(["runtime-apply", "macos-app-apply", "runtime-snapshot-prune"]),
  phase: z.literal("draining"),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});

export type RuntimeUpdateBarrier = z.infer<typeof BarrierSchema>;

function barrierPath(stateDir: string): string {
  return path.join(stateDir, "runtime-update-barrier.json");
}

async function readBarrierFile(stateDir: string): Promise<RuntimeUpdateBarrier | null> {
  try {
    const parsed = BarrierSchema.safeParse(JSON.parse(await fs.readFile(barrierPath(stateDir), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function getRuntimeUpdateBarrier(
  stateDir: string,
  now = Date.now(),
): Promise<RuntimeUpdateBarrier | null> {
  const barrier = await readBarrierFile(stateDir);
  if (!barrier) return null;
  if (barrier.expiresAt > now) return barrier;
  await releaseRuntimeUpdateBarrier(stateDir, barrier.operationId);
  return null;
}

export async function acquireRuntimeUpdateBarrier(input: {
  stateDir: string;
  operationId: string;
  projectId: string;
  kind: RuntimeUpdateBarrier["kind"];
  now?: number;
  ttlMs?: number;
}): Promise<RuntimeUpdateBarrier> {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const barrier: RuntimeUpdateBarrier = {
    schemaVersion: 1,
    operationId: input.operationId,
    projectId: input.projectId,
    kind: input.kind,
    phase: "draining",
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  await fs.mkdir(input.stateDir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(input.stateDir, DIR_MODE).catch(() => undefined);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(barrierPath(input.stateDir), "wx", FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify(barrier, null, 2)}\n`);
      } finally {
        await handle.close();
      }
      return barrier;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await getRuntimeUpdateBarrier(input.stateDir, now);
      if (!existing) continue;
      if (existing.operationId === input.operationId) return existing;
      throw new DomainError(ErrorCode.RUNTIME_UPDATE_IN_PROGRESS, "A runtime or app update is already draining commands", {
        operationId: existing.operationId,
        projectId: existing.projectId,
        phase: existing.phase,
        retryAfterMs: Math.max(1, existing.expiresAt - now),
      });
    }
  }
  throw new DomainError(ErrorCode.RUNTIME_UPDATE_IN_PROGRESS, "Runtime update barrier is busy");
}

export async function releaseRuntimeUpdateBarrier(stateDir: string, operationId: string): Promise<boolean> {
  const existing = await readBarrierFile(stateDir);
  if (!existing || existing.operationId !== operationId) return false;
  const temporary = `${barrierPath(stateDir)}.release-${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(barrierPath(stateDir), temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fs.unlink(temporary).catch(() => undefined);
  return true;
}

export async function assertRuntimeUpdateNotDraining(stateDir: string, now = Date.now()): Promise<void> {
  const barrier = await getRuntimeUpdateBarrier(stateDir, now);
  if (!barrier) return;
  throw new DomainError(ErrorCode.RUNTIME_UPDATE_IN_PROGRESS, "A runtime or app update is draining active commands", {
    operationId: barrier.operationId,
    projectId: barrier.projectId,
    phase: barrier.phase,
    retryAfterMs: Math.max(1, barrier.expiresAt - now),
  });
}

export async function assertRuntimeMaintenanceAllowsLeaseAcquisition(
  stateDir: string,
  now = Date.now(),
): Promise<void> {
  const barrier = await getRuntimeUpdateBarrier(stateDir, now);
  if (!barrier) return;
  throw new DomainError(
    ErrorCode.RUNTIME_UPDATE_IN_PROGRESS,
    "C2CT runtime maintenance is in progress; project lease acquisition and renewal are temporarily disabled",
    {
      operationId: barrier.operationId,
      projectId: barrier.projectId,
      phase: barrier.phase,
      maintenanceInProgress: true,
      leaseAcquisitionBlocked: true,
      leaseRenewalBlocked: true,
      releaseOwnedLeasesAllowed: true,
      recommendedAction: "release-owned-project-capabilities-and-retry-after-maintenance",
      retryAfterMs: Math.max(1, barrier.expiresAt - now),
    },
  );
}
