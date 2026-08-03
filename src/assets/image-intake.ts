import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";
import { isSecretPath } from "../policy/secrets.js";
import { detect, writeImageMetadata, writeVersionedImage, type SavedImage } from "./images.js";

// execution-capability: macos-image-intake-helper
const execFileAsync = promisify(execFile);

/** Local-file intake gets a much higher cap than the base64 tool-call path
 * (PRD-style rationale: bytes never traverse the model context here, so the
 * 10MB base64 ceiling in images.ts doesn't apply). */
const MAX_LOCAL_IMAGE_BYTES = 50 * 1024 * 1024;

const DEFAULT_IMAGE_DIR = path.join(".chatgpt2codex", "images");
const DOWNLOAD_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

export interface IntakeResult {
  filePath: string;
  sha256: string;
  bytes: number;
  mime: SavedImage["mime"];
  source: "clipboard" | "download" | "path";
  sourcePath?: string;
  deduped?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/which", [cmd], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function readValidatedFile(absPath: string, maxBytes: number): Promise<Buffer> {
  const bytes = await fs.readFile(absPath);
  if (bytes.length === 0) {
    throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, "Image file is empty", { path: absPath });
  }
  if (bytes.length > maxBytes) {
    throw new DomainError(ErrorCode.QUOTA_EXCEEDED, `Image exceeds ${Math.floor(maxBytes / (1024 * 1024))}MB limit`, {
      bytes: bytes.length,
      path: absPath,
    });
  }
  return bytes;
}

