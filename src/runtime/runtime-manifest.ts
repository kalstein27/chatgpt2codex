import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface RuntimeManifest {
  schemaVersion: typeof RUNTIME_MANIFEST_SCHEMA_VERSION;
  packageVersion: string;
  sourceRevision: string | null;
  sourceFingerprint: string | null;
  buildFingerprint: string | null;
  runtimeFingerprint: string | null;
  buildTimestamp: string | null;
  cliSha256: string | null;
  toolSchemaRevision: string | null;
  uiResourceRevision: string | null;
  nodeVersion: string;
  runtimeSnapshotId: string | null;
  runtimeRoot: string;
  platform: NodeJS.Platform;
  architecture: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;
const TOOL_SCHEMA_REVISION_PATTERN = /^sha256:[a-f0-9]{24}$/u;
const SNAPSHOT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SEALED_MANIFEST_RELATIVE_PATH = "dist/runtime-build-manifest.json";

interface SealedRuntimeBuildIdentity {
  schemaVersion: typeof RUNTIME_MANIFEST_SCHEMA_VERSION;
  packageVersion: string;
  sourceRevision: string;
  sourceFingerprint: string;
  buildFingerprint: string;
  runtimeFingerprint: string;
  buildTimestamp: string;
  cliSha256: string;
  toolSchemaRevision: string;
  uiResourceRevision?: string;
  nodeVersion: string;
  runtimeSnapshotId: string;
  platform: NodeJS.Platform;
  architecture: string;
}

let currentRuntimeManifestCache: { runtimeRoot: string; manifest: RuntimeManifest } | null = null;

function inferredRuntimeRoot(): string {
  const configured = process.env.CHATGPT2CODEX_RUNTIME_ROOT?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
}

function collectFiles(root: string, relative: string, predicate: (relativePath: string) => boolean): string[] {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return predicate(relative) ? [relative] : [];
  if (!stat.isDirectory()) return [];
  const result: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
    if (entry.isDirectory()) result.push(...collectFiles(root, child, predicate));
    else if (entry.isFile() && predicate(child)) result.push(child);
  }
  return result;
}

