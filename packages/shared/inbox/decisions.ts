import { cutText, inboxUrgencyOf, type InboxUrgency } from "@plannotator/core/inbox-questions";
import type { InboxDecision } from "@plannotator/core/inbox-types";

export interface InboxDecisionCandidate {
  decision: InboxDecision;
  seq: number;
}

export const INBOX_DECISION_EXCERPT_CHARS = 280;

const BLOCK_START_RE = /^[ \t]*:::[ \t]*(?:question(?:-multi|-text)?|action)\b/m;

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

function byBlocked<T>(a: Group<T>, b: Group<T>): number {
  return a.urgency - b.urgency || b.stopped - a.stopped || b.holding - a.holding || a.firstSeq - b.firstSeq || a.key.localeCompare(b.key);
}

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

export function inboxDecisionGroupKey(decision: Pick<InboxDecision, "session" | "thread">): string {
  return `${decision.session.key}\u0001${decision.thread.id}`;
}
