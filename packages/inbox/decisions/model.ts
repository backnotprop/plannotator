import type { InboxDecision, InboxListRow, InboxMessageWire, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { readInboxQuestionKind, inboxAgentName } from '@plannotator/core/inbox-types';
import { capQuestionPrompt, type QuestionAnswer } from '@plannotator/core/question-block';
import { INBOX_STOPPED_REPLY_TEXT } from '@plannotator/core/inbox-delivery-line';
import { sendTargetsOf, type SendTarget } from '../sendTargets';
import { plainLabel } from '../folding';

export type DecisionGone = 'sent' | 'replaced' | 'closed';

export interface QueueState {
  order: string[];
  cache: Map<string, InboxDecision>;
  gone: Map<string, DecisionGone>;
  later: Set<string>;
  current: string | null;
}

export function emptyQueue(): QueueState {
  return { order: [], cache: new Map(), gone: new Map(), later: new Set(), current: null };
}

export function threadDecisions(decisions: readonly InboxDecision[], threadId: string): InboxDecision[] {
  return decisions.filter((decision) => decision.thread.id === threadId);
}

export function groupKeyOf(decision: Pick<InboxDecision, 'session' | 'thread'>): string {
  return `${decision.session.key}\u0001${decision.thread.id}`;
}

export function sessionKeyOfMessage(message: InboxMessageWire): string {
  if (message.author.kind !== 'agent' || !message.author.session) return `m:${message.id}`;
  return `s:${message.author.host ?? ''}\u0000${message.author.session}`;
}

export function isActionDecision(decision: InboxDecision): boolean {
  return readInboxQuestionKind(decision.question.kind) === 'action';
}

export function isHandled(state: QueueState, id: string): boolean {
  if (state.gone.has(id)) return true;
  const decision = state.cache.get(id);
  return decision !== undefined && decision.question.state !== 'open';
}

export function mergeDecisions(
  state: QueueState,
  decisions: readonly InboxDecision[],
  sent: ReadonlySet<string> = new Set(),
  pending: ReadonlySet<string> = new Set(),
): QueueState {
  const cache = new Map(state.cache);
  const order = [...state.order];
  const known = new Set(order);
  const fresh = new Set<string>();
  for (const decision of decisions) {
    fresh.add(decision.id);
    const held = cache.get(decision.id);
    // A read older than what the window already saved (a lower revision, or a pick still on its way) never undoes it.
    const stale = held !== undefined && (pending.has(decision.id) || held.question.revision > decision.question.revision);
    cache.set(decision.id, stale ? { ...decision, question: held.question } : decision);
    if (!known.has(decision.id)) {
      order.push(decision.id);
      known.add(decision.id);
    }
  }
  const gone = new Map(state.gone);
  for (const id of order) {
    if (fresh.has(id)) {
      gone.delete(id);
      continue;
    }
    if (gone.has(id)) continue;
    gone.set(id, sent.has(id) ? 'sent' : 'closed');
  }
  const later = new Set([...state.later].filter((id) => fresh.has(id) && cache.get(id)?.question.state === 'open'));
  const next: QueueState = { order, cache, gone, later, current: state.current };
  if (next.current === null || !known.has(next.current)) next.current = nextId(next, null);
  return next;
}

export function replacementOf(question: Pick<InboxQuestion, 'superseded_by'>): string | null {
  const by = question.superseded_by;
  return by && by.key ? `${by.message_id}/${by.key}` : null;
}

export function markReplaced(state: QueueState, question: InboxQuestion): QueueState {
  const id = `${question.message_id}/${question.key}`;
  if (!state.order.includes(id)) return state;
  const gone = new Map(state.gone).set(id, 'replaced');
  const cache = new Map(state.cache);
  const old = cache.get(id);
  if (old) cache.set(id, { ...old, question: { ...old.question, ...question } });
  return { ...state, gone, cache, later: new Set([...state.later].filter((l) => l !== id)) };
}

export function placeAfter(state: QueueState, id: string, after: string): QueueState {
  if (!state.order.includes(id) || !state.order.includes(after) || id === after) return state;
  const order = state.order.filter((o) => o !== id);
  order.splice(order.indexOf(after) + 1, 0, id);
  return { ...state, order };
}

export function nextId(state: QueueState, from: string | null): string | null {
  const waiting = (id: string) => !isHandled(state, id);
  const start = from === null ? -1 : state.order.indexOf(from);
  const after = state.order.slice(start + 1).concat(state.order.slice(0, start + 1));
  return after.find((id) => waiting(id) && !state.later.has(id)) ?? after.find((id) => waiting(id)) ?? null;
}

export function previousId(state: QueueState, from: string | null): string | null {
  const index = from === null ? state.order.length : state.order.indexOf(from);
  for (let i = index - 1; i >= 0; i -= 1) {
    const id = state.order[i]!;
    const reason = state.gone.get(id);
    if (reason === 'replaced' || reason === 'closed') continue;
    return id;
  }
  return null;
}

export function putOff(state: QueueState, id: string): QueueState {
  const order = [...state.order.filter((o) => o !== id), id];
  const later = new Set(state.later).add(id);
  const next = { ...state, order, later };
  return { ...next, current: nextId(next, id) };
}

export function leftCount(state: QueueState): number {
  return state.order.filter((id) => !isHandled(state, id)).length;
}

export function groupIds(state: QueueState, key: string): string[] {
  return state.order.filter((id) => {
    const decision = state.cache.get(id);
    return decision !== undefined && groupKeyOf(decision) === key;
  });
}

export function freshPicks(state: QueueState, key: string, carried: ReadonlySet<string> = new Set()): string[] {
  return groupIds(state, key).filter((id) => {
    const decision = state.cache.get(id)!;
    return !state.gone.has(id) && !carried.has(id) && !isActionDecision(decision) && decision.question.state === 'picked';
  });
}

export function groupReady(state: QueueState, key: string, carried: ReadonlySet<string> = new Set()): boolean {
  const ids = groupIds(state, key);
  if (ids.length === 0) return false;
  if (!ids.every((id) => isHandled(state, id))) return false;
  return freshPicks(state, key, carried).length > 0;
}

export function groupHalfAnswered(state: QueueState, key: string, carried: ReadonlySet<string> = new Set()): boolean {
  return freshPicks(state, key, carried).length > 0 && !groupReady(state, key, carried);
}

export const DECISION_HOLD_MS = 5000;

export function startHold(now: number, open: boolean): GroupSend {
  return { kind: 'hold', until: now + DECISION_HOLD_MS, paused: open ? null : DECISION_HOLD_MS };
}

export interface GroupSendFacts {
  ready: boolean;
  touched: boolean;
  draft: boolean;
  open: boolean;
  now: number;
}

export function nextGroupSend(state: GroupSend, facts: GroupSendFacts): GroupSend {
  if (state.kind === 'sending') return state;
  if (state.kind === 'failed') return facts.ready ? state : { kind: 'waiting' };
  if (state.kind === 'sent') return facts.ready ? nextGroupSend({ kind: 'waiting' }, facts) : state;
  if (!facts.ready) return state.kind === 'waiting' ? state : { kind: 'waiting' };
  if (facts.draft) return state.kind === 'draft' ? state : { kind: 'draft', held: state.kind === 'held' && state.by === 'person' };
  if (state.kind === 'draft' && state.held) return { kind: 'held', by: 'person' };
  if (state.kind === 'hold') return facts.touched ? state : { kind: 'held', by: 'untouched' };
  if (state.kind === 'held' && state.by === 'person') return state;
  if (!facts.touched) return state.kind === 'held' ? state : { kind: 'held', by: 'untouched' };
  return startHold(facts.now, facts.open);
}

export function pauseHold(state: GroupSend, open: boolean, now: number): GroupSend {
  if (state.kind !== 'hold') return state;
  if (!open && state.paused === null) return { ...state, paused: Math.max(0, state.until - now) };
  if (open && state.paused !== null) return { kind: 'hold', until: now + state.paused, paused: null };
  return state;
}

export function restartHold(state: GroupSend, now: number, open: boolean): GroupSend {
  return state.kind === 'hold' ? startHold(now, open) : state;
}

export function holdSeconds(state: Extract<GroupSend, { kind: 'hold' }>, now: number): number {
  const left = state.paused ?? state.until - now;
  return Math.min(DECISION_HOLD_MS / 1000, Math.max(1, Math.ceil(left / 1000)));
}

export function groupKeys(state: QueueState): string[] {
  const out: string[] = [];
  for (const id of state.order) {
    const decision = state.cache.get(id);
    if (!decision) continue;
    const key = groupKeyOf(decision);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

export function groupSendTargets(thread: InboxThread, sessionKey: string): SendTarget[] {
  return sendTargetsOf(thread).filter((t) => sessionKeyOfMessage(t.message) === sessionKey && (t.questions.length > 0 || t.skip.length > 0));
}

export type GroupSend =
  | { kind: 'waiting' }
  | { kind: 'hold'; until: number; paused: number | null }
  | { kind: 'held'; by: 'person' | 'untouched' }
  | { kind: 'draft'; held: boolean }
  | { kind: 'sending' }
  | { kind: 'sent'; at: string }
  | { kind: 'failed'; error: string };

export type AfterSend = 'sending' | 'stopped' | 'queued' | 'saved' | 'undelivered' | 'delivered' | 'working' | 'replied';

export function afterSendOf(row: InboxListRow | undefined, sentAt: string, busy: boolean | null): AfterSend {
  if (row && row.last_author === 'agent' && row.last_agent_at !== null && row.last_agent_at !== undefined && row.last_agent_at > sentAt) return 'replied';
  const state = row?.delivery?.state;
  const delivered = state === 'delivered' || (row?.sent?.checked_at ?? null) !== null;
  if (delivered) return busy ? 'working' : 'delivered';
  // Claude Code holds it until the person types in that session: Stopped, not Queued.
  if (row?.delivery?.reason === 'stopped') return 'stopped';
  if (state === 'queued' || state === 'saved' || state === 'undelivered') return state;
  return 'sending';
}

export const AFTER_SEND_ORDER: readonly AfterSend[] = ['sending', 'undelivered', 'stopped', 'queued', 'saved', 'delivered', 'working', 'replied'];

export const AFTER_SEND_WORDS: Record<AfterSend, string> = {
  sending: 'Sending',
  stopped: INBOX_STOPPED_REPLY_TEXT,
  queued: 'Queued',
  saved: 'Saved',
  undelivered: 'Not delivered',
  delivered: 'Delivered',
  working: 'Working',
  replied: 'Replied',
};

export function chipDomKey(key: string): string {
  return key.replace('\u0000', ':');
}

export interface SessionChip {
  key: string;
  host: string | null;
  name: string;
  label: string;
  dots: { id: string; state: 'done' | 'current' | 'open' | 'later' }[];
  groups: string[];
}

export function sessionChips(state: QueueState): SessionChip[] {
  const chips = new Map<string, SessionChip>();
  for (const id of state.order) {
    const decision = state.cache.get(id);
    if (!decision) continue;
    const reason = state.gone.get(id);
    if (reason === 'replaced' || reason === 'closed') continue;
    const key = decision.session.key;
    const chip =
      chips.get(key) ??
      ({
        key,
        host: decision.session.host,
        name: inboxAgentName(decision.message.author),
        label: decision.thread.project.name,
        dots: [],
        groups: [],
      } satisfies SessionChip);
    if (!chip.label.split(' · ').includes(decision.thread.project.name)) chip.label = `${chip.label} · ${decision.thread.project.name}`;
    const group = groupKeyOf(decision);
    if (!chip.groups.includes(group)) chip.groups.push(group);
    chip.dots.push({ id, state: id === state.current ? 'current' : isHandled(state, id) ? 'done' : state.later.has(id) ? 'later' : 'open' });
    chips.set(key, chip);
  }
  const seen = new Map<string, number>();
  return [...chips.values()].map((chip) => {
    const count = (seen.get(chip.name) ?? 0) + 1;
    seen.set(chip.name, count);
    if (count === 1) return chip;
    return { ...chip, name: count === 2 ? `${chip.name} (another session)` : `${chip.name} (another session ${count})` };
  });
}

function answerKind(question: InboxQuestion): QuestionAnswer['kind'] {
  const kind = readInboxQuestionKind(question.kind);
  return kind === 'multi' || kind === 'text' ? kind : 'single';
}

export function baseAnswer(question: InboxQuestion): QuestionAnswer {
  return question.answer ?? { v: 1, key: question.key, kind: answerKind(question), prompt: capQuestionPrompt(question.prompt), selected: [] };
}

export function choiceAnswer(question: InboxQuestion, selected: readonly string[], note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { other: _o, text: _t, skipped: _s, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [...selected], ...(note.trim() ? { note: note.trim() } : {}) };
}

export function otherAnswer(question: InboxQuestion, other: string, note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { text: _t, skipped: _s, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [], other: other.trim(), ...(note.trim() ? { note: note.trim() } : {}) };
}

export function textAnswer(question: InboxQuestion, text: string, note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { other: _o, skipped: _s, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [], text: text.trim(), ...(note.trim() ? { note: note.trim() } : {}) };
}

export function skipAnswer(question: InboxQuestion, note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { other: _o, text: _t, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [], skipped: true, ...(note.trim() ? { note: note.trim() } : {}) };
}

export function answerWords(answer: QuestionAnswer | null): string {
  if (!answer) return 'No answer';
  if (answer.skipped) return 'Skipped';
  const parts = answer.selected.map(plainLabel);
  if (answer.other?.trim()) parts.push(answer.other.trim());
  if (answer.text?.trim()) parts.push(answer.text.trim());
  const words = parts.join(', ') || (answer.note ? 'A note' : 'No answer');
  return words.length > 120 ? `${words.slice(0, 119)}…` : words;
}

export function swipeChoices(question: InboxQuestion): [string, string] | null {
  if (readInboxQuestionKind(question.kind) !== 'single' || question.choices.length !== 2) return null;
  if (question.reversible || question.choices.some((choice) => choice.image)) return null;
  return [question.choices[0]!.label, question.choices[1]!.label];
}

export function swipeHint(choices: readonly [string, string]): string {
  return `Swipe right for ${plainLabel(choices[0])}, left for ${plainLabel(choices[1])}.`;
}

/** Every answer that chooses something asks once more on a `Reversible: no` question, the recommended one included: the grammar does not say which choice cannot be undone. */
export function answerNeedsConfirm(question: InboxQuestion, answer: QuestionAnswer): boolean {
  if (!question.reversible || answer.skipped) return false;
  return answer.selected.length > 0 || !!answer.other?.trim() || !!answer.text?.trim();
}

export const CONFIRM_LABEL_CHARS = 40;
export function confirmLabel(words: string): string {
  return words.length > CONFIRM_LABEL_CHARS ? `${words.slice(0, CONFIRM_LABEL_CHARS - 1).trimEnd()}…` : words;
}

export function headLine(state: QueueState): string {
  const live = state.order.filter((id) => {
    const reason = state.gone.get(id);
    return reason !== 'replaced' && reason !== 'closed';
  });
  const at = state.current === null ? live.length : Math.max(1, live.indexOf(state.current) + 1);
  const waiting = new Set(
    state.order.filter((id) => !isHandled(state, id)).map((id) => state.cache.get(id)?.session.key).filter((k): k is string => !!k),
  ).size;
  return `${at} of ${live.length} · ${waiting} ${waiting === 1 ? 'agent' : 'agents'} waiting`;
}
