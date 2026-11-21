/**
 * Re-ask all's write for one thread (`POST /api/inbox/threads/:id/reask`, packages/shared/inbox/reask-all.ts): the
 * thread's own Re-ask to every session there with a question open that can still be woken. `batchId`: one per press,
 * so a retry answers the notes that press wrote. Only this Inbox's own threads: a linked machine's thread is left out
 * (`reaskReaches`), since that Inbox's door does not take Re-ask all.
 */
import { apiPost } from '../../api';
import { inboxUrl, machineOf, selfMachineId } from '../../inboxUrl';

export interface ReaskAllSessionView {
  host: string | null;
  session: string | null;
}

export interface ThreadReaskAllView {
  thread_id: string;
  asked: (ReaskAllSessionView & { message_id: string; reply_id: string })[];
  unreached: ReaskAllSessionView[];
}

/** Whether Re-ask all can write this thread from here: this Inbox's own, never a linked machine's. */
export function reaskReaches(threadId: string): boolean {
  const machine = machineOf(threadId);
  return !machine || machine === selfMachineId();
}

export function postReaskAll(threadId: string, batchId: string): Promise<ThreadReaskAllView> {
  return apiPost<ThreadReaskAllView>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/reask`), { batch_id: batchId });
}
