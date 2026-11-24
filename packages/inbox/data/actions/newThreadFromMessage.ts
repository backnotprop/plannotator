/**
 * New thread from this message's write (thread/newThreadFromMessage.ts): a plain reply to that very message
 * (`POST /api/inbox/messages/:id/reply`), so it goes to the session that wrote it, as any reply to that message does.
 * No picks, no other session aimed at, no tags, the reply draft untouched. One key per press. `author_only`: no
 * `#tag` is read from the quoted words, no "still open" line goes under them, and its length is not noted as the
 * person's long reply.
 */
import { inboxApi } from '../../api';
import { newUuid } from '../../uuid';

export function postNewThreadFromMessage(messageId: string, words: string): Promise<unknown> {
  return inboxApi.reply(messageId, { idempotency_key: newUuid(), words, questions: [], author_only: true });
}
