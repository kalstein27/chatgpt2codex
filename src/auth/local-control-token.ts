import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const TOKEN_FILE = "local-control-token";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const DIRECTORY_MODE = 0o700;
const TOKEN_MODE = 0o600;
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
const HAS_NO_FOLLOW = NO_FOLLOW !== 0;

export function localControlTokenPath(stateDir: string): string {
  return path.join(stateDir, TOKEN_FILE);
}

function isPosix(): boolean {
  return process.platform !== "win32";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function invalidDirectoryError(): Error {
  return new Error("Invalid local control token directory.");
}

function invalidTokenFileError(): Error {
  return new Error("Invalid local control token file.");
}

function assertCurrentOwner(info: Stats, errorFactory: () => Error): void {
  if (!isPosix()) return;
  const uid = process.getuid?.();
  if (uid === undefined || info.uid !== uid) throw errorFactory();
}

function assertMode(info: Stats, expected: number, errorFactory: () => Error): void {
  if (isPosix() && (info.mode & 0o777) !== expected) throw errorFactory();
}

async function secureStateDirectory(stateDir: string): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true, mode: DIRECTORY_MODE });
    let info = await lstat(stateDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw invalidDirectoryError();
    assertCurrentOwner(info, invalidDirectoryError);

    if (isPosix()) {
      await chmod(stateDir, DIRECTORY_MODE);
      info = await lstat(stateDir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw invalidDirectoryError();
      assertCurrentOwner(info, invalidDirectoryError);
      assertMode(info, DIRECTORY_MODE, invalidDirectoryError);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid local control token directory.") throw error;
    throw invalidDirectoryError();
  }
}

function assertRegularTokenHandle(handle: FileHandle): Promise<Stats> {
  return handle.stat().then((info) => {
    if (!info.isFile()) throw invalidTokenFileError();
    assertCurrentOwner(info, invalidTokenFileError);
    return info;
  });
}

async function hardenTokenHandle(handle: FileHandle): Promise<Stats> {
  let info = await assertRegularTokenHandle(handle);
  if (isPosix()) {
    await handle.chmod(TOKEN_MODE);
    info = await assertRegularTokenHandle(handle);
    assertMode(info, TOKEN_MODE, invalidTokenFileError);
  }
  return info;
}

/**
 * Open the final token component without following symlinks where the host
 * supports O_NOFOLLOW. On Windows, lstat-before/open/lstat-after plus fstat
 * checks provide the platform-compatible fail-safe boundary available to
 * Node; a replacement detected during that window is rejected.
 */
async function readExistingToken(filePath: string): Promise<string | undefined> {
  let before: Stats;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw invalidTokenFileError();
  }
  if (before.isSymbolicLink() || !before.isFile()) throw invalidTokenFileError();
  assertCurrentOwner(before, invalidTokenFileError);

  let handle: FileHandle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW);
  } catch {
    throw invalidTokenFileError();
  }
  try {
    const info = await hardenTokenHandle(handle);
    if (!HAS_NO_FOLLOW) {
      let after: Stats;
      try {
        after = await lstat(filePath);
      } catch {
        throw invalidTokenFileError();
      }
      if (after.isSymbolicLink() || !after.isFile() || after.dev !== info.dev || after.ino !== info.ino) {
        throw invalidTokenFileError();
      }
    }
    const token = (await handle.readFile({ encoding: "utf8" })).trim();
    return TOKEN_PATTERN.test(token) ? token : undefined;
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid local control token file.") throw error;
    throw invalidTokenFileError();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function createToken(filePath: string, token: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      TOKEN_MODE,
    );
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw error;
    throw new Error("Unable to create local control token file.");
  }

  try {
    await hardenTokenHandle(handle);
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
    await hardenTokenHandle(handle);
    return token;
  } catch {
    throw new Error("Unable to create local control token file.");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Create once and reuse a file-protected capability for the native tray. */
export async function ensureLocalControlToken(stateDir: string): Promise<string> {
  await secureStateDirectory(stateDir);
  const filePath = localControlTokenPath(stateDir);
  const existing = await readExistingToken(filePath);
  if (existing) return existing;

  const token = randomBytes(32).toString("base64url");
  try {
    return await createToken(filePath, token);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const raced = await readExistingToken(filePath);
    if (raced) return raced;
    throw invalidTokenFileError();
  }
}
