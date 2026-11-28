/**
 * A Send names each question by the revision this window read. Another tab or device that saved the same answer
 * meanwhile raises that revision, and the reply comes back `question_revision_conflict` although nothing the
 * person sees changed. Then the thread is read again and, when every question the reply sends still holds the
 * answer this window shows (picked, not sent), the reply goes once more at the Inbox's revisions. Any other
 * change (a different answer, a cleared pick, a Send from elsewhere) keeps the refusal: that is the person's to read.
 */
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError } from '../../apiError';
import type { inboxApi } from '../../api';

type ReplyInput = Parameters<typeof inboxApi.reply>[1];

/** Two answers that say the same: the same picks and the same words. */
function sameAnswer(a: QuestionAnswer | null | undefined, b: QuestionAnswer | null | undefined): boolean {
  if (!a || !b) return a === b;
  const said = (x: QuestionAnswer) => JSON.stringify([x.selected, x.other ?? null, x.text ?? null, x.note ?? null, !!x.skipped]);
  return said(a) === said(b);
}

/**
 * `send`, and on a revision conflict once more at the Inbox's revisions when the answers are still the ones
 * `shown` (the thread as this window drew it) holds; `read` reads the thread as the Inbox has it now.
 */
export async function sendOverSameAnswers<T>(
  messageId: string,
  input: ReplyInput,
  shown: InboxThread,
  send: (input: ReplyInput) => Promise<T>,
  read: () => Promise<InboxThread>,
): Promise<T> {
  try {
    return await send(input);
  } catch (cause) {
    if (!(cause instanceof InboxApiError) || cause.code !== 'question_revision_conflict' || input.questions.length === 0) throw cause;
    const latest = await read().catch(() => null);
    if (!latest) throw cause;
    const find = (t: InboxThread, id: string, key: string) => t.messages.find((m) => m.id === id)?.questions?.find((q) => q.key === key);
    const fresh: ReplyInput['questions'] = [];
    for (const q of input.questions) {
      const id = q.message_id ?? messageId;
      const now = find(latest, id, q.key);
      const was = find(shown, id, q.key);
      if (!now || !was || now.state !== 'picked' || !sameAnswer(now.answer, was.answer)) throw cause;
      fresh.push({ ...q, revision: now.revision });
    }
    return send({ ...input, questions: fresh });
  }
}
