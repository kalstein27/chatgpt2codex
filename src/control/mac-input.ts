import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError, ErrorCode } from "../types.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import type { ResolvedTargetPreview } from "./queue.js";

/**
 * darwin-only synthetic-input primitives for Option B desktop control.
 * Every export throws NOT_IMPLEMENTED on non-darwin platforms. These are the
 * only functions in the codebase that actually move a mouse or send
 * keystrokes; they are only ever invoked by src/control/executor.ts after a
 * local human approval (never directly from a tool handler), except for
 * resolveAxElement which is deliberately side-effect free (no
 * activate/click/set) so it can be called from src/control/tools.ts at
 * request time to build a dry-run approval preview.
 */

function execFileAsync(
  file: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // execution-capability: macos-control-subprocess
    execFile(
      file,
      args,
      { env: { ...buildSafeChildEnv(), ...extraEnv }, windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `role` is interpolated as a raw AppleScript element class (e.g.
 * `every button of ...`, `first text field whose ...`) rather than a
 * quoted string literal — AppleScript class names cannot be quoted like
 * appleScriptString() does for title/description. An unconstrained role
 * value could therefore close the enclosing script clause and inject
 * arbitrary AppleScript (including `do shell script`). Defense in depth:
 * even though the MCP tool schema (src/server/tools.ts controlTargetSchema)
 * already restricts `role` with the same shape, re-validate here at the
 * actual interpolation sites so this module is safe regardless of caller. */
const AX_ROLE_CLASS_RE = /^[A-Za-z][A-Za-z ]{0,40}$/;

function assertSafeAxRoleClass(role: string): void {
  if (!AX_ROLE_CLASS_RE.test(role)) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Invalid accessibility role class: ${JSON.stringify(role)}`);
  }
}

function assertDarwin(): void {
  if (process.platform !== "darwin") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Desktop control synthetic input is only supported on macOS");
  }
}

/** Name of the frontmost (active) application, used as the 2nd sensitive-app
 * gate immediately before executing an approved action. */
export async function resolveFrontmostApp(): Promise<string | undefined> {
  assertDarwin();
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-e",
      `tell application "System Events" to get name of first process whose frontmost is true`,
    ], {}, 1_000);
    const name = stdout.trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

export interface AppWindowRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Absolute screen bounds of `appName`'s front window (same osascript
 * approach as src/e2e/local-e2e.ts getAppWindowRegion). */
export async function getAppWindowRegion(appName: string): Promise<AppWindowRegion> {
  assertDarwin();
  const { stdout } = await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application ${appleScriptString(appName)} to activate
    tell application "System Events"
      repeat 40 times
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
  const nums = parts.slice(0, 4).map((n) => Number.parseInt(n, 10));
  return { x: nums[0] ?? 0, y: nums[1] ?? 0, width: nums[2] ?? 0, height: nums[3] ?? 0 };
}

/** Resolve a window-relative point (0..1 fractions) to an absolute screen
 * point via the app's current front-window bounds. Used as the click-target
 * fallback when no accessibility element is available. */
export async function resolveWindowPoint(appName: string, xRel: number, yRel: number): Promise<{ x: number; y: number }> {
  const region = await getAppWindowRegion(appName);
  return {
    x: Math.round(region.x + region.width * xRel),
    y: Math.round(region.y + region.height * yRel),
  };
}

/** Click an absolute screen point. Prefers the native `chatgpt2codex-ax`
 * helper's CGEvent-based synthesis (more reliable against Electron/Chromium
 * apps than AppleScript UI scripting) and falls back to the existing
 * osascript "click at" primitive when the helper is unavailable or fails. */
export async function clickAtPoint(appName: string, x: number, y: number): Promise<void> {
  assertDarwin();
  const helper = resolveHelperPath();
  if (helper) {
    try {
      await runHelper(helper, "click", { appName, x, y });
      return;
    } catch {
      // Fall through to the osascript fallback below.
    }
  }
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application ${appleScriptString(appName)} to activate
    tell application "System Events"
      click at {${Math.round(x)}, ${Math.round(y)}}
    end tell
    `,
  ]);
}

export interface AxClickTarget {
  role: string;
  title?: string;
  label?: string;
}

/** Click an accessibility element in `appName`'s front window by role +
 * title/label, preferred over absolute/relative coordinates. */
export async function clickAxElement(appName: string, target: AxClickTarget): Promise<void> {
  assertDarwin();
  assertSafeAxRoleClass(target.role);
  const titleOrLabel = target.title ?? target.label;
  if (!titleOrLabel) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Accessibility click target requires a title or label");
  }
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application ${appleScriptString(appName)} to activate
    tell application "System Events"
      tell process ${appleScriptString(appName)}
        set frontmost to true
        click (first ${target.role} whose title is ${appleScriptString(titleOrLabel)} of front window)
      end tell
    end tell
    `,
  ]);
}

/** Type literal text into the frontmost element of `appName`. Prefers the
 * native helper's CGEvent keyboard synthesis over AppleScript `keystroke`
 * and falls back to it when the helper is unavailable or fails. The raw
 * `text` is only ever passed over the helper's stdin pipe, never logged. */
export async function typeText(appName: string, text: string): Promise<void> {
  assertDarwin();
  const helper = resolveHelperPath();
  if (helper) {
    try {
      await runHelper(helper, "type", { appName, text });
      return;
    } catch {
      // Fall through to the osascript fallback below.
    }
  }
  // The text is passed via an environment variable and read back with
  // `system attribute`, never inlined into the script argv: node's execFile
  // error.message includes the full "Command failed: <file> <args>" string
  // on failure (e.g. AppleScript error -1728), so inlining the raw text here
  // would leak it — including passwords typed into a form — into any caller
  // that logs or returns that error message (ledger, tool result to
  // ChatGPT). See src/control/executor.ts's catch handler.
  await execFileAsync(
    "/usr/bin/osascript",
    [
      "-e",
      `
    tell application ${appleScriptString(appName)} to activate
    tell application "System Events"
      tell process ${appleScriptString(appName)}
        set frontmost to true
        keystroke (system attribute "CHATGPT2CODEX_CTL_TYPE_TEXT")
      end tell
    end tell
    `,
    ],
    { CHATGPT2CODEX_CTL_TYPE_TEXT: text },
  );
}

/** Press a single virtual key code in `appName`. Prefers the native helper's
 * CGEvent keyboard synthesis over AppleScript `key code` and falls back to
 * it when the helper is unavailable or fails. */
export async function pressKey(appName: string, keyCode: number): Promise<void> {
  assertDarwin();
  const helper = resolveHelperPath();
  if (helper) {
    try {
      await runHelper(helper, "key", { appName, keyCode: Math.round(keyCode) });
      return;
    } catch {
      // Fall through to the osascript fallback below.
    }
  }
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application ${appleScriptString(appName)} to activate
    tell application "System Events"
      tell process ${appleScriptString(appName)}
        set frontmost to true
        key code ${Math.round(keyCode)}
      end tell
    end tell
    `,
  ]);
}

