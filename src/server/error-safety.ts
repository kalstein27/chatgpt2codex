import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";

export const REMOTE_INTERNAL_ERROR_CODE = "INTERNAL_ERROR";

export interface BoundaryError {
  code: string;
  message: string;
  /** Explicitly allowlisted, secret-free details useful for retry/approval flows. */
  details?: Record<string, unknown>;
}

const PUBLIC_DOMAIN_MESSAGES: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.PROJECT_NOT_FOUND]: "Project not found.",
  [ErrorCode.PATH_OUTSIDE_PROJECT]: "Path is outside the allowed project.",
  [ErrorCode.PATH_OUTSIDE_WORKSPACE]: "Path is outside the allowed workspace.",
  [ErrorCode.HASH_MISMATCH]: "File hash mismatch.",
  [ErrorCode.STALE_FILE_HASH]: "The file changed after it was read.",
  [ErrorCode.PATCH_CONTEXT_REDACTED]: "The patch contains redacted context and cannot be matched safely.",
  [ErrorCode.PATCH_CONTEXT_NOT_FOUND]: "The patch context was not found in the current file.",
  [ErrorCode.CONCURRENT_MUTATION]: "The file changed while the edit was being prepared.",
  [ErrorCode.LEASE_REQUIRED]: "An active project lease is required.",
  [ErrorCode.LEASE_EXPIRED]: "The project lease has expired.",
  [ErrorCode.HOST_MANAGEMENT_REQUIRED]: "Host management authorization is required.",
  [ErrorCode.HOST_MANAGEMENT_EXPIRED]: "The host management authorization has expired.",
  [ErrorCode.COMMAND_NOT_ALLOWED]: "The requested command is not allowed.",
  [ErrorCode.ARBITRARY_SHELL_DENIED]: "Arbitrary shell execution is not allowed.",
  [ErrorCode.APPROVAL_REQUIRED]: "Local approval is required.",
  [ErrorCode.FILE_NOT_FOUND]: "The requested file was not found.",
  [ErrorCode.FILE_EXISTS]: "The file already exists.",
  [ErrorCode.FILE_TOO_LARGE]: "The file is too large.",
  [ErrorCode.SECRET_BLOCKED]: "The requested path is protected.",
  [ErrorCode.TIMEOUT]: "The operation timed out.",
  [ErrorCode.AMBIGUOUS_PROJECT]: "The project selection is ambiguous.",
  [ErrorCode.WORKSPACE_NOT_READY]: "The workspace is not ready.",
  [ErrorCode.NOT_A_FILE]: "The requested path is not a file.",
  [ErrorCode.PATCH_TOO_LARGE]: "The patch is too large.",
  [ErrorCode.NULLBYTE_REJECTED]: "The request contains an invalid path.",
  [ErrorCode.PENDING_WORK_IN_ACTIVE]: "Another operation is already active.",
  [ErrorCode.ACTIVE_OPERATION_IN_PROGRESS]: "Another operation is still running.",
  [ErrorCode.RUNTIME_UPDATE_IN_PROGRESS]: "A runtime or app update is in progress. Retry after the drain completes.",
  [ErrorCode.ACTIVE_PROJECT_LEASE_HELD]: "An active privileged lease already holds the requested or overlapping project root.",
  [ErrorCode.RECOVERY_NOT_FOREIGN_WORK_LANE]: "The requested state is not a recoverable foreign work lane.",
  [ErrorCode.SERIAL_ADMIN_LEASE_HELD]: "A serial or control lease currently holds the project root.",
  [ErrorCode.CURRENT_SESSION_LANE_USE_NORMAL_RELEASE]: "The current session owns this work lane.",
  [ErrorCode.ACTIVE_OPERATION_PRESENT]: "An active project operation prevents recovery.",
  [ErrorCode.LOCK_OWNER_STILL_ACTIVE]: "The privileged lock owner is still active.",
  [ErrorCode.STALE_ROOT_LOCK_RECOVERABLE]: "The privileged root lock is stale and recoverable.",
  [ErrorCode.ROOT_LOCK_STATE_INCONSISTENT]: "The privileged root-lock state is inconsistent.",
  [ErrorCode.CHATGPT_SANDBOX_PATH_UNAVAILABLE]:
    "The supplied path belongs to the ChatGPT sandbox, not the connected Mac. Use a ChatGPT image URL, clipboard, download, or an actual Mac path.",
  [ErrorCode.SCAN_DENIED]: "The requested scan is not allowed.",
  [ErrorCode.PROJECT_NOT_SELECTED]: "A project must be selected first.",
  [ErrorCode.NOT_IMPLEMENTED]: "The operation is not implemented.",
  [ErrorCode.CHECKPOINT_NOT_FOUND]: "Checkpoint not found.",
  [ErrorCode.INVALID_IMAGE_DATA]: "The image data is invalid.",
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: "The media type is not supported.",
  [ErrorCode.PLATFORM_UNSUPPORTED]: "The operation is not supported on this platform.",
  [ErrorCode.QUOTA_EXCEEDED]: "The operation exceeds its quota.",
  [ErrorCode.INVALID_ARGUMENT]: "The request contains an invalid argument.",
  [ErrorCode.PERMISSION_DENIED]: "Permission denied.",
  [ErrorCode.CONTROL_DISABLED]: "Desktop control is disabled.",
  [ErrorCode.CONFIRMATION_PENDING]: "Desktop control confirmation is pending.",
  [ErrorCode.SENSITIVE_TARGET_BLOCKED]: "The requested desktop target is blocked.",
  [ErrorCode.CONTROL_KILLED]: "Desktop control is stopped.",
};

