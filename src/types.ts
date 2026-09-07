/**
 * chatgpt2codex shared contract.
 *
 * This module is the single source of truth for cross-module types used by
 * every tool implementation. It implements the repository's internal PRD
 * contracts without requiring private/local design documents in the public tree.
 *
 * Public signatures frozen here MUST NOT change without updating every
 * dependent module. Implementers fill in *other* modules' bodies, not this
 * file's shape.
 */
import type { RuntimeActivityContext } from "./runtime/activity.js";
import type { ConnectionDiagnosticsSink } from "./runtime/connection-diagnostics.js";

// ---------------------------------------------------------------------------
// Domain data model (PRD §10)
// ---------------------------------------------------------------------------

/** Canonical project metadata as tracked in the central registry. */
export interface Project {
  projectId: string;
  name: string;
  root: string;
  aliases: string[];
  branch?: string;
  dirty?: boolean;
  hasAgentsMd?: boolean;
  hasCodeBrain?: boolean;
  packageHints?: string[];
  lastSeenAt?: string;
}

/**
 * Registry entry as persisted in `~/.local/share/chatgpt2codex/projects.json`.
 * Currently identical in shape to `Project`; kept as a distinct alias so the
 * on-disk contract can diverge from the in-memory/API contract later without
 * a breaking rename.
 */
export type ProjectRegistryEntry = Project;

/**
 * Lease preset controlling the ceiling of permitted mutating operations.
 * `control` is the Option B human-confirmed desktop-control preset: it grants
 * only `read` + `control` capabilities (never write/image/remote) and is
 * only reachable when the install-time `CHATGPT2CODEX_CONTROL` feature flag
 * is enabled (src/control/policy.ts isControlEnabled).
 */
export type LeasePreset = "read-only" | "tests-only" | "full-write" | "image-only" | "control";

