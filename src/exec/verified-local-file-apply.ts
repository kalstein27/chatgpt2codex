import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const RECEIPT_SCHEMA_VERSION = 1;

export type FixedLocalDestinationClass = "user-application-support-measurement";

interface FixedLocalSourceDeclaration {
  projectRelativePath: string;
  sha256?: string;
  sha256From?: string;
}

interface FixedLocalDestinationDeclaration {
  class: FixedLocalDestinationClass;
  fixedRelativePath: string;
}

export interface FixedLocalFileOperationDeclaration {
  source: FixedLocalSourceDeclaration;
  destination: FixedLocalDestinationDeclaration;
  replaceMode: "atomic";
  approval: "once";
  network: false;
  launchProcess: false;
}

export interface PreparedVerifiedLocalFileOperation {
  operationSpecId: string;
  sourceRelativePath: string;
  expectedSourceSha256: string;
  destinationClass: FixedLocalDestinationClass;
  destinationRelativePath: string;
  destinationPathDigest: string;
  replaceMode: "atomic";
  approval: "once";
}

export interface VerifiedLocalFileApplyResult {
  operationSpecId: string;
  receiptId: string;
  attemptCount: 1;
  sourceSha256: string;
  installedSha256: string;
  destinationClass: FixedLocalDestinationClass;
  destinationPathDigest: string;
  fileMutationStatus: "APPLIED";
  receiptStatus: "DURABLE";
  sourceIntegrityStatus: "PASS";
  destinationPolicyStatus: "PASS";
  atomicReplaceStatus: "PASS";
  postVerifyStatus: "PASS";
  automaticRetrySafe: false;
}

interface ReceiptRecord {
  schemaVersion: 1;
  receiptId: string;
  projectId: string;
  operationSpecId: string;
  sourceSha256: string;
  destinationClass: FixedLocalDestinationClass;
  destinationPathDigest: string;
  attemptCount: 1;
  automaticRetrySafe: false;
  state: "PREPARED" | "APPLIED" | "FAILED";
  createdAt: number;
  updatedAt: number;
  failureStage?: string;
}

export interface VerifiedLocalFileApplyOptions {
  destinationRoots?: Partial<Record<FixedLocalDestinationClass, string>>;
  now?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `fixed local file operation requires ${key}`);
  }
  return value;
}

function normalizeDeclaration(value: unknown): FixedLocalFileOperationDeclaration {
  const record = asRecord(value);
  const source = asRecord(record?.source);
  const destination = asRecord(record?.destination);
  if (!record || !source || !destination) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "fixed local file operation declaration is incomplete");
  }
  const destinationClass = requireString(destination, "class");
  if (destinationClass !== "user-application-support-measurement") {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "destination class is not allowlisted for verified local file apply", {
      destinationClass,
    });
  }
  if (record.replaceMode !== "atomic" || record.approval !== "once" || record.network !== false || record.launchProcess !== false) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "fixed local file operation may only declare atomic, once-approved, offline, no-process behavior", {
      replaceMode: record.replaceMode ?? null,
      approval: record.approval ?? null,
      network: record.network ?? null,
      launchProcess: record.launchProcess ?? null,
    });
  }
  const sha256 = typeof source.sha256 === "string" ? source.sha256.toLowerCase() : undefined;
  const sha256From = typeof source.sha256From === "string" ? source.sha256From : undefined;
  if ((sha256 ? 1 : 0) + (sha256From ? 1 : 0) !== 1) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "source must declare exactly one of sha256 or sha256From");
  }
  return {
    source: {
      projectRelativePath: requireString(source, "projectRelativePath"),
      ...(sha256 ? { sha256 } : {}),
      ...(sha256From ? { sha256From } : {}),
    },
    destination: {
      class: destinationClass,
      fixedRelativePath: requireString(destination, "fixedRelativePath"),
    },
    replaceMode: "atomic",
    approval: "once",
    network: false,
    launchProcess: false,
  };
}

function assertSha256(value: unknown, source: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_PATTERN.test(normalized)) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, `invalid SHA-256 value from ${source}`);
  }
  return normalized;
}

async function lstatRegularNoSymlink(filePath: string, label: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    throw new DomainError(ErrorCode.FILE_NOT_FOUND, `${label} does not exist`);
  }
  if (stat.isSymbolicLink()) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `${label} must not be a symlink`);
  }
  if (!stat.isFile()) {
    throw new DomainError(ErrorCode.NOT_A_FILE, `${label} must be a regular file`);
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, `${label} exceeds the verified local file apply size limit`, {
      maxBytes: MAX_ARTIFACT_BYTES,
    });
  }
  return stat;
}

