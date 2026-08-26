import { promises as fs } from "node:fs";
import { DomainError, ErrorCode, makeResult, type ToolContext, type ToolResult } from "../types.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { resolveActiveProject } from "../workspace/active.js";
import { captureE2eAppScreenshot, captureE2eScreenshot } from "../e2e/local-e2e.js";
import { redact } from "../policy/secrets.js";
import {
  summarizeAuditInput,
  summarizeControlTarget,
  summarizePrivateText,
  summarizeResolvedTarget,
} from "../policy/audit-input.js";
import { assertAllowedTarget, controlAllowlist, isAppAllowed, isControlChatGptExposed } from "./policy.js";
import { assertScreenshotTargetAllowed, maskSensitiveRegions } from "./screenshot-mask.js";
import { executeApprovedAction } from "./executor.js";
import * as macInput from "./mac-input.js";
import {
  approveAction,
  enqueue,
  getAction,
  isKilled,
  listActions,
  rejectAction,
  setKill,
  toSummary,
  type ControlActionKind,
  type ControlActionTarget,
  type ResolvedTargetPreview,
} from "./queue.js";

/**
 * Handlers for the 4 Option B desktop-control MCP tools. Registered
 * conditionally by src/server/tools.ts (only when isControlEnabled()), and
 * kept intentionally free of any dependency on src/server/tools.ts /
 * src/server/actions.ts to avoid a module cycle — both of those import
 * *from* here, never the reverse.
 */

interface CallToolResultLike {
  content: ToolResult["content"];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

// Success-path structuredContent already goes through toSummary()/redact()
// (e.g. computer_action_status text summary). The error path must too: a
// raw thrown error message (or its `details`) can otherwise reach both the
// permanent ledger `error` field and the untrusted-model-facing tool result
// unredacted — mirrors src/server/tools.ts mapError, which has the
// identical DomainError/non-DomainError branches redact()ed.
function mapControlError(err: unknown): ToolResult<{ error: string; code: string; details?: unknown }> {
  if (err instanceof DomainError) {
    const safeMessage = redact(err.message);
    return makeResult(
      { error: safeMessage, code: err.code, details: summarizeAuditInput(err.details) },
      `Error [${err.code}]: ${safeMessage}`,
      true,
    );
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = redact(rawMessage);
  return makeResult({ error: message, code: ErrorCode.NOT_IMPLEMENTED }, `Error: ${message}`, true);
}

async function withControlErrorMapping<T extends Record<string, unknown>>(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  fn: () => Promise<ToolResult<T> | CallToolResultLike>,
): Promise<CallToolResultLike> {
  const operationId = ctx.activity?.tracker.startOperation(ctx.activity.session, toolName);
  try {
    const result = await fn();
    await ctx.ledger.append({
      type: "tool.call.completed",
      tool: toolName,
      input: summarizeAuditInput(input),
      isError: result.isError === true,
    });
    ctx.activity?.tracker.finishOperation(ctx.activity.session, operationId, {
      errorCode: result.isError ? "TOOL_RESULT_ERROR" : undefined,
    });
    await ctx.diagnostics
      ?.record({
        event: "tool.call",
        outcome: result.isError ? "failure" : "success",
        tool: toolName,
        ...(result.isError ? { errorCode: "TOOL_RESULT_ERROR" } : {}),
      })
      .catch(() => undefined);
    return { content: result.content, structuredContent: result.structuredContent, ...(result.isError ? { isError: true } : {}) };
  } catch (err) {
    const mapped = mapControlError(err);
    await ctx.ledger.append({
      type: "tool.call.failed",
      tool: toolName,
      input: summarizeAuditInput(input),
      code: mapped.structuredContent.code,
      error: mapped.structuredContent.error,
    });
    ctx.activity?.tracker.finishOperation(ctx.activity.session, operationId, {
      errorCode: String(mapped.structuredContent.code),
    });
    await ctx.diagnostics
      ?.record({
        event: "tool.call",
        outcome: "failure",
        tool: toolName,
        errorCode: String(mapped.structuredContent.code),
      })
      .catch(() => undefined);
    return { content: mapped.content, structuredContent: mapped.structuredContent, isError: true };
  }
}

/** Both gates: an active project must hold a `control`-capable lease. */
async function requireControlLease(ctx: ToolContext): Promise<{ projectId: string; root: string }> {
  const active = await resolveActiveProject(ctx);
  if (!active) {
    throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "Select a project with project_select preset=control first");
  }
  await requireProjectLease(ctx, active.projectId, "control");
  return { projectId: active.projectId, root: active.root };
}

export interface ComputerScreenshotInput {
  appName?: string;
  label?: string;
  waitMs?: number;
}

export async function handleComputerScreenshot(ctx: ToolContext, input: ComputerScreenshotInput): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_screenshot", input, async () => {
    const { projectId, root } = await requireControlLease(ctx);
    // Full-screen capture (no appName) shows whatever is frontmost, so the
    // sensitive-app gate must check the *live* frontmost app in that case —
    // an app-targeted capture is already covered by the appName check below.
    const frontmostApp =
      input.appName === undefined && process.platform === "darwin"
        ? await macInput.resolveFrontmostApp().catch(() => undefined)
        : undefined;
    assertScreenshotTargetAllowed(input.appName, frontmostApp);

