import { randomUUID } from "node:crypto";
import {
  refreshChatGptHostCatalog,
  type ChatGptHostCatalogRefreshResult,
} from "../exec/chatgpt-host-catalog-refresh.js";
import {
  probeRuntimeHealth,
  requestRuntimeReload,
  type RuntimeHealthSnapshot,
} from "./runtime-apply.js";
import {
  acquireRuntimeUpdateBarrier,
  releaseRuntimeUpdateBarrier,
  type RuntimeUpdateBarrier,
} from "./runtime-update-barrier.js";

export type RuntimeReapplyRefreshStatus =
  | "reapplied-and-refresh-requested"
  | "reapply-failed"
  | "refresh-failed";

export interface RuntimeReapplyRefreshResult {
  ok: boolean;
  status: RuntimeReapplyRefreshStatus;
  runtimeReapplied: boolean;
  previousRuntimePid: number | null;
  currentRuntimePid: number | null;
  runtimeFingerprint: string | null;
  runtimeRoot: string | null;
  supervisorPreserved: boolean;
  connectorPreserved: boolean;
  tunnelProcessesPreserved: boolean;
  catalogRefresh: ChatGptHostCatalogRefreshResult | null;
  errorCode?: string;
  message?: string;
  recommendedAction: "none" | "retry-from-settings" | "inspect-runtime-health" | "requery-current-chat";
}

