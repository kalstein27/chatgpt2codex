/**
 * Risk tiers recognized by the Two-key classifier (PRD §9.5 / §6). Ordered
 * from least to most privileged; unknown tiers are treated conservatively
 * (approval required) rather than silently allowed.
 */
const NO_APPROVAL_TIERS = new Set(["observe", "read", "verify", "write"]);
const APPROVAL_REQUIRED_TIERS = new Set(["destructive", "network", "local-file-mutation", "danger"]);

/**
 * Whether a given risk tier (e.g. "read" | "verify" | "write" | "network" |
 * "destructive" | "local-file-mutation") requires an explicit human approval gate before executing
 * (PRD §9.5 Two-key classification).
 *
 * Per PRD §9.5: `if tier in {destructive, network} and not
 * intent.approvedByHuman: return APPROVAL_REQUIRED`. `write` alone does not
 * require approval (it requires a lease that allows writes — a separate
 * check), but destructive/network/danger-tier actions always do. Unknown/
 * unrecognized tiers default to requiring approval (deny-by-default, PRD
 * §7/§11 posture).
 */
export function needsApproval(riskTier: string): boolean {
  const tier = riskTier.trim().toLowerCase();

  if (APPROVAL_REQUIRED_TIERS.has(tier)) {
    return true;
  }
  if (NO_APPROVAL_TIERS.has(tier)) {
    return false;
  }
  // Unrecognized tier: fail closed.
  return true;
}
