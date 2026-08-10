import type { McpRequestClassification } from "./mcp-request-classification.js";

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
export const MCP_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
export const MCP_DISCOVERY_TTL_MS = MCP_SCHEMA_CACHE_TTL_MS;
export const MCP_TOOL_LIST_TTL_MS = MCP_SCHEMA_CACHE_TTL_MS;
export const MCP_SCHEMA_CONTRACT_VERSION = 2;
export const MCP_SCHEMA_REVISION_META_KEY = "io.ezbuilder.chatgpt2codex/schemaRevision";
export const MCP_SCHEMA_EXPIRED_META_KEY = "io.ezbuilder.chatgpt2codex/schemaExpired";
export const MCP_CORE_TOOLS_META_KEY = "io.ezbuilder.chatgpt2codex/coreToolNames";

export const MCP_CORE_TOOL_NAMES = [
  "c2ct_invoke",
  "connection_status",
  "connection_audit",
  "project_select",
  "project_release",
  "project_renew_lease",
  "project_status",
  "project_rules",
  "code_search",
  "file_read_slice",
  "file_edit_lines",
  "file_apply_patch",
  "file_create",
  "repo_status",
  "git_diff_summary",
] as const;

export interface McpServerIdentity {
  name: string;
  version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function modernRequestMeta(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !isRecord(body.params) || !isRecord(body.params._meta)) return undefined;
  return body.params._meta;
}

export function modernProtocolVersion(body: unknown): string | undefined {
  const value = modernRequestMeta(body)?.[MCP_PROTOCOL_VERSION_META_KEY];
  return typeof value === "string" ? value : undefined;
}

export function modernClientName(body: unknown): string | undefined {
  const info = modernRequestMeta(body)?.[MCP_CLIENT_INFO_META_KEY];
  if (!isRecord(info)) return undefined;
  return typeof info.name === "string" ? info.name : undefined;
}

export function isSessionlessDiscoveryRequest(
  httpMethod: string,
  classification: McpRequestClassification,
): boolean {
  return (
    httpMethod === "POST" &&
    !classification.hasSessionHeader &&
    classification.requestKind === "request" &&
    classification.jsonRpcMethod === "server/discover"
  );
}

export function isModernMcpRequest(
  httpMethod: string,
  body: unknown,
  classification: McpRequestClassification,
  protocolVersionHeader?: string,
): boolean {
  if (httpMethod !== "POST" || classification.hasSessionHeader) return false;
  if (classification.requestKind !== "request" && classification.requestKind !== "notification") return false;
  const modernSubsetMethod =
    classification.jsonRpcMethod === "server/discover" ||
    classification.jsonRpcMethod === "tools/list" ||
    classification.jsonRpcMethod === "tools/call";
  return (
    isSessionlessDiscoveryRequest(httpMethod, classification) ||
    modernProtocolVersion(body) !== undefined ||
    (modernSubsetMethod && protocolVersionHeader !== undefined)
  );
}

export function modernServerMeta(serverInfo: McpServerIdentity): Record<string, unknown> {
  return { [MCP_SERVER_INFO_META_KEY]: serverInfo };
}

export function createMcpDiscoveryResult(serverInfo: McpServerIdentity): Record<string, unknown> {
  return {
    resultType: "complete",
    supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
    capabilities: { tools: {} },
    instructions:
      "Cache the advertised tool schemas for ttlMs. tools/list also supports exact-name query, explicit names, and coreOnly extensions for compact schema discovery.",
    ttlMs: MCP_DISCOVERY_TTL_MS,
    toolListTtlMs: MCP_TOOL_LIST_TTL_MS,
    cacheScope: "private",
    schemaContractVersion: MCP_SCHEMA_CONTRACT_VERSION,
    schemaExpired: false,
    coreToolNames: [...MCP_CORE_TOOL_NAMES],
    _meta: modernServerMeta(serverInfo),
  };
}
