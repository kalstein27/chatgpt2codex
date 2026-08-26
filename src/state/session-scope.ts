import { createHash, randomUUID } from "node:crypto";

const OPENAI_SESSION_META_KEY = "openai/session";
const MAX_REMOTE_SESSION_ID_LENGTH = 512;

/**
 * Session scopes isolate authenticated remote owner state from the historical
 * local/default session. Scope identifiers are opaque and are hashed again by
 * Store before they become filenames.
 */
export function hashedSessionScope(kind: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(kind)
    .update("\0")
    .update(parts.join("\0"))
    .digest("hex");
  return `${kind}:${digest}`;
}

/**
 * ChatGPT2Codex is a single-owner runtime. Every authenticated remote MCP or
 * GPT Actions request uses this same stable scope so OAuth refreshes, client-ID
 * changes, and MCP transport rotation cannot discard the selected project or
 * lease. Local stdio and the local approval UI intentionally do not use it.
 */
export function remoteOwnerSessionScope(): string {
  return hashedSessionScope("remote-owner", "single-user");
}

/**
 * Bind remote state to one ChatGPT conversation without persisting the opaque
 * source identifier. Different conversations must never share project leases
 * or work lanes merely because they authenticate as the same local owner.
 */
export function remoteConversationSessionScope(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const value = (meta as Record<string, unknown>)[OPENAI_SESSION_META_KEY];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_SESSION_ID_LENGTH) {
    return undefined;
  }
  return hashedSessionScope("remote-chat", value);
}

/** Stable only for one stateful MCP transport. Transport rotation intentionally
 * loses project capability rather than falling back to a shared owner scope. */
export function remoteTransportSessionScope(seed: string): string {
  return hashedSessionScope("remote-transport", seed);
}

/** Fail-closed fallback for remote requests that expose no stable conversation
 * identity. It is intentionally not reusable by a later request. */
export function remoteTransientSessionScope(): string {
  return hashedSessionScope("remote-transient", randomUUID());
}