/** Active project lease granted by `project_select`. */
export interface Lease {
  projectId: string;
  leaseId: string;
  projectRoot: string;
  preset: LeasePreset;
  issuedAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

/** Execution mode ladder (PRD §6 / CHATGPT2CODEX-PRD §13). */
export type ExecutionMode = "observe" | "read" | "edit" | "verify" | "danger";

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------

export interface Config {
  workspaceRoot: string;
  /** Explicit authorized workspace roots. The first entry is workspaceRoot. */
  workspaceRoots?: string[];
  stateDir: string;
  /** Max bytes returned/read for a single file_read_slice call. */
  maxReadBytes: number;
  /** Max bytes accepted for a single file_apply_patch payload. */
  maxPatchBytes: number;
  /** Default command timeout in seconds. */
  defaultCommandTimeoutSec: number;
  /** Default lease TTL in ms. */
  defaultLeaseTtlMs: number;
  /** Experimental parallel project lanes. Default false; never inferred from
   * an existing serial lease. */
  multiProjectLanesEnabled?: boolean;
  /** Public HTTP origin used for short-lived inline screenshot links. */
  publicUrl?: string;
}

// ---------------------------------------------------------------------------
// Tool context — dependency bag threaded through every tool handler.
// ---------------------------------------------------------------------------

export interface ToolContext {
  workspaceRoot: string;
  /** Explicit authorized workspace roots. Falls back to [workspaceRoot]. */
  workspaceRoots?: string[];
  stateDir: string;
  /** Loaded/loadable project registry entries. */
  registry: ProjectRegistryEntry[];
  /** Append-only audit ledger sink. */
  ledger: {
    append(event: { type: string; [k: string]: unknown }): Promise<void>;
  };
  /** Central state store (registry + session persistence). */
  store: {
    loadProjects(): Promise<ProjectRegistryEntry[]>;
    saveProjects(p: ProjectRegistryEntry[]): Promise<void>;
    getSession(scope?: string): Promise<unknown>;
    setSession(s: unknown, scope?: string): Promise<void>;
    /** Serialize a complete read/modify/write transaction for one scoped
     * session. Production stores provide this; narrow test doubles may omit it. */
    updateSession?(
      scope: string | undefined,
      updater: (current: unknown) => unknown | Promise<unknown>,
    ): Promise<unknown>;
    /** Remove only one exact persisted serial lease after the caller has
     * independently proved its global privilege generation abandoned. */
    clearSerialLeaseByIdentity?(input: {
      projectId: string;
      leaseId: string;
      preset: LeasePreset;
    }): Promise<{ cleared: boolean; matchedCount: number }>;
  };
  /** Opaque scope for active-project and lease persistence. Absent means the
   * historical local/default session. Raw credentials must never be stored. */
  sessionScope?: string;
  config: Config;
  /** True for an MCP server instance handed a remote/network transport
   * session (currently: src/server/http.ts's /mcp endpoint, which is how
   * ChatGPT connects). Absent/false for local stdio sessions (Codex CLI,
   * status bar). Used to refuse arming a `control` lease or resuming a
   * killed control session (project_select preset=control) from a remote
   * caller — lease arming and kill resumption stay local-only even when the
   * desktop-control tools are exposed to ChatGPT
   * (src/control/policy.ts isControlChatGptExposed). */
  remote?: boolean;
  /** Server-injected provenance for one dedicated GPT Action route. This is
   * never populated from caller input. Consequential=true means the route is
   * published with x-openai-isConsequential=true so ChatGPT must confirm the
   * exact action before issuing the request. */
  actionInvocation?: {
    surface: "gpt-action";
    operationId: string;
    dedicatedRoute: true;
    consequential: boolean;
  };
  /** Optional per-transport activity sink used only for bounded local
   * operational status. Tool inputs and outputs are never passed to it. */
  activity?: RuntimeActivityContext;
  /** Secret-free local connection event sink. Never pass tool inputs,
   * authorization headers, tokens, or tool outputs to this interface. */
  diagnostics?: ConnectionDiagnosticsSink;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Domain error codes — never throw raw strings across a tool boundary. */
export enum ErrorCode {
  PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND",
  PATH_OUTSIDE_PROJECT = "PATH_OUTSIDE_PROJECT",
  PATH_OUTSIDE_WORKSPACE = "PATH_OUTSIDE_WORKSPACE",
  HASH_MISMATCH = "HASH_MISMATCH",
  STALE_FILE_HASH = "STALE_FILE_HASH",
  PATCH_CONTEXT_REDACTED = "PATCH_CONTEXT_REDACTED",
  PATCH_CONTEXT_NOT_FOUND = "PATCH_CONTEXT_NOT_FOUND",
  CONCURRENT_MUTATION = "CONCURRENT_MUTATION",
  LEASE_REQUIRED = "LEASE_REQUIRED",
  LEASE_EXPIRED = "LEASE_EXPIRED",
  COMMAND_NOT_ALLOWED = "COMMAND_NOT_ALLOWED",
  ARBITRARY_SHELL_DENIED = "ARBITRARY_SHELL_DENIED",
  APPROVAL_REQUIRED = "APPROVAL_REQUIRED",
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  FILE_EXISTS = "FILE_EXISTS",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  SECRET_BLOCKED = "SECRET_BLOCKED",
  TIMEOUT = "TIMEOUT",
  AMBIGUOUS_PROJECT = "AMBIGUOUS_PROJECT",
  WORKSPACE_NOT_READY = "WORKSPACE_NOT_READY",
  // Additional codes referenced by the PRD tool catalog (§8) that stub
  // implementations may also raise; kept here so every module shares one
  // enum instead of inventing ad-hoc strings.
  NOT_A_FILE = "NOT_A_FILE",
  PATCH_TOO_LARGE = "PATCH_TOO_LARGE",
  NULLBYTE_REJECTED = "NULLBYTE_REJECTED",
  PENDING_WORK_IN_ACTIVE = "PENDING_WORK_IN_ACTIVE",
  ACTIVE_OPERATION_IN_PROGRESS = "ACTIVE_OPERATION_IN_PROGRESS",
  RUNTIME_UPDATE_IN_PROGRESS = "RUNTIME_UPDATE_IN_PROGRESS",
  ACTIVE_PROJECT_LEASE_HELD = "ACTIVE_PROJECT_LEASE_HELD",
  RECOVERY_NOT_FOREIGN_WORK_LANE = "RECOVERY_NOT_FOREIGN_WORK_LANE",
  SERIAL_ADMIN_LEASE_HELD = "SERIAL_ADMIN_LEASE_HELD",
  CURRENT_SESSION_LANE_USE_NORMAL_RELEASE = "CURRENT_SESSION_LANE_USE_NORMAL_RELEASE",
  ACTIVE_OPERATION_PRESENT = "ACTIVE_OPERATION_PRESENT",
  LOCK_OWNER_STILL_ACTIVE = "LOCK_OWNER_STILL_ACTIVE",
  STALE_ROOT_LOCK_RECOVERABLE = "STALE_ROOT_LOCK_RECOVERABLE",
  ROOT_LOCK_STATE_INCONSISTENT = "ROOT_LOCK_STATE_INCONSISTENT",
  CHATGPT_SANDBOX_PATH_UNAVAILABLE = "CHATGPT_SANDBOX_PATH_UNAVAILABLE",
  SCAN_DENIED = "SCAN_DENIED",
  PROJECT_NOT_SELECTED = "PROJECT_NOT_SELECTED",
  NOT_IMPLEMENTED = "NOT_IMPLEMENTED",
  CHECKPOINT_NOT_FOUND = "CHECKPOINT_NOT_FOUND",
  INVALID_IMAGE_DATA = "INVALID_IMAGE_DATA",
  UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE",
  PLATFORM_UNSUPPORTED = "PLATFORM_UNSUPPORTED",
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",
  OPERATION_NOT_FOUND = "OPERATION_NOT_FOUND",
  OPERATION_NOT_ACTIVE = "OPERATION_NOT_ACTIVE",
  INVALID_ARGUMENT = "INVALID_ARGUMENT",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  // Option B desktop-control codes (src/control/**).
  CONTROL_DISABLED = "CONTROL_DISABLED",
  CONFIRMATION_PENDING = "CONFIRMATION_PENDING",
  SENSITIVE_TARGET_BLOCKED = "SENSITIVE_TARGET_BLOCKED",
  CONTROL_KILLED = "CONTROL_KILLED",
}

/** Thrown by any domain-level failure. Tool boundary must catch and map. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Tool result helper
// ---------------------------------------------------------------------------

/**
 * Shape every MCP tool handler resolves to: structured content for
 * programmatic consumers plus a short human-readable text summary, matching
 * MCP's `structuredContent` + text content block convention.
 */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

export interface ToolResult<T = Record<string, unknown>> {
  structuredContent: T;
  content: ToolContent[];
  isError?: boolean;
  /** Result-level metadata (e.g. ChatGPT Apps SDK widget payloads); not shown to the model. */
  _meta?: Record<string, unknown>;
}

export function makeResult<T extends Record<string, unknown>>(
  structured: T,
  text: string,
  isError?: boolean,
): ToolResult<T> {
  return {
    structuredContent: structured,
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}
