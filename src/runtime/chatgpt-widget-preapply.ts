import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeManifest } from "./runtime-manifest.js";
import { getRuntimeManifestForRoot } from "./runtime-manifest.js";
import { CHATGPT_WIDGET_BUILD_META_RELATIVE_PATH } from "./chatgpt-widget-assets.js";

export const CHATGPT_WIDGET_PREAPPLY_SCHEMA_VERSION = 1 as const;
export const CHATGPT_WIDGET_PREAPPLY_BUILD_RECEIPT_RELATIVE_PATH = path.join(
  "dist",
  "runtime",
  "chatgpt-widget-preapply.receipt",
);

export const CHATGPT_WIDGET_PREAPPLY_REQUIRED_CHECKS = [
  "widget-parser",
  "targeted-regression",
  "typecheck",
  "full-test",
  "build",
  "diff-check",
] as const;

type RequiredCheck = (typeof CHATGPT_WIDGET_PREAPPLY_REQUIRED_CHECKS)[number];

export interface ChatGptWidgetPreapplyBuildReceipt {
  schemaVersion: typeof CHATGPT_WIDGET_PREAPPLY_SCHEMA_VERSION;
  candidateFingerprint: string;
  uiResourceRevision: string;
  widgetAssetRevision: string;
  checks: RequiredCheck[];
  verifiedAt: string;
}

interface ChatGptWidgetPreapplyStage {
  schemaVersion: typeof CHATGPT_WIDGET_PREAPPLY_SCHEMA_VERSION;
  projectId: string;
  candidateFingerprint: string;
  uiResourceRevision: string;
  widgetAssetRevision: string;
  stagedAt: string;
}

export interface ChatGptWidgetPreapplyRenderProof extends ChatGptWidgetPreapplyStage {
  evidence?: "probe-decision" | "asset-load";
  probeRequestId?: string;
  decision?: "allow" | "deny";
  renderedAt: string;
}

