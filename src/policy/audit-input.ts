import { createHash } from "node:crypto";
import { redact } from "./secrets.js";

const MAX_DEPTH = 6;
const MAX_OBJECT_KEYS = 50;
const MAX_ARRAY_ITEMS = 50;
const MAX_INLINE_STRING_CHARS = 1_024;

const SECRET_KEY_PATTERN =
  /^(token|ownerToken|accessToken|refreshToken|apiKey|password|passphrase|secret|authorization|cookie|setCookie|stdin)$/i;
const CAPABILITY_HANDLE_KEY_PATTERN = /^(workLaneId)$/i;
const BINARY_KEY_PATTERN = /^(imageData|imageBytes|base64|dataUrl)$/i;
const PATCH_KEY_PATTERN = /^(patch|patchText|diff)$/i;
const PRIVATE_TEXT_KEY_PATTERN = /^(text|body|content|fileContent|reason|typedText|inputText|instruction|prompt|query|topic|label|message|title|description|error|preview)$/i;
const COMMAND_KEY_PATTERN = /^(command|script)$/i;
const ARGUMENTS_KEY_PATTERN = /^(args|argv|arguments)$/i;
const SECRET_CONTAINER_KEY_PATTERN = /^(env|environment|environmentvariables|headers|requestheaders|responseheaders)$/i;
const PATH_KEY_PATTERN = /^(path|cwd|root|projectRoot|sourcePath|destPath)$/i;
const URL_KEY_PATTERN = /(?:url|uri)$/i;

function normalizedKey(key: string): string {
  return key.replace(/[-_\s]/g, "");
}

function stringSize(value: string): { chars: number; bytes: number } {
  return { chars: value.length, bytes: Buffer.byteLength(value, "utf8") };
}

function auditValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "binary";
  if (value instanceof Date) return "date";
  return typeof value;
}

function summarizeSecretContainer(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { kind: "secret-container", redacted: true, itemCount: value.length };
  }
  if (value && typeof value === "object") {
    return {
      kind: "secret-container",
      redacted: true,
      itemCount: Object.keys(value as Record<string, unknown>).length,
    };
  }
  return { kind: "secret-container", redacted: true, valueType: auditValueType(value) };
}

function summarizeArguments(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    let bytes: number | undefined;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      // Count remains useful even when an unusual value cannot be serialized.
    }
    return {
      kind: "arguments",
      redacted: true,
      count: value.length,
      ...(bytes !== undefined ? { bytes } : {}),
    };
  }
  return { kind: "arguments", redacted: true, valueType: auditValueType(value) };
}