    // Screenshot capture must pass the same allowlist gate as synthetic
    // input (click/type/key): the denylist check above only refuses known
    // sensitive apps, it does not require the target to be explicitly
    // opted in. Without this, any non-denylisted, non-allowlisted app
    // (Mail, Messages, a private editor, ...) could be captured even
    // though it could never be clicked/typed into.
    const allowlist = controlAllowlist();
    if (input.appName !== undefined) {
      if (!isAppAllowed(input.appName, allowlist)) {
        throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `App is not on the control allowlist: ${input.appName}`, {
          appName: input.appName,
        });
      }
    } else if (isControlChatGptExposed()) {
      // A full-screen capture (`screencapture -x`) captures every visible
      // window on the display, not just the frontmost one — checking only
      // the live frontmost app's denylist/allowlist status (as an earlier
      // version of this branch did, by allowing capture whenever the
      // frontmost app itself was allowlisted) cannot see a *background*
      // sensitive-app window (e.g. a password manager open behind the
      // frontmost app, or visible on a second display/Space) that would
      // still be captured and returned to ChatGPT. Rather than enumerate
      // every on-screen window's owning process, the ChatGPT-exposed
      // (remotely reachable) mode simply refuses full-screen capture
      // outright and requires an explicit, allowlisted appName instead —
      // captureE2eAppScreenshot only ever captures that single app's own
      // window region, so it cannot leak a background window by
      // construction.
      throw new DomainError(
        ErrorCode.SENSITIVE_TARGET_BLOCKED,
        "Full-screen capture is not available when exposed to ChatGPT (it can show background sensitive windows the allowlist can't see); pass an allowlisted appName to capture a specific window",
        { appName: frontmostApp },
      );
    }

    const result = input.appName
      ? await captureE2eAppScreenshot(root, { appName: input.appName, label: input.label, waitMs: input.waitMs })
      : await captureE2eScreenshot(root, { label: input.label, waitMs: input.waitMs });
    const masked = await maskSensitiveRegions({ pngPath: result.path, appName: input.appName });

    await ctx.ledger.append({
      type: "control.screenshot.captured",
      projectId,
      appName: input.appName ?? "screen",
      masked: masked.masked,
    });

    const base64 = await fs.readFile(masked.pngPath).then((buf) => buf.toString("base64"));
    return {
      structuredContent: { path: masked.pngPath, bytes: result.bytes, appName: input.appName ?? null },
      content: [
        { type: "text", text: `Captured control screenshot: ${masked.pngPath}` },
        { type: "image", data: base64, mimeType: "image/png" },
      ],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerRequestActionInput {
  appName: string;
  kind: ControlActionKind;
  target?: ControlActionTarget;
  text?: string;
  keyCode?: number;
  keys?: string[];
  button?: "left" | "right" | "middle";
  path?: Array<{ xRel: number; yRel: number }>;
  scrollX?: number;
  scrollY?: number;
  durationMs?: number;
  reason: string;
}

function validRelativePoint(point: { xRel: number; yRel: number } | undefined): boolean {
  return Boolean(point && Number.isFinite(point.xRel) && Number.isFinite(point.yRel) && point.xRel >= 0 && point.xRel <= 1 && point.yRel >= 0 && point.yRel <= 1);
}

function validateComputerActionInput(input: ComputerRequestActionInput): ControlActionTarget {
  const target = input.target ?? {};
  if (input.button !== undefined && !["left", "right", "middle"].includes(input.button)) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Unsupported mouse button: ${input.button}`);
  }
  switch (input.kind) {
    case "click":
      if (!target.ax && !validRelativePoint(target.windowPoint)) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "click requires target.ax or target.windowPoint");
      break;
    case "double_click":
    case "move":
      if (!validRelativePoint(target.windowPoint)) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `${input.kind} requires target.windowPoint`);
      break;
    case "drag":
      if (!input.path || input.path.length < 2 || input.path.length > 32 || !input.path.every(validRelativePoint)) {
        throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "drag requires path with 2..32 valid window-relative points");
      }
      break;
    case "scroll":
      if (!validRelativePoint(target.windowPoint)) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "scroll requires target.windowPoint");
      if (!Number.isFinite(input.scrollX ?? NaN) || !Number.isFinite(input.scrollY ?? NaN)) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "scroll requires finite scrollX and scrollY");
      if (Math.abs(input.scrollX ?? 0) > 4000 || Math.abs(input.scrollY ?? 0) > 4000) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "scroll deltas must be between -4000 and 4000");
      break;
    case "type":
      if (typeof input.text !== "string") throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "type requires text");
      break;
    case "key":
      if (!Number.isInteger(input.keyCode) || (input.keyCode ?? -1) < 0 || (input.keyCode ?? 128) > 127) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "key requires keyCode in 0..127");
      break;
    case "keypress":
      if (!input.keys || input.keys.length < 1 || input.keys.length > 8 || input.keys.some((key) => !key.trim() || key.length > 32)) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "keypress requires 1..8 short key names");
      break;
    case "wait":
      if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 10_000)) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "wait durationMs must be between 0 and 10000");
      break;
  }
  return target;
}

// Defense in depth for the ChatGPT-exposed immediate-execution branch below:
// the server has no way to verify that a client's Confirm/Deny prompt was a
// distinct, deliberate human tap rather than an "always allow"/auto-approve
// client setting or a prompt-injected loop re-issuing the same request. This
// bounds how many approvedVia:"chatgpt" actions can auto-execute inside a
// rolling window; once the cap is hit, further requests fall back to the
// normal queue+local-approval path below (never hard-fail the request), so a
// runaway burst surfaces to the local operator (via `control status`/the
// status bar) instead of continuing to run unattended. This does not replace
// or weaken any existing gate (sensitive-app denylist, control allowlist,
// kill switch, 2nd live-frontmost re-check) — it only caps how many actions
// can skip the local-approval step in a given window.
const CHATGPT_EXPOSED_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const CHATGPT_EXPOSED_RATE_LIMIT_MAX = 20;

async function isChatGptExposedRateLimited(stateDir: string, now = Date.now()): Promise<boolean> {
  const actions = await listActions(stateDir);
  const recentAutoExecuted = actions.filter(
    (a) =>
      a.approvedVia === "chatgpt" &&
      a.result?.executedAt !== undefined &&
      now - a.result.executedAt < CHATGPT_EXPOSED_RATE_LIMIT_WINDOW_MS,
  );
  return recentAutoExecuted.length >= CHATGPT_EXPOSED_RATE_LIMIT_MAX;
}

export async function handleComputerRequestAction(ctx: ToolContext, input: ComputerRequestActionInput): Promise<CallToolResultLike> {
  const redactedInput = { ...input, text: input.text ? "[redacted]" : undefined };
  return withControlErrorMapping(ctx, "computer_request_action", redactedInput, async () => {
    const { projectId } = await requireControlLease(ctx);
    const target = validateComputerActionInput(input);

    if (await isKilled(ctx.stateDir)) {
      throw new DomainError(ErrorCode.CONTROL_KILLED, "Control session is killed; grant a new control lease to resume");
    }

    const frontmostApp = process.platform === "darwin" ? await macInput.resolveFrontmostApp().catch(() => undefined) : undefined;
    try {
      assertAllowedTarget({ appName: input.appName, frontmostAppName: frontmostApp, allowlist: controlAllowlist() });
    } catch (err) {
      await ctx.ledger.append({
        type: "control.action.blocked",
        projectId,
        appName: input.appName,
        frontmostApp,
        reason: err instanceof DomainError ? err.code : "blocked",
      });
      throw err;
    }

    // Dry-run preview: resolve the AX target read-only (no activate/click) so
    // the local approver can see role/title/frame/app/window/matchCount
    // before anything executes. Never blocks the request: a resolve failure
    // (e.g. an Electron/Chromium app with an empty AX tree) is surfaced as
    // resolved.found=false rather than an error, so the approver knows to
    // expect an executor-time windowPoint fallback.
    let resolved: ResolvedTargetPreview | undefined;
    if (target.ax && process.platform === "darwin") {
      resolved = await macInput.resolveAxElement(input.appName, target.ax).catch((err) => ({
        found: false,
        reason: err instanceof Error ? err.message : String(err),
      }));
    }

    const record = await enqueue(ctx.stateDir, {
      appName: input.appName,
      kind: input.kind,
      target,
      text: input.text,
      keyCode: input.keyCode,
      keys: input.keys,
      button: input.button,
      path: input.path,
      scrollX: input.scrollX,
      scrollY: input.scrollY,
      durationMs: input.durationMs,
      reason: input.reason,
      resolved,
    });

    await ctx.ledger.append({
      type: "control.action.requested",
      projectId,
      actionId: record.actionId,
      appName: record.appName,
      kind: record.kind,
      target: summarizeControlTarget(record.target),
      button: record.button,
      pathPoints: record.path?.length,
      scroll: record.scrollX !== undefined || record.scrollY !== undefined ? { x: record.scrollX ?? 0, y: record.scrollY ?? 0 } : undefined,
      keys: record.keys,
      durationMs: record.durationMs,
      reason: summarizePrivateText(record.reason),
      resolved: summarizeResolvedTarget(record.resolved),
    });

    if (isControlChatGptExposed() && !(await isChatGptExposedRateLimited(ctx.stateDir))) {
      // Reaching this call at all means the owner's ChatGPT client already
      // showed its Confirm/Deny prompt (driven by this tool's non-read-only
      // annotations) and the owner confirmed on their phone — that is the
      // human approval gate in this mode. Approve and execute immediately
      // through the exact same executor.ts path a local `control approve`
      // would take (kill re-check, darwin preflight, 2nd live-frontmost
      // sensitive-app/allowlist check, before/after evidence, audit), just
      // tagged approvedVia:"chatgpt" for the trail.
      const approved = await approveAction(ctx.stateDir, record.actionId, { approvedVia: "chatgpt" });
      await executeApprovedAction(ctx, approved);
      const done = (await getAction(ctx.stateDir, record.actionId)) ?? approved;
      const summary = toSummary(done);
      const errorSuffix = done.result?.ok === false && done.result.error ? `, error=${done.result.error}` : "";
      return {
        structuredContent: { ...summary },
        content: [
          {
            type: "text",
            text: `Control action ${done.actionId} was confirmed and executed (status=${done.status}${errorSuffix}).`,
          },
        ],
      } satisfies CallToolResultLike;
    }

    if (isControlChatGptExposed()) {
      await ctx.ledger.append({
        type: "control.action.rate_limited",
        projectId,
        actionId: record.actionId,
        appName: record.appName,
      });
    }

    const summary = toSummary(record);
    return {
      structuredContent: { ...summary },
      content: [
        {
          type: "text",
          text: `Control action ${record.actionId} is queued and requires local human approval before it executes (status=${record.status}).`,
        },
      ],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerActionStatusInput {
  actionId?: string;
}

export async function handleComputerActionStatus(ctx: ToolContext, input: ComputerActionStatusInput): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_action_status", input, async () => {
    await requireControlLease(ctx);

    if (input.actionId) {
      const record = await getAction(ctx.stateDir, input.actionId);
      if (!record) {
        throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Control action not found: ${input.actionId}`);
      }
      const summary = toSummary(record);
      return {
        structuredContent: { action: summary },
        content: [{ type: "text", text: `Action ${record.actionId}: ${record.status}` }],
      } satisfies CallToolResultLike;
    }

    const actions = (await listActions(ctx.stateDir)).map(toSummary);
    return {
      structuredContent: { actions },
      content: [{ type: "text", text: `${actions.length} control action(s) in the queue.` }],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerKillSwitchInput {
  reason?: string;
}

export async function handleComputerKillSwitch(ctx: ToolContext, input: ComputerKillSwitchInput): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_kill_switch", input, async () => {
    const { projectId } = await requireControlLease(ctx);
    await setKill(ctx.stateDir);
    await ctx.ledger.append({ type: "control.kill", projectId, reason: input.reason ? summarizePrivateText(input.reason) : undefined });
    return {
      structuredContent: { killed: true },
      content: [{ type: "text", text: "Control session killed. All pending actions were rejected." }],
    } satisfies CallToolResultLike;
  });
}

// approveAction/rejectAction/CLI helpers are re-exported from queue.ts by
// src/cli.ts directly; nothing else in this module needs them.
export { approveAction, rejectAction };
