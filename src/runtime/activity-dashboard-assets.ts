import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_BYTES = 512 * 1024;
const CONTRACT_MARKER = '<meta name="c2ct-activity-dashboard-contract" content="1">';
const REVISION_PATTERN = /var pageDashboardRevision = "([a-f0-9]{16})";/u;

export const ACTIVITY_DASHBOARD_BUILD_ASSET_RELATIVE_PATH = path.join(
  "dist",
  "server",
  "activity-dashboard.asset.html",
);
export const ACTIVITY_DASHBOARD_OVERRIDE_FILE = "activity-dashboard.html";

export interface ActivityDashboardAssetResult {
  revision: string;
  bytes: number;
  target: string;
}

function validateDashboardHtml(html: string): { revision: string; bytes: number } {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes <= 0 || bytes > MAX_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, "Activity dashboard asset size is outside the allowed range", {
      bytes,
      maxBytes: MAX_BYTES,
    });
  }
  if (html.includes("\0")) {
    throw new DomainError(ErrorCode.NULLBYTE_REJECTED, "Activity dashboard asset contains a null byte");
  }
  if (!/^<!doctype html>/iu.test(html.trimStart()) || !html.includes(CONTRACT_MARKER)) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Activity dashboard asset does not match the expected document contract");
  }
  const revision = REVISION_PATTERN.exec(html)?.[1];
  if (!revision) {
    throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Activity dashboard asset is missing its revision marker");
  }
  return { revision, bytes };
}

async function writeAtomic(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, data, { encoding: "utf8", mode: FILE_MODE });
    await fs.chmod(temporaryPath, FILE_MODE).catch(() => undefined);
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, FILE_MODE).catch(() => undefined);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

export async function emitCandidateActivityDashboardAsset(options: {
  projectRoot: string;
  html: string;
}): Promise<ActivityDashboardAssetResult> {
  const validated = validateDashboardHtml(options.html);
  const target = path.join(options.projectRoot, ACTIVITY_DASHBOARD_BUILD_ASSET_RELATIVE_PATH);
  await writeAtomic(target, options.html);
  return { ...validated, target };
}

export async function applyRuntimeActivityDashboardAsset(options: {
  runtimeRoot: string;
  stateDir: string;
}): Promise<ActivityDashboardAssetResult | null> {
  const source = path.join(options.runtimeRoot, ACTIVITY_DASHBOARD_BUILD_ASSET_RELATIVE_PATH);
  let html: string;
  try {
    html = await fs.readFile(source, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const validated = validateDashboardHtml(html);
  const target = path.join(options.stateDir, ACTIVITY_DASHBOARD_OVERRIDE_FILE);
  await writeAtomic(target, html);
  return { ...validated, target };
}
