/**
 * A list row's grey line (approval "inbox-row-latest-preview", 2026-11-09): the thread's latest message as plain
 * text, like a mail app's. The store picks the message (`InboxStore.listRow`: the newest unread agent message while
 * one is unread, else the newest message, the Inbox's own notes read past) and these words say it:
 *
 * - an agent message that asks: "Asked: <its first open question's prompt>";
 * - else its first words (markdown, fences, tables and question blocks dropped);
 * - else an open action item ("Action item: …"), its files ("2 files: a.zip, b.png"), its guided review's title;
 * - the person's reply: "You: <their words>"; with no words, "You answered: <the picks>" (or "You skipped 2
 *   questions"), else "You: <its files>".
 *
 * Pure, and bounded: the text is cut at a word near `INBOX_ROW_PREVIEW_MAX` characters, whatever the body's size.
 */

import { answerWords, cleanInline, cutAtWord, firstWords, replyWords } from './inbox-folding';
import type { InboxMessage, InboxQuestion } from './inbox-types';

/** The longest the row's line is (characters, before its "…"): two lines of a three-line row, one wide row. */
export const INBOX_ROW_PREVIEW_MAX = 160;

/** A message's words for its row (`firstWords`, of the person's own words on a reply). The store keeps these per record. */
export function inboxRowPreviewWords(message: Pick<InboxMessage, 'author' | 'body'>): string {
  // Twice the cut of kept text is plenty: the rest of a long body is never read.
  return firstWords(message.author.kind === 'person' ? replyWords(message.body) : message.body, INBOX_ROW_PREVIEW_MAX, INBOX_ROW_PREVIEW_MAX * 2);
}

/** What the line reads of a question: the wire's `InboxQuestion`, or the store's record with its state worked out. */
export type InboxRowPreviewQuestion = Pick<InboxQuestion, 'kind' | 'prompt' | 'state' | 'answer'> & { orphaned?: boolean };

/** A question still asking something: not replaced, not orphaned. */
const live = (q: InboxRowPreviewQuestion) => q.state !== 'superseded' && !q.orphaned;

const plain = (text: string) => cleanInline(text).replace(/\s+/g, ' ').trim();

/** "1 file: a.zip", "2 files: a.zip, b.png". */
function filesLine(names: readonly string[]): string {
  return `${names.length} ${names.length === 1 ? 'file' : 'files'}: ${names.join(', ')}`;
}

export interface InboxRowPreviewInput {
  message: Pick<InboxMessage, 'author' | 'body' | 'attachments' | 'guide' | 'reask'>;
  /** `inboxRowPreviewWords(message)`, when the caller keeps it. */
  words?: string;
  /** An agent message's own questions and action items. */
  questions?: readonly InboxRowPreviewQuestion[];
  /** A person's reply: the thread's questions whose answer it carried (`sent_reply_id`). */
  answered?: readonly InboxRowPreviewQuestion[];
}

/** The row's line for one message, or null when it has nothing to say. */
export function inboxRowPreview(input: InboxRowPreviewInput): string | null {
  const { message } = input;
  let read: string | undefined = input.words;
  // Read only when the line gets that far (an agent's question comes first).
  const wordsOf = () => (read ??= inboxRowPreviewWords(message));
  const cut = (text: string) => (text ? cutAtWord(text, INBOX_ROW_PREVIEW_MAX) : null);
  const files = (message.attachments ?? []).map((file) => file.name).filter(Boolean);
  if (message.author.kind === 'person') {
    // A Re-ask note: what the person did (the thread's folded line says it the same way).
    const reasked = message.reask?.length ?? 0;
    if (reasked > 0) return `You: ${reasked === 1 ? 'Asked to re-ask the open question' : `Asked to re-ask ${reasked} open questions in one message`}`;
    const words = wordsOf();
    if (words) return cut(`You: ${words}`);
    const answers = (input.answered ?? []).filter((q) => q.answer !== null && q.kind !== 'action');
    const picked = answers.filter((q) => q.answer!.skipped !== true);
    if (picked.length > 0) return cut(`You answered: ${picked.map((q) => answerWords(q.answer!)).join('; ')}`);
    if (answers.length > 0) return `You skipped ${answers.length} ${answers.length === 1 ? 'question' : 'questions'}`;
    if (files.length > 0) return cut(`You: ${filesLine(files)}`);
    return null;
  }
  const questions = (input.questions ?? []).filter(live);
  const asking = questions.filter((q) => q.kind !== 'action' && (q.state === 'open' || q.state === 'picked'));
  if (asking.length > 0) return cut(`Asked: ${plain(asking[0]!.prompt)}`);
  const words = wordsOf();
  if (words) return words;
  const todo = questions.find((q) => q.kind === 'action' && q.state === 'open');
  if (todo) return cut(`Action item: ${plain(todo.prompt).replace(/[?.!:]+$/, '')}`);
  if (files.length > 0) return cut(filesLine(files));
  if (message.guide?.title) return cut(plain(message.guide.title));
  return null;
}
