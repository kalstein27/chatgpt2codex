import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";
import { redact } from "../policy/secrets.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { guardShellCommand } from "../exec/local-shell.js";

export interface E2eScreenshotResult {
  path: string;
  bytes: number;
  opened: boolean;
  captureMode: "screen" | "browser-region" | "app-window";
  targetUrl?: string;
  targetAppName?: string;
  shotLabel?: string;
}

/** Mirrors src/server/tools.ts's isLocalHttpUrl (duplicated rather than
 * imported to avoid a circular import: tools.ts already imports from this
 * module). Every current tools.ts caller of openE2eTarget/
 * captureE2eUrlScreenshot's `url` already validates it with that same
 * predicate before calling in (e2e_open_target, e2e_open_url_screenshot,
 * e2e_test_and_show_screenshot) — except e2e_run_command's `screenshotUrl`
 * input, which reached captureE2eUrlScreenshot with no caller-side check at
 * all. Re-validating here, at the two url-accepting entry points
 * themselves, closes that gap and means no future/alternate caller can
 * reopen it either: without this, an attacker-controlled url (file://,
 * cloud-metadata/internal http, chrome://) would drive the owner's real,
 * cookie-bearing Chrome via osascript/`open` and the rendered content would
 * be returned as a screenshot (SSRF + local-file-read). */
function isLocalHttpUrl(value: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(value);
}

function assertLocalHttpUrl(url: string, fnName: string): void {
  if (!isLocalHttpUrl(url)) {
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      `${fnName} only opens local loopback http(s) URLs; external/file/custom-scheme URLs require local approval.`,
    );
  }
}

function slug(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return clean || "e2e";
}

function e2eId(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `e2e-${Date.now()}-${digest}`;
}

async function e2eDir(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, ".chatgpt2codex", "e2e");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function execFileAsync(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // execution-capability: e2e-fixed-tool
    execFile(file, args, { env: buildSafeChildEnv(), windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function captureRegionScreenshot(
  projectRoot: string,
  input: {
    label: string;
    region: string;
    openAfterCapture?: boolean;
    captureMode: "browser-region" | "app-window";
    targetUrl?: string;
    targetAppName?: string;
    shotLabel?: string;
  },
): Promise<E2eScreenshotResult> {
  const root = await fs.realpath(projectRoot);
  const dir = path.join(await e2eDir(root), "screenshots");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${slug(input.label)}.png`);
  await execFileAsync("/usr/sbin/screencapture", ["-x", "-R", input.region, file]);
  const stat = await fs.stat(file);
  if (stat.size === 0) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      "macOS Screen Recording permission is required for E2E screenshots. Open ChatGPT To Codex > Screenshot Permission, enable ChatGPT To Codex in System Settings > Privacy & Security > Screen Recording, then retry.",
      { permission: "screen-recording" },
    );
  }
  const opened = input.openAfterCapture === true;
  if (opened) {
    await execFileAsync("/usr/bin/open", [file]);
  }
  return {
    path: file,
    bytes: stat.size,
    opened,
    captureMode: input.captureMode,
    targetUrl: input.targetUrl,
    targetAppName: input.targetAppName,
    shotLabel: input.shotLabel,
  };
}

async function getAppWindowRegion(appName: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application ${appleScriptString(appName)} to activate
    tell application "System Events"
      repeat 80 times
        if exists process ${appleScriptString(appName)} then
          tell process ${appleScriptString(appName)}
            set frontmost to true
            if (count of windows) > 0 then
              set winPos to position of front window
              set winSize to size of front window
              return ((item 1 of winPos) as integer) & "," & ((item 2 of winPos) as integer) & "," & ((item 1 of winSize) as integer) & "," & ((item 2 of winSize) as integer)
            end if
          end tell
        end if
        delay 0.25
      end repeat
    end tell
    error "app window not found"
    `,
  ]);
  const parts = stdout.match(/-?\d+/g);
  if (!parts || parts.length < 4) {
    throw new Error(`invalid app window bounds: ${stdout.trim()}`);
  }
  return parts.slice(0, 4).join(",");
}

async function scrollAppWindow(appName: string): Promise<void> {
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application "System Events"
      if exists process ${appleScriptString(appName)} then
        tell process ${appleScriptString(appName)}
          set frontmost to true
          key code 121
        end tell
      end if
    end tell
    `,
  ]);
}

async function scrollChromePage(fraction: number): Promise<void> {
  const clamped = Math.max(0, Math.min(1, fraction));
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application "Google Chrome"
      execute active tab of front window javascript "window.scrollTo(0, Math.max(0, (document.documentElement.scrollHeight - window.innerHeight) * ${clamped}));"
    end tell
    `,
  ]);
}