async function hashFileHandle(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== size) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "source changed while being verified");
  }
  return hash.digest("hex");
}

async function hashRegularFileNoFollow(filePath: string, label: string): Promise<{ sha256: string; mode: number; size: number }> {
  await lstatRegularNoSymlink(filePath, label);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new DomainError(ErrorCode.NOT_A_FILE, `${label} must be a regular file`);
    if (stat.size > MAX_ARTIFACT_BYTES) throw new DomainError(ErrorCode.FILE_TOO_LARGE, `${label} exceeds the size limit`);
    return {
      sha256: await hashFileHandle(handle, stat.size),
      mode: stat.mode & 0o777,
      size: stat.size,
    };
  } finally {
    await handle.close();
  }
}

function readJsonField(document: unknown, selector: string): unknown {
  const cleaned = selector.replace(/^#/, "");
  if (!cleaned) return document;
  const parts = cleaned.startsWith("/")
    ? cleaned.slice(1).split("/").filter(Boolean)
    : cleaned.split(".").filter(Boolean);
  let current: unknown = document;
  for (const raw of parts) {
    const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    const record = asRecord(current);
    if (!record || !(key in record)) return undefined;
    current = record[key];
  }
  return current;
}

async function expectedShaFromDeclaration(projectRoot: string, source: FixedLocalSourceDeclaration): Promise<string> {
  if (source.sha256) return assertSha256(source.sha256, "manifest sha256");
  const reference = source.sha256From ?? "";
  const hashIndex = reference.indexOf("#");
  if (hashIndex <= 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "sha256From must use project-relative-json-path#field syntax");
  }
  const rel = reference.slice(0, hashIndex);
  const selector = reference.slice(hashIndex);
  const evidencePath = await resolveInProject(projectRoot, rel, { rejectRoot: true });
  await lstatRegularNoSymlink(evidencePath, "SHA evidence file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  } catch {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "SHA evidence file is not valid JSON");
  }
  return assertSha256(readJsonField(parsed, selector), "sha256From evidence");
}

function validateDestinationRelativePath(destinationClass: FixedLocalDestinationClass, relativePath: string): string[] {
  if (relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "fixed destination must be a relative, non-null path");
  }
  const normalized = path.normalize(relativePath);
  const parts = normalized.split(path.sep).filter(Boolean);
  if (normalized !== relativePath || parts.some((part) => part === ".." || part === "." || part.startsWith("."))) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "fixed destination contains traversal, normalization, or hidden-path components");
  }
  if (destinationClass === "user-application-support-measurement") {
    if (parts.length < 3 || parts[1] !== "Measurement") {
      throw new DomainError(
        ErrorCode.PERMISSION_DENIED,
        "user-application-support-measurement destinations must be <product>/Measurement/<file>",
      );
    }
  }
  return parts;
}

function defaultDestinationRoot(destinationClass: FixedLocalDestinationClass): string {
  if (process.platform !== "darwin") {
    throw new DomainError(ErrorCode.PLATFORM_UNSUPPORTED, `${destinationClass} is currently supported only on macOS`);
  }
  return path.join(os.homedir(), "Library", "Application Support");
}

async function resolveDestinationPath(
  destinationClass: FixedLocalDestinationClass,
  relativePath: string,
  roots?: Partial<Record<FixedLocalDestinationClass, string>>,
): Promise<string> {
  const parts = validateDestinationRelativePath(destinationClass, relativePath);
  const configuredRoot = roots?.[destinationClass] ?? defaultDestinationRoot(destinationClass);
  let rootStat;
  try {
    rootStat = await fs.lstat(configuredRoot);
  } catch {
    throw new DomainError(ErrorCode.FILE_NOT_FOUND, "destination class root does not exist", { destinationClass });
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "destination class root must be a real directory", { destinationClass });
  }
  const realRoot = await fs.realpath(configuredRoot);
  let current = realRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      throw new DomainError(ErrorCode.FILE_NOT_FOUND, "predeclared destination parent does not exist", { destinationClass });
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "destination parent contains a symlink or non-directory component", {
        destinationClass,
      });
    }
  }
  const parentReal = await fs.realpath(current);
  const parentRel = path.relative(realRoot, parentReal);
  if (parentRel.startsWith("..") || path.isAbsolute(parentRel)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "destination parent escapes the allowlisted class root", { destinationClass });
  }
  const destination = path.join(parentReal, parts.at(-1)!);
  try {
    const leaf = await fs.lstat(destination);
    if (leaf.isSymbolicLink() || !leaf.isFile()) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "existing destination must be a regular non-symlink file");
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw error;
  }
  return destination;
}

