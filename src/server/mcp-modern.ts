import type { ToolContext } from "../types.js";
import { toRemoteBoundaryError } from "./error-safety.js";
import { createServer as createMcpServer } from "./mcp-server.js";
import {
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_CLIENT_INFO_META_KEY,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_META_KEY,
  MCP_SCHEMA_EXPIRED_META_KEY,
  MCP_SCHEMA_REVALIDATE_META_KEY,
  MCP_SCHEMA_REVISION_META_KEY,
  MCP_TOOL_LIST_TTL_MS,
  createMcpDiscoveryResult,
  modernProtocolVersion,
  modernRequestMeta,
  modernServerMeta,
  type McpServerIdentity,
} from "./mcp-discovery.js";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface ModernMcpHttpHeaders {
  protocolVersion?: string;
  method?: string;
  name?: string;
}

export interface ModernMcpDispatchResult {
  status: number;
  response?: Record<string, unknown>;
}

type LegacyRequestHandler = (
  request: { method: string; params?: Record<string, unknown> },
  extra: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRequestId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null;
}

function jsonRpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: safeRequestId(id), result };
}

function jsonRpcError(id: unknown, code: number, message: string, data?: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: safeRequestId(id),
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function decorateModernResult(
  method: string,
  result: Record<string, unknown>,
  serverInfo: McpServerIdentity,
): Record<string, unknown> {
  const existingMeta = isRecord(result._meta) ? result._meta : {};
  const decorated: Record<string, unknown> = {
    ...result,
    resultType: "complete",
    _meta: { ...existingMeta, ...modernServerMeta(serverInfo) },
  };
  if (method === "tools/list") {
    decorated.ttlMs = MCP_TOOL_LIST_TTL_MS;
    decorated.cacheScope = "private";
    decorated.schemaMustRevalidate = true;
    decorated._meta = {
      ...(decorated._meta as Record<string, unknown>),
      [MCP_SCHEMA_REVALIDATE_META_KEY]: true,
    };
  }
  if (method === "tools/call" && !Array.isArray(decorated.content)) {
    decorated.content = [];
  }
  return decorated;
}

function invalidEnvelopeReason(body: unknown, headers?: ModernMcpHttpHeaders): string | undefined {
  if (!isRecord(body) || !isRecord(body.params)) return "params must be an object";
  const meta = modernRequestMeta(body);
  if (!meta && headers?.protocolVersion === undefined) {
    return `params._meta or MCP-Protocol-Version is required`;
  }
  if (meta && typeof meta[MCP_PROTOCOL_VERSION_META_KEY] !== "string" && headers?.protocolVersion === undefined) {
    return `${MCP_PROTOCOL_VERSION_META_KEY} is required`;
  }
  if (meta && !isRecord(meta[MCP_CLIENT_CAPABILITIES_META_KEY])) {
    return `${MCP_CLIENT_CAPABILITIES_META_KEY} must be an object`;
  }
  const clientInfo = meta?.[MCP_CLIENT_INFO_META_KEY];
  if (
    clientInfo !== undefined &&
    (!isRecord(clientInfo) || typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string")
  ) {
    return `${MCP_CLIENT_INFO_META_KEY} must contain string name and version fields`;
  }
  return undefined;
}

function headerMismatch(
  method: string,
  params: Record<string, unknown>,
  requestedVersion: string,
  headers: ModernMcpHttpHeaders | undefined,
): { header: string; expected: string; actual: string } | undefined {
  if (!headers) return undefined;
  if (headers.protocolVersion !== undefined && headers.protocolVersion !== requestedVersion) {
    return { header: "MCP-Protocol-Version", expected: requestedVersion, actual: headers.protocolVersion };
  }
  if (headers.method !== undefined && headers.method !== method) {
    return { header: "Mcp-Method", expected: method, actual: headers.method };
  }
  if (method === "tools/call" && typeof params.name === "string" && headers.name !== undefined && headers.name !== params.name) {
    return { header: "Mcp-Name", expected: params.name, actual: headers.name };
  }
  return undefined;
}

async function invokeLegacyHandler(
  ctx: ToolContext,
  method: string,
  params: Record<string, unknown>,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = await createMcpServer(ctx);
  const protocol = (server as unknown as {
    server?: { _requestHandlers?: Map<string, LegacyRequestHandler> };
  }).server;
  const handler = protocol?._requestHandlers?.get(method);
  if (!handler) throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  return await handler({ method, params }, extra);
}

export async function dispatchModernMcpRequest(
  ctx: ToolContext,
  body: unknown,
  serverInfo: McpServerIdentity,
  headers?: ModernMcpHttpHeaders,
): Promise<ModernMcpDispatchResult> {
  if (!isRecord(body)) {
    return { status: 200, response: jsonRpcError(null, -32600, "Invalid Request") };
  }

  const request = body as JsonRpcRequest;
  const method = typeof request.method === "string" ? request.method : undefined;
  const notification = !Object.prototype.hasOwnProperty.call(request, "id");
  if (request.jsonrpc !== "2.0" || !method) {
    return { status: 200, response: jsonRpcError(request.id, -32600, "Invalid Request") };
  }

  const envelopeError = invalidEnvelopeReason(body, headers);
  if (envelopeError) {
    return { status: 200, response: jsonRpcError(request.id, -32602, "Invalid params", { reason: envelopeError }) };
  }

  const params = request.params as Record<string, unknown>;
  const requestedVersion = modernProtocolVersion(body) ?? headers?.protocolVersion;
  if (requestedVersion !== MCP_MODERN_PROTOCOL_VERSION) {
    return {
      status: 200,
      response: jsonRpcError(request.id, -32022, "Unsupported protocol version", {
        supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
      }),
    };
  }

  const mismatch = headerMismatch(method, params, requestedVersion, headers);
  if (mismatch) {
    return {
      status: 400,
      response: jsonRpcError(request.id, -32020, "Header mismatch", { header: mismatch.header }),
    };
  }

  if (notification) return { status: 202 };
  if (method === "server/discover") {
    let schemaRevision: string | undefined;
    try {
      const toolList = await invokeLegacyHandler(ctx, "tools/list", {}, { _meta: modernRequestMeta(body) ?? {} });
      if (typeof toolList.schemaRevision === "string") schemaRevision = toolList.schemaRevision;
    } catch {
      // Discovery remains usable even if schema enumeration unexpectedly fails;
      // the client can still revalidate with a direct tools/list call.
    }
    return {
      status: 200,
      response: jsonRpcResult(request.id, createMcpDiscoveryResult(serverInfo, schemaRevision)),
    };
  }
  if (method !== "tools/list" && method !== "tools/call") {
    return { status: 200, response: jsonRpcError(request.id, -32601, "Method not found") };
  }

  try {
    const result = await invokeLegacyHandler(ctx, method, params, {
      _meta: modernRequestMeta(body) ?? {},
    });
    if (method === "tools/list") {
      const currentRevision = typeof result.schemaRevision === "string" ? result.schemaRevision : undefined;
      const clientRevision = modernRequestMeta(body)?.[MCP_SCHEMA_REVISION_META_KEY];
      const staleClientRevision = typeof clientRevision === "string"
        && currentRevision !== undefined
        && clientRevision !== currentRevision;
      result.schemaExpired = staleClientRevision;
      result.schemaMustRevalidate = true;
      result._meta = {
        ...(isRecord(result._meta) ? result._meta : {}),
        [MCP_SCHEMA_EXPIRED_META_KEY]: staleClientRevision,
        [MCP_SCHEMA_REVALIDATE_META_KEY]: true,
      };
    }
    return { status: 200, response: jsonRpcResult(request.id, decorateModernResult(method, result, serverInfo)) };
  } catch (error) {
    const boundary = toRemoteBoundaryError(error);
    const diagnostic = await ctx.diagnostics
      ?.record({ event: "mcp.modern_error", outcome: "failure", method, errorCode: boundary.code })
      .catch(() => undefined);
    return {
      status: 200,
      response: jsonRpcError(request.id, -32603, boundary.message, {
        code: boundary.code,
        ...(diagnostic?.diagnosticId ? { diagnosticId: diagnostic.diagnosticId } : {}),
      }),
    };
  }
}
