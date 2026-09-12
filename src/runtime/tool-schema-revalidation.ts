import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntimeManifest, type RuntimeManifest } from "./runtime-manifest.js";
import { getLatestAppliedSchemaChangingRuntimeApplyReceipt, type RuntimeApplyReceipt } from "./runtime-apply.js";
import { readHostCatalogRebind, type HostCatalogRebindReceipt } from "./host-catalog-rebind.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const RECEIPT_SCHEMA_VERSION = 1;
const SCHEMA_REVISION_PATTERN = /^sha256:[a-f0-9]{24}$/u;
const RECEIPT_FILE = "tool-schema-revalidation.json";

export interface ToolSchemaRevalidationReceipt {
  schemaVersion: 1;
  observedAt: string;
  schemaRevision: string;
  runtimeToolSchemaRevision: string | null;
  runtimeHostCatalogRevision: string | null;
  runtimeFingerprint: string | null;
  clientSchemaRevision: string | null;
  staleClientRevision: boolean;
}

export type ToolSchemaRecoveryMode = "named-tools-preferred" | "stable-dispatcher-preferred";

export interface ToolSchemaRecoveryPlan {
  mode: ToolSchemaRecoveryMode;
  reason:
    | "no-applied-schema-change"
    | "latest-schema-change-is-not-current-runtime"
    | "runtime-schema-changed-awaiting-tools-list"
    | "post-apply-tools-list-observed"
    | "post-apply-host-catalog-rebind-observed";
  toolSchemaChanged: boolean;
  toolListRefreshObserved: boolean | null;
  preferredExecution: "named-tool" | "c2ct_invoke";
  liveSchemaTool: "tool_schema_get";
  stableDispatcherTool: "c2ct_invoke";
  runtimeToolSchemaRevision: string | null;
  runtimeHostCatalogRevision: string | null;
  runtimeFingerprint: string | null;
  lastObservedCanonicalSchemaRevision: string | null;
  lastObservedAt: string | null;
  hostCatalogRebindVerified: boolean | null;
  hostCatalogRefresh: {
    surface: "host-app-server";
    method: "app/installed";
    forceRefresh: true;
    requiresFreshChatVerification: false;
    connectorReregistrationRequired: false;
  };
  instruction: string;
}

export interface ToolSchemaRecoveryState {
  plan: ToolSchemaRecoveryPlan;
  lastRuntimeApply: RuntimeApplyReceipt | null;
  revalidation: ToolSchemaRevalidationReceipt | null;
  hostCatalogRebind: HostCatalogRebindReceipt | null;
}

function receiptPath(stateDir: string): string {
  return path.join(stateDir, "runtime-schema", RECEIPT_FILE);
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && SCHEMA_REVISION_PATTERN.test(value);
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeReceipt(value: unknown): ToolSchemaRevalidationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RECEIPT_SCHEMA_VERSION) return null;
  if (!validIsoTimestamp(record.observedAt) || !validRevision(record.schemaRevision)) return null;
  const runtimeToolSchemaRevision = record.runtimeToolSchemaRevision;
  if (runtimeToolSchemaRevision !== null && !validRevision(runtimeToolSchemaRevision)) return null;
  const runtimeHostCatalogRevision = record.runtimeHostCatalogRevision;
  if (runtimeHostCatalogRevision !== undefined && runtimeHostCatalogRevision !== null && !validRevision(runtimeHostCatalogRevision)) {
    return null;
  }
  const runtimeFingerprint = record.runtimeFingerprint;
  if (runtimeFingerprint !== null && (typeof runtimeFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(runtimeFingerprint))) {
    return null;
  }
  const clientSchemaRevision = record.clientSchemaRevision;
  if (clientSchemaRevision !== null && !validRevision(clientSchemaRevision)) return null;
  if (typeof record.staleClientRevision !== "boolean") return null;
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    observedAt: record.observedAt,
    schemaRevision: record.schemaRevision,
    runtimeToolSchemaRevision,
    runtimeHostCatalogRevision: validRevision(runtimeHostCatalogRevision) ? runtimeHostCatalogRevision : null,
    runtimeFingerprint,
    clientSchemaRevision,
    staleClientRevision: record.staleClientRevision,
  };
}

