/**
 * Re-ask all's write for one thread (`POST /api/inbox/threads/:id/reask`, packages/shared/inbox/reask-all.ts): the
 * thread's own Re-ask to every session there with a question open that can still be woken. `batchId`: one per press,
 * so a retry answers the notes that press wrote. Only this Inbox's own threads: a linked machine's row is not part of
 * Re-ask all (markAllRead.ts `offersRowReask`), since that Inbox's door does not take the route.
 */
import { apiPost } from '../../api';
import { inboxUrl } from '../../inboxUrl';

export interface ReaskAllSessionView {
  host: string | null;
  session: string | null;
}

export interface ThreadReaskAllView {
  thread_id: string;
  asked: (ReaskAllSessionView & { message_id: string; reply_id: string })[];
  unreached: ReaskAllSessionView[];
  /** Sessions whose note could not be written while others' were. */
  failed?: ReaskAllSessionView[];
  /** Sessions left out because they were asked again already. */
  already?: number;
}

export function postReaskAll(threadId: string, batchId: string): Promise<ThreadReaskAllView> {
  return apiPost<ThreadReaskAllView>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/reask`), { batch_id: batchId });
}