export interface AxResolveTarget {
  role: string;
  title?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// AX semantic targeting: native `chatgpt2codex-ax` helper (preferred, ships
// inside the signed .app bundle at Contents/MacOS/chatgpt2codex-ax, built by
// scripts/build-macos-app.sh from macos/ChatGPTToCodexStatusBar/ax-helper.swift)
// with an osascript/System Events read-only fallback for source/dev runs
// where the helper hasn't been built. Resolve is always side-effect free;
// press/setvalue re-resolve the element at actuation time (never reuse a
// stale reference from an earlier dry-run preview).
// ---------------------------------------------------------------------------

let cachedHelperPath: string | null | undefined;

/** Locate the bundled `chatgpt2codex-ax` helper relative to this compiled
 * module (dist/control/mac-input.js -> Contents/Resources/chatgpt2codex/dist/control
 * -> up 4 -> Contents/MacOS/chatgpt2codex-ax). Returns null (cached) when not
 * running from inside the packaged app, e.g. source/dev/test runs. */
function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) return cachedHelperPath;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(here, "..", "..", "..", "..", "MacOS", "chatgpt2codex-ax");
    cachedHelperPath = existsSync(candidate) ? candidate : null;
  } catch {
    cachedHelperPath = null;
  }
  return cachedHelperPath;
}

