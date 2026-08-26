import { promises as fs } from "node:fs";
import path from "node:path";
import { controlAllowlist, isAppAllowed, isSensitiveApp } from "./policy.js";

/**
 * Local-only "auto-approve" scope flag, mirroring the KILL flag pattern in
 * src/control/queue.ts (same `stateDir/control/**` directory, same 0600 file
 * mode). This file is the single source of truth for whether a *pending*
 * control action may be promoted straight to `approved` without a human
 * clicking Approve.
 *
 * The only writers of this file are setAuto/clearAuto below. Their only
 * callers are:
 *  - src/cli.ts `control auto on|off` (a local human at the keyboard; the
 *    macOS status-bar toggle goes through this same CLI path, never a
 *    direct file write of its own — see main.swift runCli(["control",
 *    "auto", ...])).
 *  - src/control/queue.ts setKill (kill always clears auto too).
 * No MCP tool handler (src/control/tools.ts computer_*) and no HTTP route
 * imports this module: the model/ChatGPT can request actions (enqueue) but
 * has no path that turns auto-approval on or widens its scope.
 *
 * autoDecision() is the single point of truth consulted by
 * src/control/executor.ts before ever promoting a pending action; it
 * re-applies the sensitive-app denylist and app allowlist on every check
 * (never trusts the scope file alone), and lazily clears an expired scope
 * so the session automatically falls back to manual approval.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TTL_MINUTES = 10;
const MAX_TTL_MINUTES = 60;

export type AutoActionKind =
  | "click"
  | "double_click"
  | "drag"
  | "scroll"
  | "move"
  | "type"
  | "key"
  | "keypress"
  | "wait";

/** On-disk shape. Contains no secrets and no input text/payloads — just app
 * names, timestamps, and a use counter. */
export interface AutoScope {
  enabledAt: number;
  expiresAt: number;
  /** Normalized (trimmed, lowercased) app names this scope applies to.
   * Always a subset of the control allowlist at the time it was set. */
  apps: string[];
  kinds?: AutoActionKind[];
  maxCount?: number;
  count: number;
}

export interface SetAutoInput {
  apps: string[];
  minutes?: number;
  kinds?: AutoActionKind[];
  maxCount?: number;
}

export interface AutoDecisionInput {
  appName: string;
  kind: AutoActionKind;
}

export interface AutoDecisionResult {
  allowed: boolean;
  scope?: AutoScope;
}

function controlDir(stateDir: string): string {
  return path.join(stateDir, "control");
}

function autoFlagPath(stateDir: string): string {
  return path.join(controlDir(stateDir), "AUTO");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    // Non-fatal: filesystem may not support POSIX permission bits.
  }
}

function normalizeApp(name: string): string {
  return name.trim().toLowerCase();
}

/** Clamp a requested TTL into (0, MAX_TTL_MINUTES], defaulting to
 * DEFAULT_TTL_MINUTES when unset/invalid. Exported so the CLI can echo the
 * effective value back to the operator. */
export function clampMinutes(minutes: number | undefined): number {
  const requested = minutes === undefined || Number.isNaN(minutes) ? DEFAULT_TTL_MINUTES : minutes;
  return Math.min(Math.max(requested, 1), MAX_TTL_MINUTES);
}

async function writeScope(stateDir: string, scope: AutoScope): Promise<void> {
  await ensureDir(controlDir(stateDir));
  const file = autoFlagPath(stateDir);
  await fs.writeFile(file, `${JSON.stringify(scope, null, 2)}\n`, { mode: FILE_MODE });
  try {
    await fs.chmod(file, FILE_MODE);
  } catch {
    // Non-fatal.
  }
}

/**
 * Turn on auto-approval for a bounded scope. Local-human-only entrypoint
 * (see module doc). Apps are defensively re-filtered here to the current
 * sensitive-app denylist and control allowlist intersection, so a caller
 * can never widen effective scope beyond what those two gates already
 * permit, even if the CLI-level filtering above it had a bug.
 */
export async function setAuto(stateDir: string, input: SetAutoInput): Promise<AutoScope> {
  const allowlist = controlAllowlist();
  const apps = Array.from(
    new Set(
      input.apps
        .map(normalizeApp)
        .filter((app) => app.length > 0 && !isSensitiveApp(app) && isAppAllowed(app, allowlist)),
    ),
  );
  const now = Date.now();
  const minutes = clampMinutes(input.minutes);
  const scope: AutoScope = {
    enabledAt: now,
    expiresAt: now + minutes * 60 * 1000,
    apps,
    kinds: input.kinds && input.kinds.length > 0 ? input.kinds : undefined,
    maxCount: input.maxCount,
    count: 0,
  };
  await writeScope(stateDir, scope);
  return scope;
}

/** Turn off auto-approval immediately. Called by `control auto off` and by
 * src/control/queue.ts setKill (kill always disables auto too). */
export async function clearAuto(stateDir: string): Promise<void> {
  await fs.unlink(autoFlagPath(stateDir)).catch(() => undefined);
}

/** Read the raw scope file, if any, without side effects (no expiry check). */
export async function readAuto(stateDir: string): Promise<AutoScope | null> {
  try {
    const raw = await fs.readFile(autoFlagPath(stateDir), "utf8");
    return JSON.parse(raw) as AutoScope;
  } catch {
    return null;
  }
}

/** Increment the use counter after a successful auto-approval. Called by
 * src/control/executor.ts once per promoted action. Best-effort: losing a
 * concurrent increment only makes maxCount slightly generous, it never lets
 * auto bypass the sensitive-app/allowlist/TTL gates checked on every call
 * to autoDecision. */
export async function recordAutoUse(stateDir: string): Promise<void> {
  const scope = await readAuto(stateDir);
  if (!scope) return;
  await writeScope(stateDir, { ...scope, count: scope.count + 1 });
}

/**
 * Whether a pending action for `input.appName`/`input.kind` may be
 * auto-approved right now. Every condition must hold:
 *  (a) an AUTO scope file exists,
 *  (b) it has not expired — otherwise it is lazily cleared here so the
 *      session falls back to manual approval automatically,
 *  (c) the target app is not on the sensitive-app denylist,
 *  (d) the target app is on both the live control allowlist and the
 *      scope's own app list,
 *  (e) kinds is unset or includes this action's kind,
 *  (f) maxCount is unset or the scope hasn't used it up yet.
 * The caller (src/control/executor.ts) is responsible for calling
 * recordAutoUse() after a true decision is actually acted on.
 */
export async function autoDecision(stateDir: string, input: AutoDecisionInput, now: number = Date.now()): Promise<AutoDecisionResult> {
  const scope = await readAuto(stateDir);
  if (!scope) return { allowed: false };
  if (now >= scope.expiresAt) {
    await clearAuto(stateDir);
    return { allowed: false };
  }
  if (isSensitiveApp(input.appName)) return { allowed: false, scope };
  const norm = normalizeApp(input.appName);
  if (!isAppAllowed(norm, controlAllowlist())) return { allowed: false, scope };
  if (!scope.apps.includes(norm)) return { allowed: false, scope };
  if (scope.kinds && !scope.kinds.includes(input.kind)) return { allowed: false, scope };
  if (scope.maxCount !== undefined && scope.count >= scope.maxCount) return { allowed: false, scope };
  return { allowed: true, scope };
}

export { DEFAULT_TTL_MINUTES, MAX_TTL_MINUTES };
