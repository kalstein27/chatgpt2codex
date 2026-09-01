import { DomainError, ErrorCode } from "../types.js";

/**
 * Option B (human-confirmed desktop control) policy primitives.
 *
 * Two independent gates must both be satisfied before any of the 4 control
 * tools can be reached at all:
 *  1. Feature flag `CHATGPT2CODEX_CONTROL` (isControlEnabled) — enabled by
 *     default; set it to "0"/"false"/"off" (case-insensitive) to opt out.
 *  2. A `control` lease preset explicitly granted via project_select
 *     (enforced separately by src/workspace/lease-guard.ts).
 * Neither gate alone is sufficient. Gate 1 only controls whether the tools
 * are registered/reachable at all — even with it on, gate 2 (and the
 * ChatGPT remote-execution gate + generic call-tool bridge block, which apply
 * unconditionally) still stand between ChatGPT and any control action.
 */

const CONTROL_ENV_FLAG = "CHATGPT2CODEX_CONTROL";
const CONTROL_ALLOWLIST_ENV_FLAG = "CHATGPT2CODEX_CONTROL_ALLOWLIST";
const CONTROL_CHATGPT_ENV_FLAG = "CHATGPT2CODEX_CONTROL_CHATGPT";

/**
 * Whether this build has a real synthetic-input backend for the current OS.
 * The queue and local approval API are cross-platform, but approved
 * click/type/key execution is currently implemented only by the macOS
 * backend. Native shells use this capability bit to avoid offering an Arm
 * control that cannot actually execute on the host.
 */
export function isDesktopControlSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/** Names of the 4 desktop-control MCP tools. Shared denylist used by:
 *  - src/server/tools.ts remote MCP tool handler guard (catalog stays visible)
 *  - src/server/actions.ts callRegisteredTool (block the generic call-tool/action bridge) */
export const CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "computer_screenshot",
  "computer_request_action",
  "computer_action_status",
  "computer_kill_switch",
]);

/**
 * Whether the desktop-control feature surface is enabled at all.
 * Enabled by default (including when the env var is unset) so the control
 * tools and status-bar control menu work even when the app is launched via
 * `open` with no environment configured. Set CHATGPT2CODEX_CONTROL to
 * "0"/"false"/"off" (case-insensitive) as an explicit opt-out safety valve.
 */
export function isControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CONTROL_ENV_FLAG];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

/**
 * Owner opt-in flag ("ChatGPT confirm" model): authorize the 4 desktop-control
 * tools for remote ChatGPT execution on their dedicated MCP surface, and let a
 * confirmed `computer_request_action` call execute immediately through the
 * executor path (src/control/tools.ts handleComputerRequestAction) instead of
 * only ever queuing for local human approval. Disabled by default — this is
 * the public-product-safe default, identical to today's hide+block behavior
 * — until the owner explicitly sets CHATGPT2CODEX_CONTROL_CHATGPT to
 * "1"/"true"/"on" (case-insensitive). Independent of `isControlEnabled`:
 * that flag controls whether the control surface exists at all (including
 * local-only use via stdio/status bar); this one only controls whether
 * ChatGPT specifically can see and call it.
 */
export function isControlChatGptExposed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CONTROL_CHATGPT_ENV_FLAG];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

/** ChatGPT-only execution semantics must never leak into local/native stdio clients. */
export function isRemoteChatGptControlExposed(
  remote: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return remote === true && isControlChatGptExposed(env);
}

/**
 * Case-insensitive substrings matched against app names/bundle-ish labels.
 * Any match blocks both synthetic input (click/type/key) and screenshot
 * capture, regardless of allowlist configuration.
 */
export const SENSITIVE_APP_DENYLIST: readonly string[] = [
  "1password",
  "bitwarden",
  "keepassxc",
  "passwords", // Apple Passwords.app
  "keychain access",
  "system settings",
  "system preferences",
  "authy",
  "google authenticator",
  "authenticator",
  "lastpass",
  "dashlane",
  "nordpass",
  "banking",
  "coinbase",
  "metamask",
  "crypto wallet",
];

export function isSensitiveApp(appName: string | undefined): boolean {
  if (!appName) return false;
  const norm = appName.trim().toLowerCase();
  return SENSITIVE_APP_DENYLIST.some((entry) => norm.includes(entry));
}

/** Explicit allowlist of app names control may target, configured via env
 * (comma-separated). Finder is the compatibility default only when the env
 * value is absent. An explicitly configured empty value means no app is
 * reachable, which lets the native settings UI fail closed. */
export function controlAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[CONTROL_ALLOWLIST_ENV_FLAG];
  if (raw === undefined) return ["Finder"];
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isAppAllowed(appName: string, allowlist: readonly string[]): boolean {
  const norm = appName.trim().toLowerCase();
  return allowlist.some((entry) => entry.trim().toLowerCase() === norm);
}

export interface AssertTargetInput {
  appName: string;
  frontmostAppName?: string;
  allowlist: readonly string[];
}

/**
 * Throws SENSITIVE_TARGET_BLOCKED unless the target app (and the frontmost
 * app, when known) is both absent from the sensitive denylist and present on
 * the explicit control allowlist. Called twice per action: once at
 * request-time (1st gate) and again immediately before execution using the
 * live frontmost app (2nd gate) — see src/control/tools.ts / executor.ts.
 */
export function assertAllowedTarget(input: AssertTargetInput): void {
  if (isSensitiveApp(input.appName)) {
    throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `Target app is blocked by the sensitive-app denylist: ${input.appName}`, {
      appName: input.appName,
    });
  }
  if (isSensitiveApp(input.frontmostAppName)) {
    throw new DomainError(
      ErrorCode.SENSITIVE_TARGET_BLOCKED,
      `Frontmost app is blocked by the sensitive-app denylist: ${input.frontmostAppName}`,
      { appName: input.frontmostAppName },
    );
  }
  if (!isAppAllowed(input.appName, input.allowlist)) {
    throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `App is not on the control allowlist: ${input.appName}`, {
      appName: input.appName,
    });
  }
}
