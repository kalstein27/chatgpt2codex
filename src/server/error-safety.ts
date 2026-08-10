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
  [ErrorCode.ACTIVE_PROJECT_LEASE_HELD]: "Another project still holds an active privileged lease.",
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
const SAFE_LEASE_PRESETS = new Set(["read-only", "tests-only", "full-write", "image-only", "control"]);
const SAFE_LEASE_CAPABILITIES = new Set(["read", "verify", "write", "image", "remote", "control"]);
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
  if (!details) return undefined;

  if (code === ErrorCode.PERMISSION_DENIED) {
    const projectId = details.projectId;
    const preset = details.preset;
    const requiredCapability = details.requiredCapability;
    const recommendedPreset = details.recommendedPreset;
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
        projectId: redact(projectId),
        preset,
        requiredCapability,
        recommendedPreset,
      };
    }
    return undefined;
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
