export type McpRequestKind = "request" | "notification" | "batch" | "invalid";

export interface McpRequestClassification {
  requestKind: McpRequestKind;
  jsonRpcMethod?: string;
  hasSessionHeader: boolean;
  initializeRequest: boolean;
  notification: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract only the JSON-RPC envelope fields needed for connection diagnostics.
 * Params, ids, request bodies, tool inputs, and user text are never returned.
 */
export function classifyMcpRequest(body: unknown, hasSessionHeader: boolean): McpRequestClassification {
  if (Array.isArray(body)) {
    return {
      requestKind: "batch",
      hasSessionHeader,
      initializeRequest: false,
      notification: false,
    };
  }

  if (!isRecord(body)) {
    return {
      requestKind: "invalid",
      hasSessionHeader,
      initializeRequest: false,
      notification: false,
    };
  }

  const jsonRpcMethod = typeof body.method === "string" ? body.method : undefined;
  if (!jsonRpcMethod) {
    return {
      requestKind: "invalid",
      hasSessionHeader,
      initializeRequest: false,
      notification: false,
    };
  }

  const notification = !Object.prototype.hasOwnProperty.call(body, "id");
  return {
    requestKind: notification ? "notification" : "request",
    jsonRpcMethod,
    hasSessionHeader,
    initializeRequest: jsonRpcMethod === "initialize",
    notification,
  };
}
