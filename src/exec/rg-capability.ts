import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode, type Lease } from "../types.js";
import { resolveInProject } from "../policy/paths.js";
import { resolveCommandOnPath } from "./runtime-environment.js";

const STATE_SCHEMA_VERSION = 1;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_RETAINED_REQUESTS = 100;
const DEFAULT_MAX_RESULTS = 200;
const HARD_MAX_RESULTS = 500;
const RG_MAX_BUFFER = 32 * 1024 * 1024;

const SKIP_DIRS = [
  ".git",
  "node_modules",
  ".ai",
  ".codex",
  ".venv",
  "dist",
  "build",
  ".next",
  "vendor",
] as const;

export type RgPreference = "code-search-only" | "ask" | "always";
export type RgApprovalDecision = "once" | "session" | "always";
export type RgPatternMode = "literal" | "regex";

export interface RgSearchOptions {
  patternMode?: RgPatternMode;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface VerifiedRgBinary {
  available: true;
  trusted: true;
  path: string;
  realPath: string;
  version: string;
  sha256: string;
  ownerUid?: number;
  mode?: number;
  source: "configured" | "bundled-runtime" | "managed-tool" | "installed-app" | "fixed-system" | "shell-path";
}

export interface UnavailableRgBinary {
  available: false;
  trusted: false;
  reason: string;
  rejectedPath?: string;
}

export type RgBinaryInspection = VerifiedRgBinary | UnavailableRgBinary;

interface RgGrant {
  scope: RgApprovalDecision;
  projectId: string;
  projectRoot: string;
  leaseId?: string;
  binaryPath: string;
  binarySha256: string;
  approvedAt: number;
  expiresAt?: number;
  operationFingerprint?: string;
}

export interface RgApprovalRequest {
  requestId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  decision?: RgApprovalDecision;
  projectId: string;
  projectRoot: string;
  leaseId: string;
  leaseExpiresAt: number;
  operationFingerprint: string;
  queryHash: string;
  queryPreview: string;
  patternMode: RgPatternMode;
  caseSensitive: boolean;
  maxResults: number;
  binaryPath: string;
  binaryVersion: string;
  binarySha256: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
}

interface RgCapabilityState {
  schemaVersion: 1;
  preferences: Record<string, RgPreference>;
  grants: RgGrant[];
  requests: RgApprovalRequest[];
}

export interface RgAuthorization {
  scope: RgApprovalDecision;
  requestId?: string;
  operationFingerprint: string;
}

export interface RgCapabilityStatus {
  preference: RgPreference;
  binary: RgBinaryInspection;
  pendingRequests: RgApprovalRequest[];
  grants: Array<{
    scope: RgApprovalDecision;
    projectId: string;
    leaseId?: string;
    binaryPath: string;
    binarySha256: string;
    approvedAt: number;
    expiresAt?: number;
  }>;
}

export interface RgSearchMatch {
  path: string;
  line: number;
  column?: number;
  snippet: string;
}

export interface RgSearchResult {
  matches: RgSearchMatch[];
  backend: "external-rg";
  binaryPath: string;
  binaryVersion: string;
  binarySha256: string;
  approvalScope: RgApprovalDecision;
  searchRoot: string;
  durationMs: number;
}

type ResolveRgOptions = {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  candidatePaths?: string[];
};

const locks = new Map<string, Promise<void>>();
let statusBinaryCache: { expiresAt: number; binary: RgBinaryInspection } | undefined;

function statePath(stateDir: string): string {
  return path.join(stateDir, "external-rg-capability.json");
}

function emptyState(): RgCapabilityState {
  return { schemaVersion: STATE_SCHEMA_VERSION, preferences: {}, grants: [], requests: [] };
}

function normalizeState(raw: unknown): RgCapabilityState {
  if (!raw || typeof raw !== "object") return emptyState();
  const candidate = raw as Partial<RgCapabilityState>;
  if (candidate.schemaVersion !== STATE_SCHEMA_VERSION) return emptyState();
  const preferences: Record<string, RgPreference> = {};
  for (const [projectId, value] of Object.entries(candidate.preferences ?? {})) {
    if (value === "code-search-only" || value === "ask" || value === "always") {
      preferences[projectId] = value;
    }
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    preferences,
    grants: Array.isArray(candidate.grants) ? candidate.grants.filter(isGrant) : [],
    requests: Array.isArray(candidate.requests) ? candidate.requests.filter(isRequest) : [],
  };
}

function isGrant(value: unknown): value is RgGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Partial<RgGrant>;
  return (
    (grant.scope === "once" || grant.scope === "session" || grant.scope === "always") &&
    typeof grant.projectId === "string" &&
    typeof grant.projectRoot === "string" &&
    typeof grant.binaryPath === "string" &&
    typeof grant.binarySha256 === "string" &&
    typeof grant.approvedAt === "number"
  );
}

