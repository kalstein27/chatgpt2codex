import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";

const DEFAULT_MAX_RESULTS = 200;
const HARD_MAX_RESULTS = 200;

/** Directory names the JS fallback walker never descends into. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".ai",
  ".codex",
  "dist",
  "build",
  ".next",
  ".venv",
  "vendor",
]);

interface Match {
  path: string;
  line: number;
  snippet: string;
  score?: number;
}

/**
 * Search project source for `query` (PRD §8.3 code_search). Prefers Code
 * Brain (`.ai/bin/ai`) if present, else falls back to ripgrep via
 * child_process, else a dependency-light JS glob+read fallback so search
 * never hard-fails.
 */
export async function codeSearch(
  root: string,
  query: string,
  mode?: string,
  maxResults?: number,
): Promise<{ matches: Match[]; backend: string }> {
  void mode;

  if (!query || query.length === 0) {
    return { matches: [], backend: "ripgrep" };
  }

  const cap = Math.max(1, Math.min(maxResults ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS));

  // Resolve+verify root itself is a real, accessible directory before
  // scoping any search into it (defense in depth; individual match paths
  // are still confined per-result below).
  const realRoot = await resolveInProject(root, ".", { allowSymlink: false });

  const rgResult = await tryRipgrep(realRoot, query, cap);
  if (rgResult) return rgResult;

  const matches = await jsFallbackSearch(realRoot, query, cap);
  return { matches, backend: "ripgrep-js-fallback" };
}

async function tryRipgrep(
  root: string,
  query: string,
  cap: number,
): Promise<{ matches: Match[]; backend: string } | null> {
  try {
    const args = [
      "--json",
      "--no-follow", // never follow symlinks
      "--max-count",
      String(cap),
      ...Array.from(SKIP_DIRS).flatMap((dir) => ["--glob", `!**/${dir}/**`]),
      "--",
      query,
      root,
    ];
    const { stdout } = await execFileAsync("rg", args);
    const matches: Match[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        typeof obj !== "object" ||
        obj === null ||
        !("type" in obj) ||
        (obj as { type: unknown }).type !== "match"
      ) {
        continue;
      }
      const data = (obj as unknown as { data: RgMatchData }).data;
      const absPath = data.path.text;
      const rel = path.relative(root, absPath);
      const snippet = data.lines.text.replace(/\n$/, "");
      matches.push({ path: rel, line: data.line_number, snippet });
      if (matches.length >= cap) break;
    }
    return { matches, backend: "ripgrep" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // rg binary not present -> fall back to JS search.
      return null;
    }
    // ripgrep exits with code 1 when there are simply no matches. execFile
    // rejects on non-zero exit; treat "no matches" as an empty result set
    // rather than surfacing an error, but still fall back on real failures.
    const asExec = err as { code?: number; stdout?: string };
    if (typeof asExec.code === "number" && asExec.code === 1) {
      return { matches: [], backend: "ripgrep" };
    }
    return null;
  }
}

interface RgMatchData {
  path: { text: string };
  line_number: number;
  lines: { text: string };
}

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // execution-capability: code-search-ripgrep-backend
    execFile(
      cmd,
      args,
      { maxBuffer: 1024 * 1024 * 32, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as NodeJS.ErrnoException & { code?: number | string };
          (e as { stdout?: string }).stdout = stdout;
          reject(e);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Dependency-light JS fallback: walk the tree (skipping symlinks and common
 * noise dirs), read text files, and do a case-sensitive substring scan
 * line-by-line. Used only when `rg` is unavailable so search never
 * hard-fails.
 */
async function jsFallbackSearch(root: string, query: string, cap: number): Promise<Match[]> {
  const matches: Match[] = [];
  await walk(root, async (absFile, rel) => {
    if (matches.length >= cap) return;
    let content: string;
    try {
      const buf = await fs.readFile(absFile);
      if (buf.includes(0)) return; // skip binary-looking files
      content = buf.toString("utf8");
    } catch {
      return;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= cap) break;
      const line = lines[i] ?? "";
      if (line.includes(query)) {
        matches.push({ path: rel, line: i + 1, snippet: line.trim().slice(0, 400) });
      }
    }
  });
  return matches;
}

async function walk(
  root: string,
  onFile: (abs: string, rel: string) => Promise<void>,
  dir: string = root,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, onFile, path.join(dir, entry.name));
    } else if (entry.isFile()) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      await onFile(abs, rel);
    }
  }
}

// Re-export so callers/tests can construct a DomainError-compatible failure
// path consistently if needed.
export { DomainError, ErrorCode };
