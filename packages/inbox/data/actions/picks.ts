/**
 * A question's answer saved: the pick queue (pickQueue.ts) runs these one at a time per question, with the
 * revision the Inbox holds and the conflict rule (pickConflict.ts), as before. The save's answer goes into the held
 * thread at once (the questions come back whole), so every place that shows the thread shows the saved answer.
 *
 * Shown before the save answers by the pane's own `pending` map, which the queue keeps per question and drops on a
 * failure: a pick or a key in "Other" draws there at once and never waits for the cache.
 */
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

/** The answers a save brought back, into whichever held thread has their message. */
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
      // `unsentOnly`: a save that lands after its question went with a reply never reopens what the agent has.
      mutationFn: (save: PickSave) => inboxApi.pick(save.messageId, save.key, save.revision, save.answer, { unsentOnly: true, keepalive: save.keepalive }),
      onSuccess: (result, save) => keepSavedQuestions(client, save.messageId, result.questions),
    },
    client,
  );
}
