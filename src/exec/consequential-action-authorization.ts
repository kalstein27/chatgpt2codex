import type { Lease, ToolContext } from "../types.js";
import {
  operationFingerprint,
  type OperationRisk,
  type OperationAuthorization,
} from "./operation-approval.js";

export interface ConsequentialActionAuthorization extends OperationAuthorization {
  approvalProvider: "chatgpt-host";
}

export function authorizeConsequentialGptAction(input: {
  ctx: ToolContext;
  lease: Lease;
  tool: string;
  risk: OperationRisk;
  operation: unknown;
  requestId: string;
}): ConsequentialActionAuthorization | null {
  const invocation = input.ctx.actionInvocation;
  if (!invocation ||
      invocation.surface !== "gpt-action" ||
      invocation.dedicatedRoute !== true ||
      invocation.consequential !== true ||
      invocation.operationId !== input.tool) {
    return null;
  }

  return {
    requestId: `gpt_action:${input.requestId}`,
    scope: "once",
    operationFingerprint: operationFingerprint({
      projectId: input.lease.projectId,
      projectRoot: input.lease.projectRoot,
      leaseId: input.lease.leaseId,
      tool: input.tool,
      risk: input.risk,
      operation: input.operation,
    }),
    approvalProvider: "chatgpt-host",
  };
}

export function authorizeDedicatedConsequentialAction(input: {
  ctx: ToolContext;
  lease: Lease;
  tool: string;
  risk: OperationRisk;
  operation: unknown;
  requestId: string;
}): ConsequentialActionAuthorization | null {
  const invocation = input.ctx.actionInvocation;
  if (!invocation ||
      invocation.surface !== "gpt-action" ||
      invocation.dedicatedRoute !== true ||
      invocation.consequential !== true ||
      invocation.operationId !== input.tool) {
    return null;
  }

  return {
    requestId: `gpt_action:${input.requestId}`,
    scope: "once",
    operationFingerprint: operationFingerprint({
      projectId: input.lease.projectId,
      projectRoot: input.lease.projectRoot,
      leaseId: input.lease.leaseId,
      tool: input.tool,
      risk: input.risk,
      operation: input.operation,
    }),
    approvalProvider: "chatgpt-host",
  };
}