function isRequest(value: unknown): value is RgApprovalRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<RgApprovalRequest>;
  return (
    typeof request.requestId === "string" &&
    (request.status === "pending" || request.status === "approved" || request.status === "rejected" || request.status === "expired") &&
    typeof request.projectId === "string" &&
    typeof request.projectRoot === "string" &&
    typeof request.leaseId === "string" &&
    typeof request.leaseExpiresAt === "number" &&
    typeof request.operationFingerprint === "string" &&
    typeof request.binaryPath === "string" &&
    typeof request.binarySha256 === "string" &&
    typeof request.createdAt === "number" &&
    typeof request.expiresAt === "number"
  );
}

async function readState(stateDir: string): Promise<RgCapabilityState> {
  try {
    return normalizeState(JSON.parse(await readFile(statePath(stateDir), "utf8")));
  } catch {
    return emptyState();
  }
}

async function writeState(stateDir: string, state: RgCapabilityState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700).catch(() => undefined);
  const destination = statePath(stateDir);
  const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, destination);
}

async function withStateLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(stateDir);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

function cleanupState(state: RgCapabilityState, now: number): boolean {
  const before = JSON.stringify(state);
  for (const request of state.requests) {
    if (request.status === "pending" && (request.expiresAt <= now || request.leaseExpiresAt <= now)) {
      request.status = "expired";
      request.resolvedAt = now;
    }
  }
  state.grants = state.grants.filter((grant) => grant.expiresAt === undefined || grant.expiresAt > now);
  state.requests = state.requests
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_RETAINED_REQUESTS);
  return before !== JSON.stringify(state);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function operationFingerprint(
  projectId: string,
  projectRoot: string,
  leaseId: string,
  query: string,
  options: Required<RgSearchOptions>,
  binary: VerifiedRgBinary,
): string {
  return sha256Text(JSON.stringify({
    projectId,
    projectRoot,
    leaseId,
    query,
    patternMode: options.patternMode,
    caseSensitive: options.caseSensitive,
    maxResults: options.maxResults,
    binaryPath: binary.realPath,
    binarySha256: binary.sha256,
  }));
}

function normalizeOptions(options: RgSearchOptions = {}): Required<RgSearchOptions> {
  return {
    patternMode: options.patternMode ?? "literal",
    caseSensitive: options.caseSensitive ?? true,
    maxResults: Math.max(1, Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS)),
  };
}

function binaryCandidates(options: ResolveRgOptions): Array<{ path: string; source: VerifiedRgBinary["source"] }> {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? "rg.exe" : "rg";
  const candidates: Array<{ path: string; source: VerifiedRgBinary["source"] }> = [];
  const add = (candidate: string | undefined, source: VerifiedRgBinary["source"]): void => {
    if (!candidate) return;
    const normalized = path.resolve(candidate);
    if (!candidates.some((entry) => entry.path === normalized)) candidates.push({ path: normalized, source });
  };

  for (const candidate of options.candidatePaths ?? []) add(candidate, "configured");
  add(env.CHATGPT2CODEX_RG_PATH, "configured");
  add(path.join(path.dirname(execPath), executable), "bundled-runtime");

  if (platform === "darwin") {
    add(
      env.HOME
        ? path.join(env.HOME, ".local", "share", "chatgpt2codex", "tools", "ripgrep", "15.1.0", "rg")
        : undefined,
      "managed-tool",
    );
    add("/Applications/ChatGPT To Codex.app/Contents/Resources/chatgpt2codex/bin/rg", "installed-app");
    add("/Applications/ChatGPT To Codex.app/Contents/Resources/bin/rg", "installed-app");
    add("/opt/homebrew/bin/rg", "fixed-system");
    add("/usr/local/bin/rg", "fixed-system");
  } else if (platform === "win32") {
    add(path.join(path.dirname(execPath), "rg.exe"), "bundled-runtime");
  } else {
    add("/usr/local/bin/rg", "fixed-system");
    add("/usr/bin/rg", "fixed-system");
  }

  add(resolveCommandOnPath(executable, { env, execPath, platform }), "shell-path");
  return candidates;
}

