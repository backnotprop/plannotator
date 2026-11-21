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

/** One thread's write: its answer, left out (a linked machine's thread), or refused. */
export type ReaskAllOutcome = { row: InboxListRow; ok: true; value: ThreadReaskAllView | null } | { row: InboxListRow; ok: false; cause: unknown };

export interface ReaskAllTally {
  /** The agents asked: each session once, however many of its threads were. */
  asked: number;
  /** The agents with a question open that could not be woken, plus each thread left out (a linked machine's). */
  unreached: number;
  /** Threads whose write was refused, and the first refusal. */
  refused: number;
  cause: unknown;
}

const agentKey = (s: { host: string | null; session: string | null }, fallback: string) => (s.session ? `${s.host ?? ''}\u0000${s.session}` : `\u0001${fallback}`);

export function tallyReaskAll(outcomes: readonly ReaskAllOutcome[]): ReaskAllTally {
  const asked = new Set<string>();
  const unreached = new Set<string>();
  let refused = 0;
  let cause: unknown = null;
  for (const o of outcomes) {
    if (!o.ok) {
      refused += 1;
      cause ??= o.cause;
      continue;
    }
    if (!o.value) {
      unreached.add(`\u0002${o.row.thread_id}`);
      continue;
    }
    for (const s of o.value.asked) asked.add(agentKey(s, s.message_id));
    for (const s of o.value.unreached) unreached.add(agentKey(s, o.row.thread_id));
  }
  // A session asked in one thread is reachable: never also counted as not reached.
  for (const key of asked) unreached.delete(key);
  return { asked: asked.size, unreached: unreached.size, refused, cause };
}

/**
 * "Asked 3 agents to re-ask · 1 could not be reached"; "Could not reach 2 agents" when none was asked. Null when
 * nothing was asked, nothing missed and nothing refused (every agent was already asked again): the caller says so.
 */
export function reaskAllToast(t: ReaskAllTally): Pick<InboxToastModel, 'icon' | 'lead' | 'phoneLead' | 'detail' | 'wrap'> | null {
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
