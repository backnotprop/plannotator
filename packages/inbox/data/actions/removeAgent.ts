/**
 * Remove an agent from a thread, and the toast's Undo (approval "inbox-remove-agent-from-thread"): `POST
 * /api/inbox/threads/:id/remove-agent` and `…/remove-agent/undo`, `{ session }`, on the thread's own machine (a linked
 * one through its door and the outbox, mark `remove-agent`). Nothing is sent and nobody is woken; the thread's read
 * after it shows the agent gone (or back).
 */
import type { InboxRemoval } from '@plannotator/core/inbox-types';
import { apiPost } from '../../api';
import { inboxUrl, machineOf } from '../../inboxUrl';

const removeUrl = (threadId: string, rest = '') => inboxUrl(`/threads/${encodeURIComponent(threadId)}/remove-agent${rest}`, undefined, machineOf(threadId));

export function postRemoveAgent(threadId: string, session: string): Promise<{ thread_id: string; removal: InboxRemoval }> {
  return apiPost(removeUrl(threadId), { session });
}

export function postUndoRemoveAgent(threadId: string, session: string): Promise<{ thread_id: string; removed: InboxRemoval[] }> {
  return apiPost(removeUrl(threadId, '/undo'), { session });
}
