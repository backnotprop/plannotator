import { isInboxActionReport, isInboxNote, type InboxMessageWire } from '@plannotator/core/inbox-types';
import { inboxQuestionPlace, inboxQuestionsInPlaceOrder, splitInboxReplyBody, type InboxReplyBodyParts } from '@plannotator/core/inbox-questions';
import { cleanInline } from './folding';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { pickWords } from './components/ReplacedQuestion';

export interface SentAnswer {
  id: string;
  messageId: string;
  key: string;
  number: number;
  prompt: string;
  answer: string;
  skipped: boolean;
}

function answerWords(answer: QuestionAnswer): string {
  const words = pickWords(answer);
  const note = answer.note?.trim();
  if (!note) return words;
  return words ? `${words} · Note: ${note}` : `Note: ${note}`;
}

export interface SentAnswerGroup {
  messageId: string;
  name: string;
  file?: { id: string; name: string } | null;
  answers: SentAnswer[];
}

export function fileGroupName(fileName: string, messageName: string): string {
  return `${fileName} in ${messageName}`;
}

export function sentAnswersOf(reply: InboxMessageWire, messages: readonly InboxMessageWire[], nameOf: (message: InboxMessageWire) => string): SentAnswerGroup[] {
  if (reply.author.kind !== 'person') return [];
  const groups: SentAnswerGroup[] = [];
  for (const message of messages) {
    if (message.author.kind !== 'agent') continue;
    const sent = inboxQuestionsInPlaceOrder((message.questions ?? []).filter((q) => q.sent_reply_id === reply.id && q.answer !== null));
    let place: string | null | undefined;
    for (const q of sent) {
      const here = inboxQuestionPlace(q);
      if (here !== place) {
        place = here;
        groups.push({
          messageId: message.id,
          name: q.attachment ? fileGroupName(q.attachment.name, nameOf(message)) : nameOf(message),
          ...(q.attachment ? { file: { id: q.attachment.id, name: q.attachment.name } } : {}),
          answers: [],
        });
      }
      groups.at(-1)!.answers.push({
        id: `${message.id}/${q.key}`,
        messageId: message.id,
        key: q.key,
        number: q.position + 1,
        prompt: cleanInline(q.prompt).replace(/\s+/g, ' ').trim(),
        answer: answerWords(q.answer!),
        skipped: q.answer!.skipped === true,
      });
    }
  }
  return groups;
}

export function sentReplyParts(message: InboxMessageWire, body: string, answers: readonly SentAnswerGroup[]): InboxReplyBodyParts | null {
  if (message.author.kind !== 'person' || isInboxNote(message) || isInboxActionReport(message) || (message.reask?.length ?? 0) > 0) return null;
  const parts = splitInboxReplyBody(body);
  if (!parts.changed) return null;
  if (parts.answers && answers.length === 0) return null;
  return parts;
}

export function sentAnswersHeading(groups: readonly SentAnswerGroup[]): string {
  const all = groups.flatMap((g) => g.answers);
  const skipped = all.filter((a) => a.skipped).length;
  const answered = all.length - skipped;
  const n = (count: number) => `${count} question${count === 1 ? '' : 's'}`;
  if (answered > 0 && skipped > 0) return `You answered ${n(answered)}, skipped ${skipped}`;
  if (answered > 0) return `You answered ${n(answered)}`;
  return `You skipped ${n(skipped)}`;
}
