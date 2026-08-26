import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError, ErrorCode } from "../types.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import type { ResolvedTargetPreview } from "./queue.js";
import {
  requestAccessibilityBridge,
  type AccessibilityBridgeKind,
  type AccessibilityBridgePayload,
} from "./accessibility-bridge.js";

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

const MENU_BAR_ACCESSIBILITY_TIMEOUT_MS = 5_000;

function requestMenuBarAccessibility(
  kind: AccessibilityBridgeKind,
  payload?: AccessibilityBridgePayload,
): Promise<Record<string, unknown>> {
  return requestAccessibilityBridge({ kind, payload, timeoutMs: MENU_BAR_ACCESSIBILITY_TIMEOUT_MS });
}

/** Name of the frontmost (active) application, used as the 2nd sensitive-app
 * gate immediately before executing an approved action. */
export async function resolveFrontmostApp(): Promise<string | undefined> {
  assertDarwin();
  try {
    const result = await requestMenuBarAccessibility("frontmost");
    const name = typeof result.appName === "string" ? result.appName.trim() : "";
    if (name.length > 0) return name;
  } catch {
    // Fall through to the legacy System Events lookup below.
  }
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
  try {
    const result = await requestMenuBarAccessibility("windowregion", { appName });
    const x = typeof result.x === "number" ? result.x : Number.NaN;
    const y = typeof result.y === "number" ? result.y : Number.NaN;
    const width = typeof result.width === "number" ? result.width : Number.NaN;
    const height = typeof result.height === "number" ? result.height : Number.NaN;
    if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
      return { x, y, width, height };
    }
  } catch {
    // Fall through to the legacy System Events lookup below.
  }
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

export type MouseButton = "left" | "right" | "middle";

/** Click an absolute screen point. The signed menu-bar bridge is primary so
 * macOS evaluates the app's Accessibility TCC identity. clickCount is bounded
 * by callers to 1 or 2; non-left buttons intentionally have no System Events
 * fallback because silently degrading them to a left click would be unsafe. */
export async function clickAtPoint(
  appName: string,
  x: number,
  y: number,
  button: MouseButton = "left",
  clickCount = 1,
 ): Promise<void> {
  assertDarwin();
  const kind: AccessibilityBridgeKind = clickCount >= 2 ? "doubleclick" : "click";
  try {
    await requestMenuBarAccessibility(kind, { appName, x, y, button });
    return;
  } catch {
    // Fall through to the packaged helper and limited System Events fallback.
  }
  const helper = resolveHelperPath();
  if (helper) {
    try {
      await runHelper(helper, kind, { appName, x, y, button });
      return;
    } catch {
      // Fall through only for a left click.
    }
  }
  if (button !== "left") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `${button} click requires the native accessibility bridge`);
  }
  const repeatCount = clickCount >= 2 ? 2 : 1;
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application ${appleScriptString(appName)} to activate
    tell application "System Events"
      repeat ${repeatCount} times
        click at {${Math.round(x)}, ${Math.round(y)}}
        delay 0.05
      end repeat
    end tell
    `,
  ]);
}

/** Move the pointer without clicking. */
export async function moveMouseToPoint(appName: string, x: number, y: number): Promise<void> {
  assertDarwin();
  try {
    await requestMenuBarAccessibility("move", { appName, x, y });
    return;
  } catch {
    // Fall through to packaged helper.
  }
  const helper = resolveHelperPath();
  if (helper) {
    await runHelper(helper, "move", { appName, x, y });
    return;
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Mouse move requires the native accessibility bridge");
}

/** Drag through an already-resolved absolute path. */
export async function dragPoints(
  appName: string,
  points: Array<{ x: number; y: number }>,
  button: MouseButton = "left",
): Promise<void> {
  assertDarwin();
  try {
    await requestMenuBarAccessibility("drag", { appName, points, button });
    return;
  } catch {
    // Fall through to packaged helper.
  }
  const helper = resolveHelperPath();
  if (helper) {
    await runHelper(helper, "drag", { appName, points, button });
    return;
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Drag requires the native accessibility bridge");
}

/** Scroll at an absolute point. Positive scrollY means down and positive
 * scrollX means right, matching the model-facing computer-use convention. */
export async function scrollAtPoint(
  appName: string,
  x: number,
  y: number,
  scrollX: number,
  scrollY: number,
): Promise<void> {
  assertDarwin();
  try {
    await requestMenuBarAccessibility("scroll", { appName, x, y, scrollX, scrollY });
    return;
  } catch {
    // Fall through to packaged helper.
  }
  const helper = resolveHelperPath();
  if (helper) {
    await runHelper(helper, "scroll", { appName, x, y, scrollX, scrollY });
    return;
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Scroll requires the native accessibility bridge");
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
 * native helper's CGEvent keyboard synthesis over AppleScript `keystroke`. */
export async function typeText(appName: string, text: string): Promise<void> {
  assertDarwin();
  try {
    await requestMenuBarAccessibility("type", { appName, text });
    return;
  } catch {
    // Fall through to the packaged helper and System Events fallbacks below.
  }
  const helper = resolveHelperPath();
  if (helper) {
    try {
      await runHelper(helper, "type", { appName, text });
      return;
    } catch {
      // Fall through to the osascript fallback below.
    }
  }
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

/** Press a single virtual key code in `appName`. */
export async function pressKey(appName: string, keyCode: number): Promise<void> {
  assertDarwin();
  const roundedKeyCode = Math.round(keyCode);
  try {
    await requestMenuBarAccessibility("key", { appName, keyCode: roundedKeyCode });
    return;
  } catch {
    // Fall through to the packaged helper and System Events fallbacks below.
  }
  const helper = resolveHelperPath();
  if (helper) {
    try {
      await runHelper(helper, "key", { appName, keyCode: roundedKeyCode });
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
        key code ${roundedKeyCode}
      end tell
    end tell
    `,
  ]);
}