export async function recordToolSchemaRevalidation(
  stateDir: string,
  input: {
    schemaRevision: string;
    clientSchemaRevision?: string | null;
    staleClientRevision: boolean;
    now?: Date;
  },
): Promise<ToolSchemaRevalidationReceipt | null> {
  if (!validRevision(input.schemaRevision)) return null;
  const runtimeManifest = getRuntimeManifest();
  const directory = path.dirname(receiptPath(stateDir));
  await mkdir(directory, { recursive: true, mode: DIR_MODE });
  await chmod(directory, DIR_MODE).catch(() => undefined);
  const receipt: ToolSchemaRevalidationReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    observedAt: (input.now ?? new Date()).toISOString(),
    schemaRevision: input.schemaRevision,
    runtimeToolSchemaRevision: validRevision(runtimeManifest.toolSchemaRevision)
      ? runtimeManifest.toolSchemaRevision
      : null,
    runtimeHostCatalogRevision: validRevision(runtimeManifest.hostCatalogRevision)
      ? runtimeManifest.hostCatalogRevision
      : null,
    runtimeFingerprint: typeof runtimeManifest.runtimeFingerprint === "string"
      ? runtimeManifest.runtimeFingerprint
      : null,
    clientSchemaRevision: validRevision(input.clientSchemaRevision) ? input.clientSchemaRevision : null,
    staleClientRevision: input.staleClientRevision,
  };
  const target = receiptPath(stateDir);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    await chmod(temporary, FILE_MODE).catch(() => undefined);
    await rename(temporary, target);
    await chmod(target, FILE_MODE).catch(() => undefined);
    return receipt;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readToolSchemaRevalidation(stateDir: string): Promise<ToolSchemaRevalidationReceipt | null> {
  try {
    const parsed = JSON.parse(await readFile(receiptPath(stateDir), "utf8")) as unknown;
    return normalizeReceipt(parsed);
  } catch {
    return null;
  }
}

function manifestCatalogRevision(manifest: RuntimeManifest): string | null {
  return validRevision(manifest.hostCatalogRevision)
    ? manifest.hostCatalogRevision
    : validRevision(manifest.toolSchemaRevision)
      ? manifest.toolSchemaRevision
      : null;
}

function appliedSchemaChange(receipt: RuntimeApplyReceipt | null): boolean {
  const catalogChanged = receipt
    ? manifestCatalogRevision(receipt.previousManifest) !== manifestCatalogRevision(receipt.targetManifest)
    : false;
  const uiResourceChanged = Boolean(
    receipt
    && typeof receipt.previousManifest.uiResourceRevision === "string"
    && typeof receipt.targetManifest.uiResourceRevision === "string"
    && receipt.previousManifest.uiResourceRevision !== receipt.targetManifest.uiResourceRevision,
  );
  return Boolean(
    receipt
    && (receipt.state === "APPLIED" || receipt.state === "ALREADY_APPLIED")
    && (catalogChanged || uiResourceChanged),
  );
}

function applyTargetsCurrentRuntime(receipt: RuntimeApplyReceipt, runtimeManifest: RuntimeManifest): boolean {
  const targetCatalogRevision = manifestCatalogRevision(receipt.targetManifest);
  const runtimeCatalogRevision = manifestCatalogRevision(runtimeManifest);
  if (targetCatalogRevision && runtimeCatalogRevision && targetCatalogRevision !== runtimeCatalogRevision) return false;
  if (receipt.targetManifest.runtimeFingerprint && runtimeManifest.runtimeFingerprint) {
    return receipt.targetManifest.runtimeFingerprint === runtimeManifest.runtimeFingerprint;
  }
  return true;
}

