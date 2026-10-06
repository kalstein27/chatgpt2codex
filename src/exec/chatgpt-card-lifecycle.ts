export type ChatGptCardLifecyclePhase =
  | "unresolved"
  | "presentable"
  | "waiting-user"
  | "resolving"
  | "terminal";

export type ChatGptCardTerminalReason =
  | "allowed"
  | "denied"
  | "completed"
  | "expired"
  | "consumed"
  | "missing";

export type ChatGptCardStatusSource =
  | "server-authoritative"
  | "authoritative-local-latch"
  | "local-display-only"
  | "unknown";

export type ChatGptCardPollMode = "none" | "bounded-status-only";

export type ChatGptCardNextAction =
  | "await-state"
  | "present"
  | "wait-user"
  | "poll-status"
  | "render-terminal";

export interface ChatGptCardLifecycleState {
  phase: ChatGptCardLifecyclePhase;
  identityKey: string;
  terminalReason?: ChatGptCardTerminalReason;
  expiresAt?: number | null;
  statusSource: ChatGptCardStatusSource;
  presentationRequired: boolean;
  pollMode: ChatGptCardPollMode;
}

export interface NormalizeChatGptCardStateInput {
  identityKey: string;
  phase: Exclude<ChatGptCardLifecyclePhase, "terminal">;
  terminalReason?: ChatGptCardTerminalReason;
  expiresAt?: number | null;
  statusSource?: ChatGptCardStatusSource;
  presentationRequired?: boolean;
  pollMode?: ChatGptCardPollMode;
}

function cleanIdentity(value: string): string {
  return value.trim();
}

export function normalizeCardState(input: NormalizeChatGptCardStateInput): ChatGptCardLifecycleState {
  const identityKey = cleanIdentity(input.identityKey);
  if (!identityKey) throw new Error("Card lifecycle identityKey is required");
  const terminalReason = input.terminalReason;
  return {
    phase: terminalReason ? "terminal" : input.phase,
    identityKey,
    ...(terminalReason ? { terminalReason } : {}),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    statusSource: input.statusSource ?? "unknown",
    presentationRequired: terminalReason ? false : input.presentationRequired === true,
    pollMode: terminalReason ? "none" : (input.pollMode ?? "none"),
  };
}

export function classifyTerminalState(
  status: string | null | undefined,
  terminalStatuses: Readonly<Record<string, ChatGptCardTerminalReason>>,
): ChatGptCardTerminalReason | undefined {
  if (!status) return undefined;
  return terminalStatuses[status];
}

export function shouldMountPresenter(state: ChatGptCardLifecycleState): boolean {
  return state.phase === "presentable" && state.presentationRequired;
}

export function shouldPollStatus(state: ChatGptCardLifecycleState): boolean {
  return state.phase === "resolving" && state.pollMode === "bounded-status-only";
}

export function resolveNextCardAction(state: ChatGptCardLifecycleState): ChatGptCardNextAction {
  if (state.phase === "terminal") return "render-terminal";
  if (shouldMountPresenter(state)) return "present";
  if (state.phase === "waiting-user") return "wait-user";
  if (shouldPollStatus(state)) return "poll-status";
  return "await-state";
}

export function cardLifecycleDedupeKey(input: {
  cardKind: string;
  identity: string;
  presenterRevision?: string | null;
  resourceRevision?: string | null;
}): string {
  const parts = [
    "c2ct-card-v1",
    input.cardKind.trim(),
    input.identity.trim(),
    input.presenterRevision?.trim() ?? "",
    input.resourceRevision?.trim() ?? "",
  ];
  if (!parts[1] || !parts[2]) throw new Error("Card lifecycle dedupe key requires cardKind and identity");
  return parts.map((part) => `${part.length}:${part}`).join("|");
}
