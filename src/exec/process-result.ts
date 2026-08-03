export type TransportStatus = "SUCCESS";

export type CommandStatus =
  | "SUCCESS"
  | "NONZERO_EXIT"
  | "SPAWN_FAILED"
  | "TIMEOUT";

export type CleanupStatus = "NOT_REQUIRED" | "COMPLETED" | "FAILED";

export type ArtifactStatus = "NOT_REQUIRED" | "CREATED" | "TRUNCATED" | "FAILED";

export interface CapturedProcessOutput {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  artifactTruncated: boolean;
}

export interface ProcessExecutionResult {
  commandStatus: CommandStatus;
  exitCode: number | null;
  terminationSignal: NodeJS.Signals | null;
  cleanupStatus: CleanupStatus;
  stdoutSummary: string;
  stderrSummary: string;
  durationMs: number;
  outputTruncated: boolean;
  capturedOutput?: CapturedProcessOutput;
}

export interface DomainResultContract {
  successExitCodes?: number[];
  successStatus?: string;
  failureStatus?: string;
  timeoutStatus?: string;
  spawnFailedStatus?: string;
}

export interface DomainStatusResolution {
  domainStatus: string | null;
  domainStatusSource: "caller-contract" | "not-provided";
}

export function commandStatusFromExit(
  exitCode: number | null,
  spawnFailed = false,
): CommandStatus {
  if (spawnFailed) return "SPAWN_FAILED";
  return exitCode === 0 ? "SUCCESS" : "NONZERO_EXIT";
}

export function resolveDomainStatus(
  result: Pick<ProcessExecutionResult, "commandStatus" | "exitCode">,
  contract?: DomainResultContract,
): DomainStatusResolution {
  if (!contract) {
    return { domainStatus: null, domainStatusSource: "not-provided" };
  }

  if (result.commandStatus === "TIMEOUT") {
    return {
      domainStatus: contract.timeoutStatus ?? contract.failureStatus ?? "TIMEOUT",
      domainStatusSource: "caller-contract",
    };
  }
  if (result.commandStatus === "SPAWN_FAILED") {
    return {
      domainStatus: contract.spawnFailedStatus ?? contract.failureStatus ?? "SPAWN_FAILED",
      domainStatusSource: "caller-contract",
    };
  }

  const successExitCodes = contract.successExitCodes?.length
    ? [...new Set(contract.successExitCodes)]
    : [0];
  const domainSuccess = result.exitCode !== null && successExitCodes.includes(result.exitCode);
  return {
    domainStatus: domainSuccess
      ? (contract.successStatus ?? "SUCCESS")
      : (contract.failureStatus ?? "FAILURE"),
    domainStatusSource: "caller-contract",
  };
}

export function artifactStatusFor(input: {
  outputTruncated: boolean;
  artifactCreated: boolean;
  artifactTruncated?: boolean;
  artifactFailed?: boolean;
}): ArtifactStatus {
  if (input.artifactFailed) return "FAILED";
  if (!input.outputTruncated) return "NOT_REQUIRED";
  if (!input.artifactCreated) return "FAILED";
  return input.artifactTruncated ? "TRUNCATED" : "CREATED";
}
