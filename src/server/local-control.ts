import { timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { makeLease } from "../workspace/project-select.js";
import { redact } from "../policy/secrets.js";
import { clearAuto, readAuto, setAuto } from "../control/auto.js";
import {
  armRequestSummary,
  getArmRequest,
  listArmRequests,
  withPendingArmRequestLock,
  type ArmRequestRecord,
} from "../control/arm-requests.js";
import {
  approveAction,
  clearKill,
  isKilled,
  listActions,
  rejectAction,
  setKill,
  type ControlActionRecord,
} from "../control/queue.js";
import {
  controlAllowlist,
  isAppAllowed,
  isControlEnabled,
  isDesktopControlSupported,
  isSensitiveApp,
} from "../control/policy.js";
import type { RuntimeActivityTracker } from "../runtime/activity.js";
import type { ConnectionDiagnosticsSink } from "../runtime/connection-diagnostics.js";
import {
  ensureRgAuthorized,
  executeRgSearch,
  getRgCapabilityStatus,
  resolveRgApprovalRequest,
  setRgPreference,
  type RgApprovalDecision,
} from "../exec/rg-capability.js";
import { installManagedRipgrep } from "../exec/managed-rg-installer.js";
import {
  listOperationApprovalRequests,
  operationApprovalSummary,
  resolveOperationApprovalRequest,
} from "../exec/operation-approval.js";

export interface LocalControlRouteConfig {
  port: number;
  token: string;
  startedAt: number;
  desktopControlSupported?: boolean;
  diagnostics?: ConnectionDiagnosticsSink;
  approvalState?: {
    clearKill?: typeof clearKill;
    isKilled?: typeof isKilled;
    setKill?: typeof setKill;
  };
  rgBinary?: Awaited<ReturnType<typeof getRgCapabilityStatus>>["binary"];
}

function authorizedToken(candidate: string | undefined, expected: string): boolean {
  if (!candidate?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(candidate.slice("Bearer ".length), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function localHostAllowed(req: Request, port: number): boolean {
  const host = req.header("host")?.toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function localOnly(config: LocalControlRouteConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Cache-Control", "no-store");
    if (!localHostAllowed(req, config.port)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!authorizedToken(req.header("authorization"), config.token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function uiAction(record: ControlActionRecord): Record<string, unknown> {
  return {
    actionId: record.actionId,
    appName: record.appName,
    kind: record.kind,
    target: record.target,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: record.status,
    resolved: record.resolved,
  };
}

async function auditExpiredArmRequests(
  ctx: ToolContext,
  records: ArmRequestRecord[],
): Promise<void> {
  for (const record of records) {
    await ctx.ledger.append({
      type: "control.arm-request.expired",
      requestId: record.requestId,
      projectId: record.projectId,
    }).catch(() => undefined);
  }
}

async function approveAllEligible(stateDir: string): Promise<{ approved: string[]; skipped: number; killed: boolean }> {
  const approved: string[] = [];
  let skipped = 0;
  if (await isKilled(stateDir)) return { approved, skipped, killed: true };
  const allowlist = controlAllowlist();
  const pending = (await listActions(stateDir)).filter((action) => action.status === "pending");
  for (const action of pending) {
    if (await isKilled(stateDir)) return { approved, skipped, killed: true };
    if (isSensitiveApp(action.appName) || !isAppAllowed(action.appName, allowlist)) {
      skipped += 1;
      continue;
    }
    try {
      await approveAction(stateDir, action.actionId);
      approved.push(action.actionId);
    } catch {
      skipped += 1;
    }
  }
  return { approved, skipped, killed: false };
}

async function respondToArmResolutionError(
  ctx: ToolContext,
  res: Response,
  requestId: string,
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof DomainError)) return false;
  if (error.details?.reason === "arm_request_project_mismatch") {
    res.status(409).json({
      error: "arm_request_project_mismatch",
      requestProjectId: error.details.requestProjectId,
      activeProjectId: error.details.activeProjectId ?? null,
    });
    return true;
  }
  if (error.code !== ErrorCode.NOT_IMPLEMENTED && error.code !== ErrorCode.APPROVAL_REQUIRED) return false;
  const current = await getArmRequest(ctx.stateDir, requestId);
  if (!current.request) {
    res.status(404).json({ error: "arm_request_not_found", requestId });
  } else {
    res.status(409).json({ error: "arm_request_not_pending", request: armRequestSummary(current.request) });
  }
  return true;
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: redact(error instanceof Error ? error.message : String(error)) });
      }
    });
  };
}

