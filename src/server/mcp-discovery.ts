import type { McpRequestClassification } from "./mcp-request-classification.js";
import { CHATGPT_OPERATION_APPROVAL_PRESENTER_TOOL } from "./chatgpt-consent-widget.js";

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
// Remote ChatGPT may keep a mounted tool schema across a runtime replacement.
// C2CT therefore never asks clients/proxies to persist schema discovery results:
// every discovery/list read is a revalidation point for the live runtime.
export const MCP_SCHEMA_CACHE_TTL_MS = 0;
export const MCP_DISCOVERY_TTL_MS = MCP_SCHEMA_CACHE_TTL_MS;
export const MCP_TOOL_LIST_TTL_MS = MCP_SCHEMA_CACHE_TTL_MS;
export const MCP_SCHEMA_CONTRACT_VERSION = 4;
export const MCP_SCHEMA_REVISION_META_KEY = "io.ezbuilder.chatgpt2codex/schemaRevision";
export const MCP_SCHEMA_EXPIRED_META_KEY = "io.ezbuilder.chatgpt2codex/schemaExpired";
export const MCP_SCHEMA_REVALIDATE_META_KEY = "io.ezbuilder.chatgpt2codex/schemaMustRevalidate";
export const MCP_CORE_TOOLS_META_KEY = "io.ezbuilder.chatgpt2codex/coreToolNames";

// Keep stateful SDK initialize responses and the stateless ChatGPT discovery
// adapter on the same capability contract. Hosts that support MCP list-change
// notifications can invalidate their mounted catalog, while reconnect/refresh
// still revalidates against the live tools/list response with a zero TTL.
export const MCP_TOOL_CAPABILITIES = {
  listChanged: true,
} as const;

export const MCP_CORE_TOOL_NAMES = [
  "c2ct_invoke",
  CHATGPT_OPERATION_APPROVAL_PRESENTER_TOOL,
  "connection_status",
  "connection_audit",
  "session_context_update",
  "project_lane_open",
  "project_lane_status",
  "project_lane_renew",
  "project_lane_release",
  "project_lane_recover",
  "project_select",
  "project_release",
  "project_renew_lease",
  "chatgpt_widget_asset_apply",
  "project_status",
  "project_rules",
  "operation_status",
  "runtime_apply_status",
  "macos_app_apply_status",
  "runtime_snapshot_status",
  "code_search",
  "file_read_slice",
  "file_read_batch",
  "file_edit_lines",
  "file_apply_patch",
  "file_create",
  "tool_schema_get",
  "mutation_status",
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

export function createMcpDiscoveryResult(
  serverInfo: McpServerIdentity,
  schemaRevision?: string,
): Record<string, unknown> {
  return {
    resultType: "complete",
    supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
    capabilities: { tools: { ...MCP_TOOL_CAPABILITIES } },
    instructions:
      "Revalidate tools/list for the live runtime instead of persisting tool schemas across runtime replacement. tools/list supports exact-name query, explicit names, and coreOnly extensions. tool_schema_get plus c2ct_invoke is the stable fallback when a host-mounted named schema is stale.",
    ttlMs: MCP_DISCOVERY_TTL_MS,
    toolListTtlMs: MCP_TOOL_LIST_TTL_MS,
    cacheScope: "private",
    schemaContractVersion: MCP_SCHEMA_CONTRACT_VERSION,
    schemaExpired: false,
    schemaMustRevalidate: true,
    ...(schemaRevision ? { schemaRevision } : {}),
    coreToolNames: [...MCP_CORE_TOOL_NAMES],
    _meta: {
      ...modernServerMeta(serverInfo),
      [MCP_SCHEMA_REVALIDATE_META_KEY]: true,
      ...(schemaRevision ? { [MCP_SCHEMA_REVISION_META_KEY]: schemaRevision } : {}),
    },
  };
}
