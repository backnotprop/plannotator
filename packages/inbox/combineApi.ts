import type { InboxCombinePlan, InboxCombineRecord } from '@plannotator/core/inbox-types';
import { apiGet, apiPost } from './api';
import { inboxUrl } from './inboxUrl';

/**
 * Combine's routes (approval "inbox-multi-select", 4A; packages/server/inbox-combine.ts), each on the machine that
 * holds the picked threads (`machine`, null for this one): only that machine's sessions can read them.
 */
export const combineApi = {
  /** Who can be asked about these threads, and the Combines worth showing; `all` (picks on two computers): every running agent there. */
  plan: (threads: readonly string[], machine: string | null, all = false) => apiGet<InboxCombinePlan>(inboxUrl('/combine', `threads=${threads.join(',')}${all ? '&all=1' : ''}`, machine)),
  /** The Combines worth showing (one still waiting, or one settled within a day). */
  list: (machine: string | null) => apiGet<InboxCombinePlan>(inboxUrl('/combine', undefined, machine)),
  start: (input: { thread_ids: readonly string[]; session: string; words?: string; idempotency_key: string }, machine: string | null) =>
    apiPost<{ combine: InboxCombineRecord }>(inboxUrl('/combine', undefined, machine), { ...input, thread_ids: [...input.thread_ids] }),
  /** Stop one still waiting, or Undo one done (the picked threads come back). */
  change: (id: string, action: 'cancel' | 'undo', machine: string | null) =>
    apiPost<{ combine: InboxCombineRecord }>(inboxUrl(`/combine/${id}/${action}`, undefined, machine), { idempotency_key: `${id}-${action}-${Date.now()}` }),
};