export interface ChatGptWidgetPreapplyGateInspection {
  required: boolean;
  ready: boolean;
  automaticChecksPassed: boolean;
  harmlessRenderPassed: boolean;
  reason: string;
  recommendedAction: "none" | "run-widget-preapply-checks" | "hot-apply-and-render-harmless-probe";
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^sha256:[a-f0-9]{24,64}$/u;
const CONSENT_REQUEST_PATTERN = /^consent_[0-9a-fA-F-]{36}$/u;

function preapplyRoot(stateDir: string): string {
  return path.join(stateDir, "chatgpt-widget-preapply");
}

function stagePath(stateDir: string): string {
  return path.join(preapplyRoot(stateDir), "staged.json");
}

function proofPath(stateDir: string, candidateFingerprint: string): string {
  return path.join(preapplyRoot(stateDir), "proofs", `${candidateFingerprint}.json`);
}

async function writeAtomic(filePath: string, data: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function exactChecks(value: unknown): value is RequiredCheck[] {
  return Array.isArray(value)
    && value.length === CHATGPT_WIDGET_PREAPPLY_REQUIRED_CHECKS.length
    && CHATGPT_WIDGET_PREAPPLY_REQUIRED_CHECKS.every((check, index) => value[index] === check);
}

function parseBuildReceipt(raw: string): ChatGptWidgetPreapplyBuildReceipt | null {
  const value = parseObject(raw);
  if (!value) return null;
  if (
    value.schemaVersion !== CHATGPT_WIDGET_PREAPPLY_SCHEMA_VERSION
    || typeof value.candidateFingerprint !== "string"
    || !SHA256_PATTERN.test(value.candidateFingerprint)
    || typeof value.uiResourceRevision !== "string"
    || !REVISION_PATTERN.test(value.uiResourceRevision)
    || typeof value.widgetAssetRevision !== "string"
    || !REVISION_PATTERN.test(value.widgetAssetRevision)
    || !exactChecks(value.checks)
    || typeof value.verifiedAt !== "string"
    || !Number.isFinite(Date.parse(value.verifiedAt))
  ) return null;
  return value as unknown as ChatGptWidgetPreapplyBuildReceipt;
}

function parseStage(raw: string): ChatGptWidgetPreapplyStage | null {
  const value = parseObject(raw);
  if (!value) return null;
  if (
    value.schemaVersion !== CHATGPT_WIDGET_PREAPPLY_SCHEMA_VERSION
    || typeof value.projectId !== "string"
    || value.projectId.length === 0
    || typeof value.candidateFingerprint !== "string"
    || !SHA256_PATTERN.test(value.candidateFingerprint)
    || typeof value.uiResourceRevision !== "string"
    || !REVISION_PATTERN.test(value.uiResourceRevision)
    || typeof value.widgetAssetRevision !== "string"
    || !REVISION_PATTERN.test(value.widgetAssetRevision)
    || typeof value.stagedAt !== "string"
    || !Number.isFinite(Date.parse(value.stagedAt))
  ) return null;
  return value as unknown as ChatGptWidgetPreapplyStage;
}

function parseProof(raw: string): ChatGptWidgetPreapplyRenderProof | null {
  const value = parseObject(raw);
  if (!value) return null;
  const stage = parseStage(raw);
  if (!stage) return null;
  const evidence = value.evidence === "asset-load" ? "asset-load" : "probe-decision";
  if (evidence === "probe-decision") {
    if (
      typeof value.probeRequestId !== "string"
      || !CONSENT_REQUEST_PATTERN.test(value.probeRequestId)
      || (value.decision !== "allow" && value.decision !== "deny")
    ) return null;
  } else if (value.probeRequestId !== undefined || value.decision !== undefined) {
    return null;
  }
  if (typeof value.renderedAt !== "string" || !Number.isFinite(Date.parse(value.renderedAt))) return null;
  return {
    ...stage,
    evidence,
    ...(evidence === "probe-decision" ? {
      probeRequestId: value.probeRequestId as string,
      decision: value.decision as "allow" | "deny",
    } : {}),
    renderedAt: value.renderedAt,
  };
}

async function readWidgetAssetRevision(runtimeRoot: string): Promise<string | null> {
  const raw = await readFile(path.join(runtimeRoot, CHATGPT_WIDGET_BUILD_META_RELATIVE_PATH), "utf8").catch(() => null);
  if (!raw) return null;
  const value = parseObject(raw);
  const revision = value?.revision;
  return typeof revision === "string" && /^sha256:[a-f0-9]{64}$/u.test(revision) ? revision : null;
}

export async function readChatGptWidgetPreapplyBuildReceipt(
  runtimeRoot: string,
): Promise<ChatGptWidgetPreapplyBuildReceipt | null> {
  const raw = await readFile(path.join(runtimeRoot, CHATGPT_WIDGET_PREAPPLY_BUILD_RECEIPT_RELATIVE_PATH), "utf8")
    .catch(() => null);
  return raw ? parseBuildReceipt(raw) : null;
}

export async function sealChatGptWidgetPreapplyBuildReceipt(projectRoot: string): Promise<ChatGptWidgetPreapplyBuildReceipt> {
  const manifest = getRuntimeManifestForRoot(projectRoot);
  if (!manifest.buildFingerprint || !SHA256_PATTERN.test(manifest.buildFingerprint)) {
    throw new Error("Widget pre-apply receipt requires a sealed candidate build fingerprint");
  }
  if (!manifest.uiResourceRevision || !REVISION_PATTERN.test(manifest.uiResourceRevision)) {
    throw new Error("Widget pre-apply receipt requires a sealed UI resource revision");
  }
  const widgetAssetRevision = await readWidgetAssetRevision(projectRoot);
  if (!widgetAssetRevision) {
    throw new Error("Widget pre-apply receipt requires the built approval-card asset metadata");
  }
  const receipt: ChatGptWidgetPreapplyBuildReceipt = {
    schemaVersion: CHATGPT_WIDGET_PREAPPLY_SCHEMA_VERSION,
    candidateFingerprint: manifest.buildFingerprint,
    uiResourceRevision: manifest.uiResourceRevision,
    widgetAssetRevision,
    checks: [...CHATGPT_WIDGET_PREAPPLY_REQUIRED_CHECKS],
    verifiedAt: new Date().toISOString(),
  };
  await writeAtomic(
    path.join(projectRoot, CHATGPT_WIDGET_PREAPPLY_BUILD_RECEIPT_RELATIVE_PATH),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

async function validatedBuildReceipt(runtimeRoot: string, manifest: RuntimeManifest): Promise<ChatGptWidgetPreapplyBuildReceipt | null> {
  const receipt = await readChatGptWidgetPreapplyBuildReceipt(runtimeRoot);
  if (!receipt || !manifest.buildFingerprint || !manifest.uiResourceRevision) return null;
  const widgetAssetRevision = await readWidgetAssetRevision(runtimeRoot);
  if (!widgetAssetRevision) return null;
  return receipt.candidateFingerprint === manifest.buildFingerprint
    && receipt.uiResourceRevision === manifest.uiResourceRevision
    && receipt.widgetAssetRevision === widgetAssetRevision
    ? receipt
    : null;
}

export async function stageChatGptWidgetPreapplyRenderCandidate(input: {
  stateDir: string;
  projectId: string;
  projectRoot: string;
  appliedWidgetAssetRevision: string;
}): Promise<ChatGptWidgetPreapplyStage | null> {
  const manifest = getRuntimeManifestForRoot(input.projectRoot);
  const receipt = await validatedBuildReceipt(input.projectRoot, manifest);
  if (!receipt || receipt.widgetAssetRevision !== input.appliedWidgetAssetRevision) return null;
  const stage: ChatGptWidgetPreapplyStage = {
    schemaVersion: CHATGPT_WIDGET_PREAPPLY_SCHEMA_VERSION,
    projectId: input.projectId,
    candidateFingerprint: receipt.candidateFingerprint,
    uiResourceRevision: receipt.uiResourceRevision,
    widgetAssetRevision: receipt.widgetAssetRevision,
    stagedAt: new Date().toISOString(),
  };
  await writeAtomic(stagePath(input.stateDir), `${JSON.stringify(stage, null, 2)}\n`);
  return stage;
}

export async function recordChatGptWidgetPreapplyRenderProof(input: {
  stateDir: string;
  probeRequestId: string;
  decision: "allow" | "deny";
}): Promise<ChatGptWidgetPreapplyRenderProof | null> {
  if (!CONSENT_REQUEST_PATTERN.test(input.probeRequestId)) return null;
  const raw = await readFile(stagePath(input.stateDir), "utf8").catch(() => null);
  const stage = raw ? parseStage(raw) : null;
  if (!stage) return null;
  const proof = {
    ...stage,
    evidence: "probe-decision" as const,
    probeRequestId: input.probeRequestId,
    decision: input.decision,
    renderedAt: new Date().toISOString(),
  };
  await writeAtomic(proofPath(input.stateDir, stage.candidateFingerprint), `${JSON.stringify(proof, null, 2)}\n`);
  return proof;
}

export async function recordChatGptWidgetPreapplyAssetLoad(input: {
  stateDir: string;
  widgetAssetRevision: string;
}): Promise<boolean> {
  if (!REVISION_PATTERN.test(input.widgetAssetRevision)) return false;
  const raw = await readFile(stagePath(input.stateDir), "utf8").catch(() => null);
  const stage = raw ? parseStage(raw) : null;
  if (!stage || stage.widgetAssetRevision !== input.widgetAssetRevision) return false;
  const proof = {
    ...stage,
    evidence: "asset-load" as const,
    renderedAt: new Date().toISOString(),
  };
  await writeAtomic(proofPath(input.stateDir, stage.candidateFingerprint), `${JSON.stringify(proof, null, 2)}\n`);
  return true;
}

async function readRenderProof(stateDir: string, candidateFingerprint: string): Promise<ChatGptWidgetPreapplyRenderProof | null> {
  const raw = await readFile(proofPath(stateDir, candidateFingerprint), "utf8").catch(() => null);
  return raw ? parseProof(raw) : null;
}

export async function inspectChatGptWidgetPreapplyGate(input: {
  stateDir: string;
  projectId: string;
  targetRuntimeRoot: string;
  currentManifest: RuntimeManifest;
  targetManifest: RuntimeManifest;
}): Promise<ChatGptWidgetPreapplyGateInspection> {
  const targetUiRevision = input.targetManifest.uiResourceRevision;
  const required = Boolean(targetUiRevision && targetUiRevision !== input.currentManifest.uiResourceRevision);
  if (!required) {
    return {
      required: false,
      ready: true,
      automaticChecksPassed: true,
      harmlessRenderPassed: true,
      reason: "ui-resource-unchanged",
      recommendedAction: "none",
    };
  }

  const receipt = await validatedBuildReceipt(input.targetRuntimeRoot, input.targetManifest);
  if (!receipt) {
    return {
      required: true,
      ready: false,
      automaticChecksPassed: false,
      harmlessRenderPassed: false,
      reason: "verified-build-receipt-missing-or-stale",
      recommendedAction: "run-widget-preapply-checks",
    };
  }

  const proof = await readRenderProof(input.stateDir, receipt.candidateFingerprint);
  const harmlessRenderPassed = Boolean(
    proof
    && proof.projectId === input.projectId
    && proof.uiResourceRevision === receipt.uiResourceRevision
    && proof.widgetAssetRevision === receipt.widgetAssetRevision,
  );
  return {
    required: true,
    ready: harmlessRenderPassed,
    automaticChecksPassed: true,
    harmlessRenderPassed,
    reason: harmlessRenderPassed ? "verified" : "harmless-real-render-proof-missing",
    recommendedAction: harmlessRenderPassed ? "none" : "hot-apply-and-render-harmless-probe",
  };
}
