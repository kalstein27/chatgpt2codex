import { randomUUID } from "node:crypto";
import { DomainError, ErrorCode } from "../types.js";

const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_CARDS = 128;
export const CHATGPT_WIDGET_SHELL_COMPAT_PREFIX = "__c2ct_widget_shell_choice_v1__|";

export interface ChatGptWidgetChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export interface ChatGptWidgetChoiceCard {
  kind: "choice";
  cardId: string;
  title: string;
  prompt: string;
  options: ChatGptWidgetChoiceOption[];
  createdAt: number;
  expiresAt: number;
  status: "pending" | "resolved";
}

export interface ChatGptWidgetChoiceResult {
  receiptId: string;
  cardId: string;
  choiceId: string;
  choiceLabel: string;
  resolvedAt: number;
}

export function decodeChatGptWidgetChoiceTransport(payload: string): { cardId: string; choiceId: string } | undefined {
  if (!payload.startsWith(CHATGPT_WIDGET_SHELL_COMPAT_PREFIX) || payload.length > 128) return undefined;
  const parts = payload.slice(CHATGPT_WIDGET_SHELL_COMPAT_PREFIX.length).split("|");
  if (parts.length !== 2) return undefined;
  const cardId = parts[0];
  const choiceId = parts[1];
  if (!cardId || !choiceId) return undefined;
  if (!/^wcc_[0-9a-fA-F-]{36}$/u.test(cardId)) return undefined;
  if (!/^[A-Za-z0-9._:-]{1,40}$/u.test(choiceId)) return undefined;
  return { cardId, choiceId };
}

interface StoredCard extends ChatGptWidgetChoiceCard {
  sessionScope: string;
  result?: ChatGptWidgetChoiceResult;
}

const cards = new Map<string, StoredCard>();
const currentCardBySession = new Map<string, string>();
const receiptToCard = new Map<string, string>();

function invalid(message: string): DomainError {
  return new DomainError(ErrorCode.INVALID_ARGUMENT, message);
}

function forbidden(message: string): DomainError {
  return new DomainError(ErrorCode.PERMISSION_DENIED, message);
}

function publicCard(card: StoredCard): ChatGptWidgetChoiceCard {
  return {
    kind: "choice",
    cardId: card.cardId,
    title: card.title,
    prompt: card.prompt,
    options: card.options.map((option) => ({ ...option })),
    createdAt: card.createdAt,
    expiresAt: card.expiresAt,
    status: card.status,
  };
}

function prune(now: number): void {
  for (const [cardId, card] of cards) {
    if (card.expiresAt >= now) continue;
    cards.delete(cardId);
    if (currentCardBySession.get(card.sessionScope) === cardId) currentCardBySession.delete(card.sessionScope);
    if (card.result) receiptToCard.delete(card.result.receiptId);
  }
  while (cards.size > MAX_CARDS) {
    const first = cards.entries().next().value as [string, StoredCard] | undefined;
    if (!first) break;
    const [cardId, card] = first;
    cards.delete(cardId);
    if (currentCardBySession.get(card.sessionScope) === cardId) currentCardBySession.delete(card.sessionScope);
    if (card.result) receiptToCard.delete(card.result.receiptId);
  }
}

function validateOptions(options: ChatGptWidgetChoiceOption[]): void {
  if (options.length < 2 || options.length > 5) throw invalid("Choice cards require between 2 and 5 options");
  const seen = new Set<string>();
  for (const option of options) {
    if (!/^[A-Za-z0-9._:-]{1,40}$/u.test(option.id)) throw invalid("Choice option id has an invalid format");
    if (!option.label || option.label.length > 80) throw invalid("Choice option label must be 1-80 characters");
    if (option.description && option.description.length > 160) throw invalid("Choice option description must be at most 160 characters");
    if (seen.has(option.id)) throw invalid("Choice option ids must be unique");
    seen.add(option.id);
  }
}

export function createChatGptWidgetChoiceCard(input: {
  sessionScope: string;
  title: string;
  prompt: string;
  options: ChatGptWidgetChoiceOption[];
  now?: number;
  ttlMs?: number;
}): ChatGptWidgetChoiceCard {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!input.sessionScope) throw invalid("ChatGPT session scope is required for a widget card");
  if (!input.title || input.title.length > 80) throw invalid("Choice card title must be 1-80 characters");
  if (!input.prompt || input.prompt.length > 240) throw invalid("Choice card prompt must be 1-240 characters");
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > DEFAULT_TTL_MS) throw invalid("Choice card ttl is out of range");
  validateOptions(input.options);
  prune(now);

  const cardId = `wcc_${randomUUID()}`;
  const card: StoredCard = {
    kind: "choice",
    cardId,
    title: input.title,
    prompt: input.prompt,
    options: input.options.map((option) => ({ ...option })),
    createdAt: now,
    expiresAt: now + ttlMs,
    status: "pending",
    sessionScope: input.sessionScope,
  };
  cards.set(cardId, card);
  currentCardBySession.set(input.sessionScope, cardId);
  prune(now);
  return publicCard(card);
}

export function getCurrentChatGptWidgetChoiceCard(input: {
  sessionScope: string;
  now?: number;
}): ChatGptWidgetChoiceCard | undefined {
  const now = input.now ?? Date.now();
  prune(now);
  const cardId = currentCardBySession.get(input.sessionScope);
  if (!cardId) return undefined;
  const card = cards.get(cardId);
  if (!card || card.expiresAt < now) return undefined;
  return publicCard(card);
}

export function resolveChatGptWidgetChoice(input: {
  sessionScope: string;
  cardId: string;
  choiceId: string;
  now?: number;
}): ChatGptWidgetChoiceResult {
  const now = input.now ?? Date.now();
  prune(now);
  const card = cards.get(input.cardId);
  if (!card) throw invalid("Choice card was not found or expired");
  if (card.sessionScope !== input.sessionScope) throw forbidden("Choice card belongs to another ChatGPT session");
  const option = card.options.find((candidate) => candidate.id === input.choiceId);
  if (!option) throw invalid("Choice is not part of this card");

  if (card.result) {
    if (card.result.choiceId !== input.choiceId) throw invalid("Choice card has already been resolved with a different option");
    return { ...card.result };
  }

  const result: ChatGptWidgetChoiceResult = {
    receiptId: `wcr_${randomUUID()}`,
    cardId: card.cardId,
    choiceId: option.id,
    choiceLabel: option.label,
    resolvedAt: now,
  };
  card.status = "resolved";
  card.result = result;
  receiptToCard.set(result.receiptId, card.cardId);
  return { ...result };
}

export function getChatGptWidgetChoiceResult(input: {
  sessionScope: string;
  receiptId?: string;
  cardId?: string;
  now?: number;
}): ChatGptWidgetChoiceResult {
  const now = input.now ?? Date.now();
  prune(now);
  const receiptCardId = input.receiptId ? receiptToCard.get(input.receiptId) : undefined;
  if (input.receiptId && !receiptCardId) throw invalid("Choice result was not found or expired");
  if (input.cardId && receiptCardId && input.cardId !== receiptCardId) throw invalid("Choice result identifiers do not match");
  const cardId = input.cardId ?? receiptCardId;
  if (!cardId) throw invalid("Choice result requires a receiptId or cardId");
  const card = cards.get(cardId);
  if (!card || !card.result) throw invalid("Choice result was not found or expired");
  if (card.sessionScope !== input.sessionScope) throw forbidden("Choice result belongs to another ChatGPT session");
  if (input.receiptId && card.result.receiptId !== input.receiptId) throw invalid("Choice result identifiers do not match");
  return { ...card.result };
}
