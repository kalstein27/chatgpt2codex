import { DomainError, ErrorCode } from "../types.js";
import {
  ensureOperationAuthorized,
  type EnsureOperationApprovalInput,
  type OperationApprovalVia,
  type OperationAuthorization,
} from "./operation-approval.js";

export type ApprovalProviderId = "chatgpt-host" | "local-menu-bar";

export interface ApprovalProviderSnapshot {
  provider: ApprovalProviderId;
  available: boolean;
  trustedVia: OperationApprovalVia | null;
  hostNative: boolean;
  canAuthorizeProtectedOperations: boolean;
  integrationState: "ready" | "awaiting-trusted-host-attestation";
}

export interface ApprovalBrokerPlan {
  providerOrder: ApprovalProviderId[];
  selectedProvider: ApprovalProviderId | null;
  selectedTrustedVia: OperationApprovalVia | null;
  hostNativeApprovalAvailable: boolean;
  approvalFallbackActive: boolean;
  hostNativeApprovalIntegrationState: "ready" | "awaiting-trusted-host-attestation";
  conversationalDecisionCanAuthorize: false;
  computerUseCanAuthorize: false;
}

export interface BrokeredOperationAuthorization extends OperationAuthorization {
  approvalProvider: ApprovalProviderId;
}

const APPROVAL_PROVIDERS: Record<ApprovalProviderId, ApprovalProviderSnapshot> = {
  "chatgpt-host": {
    provider: "chatgpt-host",
    available: false,
    trustedVia: null,
    hostNative: true,
    canAuthorizeProtectedOperations: false,
    integrationState: "awaiting-trusted-host-attestation",
  },
  "local-menu-bar": {
    provider: "local-menu-bar",
    available: true,
    trustedVia: "menu-bar-ui",
    hostNative: false,
    canAuthorizeProtectedOperations: true,
    integrationState: "ready",
  },
};

export const RUNTIME_APPLY_PROVIDER_ORDER = ["chatgpt-host", "local-menu-bar"] as const;

export function approvalProviderSnapshot(provider: ApprovalProviderId): ApprovalProviderSnapshot {
  return { ...APPROVAL_PROVIDERS[provider] };
}

export function approvalBrokerPlan(
  providerOrder: readonly ApprovalProviderId[],
): ApprovalBrokerPlan {
  const selected = providerOrder
    .map((provider) => APPROVAL_PROVIDERS[provider])
    .find((provider) => provider.available && provider.trustedVia);
  return {
    providerOrder: [...providerOrder],
    selectedProvider: selected?.provider ?? null,
    selectedTrustedVia: selected?.trustedVia ?? null,
    hostNativeApprovalAvailable: APPROVAL_PROVIDERS["chatgpt-host"].available,
    approvalFallbackActive: Boolean(selected && selected.provider !== providerOrder[0]),
    hostNativeApprovalIntegrationState: APPROVAL_PROVIDERS["chatgpt-host"].integrationState,
    conversationalDecisionCanAuthorize: false,
    computerUseCanAuthorize: false,
  };
}

export function selectApprovalProvider(
  providerOrder: readonly ApprovalProviderId[],
): ApprovalProviderSnapshot {
  const plan = approvalBrokerPlan(providerOrder);
  if (plan.selectedProvider) return approvalProviderSnapshot(plan.selectedProvider);
  throw new DomainError(
    ErrorCode.NOT_IMPLEMENTED,
    "No trusted approval provider is currently available for this operation",
    { ...plan },
  );
}

export async function ensureBrokeredOperationAuthorized(
  input: EnsureOperationApprovalInput & { providerOrder: readonly ApprovalProviderId[] },
): Promise<BrokeredOperationAuthorization> {
  const plan = approvalBrokerPlan(input.providerOrder);
  const provider = selectApprovalProvider(input.providerOrder);
  try {
    const authorization = await ensureOperationAuthorized({
      ...input,
      requiredApprovalVia: provider.trustedVia ?? undefined,
    });
    return { ...authorization, approvalProvider: provider.provider };
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCode.APPROVAL_REQUIRED) {
      throw new DomainError(error.code, error.message, {
        ...(error.details ?? {}),
        ...plan,
        approvalProvider: provider.provider,
      });
    }
    throw error;
  }
}