function execFileResult(
  executable: string,
  args: string[],
  options: Parameters<typeof execFile>[2],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // execution-capability: external-rg-inspect-search
    execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        const code = typeof (error as { code?: unknown }).code === "number"
          ? Number((error as { code: number }).code)
          : undefined;
        if (code !== undefined) {
          resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: code });
          return;
        }
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
    });
  });
}

async function inspectCandidate(
  candidate: { path: string; source: VerifiedRgBinary["source"] },
  platform: NodeJS.Platform,
): Promise<VerifiedRgBinary | UnavailableRgBinary> {
  let resolved: string;
  try {
    resolved = await realpath(candidate.path);
    const info = await stat(resolved);
    if (!info.isFile()) return { available: false, trusted: false, reason: "rg candidate is not a regular file", rejectedPath: resolved };
    if (platform !== "win32") {
      await access(resolved, constants.X_OK);
      if ((info.mode & 0o022) !== 0) {
        return { available: false, trusted: false, reason: "rg candidate is group/world writable", rejectedPath: resolved };
      }
      const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (currentUid !== undefined && info.uid !== currentUid && info.uid !== 0) {
        return { available: false, trusted: false, reason: "rg candidate owner is not the current user or root", rejectedPath: resolved };
      }
    }
    const versionResult = await execFileResult(resolved, ["--version"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      env: { PATH: path.dirname(resolved), RIPGREP_CONFIG_PATH: "", NO_COLOR: "1" },
    });
    if (versionResult.exitCode !== 0) {
      return { available: false, trusted: false, reason: "rg candidate did not report a version", rejectedPath: resolved };
    }
    const firstLine = versionResult.stdout.split(/\r?\n/u).find(Boolean)?.trim() ?? "";
    if (!/^ripgrep\s+\d+/iu.test(firstLine)) {
      return { available: false, trusted: false, reason: "rg candidate version output is not ripgrep", rejectedPath: resolved };
    }
    return {
      available: true,
      trusted: true,
      path: candidate.path,
      realPath: resolved,
      version: firstLine,
      sha256: await sha256File(resolved),
      ...(platform !== "win32" ? { ownerUid: info.uid, mode: info.mode & 0o777 } : {}),
      source: candidate.source,
    };
  } catch (error) {
    return {
      available: false,
      trusted: false,
      reason: error instanceof Error ? error.message : "rg candidate is unavailable",
      rejectedPath: candidate.path,
    };
  }
}

export async function inspectRgBinary(options: ResolveRgOptions = {}): Promise<RgBinaryInspection> {
  const platform = options.platform ?? process.platform;
  let rejected: UnavailableRgBinary | undefined;
  for (const candidate of binaryCandidates(options)) {
    const inspected = await inspectCandidate(candidate, platform);
    if (inspected.available) return inspected;
    if (inspected.rejectedPath && !/ENOENT|no such file/iu.test(inspected.reason)) rejected = inspected;
  }
  return rejected ?? { available: false, trusted: false, reason: "No verified rg binary is available" };
}

async function inspectRgBinaryForStatus(now: number): Promise<RgBinaryInspection> {
  if (statusBinaryCache && statusBinaryCache.expiresAt > now) return statusBinaryCache.binary;
  const binary = await inspectRgBinary();
  statusBinaryCache = { expiresAt: now + 10_000, binary };
  return binary;
}

function grantMatchesBinary(grant: RgGrant, binary: VerifiedRgBinary): boolean {
  return grant.binaryPath === binary.realPath && grant.binarySha256 === binary.sha256;
}

function grantMatchesProject(grant: RgGrant, projectId: string, projectRoot: string): boolean {
  return grant.projectId === projectId && path.resolve(grant.projectRoot) === path.resolve(projectRoot);
}