export async function resolveVerifiedLocalFileOperation(
  projectRoot: string,
  operationSpecId: string,
  options: VerifiedLocalFileApplyOptions = {},
): Promise<PreparedVerifiedLocalFileOperation> {
  if (!OPERATION_ID_PATTERN.test(operationSpecId)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "operationSpecId has an invalid format");
  }
  const packagePath = await resolveInProject(projectRoot, "package.json", { rejectRoot: true });
  await lstatRegularNoSymlink(packagePath, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "project package.json is not valid JSON");
  }
  const c2ct = asRecord(pkg.c2ct);
  const operations = asRecord(c2ct?.fixedLocalFileOperations);
  if (!operations || !(operationSpecId in operations)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `unknown predeclared fixed local file operation: ${operationSpecId}`);
  }
  const declaration = normalizeDeclaration(operations[operationSpecId]);
  const sourcePath = await resolveInProject(projectRoot, declaration.source.projectRelativePath, { rejectRoot: true });
  const expectedSourceSha256 = await expectedShaFromDeclaration(projectRoot, declaration.source);
  const source = await hashRegularFileNoFollow(sourcePath, "source artifact");
  if (source.sha256 !== expectedSourceSha256) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "source artifact SHA-256 does not match the predeclared evidence", {
      expectedSha256: expectedSourceSha256,
      actualSha256: source.sha256,
    });
  }
  const destinationPath = await resolveDestinationPath(
    declaration.destination.class,
    declaration.destination.fixedRelativePath,
    options.destinationRoots,
  );
  return {
    operationSpecId,
    sourceRelativePath: declaration.source.projectRelativePath,
    expectedSourceSha256,
    destinationClass: declaration.destination.class,
    destinationRelativePath: declaration.destination.fixedRelativePath,
    destinationPathDigest: createHash("sha256").update(destinationPath).digest("hex"),
    replaceMode: "atomic",
    approval: "once",
  };
}

function receiptIdFor(projectId: string, prepared: PreparedVerifiedLocalFileOperation): string {
  return `flf_${createHash("sha256").update(JSON.stringify({
    projectId,
    operationSpecId: prepared.operationSpecId,
    sourceSha256: prepared.expectedSourceSha256,
    destinationClass: prepared.destinationClass,
    destinationPathDigest: prepared.destinationPathDigest,
  })).digest("hex").slice(0, 40)}`;
}

function receiptDirectory(stateDir: string): string {
  return path.join(stateDir, "fixed-local-file-operation-receipts");
}

async function fsyncDirectory(directory: string): Promise<void> {
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | directoryFlag);
    await handle.sync();
  } catch {
    // Directory fsync is best-effort across supported filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createReceiptBeforeMutation(
  stateDir: string,
  projectId: string,
  prepared: PreparedVerifiedLocalFileOperation,
  now: number,
): Promise<{ receipt: ReceiptRecord; receiptPath: string }> {
  const directory = receiptDirectory(stateDir);
  await fs.mkdir(directory, { recursive: true, mode: DIR_MODE });
  await fs.chmod(directory, DIR_MODE).catch(() => undefined);
  const receiptId = receiptIdFor(projectId, prepared);
  const receiptPath = path.join(directory, `${receiptId}.json`);
  const receipt: ReceiptRecord = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId,
    projectId,
    operationSpecId: prepared.operationSpecId,
    sourceSha256: prepared.expectedSourceSha256,
    destinationClass: prepared.destinationClass,
    destinationPathDigest: prepared.destinationPathDigest,
    attemptCount: 1,
    automaticRetrySafe: false,
    state: "PREPARED",
    createdAt: now,
    updatedAt: now,
  };
  let handle: FileHandle;
  try {
    handle = await fs.open(receiptPath, "wx", FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "this exact verified local file operation already has an attempt receipt", {
        receiptId,
        attemptCount: 1,
        automaticRetrySafe: false,
      });
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(directory);
  return { receipt, receiptPath };
}

async function updateReceipt(receiptPath: string, receipt: ReceiptRecord): Promise<void> {
  const directory = path.dirname(receiptPath);
  const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, receiptPath);
  await fsyncDirectory(directory);
}

async function copyHandle(source: FileHandle, destination: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await source.read(buffer, 0, length, position);
    if (bytesRead <= 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    await destination.write(chunk, 0, chunk.length, position);
    hash.update(chunk);
    position += bytesRead;
  }
  if (position !== size) throw new DomainError(ErrorCode.HASH_MISMATCH, "source changed during fixed local file copy");
  return hash.digest("hex");
}