export interface RuntimeReapplyRefreshDependencies {
  probeHealth?: (port: number) => Promise<RuntimeHealthSnapshot>;
  requestReload?: (stateDir: string, operationId: string) => Promise<void>;
  refreshHostCatalog?: () => Promise<ChatGptHostCatalogRefreshResult>;
  acquireBarrier?: (input: {
    stateDir: string;
    operationId: string;
    projectId: string;
    kind: RuntimeUpdateBarrier["kind"];
    ttlMs?: number;
  }) => Promise<RuntimeUpdateBarrier>;
  releaseBarrier?: (stateDir: string, operationId: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function sameRuntime(before: RuntimeHealthSnapshot, after: RuntimeHealthSnapshot): boolean {
  const beforeManifest = before.manifest;
  const afterManifest = after.manifest;
  return Boolean(
    beforeManifest?.runtimeFingerprint
    && afterManifest?.runtimeFingerprint === beforeManifest.runtimeFingerprint
    && afterManifest.runtimeRoot === beforeManifest.runtimeRoot,
  );
}

function preservation(before: RuntimeHealthSnapshot, after: RuntimeHealthSnapshot): {
  supervisorPreserved: boolean;
  connectorPreserved: boolean;
  tunnelProcessesPreserved: boolean;
} {
  const beforeExternal = before.externalIdentity;
  const afterExternal = after.externalIdentity;
  const beforeSupervisor = beforeExternal?.supervisorPid ?? before.supervisorPid;
  const afterSupervisor = afterExternal?.supervisorPid ?? after.supervisorPid;
  const supervisorPreserved = beforeSupervisor !== null && afterSupervisor === beforeSupervisor;
  const connectorPreserved = supervisorPreserved
    && Boolean(beforeExternal)
    && Boolean(afterExternal)
    && afterExternal?.connectorPublicOrigin === beforeExternal?.connectorPublicOrigin;
  const tunnelProcessesPreserved = Boolean(beforeExternal)
    && Boolean(afterExternal)
    && afterExternal?.tunnelMode === beforeExternal?.tunnelMode
    && afterExternal?.cloudflaredPid === beforeExternal?.cloudflaredPid;
  return { supervisorPreserved, connectorPreserved, tunnelProcessesPreserved };
}

function failedResult(
  before: RuntimeHealthSnapshot,
  after: RuntimeHealthSnapshot | null,
  errorCode: string,
  message: string,
): RuntimeReapplyRefreshResult {
  const preserved = after
    ? preservation(before, after)
    : { supervisorPreserved: false, connectorPreserved: false, tunnelProcessesPreserved: false };
  return {
    ok: false,
    status: "reapply-failed",
    runtimeReapplied: false,
    previousRuntimePid: before.runtimePid,
    currentRuntimePid: after?.runtimePid ?? null,
    runtimeFingerprint: after?.manifest?.runtimeFingerprint ?? before.manifest?.runtimeFingerprint ?? null,
    runtimeRoot: after?.manifest?.runtimeRoot ?? before.manifest?.runtimeRoot ?? null,
    ...preserved,
    catalogRefresh: null,
    errorCode,
    message,
    recommendedAction: "inspect-runtime-health",
  };
}

export async function reapplyCurrentRuntimeAndRefresh(input: {
  stateDir: string;
  port: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  stableProbeCount?: number;
}, dependencies: RuntimeReapplyRefreshDependencies = {}): Promise<RuntimeReapplyRefreshResult> {
  const probe = dependencies.probeHealth ?? probeRuntimeHealth;
  const reload = dependencies.requestReload ?? requestRuntimeReload;
  const refresh = dependencies.refreshHostCatalog ?? refreshChatGptHostCatalog;
  const acquireBarrier = dependencies.acquireBarrier ?? acquireRuntimeUpdateBarrier;
  const releaseBarrier = dependencies.releaseBarrier ?? releaseRuntimeUpdateBarrier;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const timeoutMs = Math.max(1_000, Math.min(120_000, input.timeoutMs ?? 45_000));
  const pollIntervalMs = Math.max(50, Math.min(5_000, input.pollIntervalMs ?? 500));
  const stableProbeCount = Math.max(1, Math.min(10, input.stableProbeCount ?? 2));

  const before = await probe(input.port);
  const beforeSupervisor = before.externalIdentity?.supervisorPid ?? before.supervisorPid;
  if (!before.healthy || before.runtimePid === null || beforeSupervisor === null || !before.manifest?.runtimeFingerprint) {
    return failedResult(before, null, "RUNTIME_REAPPLY_PRECONDITION_FAILED", "The managed runtime is not healthy enough to reapply safely.");
  }

  const operationId = `local-runtime-reapply-${randomUUID()}`;
  let barrierAcquired = false;
  try {
    await acquireBarrier({
      stateDir: input.stateDir,
      operationId,
      projectId: "chatgpt2codex-local-recovery",
      kind: "runtime-apply",
      ttlMs: timeoutMs + 30_000,
    });
    barrierAcquired = true;
    await reload(input.stateDir, operationId);

    const deadline = now() + timeoutMs;
    let stableProbes = 0;
    let lastHealth: RuntimeHealthSnapshot | null = null;
    while (now() < deadline) {
      await sleep(pollIntervalMs);
      const health = await probe(input.port);
      lastHealth = health;
      const pidChanged = health.runtimePid !== null && health.runtimePid !== before.runtimePid;
      const preserved = preservation(before, health);
      const accepted = health.healthy
        && pidChanged
        && sameRuntime(before, health)
        && preserved.supervisorPreserved
        && preserved.connectorPreserved
        && preserved.tunnelProcessesPreserved;
      if (accepted) {
        stableProbes += 1;
        if (stableProbes >= stableProbeCount) {
          const catalogRefresh = await refresh();
          const base = {
            runtimeReapplied: true,
            previousRuntimePid: before.runtimePid,
            currentRuntimePid: health.runtimePid,
            runtimeFingerprint: health.manifest?.runtimeFingerprint ?? null,
            runtimeRoot: health.manifest?.runtimeRoot ?? null,
            ...preserved,
            catalogRefresh,
          };
          if (!catalogRefresh.ok) {
            return {
              ...base,
              ok: false,
              status: "refresh-failed",
              errorCode: catalogRefresh.errorCode ?? "CATALOG_REFRESH_FAILED",
              message: catalogRefresh.message ?? "Runtime reapply succeeded, but ChatGPT catalog refresh did not complete.",
              recommendedAction: "retry-from-settings",
            };
          }
          return {
            ...base,
            ok: true,
            status: "reapplied-and-refresh-requested",
            recommendedAction: "requery-current-chat",
          };
        }
      } else {
        stableProbes = 0;
      }
    }

    return failedResult(
      before,
      lastHealth,
      "RUNTIME_REAPPLY_TIMEOUT",
      "The current runtime did not return with the same identity and preserved connector topology before the timeout.",
    );
  } catch (error) {
    return failedResult(
      before,
      null,
      "RUNTIME_REAPPLY_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (barrierAcquired) await releaseBarrier(input.stateDir, operationId).catch(() => false);
  }
}