export function fingerprintRuntimeFiles(root: string, relativeFiles: readonly string[]): string | null {
  const normalized = [...new Set(relativeFiles.map((entry) => entry.split(path.sep).join(path.posix.sep)))].sort();
  const existing = normalized.filter((entry) => existsSync(path.join(root, entry)) && statSync(path.join(root, entry)).isFile());
  if (existing.length === 0) return null;
  const hash = createHash("sha256");
  for (const relative of existing) {
    const content = readFileSync(path.join(root, relative));
    hash.update(relative, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(content.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function configuredSourceFingerprint(): string | null {
  const value = process.env.CHATGPT2CODEX_SOURCE_FINGERPRINT?.trim();
  return value && SHA256_PATTERN.test(value) ? value.toLowerCase() : null;
}

function sourceFingerprint(root: string): string | null {
  const configured = configuredSourceFingerprint();
  if (configured) return configured;
  const sourceFiles = collectFiles(root, "src", (entry) =>
    entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.includes("/__tests__/"),
  );
  if (sourceFiles.length === 0) return null;
  const files = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "start-chatgpt.sh",
    "start-chatgpt.ps1",
    "macos/ChatGPTToCodexStatusBar/runtime-updater.swift",
    ...sourceFiles,
  ];
  return fingerprintRuntimeFiles(root, files);
}

function buildFingerprint(root: string): string | null {
  const files = [
    "package.json",
    "package-lock.json",
    ...collectFiles(root, "dist", (entry) =>
      (entry.endsWith(".js") || entry.endsWith(".json")) &&
      !entry.endsWith(".map") &&
      entry !== SEALED_MANIFEST_RELATIVE_PATH,
    ),
  ];
  return fingerprintRuntimeFiles(root, files);
}

function sha256File(file: string): string | null {
  try {
    if (!statSync(file).isFile()) return null;
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function cliSha256(root: string): string | null {
  return sha256File(path.join(root, "dist", "cli.js"));
}

function toolSchemaRevision(root: string): string | null {
  const compiled = [
    "dist/server/tools.js",
    "dist/server/actions.js",
    "dist/server/mcp-discovery.js",
  ];
  const source = [
    "src/server/tools.ts",
    "src/server/actions.ts",
    "src/server/mcp-discovery.ts",
  ];
  const selected = compiled.every((entry) => existsSync(path.join(root, entry))) ? compiled : source;
  const fingerprint = fingerprintRuntimeFiles(root, selected);
  return fingerprint ? `sha256:${fingerprint.slice(0, 24)}` : null;
}

function uiResourceRevision(root: string): string | null {
  const compiled = [
    "dist/server/chatgpt-consent-widget.js",
    "dist/server/chatgpt-widget-capability-lab.js",
  ];
  const source = [
    "src/server/chatgpt-consent-widget.ts",
    "src/server/chatgpt-widget-capability-lab.ts",
  ];
  const selected = compiled.every((entry) => existsSync(path.join(root, entry))) ? compiled : source;
  const fingerprint = fingerprintRuntimeFiles(root, selected);
  return fingerprint ? `sha256:${fingerprint.slice(0, 24)}` : null;
}

function packageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(pkg.version)) {
      return pkg.version;
    }
  } catch {
    // Installed development layouts may omit package.json. Keep status available.
  }
  return "development";
}

function sourceRevision(root: string): string | null {
  const configured = process.env.CHATGPT2CODEX_SOURCE_REVISION;
  if (configured !== undefined) {
    const value = configured.trim();
    return value && /^[a-f0-9]{7,64}$/iu.test(value) ? value.toLowerCase() : null;
  }
  try {
    // execution-capability: git-readonly-argv
    const value = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[a-f0-9]{7,64}$/iu.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

function configuredBuildTimestamp(): string | null {
  const configured = process.env.CHATGPT2CODEX_BUILD_TIMESTAMP?.trim();
  if (configured) {
    const parsed = Date.parse(configured);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH?.trim();
  if (sourceDateEpoch && /^\d{1,12}$/u.test(sourceDateEpoch)) {
    const epochMs = Number(sourceDateEpoch) * 1_000;
    if (Number.isSafeInteger(epochMs)) return new Date(epochMs).toISOString();
  }
  return null;
}

function buildTimestampForSeal(): string {
  return configuredBuildTimestamp() ?? new Date().toISOString();
}

function runtimeSnapshotId(input: {
  packageVersion: string;
  sourceRevision: string | null;
  sourceFingerprint: string | null;
  runtimeFingerprint: string | null;
  cliSha256: string | null;
  toolSchemaRevision: string | null;
  nodeVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
}): string | null {
  if (!input.sourceRevision || !input.sourceFingerprint || !input.runtimeFingerprint || !input.cliSha256 || !input.toolSchemaRevision) {
    return null;
  }
  const canonical = JSON.stringify({
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    packageVersion: input.packageVersion,
    sourceRevision: input.sourceRevision,
    sourceFingerprint: input.sourceFingerprint,
    runtimeFingerprint: input.runtimeFingerprint,
    cliSha256: input.cliSha256,
    toolSchemaRevision: input.toolSchemaRevision,
    nodeVersion: input.nodeVersion,
    platform: input.platform,
    architecture: input.architecture,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function isSealedRuntimeBuildIdentity(value: unknown): value is SealedRuntimeBuildIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SealedRuntimeBuildIdentity>;
  return candidate.schemaVersion === RUNTIME_MANIFEST_SCHEMA_VERSION &&
    typeof candidate.packageVersion === "string" &&
    typeof candidate.sourceRevision === "string" && /^[a-f0-9]{7,64}$/u.test(candidate.sourceRevision) &&
    typeof candidate.sourceFingerprint === "string" && SHA256_PATTERN.test(candidate.sourceFingerprint) &&
    typeof candidate.buildFingerprint === "string" && SHA256_PATTERN.test(candidate.buildFingerprint) &&
    typeof candidate.runtimeFingerprint === "string" && SHA256_PATTERN.test(candidate.runtimeFingerprint) &&
    typeof candidate.buildTimestamp === "string" && Number.isFinite(Date.parse(candidate.buildTimestamp)) &&
    typeof candidate.cliSha256 === "string" && SHA256_PATTERN.test(candidate.cliSha256) &&
    typeof candidate.toolSchemaRevision === "string" && TOOL_SCHEMA_REVISION_PATTERN.test(candidate.toolSchemaRevision) &&
    (candidate.uiResourceRevision === undefined ||
      (typeof candidate.uiResourceRevision === "string" && TOOL_SCHEMA_REVISION_PATTERN.test(candidate.uiResourceRevision))) &&
    typeof candidate.nodeVersion === "string" && /^v\d+\.\d+\.\d+/u.test(candidate.nodeVersion) &&
    typeof candidate.runtimeSnapshotId === "string" && SNAPSHOT_ID_PATTERN.test(candidate.runtimeSnapshotId) &&
    typeof candidate.platform === "string" &&
    typeof candidate.architecture === "string";
}

function readSealedRuntimeBuildIdentity(root: string, observed: {
  packageVersion: string;
  buildFingerprint: string | null;
  cliSha256: string | null;
  toolSchemaRevision: string | null;
  uiResourceRevision: string | null;
}): SealedRuntimeBuildIdentity | null {
  try {
    const candidate = JSON.parse(readFileSync(path.join(root, SEALED_MANIFEST_RELATIVE_PATH), "utf8")) as unknown;
    if (!isSealedRuntimeBuildIdentity(candidate)) return null;
    if (candidate.packageVersion !== observed.packageVersion ||
        candidate.buildFingerprint !== observed.buildFingerprint ||
        candidate.runtimeFingerprint !== observed.buildFingerprint ||
        candidate.cliSha256 !== observed.cliSha256 ||
        candidate.toolSchemaRevision !== observed.toolSchemaRevision ||
        (candidate.uiResourceRevision !== undefined && candidate.uiResourceRevision !== observed.uiResourceRevision) ||
        candidate.platform !== process.platform ||
        candidate.architecture !== process.arch) return null;
    const expectedSnapshot = runtimeSnapshotId(candidate);
    return expectedSnapshot === candidate.runtimeSnapshotId ? candidate : null;
  } catch {
    return null;
  }
}

function freshRuntimeManifestForRoot(runtimeRoot: string, timestamp: string | null): RuntimeManifest {
  const packageVersionValue = packageVersion(runtimeRoot);
  const sourceRevisionValue = sourceRevision(runtimeRoot);
  const sourceFingerprintValue = sourceFingerprint(runtimeRoot);
  const buildFingerprintValue = buildFingerprint(runtimeRoot);
  const cliSha256Value = cliSha256(runtimeRoot);
  const toolSchemaRevisionValue = toolSchemaRevision(runtimeRoot);
  const uiResourceRevisionValue = uiResourceRevision(runtimeRoot);
  const nodeVersion = process.version;
  const runtimeFingerprint = buildFingerprintValue;
  return {
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    packageVersion: packageVersionValue,
    sourceRevision: sourceRevisionValue,
    sourceFingerprint: sourceFingerprintValue,
    buildFingerprint: buildFingerprintValue,
    runtimeFingerprint,
    buildTimestamp: timestamp,
    cliSha256: cliSha256Value,
    toolSchemaRevision: toolSchemaRevisionValue,
    uiResourceRevision: uiResourceRevisionValue,
    nodeVersion,
    runtimeSnapshotId: runtimeSnapshotId({
      packageVersion: packageVersionValue,
      sourceRevision: sourceRevisionValue,
      sourceFingerprint: sourceFingerprintValue,
      runtimeFingerprint,
      cliSha256: cliSha256Value,
      toolSchemaRevision: toolSchemaRevisionValue,
      nodeVersion,
      platform: process.platform,
      architecture: process.arch,
    }),
    runtimeRoot,
    platform: process.platform,
    architecture: process.arch,
  };
}

export function sealRuntimeBuildManifest(runtimeRootValue = inferredRuntimeRoot()): RuntimeManifest {
  const runtimeRoot = path.resolve(runtimeRootValue);
  const manifest = freshRuntimeManifestForRoot(runtimeRoot, buildTimestampForSeal());
  if (!manifest.sourceRevision || !manifest.sourceFingerprint || !manifest.buildFingerprint ||
      !manifest.runtimeFingerprint || !manifest.cliSha256 || !manifest.toolSchemaRevision || !manifest.runtimeSnapshotId) {
    throw new Error("Runtime build identity is incomplete; refusing to seal runtime manifest");
  }
  const sealed: SealedRuntimeBuildIdentity = {
    schemaVersion: manifest.schemaVersion,
    packageVersion: manifest.packageVersion,
    sourceRevision: manifest.sourceRevision,
    sourceFingerprint: manifest.sourceFingerprint,
    buildFingerprint: manifest.buildFingerprint,
    runtimeFingerprint: manifest.runtimeFingerprint,
    buildTimestamp: manifest.buildTimestamp!,
    cliSha256: manifest.cliSha256,
    toolSchemaRevision: manifest.toolSchemaRevision,
    ...(manifest.uiResourceRevision ? { uiResourceRevision: manifest.uiResourceRevision } : {}),
    nodeVersion: manifest.nodeVersion,
    runtimeSnapshotId: manifest.runtimeSnapshotId,
    platform: manifest.platform,
    architecture: manifest.architecture,
  };
  const destination = path.join(runtimeRoot, SEALED_MANIFEST_RELATIVE_PATH);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o644 });
  if (runtimeRoot === inferredRuntimeRoot()) currentRuntimeManifestCache = { runtimeRoot, manifest };
  return manifest;
}

/** Runtime build identity. Identity fields are secret-free; runtimeRoot is local diagnostic context. */
export function getRuntimeManifest(): RuntimeManifest {
  // The loaded runtime cannot change identity without a process replacement.
  // Re-hashing the full dist tree on every status call adds avoidable latency
  // and can transiently describe files that have changed on disk but are not
  // the code executing in this process.
  const runtimeRoot = inferredRuntimeRoot();
  if (currentRuntimeManifestCache?.runtimeRoot !== runtimeRoot) {
    currentRuntimeManifestCache = {
      runtimeRoot,
      manifest: getRuntimeManifestForRoot(runtimeRoot),
    };
  }
  return currentRuntimeManifestCache.manifest;
}

export function getRuntimeManifestForRoot(runtimeRootValue: string): RuntimeManifest {
  const runtimeRoot = path.resolve(runtimeRootValue);
  const packageVersionValue = packageVersion(runtimeRoot);
  const buildFingerprintValue = buildFingerprint(runtimeRoot);
  const cliSha256Value = cliSha256(runtimeRoot);
  const toolSchemaRevisionValue = toolSchemaRevision(runtimeRoot);
  const uiResourceRevisionValue = uiResourceRevision(runtimeRoot);
  const sealed = readSealedRuntimeBuildIdentity(runtimeRoot, {
    packageVersion: packageVersionValue,
    buildFingerprint: buildFingerprintValue,
    cliSha256: cliSha256Value,
    toolSchemaRevision: toolSchemaRevisionValue,
    uiResourceRevision: uiResourceRevisionValue,
  });
  const manifest = sealed
    ? { ...sealed, uiResourceRevision: sealed.uiResourceRevision ?? uiResourceRevisionValue, runtimeRoot }
    : freshRuntimeManifestForRoot(runtimeRoot, configuredBuildTimestamp());
  return manifest;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly && process.argv.includes("--seal")) {
  const sealed = sealRuntimeBuildManifest();
  process.stdout.write(`sealed runtime manifest ${sealed.runtimeSnapshotId}\n`);
}
