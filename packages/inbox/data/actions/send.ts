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