const SAFE_APPROVAL_REASONS = new Set([
  "approval_already_granted_but_not_visible",
  "fresh_approval_required_after_invisible_grant",
]);
const SAFE_PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_REQUEST_ID_RE = /^arm_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_OPERATION_APPROVAL_REQUEST_ID_RE = /^op_[0-9a-fA-F-]{36}$/u;
const SAFE_WIDGET_APPROVAL_REASONS = new Set([
  "WIDGET_APPROVAL_TOKEN_INVALID",
  "WIDGET_APPROVAL_TOKEN_EXPIRED",
  "WIDGET_APPROVAL_ALREADY_SUBMITTED",
  "WIDGET_APPROVAL_SCOPE_MISMATCH",
  "WIDGET_APPROVAL_REQUEST_SCOPE_MISMATCH",
]);
const PERMISSION_DENIED_HANDLING = Object.freeze({
  classificationRequired: true,
  terminalByCodeAlone: false,
  sameCallRetry: "do-not-replay",
  nextStep: "follow-specific-recovery-or-inspect-live-contract",
});
const SAFE_UPDATE_OPERATION_ID_RE = /^(?:rt|app)_[A-Za-z0-9][A-Za-z0-9._:-]{6,155}$/u;
const SAFE_LEASE_PRESETS = new Set(["read-only", "tests-only", "full-write", "image-only", "control"]);
const SAFE_LEASE_CAPABILITIES = new Set(["read", "verify", "write", "image", "remote", "control"]);
const SAFE_PROJECT_SELECT_PURPOSES = new Set(["legacy-admin", "control"]);
const SAFE_AUTHORIZATION_TOOLS = new Set(["project_lane_open", "project_select"]);
const SAFE_PROJECT_CONFLICT_KINDS = new Set(["project-lane", "serial-lease", "project-root-lock", "project-root-overlap"]);
const SAFE_ROOT_OVERLAP_RELATIONS = new Set(["ancestor", "descendant"]);
const SAFE_ROOT_RELATIONS = new Set(["same-root", "ancestor", "descendant"]);
const SAFE_LEASE_HINT_ACTIONS = new Set([
  "project_lane_open",
  "project_lane_renew",
  "release-current-blocking-lease",
  "wait-for-blocking-owner-release",
  "start-new-session-for-other-project",
  "register-explicit-workspace-root",
  "use-required-project-id",
  "workspace_refresh_index",
]);
const SAFE_WORK_LANE_RECOVERY_TOOLS = new Set([
  "project_lane_open",
  "project_lane_renew",
  "project_lane_recover",
]);
const SAFE_BLOCKER_KINDS = new Set(["work-lane", "serial-admin-lease", "control-lease", "stale-orphan-root-lock"]);
const SAFE_OWNER_RELATIONS = new Set(["current", "foreign"]);
const SAFE_OWNER_STATES = new Set(["live", "abandoned"]);
const SAFE_RECOVERY_REASONS = new Set([
  ErrorCode.RECOVERY_NOT_FOREIGN_WORK_LANE,
  ErrorCode.SERIAL_ADMIN_LEASE_HELD,
  ErrorCode.CURRENT_SESSION_LANE_USE_NORMAL_RELEASE,
  ErrorCode.ACTIVE_OPERATION_PRESENT,
  ErrorCode.LOCK_OWNER_STILL_ACTIVE,
  ErrorCode.STALE_ROOT_LOCK_RECOVERABLE,
  ErrorCode.ROOT_LOCK_STATE_INCONSISTENT,
]);
const SAFE_RECOVERY_ACTIONS = new Set([
  "project_release",
  "project_lane_release",
  "project_lane_recover",
  "project_lane_open",
  "project_lane_release-or-project_lane_recover-if-handle-lost",
  "wait-for-owner-release",
  "wait-for-owner-release-or-expiry",
  "wait-for-active-operation-to-finish",
]);
const POST_RUNTIME_BOOTSTRAP_ORDER = [
  "connection_status",
  "agent_guide",
  "project_rules",
  "project_status",
  "project_lane_open",
] as const;
const SAFE_POST_RUNTIME_BOOTSTRAP_STEPS = new Set<string>(POST_RUNTIME_BOOTSTRAP_ORDER);

