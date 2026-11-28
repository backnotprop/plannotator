import { useMutation } from '@tanstack/react-query';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { useInboxQueryClient } from '../client';
import { inboxApi, type ReplyResult } from '../../api';
import { sendReadMs } from '../../apiWrite';
import { threadDrawReady } from '../../threadDrawReady';
import { inboxKeys } from '../keys';
import { putThread } from '../queries/thread';
import { sendOverSameAnswers } from './sendSameAnswers';

export type ReplyInput = Parameters<typeof inboxApi.reply>[1];

export function useSendReply() {
  const client = useInboxQueryClient();
  return useMutation(
    {
      mutationKey: inboxKeys.send(),
      /** `shown`: the thread as the window drew it; another client's save of the same answers then does not refuse the Send (sendSameAnswers.ts). */
      mutationFn: async ({ messageId, input, shown }: { messageId: string; input: ReplyInput; shown?: InboxThread }): Promise<ReplyResult> => {
        const send = (body: ReplyInput) => inboxApi.reply(messageId, body);
        const answer = shown ? await sendOverSameAnswers(messageId, input, shown, send, async () => (await inboxApi.thread(shown.thread_id, sendReadMs())).thread) : await send(input);
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
