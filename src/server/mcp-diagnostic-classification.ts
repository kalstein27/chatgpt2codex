import { redact } from "../policy/secrets.js";

export interface ModernMcpDiagnosticInput {
  status: number;
  jsonRpcMethod?: string;
  jsonRpcErrorCode?: number;
  body?: unknown;
}

export interface ModernMcpDiagnosticClassification {
  event: "mcp.modern_request" | "mcp.resource_probe";
  outcome: "success" | "failure" | "info";
  errorCode?: string;
  probeResult?: "unsupported";
  resourceScheme?: string;
  resourceName?: string;
}

const SAFE_RESOURCE_SCHEMES = new Set(["ui", "mcp", "resource", "file", "http", "https"]);
const RESOURCE_NAME_SCHEMES = new Set(["ui", "mcp", "resource"]);

function resourceProbeSummary(body: unknown): { resourceScheme?: string; resourceName?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const params = (body as Record<string, unknown>).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const uri = (params as Record<string, unknown>).uri;
  if (typeof uri !== "string") return {};
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(uri);
  if (!schemeMatch) return {};
  const resourceScheme = schemeMatch[1]!.toLowerCase();
  if (!SAFE_RESOURCE_SCHEMES.has(resourceScheme)) return {};
  if (!RESOURCE_NAME_SCHEMES.has(resourceScheme)) return { resourceScheme };
  const pathOnly = uri.split(/[?#]/u, 1)[0] ?? "";
  const candidate = pathOnly.split("/").filter(Boolean).at(-1);
  const resourceName = candidate
    && /^[A-Za-z0-9._-]{1,80}$/u.test(candidate)
    && !/(?:token|secret|credential|password|passwd|api[_-]?key)/iu.test(candidate)
    && redact(candidate) === candidate
    ? candidate
    : undefined;
  return { resourceScheme, ...(resourceName ? { resourceName } : {}) };
}

export function classifyModernMcpDiagnostic(
  input: ModernMcpDiagnosticInput,
): ModernMcpDiagnosticClassification {
  const unsupportedResourceProbe =
    input.status === 200
    && input.jsonRpcMethod === "resources/read"
    && input.jsonRpcErrorCode === -32601;
  if (unsupportedResourceProbe) {
    return {
      event: "mcp.resource_probe",
      outcome: "info",
      probeResult: "unsupported",
      ...resourceProbeSummary(input.body),
    };
  }
  const failure = input.status >= 400 || input.jsonRpcErrorCode !== undefined;
  return {
    event: "mcp.modern_request",
    outcome: failure ? "failure" : "success",
    ...(failure
      ? { errorCode: input.status >= 400 ? `HTTP_${input.status}` : "MCP_JSONRPC_ERROR" }
      : {}),
  };
}