async function waitForUrl(url: string, timeoutSec: number): Promise<{ ok: boolean; status?: number; error?: string; elapsedMs: number }> {
  const started = Date.now();
  const deadline = started + timeoutSec * 1000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.status < 500) {
        return { ok: true, status: res.status, elapsedMs: Date.now() - started };
      }
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  return { ok: false, error: lastError || "timeout", elapsedMs: Date.now() - started };
}

export async function startE2eServer(
  projectRoot: string,
  input: {
    command: string;
    cwd?: string;
    label?: string;
    waitUrl?: string;
    waitTimeoutSec?: number;
  },
): Promise<{
  runId: string;
  pid: number;
  cwd: string;
  logPath: string;
  wait?: { ok: boolean; status?: number; error?: string; elapsedMs: number };
}> {
  guardShellCommand(input.command);
  const root = await fs.realpath(projectRoot);
  const commandCwd = input.cwd ? await resolveInProject(root, input.cwd, { allowSymlink: false }) : root;
  const stat = await fs.stat(commandCwd).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "cwd is not a project directory", { cwd: input.cwd });
  }

  const dir = await e2eDir(root);
  const runId = e2eId(input.command);
  const logPath = path.join(dir, `${runId}-${slug(input.label ?? "server")}.log`);
  const out = await fs.open(logPath, "a");
  // execution-capability: e2e-project-server-shell
  const child = spawn("/bin/zsh", ["-lc", input.command], {
    cwd: commandCwd,
    env: buildSafeChildEnv(),
    detached: true,
    stdio: ["ignore", out.fd, out.fd],
  });
  child.unref();
  await out.close();

  const wait = input.waitUrl ? await waitForUrl(input.waitUrl, input.waitTimeoutSec ?? 30) : undefined;
  return {
    runId,
    pid: child.pid ?? 0,
    cwd: path.relative(root, commandCwd) || ".",
    logPath,
    wait,
  };
}

export async function stopE2eServer(input: { pid: number }): Promise<{ stopped: boolean; error?: string }> {
  if (!input.pid || input.pid < 1) {
    return { stopped: false, error: "missing pid" };
  }
  try {
    process.kill(-input.pid, "SIGTERM");
    await delay(500);
    return { stopped: true };
  } catch (error) {
    return { stopped: false, error: summarizeE2eError(error) };
  }
}

