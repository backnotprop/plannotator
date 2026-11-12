import { answerWords, cleanInline, cutAtWord, firstWords, replyWords } from './inbox-folding';
import type { InboxMessage, InboxQuestion } from './inbox-types';

export const INBOX_ROW_PREVIEW_MAX = 160;

export function inboxRowPreviewWords(message: Pick<InboxMessage, 'author' | 'body'>): string {
  return firstWords(message.author.kind === 'person' ? replyWords(message.body) : message.body, INBOX_ROW_PREVIEW_MAX, INBOX_ROW_PREVIEW_MAX * 2);
}

export type InboxRowPreviewQuestion = Pick<InboxQuestion, 'kind' | 'prompt' | 'state' | 'answer'> & { orphaned?: boolean };

const live = (q: InboxRowPreviewQuestion) => q.state !== 'superseded' && !q.orphaned;

const plain = (text: string) => cleanInline(text).replace(/\s+/g, ' ').trim();

function filesLine(names: readonly string[]): string {
  return `${names.length} ${names.length === 1 ? 'file' : 'files'}: ${names.join(', ')}`;
}

export interface InboxRowPreviewInput {
  message: Pick<InboxMessage, 'author' | 'body' | 'attachments' | 'guide' | 'reask'>;
  words?: string;
  questions?: readonly InboxRowPreviewQuestion[];
  answered?: readonly InboxRowPreviewQuestion[];
}

export function inboxRowPreview(input: InboxRowPreviewInput): string | null {
  const { message } = input;
  let read: string | undefined = input.words;
  const wordsOf = () => (read ??= inboxRowPreviewWords(message));
  const cut = (text: string) => (text ? cutAtWord(text, INBOX_ROW_PREVIEW_MAX) : null);
  const files = (message.attachments ?? []).map((file) => file.name).filter(Boolean);
  if (message.author.kind === 'person') {
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