export async function ensureRgAuthorized(input: {
  stateDir: string;
  projectId: string;
  projectRoot: string;
  lease: Lease;
  query: string;
  queryPreview?: string;
  options?: RgSearchOptions;
  binary?: RgBinaryInspection;
  now?: number;
}): Promise<{ authorization: RgAuthorization; binary: VerifiedRgBinary; options: Required<RgSearchOptions> }> {
  const now = input.now ?? Date.now();
  const binary = input.binary ?? await inspectRgBinary();
  if (!binary.available) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Verified external rg is unavailable; use code_search instead", {
      capability: "external-rg-search",
      fallbackTool: "code_search",
      reason: binary.reason,
    });
  }
  const options = normalizeOptions(input.options);
  const fingerprint = operationFingerprint(
    input.projectId,
    input.projectRoot,
    input.lease.leaseId,
    input.query,
    options,
    binary,
  );

  return withStateLock(input.stateDir, async () => {
    const state = await readState(input.stateDir);
    cleanupState(state, now);
    const preference = state.preferences[input.projectId] ?? "ask";

    const onceIndex = state.grants.findIndex((grant) =>
      grant.scope === "once" &&
      grant.operationFingerprint === fingerprint &&
      grantMatchesProject(grant, input.projectId, input.projectRoot) &&
      grantMatchesBinary(grant, binary),
    );
    if (onceIndex >= 0) {
      const [grant] = state.grants.splice(onceIndex, 1);
      await writeState(input.stateDir, state);
      return {
        authorization: { scope: "once", operationFingerprint: fingerprint },
        binary,
        options,
      };
    }

    const sessionGrant = state.grants.find((grant) =>
      grant.scope === "session" &&
      grant.leaseId === input.lease.leaseId &&
      grantMatchesProject(grant, input.projectId, input.projectRoot) &&
      grantMatchesBinary(grant, binary),
    );
    if (sessionGrant) {
      await writeState(input.stateDir, state);
      return {
        authorization: { scope: "session", operationFingerprint: fingerprint },
        binary,
        options,
      };
    }

    const alwaysGrant = state.grants.find((grant) =>
      grant.scope === "always" &&
      grantMatchesProject(grant, input.projectId, input.projectRoot) &&
      grantMatchesBinary(grant, binary),
    );
    if (preference === "always" && alwaysGrant) {
      await writeState(input.stateDir, state);
      return {
        authorization: { scope: "always", operationFingerprint: fingerprint },
        binary,
        options,
      };
    }

    if (preference === "code-search-only") {
      await writeState(input.stateDir, state);
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "External rg search is disabled for this project", {
        capability: "external-rg-search",
        preference,
        fallbackTool: "code_search",
      });
    }

    let request = state.requests.find((candidate) =>
      candidate.status === "pending" &&
      candidate.operationFingerprint === fingerprint &&
      candidate.binarySha256 === binary.sha256 &&
      candidate.expiresAt > now,
    );
    if (!request) {
      request = {
        requestId: `rgreq_${randomUUID()}`,
        status: "pending",
        projectId: input.projectId,
        projectRoot: path.resolve(input.projectRoot),
        leaseId: input.lease.leaseId,
        leaseExpiresAt: input.lease.expiresAt,
        operationFingerprint: fingerprint,
        queryHash: sha256Text(input.query),
        queryPreview: (input.queryPreview ?? `[${input.query.length} character search pattern]`).slice(0, 160),
        patternMode: options.patternMode,
        caseSensitive: options.caseSensitive,
        maxResults: options.maxResults,
        binaryPath: binary.realPath,
        binaryVersion: binary.version,
        binarySha256: binary.sha256,
        createdAt: now,
        expiresAt: Math.min(now + REQUEST_TTL_MS, input.lease.expiresAt),
      };
      state.requests.unshift(request);
    }
    cleanupState(state, now);
    await writeState(input.stateDir, state);
    throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "External rg search requires local approval", {
      capability: "external-rg-search",
      requestId: request.requestId,
      projectId: request.projectId,
      projectRoot: request.projectRoot,
      leaseId: request.leaseId,
      binaryPath: request.binaryPath,
      binaryVersion: request.binaryVersion,
      binarySha256: request.binarySha256,
      queryPreview: request.queryPreview,
      patternMode: request.patternMode,
      caseSensitive: request.caseSensitive,
      maxResults: request.maxResults,
      expiresAt: request.expiresAt,
      approvalOptions: ["once", "session", "always", "reject"],
      fallbackTool: "code_search",
    });
  });
}