function hashedSummary(kind: "binary" | "patch", value: string): Record<string, unknown> {
  return {
    kind,
    ...stringSize(value),
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

function commandExecutable(value: string): string {
  const first = value.trim().split(/\s+/u)[0] ?? "unknown";
  const normalized = first.replace(/^['"]|['"]$/gu, "");
  return (normalized.split(/[\\/]/u).pop() || "unknown").slice(0, 80);
}

function commandRisk(value: string): "local" | "network" | "destructive" {
  const lower = value.toLowerCase();
  if (/\b(?:rm|rmdir|del|remove-item|git\s+(?:reset|clean|push)|shutdown|reboot|kill|pkill|launchctl)\b/u.test(lower)) {
    return "destructive";
  }
  if (/\b(?:curl|wget|fetch|git\s+(?:clone|fetch)|npm\s+(?:install|publish)|pip\s+install)\b|https?:\/\//u.test(lower)) {
    return "network";
  }
  return "local";
}

/** Permanent-ledger representation for command/script fields. */
export function summarizeCommandAudit(value: string): Record<string, unknown> {
  return {
    kind: "command",
    ...stringSize(value),
    executable: commandExecutable(value),
    risk: commandRisk(value),
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

/** Permanent-ledger representation for free-form user text. */
export function summarizePrivateText(value: string): Record<string, unknown> {
  return { kind: "private-text", redacted: true, ...stringSize(value) };
}

export function summarizePath(value: string): Record<string, unknown> {
  const basename = value.split(/[\\/]/u).filter(Boolean).pop() ?? "";
  return {
    kind: "path",
    absolute: /^(?:[\\/]|~[\\/]|[A-Za-z]:[\\/])/u.test(value),
    basename: basename.slice(0, 120),
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

export function summarizeUrl(value: string): Record<string, unknown> {
  try {
    const parsed = new URL(value);
    return {
      kind: "url",
      protocol: parsed.protocol,
      hasUsername: Boolean(parsed.username),
      hasPassword: Boolean(parsed.password),
      hasQuery: parsed.search.length > 0,
      hasFragment: parsed.hash.length > 0,
      sha256: createHash("sha256").update(value, "utf8").digest("hex"),
    };
  } catch {
    return summarizePrivateText(value);
  }
}

/**
 * Permanent-ledger representation for desktop-control target metadata.
 * AX titles/labels/descriptions can contain arbitrary user text, so retain
 * only the target shape and role. Coordinates are intentionally represented
 * as presence rather than exact values.
 */
export function summarizeControlTarget(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "control-target", valid: false };
  }
  const target = value as Record<string, unknown>;
  const ax = target.ax && typeof target.ax === "object" && !Array.isArray(target.ax)
    ? target.ax as Record<string, unknown>
    : undefined;
  const point = target.windowPoint && typeof target.windowPoint === "object" && !Array.isArray(target.windowPoint)
    ? target.windowPoint as Record<string, unknown>
    : undefined;
  return {
    kind: "control-target",
    hasAx: Boolean(ax),
    ...(ax ? { axRole: typeof ax.role === "string" ? ax.role.slice(0, 40) : "unknown" } : {}),
    hasWindowPoint: Boolean(point),
  };
}

/** Permanent-ledger representation for the read-only AX resolve preview. */
export function summarizeResolvedTarget(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const resolved = value as Record<string, unknown>;
  const frame = resolved.frame && typeof resolved.frame === "object" && !Array.isArray(resolved.frame)
    ? resolved.frame as Record<string, unknown>
    : undefined;
  return {
    kind: "control-resolve",
    found: resolved.found === true,
    ...(typeof resolved.role === "string" ? { role: resolved.role.slice(0, 40) } : {}),
    hasFrame: Boolean(frame),
    ...(typeof resolved.matchCount === "number" ? { matchCount: resolved.matchCount } : {}),
    ...(typeof resolved.source === "string" ? { source: resolved.source } : {}),
    ...(resolved.reason !== undefined ? { reason: summarizePrivateText(String(resolved.reason)) } : {}),
  };
}

function summarizeString(value: string, key?: string): unknown {
  const normalized = key ? normalizedKey(key) : "";

  if (CAPABILITY_HANDLE_KEY_PATTERN.test(normalized)) {
    return {
      kind: "capability-handle",
      redacted: true,
      ...stringSize(value),
      sha256: createHash("sha256").update(value, "utf8").digest("hex"),
    };
  }
  if (SECRET_KEY_PATTERN.test(normalized)) {
    return { kind: "secret", redacted: true, ...stringSize(value) };
  }
  if (BINARY_KEY_PATTERN.test(normalized)) {
    return hashedSummary("binary", value);
  }
  if (PATCH_KEY_PATTERN.test(normalized)) {
    return hashedSummary("patch", value);
  }
  if (PATH_KEY_PATTERN.test(normalized) && /^(?:[\\/]|~[\\/]|[A-Za-z]:[\\/])/u.test(value)) {
    return summarizePath(value);
  }
  if (URL_KEY_PATTERN.test(normalized)) {
    return summarizeUrl(value);
  }
  if (PRIVATE_TEXT_KEY_PATTERN.test(normalized)) {
    return summarizePrivateText(value);
  }
  if (COMMAND_KEY_PATTERN.test(normalized)) {
    return summarizeCommandAudit(value);
  }
  if (value.length > MAX_INLINE_STRING_CHARS) {
    return {
      kind: "string",
      ...stringSize(value),
      sha256: createHash("sha256").update(value, "utf8").digest("hex"),
      truncated: true,
    };
  }
  return redact(value);
}

/**
 * Produce a bounded, field-aware representation suitable for the permanent
 * audit ledger. It never JSON-stringifies the full input, and it avoids
 * storing credentials, typed text, patch bodies, or base64 image payloads.
 */
export function summarizeAuditInput(input: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number, key?: string): unknown => {
    const normalized = key ? normalizedKey(key) : "";
    if (key && SECRET_CONTAINER_KEY_PATTERN.test(normalized)) {
      return summarizeSecretContainer(value);
    }
    if (key && ARGUMENTS_KEY_PATTERN.test(normalized)) {
      return summarizeArguments(value);
    }
    if (key && URL_KEY_PATTERN.test(normalized)) {
      return typeof value === "string"
        ? summarizeUrl(value)
        : { kind: "url", redacted: true, valueType: auditValueType(value) };
    }
    if (typeof value === "string") return summarizeString(value, key);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      return {
        kind: "binary",
        bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
    }
    if (typeof value !== "object") return redact(String(value));
    if (depth >= MAX_DEPTH) return { truncated: true, reason: "max-depth" };
    if (seen.has(value)) return { truncated: true, reason: "circular-reference" };
    seen.add(value);

    if (Array.isArray(value)) {
      const result = value.slice(0, MAX_ARRAY_ITEMS).map((item) => visit(item, depth + 1));
      if (value.length > MAX_ARRAY_ITEMS) {
        result.push({ truncated: true, remainingItems: value.length - MAX_ARRAY_ITEMS });
      }
      return result;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
      const summarized = visit(childValue, depth + 1, childKey);
      if (summarized !== undefined) result[childKey] = summarized;
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      result._truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return result;
  };

  try {
    return visit(input, 0);
  } catch {
    // Auditing must never turn a completed tool mutation into a failed call
    // because an unusual object contains a throwing getter or proxy trap.
    return { truncated: true, reason: "unserializable-input" };
  }
}