function respondToRgResolutionError(res: Response, error: unknown): boolean {
  if (!(error instanceof DomainError)) return false;
  const status = error.code === ErrorCode.NOT_IMPLEMENTED ? 404 : 409;
  res.status(status).json({
    error: "rg_approval_failed",
    code: error.code,
    message: redact(error.message),
    details: error.details ?? {},
  });
  return true;
}

export function registerLocalControlRoutes(
  app: Express,
  ctx: ToolContext,
  tracker: RuntimeActivityTracker,
  config: LocalControlRouteConfig,
): void {
  const base = "/local-control/v1";
  const desktopControlSupported = config.desktopControlSupported ?? isDesktopControlSupported();
  app.use(base, localOnly(config));

  app.get(
    `${base}/status`,
    asyncRoute(async (_req, res) => {
      const now = Date.now();
      const persisted = (await ctx.store.getSession()) as {
        activeProjectId?: string | null;
        mode?: string;
        lease?: {
          projectId: string;
          preset: string;
          issuedAt: number;
          expiresAt: number;
        } | null;
      };
      const registry = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
      const project = registry.find((entry) => entry.projectId === persisted.activeProjectId);
      const leaseActive = Boolean(persisted.lease && persisted.lease.expiresAt > now);
      const killed = await isKilled(ctx.stateDir);
      const actions = await listActions(ctx.stateDir);
      const allPending = actions.filter((action) => action.status === "pending");
      const pending = allPending.slice(0, 50);
      const armRequests = await listArmRequests(ctx.stateDir, now);
      await auditExpiredArmRequests(ctx, armRequests.expired);
      const allPendingArmRequests = armRequests.requests.filter((request) => request.status === "pending");
      const pendingArmRequests = allPendingArmRequests.slice(0, 50);
      const auto = await readAuto(ctx.stateDir);
      const autoActive = Boolean(auto && auto.expiresAt > now);
      const diagnosticSummary = await config.diagnostics?.summary(10);
      const rgStatus = await getRgCapabilityStatus({
        stateDir: ctx.stateDir,
        projectId: project?.projectId ?? null,
        binary: config.rgBinary,
        now,
      });
      const operationApprovalRequests = await listOperationApprovalRequests(ctx.stateDir, now);
      const pendingOperationApprovals = operationApprovalRequests.filter((request) => request.status === "pending");

      res.json({
        schemaVersion: 3,
        server: { ok: true, pid: process.pid, startedAt: config.startedAt },
        project: project ? { projectId: project.projectId, name: project.name } : null,
        lease: persisted.lease
          ? {
              preset: persisted.lease.preset,
              issuedAt: persisted.lease.issuedAt,
              expiresAt: persisted.lease.expiresAt,
              active: leaseActive,
            }
          : null,
        control: {
          enabled: isControlEnabled(),
          platformSupported: desktopControlSupported,
          armed: leaseActive && persisted.lease?.preset === "control" && !killed,
          killed,
          pendingCount: allPending.length,
          pendingActions: pending.map(uiAction),
          pendingArmRequestCount: allPendingArmRequests.length,
          pendingArmRequests: pendingArmRequests.map(armRequestSummary),
          autoEnabled: autoActive,
          autoRemainingMs: auto ? Math.max(0, auto.expiresAt - now) : 0,
          allowlistedAppCount: controlAllowlist().length,
        },
        operationApprovals: {
          pendingRequestCount: pendingOperationApprovals.length,
          pendingRequests: pendingOperationApprovals.slice(0, 50).map(operationApprovalSummary),
        },
        externalSearch: {
          rg: {
            preference: rgStatus.preference,
            binary: rgStatus.binary,
            pendingRequestCount: rgStatus.pendingRequests.length,
            pendingRequests: rgStatus.pendingRequests.slice(0, 50),
            grants: rgStatus.grants,
            fallbackTool: "code_search",
          },
        },
        sessions: tracker.snapshot(now),
        diagnostics: diagnosticSummary
          ? {
              logPath: diagnosticSummary.logPath,
              lastEventAt: diagnosticSummary.lastEventAt,
              lastSuccessAt: diagnosticSummary.lastSuccessAt,
              lastFailureAt: diagnosticSummary.lastFailureAt,
              lastFailure: diagnosticSummary.lastFailure,
              clientCancellationRecovery: diagnosticSummary.clientCancellationRecovery ?? null,
            }
          : null,
      });
    }),
  );

  app.post(
    `${base}/project/select`,
    asyncRoute(async (req, res) => {
      const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
      const preset = typeof req.body?.preset === "string" ? req.body.preset : "full-write";
      const allowedPresets: LeasePreset[] = ["read-only", "tests-only", "full-write", "image-only"];
      if (!projectId || !allowedPresets.includes(preset as LeasePreset)) {
        res.status(400).json({ error: "invalid_project_selection", allowedPresets });
        return;
      }
      const registry = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
      const project = registry.find((entry) => entry.projectId === projectId);
      if (!project) {
        res.status(404).json({ error: "project_not_found", projectId });
        return;
      }
      const persisted = (await ctx.store.getSession()) as {
        activeProjectId?: string | null;
        mode?: string;
        lease?: Lease | null;
        [key: string]: unknown;
      };
      const lease = makeLease(project, preset as LeasePreset);
      await ctx.store.setSession({ ...persisted, activeProjectId: project.projectId, mode: "read", lease });
      await ctx.ledger.append({
        type: "project.selected.local",
        projectId: project.projectId,
        leaseId: lease.leaseId,
        preset: lease.preset,
      }).catch(() => undefined);
      res.json({
        ok: true,
        project: { projectId: project.projectId, name: project.name },
        lease: { leaseId: lease.leaseId, preset: lease.preset, expiresAt: lease.expiresAt },
      });
    }),
  );

  for (const decision of ["approve", "reject"] as const) {
    app.post(
      `${base}/operation-approvals/:requestId/${decision}`,
      asyncRoute(async (req, res) => {
        const requestId = String(req.params.requestId ?? "");
        try {
          const request = await resolveOperationApprovalRequest({
            stateDir: ctx.stateDir,
            requestId,
            decision,
          });
          await ctx.ledger.append({
            type: decision === "approve" ? "operation.approval.approved" : "operation.approval.rejected",
            requestId: request.requestId,
            projectId: request.projectId,
            tool: request.tool,
            risk: request.risk,
          }).catch(() => undefined);
          res.json({ ok: true, request: operationApprovalSummary(request) });
        } catch (error) {
          if (error instanceof DomainError) {
            res.status(error.code === ErrorCode.NOT_IMPLEMENTED ? 404 : 409).json({
              error: "operation_approval_failed",
              code: error.code,
              message: redact(error.message),
              details: error.details ?? {},
            });
            return;
          }
          throw error;
        }
      }),
    );
  }

  app.post(
    `${base}/external-search/rg/install`,
    asyncRoute(async (_req, res) => {
      const persisted = (await ctx.store.getSession()) as { activeProjectId?: string | null };
      const projectId = persisted.activeProjectId;
      if (!projectId) {
        res.status(409).json({ error: "project_not_selected" });
        return;
      }
      const result = await installManagedRipgrep();
      await ctx.ledger.append({
        type: "runtime.managed-rg.installed.local",
        projectId,
        version: result.version,
        binarySha256: result.binarySha256,
        reusedExisting: result.reusedExisting,
      }).catch(() => undefined);
      res.json({ ok: true, projectId, ...result });
    }),
  );

  app.post(
    `${base}/external-search/rg/search`,
    asyncRoute(async (req, res) => {
      const query = typeof req.body?.query === "string" ? req.body.query : "";
      const patternMode = req.body?.patternMode === "regex" ? "regex" : "literal";
      const caseSensitive = req.body?.caseSensitive === true;
      const requestedMaxResults = Number(req.body?.maxResults ?? 50);
      const maxResults = Number.isFinite(requestedMaxResults)
        ? Math.min(200, Math.max(1, Math.trunc(requestedMaxResults)))
        : 50;
      if (!query || query.length > 2_000 || query.includes("\0")) {
        res.status(400).json({ error: "invalid_rg_query" });
        return;
      }

      const persisted = (await ctx.store.getSession()) as {
        activeProjectId?: string | null;
        lease?: Lease | null;
      };
      const registry = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
      const project = registry.find((entry) => entry.projectId === persisted.activeProjectId);
      const lease = persisted.lease && persisted.lease.expiresAt > Date.now() ? persisted.lease : null;
      if (!project || !lease || lease.projectId !== project.projectId || lease.projectRoot !== project.root) {
        res.status(409).json({ error: "project_lease_required" });
        return;
      }

      try {
        const authorized = await ensureRgAuthorized({
          stateDir: ctx.stateDir,
          projectId: project.projectId,
          projectRoot: project.root,
          lease,
          query,
          queryPreview: query.slice(0, 160),
          options: { patternMode, caseSensitive, maxResults },
          binary: config.rgBinary,
        });
        const result = await executeRgSearch({
          binary: authorized.binary,
          projectRoot: project.root,
          query,
          options: authorized.options,
          approvalScope: authorized.authorization.scope,
        });
        await ctx.ledger.append({
          type: "code.external-rg.search.completed.local",
          projectId: project.projectId,
          approvalScope: authorized.authorization.scope,
          binarySha256: authorized.binary.sha256,
          resultCount: result.matches.length,
        }).catch(() => undefined);
        res.json({ ok: true, projectId: project.projectId, ...result });
      } catch (error) {
        if (error instanceof DomainError) {
          res.status(error.code === ErrorCode.APPROVAL_REQUIRED ? 409 : 400).json({
            error: error.code === ErrorCode.APPROVAL_REQUIRED ? "rg_approval_required" : "rg_search_failed",
            code: error.code,
            message: error.message,
            details: error.details ?? null,
          });
          return;
        }
        throw error;
      }
    }),
  );

  app.post(
    `${base}/external-search/rg/preference/:preference`,
    asyncRoute(async (req, res) => {
      const preference = String(req.params.preference);
      if (preference !== "ask" && preference !== "code-search-only") {
        res.status(400).json({ error: "invalid_rg_preference", allowed: ["ask", "code-search-only"] });
        return;
      }
      const persisted = (await ctx.store.getSession()) as { activeProjectId?: string | null };
      const projectId = persisted.activeProjectId;
      if (!projectId) {
        res.status(409).json({ error: "project_not_selected" });
        return;
      }
      const updated = await setRgPreference(ctx.stateDir, projectId, preference);
      await ctx.ledger.append({
        type: "code.external-rg.preference.changed.local",
        projectId,
        preference: updated,
      }).catch(() => undefined);
      res.json({ ok: true, projectId, preference: updated });
    }),
  );

  app.post(
    `${base}/external-search/rg/requests/:requestId/:decision`,
    asyncRoute(async (req, res) => {
      const requestId = String(req.params.requestId);
      const rawDecision = String(req.params.decision);
      if (!["once", "session", "always", "reject"].includes(rawDecision)) {
        res.status(400).json({
          error: "invalid_rg_approval_decision",
          allowed: ["once", "session", "always", "reject"],
        });
        return;
      }
      const decision = rawDecision as RgApprovalDecision | "reject";
      const persisted = (await ctx.store.getSession()) as { lease?: Lease | null };
      const currentLease = persisted.lease && persisted.lease.expiresAt > Date.now()
        ? persisted.lease
        : null;
      try {
        const request = await resolveRgApprovalRequest({
          stateDir: ctx.stateDir,
          requestId,
          decision,
          currentLease,
          binary: config.rgBinary,
        });
        await ctx.ledger.append({
          type: decision === "reject"
            ? "code.external-rg.request.rejected.local"
            : "code.external-rg.request.approved.local",
          requestId,
          projectId: request.projectId,
          decision,
          binarySha256: request.binarySha256,
        }).catch(() => undefined);
        res.json({ ok: true, request });
      } catch (error) {
        if (respondToRgResolutionError(res, error)) return;
        throw error;
      }
    }),
  );

  app.get(
    `${base}/diagnostics`,
    asyncRoute(async (req, res) => {
      if (!config.diagnostics) {
        res.status(404).json({ error: "diagnostics_unavailable" });
        return;
      }
      const requested = Number.parseInt(String(req.query.limit ?? "40"), 10);
      const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, requested)) : 40;
      res.json({ ok: true, ...(await config.diagnostics.summary(limit)) });
    }),
  );

  app.post(
    `${base}/control/arm`,
    asyncRoute(async (_req, res) => {
      if (!desktopControlSupported) {
        res.status(409).json({ error: "desktop_control_not_supported_on_platform", platform: process.platform });
        return;
      }
      const persisted = (await ctx.store.getSession()) as {
        activeProjectId?: string | null;
        mode?: string;
      };
      const registry = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
      const project = registry.find((entry) => entry.projectId === persisted.activeProjectId);
      if (!project) {
        res.status(409).json({ error: "project_not_selected" });
        return;
      }
      const lease = makeLease(project, "control");
      await ctx.store.setSession({ ...persisted, activeProjectId: project.projectId, mode: "read", lease });
      await clearKill(ctx.stateDir);
      await ctx.ledger.append({ type: "control.armed.local", projectId: project.projectId, leaseId: lease.leaseId });
      res.json({ ok: true, armed: true, expiresAt: lease.expiresAt });
    }),
  );

  app.post(
    `${base}/control/arm-requests/:requestId/approve`,
    asyncRoute(async (req, res) => {
      if (!desktopControlSupported) {
        res.status(409).json({ error: "desktop_control_not_supported_on_platform", platform: process.platform });
        return;
      }
      const requestId = String(req.params.requestId);
      const clearApprovalKill = config.approvalState?.clearKill ?? clearKill;
      const readApprovalKill = config.approvalState?.isKilled ?? isKilled;
      const setApprovalKill = config.approvalState?.setKill ?? setKill;
      let approved: ArmRequestRecord | undefined;
      let lease: ReturnType<typeof makeLease> | undefined;

      try {
        await withPendingArmRequestLock(ctx.stateDir, requestId, async ({ request, transition }) => {
          const persisted = (await ctx.store.getSession()) as {
            activeProjectId?: string | null;
            mode?: string;
            lease?: unknown;
            [key: string]: unknown;
          };
          const registry = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
          const project = registry.find((entry) => entry.projectId === request.projectId);
          const requesterScope = request.sessionScope;
          const requesterPersisted = requesterScope
            ? ((await ctx.store.getSession(requesterScope)) as {
                activeProjectId?: string | null;
                mode?: string;
                lease?: unknown;
                [key: string]: unknown;
              })
            : persisted;
          const localProjectMismatch = Boolean(
            persisted.activeProjectId && persisted.activeProjectId !== request.projectId,
          );
          const requesterProjectMismatch = Boolean(
            requesterPersisted.activeProjectId && requesterPersisted.activeProjectId !== request.projectId,
          );
          if (!project || localProjectMismatch || requesterProjectMismatch) {
            throw new DomainError(ErrorCode.PERMISSION_DENIED, "Arm request project mismatch", {
              reason: "arm_request_project_mismatch",
              requestProjectId: request.projectId,
              activeProjectId: persisted.activeProjectId ?? null,
              requesterProjectId: requesterPersisted.activeProjectId ?? null,
            });
          }

          const previousSession = { ...persisted };
          const previousRequesterSession = { ...requesterPersisted };
          const wasKilled = await readApprovalKill(ctx.stateDir);
          const nextLease = makeLease(project, "control");
          try {
            await ctx.store.setSession({ ...persisted, activeProjectId: project.projectId, mode: "read", lease: nextLease });
            if (requesterScope) {
              await ctx.store.setSession(
                { ...requesterPersisted, activeProjectId: project.projectId, mode: "read", lease: nextLease },
                requesterScope,
              );
            }
            await clearApprovalKill(ctx.stateDir);
            approved = await transition("approved");
            lease = nextLease;
          } catch (error) {
            await ctx.store.setSession(previousSession).catch(() => undefined);
            if (requesterScope) {
              await ctx.store.setSession(previousRequesterSession, requesterScope).catch(() => undefined);
            }
            if (wasKilled) await setApprovalKill(ctx.stateDir).catch(() => undefined);
            else await clearApprovalKill(ctx.stateDir).catch(() => undefined);
            throw error;
          }
        });
      } catch (error) {
        if (await respondToArmResolutionError(ctx, res, requestId, error)) return;
        throw error;
      }

      if (!approved || !lease) throw new Error("Arm approval transaction completed without a terminal record");
      await ctx.ledger.append({
        type: "control.arm-request.approved.local",
        requestId: approved.requestId,
        projectId: approved.projectId,
        leaseId: lease.leaseId,
      }).catch(() => undefined);
      res.json({
        ok: true,
        request: armRequestSummary(approved),
        control: {
          leaseGranted: true,
          armed: true,
          expiresAt: lease.expiresAt,
          leaseId: lease.leaseId,
          sessionKey: approved.sessionKey,
          grantedSessionScope: approved.sessionScope ?? null,
          visibleToRequester: true,
        },
      });
    }),
  );

  app.post(
    `${base}/control/arm-requests/:requestId/reject`,
    asyncRoute(async (req, res) => {
      const requestId = String(req.params.requestId);
      let rejected: ArmRequestRecord | undefined;
      try {
        await withPendingArmRequestLock(ctx.stateDir, requestId, async ({ transition }) => {
          rejected = await transition("rejected");
        });
      } catch (error) {
        if (await respondToArmResolutionError(ctx, res, requestId, error)) return;
        throw error;
      }
      if (!rejected) throw new Error("Arm rejection transaction completed without a terminal record");
      await ctx.ledger.append({
        type: "control.arm-request.rejected.local",
        requestId: rejected.requestId,
        projectId: rejected.projectId,
      }).catch(() => undefined);
      res.json({ ok: true, request: armRequestSummary(rejected), controlStateChanged: false });
    }),
  );

  app.post(
    `${base}/control/disarm`,
    asyncRoute(async (_req, res) => {
      const persisted = (await ctx.store.getSession()) as Record<string, unknown>;
      await setKill(ctx.stateDir);
      await ctx.store.setSession({ ...persisted, mode: "observe", lease: null });
      await ctx.ledger.append({ type: "control.disarmed.local" });
      res.json({ ok: true, armed: false });
    }),
  );

  app.post(
    `${base}/control/actions/:actionId/approve`,
    asyncRoute(async (req, res) => {
      const record = await approveAction(ctx.stateDir, String(req.params.actionId));
      await ctx.ledger.append({ type: "control.action.approved.local", actionId: record.actionId });
      res.json({ ok: true, action: uiAction(record) });
    }),
  );

  app.post(
    `${base}/control/actions/:actionId/reject`,
    asyncRoute(async (req, res) => {
      const record = await rejectAction(ctx.stateDir, String(req.params.actionId), "rejected-by-local-approver");
      await ctx.ledger.append({ type: "control.action.rejected.local", actionId: record.actionId });
      res.json({ ok: true, action: uiAction(record) });
    }),
  );

  app.post(
    `${base}/control/actions/approve-all`,
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...(await approveAllEligible(ctx.stateDir)) });
    }),
  );

  app.post(
    `${base}/control/kill`,
    asyncRoute(async (_req, res) => {
      await setKill(ctx.stateDir);
      await ctx.ledger.append({ type: "control.killed.local" });
      res.json({ ok: true, killed: true });
    }),
  );

  app.post(
    `${base}/control/auto/on`,
    asyncRoute(async (_req, res) => {
      if (!isControlEnabled()) {
        res.status(409).json({ error: "control_disabled" });
        return;
      }
      const apps = controlAllowlist();
      if (apps.length === 0) {
        res.status(409).json({ error: "allowlist_empty" });
        return;
      }
      const scope = await setAuto(ctx.stateDir, { apps });
      res.json({ ok: true, autoEnabled: true, expiresAt: scope.expiresAt });
    }),
  );

  app.post(
    `${base}/control/auto/off`,
    asyncRoute(async (_req, res) => {
      await clearAuto(ctx.stateDir);
      res.json({ ok: true, autoEnabled: false });
    }),
  );
}