export async function resolveRgApprovalRequest(input: {
  stateDir: string;
  requestId: string;
  decision: RgApprovalDecision | "reject";
  currentLease?: Lease | null;
  binary?: RgBinaryInspection;
  now?: number;
}): Promise<RgApprovalRequest> {
  const now = input.now ?? Date.now();
  return withStateLock(input.stateDir, async () => {
    const state = await readState(input.stateDir);
    cleanupState(state, now);
    const request = state.requests.find((candidate) => candidate.requestId === input.requestId);
    if (!request) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "rg approval request was not found", { requestId: input.requestId });
    if (request.status !== "pending") {
      throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "rg approval request is no longer pending", {
        requestId: request.requestId,
        status: request.status,
      });
    }
    if (request.expiresAt <= now || request.leaseExpiresAt <= now) {
      request.status = "expired";
      request.resolvedAt = now;
      await writeState(input.stateDir, state);
      throw new DomainError(ErrorCode.LEASE_EXPIRED, "rg approval request expired with its project lease", { requestId: request.requestId });
    }
    if (input.decision === "reject") {
      request.status = "rejected";
      request.resolvedAt = now;
      await writeState(input.stateDir, state);
      return request;
    }

    const binary = input.binary ?? await inspectRgBinary();
    if (!binary.available || binary.realPath !== request.binaryPath || binary.sha256 !== request.binarySha256) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "The verified rg binary changed after approval was requested", {
        requestId: request.requestId,
        expectedBinaryPath: request.binaryPath,
        expectedBinarySha256: request.binarySha256,
        actualBinaryPath: binary.available ? binary.realPath : null,
        actualBinarySha256: binary.available ? binary.sha256 : null,
      });
    }
    if (
      !input.currentLease ||
      input.currentLease.leaseId !== request.leaseId ||
      input.currentLease.projectId !== request.projectId ||
      path.resolve(input.currentLease.projectRoot) !== path.resolve(request.projectRoot) ||
      input.currentLease.expiresAt <= now
    ) {
      throw new DomainError(ErrorCode.LEASE_EXPIRED, "The rg approval request is not bound to the active project lease", {
        requestId: request.requestId,
        requestLeaseId: request.leaseId,
        activeLeaseId: input.currentLease?.leaseId ?? null,
        requestProjectId: request.projectId,
        activeProjectId: input.currentLease?.projectId ?? null,
      });
    }

    const grant: RgGrant = {
      scope: input.decision,
      projectId: request.projectId,
      projectRoot: request.projectRoot,
      binaryPath: request.binaryPath,
      binarySha256: request.binarySha256,
      approvedAt: now,
      ...(input.decision === "once" ? {
        operationFingerprint: request.operationFingerprint,
        expiresAt: Math.min(now + REQUEST_TTL_MS, request.leaseExpiresAt),
      } : {}),
      ...(input.decision === "session" ? {
        leaseId: request.leaseId,
        expiresAt: request.leaseExpiresAt,
      } : {}),
    };
    state.grants = state.grants.filter((existing) => {
      if (!grantMatchesProject(existing, request.projectId, request.projectRoot)) return true;
      if (input.decision === "always") return existing.scope !== "always";
      if (input.decision === "session") return existing.scope !== "session" || existing.leaseId !== request.leaseId;
      return existing.scope !== "once" || existing.operationFingerprint !== request.operationFingerprint;
    });
    state.grants.push(grant);
    if (input.decision === "always") state.preferences[request.projectId] = "always";
    request.status = "approved";
    request.decision = input.decision;
    request.resolvedAt = now;
    await writeState(input.stateDir, state);
    return request;
  });
}

export async function setRgPreference(
  stateDir: string,
  projectId: string,
  preference: Exclude<RgPreference, "always">,
  now: number = Date.now(),
): Promise<RgPreference> {
  return withStateLock(stateDir, async () => {
    const state = await readState(stateDir);
    cleanupState(state, now);
    state.preferences[projectId] = preference;
    state.grants = state.grants.filter((grant) => grant.projectId !== projectId);
    for (const request of state.requests) {
      if (request.projectId === projectId && request.status === "pending") {
        request.status = "rejected";
        request.resolvedAt = now;
      }
    }
    await writeState(stateDir, state);
    return preference;
  });
}

