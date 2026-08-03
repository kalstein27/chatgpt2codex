import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

export const MANAGED_RG_VERSION = "15.1.0";
export const MANAGED_RG_TARGET = "aarch64-apple-darwin";
export const MANAGED_RG_ARCHIVE_SHA256 = "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715";
export const MANAGED_RG_DIST = `ripgrep-${MANAGED_RG_VERSION}-${MANAGED_RG_TARGET}`;
export const MANAGED_RG_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${MANAGED_RG_VERSION}/${MANAGED_RG_DIST}.tar.gz`;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

export interface ManagedRgInstallResult {
  installedPath: string;
  version: string;
  archiveSha256: string;
  binarySha256: string;
  sourceUrl: string;
  reusedExisting: boolean;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function runFile(
  file: string,
  args: string[],
  options: Parameters<typeof execFile>[2] = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // execution-capability: managed-rg-installer-subprocess
    execFile(file, args, { ...options, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `managed ripgrep installer command failed: ${path.basename(file)}`, {
          file: path.basename(file),
          exitCode: typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null,
        }));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function assertSupportedHost(platform: NodeJS.Platform, arch: string): void {
  if (platform !== "darwin" || arch !== "arm64") {
    throw new DomainError(
      ErrorCode.COMMAND_NOT_ALLOWED,
      `managed ripgrep ${MANAGED_RG_VERSION} installation is pinned only for macOS arm64`,
      { platform, arch },
    );
  }
}

function assertSafeArchiveEntries(listing: string, verboseListing: string): void {
  for (const entry of listing.split(/\r?\n/u)) {
    if (!entry) continue;
    if (entry.startsWith("/")) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "ripgrep archive contains an absolute path");
    }
    if (`/${entry}/`.includes("/../")) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "ripgrep archive contains parent traversal");
    }
    if (entry !== MANAGED_RG_DIST && entry !== `${MANAGED_RG_DIST}/` && !entry.startsWith(`${MANAGED_RG_DIST}/`)) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "ripgrep archive contains an unexpected top-level path");
    }
  }
  for (const line of verboseListing.split(/\r?\n/u)) {
    if (!line) continue;
    const type = line[0];
    if (type === "l" || type === "h") {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "ripgrep archive contains a symbolic or hard link");
    }
  }
}

async function inspectInstalled(binaryPath: string): Promise<ManagedRgInstallResult | null> {
  try {
    const resolved = await realpath(binaryPath);
    const info = await stat(resolved);
    if (!info.isFile() || (info.mode & 0o022) !== 0) return null;
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && info.uid !== currentUid) return null;
    const version = (await runFile(resolved, ["--version"], {
      timeout: 2_000,
      env: { PATH: path.dirname(resolved), RIPGREP_CONFIG_PATH: "", NO_COLOR: "1" },
    })).stdout.split(/\r?\n/u)[0]?.trim() ?? "";
    if (!version.startsWith(`ripgrep ${MANAGED_RG_VERSION}`)) return null;
    const bytes = await readFile(resolved);
    return {
      installedPath: resolved,
      version,
      archiveSha256: MANAGED_RG_ARCHIVE_SHA256,
      binarySha256: sha256(bytes),
      sourceUrl: MANAGED_RG_URL,
      reusedExisting: true,
    };
  } catch {
    return null;
  }
}

export async function installManagedRipgrep(input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<ManagedRgInstallResult> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  assertSupportedHost(platform, arch);

  const env = input.env ?? process.env;
  const home = env.HOME || os.homedir();
  const installDir = path.join(home, ".local", "share", "chatgpt2codex", "tools", "ripgrep", MANAGED_RG_VERSION);
  const installedPath = path.join(installDir, "rg");
  const existing = await inspectInstalled(installedPath);
  if (existing) return existing;

  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(MANAGED_RG_URL, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `official ripgrep download failed with HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "ripgrep archive exceeds the maximum allowed size");
  }
  const archiveBytes = Buffer.from(await response.arrayBuffer());
  if (archiveBytes.length === 0 || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "ripgrep archive size is invalid");
  }
  const archiveSha256 = sha256(archiveBytes);
  if (archiveSha256 !== MANAGED_RG_ARCHIVE_SHA256) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "ripgrep archive checksum mismatch", {
      expected: MANAGED_RG_ARCHIVE_SHA256,
      actual: archiveSha256,
    });
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-managed-rg-"));
  const archivePath = path.join(tempRoot, `${MANAGED_RG_DIST}.tar.gz`);
  const extractDir = path.join(tempRoot, "extract");
  const stagedBinary = path.join(installDir, `.rg.${process.pid}.tmp`);
  try {
    await writeFile(archivePath, archiveBytes, { mode: 0o600 });
    await mkdir(extractDir, { recursive: true, mode: 0o700 });
    const listing = await runFile("/usr/bin/tar", ["-tzf", archivePath], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    const verbose = await runFile("/usr/bin/tar", ["-tvzf", archivePath], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    assertSafeArchiveEntries(listing.stdout, verbose.stdout);
    await runFile("/usr/bin/tar", ["-xzf", archivePath, "-C", extractDir], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });

    const sourceBinary = path.join(extractDir, MANAGED_RG_DIST, "rg");
    const sourceInfo = await stat(sourceBinary);
    if (!sourceInfo.isFile()) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "verified ripgrep archive did not contain a regular rg binary");
    }
    await chmod(sourceBinary, 0o700);
    const version = (await runFile(sourceBinary, ["--version"], {
      timeout: 2_000,
      env: { PATH: path.dirname(sourceBinary), RIPGREP_CONFIG_PATH: "", NO_COLOR: "1" },
    })).stdout.split(/\r?\n/u)[0]?.trim() ?? "";
    if (!version.startsWith(`ripgrep ${MANAGED_RG_VERSION}`)) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `unexpected ripgrep version: ${version}`);
    }

    await mkdir(installDir, { recursive: true, mode: 0o700 });
    await chmod(installDir, 0o700);
    await copyFile(sourceBinary, stagedBinary);
    await chmod(stagedBinary, 0o700);
    await rename(stagedBinary, installedPath);
    const binaryBytes = await readFile(installedPath);
    const binarySha256 = sha256(binaryBytes);
    await writeFile(
      path.join(installDir, "install-metadata.json"),
      `${JSON.stringify({
        version: MANAGED_RG_VERSION,
        target: MANAGED_RG_TARGET,
        sourceUrl: MANAGED_RG_URL,
        archiveSha256,
        binarySha256,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return {
      installedPath: await realpath(installedPath),
      version,
      archiveSha256,
      binarySha256,
      sourceUrl: MANAGED_RG_URL,
      reusedExisting: false,
    };
  } finally {
    await rm(stagedBinary, { force: true }).catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