export function toolSchemaRecoveryPlan(input: {
  runtimeManifest: RuntimeManifest;
  lastRuntimeApply: RuntimeApplyReceipt | null;
  revalidation: ToolSchemaRevalidationReceipt | null;
  hostCatalogRebind?: HostCatalogRebindReceipt | null;
}): ToolSchemaRecoveryPlan {
  const { runtimeManifest, lastRuntimeApply, revalidation, hostCatalogRebind = null } = input;
  const toolSchemaChanged = appliedSchemaChange(lastRuntimeApply);
  const applyTargetsCurrent = Boolean(
    lastRuntimeApply && applyTargetsCurrentRuntime(lastRuntimeApply, runtimeManifest),
  );
  const applyAt = lastRuntimeApply ? Date.parse(lastRuntimeApply.updatedAt) : Number.NaN;
  const rebindObservedAt = hostCatalogRebind ? Date.parse(hostCatalogRebind.observedAt) : Number.NaN;
  const refreshCompletedAt = lastRuntimeApply?.hostCatalogRefreshCompletedAt
    ? Date.parse(lastRuntimeApply.hostCatalogRefreshCompletedAt)
    : Number.NaN;
  const hostCatalogRebindVerified = hostCatalogRebind && applyTargetsCurrent
    ? Boolean(
      lastRuntimeApply
      && lastRuntimeApply.hostCatalogRefreshAttempted === true
      && lastRuntimeApply.hostCatalogRefreshRequested === true
      && lastRuntimeApply.hostCatalogScanCompleted === true
      && Number.isFinite(applyAt)
      && Number.isFinite(refreshCompletedAt)
      && Number.isFinite(rebindObservedAt)
      && refreshCompletedAt >= applyAt
      && rebindObservedAt >= refreshCompletedAt
      && hostCatalogRebind.runtimeHostCatalogRevision === runtimeManifest.hostCatalogRevision
      && hostCatalogRebind.runtimeFingerprint === runtimeManifest.runtimeFingerprint,
    )
    : null;
  const base = {
    toolSchemaChanged,
    liveSchemaTool: "tool_schema_get" as const,
    stableDispatcherTool: "c2ct_invoke" as const,
    runtimeToolSchemaRevision: runtimeManifest.toolSchemaRevision,
    runtimeHostCatalogRevision: runtimeManifest.hostCatalogRevision ?? null,
    runtimeFingerprint: runtimeManifest.runtimeFingerprint,
    lastObservedCanonicalSchemaRevision: revalidation?.schemaRevision ?? null,
    lastObservedAt: revalidation?.observedAt ?? null,
    hostCatalogRebindVerified,
    hostCatalogRefresh: {
      surface: "host-app-server" as const,
      method: "app/installed" as const,
      forceRefresh: true as const,
      requiresFreshChatVerification: false as const,
      connectorReregistrationRequired: false as const,
    },
  };

  if (!lastRuntimeApply || !toolSchemaChanged) {
    return {
      ...base,
      mode: "named-tools-preferred",
      reason: "no-applied-schema-change",
      toolListRefreshObserved: null,
      preferredExecution: "named-tool",
      instruction: "Use named tools normally. If the host catalog is stale while tool_schema_get shows the current live schema, refresh the host connector runtime snapshot with app/installed(forceRefresh=true), then re-query the direct named mount in the current chat. A successful catalog refresh can update the current chat; use a fresh chat only as a fallback when the current host mount still remains stale. Refresh plugin/package inventory separately only when plugin metadata itself changed. Until host convergence, recover backend operations through tool_schema_get + c2ct_invoke without re-registering the connector. Widget/approval presenter exception: never use c2ct_invoke to render or validate ChatGPT widget UI, approval cards, outputTemplate/resource mounts, or host confirmation UI; those require the dedicated direct named presenter/tool surface because generic dispatch does not reproduce the host's static tool metadata mount.",
    };
  }

  if (!applyTargetsCurrent) {
    return {
      ...base,
      mode: "named-tools-preferred",
      reason: "latest-schema-change-is-not-current-runtime",
      toolListRefreshObserved: null,
      preferredExecution: "named-tool",
      instruction: "The latest schema-changing apply does not describe this runtime. Prefer named tools, but if host catalog evidence disagrees with live tool_schema_get, refresh the host connector runtime snapshot with app/installed(forceRefresh=true) and re-query the direct named mount in the current chat. A fresh chat is fallback verification only when the current host mount does not update. Keep c2ct_invoke as the backend host-schema fallback and do not re-register the connector. Widget/approval presenter exception: never use c2ct_invoke to render or validate ChatGPT widget UI, approval cards, outputTemplate/resource mounts, or host confirmation UI; those require the dedicated direct named presenter/tool surface because generic dispatch does not reproduce the host's static tool metadata mount.",
    };
  }

  if (hostCatalogRebindVerified) {
    return {
      ...base,
      mode: "named-tools-preferred",
      reason: "post-apply-host-catalog-rebind-observed",
      toolListRefreshObserved: false,
      preferredExecution: "named-tool",
      instruction: "The bounded post-apply host catalog refresh completed and a direct named catalog marker was then invoked against the same runtime fingerprint and host-catalog revision. Treat the current chat named-tool mount as rebound even if a separate tools/list observation has not been recorded. Keep c2ct_invoke only as a backend fallback if a later named call is rejected. Widget/approval presenters must continue to use their dedicated direct named surface.",
    };
  }

  const observedAt = revalidation ? Date.parse(revalidation.observedAt) : Number.NaN;
  const toolListRefreshObserved = Boolean(
    revalidation
    && !revalidation.staleClientRevision
    && Number.isFinite(applyAt)
    && Number.isFinite(observedAt)
    && observedAt >= applyAt
    && revalidation.runtimeToolSchemaRevision === runtimeManifest.toolSchemaRevision
    && (
      !runtimeManifest.hostCatalogRevision
      || revalidation.runtimeHostCatalogRevision === runtimeManifest.hostCatalogRevision
    )
    && (
      !runtimeManifest.runtimeFingerprint
      || revalidation.runtimeFingerprint === runtimeManifest.runtimeFingerprint
    ),
  );

  if (toolListRefreshObserved) {
    return {
      ...base,
      mode: "named-tools-preferred",
      reason: "post-apply-tools-list-observed",
      toolListRefreshObserved: true,
      preferredExecution: "named-tool",
      instruction: "A current tools/list response was served after the schema-changing runtime apply, but this does not prove that the ChatGPT host rebound its mounted catalog. Prefer named tools only when the direct host mount is present; otherwise refresh the host connector runtime snapshot with app/installed(forceRefresh=true), then re-query the direct named mount in the current chat. Use a fresh chat only if the current host mount remains stale. Use c2ct_invoke only as the backend correctness fallback while the host catalog is stale. Widget/approval presenter exception: never use c2ct_invoke to render or validate ChatGPT widget UI, approval cards, outputTemplate/resource mounts, or host confirmation UI; those require the dedicated direct named presenter/tool surface.",
    };
  }

  return {
    ...base,
    mode: "stable-dispatcher-preferred",
    reason: "runtime-schema-changed-awaiting-tools-list",
    toolListRefreshObserved: false,
    preferredExecution: "c2ct_invoke",
    instruction: "The runtime schema changed and no current post-apply tools/list fetch has been observed. Refresh the host connector runtime snapshot with app/installed(forceRefresh=true), then re-query the direct named mount in the current chat. A successful catalog refresh can update the current chat; use a fresh chat only as fallback when the current host mount remains stale. Refresh plugin/package inventory separately only when plugin metadata itself changed. Until host convergence, route backend-safe public operations through stable c2ct_invoke. Widget/approval presenter exception: never use c2ct_invoke to render or validate ChatGPT widget UI, approval cards, outputTemplate/resource mounts, or host confirmation UI; those require the dedicated direct named presenter/tool surface. If c2ct_invoke refuses a target because that named tool requires host confirmation, do not bypass the boundary. Do not re-register the bare /mcp connector.",
  };
}

export async function readToolSchemaRecoveryState(
  stateDir: string,
  runtimeManifest: RuntimeManifest = getRuntimeManifest(),
): Promise<ToolSchemaRecoveryState> {
  const [lastRuntimeApply, revalidation, hostCatalogRebind] = await Promise.all([
    getLatestAppliedSchemaChangingRuntimeApplyReceipt(stateDir).catch(() => null),
    readToolSchemaRevalidation(stateDir),
    readHostCatalogRebind(stateDir),
  ]);
  return {
    plan: toolSchemaRecoveryPlan({ runtimeManifest, lastRuntimeApply, revalidation, hostCatalogRebind }),
    lastRuntimeApply,
    revalidation,
    hostCatalogRebind,
  };
}
