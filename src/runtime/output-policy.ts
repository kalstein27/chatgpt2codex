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
  "Keep tool-by-tool chatter hidden, but do not leave the user staring at a silent 'thinking' state during multi-step C2CT work. Emit one short user-visible progress heartbeat before the first substantive project operation, then only when the work changes phase (for example inspect -> edit -> verify/apply) or after roughly 20-30 seconds / 4-6 consecutive C2CT calls without visible text. Use one compact sentence such as '관련 코드 확인 중…', '수정 반영 중…', or '검증 중…'. Do not enumerate tool names or repeat tool results. Approval, blocker, and error messages remain immediately visible. Keep the final summary concise.";

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
