/**
 * The person's own sent reply, as the window shows it to them (display only).
 *
 * The store writes a reply's body for the agent (core's
 * `composeInboxReplyBody`): "Answered 2 questions.", the person's words, a
 * line about the questions still open, then "## Answers to your questions"
 * with `### Q1. <prompt> (line 4)` blocks. That text is what agents receive
 * and it is kept as it is. The person sees their words, then a short list of
 * what they answered, read from the questions themselves (each sent question
 * names the reply that carried it, `sent_reply_id`), then the comments and
 * files as before. `splitInboxReplyBody` takes the agent-facing parts out of
 * the words. The folded line (`replyWords`) and search read the words with
 * their own, looser rule; for a body the store wrote they give the same text.
 */
import { isInboxActionReport, isInboxNote, type InboxMessageWire } from '@plannotator/core/inbox-types';
import { splitInboxReplyBody, type InboxReplyBodyParts } from '@plannotator/core/inbox-questions';
import { cleanInline } from './folding';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { pickWords } from './components/ReplacedQuestion';

/** One answer a sent reply carried. */
export interface SentAnswer {
  /** `<message id>/<key>`. */
  id: string;
  messageId: string;
  key: string;
  /** The question's number in its message (Q1, Q2…), as its card numbers it. */
  number: number;
  /** The prompt as plain text (the row cuts it with an ellipsis; its tooltip shows it whole). */
  prompt: string;
  /** The answer's words: the pick, Other, the text, a note; "Skipped" for a skip. */
  answer: string;
  skipped: boolean;
}

/** An answer's words as its row shows them: the card's "Your pick" words, then a note (ReplyAnswers' rule). */
function answerWords(answer: QuestionAnswer): string {
  const words = pickWords(answer);
  const note = answer.note?.trim();
  if (!note) return words;
  return words ? `${words} · Note: ${note}` : `Note: ${note}`;
}

/** The answers a reply carried, one group per asking message, in thread order. */
export interface SentAnswerGroup {
  messageId: string;
  /** The asking message as a group heading names it ("Claude Code's message, 2:58 PM"). */
  name: string;
  answers: SentAnswer[];
}

/**
 * The answers `reply` sent, read from the thread's questions (`sent_reply_id`
 * names the reply that carried each), grouped by the message that asked, in
 * thread order and card order. Action items are not questions and are left
 * out (they have their own checklist card).
 */
export function sentAnswersOf(reply: InboxMessageWire, messages: readonly InboxMessageWire[], nameOf: (message: InboxMessageWire) => string): SentAnswerGroup[] {
  if (reply.author.kind !== 'person') return [];
  const groups: SentAnswerGroup[] = [];
  for (const message of messages) {
    if (message.author.kind !== 'agent') continue;
    const answers = (message.questions ?? [])
      .filter((q) => q.sent_reply_id === reply.id && q.answer !== null)
      .sort((a, b) => a.position - b.position)
      .map((q) => ({
        id: `${message.id}/${q.key}`,
        messageId: message.id,
        key: q.key,
        number: q.position + 1,
        prompt: cleanInline(q.prompt).replace(/\s+/g, ' ').trim(),
        answer: answerWords(q.answer!),
        skipped: q.answer!.skipped === true,
      }));
    if (answers.length > 0) groups.push({ messageId: message.id, name: nameOf(message), answers });
  }
  return groups;
}

/**
 * How to draw a person's message body (its skills block already taken off):
 * the parts, or null to draw it as it was sent. Only the person's own replies
 * are split, never an Inbox note (set aside, reopened, 👍) or an action
 * report. A body whose answers section was found is split only when the
 * answers can be listed from the questions, so no answer ever disappears from
 * the screen.
 */
export function sentReplyParts(message: InboxMessageWire, body: string, answers: readonly SentAnswerGroup[]): InboxReplyBodyParts | null {
  if (message.author.kind !== 'person' || isInboxNote(message) || isInboxActionReport(message) || (message.reask?.length ?? 0) > 0) return null;
  const parts = splitInboxReplyBody(body);
  if (!parts.changed) return null;
  if (parts.answers && answers.length === 0) return null;
  return parts;
}

/** The list's heading: what the person did, in their words ("You answered 2 questions, skipped 1."). */
export function sentAnswersHeading(groups: readonly SentAnswerGroup[]): string {
  const all = groups.flatMap((g) => g.answers);
  const skipped = all.filter((a) => a.skipped).length;
  const answered = all.length - skipped;
  const n = (count: number) => `${count} question${count === 1 ? '' : 's'}`;
  if (answered > 0 && skipped > 0) return `You answered ${n(answered)}, skipped ${skipped}`;
  if (answered > 0) return `You answered ${n(answered)}`;
  return `You skipped ${n(skipped)}`;
}