export async function getRgCapabilityStatus(input: {
  stateDir: string;
  projectId?: string | null;
  binary?: RgBinaryInspection;
  now?: number;
}): Promise<RgCapabilityStatus> {
  const now = input.now ?? Date.now();
  const binary = input.binary ?? await inspectRgBinaryForStatus(now);
  return withStateLock(input.stateDir, async () => {
    const state = await readState(input.stateDir);
    const changed = cleanupState(state, now);
    if (changed) await writeState(input.stateDir, state);
    const projectId = input.projectId ?? "";
    return {
      preference: projectId ? (state.preferences[projectId] ?? "ask") : "ask",
      binary,
      pendingRequests: state.requests.filter((request) => request.status === "pending" && (!projectId || request.projectId === projectId)),
      grants: state.grants
        .filter((grant) => !projectId || grant.projectId === projectId)
        .map((grant) => ({
          scope: grant.scope,
          projectId: grant.projectId,
          ...(grant.leaseId ? { leaseId: grant.leaseId } : {}),
          binaryPath: grant.binaryPath,
          binarySha256: grant.binarySha256,
          approvedAt: grant.approvedAt,
          ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
        })),
    };
  });
}

interface RgJsonMatchData {
  path?: { text?: string };
  line_number?: number;
  lines?: { text?: string };
  submatches?: Array<{ start?: number }>;
}

export async function executeRgSearch(input: {
  binary: VerifiedRgBinary;
  projectRoot: string;
  query: string;
  options?: RgSearchOptions;
  approvalScope: RgApprovalDecision;
}): Promise<RgSearchResult> {
  if (!input.query || input.query.includes("\0")) {
    throw new DomainError(ErrorCode.NULLBYTE_REJECTED, "rg search query must be non-empty and contain no NUL bytes");
  }
  const options = normalizeOptions(input.options);
  const searchRoot = await resolveInProject(input.projectRoot, ".", { allowSymlink: false });
  const args = [
    "--json",
    "--no-config",
    "--no-follow",
    "--color", "never",
    "--max-filesize", "4M",
    ...(options.patternMode === "literal" ? ["--fixed-strings"] : []),
    ...(!options.caseSensitive ? ["--ignore-case"] : []),
    ...SKIP_DIRS.flatMap((dir) => ["--glob", `!**/${dir}/**`]),
    "--",
    input.query,
    searchRoot,
  ];
  const startedAt = Date.now();
  const executed = await execFileResult(input.binary.realPath, args, {
    cwd: searchRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: RG_MAX_BUFFER,
    windowsHide: true,
    env: {
      PATH: path.dirname(input.binary.realPath),
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      RIPGREP_CONFIG_PATH: "",
      NO_COLOR: "1",
    },
  });
  if (executed.exitCode !== 0 && executed.exitCode !== 1) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `rg search exited with code ${executed.exitCode}`, {
      exitCode: executed.exitCode,
      stderr: executed.stderr.slice(0, 2_000),
    });
  }

  const matches: RgSearchMatch[] = [];
  if (executed.exitCode === 0) {
    for (const line of executed.stdout.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let parsed: { type?: string; data?: RgJsonMatchData };
      try {
        parsed = JSON.parse(line) as { type?: string; data?: RgJsonMatchData };
      } catch {
        continue;
      }
      if (parsed.type !== "match" || !parsed.data?.path?.text || typeof parsed.data.line_number !== "number") continue;
      const reportedPath = parsed.data.path.text;
      const absolutePath = path.isAbsolute(reportedPath)
        ? path.resolve(reportedPath)
        : path.resolve(searchRoot, reportedPath);
      const relativePath = path.relative(searchRoot, absolutePath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
      const confinedPath = await resolveInProject(searchRoot, relativePath, { allowSymlink: false }).catch(() => null);
      if (!confinedPath) continue;
      matches.push({
        path: relativePath,
        line: parsed.data.line_number,
        ...(typeof parsed.data.submatches?.[0]?.start === "number" ? { column: parsed.data.submatches[0]!.start! + 1 } : {}),
        snippet: (parsed.data.lines?.text ?? "").replace(/\r?\n$/u, "").slice(0, 1_000),
      });
      if (matches.length >= options.maxResults) break;
    }
  }

  return {
    matches,
    backend: "external-rg",
    binaryPath: input.binary.realPath,
    binaryVersion: input.binary.version,
    binarySha256: input.binary.sha256,
    approvalScope: input.approvalScope,
    searchRoot,
    durationMs: Date.now() - startedAt,
  };
}
