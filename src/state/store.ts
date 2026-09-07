import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode, type LeasePreset, type ProjectRegistryEntry } from "../types.js";

/**
 * Central state store under `~/.local/share/chatgpt2codex/` (PRD §10):
 * projects.json (registry) and sessions.json (active project/mode/lease).
 *
 * Persistence rules (PRD §10, §11 SR-04/SR-08 adjacent hardening):
 *  - Directory created with mode 0700, files written with mode 0600.
 *  - Every write is atomic: write to a temp file in the same directory, then
 *    `rename()` over the target (rename is atomic on the same filesystem).
 *  - Every on-disk document is validated with zod before being handed back to
 *    callers; corrupt/foreign JSON never silently propagates.
 *  - Timestamps are integer epoch-ms.
 */

const ProjectRegistryEntrySchema = z.object({
  projectId: z.string(),
  name: z.string(),
  root: z.string(),
  aliases: z.array(z.string()),
  branch: z.string().optional(),
  dirty: z.boolean().optional(),
  hasAgentsMd: z.boolean().optional(),
  hasCodeBrain: z.boolean().optional(),
  packageHints: z.array(z.string()).optional(),
  lastSeenAt: z.string().optional(),
}) satisfies z.ZodType<ProjectRegistryEntry>;

const ProjectsFileSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  projects: z.array(ProjectRegistryEntrySchema),
});

type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

export const MAX_PROJECT_LANES = 8;

const ProjectLaneRecordSchema = z.object({
  laneDigest: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: z.string().min(1),
  projectRootDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ownerScopeDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  leaseId: z.string().min(1),
  preset: z.enum(["read-only", "tests-only", "full-write", "image-only"]),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative(),
});

export type ProjectLaneRecord = z.infer<typeof ProjectLaneRecordSchema>;

const ReleasedProjectLaneRecordSchema = z.object({
  laneDigest: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: z.string().min(1),
  leaseId: z.string().min(1),
  releasedAt: z.number().int().nonnegative(),
});

export type ReleasedProjectLaneRecord = z.infer<typeof ReleasedProjectLaneRecordSchema>;

/** Session document shape (active project, mode, lease) — PRD §6, §7.
 * `lanes` is an optional version-2 extension. Keeping it optional preserves
 * exact version-1 serial-session reads until the first lane is explicitly
 * opened; the existing active project and lease never become an implicit
 * lane during migration. */
const SessionSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  activeProjectId: z.string().nullable(),
  boundProjectId: z.string().nullable().optional(),
  mode: z.enum(["observe", "read", "edit", "verify", "danger"]),
  lease: z
    .object({
      projectId: z.string(),
      leaseId: z.string(),
      projectRoot: z.string(),
      preset: z.enum(["read-only", "tests-only", "full-write", "image-only", "control"]),
      issuedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
    })
    .nullable(),
  lanes: z.array(ProjectLaneRecordSchema).max(MAX_PROJECT_LANES).optional(),
  releasedLanes: z.array(ReleasedProjectLaneRecordSchema).max(16).optional(),
});

export type SessionDocument = z.infer<typeof SessionSchema>;

interface SessionCacheEntry {
  mtimeMs: number;
  size: number;
  ino: number;
  document: SessionDocument;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const PROJECTS_FILE = "projects.json";
const SESSIONS_FILE = "sessions.json";
const MAX_SCOPED_SESSION_FILES = 64;
const SCOPED_SESSION_FILE_RE = /^sessions\.[a-f0-9]{64}\.json$/;

function sessionFilename(scope?: string): string {
  if (!scope) return SESSIONS_FILE;
  const digest = createHash("sha256").update(scope).digest("hex");
  return `sessions.${digest}.json`;
}

function emptyProjectsFile(): ProjectsFile {
  return { version: 1, updatedAt: Date.now(), projects: [] };
}

function emptySession(): SessionDocument {
  return {
    version: 1,
    updatedAt: Date.now(),
    activeProjectId: null,
    mode: "observe",
    lease: null,
  };
}

export class Store {
  private readonly stateDir: string;
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly sessionCache = new Map<string, SessionCacheEntry>();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /** Ensure the state directory exists with restrictive 0700 permissions. */
  private async ensureStateDir(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    // mkdir with an existing dir does not retroactively chmod; best-effort
    // tighten permissions in case the directory pre-existed with a laxer mode.
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(this.stateDir, DIR_MODE);
    } catch {
      // Non-fatal: directory may be on a filesystem without POSIX perms.
    }
  }

