import type { ToolContext } from "../types.js";
import { resolveActiveProject } from "../workspace/active.js";
import { captureE2eAppScreenshot, captureE2eScreenshot } from "../e2e/local-e2e.js";
import { redact } from "../policy/secrets.js";
import { summarizeControlTarget, summarizePath, summarizePrivateText } from "../policy/audit-input.js";
import { assertAllowedTarget, controlAllowlist, isSensitiveApp } from "./policy.js";
import { maskSensitiveRegions } from "./screenshot-mask.js";
import { autoDecision, recordAutoUse } from "./auto.js";
import { approveAction, getAction, isKilled, listActions, markDone, toSummary, type ControlActionRecord } from "./queue.js";
import * as macInput from "./mac-input.js";

/**
 * Session worker that turns an `approved` control action into a real
 * synthetic click/keystroke. Nothing but this module ever calls
 * src/control/mac-input.ts's synthetic-input functions, and it only ever
 * does so for actions a local human has already moved to `approved` (see
 * src/control/queue.ts / the `chatgpt2codex control approve` CLI path).
 */

function keySummary(keyCode: number | undefined): string | undefined {
  return keyCode === undefined ? undefined : `keyCode:${keyCode}`;
}

/** Clamp a windowPoint xRel/yRel to [0,1]. The HTTP action bridge
 * (src/server/actions.ts callRegisteredTool) can reach handleComputerRequestAction
 * without the tool's zod schema (min(0).max(1)) ever running, so a queued
 * record's windowPoint is not guaranteed to be in range by the time it is
 * executed here — re-validate at the actual synthetic-input call site
 * rather than trusting the stored value. */
