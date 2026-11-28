/**
 * Re-ask all (a group band's menu, and the picks' ⋯ as "Re-ask"; markAllRead.ts says which rows): for each thread,
 * the thread's own Re-ask to every agent there with a question open (packages/shared/inbox/reask-all.ts). Pure: what
 * the writes came to, and the toast that says it. No Undo: a note that woke an agent cannot be taken back, and nothing
 * here is archived or read.
 */
import { plural } from '@plannotator/core/inbox-format';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxToastModel } from './components/Toast';
import type { ThreadReaskAllView } from './data/actions/reaskAll';

/** One thread's write: its answer, or refused. A linked machine's thread is never part of it (markAllRead.ts `reaskReaches`). */
export type ReaskAllOutcome = { row: InboxListRow; ok: true; value: ThreadReaskAllView } | { row: InboxListRow; ok: false; cause: unknown };

export interface ReaskAllTally {
  /** The agents asked: each session once, however many of its threads were. */
  asked: number;
  /** The agents with a question open that could not be woken, or whose note could not be written while others' were. */
  unreached: number;
  /** Threads whose write was refused, and the first refusal. */
  refused: number;
  cause: unknown;
  /**
   * Of the threads that asked nobody, missed nobody and were not refused: those with an agent asked again already
   * (`already`), and the others (only a permission prompt, or only picks: nothing there to re-ask).
   */
  already: number;
  nothing: number;
}

const agentKey = (s: { host: string | null; session: string | null }, fallback: string) => (s.session ? `${s.host ?? ''}\u0000${s.session}` : `\u0001${fallback}`);

export function tallyReaskAll(outcomes: readonly ReaskAllOutcome[]): ReaskAllTally {
  const asked = new Set<string>();
  const unreached = new Set<string>();
  let refused = 0;
  let cause: unknown = null;
  let already = 0;
  let nothing = 0;
  for (const o of outcomes) {
    if (!o.ok) {
      refused += 1;
      cause ??= o.cause;
      continue;
    }
    // Held for another machine (never this Inbox's own thread): nothing was asked here.
    if (!o.value) continue;
    const failed = o.value.failed ?? [];
    for (const s of o.value.asked) asked.add(agentKey(s, s.message_id));
    for (const s of [...o.value.unreached, ...failed]) unreached.add(agentKey(s, o.row.thread_id));
    if (o.value.asked.length + o.value.unreached.length + failed.length > 0) continue;
    if ((o.value.already ?? 0) > 0) already += 1;
    else nothing += 1;
  }
  // A session asked in one thread is reachable: never also counted as not reached.
  for (const key of asked) unreached.delete(key);
  return { asked: asked.size, unreached: unreached.size, refused, cause, already, nothing };
}

/** What the live region says when no toast comes (`reaskAllToast` null): the existing words, each only where true. */
export function reaskAllQuiet(t: Pick<ReaskAllTally, 'already' | 'nothing'>): string {
  return t.already > 0 && t.nothing === 0 ? 'Every agent was already asked again.' : 'Nothing to re-ask.';
}

/**
 * "Asked 3 agents to re-ask · 1 could not be reached"; "Could not reach 2 agents" when none was asked. Null when
 * nothing was asked, nothing missed and nothing refused: the caller says why (`reaskAllQuiet`).
 */
export function reaskAllToast(t: Pick<ReaskAllTally, 'asked' | 'unreached' | 'refused' | 'cause'>): Pick<InboxToastModel, 'icon' | 'lead' | 'phoneLead' | 'detail' | 'wrap'> | null {
  if (t.asked === 0 && t.unreached === 0 && t.refused === 0) return null;
  const parts: string[] = [];
  if (t.asked > 0 && t.unreached > 0) parts.push(`${t.unreached} could not be reached`);
  if (t.refused > 0) {
    const why = t.cause instanceof Error && t.cause.message ? t.cause.message : 'It didn’t go.';
    parts.push(`${plural(t.refused, 'thread')} did not go: ${why}`);
  }
  const lead = t.asked > 0 ? `Asked ${plural(t.asked, 'agent')} to re-ask` : t.unreached > 0 ? `Could not reach ${plural(t.unreached, 'agent')}` : 'Nothing was asked again';
  return {
    icon: t.asked > 0 && t.refused === 0 ? 'check' : 'warn',
    lead,
    phoneLead: t.asked > 0 ? `Asked ${t.asked} to re-ask` : lead,
    ...(parts.length > 0 ? { detail: parts.join(' · ') } : {}),
    ...(t.refused > 0 ? { wrap: true } : {}),
  };
}
