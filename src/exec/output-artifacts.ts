import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";

export const OUTPUT_ARTIFACT_STREAM_BYTES = 4 * 1024 * 1024;
export const OUTPUT_READ_DEFAULT_BYTES = 64 * 1024;
export const OUTPUT_READ_MAX_BYTES = 256 * 1024;
const OUTPUT_RETENTION_COUNT = 20;
const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OUTPUT_REF_PATTERN = /^out_[a-z0-9]+_[a-f0-9]{16}$/;

export interface OutputArtifactMetadata {
  schemaVersion: 1;
  outputRef: string;
  resourceUri: string;
  projectId: string;
  tool: string;
  createdAt: string;
  totalBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  sourceTruncated: boolean;
  artifactTruncated: boolean;
  sha256: string;
}

export interface OutputArtifactChunk extends OutputArtifactMetadata {
  offset: number;
  nextOffset: number;
  eof: boolean;
  content: string;
}

function outputsDir(stateDir: string): string {
  return path.join(stateDir, "outputs");
}

function assertOutputRef(outputRef: string): void {
  if (!OUTPUT_REF_PATTERN.test(outputRef)) {
    throw new DomainError(ErrorCode.NOT_A_FILE, "Invalid outputRef", { outputRef });
  }
}

function metadataPath(stateDir: string, outputRef: string): string {
  assertOutputRef(outputRef);
  return path.join(outputsDir(stateDir), `${outputRef}.json`);
}

function contentPath(stateDir: string, outputRef: string): string {
  assertOutputRef(outputRef);
  return path.join(outputsDir(stateDir), `${outputRef}.txt`);
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, data, { mode: 0o600 });
  await fs.rename(temp, filePath);
}

async function pruneOutputArtifacts(stateDir: string): Promise<void> {
  const dir = outputsDir(stateDir);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const metadataFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const records = await Promise.all(
    metadataFiles.map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      return stat ? { entry, stat } : null;
    }),
  );
  const now = Date.now();
  const sorted = records
    .filter((record): record is NonNullable<typeof record> => record !== null)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  await Promise.all(
    sorted.map(async ({ entry, stat }, index) => {
      if (index < OUTPUT_RETENTION_COUNT && now - stat.mtimeMs <= OUTPUT_RETENTION_MS) return;
      const outputRef = entry.name.slice(0, -".json".length);
      await Promise.all([
        fs.rm(metadataPath(stateDir, outputRef), { force: true }),
        fs.rm(contentPath(stateDir, outputRef), { force: true }),
      ]);
    }),
  );
}

export async function createOutputArtifact(input: {
  stateDir: string;
  projectId: string;
  tool: string;
  stdout: string;
  stderr: string;
  sourceTruncated: boolean;
  artifactTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}): Promise<OutputArtifactMetadata> {
  const dir = outputsDir(input.stateDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);

  const outputRef = `out_${Date.now().toString(36)}_${randomBytes(8).toString("hex")}`;
  const resourceUri = `chatgpt2codex://outputs/${outputRef}`;
  const safeStdout = redact(input.stdout);
  const safeStderr = redact(input.stderr);
  const document = [
    `[chatgpt2codex output ${outputRef}]`,
    `tool=${input.tool}`,
    `projectId=${input.projectId}`,
    `sourceTruncated=${input.sourceTruncated}`,
    `artifactTruncated=${input.artifactTruncated}`,
    "",
    "--- stdout ---",
    safeStdout,
    "",
    "--- stderr ---",
    safeStderr,
    "",
  ].join("\n");
  const bytes = Buffer.byteLength(document);
  const metadata: OutputArtifactMetadata = {
    schemaVersion: 1,
    outputRef,
    resourceUri,
    projectId: input.projectId,
    tool: input.tool,
    createdAt: new Date().toISOString(),
    totalBytes: bytes,
    stdoutBytes: input.stdoutBytes,
    stderrBytes: input.stderrBytes,
    sourceTruncated: input.sourceTruncated,
    artifactTruncated: input.artifactTruncated,
    sha256: createHash("sha256").update(document).digest("hex"),
  };

  await atomicWrite(contentPath(input.stateDir, outputRef), document);
  await atomicWrite(metadataPath(input.stateDir, outputRef), `${JSON.stringify(metadata, null, 2)}\n`);
  await pruneOutputArtifacts(input.stateDir).catch(() => undefined);
  return metadata;
}

export async function readOutputMetadata(stateDir: string, outputRef: string): Promise<OutputArtifactMetadata> {
  const raw = await fs.readFile(metadataPath(stateDir, outputRef), "utf8").catch(() => null);
  if (raw === null) {
    throw new DomainError(ErrorCode.NOT_A_FILE, `Output artifact not found: ${outputRef}`, { outputRef });
  }
  return JSON.parse(raw) as OutputArtifactMetadata;
}

export async function readOutputArtifact(
  stateDir: string,
  outputRef: string,
  offset = 0,
  maxBytes = OUTPUT_READ_DEFAULT_BYTES,
): Promise<OutputArtifactChunk> {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new DomainError(ErrorCode.NOT_A_FILE, "Output offset must be a non-negative integer", { offset });
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > OUTPUT_READ_MAX_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, `maxBytes must be between 1 and ${OUTPUT_READ_MAX_BYTES}`, {
      maxBytes,
    });
  }

  const metadata = await readOutputMetadata(stateDir, outputRef);
  const file = await fs.open(contentPath(stateDir, outputRef), "r").catch(() => null);
  if (!file) {
    throw new DomainError(ErrorCode.NOT_A_FILE, `Output artifact content not found: ${outputRef}`, { outputRef });
  }
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, metadata.totalBytes - offset)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const nextOffset = offset + bytesRead;
    return {
      ...metadata,
      offset,
      nextOffset,
      eof: nextOffset >= metadata.totalBytes,
      content: buffer.subarray(0, bytesRead).toString("utf8"),
    };
  } finally {
    await file.close();
  }
}

export async function readOutputArtifactAll(stateDir: string, outputRef: string): Promise<{
  metadata: OutputArtifactMetadata;
  content: string;
}> {
  const metadata = await readOutputMetadata(stateDir, outputRef);
  const content = await fs.readFile(contentPath(stateDir, outputRef), "utf8").catch(() => null);
  if (content === null) {
    throw new DomainError(ErrorCode.NOT_A_FILE, `Output artifact content not found: ${outputRef}`, { outputRef });
  }
  return { metadata, content };
}

export async function listOutputArtifacts(stateDir: string): Promise<OutputArtifactMetadata[]> {
  const dir = outputsDir(stateDir);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const metadata = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const outputRef = entry.name.slice(0, -".json".length);
        return readOutputMetadata(stateDir, outputRef).catch(() => null);
      }),
  );
  return metadata
    .filter((entry): entry is OutputArtifactMetadata => entry !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, OUTPUT_RETENTION_COUNT);
}
