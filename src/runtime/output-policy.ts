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

const FINALIZATION_INSTRUCTION =
  "Final response rule: end with exactly three concise summary lines. Approval fast-path: when a protected operation returns a pending ChatGPT approval with presentApprovalWith, call that direct named presenter immediately as the very next tool call before status polling, extra commentary, or any final response. If that presenter network-fails before render, retry only the presenter; never recreate or replay the protected operation. Use the stated direct fallback presenter only when the host catalog rejects the primary presenter. Continuation-card rule: if meaningful next work remains and no approval, blocker, or error is waiting on the user, call chatgpt_widget_shell with compact=true and exactly one option whose id is 'continue' and label is '계속 진행하기', then immediately call the direct named chatgpt_widget_lab_presenter in the same turn. A shell call is incomplete until the presenter succeeds; never send the final response after creating a shell without rendering it. If the presenter network-fails, retry only the presenter and never recreate the card. After a runtime replacement, re-query the current-chat direct named mount before presenter work; if the current host mount is still stale, follow the live recovery contract rather than substituting c2ct_invoke. Do not render a continuation card when the task is complete, there is no concrete next step, or the user must first resolve an approval/blocker/error. Never use c2ct_invoke to render this card or any approval presenter.";

const QUIET_INSTRUCTION =
  "Keep tool-by-tool chatter hidden, but do not leave the user staring at a silent 'thinking' state during multi-step C2CT work. Emit one short user-visible progress heartbeat before the first substantive project operation, then only when the work changes phase (for example inspect -> edit -> verify/apply) or after roughly 20-30 seconds / 4-6 consecutive C2CT calls without visible text. Use one compact sentence such as '관련 코드 확인 중…', '수정 반영 중…', or '검증 중…'. Do not enumerate tool names or repeat tool results. Approval, blocker, and error messages remain immediately visible. " + FINALIZATION_INSTRUCTION;

const VERBOSE_INSTRUCTION =
  "Intermediate commentary is allowed when it materially helps the user follow the work. Keep it concise and avoid repeating tool results. Approval, blocker, error, and final completion messages remain visible. " + FINALIZATION_INSTRUCTION;

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