const KEY_NAME_TO_CODE: Record<string, number> = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11,
  Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, "1": 18, "2": 19, "3": 20, "4": 21,
  "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, O: 31,
  U: 32, "[": 33, I: 34, P: 35, ENTER: 36, RETURN: 36, L: 37, J: 38, "'": 39, K: 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, N: 45, M: 46, ".": 47, TAB: 48, SPACE: 49, BACKSPACE: 51,
  DELETE: 51, ESC: 53, ESCAPE: 53, HOME: 115, END: 119, PAGEUP: 116, PAGEDOWN: 121,
  LEFT: 123, RIGHT: 124, DOWN: 125, UP: 126, F1: 122, F2: 120, F3: 99, F4: 118,
  F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};

function keypressSpec(keys: string[]): { keyCodes: number[]; modifiers: string[] } {
  const modifiers: string[] = [];
  const keyCodes: number[] = [];
  for (const raw of keys) {
    const key = raw.trim().toUpperCase();
    if (["CMD", "COMMAND", "META"].includes(key)) { modifiers.push("command"); continue; }
    if (key === "SHIFT") { modifiers.push("shift"); continue; }
    if (["ALT", "OPTION"].includes(key)) { modifiers.push("option"); continue; }
    if (["CTRL", "CONTROL"].includes(key)) { modifiers.push("control"); continue; }
    if (["FN", "FUNCTION"].includes(key)) { modifiers.push("function"); continue; }
    const keyCode = KEY_NAME_TO_CODE[key];
    if (keyCode === undefined) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Unsupported key name: ${raw}`);
    keyCodes.push(keyCode);
  }
  if (keyCodes.length === 0) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "keypress requires at least one non-modifier key");
  return { keyCodes, modifiers: [...new Set(modifiers)] };
}

/** Press a named key or key chord such as ["CMD", "L"] or ["SHIFT", "TAB"]. */
export async function pressKeyNames(appName: string, keys: string[]): Promise<void> {
  assertDarwin();
  const spec = keypressSpec(keys);
  try {
    await requestMenuBarAccessibility("keypress", { appName, ...spec });
    return;
  } catch {
    // Fall through to packaged helper, then a validated AppleScript fallback.
  }
  const helper = resolveHelperPath();
  if (helper) {
    try {
      await runHelper(helper, "keypress", { appName, ...spec });
      return;
    } catch {
      // Fall through.
    }
  }
  const modifierMap: Record<string, string> = { command: "command down", shift: "shift down", option: "option down", control: "control down" };
  const modifiers = spec.modifiers.map((name) => modifierMap[name]).filter((value): value is string => Boolean(value));
  const usingClause = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
  for (const keyCode of spec.keyCodes) {
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      `tell application ${appleScriptString(appName)} to activate\ntell application "System Events" to key code ${keyCode}${usingClause}`,
    ]);
  }
}

export interface AxResolveTarget {
  role: string;
  title?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// AX semantic targeting: the signed menu-bar app bridge is primary so native
// AX/CGEvent work executes inside the process that owns the user's stable TCC
// grant. The bundled `chatgpt2codex-ax` executable remains a compatibility
// fallback, followed by System Events where applicable. Resolve is always
// side-effect free; press/setvalue re-resolve at actuation time and never
// reuse a stale reference from an earlier dry-run preview.
// ---------------------------------------------------------------------------

let cachedHelperPath: string | null | undefined;

/** Locate the signed `chatgpt2codex-ax` helper. Packaged runs resolve it
 * relative to this compiled module. Immutable runtime snapshots live outside
 * the .app bundle, so they also probe the fixed system install location.
 * Never fall back to PATH or arbitrary environment-provided executables. */
function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) return cachedHelperPath;
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, "..", "..", "..", "..", "MacOS", "chatgpt2codex-ax"));
  } catch {
    // Runtime snapshots may not live inside the packaged app bundle.
  }
  candidates.push("/Applications/ChatGPT To Codex.app/Contents/MacOS/chatgpt2codex-ax");
  cachedHelperPath = candidates.find((candidate) => existsSync(candidate)) ?? null;
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
  assertSafeAxRoleClass(target.role);
  try {
    const result = await requestMenuBarAccessibility("resolve", {
      appName,
      role: target.role,
      title: target.title,
      description: target.description,
    });
    return { source: "menu-bar", ...result } as ResolvedTargetPreview;
  } catch {
    // Fall through to the packaged helper and read-only System Events fallback.
  }
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
  assertSafeAxRoleClass(target.role);
  try {
    await requestMenuBarAccessibility("press", {
      appName,
      role: target.role,
      title: target.title,
      description: target.description,
    });
    return;
  } catch {
    // Fall through to the packaged helper and System Events fallbacks below.
  }
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
 * keystroke-based typeText when the menu-bar bridge and helper are unavailable. */
export async function setAxValue(appName: string, target: AxResolveTarget, text: string): Promise<void> {
  assertDarwin();
  assertSafeAxRoleClass(target.role);
  try {
    await requestMenuBarAccessibility("setvalue", {
      appName,
      role: target.role,
      title: target.title,
      description: target.description,
      text,
    });
    return;
  } catch {
    // Fall through to the packaged helper and focus/type fallbacks below.
  }
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
// failing partway through. The signed menu-bar process is the primary
// definitive source because it owns the stable TCC grant. The legacy helper
// is used only when the menu-bar bridge is unavailable; a source/dev run with
// neither native source reports `source: "unavailable"` rather than guessing.
// ---------------------------------------------------------------------------

export interface PermissionPreflightResult {
  accessibilityTrusted: boolean;
  screenRecordingAllowed: boolean;
  source: "menu-bar" | "ax-helper" | "unavailable";
  reason?: string;
}

export async function preflightPermissions(): Promise<PermissionPreflightResult> {
  assertDarwin();
  try {
    const result = await requestMenuBarAccessibility("preflight");
    return {
      accessibilityTrusted: result.accessibilityTrusted === true,
      screenRecordingAllowed: result.screenRecordingAllowed === true,
      source: "menu-bar",
    };
  } catch {
    // Fall through to the legacy packaged helper when the menu-bar app bridge is unavailable.
  }
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
