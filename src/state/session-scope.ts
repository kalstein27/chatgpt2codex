import { createHash } from "node:crypto";

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
