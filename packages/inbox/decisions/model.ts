/**
 * Decision mode's queue (approval "inbox-decision-mode", direction A "Queue").
 * Pure: the queue's state lives in the window only (brief §10: no new
 * storage), built from `GET /api/inbox/decisions` and kept as the person walks
 * it. Picks go through the existing picks route and wait as drafts; nothing
 * sends by itself (the owner, 2026-11-24). The person's Send sends what is
 * answered through the existing reply route, one reply per agent session per
 * thread (`sendTargetsOf`); what is not answered stays open.
 */
import type { InboxDecision, InboxListRow, InboxMessageWire, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { readInboxQuestionKind, inboxAgentName } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { INBOX_STOPPED_REPLY_TEXT } from '@plannotator/core/inbox-delivery-line';
import { sendTargetsOf, type SendTarget } from '../sendTargets';
import { plainLabel } from '../folding';

/** Why a decision left the projection while the queue held it. */
export type DecisionGone = 'sent' | 'replaced' | 'closed';

export interface QueueState {
  /** Every decision this sitting has met, in queue order (new ones join at the end). */
  order: string[];
  /** The last known copy of each. */
  cache: Map<string, InboxDecision>;
  /** The ones that left the projection, and why. */
  gone: Map<string, DecisionGone>;
  /** Put off with Later: walked once everything else is handled. */
  later: Set<string>;
  /** The card on screen; null on the end screen. */
  current: string | null;
}

export function emptyQueue(): QueueState {
  return { order: [], cache: new Map(), gone: new Map(), later: new Set(), current: null };
}

/**
 * The queue's scope: one thread's decisions, in the projection's order
 * (thread only, owner 2026-10-27). The queue and its send groups are
 * unchanged: a group is already one session in one thread.
 */
export function threadDecisions(decisions: readonly InboxDecision[], threadId: string): InboxDecision[] {
  return decisions.filter((decision) => decision.thread.id === threadId);
}

/** The send group: one reply per agent session per thread (server's `inboxDecisionGroupKey`). */
export function groupKeyOf(decision: Pick<InboxDecision, 'session' | 'thread'>): string {
  return `${decision.session.key}\u0001${decision.thread.id}`;
}

/** An agent message's session key, as the projection writes it (`s:<host>\0<session>`, or `m:<message id>`). */
export function sessionKeyOfMessage(message: InboxMessageWire): string {
  if (message.author.kind !== 'agent' || !message.author.session) return `m:${message.id}`;
  return `s:${message.author.host ?? ''}\u0000${message.author.session}`;
}

/** An action item (its Done and Can't do it go through the actions route, not a reply). */
export function isActionDecision(decision: InboxDecision): boolean {
  return readInboxQuestionKind(decision.question.kind) === 'action';
}

/** Handled: answered (picked, skipped), marked done, or no longer waiting at all. */
export function isHandled(state: QueueState, id: string): boolean {
  if (state.gone.has(id)) return true;
  const decision = state.cache.get(id);
  return decision !== undefined && decision.question.state !== 'open';
}

/**
 * Fold a fresh projection into the queue: copies refreshed, new decisions
 * appended in the server's order (the queue never reorders under the
 * person), and the ones that left marked gone. `sent`: the decisions this
 * sitting's replies carried, so one that left with its reply reads as sent
 * (and one answered elsewhere, in its thread, reads as closed).
 */
export function mergeDecisions(
  state: QueueState,
  decisions: readonly InboxDecision[],
  sent: ReadonlySet<string> = new Set(),
  /** Decisions with a pick on its way: the copy on screen is newer than any read that crossed it. */
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

/** The decision a replaced one gives way to (its `superseded_by`), when the queue knows it. */
export function replacementOf(question: Pick<InboxQuestion, 'superseded_by'>): string | null {
  const by = question.superseded_by;
  return by && by.key ? `${by.message_id}/${by.key}` : null;
}

/**
 * A question line said the agent replaced or withdrew one of the queue's
 * decisions: it is marked replaced, and its replacement (once the projection
 * brings it) takes its place in the order, right after it.
 */
export function markReplaced(state: QueueState, question: InboxQuestion): QueueState {
  const id = `${question.message_id}/${question.key}`;
  if (!state.order.includes(id)) return state;
  const gone = new Map(state.gone).set(id, 'replaced');
  const cache = new Map(state.cache);
  const old = cache.get(id);
  if (old) cache.set(id, { ...old, question: { ...old.question, ...question } });
  return { ...state, gone, cache, later: new Set([...state.later].filter((l) => l !== id)) };
}

/** Put a replacement right after the decision it replaces (it may have joined at the end). */
export function placeAfter(state: QueueState, id: string, after: string): QueueState {
  if (!state.order.includes(id) || !state.order.includes(after) || id === after) return state;
  const order = state.order.filter((o) => o !== id);
  order.splice(order.indexOf(after) + 1, 0, id);
  return { ...state, order };
}

/**
 * The next card: the first decision after `from` that waits and is not put
 * off, then from the top, then the ones put off with Later; null when
 * nothing waits (the end screen).
 */
export function nextId(state: QueueState, from: string | null): string | null {
  const waiting = (id: string) => !isHandled(state, id);
  const start = from === null ? -1 : state.order.indexOf(from);
  const after = state.order.slice(start + 1).concat(state.order.slice(0, start + 1));
  return after.find((id) => waiting(id) && !state.later.has(id)) ?? after.find((id) => waiting(id)) ?? null;
}

/** Previous: the card before this one in the queue, handled or not, that is still a decision (not replaced or closed). */
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

/** Later: the decision moves to the end of the queue, and the next card shows. */
export function putOff(state: QueueState, id: string): QueueState {
  const order = [...state.order.filter((o) => o !== id), id];
  const later = new Set(state.later).add(id);
  const next = { ...state, order, later };
  return { ...next, current: nextId(next, id) };
}

/** Decisions still waiting (the "N left" in the head). */
export function leftCount(state: QueueState): number {
  return state.order.filter((id) => !isHandled(state, id)).length;
}

/** The decisions of one send group, in queue order. */
export function groupIds(state: QueueState, key: string): string[] {
  return state.order.filter((id) => {
    const decision = state.cache.get(id);
    return decision !== undefined && groupKeyOf(decision) === key;
  });
}

/**
 * The answers of a group no reply of this sitting carried yet: picked
 * questions, and action items whose Done or Can't do it waits in the thread's
 * draft, still in the queue. `carried`: the decisions this sitting's replies
 * already took.
 */
export function freshPicks(state: QueueState, key: string, carried: ReadonlySet<string> = new Set()): string[] {
  return groupIds(state, key).filter((id) => !state.gone.has(id) && !carried.has(id) && state.cache.get(id)!.question.state === 'picked');
}

/**
 * Whether a group's reply can go: every decision in it is handled (none put
 * off with Later and still open), and at least one answer there no reply
 * carried yet (a follow-up question answered after the group's first reply
 * makes it ready again).
 */
export function groupReady(state: QueueState, key: string, carried: ReadonlySet<string> = new Set()): boolean {
  const ids = groupIds(state, key);
  if (ids.length === 0) return false;
  if (!ids.every((id) => isHandled(state, id))) return false;
  return freshPicks(state, key, carried).length > 0;
}

/** Some of a group answered, the rest not: closing then asks "Send what you answered / Keep as a draft". */
export function groupHalfAnswered(state: QueueState, key: string, carried: ReadonlySet<string> = new Set()): boolean {
  return freshPicks(state, key, carried).length > 0 && !groupReady(state, key, carried);
}

/** Every send group the queue has met, in queue order. */
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

/**
 * The replies a group's Send makes: the thread's own Send targets
 * (`sendTargetsOf`, one per session; approval "inbox-explicit-skip"), kept to
 * this group's session and to the ones that carry an answer. The session's
 * action items whose Done or Can't do it waits in the thread's draft ride
 * along (`actions`), as picks do, and alone make a reply too (decision mode
 * stages them as the thread does). Words, files and comments wait for the
 * thread's own Send.
 */
export function groupSendTargets(thread: InboxThread, sessionKey: string): SendTarget[] {
  return sendTargetsOf(thread).filter((t) => sessionKeyOfMessage(t.message) === sessionKey && (t.questions.length > 0 || t.skip.length > 0 || t.actions.length > 0));
}

// ─────────────────────────────── Chips ───────────────────────────────

/** Where a group's reply is. */
export type GroupSend =
  | { kind: 'waiting' }
  /** The thread holds a reply draft (or comments waiting for its Send): the reply goes from the thread, never from here. */
  | { kind: 'draft' }
  | { kind: 'sending' }
  | { kind: 'sent'; at: string }
  /** `sent` of `of`: a group whose replies (one per message) went in part, the rest not. */
  | { kind: 'failed'; error: string; sent?: number; of?: number };

/**
 * Whether a batch of records can have changed the decisions a window draws: it touched a thread whose decisions are
 * drawn (`watched`), or a record named no thread. Any other batch leaves `GET /api/inbox/decisions` unread.
 */
export function batchTouches(records: { any: boolean; threads: ReadonlySet<string>; applied: ReadonlySet<string>; own: ReadonlySet<string> }, watched: ReadonlySet<string>): boolean {
  if (records.any) return true;
  return [records.threads, records.applied, records.own].some((ids) => [...ids].some((id) => watched.has(id)));
}

/** What a failed Send's chip says: "Not sent", or how much went when part of it did. */
export function failedWords(send: { sent?: number; of?: number }): string {
  return send.sent && send.of ? `${send.sent} of ${send.of} replies sent` : 'Not sent';
}

/** After a Send: Delivered, then working, then Replied (brief §4), from the list row and the connection. */
export type AfterSend = 'sending' | 'stopped' | 'queued' | 'saved' | 'undelivered' | 'delivered' | 'working' | 'replied';

/**
 * Where a sent reply is, from the row's own delivery (the same rule the
 * thread's delivery line runs): Queued for a busy agent, Saved for one that
 * only reads the thread, Delivered (or read), then Working while the agent's
 * connection says it is busy, then Replied once the agent wrote again.
 */
export function afterSendOf(row: InboxListRow | undefined, sentAt: string, busy: boolean | null): AfterSend {
  if (row && row.last_author === 'agent' && row.last_agent_at !== null && row.last_agent_at !== undefined && row.last_agent_at > sentAt) return 'replied';
  const state = row?.delivery?.state;
  const delivered = state === 'delivered' || (row?.sent?.checked_at ?? null) !== null;
  if (delivered) return busy ? 'working' : 'delivered';
  // Claude Code holds it until the person types in that session (approval "inbox-stopped-reply"): Stopped, not Queued.
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

/** A session key as an attribute value (the key holds a NUL between host and session). */
export function chipDomKey(key: string): string {
  return key.replace('\u0000', ':');
}

/** One chip of the progress strip: an agent session, a dot per decision. */
export interface SessionChip {
  key: string;
  host: string | null;
  name: string;
  /** The project, or the projects, its decisions are in. */
  label: string;
  dots: { id: string; state: 'done' | 'current' | 'open' | 'later' }[];
  groups: string[];
}

export function sessionChips(state: QueueState): SessionChip[] {
  const chips = new Map<string, SessionChip>();
  /** Each chip's projects, by whole name. */
  const projectNames = new Map<string, string[]>();
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
    // Each project once, compared whole: a project's own name may hold " · " (a disambiguated name).
    const names = projectNames.get(key) ?? [];
    if (!names.includes(decision.thread.project.name)) {
      names.push(decision.thread.project.name);
      projectNames.set(key, names);
      chip.label = names.join(' · ');
    }
    const group = groupKeyOf(decision);
    if (!chip.groups.includes(group)) chip.groups.push(group);
    chip.dots.push({ id, state: id === state.current ? 'current' : isHandled(state, id) ? 'done' : state.later.has(id) ? 'later' : 'open' });
    chips.set(key, chip);
  }
  // Two sessions of one agent would read the same: the first keeps the name, the later ones say
  // "(another session)", then "(another session 3)", as the reply route's tags name them (tags.ts).
  const seen = new Map<string, number>();
  return [...chips.values()].map((chip) => {
    const count = (seen.get(chip.name) ?? 0) + 1;
    seen.set(chip.name, count);
    if (count === 1) return chip;
    return { ...chip, name: count === 2 ? `${chip.name} (another session)` : `${chip.name} (another session ${count})` };
  });
}

// ─────────────────────────────── Answers ───────────────────────────────

/** The answers a tap or typed words make, shared with every client (core inbox-answers). */
export { baseAnswer, choiceAnswer, otherAnswer, skipAnswer, textAnswer } from '@plannotator/core/inbox-answers';

/** The answer in the person's words, for the stamp, the live region and the review: "Retry with the same key", "Skipped". */
export function answerWords(answer: QuestionAnswer | null): string {
  if (!answer) return 'No answer';
  if (answer.skipped) return 'Skipped';
  // A picked label as its plain words (`plainLabel`): "15% off", not its markdown.
  const parts = answer.selected.map(plainLabel);
  if (answer.other?.trim()) parts.push(answer.other.trim());
  if (answer.text?.trim()) parts.push(answer.text.trim());
  const words = parts.join(', ') || (answer.note ? 'A note' : 'No answer');
  return words.length > 120 ? `${words.slice(0, 119)}…` : words;
}

/** The head's line: "5 of 16 · 6 agents waiting". */
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
