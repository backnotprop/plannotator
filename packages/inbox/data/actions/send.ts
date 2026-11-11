/**
 * One reply of a Send (the pane builds each reply, its idempotency key and what it carries, as before). The last
 * reply of a Send on this Inbox asks for the thread with its answer (`with_thread`): that thread goes into the cache
 * once its code and math can draw, so the sent reply appears with no read of the thread after it.
 *
 * Not drawn before the server answers: the server writes the reply's body (its answers, actions, tags), so a copy
 * drawn earlier would not be its real shape (slow-link-fixes brief, "Left out as unsafe").
 */
import { useMutation } from '@tanstack/react-query';
import { useInboxQueryClient } from '../client';
import { inboxApi, type ReplyResult } from '../../api';
import { threadDrawReady } from '../../threadDrawReady';
import { inboxKeys } from '../keys';
import { putThread } from '../queries/thread';

export type ReplyInput = Parameters<typeof inboxApi.reply>[1];

export function useSendReply() {
  const client = useInboxQueryClient();
  return useMutation(
    {
      mutationKey: inboxKeys.send(),
      mutationFn: async ({ messageId, input }: { messageId: string; input: ReplyInput }): Promise<ReplyResult> => {
        const answer = await inboxApi.reply(messageId, input);
        if (answer.thread_read) await threadDrawReady(answer.thread_read.thread);
        return answer;
      },
      onSuccess: (answer) => {
        const read = answer.thread_read;
        if (read) putThread(client, read.thread.thread_id, read);
      },
    },
    client,
  );
}