export async function applyVerifiedLocalFileOperation(
  input: {
    stateDir: string;
    projectId: string;
    projectRoot: string;
    prepared: PreparedVerifiedLocalFileOperation;
  },
  options: VerifiedLocalFileApplyOptions = {},
): Promise<VerifiedLocalFileApplyResult> {
  const now = options.now ?? Date.now();
  const sourcePath = await resolveInProject(input.projectRoot, input.prepared.sourceRelativePath, { rejectRoot: true });
  const destinationPath = await resolveDestinationPath(
    input.prepared.destinationClass,
    input.prepared.destinationRelativePath,
    options.destinationRoots,
  );
  const destinationDigest = createHash("sha256").update(destinationPath).digest("hex");
  if (destinationDigest !== input.prepared.destinationPathDigest) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "fixed destination binding changed after approval");
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const sourceHandle = await fs.open(sourcePath, fsConstants.O_RDONLY | noFollow);
  let receiptPath: string | undefined;
  let receipt: ReceiptRecord | undefined;
  let temporaryPath: string | undefined;
  try {
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile()) throw new DomainError(ErrorCode.NOT_A_FILE, "source artifact is no longer a regular file");
    if (sourceStat.size > MAX_ARTIFACT_BYTES) throw new DomainError(ErrorCode.FILE_TOO_LARGE, "source artifact exceeds the size limit");
    const liveSourceSha = await hashFileHandle(sourceHandle, sourceStat.size);
    if (liveSourceSha !== input.prepared.expectedSourceSha256) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, "source artifact changed after approval", {
        expectedSha256: input.prepared.expectedSourceSha256,
        actualSha256: liveSourceSha,
      });
    }

    const created = await createReceiptBeforeMutation(input.stateDir, input.projectId, input.prepared, now);
    receipt = created.receipt;
    receiptPath = created.receiptPath;

    const parent = path.dirname(destinationPath);
    temporaryPath = path.join(parent, `.c2ct-fixed-${receipt.receiptId}-${randomUUID()}.tmp`);
    const tempHandle = await fs.open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      sourceStat.mode & 0o777,
    );
    let copiedSha: string;
    try {
      copiedSha = await copyHandle(sourceHandle, tempHandle, sourceStat.size);
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    if (copiedSha !== input.prepared.expectedSourceSha256) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, "temporary copy SHA-256 mismatch");
    }
    await fs.chmod(temporaryPath, sourceStat.mode & 0o777);

    const reboundDestination = await resolveDestinationPath(
      input.prepared.destinationClass,
      input.prepared.destinationRelativePath,
      options.destinationRoots,
    );
    if (reboundDestination !== destinationPath) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "fixed destination changed during mutation preflight");
    }
    await fs.rename(temporaryPath, destinationPath);
    temporaryPath = undefined;
    await fsyncDirectory(parent);

    const installed = await hashRegularFileNoFollow(destinationPath, "installed artifact");
    if (installed.sha256 !== input.prepared.expectedSourceSha256) {
      throw new DomainError(ErrorCode.HASH_MISMATCH, "post-install SHA-256 verification failed", {
        expectedSha256: input.prepared.expectedSourceSha256,
        actualSha256: installed.sha256,
      });
    }

    receipt.state = "APPLIED";
    receipt.updatedAt = Date.now();
    await updateReceipt(receiptPath, receipt);
    return {
      operationSpecId: input.prepared.operationSpecId,
      receiptId: receipt.receiptId,
      attemptCount: 1,
      sourceSha256: input.prepared.expectedSourceSha256,
      installedSha256: installed.sha256,
      destinationClass: input.prepared.destinationClass,
      destinationPathDigest: input.prepared.destinationPathDigest,
      fileMutationStatus: "APPLIED",
      receiptStatus: "DURABLE",
      sourceIntegrityStatus: "PASS",
      destinationPolicyStatus: "PASS",
      atomicReplaceStatus: "PASS",
      postVerifyStatus: "PASS",
      automaticRetrySafe: false,
    };
  } catch (error) {
    if (receipt && receiptPath) {
      receipt.state = "FAILED";
      receipt.updatedAt = Date.now();
      receipt.failureStage = error instanceof DomainError ? error.code : "UNEXPECTED_ERROR";
      await updateReceipt(receiptPath, receipt).catch(() => undefined);
    }
    throw error;
  } finally {
    await sourceHandle.close().catch(() => undefined);
    if (temporaryPath) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}