function runHelper(helperPath: string, subcommand: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // execution-capability: macos-ax-helper-stream
    const child = spawn(helperPath, [subcommand], { env: buildSafeChildEnv(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`chatgpt2codex-ax ${subcommand} exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

const AX_FRAME_DELIM = "";

/** Read-only osascript/System Events fallback for resolveAxElement. Never
 * activates, clicks, or sets frontmost — only reads role/title/description/
 * position/size, so it is safe to call at dry-run preview time. */
async function resolveAxElementViaSystemEvents(appName: string, target: AxResolveTarget): Promise<ResolvedTargetPreview> {
  assertSafeAxRoleClass(target.role);
  const filterProp = target.title !== undefined ? "title" : target.description !== undefined ? "description" : undefined;
  const filterValue = target.title ?? target.description;
  if (!filterProp || filterValue === undefined) {
    return { found: false, reason: "target requires a title or description to resolve", source: "system-events" };
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-e",
      `
      tell application "System Events"
        if not (exists process ${appleScriptString(appName)}) then error "process not found"
        tell process ${appleScriptString(appName)}
          if (count of windows) = 0 then error "no windows"
          set matchList to (every ${target.role} of front window whose ${filterProp} is ${appleScriptString(filterValue)})
          if (count of matchList) = 0 then error "not found"
          set el to item 1 of matchList
          set r to role of el
          set t to ""
          set d to ""
          try
            set t to title of el
          end try
          try
            set d to description of el
          end try
          set p to position of el
          set s to size of el
          set winTitle to title of front window
          return r & "${AX_FRAME_DELIM}" & t & "${AX_FRAME_DELIM}" & d & "${AX_FRAME_DELIM}" & ((item 1 of p) as integer) & "," & ((item 2 of p) as integer) & "," & ((item 1 of s) as integer) & "," & ((item 2 of s) as integer) & "${AX_FRAME_DELIM}" & (count of matchList) & "${AX_FRAME_DELIM}" & winTitle
        end tell
      end tell
      `,
    ], {}, 3_000);
    const parts = stdout.trimEnd().split(AX_FRAME_DELIM);
    const [role, title, description, frameStr, matchCountStr, window] = parts;
    const frameNums = (frameStr ?? "").match(/-?\d+/g)?.map((n) => Number.parseInt(n, 10));
    const frame =
      frameNums && frameNums.length >= 4
        ? { x: frameNums[0] ?? 0, y: frameNums[1] ?? 0, width: frameNums[2] ?? 0, height: frameNums[3] ?? 0 }
        : undefined;
    return {
      found: true,
      role: role || target.role,
      title: title && title.length > 0 ? title : undefined,
      description: description && description.length > 0 ? description : undefined,
      frame,
      app: appName,
      window: window && window.length > 0 ? window : undefined,
      matchCount: matchCountStr ? Number.parseInt(matchCountStr, 10) : undefined,
      source: "system-events",
    };
  } catch (err) {
    return { found: false, reason: err instanceof Error ? err.message : String(err), source: "system-events" };
  }
}

/** Resolve an accessibility element by role + title/description, without any
 * side effect (no activate, no click, no focus change). Used by
 * src/control/tools.ts to build the human-readable dry-run approval preview
 * before a control action is ever queued for approval. Prefers the native
 * `chatgpt2codex-ax` helper (works even against Electron/Chromium apps whose
 * AX tree is otherwise empty) and falls back to a read-only System Events
 * query when the helper isn't present (source/dev runs). */
export async function resolveAxElement(appName: string, target: AxResolveTarget): Promise<ResolvedTargetPreview> {
  assertDarwin();
  const helper = resolveHelperPath();
  if (helper) {
    try {
      const result = await runHelper(helper, "resolve", {
        appName,
        role: target.role,
        title: target.title,
        description: target.description,
      });
      return { source: "ax-helper", ...result } as ResolvedTargetPreview;
    } catch {
      // Fall through to the read-only System Events query below.
    }
  }
  return resolveAxElementViaSystemEvents(appName, target);
}

/** Press (AXPress) an accessibility element by role + title/description.
 * Re-resolves the element immediately before acting (never reuses a frame
 * captured by an earlier resolveAxElement dry-run preview), so an element
 * that moved or disappeared since the request was approved fails instead of
 * mis-clicking. Falls back to the existing System Events click, then to a
 * resolved center-point click, when the native helper is unavailable. */
export async function pressAxElement(appName: string, target: AxResolveTarget): Promise<void> {
  assertDarwin();
  const helper = resolveHelperPath();
  if (helper) {
    try {
      await runHelper(helper, "press", { appName, role: target.role, title: target.title, description: target.description });
      return;
    } catch {
      // Fall through to the osascript fallbacks below.
    }
  }
  if (target.title) {
    try {
      await clickAxElement(appName, { role: target.role, title: target.title });
      return;
    } catch {
      // Fall through to the resolve+point fallback below.
    }
  }
  const resolved = await resolveAxElementViaSystemEvents(appName, target);
  if (resolved.found && resolved.frame) {
    await clickAtPoint(appName, resolved.frame.x + resolved.frame.width / 2, resolved.frame.y + resolved.frame.height / 2);
    return;
  }
  throw new DomainError(
    ErrorCode.NOT_IMPLEMENTED,
    `Could not resolve accessibility element to press: ${target.role} ${target.title ?? target.description ?? ""}`.trim(),
  );
}

/** Set the value of an accessibility text element (AXSetValue) by role +
 * title/description, re-resolving at actuation time like pressAxElement.
 * Falls back to focusing the element (pressAxElement) then the existing
 * keystroke-based typeText when the native helper is unavailable. */
export async function setAxValue(appName: string, target: AxResolveTarget, text: string): Promise<void> {
  assertDarwin();
  const helper = resolveHelperPath();
  if (helper) {
    try {
      await runHelper(helper, "setvalue", {
        appName,
        role: target.role,
        title: target.title,
        description: target.description,
        text,
      });
      return;
    } catch {
      // Fall through to the focus-then-keystroke fallback below.
    }
  }
  await pressAxElement(appName, target);
  await typeText(appName, text);
}

// ---------------------------------------------------------------------------
// Live permission preflight: surfaces the real Accessibility/Screen
// Recording trust state so callers (executor.ts, `chatgpt2codex control
// preflight`) can report a clear reason instead of a control action silently
// failing partway through. Only the native helper (running inside the
// signed .app, which is what actually needs/holds the TCC grants) can answer
// this definitively; a source/dev run without the built helper reports
// `source: "unavailable"` rather than guessing.
// ---------------------------------------------------------------------------

export interface PermissionPreflightResult {
  accessibilityTrusted: boolean;
  screenRecordingAllowed: boolean;
  source: "ax-helper" | "unavailable";
  reason?: string;
}

export async function preflightPermissions(): Promise<PermissionPreflightResult> {
  assertDarwin();
  const helper = resolveHelperPath();
  if (helper) {
    try {
      const result = await runHelper(helper, "preflight", {});
      return {
        accessibilityTrusted: result.accessibilityTrusted === true,
        screenRecordingAllowed: result.screenRecordingAllowed === true,
        source: "ax-helper",
      };
    } catch (err) {
      return {
        accessibilityTrusted: false,
        screenRecordingAllowed: false,
        source: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return {
    accessibilityTrusted: false,
    screenRecordingAllowed: false,
    source: "unavailable",
    reason: "native chatgpt2codex-ax helper not found (dev/source run); permission state cannot be determined outside the packaged app",
  };
}
