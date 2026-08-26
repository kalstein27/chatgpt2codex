export type OutputPolicyMode = "quiet" | "verbose";

export interface OutputPolicySnapshot {
  mode: OutputPolicyMode;
  showIntermediateCommentary: boolean;
  exceptions: readonly ["approval", "blocker", "error"];
  finalSummary: "concise";
  instruction: string;
  revision: number;
  updatedAt: number;
  source: "startup-env" | "local-control" | "test";
}

const QUIET_INSTRUCTION =
  "Do not emit intermediate commentary or progress prose between C2CT tool calls. Continue with tools directly. Visible prose is allowed only when user approval/input is required, a blocker or error needs attention, or once at final completion. Keep the final summary concise.";

const VERBOSE_INSTRUCTION =
  "Intermediate commentary is allowed when it materially helps the user follow the work. Keep it concise and avoid repeating tool results. Approval, blocker, error, and final completion messages remain visible.";

let revision = 1;
let state: OutputPolicySnapshot = snapshot(
  process.env.CHATGPT2CODEX_SHOW_INTERMEDIATE_COMMENTARY === "1",
  "startup-env",
);

function snapshot(
  showIntermediateCommentary: boolean,
  source: OutputPolicySnapshot["source"],
): OutputPolicySnapshot {
  return Object.freeze({
    mode: showIntermediateCommentary ? "verbose" : "quiet",
    showIntermediateCommentary,
    exceptions: Object.freeze(["approval", "blocker", "error"] as const),
    finalSummary: "concise" as const,
    instruction: showIntermediateCommentary ? VERBOSE_INSTRUCTION : QUIET_INSTRUCTION,
    revision,
    updatedAt: Date.now(),
    source,
  });
}

export function currentOutputPolicy(): OutputPolicySnapshot {
  return state;
}

export function setOutputPolicy(
  showIntermediateCommentary: boolean,
  source: OutputPolicySnapshot["source"] = "local-control",
): OutputPolicySnapshot {
  if (state.showIntermediateCommentary === showIntermediateCommentary && state.source === source) {
    return state;
  }
  revision += 1;
  state = snapshot(showIntermediateCommentary, source);
  return state;
}