  /**
   * Atomically write `data` (already JSON-stringified) to `filename` inside
   * the state dir: write to a sibling temp file, fsync-flush via the OS
   * write, then rename over the target. Rename is atomic within the same
   * directory/filesystem, so readers never observe a partial write.
   */
  private async atomicWriteJson(filename: string, data: unknown): Promise<void> {
    await this.ensureStateDir();
    const target = join(this.stateDir, filename);
    const tmp = join(
      this.stateDir,
      `.${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const json = JSON.stringify(data, null, 2);
    await writeFile(tmp, json, { mode: FILE_MODE, encoding: "utf8" });
    await rename(tmp, target);
  }

  private async readJson(filename: string): Promise<unknown | undefined> {
    const target = join(this.stateDir, filename);
    try {
      const raw = await readFile(target, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: failed to read/parse ${filename}: ${(err as Error).message}`,
      );
    }
  }

  /** Keep remote/session-scoped state bounded without touching sessions.json. */
  private async pruneScopedSessionFiles(keepFilename: string): Promise<void> {
    // Called only after atomicWriteJson has already created/tightened stateDir.
    const entries = await readdir(this.stateDir, { withFileTypes: true });
    const scopedEntries = entries.filter((entry) => entry.isFile() && SCOPED_SESSION_FILE_RE.test(entry.name));
    if (scopedEntries.length <= MAX_SCOPED_SESSION_FILES) return;
    const candidates = await Promise.all(
      scopedEntries
        .map(async (entry) => ({
          filename: entry.name,
          mtimeMs: (await stat(join(this.stateDir, entry.name))).mtimeMs,
        })),
    );
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename));

    const removable = candidates.filter((entry) => entry.filename !== keepFilename);
    const overflow = removable.slice(Math.max(0, MAX_SCOPED_SESSION_FILES - 1));
    await Promise.all(
      overflow.map(async (entry) => {
        try {
          await unlink(join(this.stateDir, entry.filename));
          this.sessionCache.delete(entry.filename);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }),
    );
  }

  async loadProjects(): Promise<ProjectRegistryEntry[]> {
    const raw = await this.readJson(PROJECTS_FILE);
    if (raw === undefined) return [];
    const parsed = ProjectsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: ${PROJECTS_FILE} failed validation: ${parsed.error.message}`,
      );
    }
    return parsed.data.projects;
  }

  async saveProjects(p: ProjectRegistryEntry[]): Promise<void> {
    const validated = z.array(ProjectRegistryEntrySchema).parse(p);
    const doc: ProjectsFile = {
      version: 1,
      updatedAt: Date.now(),
      projects: validated,
    };
    await this.atomicWriteJson(PROJECTS_FILE, doc);
  }

  async getSession(scope?: string): Promise<SessionDocument> {
    const filename = sessionFilename(scope);
    const target = join(this.stateDir, filename);
    const before = await stat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!before) {
      this.sessionCache.delete(filename);
      return emptySession();
    }
    const cached = this.sessionCache.get(filename);
    if (cached && cached.mtimeMs === before.mtimeMs && cached.size === before.size && cached.ino === before.ino) {
      return structuredClone(cached.document);
    }
    const raw = await this.readJson(filename);
    if (raw === undefined) return emptySession();
    const parsed = SessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: ${filename} failed validation: ${parsed.error.message}`,
      );
    }
    const after = await stat(target).catch(() => undefined);
    if (after && after.mtimeMs === before.mtimeMs && after.size === before.size && after.ino === before.ino) {
      this.sessionCache.set(filename, {
        mtimeMs: after.mtimeMs,
        size: after.size,
        ino: after.ino,
        document: structuredClone(parsed.data),
      });
    }
    return parsed.data;
  }

  private async cacheSessionDocument(filename: string, document: SessionDocument): Promise<void> {
    const info = await stat(join(this.stateDir, filename)).catch(() => undefined);
    if (!info) {
      this.sessionCache.delete(filename);
      return;
    }
    this.sessionCache.set(filename, {
      mtimeMs: info.mtimeMs,
      size: info.size,
      ino: info.ino,
      document: structuredClone(document),
    });
  }

  private normalizeSession(s: unknown): SessionDocument {
    const merged = {
      ...emptySession(),
      ...(typeof s === "object" && s !== null ? s : {}),
    };
    // updatedAt is always server-recomputed, never trusted from caller input.
    merged.updatedAt = Date.now();
    return SessionSchema.parse(merged);
  }

  private async writeSessionUnlocked(s: unknown, scope?: string): Promise<SessionDocument> {
    const validated = this.normalizeSession(s);
    const filename = sessionFilename(scope);
    await this.atomicWriteJson(filename, validated);
    await this.cacheSessionDocument(filename, validated);
    if (scope) await this.pruneScopedSessionFiles(filename);
    return validated;
  }

  private async withSessionFilenameLock<T>(filename: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(filename) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sessionLocks.set(filename, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionLocks.get(filename) === tail) this.sessionLocks.delete(filename);
    }
  }

  private async withSessionLock<T>(scope: string | undefined, operation: () => Promise<T>): Promise<T> {
    return this.withSessionFilenameLock(sessionFilename(scope), operation);
  }

  async setSession(s: unknown, scope?: string): Promise<void> {
    await this.withSessionLock(scope, async () => {
      await this.writeSessionUnlocked(s, scope);
    });
  }

  /** Atomically update one scoped session without losing concurrent lane or
   * serial-lease changes between a separate getSession/setSession pair. */
  async updateSession(
    scope: string | undefined,
    updater: (current: SessionDocument) => unknown | Promise<unknown>,
  ): Promise<SessionDocument> {
    return this.withSessionLock(scope, async () => {
      const current = await this.getSession(scope);
      const next = await updater(current);
      return this.writeSessionUnlocked(next, scope);
    });
  }

  /**
   * Clear only the exact persisted serial lease identity after its global
   * privilege generation has been retired as an abandoned owner. The caller
   * makes the liveness/CAS decision; this helper only removes matching scoped
   * session state without exposing or reconstructing the opaque session scope.
   */
  async clearSerialLeaseByIdentity(input: {
    projectId: string;
    leaseId: string;
    preset: LeasePreset;
  }): Promise<{ cleared: boolean; matchedCount: number }> {
    await this.ensureStateDir();
    const entries = await readdir(this.stateDir, { withFileTypes: true });
    const filenames = entries
      .filter((entry) => entry.isFile() && (entry.name === SESSIONS_FILE || SCOPED_SESSION_FILE_RE.test(entry.name)))
      .map((entry) => entry.name)
      .slice(0, MAX_SCOPED_SESSION_FILES + 1);
    let matchedCount = 0;

    for (const filename of filenames) {
      await this.withSessionFilenameLock(filename, async () => {
        const raw = await this.readJson(filename);
        if (raw === undefined) return;
        const parsed = SessionSchema.safeParse(raw);
        if (!parsed.success) return;
        const lease = parsed.data.lease;
        if (
          !lease
          || lease.projectId !== input.projectId
          || lease.leaseId !== input.leaseId
          || lease.preset !== input.preset
        ) return;

        matchedCount += 1;
        const next = this.normalizeSession({
          ...parsed.data,
          mode: "read",
          lease: null,
        });
        await this.atomicWriteJson(filename, next);
        await this.cacheSessionDocument(filename, next);
      });
    }

    return { cleared: matchedCount > 0, matchedCount };
  }
}

