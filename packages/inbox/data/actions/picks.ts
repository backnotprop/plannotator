import { useMutation, type QueryClient } from '@tanstack/react-query';
import { useInboxQueryClient } from '../client';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { inboxApi } from '../../api';
import { withSavedQuestions } from '../apply/record';
import { inboxKeys } from '../keys';
import { changeThread } from '../queries/thread';

export interface PickSave {
  messageId: string;
  key: string;
  revision: number;
  answer: QuestionAnswer | null;
  keepalive?: boolean;
}

export function keepSavedQuestions(client: QueryClient, messageId: string, questions: readonly InboxQuestion[]): void {
  for (const query of client.getQueryCache().findAll({ queryKey: inboxKeys.threads() })) {
    const threadId = query.queryKey[2];
    const held = query.state.data as { thread?: { messages?: { id: string }[] } } | undefined;
    if (typeof threadId === 'string' && held?.thread?.messages?.some((m) => m.id === messageId)) {
      changeThread(client, threadId, (thread) => withSavedQuestions(thread, messageId, questions));
    }
  }
}

export function usePickSave() {
  const client = useInboxQueryClient();
  return useMutation(
    {
      mutationKey: inboxKeys.pickSave(),
      mutationFn: (save: PickSave) => inboxApi.pick(save.messageId, save.key, save.revision, save.answer, { unsentOnly: true, keepalive: save.keepalive }),
      onSuccess: (result, save) => keepSavedQuestions(client, save.messageId, result.questions),
    },
    client,
  );
}
