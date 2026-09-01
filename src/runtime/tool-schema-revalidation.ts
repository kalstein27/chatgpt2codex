import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntimeManifest, type RuntimeManifest } from "./runtime-manifest.js";
import { getLatestRuntimeApplyReceipt, type RuntimeApplyReceipt } from "./runtime-apply.js";

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
    | "post-apply-tools-list-observed";
  toolSchemaChanged: boolean;
  toolListRefreshObserved: boolean | null;
  preferredExecution: "named-tool" | "c2ct_invoke";
  liveSchemaTool: "tool_schema_get";
  stableDispatcherTool: "c2ct_invoke";
  runtimeToolSchemaRevision: string | null;
  runtimeFingerprint: string | null;
  lastObservedCanonicalSchemaRevision: string | null;
  lastObservedAt: string | null;
  instruction: string;
}

export interface ToolSchemaRecoveryState {
  plan: ToolSchemaRecoveryPlan;
  lastRuntimeApply: RuntimeApplyReceipt | null;
  revalidation: ToolSchemaRevalidationReceipt | null;
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

function appliedSchemaChange(receipt: RuntimeApplyReceipt | null): boolean {
  return Boolean(
    receipt
    && (receipt.state === "APPLIED" || receipt.state === "ALREADY_APPLIED")
    && receipt.previousManifest.toolSchemaRevision !== receipt.targetManifest.toolSchemaRevision,
  );
}

function applyTargetsCurrentRuntime(receipt: RuntimeApplyReceipt, runtimeManifest: RuntimeManifest): boolean {
  if (receipt.targetManifest.toolSchemaRevision !== runtimeManifest.toolSchemaRevision) return false;
  if (receipt.targetManifest.runtimeFingerprint && runtimeManifest.runtimeFingerprint) {
    return receipt.targetManifest.runtimeFingerprint === runtimeManifest.runtimeFingerprint;
  }
  return true;
}

export function toolSchemaRecoveryPlan(input: {
  runtimeManifest: RuntimeManifest;
  lastRuntimeApply: RuntimeApplyReceipt | null;
  revalidation: ToolSchemaRevalidationReceipt | null;
}): ToolSchemaRecoveryPlan {
  const { runtimeManifest, lastRuntimeApply, revalidation } = input;
  const toolSchemaChanged = appliedSchemaChange(lastRuntimeApply);
  const base = {
    toolSchemaChanged,
    liveSchemaTool: "tool_schema_get" as const,
    stableDispatcherTool: "c2ct_invoke" as const,
    runtimeToolSchemaRevision: runtimeManifest.toolSchemaRevision,
    runtimeFingerprint: runtimeManifest.runtimeFingerprint,
    lastObservedCanonicalSchemaRevision: revalidation?.schemaRevision ?? null,
    lastObservedAt: revalidation?.observedAt ?? null,
  };

  if (!lastRuntimeApply || !toolSchemaChanged) {
    return {
      ...base,
      mode: "named-tools-preferred",
      reason: "no-applied-schema-change",
      toolListRefreshObserved: null,
      preferredExecution: "named-tool",
      instruction: "Use named tools normally. If host-side schema validation still fails before runtime dispatch, recover through tool_schema_get + c2ct_invoke without re-registering the connector. Widget/approval presenter exception: never use c2ct_invoke to render or validate ChatGPT widget UI, approval cards, outputTemplate/resource mounts, or host confirmation UI; those require the dedicated direct named presenter/tool surface because generic dispatch does not reproduce the host's static tool metadata mount.",
    };
  }

  if (!applyTargetsCurrentRuntime(lastRuntimeApply, runtimeManifest)) {
    return {
      ...base,
      mode: "named-tools-preferred",
      reason: "latest-schema-change-is-not-current-runtime",
      toolListRefreshObserved: null,
      preferredExecution: "named-tool",
      instruction: "The latest schema-changing apply does not describe this runtime. Prefer named tools and keep c2ct_invoke as the host-schema fallback. Widget/approval presenter exception: never use c2ct_invoke to render or validate ChatGPT widget UI, approval cards, outputTemplate/resource mounts, or host confirmation UI; those require the dedicated direct named presenter/tool surface because generic dispatch does not reproduce the host's static tool metadata mount.",
    };
  }

  const applyAt = Date.parse(lastRuntimeApply.updatedAt);
  const observedAt = revalidation ? Date.parse(revalidation.observedAt) : Number.NaN;
  const toolListRefreshObserved = Boolean(
    revalidation
    && Number.isFinite(applyAt)
    && Number.isFinite(observedAt)
    && observedAt >= applyAt
    && revalidation.runtimeToolSchemaRevision === runtimeManifest.toolSchemaRevision
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
      instruction: "A current tools/list response was served after the schema-changing runtime apply. Prefer named tools; if the host still rejects a named call before runtime dispatch, use c2ct_invoke as the correctness fallback. Widget/approval presenter exception: never use c2ct_invoke to render or validate ChatGPT widget UI, approval cards, outputTemplate/resource mounts, or host confirmation UI; those require the dedicated direct named presenter/tool surface because generic dispatch does not reproduce the host's static tool metadata mount.",
    };
  }

  return {
    ...base,
    mode: "stable-dispatcher-preferred",
    reason: "runtime-schema-changed-awaiting-tools-list",
    toolListRefreshObserved: false,
    preferredExecution: "c2ct_invoke",
    instruction: "The runtime schema changed and no current post-apply tools/list fetch has been observed. After bootstrap, route public operations through stable c2ct_invoke by default until connection_status reports named-tools-preferred. Widget/approval presenter exception: never use c2ct_invoke to render or validate ChatGPT widget UI, approval cards, outputTemplate/resource mounts, or host confirmation UI; those require the dedicated direct named presenter/tool surface because generic dispatch does not reproduce the host's static tool metadata mount. If c2ct_invoke refuses a target because that named tool requires host confirmation, do not bypass the boundary; use the dedicated named surface once the host catalog supports it. Do not re-register the bare /mcp connector.",
  };
}

export async function readToolSchemaRecoveryState(
  stateDir: string,
  runtimeManifest: RuntimeManifest = getRuntimeManifest(),
): Promise<ToolSchemaRecoveryState> {
  const [lastRuntimeApply, revalidation] = await Promise.all([
    getLatestRuntimeApplyReceipt(stateDir).catch(() => null),
    readToolSchemaRevalidation(stateDir),
  ]);
  return {
    plan: toolSchemaRecoveryPlan({ runtimeManifest, lastRuntimeApply, revalidation }),
    lastRuntimeApply,
    revalidation,
  };
}