export interface PersistedProjectPrivilegeOwner {
  found: boolean;
  active: boolean;
  expiresAt: number | null;
  kind: "lane" | "serial";
}

export interface PersistedProjectPrivilegeOwnerLookup {
  projectId: string;
  leaseId: string;
  preset: LeasePreset;
  kind: "lane" | "serial";
  projectRootDigest?: string;
}

/**
 * Secret-safe persisted owner lookup used by privileged root-lock recovery.
 *
 * Root-lock owner digests intentionally cannot be inverted back to a scoped
 * session filename. Lease IDs are random exact identities, so recovery scans
 * the bounded session set and matches the lock's project/lease/preset tuple.
 * No session filename, scope, or raw owner identifier leaves this helper.
 */
export async function inspectPersistedPrivilegeOwners(input: {
  stateDir: string;
  lookups: readonly PersistedProjectPrivilegeOwnerLookup[];
  now?: number;
}): Promise<PersistedProjectPrivilegeOwner[]> {
  const now = input.now ?? Date.now();
  const entries = await readdir(input.stateDir, { withFileTypes: true }).catch(() => []);
  const filenames = entries
    .filter((entry) => entry.isFile() && (entry.name === SESSIONS_FILE || SCOPED_SESSION_FILE_RE.test(entry.name)))
    .map((entry) => entry.name)
    .slice(0, MAX_SCOPED_SESSION_FILES + 1);

  const foundExpiries = input.lookups.map(() => null as number | null);
  for (const filename of filenames) {
    let parsed: SessionDocument | undefined;
    try {
      const raw = JSON.parse(await readFile(join(input.stateDir, filename), "utf8"));
      const result = SessionSchema.safeParse(raw);
      if (result.success) parsed = result.data;
    } catch {
      // Corrupt/unreadable session state must never become proof of a live
      // privileged owner. The lock itself remains fail-closed until the
      // caller also verifies that no active operation still exists.
    }
    if (!parsed) continue;

    for (let index = 0; index < input.lookups.length; index += 1) {
      const lookup = input.lookups[index]!;
      if (lookup.kind === "serial") {
        const lease = parsed.lease;
        if (
          lease
          && lease.projectId === lookup.projectId
          && lease.leaseId === lookup.leaseId
          && lease.preset === lookup.preset
        ) {
          foundExpiries[index] = Math.max(foundExpiries[index] ?? 0, lease.expiresAt);
        }
        continue;
      }
      for (const lane of parsed.lanes ?? []) {
        if (
          lane.projectId === lookup.projectId
          && lane.leaseId === lookup.leaseId
          && lane.preset === lookup.preset
          && (lookup.projectRootDigest === undefined || lane.projectRootDigest === lookup.projectRootDigest)
        ) {
          foundExpiries[index] = Math.max(foundExpiries[index] ?? 0, lane.expiresAt);
        }
      }
    }
  }

  return input.lookups.map((lookup, index) => {
    const foundExpiry = foundExpiries[index] ?? null;
    return {
      found: foundExpiry !== null,
      active: foundExpiry !== null && foundExpiry >= now,
      expiresAt: foundExpiry,
      kind: lookup.kind,
    };
  });
}

export async function inspectPersistedPrivilegeOwner(input: PersistedProjectPrivilegeOwnerLookup & {
  stateDir: string;
  now?: number;
}): Promise<PersistedProjectPrivilegeOwner> {
  const [result] = await inspectPersistedPrivilegeOwners({
    stateDir: input.stateDir,
    lookups: [input],
    now: input.now,
  });
  return result!;
}
