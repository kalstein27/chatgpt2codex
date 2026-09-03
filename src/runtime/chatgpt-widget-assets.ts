import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

export const CHATGPT_WIDGET_ASSET_SCHEMA_VERSION = 1;
export const CHATGPT_WIDGET_ASSET_MAX_BYTES = 512 * 1024;
export const CHATGPT_WIDGET_BUILD_HTML_RELATIVE_PATH = path.join(
  "dist",
  "server",
  "chatgpt-consent-widget.asset.html",
);
export const CHATGPT_WIDGET_BUILD_META_RELATIVE_PATH = path.join(
  "dist",
  "server",
  "chatgpt-consent-widget.asset.json",
);

export interface ChatGptWidgetAssetMeta {
  schemaVersion: 1;
  protocolVersion: number;
  revision: string;
  bytes: number;
  builtAt: string;
}

export interface ActiveChatGptWidgetAsset extends ChatGptWidgetAssetMeta {
  html: string;
  source: "active" | "bundled";
}

function revisionForHtml(html: string): string {
  return `sha256:${createHash("sha256").update(html, "utf8").digest("hex")}`;
}

function assertWidgetHtml(html: string): void {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes <= 0 || bytes > CHATGPT_WIDGET_ASSET_MAX_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, "ChatGPT widget asset size is outside the allowed range", {
      bytes,
      maxBytes: CHATGPT_WIDGET_ASSET_MAX_BYTES,
    });
  }
  if (html.includes("\0")) {
    throw new DomainError(ErrorCode.NULLBYTE_REJECTED, "ChatGPT widget asset contains a null byte");
  }
  if (!/^<!doctype html>/iu.test(html.trimStart()) || !html.includes('id="approval"') || !html.includes("<script>")) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "ChatGPT widget asset does not match the expected approval-card document shape");
  }
}

function parseAssetMeta(raw: string): ChatGptWidgetAssetMeta {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "ChatGPT widget asset metadata is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "ChatGPT widget asset metadata must be an object");
  }
  const meta = value as Partial<ChatGptWidgetAssetMeta>;
  if (
    meta.schemaVersion !== CHATGPT_WIDGET_ASSET_SCHEMA_VERSION ||
    !Number.isInteger(meta.protocolVersion) ||
    typeof meta.revision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(meta.revision) ||
    !Number.isInteger(meta.bytes) ||
    typeof meta.builtAt !== "string"
  ) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "ChatGPT widget asset metadata has an invalid shape");
  }
  return meta as ChatGptWidgetAssetMeta;
}

async function writeAtomic(filePath: string, data: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { encoding: "utf8", mode: 0o600 });
  await rename(temp, filePath);
}

export async function emitCandidateChatGptWidgetAsset(options: {
  projectRoot: string;
  html: string;
  protocolVersion: number;
}): Promise<ChatGptWidgetAssetMeta> {
  assertWidgetHtml(options.html);
  const meta: ChatGptWidgetAssetMeta = {
    schemaVersion: CHATGPT_WIDGET_ASSET_SCHEMA_VERSION,
    protocolVersion: options.protocolVersion,
    revision: revisionForHtml(options.html),
    bytes: Buffer.byteLength(options.html, "utf8"),
    builtAt: new Date().toISOString(),
  };
  await writeAtomic(path.join(options.projectRoot, CHATGPT_WIDGET_BUILD_HTML_RELATIVE_PATH), options.html);
  await writeAtomic(
    path.join(options.projectRoot, CHATGPT_WIDGET_BUILD_META_RELATIVE_PATH),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  return meta;
}

function activeAssetRoot(stateDir: string): string {
  return path.join(stateDir, "chatgpt-widget-assets", "consent");
}

function activePointerPath(stateDir: string): string {
  return path.join(activeAssetRoot(stateDir), "current.json");
}

function activeRevisionPath(stateDir: string, revision: string): string {
  return path.join(activeAssetRoot(stateDir), "assets", `${revision.slice("sha256:".length)}.html`);
}

async function readCandidateAsset(projectRoot: string): Promise<{ html: string; meta: ChatGptWidgetAssetMeta }> {
  const [html, rawMeta] = await Promise.all([
    readFile(path.join(projectRoot, CHATGPT_WIDGET_BUILD_HTML_RELATIVE_PATH), "utf8"),
    readFile(path.join(projectRoot, CHATGPT_WIDGET_BUILD_META_RELATIVE_PATH), "utf8"),
  ]).catch((error: unknown) => {
    throw new DomainError(ErrorCode.FILE_NOT_FOUND, "Built ChatGPT widget asset is missing; run the verified project build first", {
      cause: error instanceof Error ? error.name : "unknown",
      recommendedAction: "npm:build",
    });
  });
  assertWidgetHtml(html);
  const meta = parseAssetMeta(rawMeta);
  const observedRevision = revisionForHtml(html);
  const observedBytes = Buffer.byteLength(html, "utf8");
  if (meta.revision !== observedRevision || meta.bytes !== observedBytes) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "Built ChatGPT widget asset does not match its metadata", {
      expectedRevision: meta.revision,
      observedRevision,
      expectedBytes: meta.bytes,
      observedBytes,
    });
  }
  return { html, meta };
}

export async function applyCandidateChatGptWidgetAsset(options: {
  projectRoot: string;
  stateDir: string;
  supportedProtocolVersion: number;
}): Promise<ChatGptWidgetAssetMeta> {
  const candidate = await readCandidateAsset(options.projectRoot);
  if (candidate.meta.protocolVersion !== options.supportedProtocolVersion) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Widget asset protocol differs from the live runtime; apply the matching runtime before hot-applying this UI", {
      candidateProtocolVersion: candidate.meta.protocolVersion,
      supportedProtocolVersion: options.supportedProtocolVersion,
      recommendedAction: "runtime-update-required",
    });
  }

  const revisionPath = activeRevisionPath(options.stateDir, candidate.meta.revision);
  await writeAtomic(revisionPath, candidate.html);
  await writeAtomic(
    activePointerPath(options.stateDir),
    `${JSON.stringify({ ...candidate.meta, appliedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return candidate.meta;
}

export async function readActiveChatGptWidgetAsset(options: {
  stateDir: string;
  supportedProtocolVersion: number;
  fallbackHtml: string;
}): Promise<ActiveChatGptWidgetAsset> {
  try {
    const rawMeta = await readFile(activePointerPath(options.stateDir), "utf8");
    const meta = parseAssetMeta(rawMeta);
    if (meta.protocolVersion !== options.supportedProtocolVersion) throw new Error("protocol-mismatch");
    const html = await readFile(activeRevisionPath(options.stateDir, meta.revision), "utf8");
    assertWidgetHtml(html);
    if (revisionForHtml(html) !== meta.revision || Buffer.byteLength(html, "utf8") !== meta.bytes) {
      throw new Error("revision-mismatch");
    }
    return { ...meta, html, source: "active" };
  } catch {
    assertWidgetHtml(options.fallbackHtml);
    return {
      schemaVersion: CHATGPT_WIDGET_ASSET_SCHEMA_VERSION,
      protocolVersion: options.supportedProtocolVersion,
      revision: revisionForHtml(options.fallbackHtml),
      bytes: Buffer.byteLength(options.fallbackHtml, "utf8"),
      builtAt: "bundled",
      html: options.fallbackHtml,
      source: "bundled",
    };
  }
}
