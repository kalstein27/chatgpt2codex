import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const WORKSPACE_ROOTS_FILE = "workspace-roots.json";

interface WorkspaceRootsDocument {
  version: 1;
  updatedAt: number;
  roots: string[];
}

function uniqueResolvedRoots(values: readonly string[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0 || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

async function workspaceRootsFile(stateDir: string): Promise<string> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  return path.join(stateDir, WORKSPACE_ROOTS_FILE);
}

export async function loadAuthorizedWorkspaceRoots(stateDir: string): Promise<string[]> {
  const filename = await workspaceRootsFile(stateDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!parsed || typeof parsed !== "object") throw new Error("workspace-roots.json must contain an object");
  const document = parsed as Partial<WorkspaceRootsDocument>;
  if (document.version !== 1 || !Array.isArray(document.roots)) {
    throw new Error("workspace-roots.json has an unsupported schema");
  }
  if (document.roots.some((value) => typeof value !== "string" || !path.isAbsolute(value))) {
    throw new Error("workspace-roots.json roots must be absolute paths");
  }
  return uniqueResolvedRoots(document.roots);
}

export async function saveAuthorizedWorkspaceRoots(stateDir: string, roots: readonly string[]): Promise<string[]> {
  const normalized = uniqueResolvedRoots(roots);
  const filename = await workspaceRootsFile(stateDir);
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const document: WorkspaceRootsDocument = { version: 1, updatedAt: Date.now(), roots: normalized };
  await fs.writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filename);
  return normalized;
}

export async function addAuthorizedWorkspaceRoot(stateDir: string, requestedRoot: string): Promise<string[]> {
  if (!path.isAbsolute(requestedRoot)) throw new Error("workspace root must be an absolute path");
  const canonicalRoot = await fs.realpath(requestedRoot);
  const info = await fs.stat(canonicalRoot);
  if (!info.isDirectory()) throw new Error("workspace root must be an existing directory");
  const current = await loadAuthorizedWorkspaceRoots(stateDir);
  return saveAuthorizedWorkspaceRoots(stateDir, [...current, canonicalRoot]);
}

export async function removeAuthorizedWorkspaceRoot(stateDir: string, requestedRoot: string): Promise<string[]> {
  if (!path.isAbsolute(requestedRoot)) throw new Error("workspace root must be an absolute path");
  const resolved = await fs.realpath(requestedRoot).catch(() => path.resolve(requestedRoot));
  const current = await loadAuthorizedWorkspaceRoots(stateDir);
  return saveAuthorizedWorkspaceRoots(stateDir, current.filter((root) => root !== resolved));
}