const SAFE_EDIT_RECOVERY: Partial<Record<ErrorCode, Record<string, string>>> = {
  [ErrorCode.STALE_FILE_HASH]: {
    reason: "stale_file_hash",
    recommendedTool: "file_read_slice",
  },
  [ErrorCode.PATCH_CONTEXT_REDACTED]: {
    reason: "patch_context_redacted",
    recommendedTool: "file_edit_lines",
  },
  [ErrorCode.PATCH_CONTEXT_NOT_FOUND]: {
    reason: "patch_context_not_found",
    recommendedTool: "file_read_slice",
  },
  [ErrorCode.CONCURRENT_MUTATION]: {
    reason: "concurrent_mutation",
    recommendedTool: "file_read_slice",
  },
};

/**
 * Keep the small approval protocol useful to a remote caller without
 * serializing arbitrary DomainError.details. Values are accepted by shape,
 * not merely by key, so user-provided paths/reasons/request bodies cannot
 * cross the boundary accidentally.
 */
function safeRemoteDetails(code: ErrorCode, details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const editRecovery = SAFE_EDIT_RECOVERY[code];
  if (editRecovery) return { ...editRecovery };
  if (!details) {
    return code === ErrorCode.PERMISSION_DENIED
      ? { permissionHandling: PERMISSION_DENIED_HANDLING }
      : undefined;
  }

  if (code === ErrorCode.HOST_MANAGEMENT_REQUIRED || code === ErrorCode.HOST_MANAGEMENT_EXPIRED) {
    const out: Record<string, unknown> = {
      authorizationBoundary: "host-management",
      reason: code === ErrorCode.HOST_MANAGEMENT_REQUIRED
        ? "host-management-required"
        : "host-management-expired",
    };
    if (details.requiredHostManagementLevel === "tools" || details.requiredHostManagementLevel === "admin") {
      out.requiredHostManagementLevel = details.requiredHostManagementLevel;
    }
    if (details.currentHostManagementLevel === "tools" || details.currentHostManagementLevel === "admin") {
      out.currentHostManagementLevel = details.currentHostManagementLevel;
    }
    if (typeof details.expiresAt === "number" && Number.isFinite(details.expiresAt)) out.expiresAt = details.expiresAt;
    if (details.recommendedTool === "host_management_acquire") out.recommendedTool = details.recommendedTool;
    return out;
  }

  if (code === ErrorCode.INVALID_ARGUMENT && details.reason === "invalid-work-lane-id") {
    const out: Record<string, unknown> = { reason: "invalid-work-lane-id" };
    if (typeof details.projectId === "string" && SAFE_PROJECT_ID_RE.test(details.projectId)) {
      out.projectId = redact(details.projectId);
    }
    if (typeof details.recommendedAction === "string" && SAFE_LEASE_HINT_ACTIONS.has(details.recommendedAction)) {
      out.recommendedAction = details.recommendedAction;
    }
    if (typeof details.recommendedTool === "string" && SAFE_WORK_LANE_RECOVERY_TOOLS.has(details.recommendedTool)) {
      out.recommendedTool = details.recommendedTool;
    }
    if (typeof details.retrySameWorkLaneId === "boolean") out.retrySameWorkLaneId = details.retrySameWorkLaneId;
    if (typeof details.terminalForWorkLaneId === "boolean") out.terminalForWorkLaneId = details.terminalForWorkLaneId;
    return out;
  }

  if (code === ErrorCode.WORKSPACE_NOT_READY && details.postRuntimeBootstrapRequired === true) {
    const missing = Array.isArray(details.missing)
      ? details.missing.filter(
          (item): item is string => typeof item === "string" && SAFE_POST_RUNTIME_BOOTSTRAP_STEPS.has(item),
        )
      : [];
    const recommendedAction =
      typeof details.recommendedAction === "string" && SAFE_POST_RUNTIME_BOOTSTRAP_STEPS.has(details.recommendedAction)
        ? details.recommendedAction
        : "connection_status";
    const out: Record<string, unknown> = {
      postRuntimeBootstrapRequired: true,
      recoveryMode: "rebootstrap-before-retry",
      requiredOrder: [...POST_RUNTIME_BOOTSTRAP_ORDER],
      missing,
      recommendedAction,
      retryOriginalCall: false,
      recoveryInstruction:
        "Run the missing bootstrap steps in order before retrying the failed call. After a reconnect or runtime change, start with connection_status and immediately agent_guide. If a mutation may have dispatched, inspect its exact status or receipt before any replay.",
    };
    if (typeof details.projectId === "string" && SAFE_PROJECT_ID_RE.test(details.projectId)) {
      out.projectId = redact(details.projectId);
    }
    return out;
  }

  if (code === ErrorCode.PROJECT_NOT_FOUND) {
    const out: Record<string, unknown> = {};
    if (details.reason === "path-owned-by-registered-project" || details.reason === "project-path-not-indexed") {
      out.reason = details.reason;
    }
    if (typeof details.requiredProjectId === "string" && SAFE_PROJECT_ID_RE.test(details.requiredProjectId)) {
      out.requiredProjectId = redact(details.requiredProjectId);
    }
    if (details.pathRelation === "inside-registered-project") out.pathRelation = details.pathRelation;
    if (typeof details.recommendedAction === "string" && SAFE_LEASE_HINT_ACTIONS.has(details.recommendedAction)) {
      out.recommendedAction = details.recommendedAction;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }


  if (code === ErrorCode.PATH_OUTSIDE_WORKSPACE) {
    const out: Record<string, unknown> = {};
    if (details.reason === "target-root-not-authorized") out.reason = details.reason;
    if (details.recommendedAction === "register-explicit-workspace-root") {
      out.recommendedAction = details.recommendedAction;
    }
    if (typeof details.authorizedWorkspaceRootCount === "number" && Number.isInteger(details.authorizedWorkspaceRootCount)) {
      out.authorizedWorkspaceRootCount = Math.max(0, details.authorizedWorkspaceRootCount);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  if (code === ErrorCode.LEASE_REQUIRED) {
    const out: Record<string, unknown> = {};
    if (typeof details.projectId === "string" && SAFE_PROJECT_ID_RE.test(details.projectId)) {
      out.projectId = redact(details.projectId);
    }
    if (typeof details.requiredCapability === "string" && SAFE_LEASE_CAPABILITIES.has(details.requiredCapability)) {
      out.requiredCapability = details.requiredCapability;
    }
    if (details.required === "workLaneId") out.required = details.required;
    if (details.leaseReason === "work-lane-required" || details.leaseReason === "work-lane-unavailable") {
      out.leaseReason = details.leaseReason;
    }
    if (typeof details.recommendedAction === "string" && SAFE_LEASE_HINT_ACTIONS.has(details.recommendedAction)) {
      out.recommendedAction = details.recommendedAction;
    }
    if (typeof details.recommendedTool === "string" && SAFE_WORK_LANE_RECOVERY_TOOLS.has(details.recommendedTool)) {
      out.recommendedTool = details.recommendedTool;
    }
    if (typeof details.retrySameWorkLaneId === "boolean") out.retrySameWorkLaneId = details.retrySameWorkLaneId;
    if (typeof details.terminalForWorkLaneId === "boolean") out.terminalForWorkLaneId = details.terminalForWorkLaneId;
    if (details.ownerMismatch === true) out.ownerMismatch = true;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  if (code === ErrorCode.LEASE_EXPIRED) {
    const out: Record<string, unknown> = {};
    if (typeof details.projectId === "string" && SAFE_PROJECT_ID_RE.test(details.projectId)) {
      out.projectId = redact(details.projectId);
    }
    if (typeof details.preset === "string" && SAFE_LEASE_PRESETS.has(details.preset)) out.preset = details.preset;
    if (typeof details.expiresAt === "number" && Number.isFinite(details.expiresAt)) out.expiresAt = details.expiresAt;
    if (typeof details.expiredBySec === "number" && Number.isFinite(details.expiredBySec)) {
      out.expiredBySec = Math.max(0, Math.floor(details.expiredBySec));
    }
    if (typeof details.recommendedAction === "string" && SAFE_LEASE_HINT_ACTIONS.has(details.recommendedAction)) {
      out.recommendedAction = details.recommendedAction;
    }
    if (typeof details.recommendedTool === "string" && SAFE_WORK_LANE_RECOVERY_TOOLS.has(details.recommendedTool)) {
      out.recommendedTool = details.recommendedTool;
    }
    if (typeof details.retrySameWorkLaneId === "boolean") out.retrySameWorkLaneId = details.retrySameWorkLaneId;
    if (typeof details.terminalForWorkLaneId === "boolean") out.terminalForWorkLaneId = details.terminalForWorkLaneId;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  if (SAFE_RECOVERY_REASONS.has(code)) {
    const out: Record<string, unknown> = {};
    if (typeof details.projectId === "string" && SAFE_PROJECT_ID_RE.test(details.projectId)) {
      out.projectId = redact(details.projectId);
    }
    if (typeof details.blockerKind === "string" && SAFE_BLOCKER_KINDS.has(details.blockerKind)) {
      out.blockerKind = details.blockerKind;
    }
    if (typeof details.preset === "string" && SAFE_LEASE_PRESETS.has(details.preset)) out.preset = details.preset;
    if (typeof details.ownerRelation === "string" && SAFE_OWNER_RELATIONS.has(details.ownerRelation)) {
      out.ownerRelation = details.ownerRelation;
    }
    if (typeof details.ownerState === "string" && SAFE_OWNER_STATES.has(details.ownerState)) out.ownerState = details.ownerState;
    if (typeof details.expiresAt === "number" && Number.isFinite(details.expiresAt)) out.expiresAt = details.expiresAt;
    if (typeof details.recoverEligible === "boolean") out.recoverEligible = details.recoverEligible;
    if (typeof details.recoveryReason === "string" && SAFE_RECOVERY_REASONS.has(details.recoveryReason as ErrorCode)) {
      out.recoveryReason = details.recoveryReason;
    }
    if (typeof details.recommendedAction === "string" && SAFE_RECOVERY_ACTIONS.has(details.recommendedAction)) {
      out.recommendedAction = details.recommendedAction;
    }
    if (typeof details.activeOperationCount === "number" && Number.isInteger(details.activeOperationCount)) {
      out.activeOperationCount = Math.max(0, details.activeOperationCount);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  if (code === ErrorCode.PERMISSION_DENIED) {
    const permissionHandling = PERMISSION_DENIED_HANDLING;
    const projectId = details.projectId;
    const preset = details.preset;
    const requiredCapability = details.requiredCapability;
    const recommendedPreset = details.recommendedPreset;
    const widgetApprovalReason = details.widgetApprovalReason;
    if (typeof widgetApprovalReason === "string" && SAFE_WIDGET_APPROVAL_REASONS.has(widgetApprovalReason)) {
      const out: Record<string, unknown> = {
        permissionHandling,
        widgetApprovalReason,
        recommendedAction: "check-exact-approval-status-and-session-binding",
        ...(widgetApprovalReason === "WIDGET_APPROVAL_TOKEN_EXPIRED" || widgetApprovalReason === "WIDGET_APPROVAL_ALREADY_SUBMITTED"
          ? { recoveryMode: "status-only", mutationReplayAllowed: false, recommendedTool: "chatgpt_operation_approval_decide", recommendedDecision: "status" }
          : {}),
      };
      if (typeof details.requestId === "string" && SAFE_OPERATION_APPROVAL_REQUEST_ID_RE.test(details.requestId)) {
        out.requestId = details.requestId;
      }
      return out;
    }
    if (
      typeof projectId === "string"
      && SAFE_PROJECT_ID_RE.test(projectId)
      && details.multiProjectLanesEnabled === true
      && typeof details.attemptedPreset === "string"
      && SAFE_LEASE_PRESETS.has(details.attemptedPreset)
      && (details.attemptedPurpose === null
        || (typeof details.attemptedPurpose === "string" && SAFE_PROJECT_SELECT_PURPOSES.has(details.attemptedPurpose)))
      && typeof details.requiredPurpose === "string"
      && SAFE_PROJECT_SELECT_PURPOSES.has(details.requiredPurpose)
      && typeof details.recommendedTool === "string"
      && SAFE_AUTHORIZATION_TOOLS.has(details.recommendedTool)
      && typeof details.recommendedPreset === "string"
      && SAFE_LEASE_PRESETS.has(details.recommendedPreset)
      && details.confirmSwitchRelevant === false
    ) {
      return {
        permissionHandling,
        projectId: redact(projectId),
        multiProjectLanesEnabled: true,
        attemptedPreset: details.attemptedPreset,
        attemptedPurpose: details.attemptedPurpose,
        requiredPurpose: details.requiredPurpose,
        recommendedTool: details.recommendedTool,
        recommendedPreset: details.recommendedPreset,
        confirmSwitchRelevant: false,
      };
    }
    if (
      typeof projectId === "string"
      && SAFE_PROJECT_ID_RE.test(projectId)
      && typeof preset === "string"
      && SAFE_LEASE_PRESETS.has(preset)
      && typeof requiredCapability === "string"
      && SAFE_LEASE_CAPABILITIES.has(requiredCapability)
      && typeof recommendedPreset === "string"
      && SAFE_LEASE_PRESETS.has(recommendedPreset)
    ) {
      return {
        permissionHandling,
        projectId: redact(projectId),
        preset,
        requiredCapability,
        recommendedPreset,
      };
    }
    if (
      typeof projectId === "string"
      && SAFE_PROJECT_ID_RE.test(projectId)
      && typeof details.boundProjectId === "string"
      && SAFE_PROJECT_ID_RE.test(details.boundProjectId)
    ) {
      const rebindBlockedBy = details.rebindBlockedBy === "active-capability"
        || details.rebindBlockedBy === "active-work"
        || details.rebindBlockedBy === "binding-state"
        ? details.rebindBlockedBy
        : "binding-state";
      const recommendedAction = rebindBlockedBy === "active-capability"
        ? "release-current-project-capability"
        : rebindBlockedBy === "active-work"
          ? "wait-for-bound-project-work-to-finish"
          : "inspect-current-session-binding";
      return {
        permissionHandling,
        projectId: redact(projectId),
        boundProjectId: redact(details.boundProjectId),
        reason: "session-bound-to-project",
        rebindBlockedBy,
        recommendedAction,
      };
    }
    return { permissionHandling };
  }

  if (code === ErrorCode.RUNTIME_UPDATE_IN_PROGRESS) {
    const operationId = details.operationId;
    const projectId = details.projectId;
    const phase = details.phase;
    const retryAfterMs = details.retryAfterMs;
    if (
      typeof operationId === "string"
      && SAFE_UPDATE_OPERATION_ID_RE.test(operationId)
      && typeof projectId === "string"
      && SAFE_PROJECT_ID_RE.test(projectId)
      && phase === "draining"
      && typeof retryAfterMs === "number"
      && Number.isInteger(retryAfterMs)
      && retryAfterMs > 0
      && retryAfterMs <= 5 * 60 * 1_000
    ) {
      return {
        operationId,
        projectId: redact(projectId),
        phase,
        retryAfterMs,
        recommendedAction: "retry-after-runtime-update",
      };
    }
    return undefined;
  }

  if (code === ErrorCode.ACTIVE_PROJECT_LEASE_HELD) {
    const out: Record<string, unknown> = {};
    if (typeof details.projectId === "string" && SAFE_PROJECT_ID_RE.test(details.projectId)) {
      out.projectId = redact(details.projectId);
    }
    if (typeof details.conflictingProjectId === "string" && SAFE_PROJECT_ID_RE.test(details.conflictingProjectId)) {
      out.conflictingProjectId = redact(details.conflictingProjectId);
    }
    if (typeof details.conflictKind === "string" && SAFE_PROJECT_CONFLICT_KINDS.has(details.conflictKind)) {
      out.conflictKind = details.conflictKind;
    }
    if (typeof details.overlapRelation === "string" && SAFE_ROOT_OVERLAP_RELATIONS.has(details.overlapRelation)) {
      out.overlapRelation = details.overlapRelation;
    }
    if (typeof details.blockingProjectId === "string" && SAFE_PROJECT_ID_RE.test(details.blockingProjectId)) {
      out.blockingProjectId = redact(details.blockingProjectId);
    }
    if (typeof details.rootRelation === "string" && SAFE_ROOT_RELATIONS.has(details.rootRelation)) {
      out.rootRelation = details.rootRelation;
    }
    if (typeof details.blockingPreset === "string" && SAFE_LEASE_PRESETS.has(details.blockingPreset)) {
      out.blockingPreset = details.blockingPreset;
    }
    if (details.blockingKind === "lane" || details.blockingKind === "serial") out.blockingKind = details.blockingKind;
    if (typeof details.ownerRelation === "string" && SAFE_OWNER_RELATIONS.has(details.ownerRelation)) {
      out.ownerRelation = details.ownerRelation;
    }
    if (typeof details.recommendedAction === "string" && SAFE_LEASE_HINT_ACTIONS.has(details.recommendedAction)) {
      out.recommendedAction = details.recommendedAction;
    }
    if (typeof details.conflictingPreset === "string" && SAFE_LEASE_PRESETS.has(details.conflictingPreset)) {
      out.conflictingPreset = details.conflictingPreset;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  if (code !== ErrorCode.APPROVAL_REQUIRED) return undefined;

  const out: Record<string, unknown> = {};
  for (const key of ["requestCreated", "requestDeduplicated", "localApprovalRequired", "leaseGranted", "visibleToRequester"] as const) {
    if (typeof details[key] === "boolean") out[key] = details[key];
  }
  if (typeof details.expiresAt === "number" && Number.isFinite(details.expiresAt)) out.expiresAt = details.expiresAt;
  if (details.preset === "control") out.preset = details.preset;
  if (typeof details.requestId === "string" && SAFE_REQUEST_ID_RE.test(details.requestId)) out.requestId = details.requestId;
  if (typeof details.projectId === "string" && SAFE_PROJECT_ID_RE.test(details.projectId)) out.projectId = redact(details.projectId);
  if (typeof details.reason === "string" && SAFE_APPROVAL_REASONS.has(details.reason)) {
    out.reason = details.reason;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Convert a thrown value to the only error shape allowed across a remote
 * boundary. Domain codes remain useful to clients, but messages and details
 * are selected from a fixed allowlist. Unknown failures intentionally lose
 * their original type, stack, path, command, and request data.
 */
export function toRemoteBoundaryError(error: unknown): BoundaryError {
  if (error instanceof DomainError) {
    const details = safeRemoteDetails(error.code, error.details);
    return {
      code: error.code,
      message: redact(PUBLIC_DOMAIN_MESSAGES[error.code] ?? "Request rejected."),
      ...(details ? { details } : {}),
    };
  }
  return { code: REMOTE_INTERNAL_ERROR_CODE, message: "Internal error" };
}

/** Local stdio callers retain the existing redacted diagnostics. */
export function toLocalBoundaryError(error: unknown): BoundaryError {
  if (error instanceof DomainError) {
    return { code: error.code, message: redact(error.message) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: ErrorCode.NOT_IMPLEMENTED, message: redact(message) };
}

/** Artifact creation is part of an otherwise successful process result. Keep
 * its local diagnostic useful while using a fixed message for remote callers. */
export function toArtifactError(error: unknown, remote: boolean): string {
  if (remote) return "Output artifact unavailable.";
  return toLocalBoundaryError(error).message.slice(0, 1_000);
}