async function writeIntakeResult(
  root: string,
  projectId: string,
  bytes: Buffer,
  destRel: string | undefined,
  source: IntakeResult["source"],
  sourcePath: string | undefined,
  metadata: Record<string, unknown> | undefined,
): Promise<IntakeResult> {
  const detected = detect(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const effectiveDestRel =
    destRel && destRel.trim().length > 0
      ? destRel
      : path.join(DEFAULT_IMAGE_DIR, `${timestampSlug()}-intake-${sha256.slice(0, 8)}.${detected.ext}`);

  const { filePath, deduped } = await writeVersionedImage(root, effectiveDestRel, bytes, sha256);

  if (metadata) {
    await writeImageMetadata(root, filePath, { projectId, sha256, mime: detected.mime, bytes: bytes.length, source, sourcePath, metadata, savedAt: Date.now() });
  }

  return {
    filePath,
    sha256,
    bytes: bytes.length,
    mime: detected.mime,
    source,
    ...(sourcePath ? { sourcePath } : {}),
    ...(deduped ? { deduped } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. Clipboard intake
// ---------------------------------------------------------------------------

const CLIPBOARD_NO_IMAGE_MESSAGE =
  "No image was captured from the clipboard. Install pngpaste on macOS, or use a downloaded file / image path instead.";

export async function readClipboardText(): Promise<string | undefined> {
  return undefined;
}

async function tryPngpaste(tmpFile: string): Promise<boolean> {
  if (!(await commandExists("pngpaste"))) return false;
  try {
    await execFileAsync("pngpaste", [tmpFile], { timeout: 10_000 });
    const st = await fs.stat(tmpFile).catch(() => null);
    return !!st && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Pull the current clipboard image via pngpaste into a temp file, validate it,
 * then copy it into the project via the shared dedup/versioned writer.
 *
 * @throws {DomainError} INVALID_IMAGE_DATA if the clipboard has no image.
 */
export async function intakeFromClipboard(
  projectRoot: string,
  projectId: string,
  destRel?: string,
  metadata?: Record<string, unknown>,
): Promise<IntakeResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-clip-"));
  const tmpFile = path.join(tmpDir, "clipboard-image");

  try {
    const got = await tryPngpaste(tmpFile);

    if (!got) {
      throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, CLIPBOARD_NO_IMAGE_MESSAGE);
    }

    const bytes = await readValidatedFile(tmpFile, MAX_LOCAL_IMAGE_BYTES);
    // Validate magic bytes now so a garbage/non-image clipboard payload
    // surfaces the same clear error rather than a raw UNSUPPORTED_MEDIA_TYPE.
    let detected;
    try {
      detected = detect(bytes);
    } catch {
      throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, CLIPBOARD_NO_IMAGE_MESSAGE);
    }
    void detected;

    return await writeIntakeResult(projectRoot, projectId, bytes, destRel, "clipboard", undefined, metadata);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 2. Downloads intake
// ---------------------------------------------------------------------------

/**
 * Find the newest image file in ~/Downloads modified within `maxAgeSec`,
 * validate it, and copy it into the project.
 *
 * @throws {DomainError} INVALID_IMAGE_DATA if no recent image is found.
 */
export async function intakeFromDownload(
  projectRoot: string,
  projectId: string,
  destRel?: string,
  maxAgeSec = 900,
  metadata?: Record<string, unknown>,
): Promise<IntakeResult> {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  let names: string[];
  try {
    names = await fs.readdir(downloadsDir);
  } catch {
    throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, `No recent image in ~/Downloads within ${maxAgeSec}s (Downloads folder not found)`, {
      downloadsDir,
    });
  }

  const now = Date.now();
  let newest: { absPath: string; mtimeMs: number } | undefined;

  for (const name of names) {
    if (!DOWNLOAD_IMAGE_EXT_RE.test(name)) continue;
    const absPath = path.join(downloadsDir, name);
    const st = await fs.stat(absPath).catch(() => null);
    if (!st || !st.isFile()) continue;
    const ageSec = (now - st.mtimeMs) / 1000;
    if (ageSec > maxAgeSec) continue;
    if (!newest || st.mtimeMs > newest.mtimeMs) {
      newest = { absPath, mtimeMs: st.mtimeMs };
    }
  }

  if (!newest) {
    throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, `No recent image in ~/Downloads within ${maxAgeSec}s`, {
      downloadsDir,
      maxAgeSec,
    });
  }

  const bytes = await readValidatedFile(newest.absPath, MAX_LOCAL_IMAGE_BYTES);
  detect(bytes); // throws UNSUPPORTED_MEDIA_TYPE if magic bytes don't match

  return await writeIntakeResult(projectRoot, projectId, bytes, destRel, "download", newest.absPath, metadata);
}

// ---------------------------------------------------------------------------
// 3. Arbitrary local-path intake
// ---------------------------------------------------------------------------

/**
 * Copy an arbitrary local image file (outside the project) into the project,
 * validating magic bytes first.
 *
 * @throws {DomainError} NOT_A_FILE if sourceAbsOrTilde doesn't exist or isn't
 *   a regular file; UNSUPPORTED_MEDIA_TYPE if it isn't a recognized image.
 */
export async function intakeFromPath(
  projectRoot: string,
  projectId: string,
  sourceAbsOrTilde: string,
  destRel: string,
  metadata?: Record<string, unknown>,
): Promise<IntakeResult> {
  const expanded = expandHome(sourceAbsOrTilde);
  const absSource = path.resolve(expanded);

  let st;
  try {
    st = await fs.stat(absSource);
  } catch {
    throw new DomainError(ErrorCode.NOT_A_FILE, `Source path does not exist: ${absSource}`, { path: absSource });
  }
  if (!st.isFile()) {
    throw new DomainError(ErrorCode.NOT_A_FILE, `Source path is not a regular file: ${absSource}`, { path: absSource });
  }
  // Defense in depth: this intake path reads from anywhere on disk (that's
  // its purpose — importing a local image from outside the project), with
  // no resolveInProject confinement. isSecretPath does not cover general
  // photo/screenshot leak surfaces, but it costs nothing to also refuse the
  // same secret-classified path patterns every other read path in this
  // codebase refuses (.env, *.pem, *.key, id_rsa*, .aws/.ssh/gcloud dirs,
  // *token*/*secret*/*credential*).
  if (isSecretPath(absSource)) {
    throw new DomainError(ErrorCode.SECRET_BLOCKED, `Refusing to read a secret-classified path: ${absSource}`, {
      path: absSource,
    });
  }

  const bytes = await readValidatedFile(absSource, MAX_LOCAL_IMAGE_BYTES);
  detect(bytes); // throws UNSUPPORTED_MEDIA_TYPE if magic bytes don't match

  return await writeIntakeResult(projectRoot, projectId, bytes, destRel, "path", absSource, metadata);
}

// ---------------------------------------------------------------------------
// doctor() support
// ---------------------------------------------------------------------------

export interface IntakeAvailability {
  pngpasteAvailable: boolean;
  downloadsDirExists: boolean;
}

export async function checkIntakeAvailability(): Promise<IntakeAvailability> {
  const [pngpasteAvailable, downloadsDirExists] = await Promise.all([
    commandExists("pngpaste"),
    fs
      .stat(path.join(os.homedir(), "Downloads"))
      .then((s) => s.isDirectory())
      .catch(() => false),
  ]);
  return { pngpasteAvailable, downloadsDirExists };
}
