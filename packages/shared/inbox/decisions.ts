/**
 * Decision mode's projection (approval "inbox-decision-mode", experimental;
 * brief §7 and §10): every question and action item that waits on the person,
 * across threads, in the order the queue walks them. Pure: the store hands
 * in its records, nothing is read or written here, and no record of decision
 * mode's own exists. Picks and Sends go through the existing routes.
 *
 * The order (brief §7):
 *   - each agent session's decisions together, so its reply can go once the
 *     last of them is handled (one reply per session per thread);
 *   - inside a session, a thread at a time;
 *   - the most blocked session first: one with a Stopped question, then one
 *     holding up work, then the rest; ties by how many it stopped on, then
 *     by its oldest waiting decision;
 *   - inside a thread, Stopped first, then Holds up, then the thread's order.
 */

import { cutText, inboxUrgencyOf, type InboxUrgency } from "@plannotator/core/inbox-questions";
import type { InboxDecision } from "@plannotator/core/inbox-types";

/** A decision with the store's order facts: the message's seq and the question's position in it. */
export interface InboxDecisionCandidate {
  decision: InboxDecision;
  seq: number;
}

/** About how long a card's message excerpt is (brief §10: long bodies never ride the read). */
export const INBOX_DECISION_EXCERPT_CHARS = 280;

const BLOCK_START_RE = /^[ \t]*:::[ \t]*(?:question(?:-multi|-text)?|action)\b/m;

/**
 * The prose of a message body before its first question or action block, as
 * one line cut to about 280 characters; null when there is none. Images and
 * link targets are left out (the card draws pictures on their own).
 */
export function inboxDecisionExcerpt(body: string): string | null {
  const match = BLOCK_START_RE.exec(body);
  const prose = (match ? body.slice(0, match.index) : body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return prose ? cutText(prose, INBOX_DECISION_EXCERPT_CHARS) : null;
}

/** The urgency of one decision (core's rule, shared with the list's sections). */
export function inboxDecisionUrgency(decision: InboxDecision): InboxUrgency {
  return inboxUrgencyOf(decision.question);
}

interface Group<T> {
  key: string;
  urgency: InboxUrgency;
  stopped: number;
  holding: number;
  firstSeq: number;
  items: T[];
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string, factsOf: (item: T) => { urgency: InboxUrgency; seq: number }): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  for (const item of items) {
    const key = keyOf(item);
    const facts = factsOf(item);
    const group = groups.get(key) ?? { key, urgency: 2 as InboxUrgency, stopped: 0, holding: 0, firstSeq: Number.POSITIVE_INFINITY, items: [] };
    group.items.push(item);
    group.urgency = Math.min(group.urgency, facts.urgency) as InboxUrgency;
    if (facts.urgency === 0) group.stopped += 1;
    if (facts.urgency === 1) group.holding += 1;
    group.firstSeq = Math.min(group.firstSeq, facts.seq);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Most blocked first; then the oldest waiting; then the key, so the order is total. */
function byBlocked<T>(a: Group<T>, b: Group<T>): number {
  return a.urgency - b.urgency || b.stopped - a.stopped || b.holding - a.holding || a.firstSeq - b.firstSeq || a.key.localeCompare(b.key);
}

/** The queue's order (see the module comment). */
export function orderInboxDecisions(candidates: readonly InboxDecisionCandidate[]): InboxDecision[] {
  const facts = (c: InboxDecisionCandidate) => ({ urgency: inboxDecisionUrgency(c.decision), seq: c.seq });
  const sessions = groupBy(candidates, (c) => c.decision.session.key, facts).sort(byBlocked);
  const out: InboxDecision[] = [];
  for (const session of sessions) {
    const threads = groupBy(session.items, (c) => c.decision.thread.id, facts).sort(byBlocked);
    for (const thread of threads) {
      const items = [...thread.items].sort(
        (a, b) =>
          inboxDecisionUrgency(a.decision) - inboxDecisionUrgency(b.decision) ||
          a.seq - b.seq ||
          a.decision.question.position - b.decision.question.position ||
          a.decision.id.localeCompare(b.decision.id),
      );
      for (const item of items) out.push(item.decision);
    }
  }
  return out;
}

/** The send group of a decision: one reply per agent session per thread. */
export function inboxDecisionGroupKey(decision: Pick<InboxDecision, "session" | "thread">): string {
  return `${decision.session.key}\u0001${decision.thread.id}`;
}
