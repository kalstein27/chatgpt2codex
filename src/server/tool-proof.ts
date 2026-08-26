import { currentOutputPolicy, type OutputPolicySnapshot } from "../runtime/output-policy.js";

export const CHATGPT2CODEX_APP_NAME = "ChatGPT To Codex";
export const CHATGPT2CODEX_TOOL_NAMESPACE = "ChatGPT_To_Codex";

export const TOOL_AVAILABILITY_GATE = {
  namespace: CHATGPT2CODEX_TOOL_NAMESPACE,
  app: CHATGPT2CODEX_APP_NAME,
  rule: "Proceed with local coding only after a current-turn chatgpt2codex MCP tool or GPT Action returns ok=true.",
  noResultMeans:
    "No local project work happened. Stop and ask the user to select/reconnect ChatGPT To Codex or refresh the Custom GPT Action schema.",
  wrongSurfaceExamples: ["image_gen", "python_user_visible", "browser-only answer"],
} as const;

export function toolCallProof(tool: string, ok: boolean): Record<string, unknown> {
  return {
    namespace: CHATGPT2CODEX_TOOL_NAMESPACE,
    app: CHATGPT2CODEX_APP_NAME,
    tool,
    ok,
    currentTurnProof: true,
    requiredBeforeCoding: true,
    proceedOnlyIfOk: true,
    noToolResultMeansNoLocalWork: true,
    instruction: ok
      ? "This chatgpt2codex tool/action result is the proof that local-tool execution is available for this turn."
      : "Do not claim local coding happened. Fix the chatgpt2codex tool/action call before proceeding.",
  };
}

export function addToolCallProof<T extends Record<string, unknown>>(
  structured: T,
  tool: string,
  ok: boolean,
): T & { chatgpt2codexToolCall: Record<string, unknown>; outputPolicy: OutputPolicySnapshot } {
  return {
    chatgpt2codexToolCall: toolCallProof(tool, ok),
    ...structured,
    outputPolicy: currentOutputPolicy(),
  };
}