function clampUnitInterval(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** macOS virtual key codes are a small non-negative integer range; a
 * negative or out-of-range value (reachable the same way as the windowPoint
 * bypass above, since keyCode's zod min(0) can likewise be skipped) is
 * rejected here instead of being handed to AppleScript/CGEvent. */
function isValidKeyCode(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 127;
}

/** Best-effort before/after screenshot evidence for an approved action.
 * Never throws and never blocks execution: darwin-only, skipped entirely
 * for a sensitive-app target (defense in depth; assertAllowedTarget already
 * refused those earlier), and skipped when there's no currently active
 * project to anchor the capture directory under. Any capture failure (e.g.
 * missing Screen Recording permission) is swallowed and reported as
 * `undefined` rather than surfacing as an execution error. */
async function captureActionEvidence(
  ctx: ToolContext,
  record: ControlActionRecord,
  phase: "before" | "after",
): Promise<{ path: string; masked: boolean } | undefined> {
  if (process.platform !== "darwin") return undefined;
  if (isSensitiveApp(record.appName)) return undefined;
  try {
    const active = await resolveActiveProject(ctx);
    if (!active) return undefined;
    const label = `control-${record.actionId}-${phase}`;
    const captured = await captureE2eAppScreenshot(active.root, { appName: record.appName, label, waitMs: 0 }).catch(() =>
      captureE2eScreenshot(active.root, { label }),
    );
    const masked = await maskSensitiveRegions({ pngPath: captured.path, appName: record.appName });
    return { path: masked.pngPath, masked: masked.masked };
  } catch {
    return undefined;
  }
}

/**
 * Turn one `approved` action into a real synthetic click/keystroke: re-checks
 * kill state, darwin Accessibility preflight, and the live-frontmost
 * sensitive-app/allowlist gate before doing anything, captures best-effort
 * before/after evidence, and always ends by marking the record `done` (never
 * throws). Exported so src/control/tools.ts can drive a single action
 * deterministically for the ChatGPT-confirmed immediate-execution path
 * (isControlChatGptExposed) without going through the polling
 * runExecutorOnce/startExecutor loop or touching any other queued action.
 */
export async function executeApprovedAction(ctx: ToolContext, record: ControlActionRecord): Promise<void> {
  if (await isKilled(ctx.stateDir)) {
    await ctx.ledger.append({
      type: "control.action.blocked",
      actionId: record.actionId,
      appName: record.appName,
      reason: "killed",
    });
    await markDone(ctx.stateDir, record.actionId, { ok: false, error: "killed" });
    return;
  }

  // Live permission preflight: a definitive (source === "ax-helper") answer
  // that Accessibility isn't trusted blocks with a clear, reportable reason
  // instead of letting the actual click/type/key attempt fail partway
  // through with an opaque AppleScript/AX error. A dev/source run without
  // the packaged helper (source === "unavailable") can't answer this
  // definitively, so it fails open here rather than blocking every action.
  if (process.platform === "darwin") {
    const preflight = await macInput.preflightPermissions().catch(() => undefined);
    if (preflight && preflight.source === "ax-helper" && !preflight.accessibilityTrusted) {
      await ctx.ledger.append({
        type: "control.action.blocked",
        actionId: record.actionId,
        appName: record.appName,
        reason: "accessibility-permission-required",
      });
      await markDone(ctx.stateDir, record.actionId, { ok: false, error: "accessibility-permission-required" });
      return;
    }
  }

  const frontmostApp = await macInput.resolveFrontmostApp().catch(() => undefined);
  try {
    assertAllowedTarget({ appName: record.appName, frontmostAppName: frontmostApp, allowlist: controlAllowlist() });
  } catch (err) {
    await ctx.ledger.append({
      type: "control.action.blocked",
      actionId: record.actionId,
      appName: record.appName,
      frontmostApp,
      reason: summarizePrivateText(err instanceof Error ? err.message : String(err)),
    });
    await markDone(ctx.stateDir, record.actionId, { ok: false, error: "blocked" });
    return;
  }

  const evidenceBefore = await captureActionEvidence(ctx, record, "before");
  try {
    let axSummary: Record<string, unknown> | undefined;
    let windowPoint: { x: number; y: number } | undefined;

    if (record.kind === "click") {
      if (record.target.ax) {
        // AX targets are re-resolved by pressAxElement itself right before
        // acting (never reusing the request-time dry-run preview frame), so
        // an element that moved or vanished since approval fails cleanly
        // instead of clicking the wrong thing. Only fall back to an
        // explicit windowPoint (never an arbitrary absolute coordinate) when
        // the record carries one.
        try {
          await macInput.pressAxElement(record.appName, record.target.ax);
          axSummary = { ...record.target.ax };
        } catch (err) {
          if (!record.target.windowPoint) throw err;
          const resolved = await macInput.resolveWindowPoint(
            record.appName,
            clampUnitInterval(record.target.windowPoint.xRel),
            clampUnitInterval(record.target.windowPoint.yRel),
          );
          await macInput.clickAtPoint(record.appName, resolved.x, resolved.y);
          windowPoint = resolved;
        }
      } else if (record.target.windowPoint) {
        const resolved = await macInput.resolveWindowPoint(
          record.appName,
          clampUnitInterval(record.target.windowPoint.xRel),
          clampUnitInterval(record.target.windowPoint.yRel),
        );
        await macInput.clickAtPoint(record.appName, resolved.x, resolved.y);
        windowPoint = resolved;
      } else {
        throw new Error("click action has neither an ax nor a windowPoint target");
      }
    } else if (record.kind === "type") {
      if (record.target.ax) {
        try {
          await macInput.setAxValue(record.appName, record.target.ax, record.text ?? "");
          axSummary = { ...record.target.ax };
        } catch (err) {
          if (!record.target.windowPoint) throw err;
          const resolved = await macInput.resolveWindowPoint(
            record.appName,
            clampUnitInterval(record.target.windowPoint.xRel),
            clampUnitInterval(record.target.windowPoint.yRel),
          );
          await macInput.clickAtPoint(record.appName, resolved.x, resolved.y);
          await macInput.typeText(record.appName, record.text ?? "");
          windowPoint = resolved;
        }
      } else {
        await macInput.typeText(record.appName, record.text ?? "");
      }
    } else if (record.kind === "key") {
      const keyCode = record.keyCode ?? 0;
      if (!isValidKeyCode(keyCode)) {
        throw new Error("key action has an out-of-range keyCode");
      }
      await macInput.pressKey(record.appName, keyCode);
    }

    const evidenceAfter = await captureActionEvidence(ctx, record, "after");
    const evidence = { before: evidenceBefore?.path, after: evidenceAfter?.path };
    await ctx.ledger.append({
      type: "control.action.executed",
      actionId: record.actionId,
      appName: record.appName,
      kind: record.kind,
      axSummary: axSummary ? summarizeControlTarget({ ax: axSummary }) : undefined,
      windowPoint,
      keySummary: keySummary(record.keyCode),
      textSummary: toSummary(record).textSummary,
      evidence: {
        before: evidence.before ? summarizePath(evidence.before) : undefined,
        after: evidence.after ? summarizePath(evidence.after) : undefined,
      },
      approvedVia: record.approvedVia ?? "human",
      ok: true,
    });
    await markDone(ctx.stateDir, record.actionId, { ok: true, evidence });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    // A "type"/setAxValue failure's underlying error can be an
    // execFile "Command failed: <argv>" string; even with mac-input.ts no
    // longer inlining raw text into the AppleScript argv, never persist or
    // return the raw OS error message for a text-carrying action — use a
    // fixed reason code instead. For other kinds, still redact() as
    // defense in depth before it reaches the ledger (permanent, unredacted
    // audit log) or the ChatGPT-exposed tool result.
    const message = record.kind === "type" ? "type-failed" : redact(rawMessage);
    const evidenceAfter = await captureActionEvidence(ctx, record, "after");
    const evidence = { before: evidenceBefore?.path, after: evidenceAfter?.path };
    await ctx.ledger.append({
      type: "control.action.executed",
      actionId: record.actionId,
      appName: record.appName,
      kind: record.kind,
      evidence: {
        before: evidence.before ? summarizePath(evidence.before) : undefined,
        after: evidence.after ? summarizePath(evidence.after) : undefined,
      },
      approvedVia: record.approvedVia ?? "human",
      ok: false,
      error: message,
    });
    await markDone(ctx.stateDir, record.actionId, { ok: false, error: message, evidence });
  }
}

/**
 * Promote any `pending` action that falls inside the local operator's
 * bounded auto-approve scope (src/control/auto.ts) straight to `approved`,
 * exactly like a human clicking Approve would, tagged `approvedVia:"auto"`
 * for the audit trail. autoDecision() itself re-checks the sensitive-app
 * denylist, the control allowlist, TTL, kind filter, and max-count on every
 * call, so this never widens what an action is allowed to target — it only
 * decides *who* clicked Approve. The promoted action still has to pass
 * executeApprovedAction's own preflight/frontmost/assertAllowedTarget/kill
 * checks below before any real synthetic input happens.
 */
async function autoApprovePendingActions(ctx: ToolContext): Promise<void> {
  const actions = await listActions(ctx.stateDir);
  for (const summary of actions) {
    if (summary.status !== "pending") continue;
    if (await isKilled(ctx.stateDir)) return;
    const fresh = await getAction(ctx.stateDir, summary.actionId);
    if (!fresh || fresh.status !== "pending") continue;

    const decision = await autoDecision(ctx.stateDir, { appName: fresh.appName, kind: fresh.kind });
    if (!decision.allowed) continue;

    let promoted: ControlActionRecord;
    try {
      promoted = await approveAction(ctx.stateDir, fresh.actionId, { approvedVia: "auto" });
    } catch {
      // Lost a race (e.g. killed or already moved between the checks
      // above and here) — leave it for the next pass / a human.
      continue;
    }
    await recordAutoUse(ctx.stateDir);
    await ctx.ledger.append({
      type: "control.action.auto_approved",
      actionId: promoted.actionId,
      appName: promoted.appName,
      kind: promoted.kind,
      scopeExpiresAt: decision.scope?.expiresAt,
    });
  }
}

/** Process every currently-approved action once (after first auto-approving
 * any in-scope pending ones). Exported separately from startExecutor so
 * tests can drive the worker deterministically instead of waiting on a
 * timer. */
export async function runExecutorOnce(ctx: ToolContext): Promise<void> {
  if (await isKilled(ctx.stateDir)) return;
  await autoApprovePendingActions(ctx);
  if (await isKilled(ctx.stateDir)) return;
  const actions = await listActions(ctx.stateDir);
  for (const summary of actions) {
    if (summary.status !== "approved") continue;
    if (await isKilled(ctx.stateDir)) return;
    const fresh = await getAction(ctx.stateDir, summary.actionId);
    if (!fresh || fresh.status !== "approved") continue;
    await executeApprovedAction(ctx, fresh);
  }
}

/** Start the in-process polling worker. Returns a stop function. Safe to
 * call once per server process; the returned interval is unref'd so it
 * never keeps the process alive on its own. */
export function startExecutor(ctx: ToolContext, intervalMs = 1000): () => void {
  const timer = setInterval(() => {
    runExecutorOnce(ctx).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