export async function openE2eTarget(input: { url?: string; appName?: string; appPath?: string; args?: string[] }): Promise<{
  launched: string;
}> {
  if (input.url) {
    assertLocalHttpUrl(input.url, "openE2eTarget");
    await execFileAsync("/usr/bin/open", [input.url]);
    return { launched: input.url };
  }
  if (input.appPath) {
    await execFileAsync("/usr/bin/open", [input.appPath, ...(input.args?.length ? ["--args", ...input.args] : [])]);
    return { launched: input.appPath };
  }
  if (input.appName) {
    await execFileAsync("/usr/bin/open", ["-a", input.appName, ...(input.args?.length ? ["--args", ...input.args] : [])]);
    return { launched: input.appName };
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Provide url, appName, or appPath");
}

export interface E2eScreenshotPreview {
  path: string;
  bytes: number;
  mimeType: "image/jpeg";
}

const PREVIEW_MAX_DIMENSION = "1200";
const PREVIEW_JPEG_QUALITY = "70";

/**
 * Downscaled JPEG preview of a captured PNG screenshot, written next to the
 * original as `<name>-preview.jpg`. Full-resolution retina PNGs are too large
 * to inline into chat clients; the preview keeps inline delivery (widget data
 * URIs, MCP image content) small. Returns null when sips is unavailable or
 * conversion fails so callers can fall back to the original PNG.
 */
export async function createE2eScreenshotPreview(screenshotPath: string): Promise<E2eScreenshotPreview | null> {
  if (!screenshotPath.endsWith(".png")) return null;
  const previewPath = `${screenshotPath.slice(0, -4)}-preview.jpg`;
  try {
    const existing = await fs.stat(previewPath).catch(() => null);
    if (!existing?.isFile() || existing.size === 0) {
      await execFileAsync("/usr/bin/sips", [
        "--resampleHeightWidthMax",
        PREVIEW_MAX_DIMENSION,
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        PREVIEW_JPEG_QUALITY,
        screenshotPath,
        "--out",
        previewPath,
      ]);
    }
    const stat = await fs.stat(previewPath);
    if (!stat.isFile() || stat.size === 0) return null;
    return { path: previewPath, bytes: stat.size, mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

export async function captureE2eScreenshot(
  projectRoot: string,
  input: { label?: string; waitMs?: number; openAfterCapture?: boolean },
): Promise<E2eScreenshotResult> {
  if (process.platform !== "darwin") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "screencapture-based E2E screenshots are currently supported on macOS");
  }
  if (input.waitMs && input.waitMs > 0) {
    await delay(Math.min(input.waitMs, 30_000));
  }
  const root = await fs.realpath(projectRoot);
  const dir = path.join(await e2eDir(root), "screenshots");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${slug(input.label ?? "screen")}.png`);
  try {
    await execFileAsync("/usr/sbin/screencapture", ["-x", file]);
  } catch (error) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      "macOS Screen Recording permission is required for E2E screenshots. Open ChatGPT To Codex > Screenshot Permission, enable ChatGPT To Codex in System Settings > Privacy & Security > Screen Recording, then retry.",
      { permission: "screen-recording", cause: summarizeE2eError(error) },
    );
  }
  const stat = await fs.stat(file);
  if (stat.size === 0) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      "macOS Screen Recording permission is required for E2E screenshots. Open ChatGPT To Codex > Screenshot Permission, enable ChatGPT To Codex in System Settings > Privacy & Security > Screen Recording, then retry.",
      { permission: "screen-recording" },
    );
  }
  const opened = input.openAfterCapture === true;
  if (opened) {
    await execFileAsync("/usr/bin/open", [file]);
  }
  return { path: file, bytes: stat.size, opened, captureMode: "screen" };
}

export async function captureE2eUrlScreenshot(
  projectRoot: string,
  input: {
    url: string;
    label?: string;
    waitMs?: number;
    openAfterCapture?: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  },
): Promise<E2eScreenshotResult> {
  assertLocalHttpUrl(input.url, "captureE2eUrlScreenshot");
  if (process.platform !== "darwin") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "browser-region E2E screenshots are currently supported on macOS");
  }
  const x = input.x ?? 80;
  const y = input.y ?? 80;
  const width = input.width ?? 1440;
  const height = input.height ?? 900;

  try {
    const right = x + width;
    const bottom = y + height;
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      `
      tell application "Google Chrome"
        activate
        if (count of windows) = 0 then make new window
        set bounds of front window to {${x}, ${y}, ${right}, ${bottom}}
        set URL of active tab of front window to ${appleScriptString(input.url)}
      end tell
      `,
    ]);
  } catch {
    await openE2eTarget({ url: input.url });
    return captureE2eScreenshot(projectRoot, {
      label: input.label ?? "url-fallback",
      waitMs: input.waitMs ?? 1500,
      openAfterCapture: input.openAfterCapture,
    });
  }

  if (input.waitMs && input.waitMs > 0) {
    await delay(Math.min(input.waitMs, 30_000));
  }
  return captureRegionScreenshot(projectRoot, {
    label: input.label ?? "url",
    region: `${x},${y},${width},${height}`,
    openAfterCapture: input.openAfterCapture,
    captureMode: "browser-region",
    targetUrl: input.url,
    shotLabel: input.label,
  });
}

export async function captureE2eUrlScreenshotSet(
  projectRoot: string,
  input: {
    url: string;
    label?: string;
    waitMs?: number;
    openAfterCapture?: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  },
): Promise<E2eScreenshotResult[]> {
  const x = input.x ?? 80;
  const y = input.y ?? 80;
  const width = input.width ?? 1440;
  const height = input.height ?? 900;
  const shots: E2eScreenshotResult[] = [];
  shots.push(
    await captureE2eUrlScreenshot(projectRoot, {
      ...input,
      label: `${input.label ?? "url"}-top`,
      openAfterCapture: false,
    }),
  );
  for (const [shotLabel, fraction] of [
    ["middle", 0.5],
    ["bottom", 1],
  ] as const) {
    try {
      await scrollChromePage(fraction);
      await delay(input.waitMs ?? 900);
      shots.push(
        await captureRegionScreenshot(projectRoot, {
          label: `${input.label ?? "url"}-${shotLabel}`,
          region: `${x},${y},${width},${height}`,
          openAfterCapture: false,
          captureMode: "browser-region",
          targetUrl: input.url,
          shotLabel,
        }),
      );
    } catch {
      // A page may not be scrollable or Chrome automation may be unavailable.
    }
  }
  if (input.openAfterCapture && shots[0]) {
    await execFileAsync("/usr/bin/open", [shots[0].path]);
    shots[0].opened = true;
  }
  return shots;
}

export async function captureE2eAppScreenshot(
  projectRoot: string,
  input: {
    appName: string;
    label?: string;
    waitMs?: number;
    openAfterCapture?: boolean;
  },
): Promise<E2eScreenshotResult> {
  if (process.platform !== "darwin") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "app-window E2E screenshots are currently supported on macOS");
  }
  if (input.waitMs && input.waitMs > 0) {
    await delay(Math.min(input.waitMs, 30_000));
  }

  let region = "";
  try {
    region = await getAppWindowRegion(input.appName);
  } catch (error) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      `macOS Accessibility permission is required to capture the ${input.appName} app window. Enable ChatGPT To Codex in System Settings > Privacy & Security > Accessibility, then retry.`,
      { permission: "accessibility", appName: input.appName, cause: summarizeE2eError(error) },
    );
  }

  return captureRegionScreenshot(projectRoot, {
    label: input.label ?? input.appName,
    region,
    openAfterCapture: input.openAfterCapture,
    captureMode: "app-window",
    targetAppName: input.appName,
    shotLabel: input.label,
  });
}

export async function captureE2eAppScreenshotSet(
  projectRoot: string,
  input: {
    appName: string;
    label?: string;
    waitMs?: number;
    openAfterCapture?: boolean;
  },
): Promise<E2eScreenshotResult[]> {
  const shots: E2eScreenshotResult[] = [];
  shots.push(
    await captureE2eAppScreenshot(projectRoot, {
      ...input,
      label: `${input.label ?? input.appName}-top`,
      openAfterCapture: false,
    }),
  );
  for (const shotLabel of ["middle", "bottom"] as const) {
    try {
      await scrollAppWindow(input.appName);
      await delay(input.waitMs ?? 900);
      shots.push(
        await captureE2eAppScreenshot(projectRoot, {
          ...input,
          label: `${input.label ?? input.appName}-${shotLabel}`,
          openAfterCapture: false,
        }),
      );
    } catch {
      // Some app windows do not accept Page Down; keep the successful shots.
    }
  }
  if (input.openAfterCapture && shots[0]) {
    await execFileAsync("/usr/bin/open", [shots[0].path]);
    shots[0].opened = true;
  }
  return shots;
}

export function summarizeE2eError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
