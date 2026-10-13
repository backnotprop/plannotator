/**
 * Folding a thread (design record, not in this repo; variant "Land"): which
 * messages open and which fold to one line when a thread opens, which read
 * messages hide in the middle of a long run, what a folded line says, and
 * which messages are new since the person's last look. Pure: the thread pane
 * (components/Thread.tsx) draws what these decide.
 */

import { isInboxNote, type InboxMessageWire, type InboxQuestion, type InboxThread } from '@plannotator/core/inbox-types';
import { QUESTION_ANSWERS_HEADING, type QuestionAnswer } from '@plannotator/core/question-block';
import { INBOX_STILL_OPEN_LINE, sliceText } from '@plannotator/core/inbox-questions';

/**
 * Where "new since you looked" starts: the seq of the person's last look at
 * the thread, or of their own last reply (a reply is a look at everything
 * before it), whichever is later. The Inbox's own notes (Mark read's
 * set-aside note, a late Undo's reopened note) are not a reply and not a
 * look. Read from the thread as it was BEFORE the window records the next
 * look, and kept until the person leaves the thread. Null when the payload
 * carries no seqs (an older Inbox): nothing is new then.
 */
export function lookBoundary(thread: InboxThread): number | null {
  if (thread.messages.length === 0 || thread.messages.some((m) => typeof m.seq !== 'number')) return null;
  let seen = thread.messages[0]!.person_seen_seq ?? 0;
  for (const message of thread.messages) if (isPersonReply(message)) seen = Math.max(seen, message.seq!);
  return seen;
}

/** A thread's last message with the Inbox's own notes read past (the one a reply's line sits on). */
export function lastNonNote(messages: readonly InboxMessageWire[]): InboxMessageWire | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (!isInboxNote(messages[i]!)) return messages[i];
  return undefined;
}

/** The person's own message (a reply or a New message), never one of the Inbox's notes. */
export function isPersonReply(message: InboxMessageWire): boolean {
  return message.author.kind === 'person' && !isInboxNote(message);
}

/** The agent messages after the boundary: new since the person's last look. */
export function newSinceLook(messages: readonly InboxMessageWire[], boundary: number | null): Set<string> {
  const out = new Set<string>();
  if (boundary === null) return out;
  for (const message of messages) {
    if (message.author.kind === 'agent' && typeof message.seq === 'number' && message.seq > boundary) out.add(message.id);
  }
  return out;
}

/** A question that still asks something: not replaced, not orphaned. */
const live = (q: InboxQuestion) => q.state !== 'superseded' && !q.orphaned;

/** The message holds a pick the person has not sent. */
export function holdsUnsentPick(message: InboxMessageWire): boolean {
  return (message.questions ?? []).some((q) => q.state === 'picked');
}

export interface FoldPlan {
  /** The messages that open folded to one line. */
  folded: Set<string>;
  /**
   * The middle of each long run of read, folded messages, hidden behind
   * "N earlier messages": a run of 4 or more keeps its first and its last
   * two. Decided once when the thread opens.
   */
  hidden: string[][];
}

/**
 * How a thread opens: a message is shown in full when it is new since the
 * last look, holds a pick not yet sent, or is the last message; every other
 * message folds. A one-message thread folds nothing (it looks as it always
 * did), and so does a thread whose seqs are unknown (an older Inbox: the
 * window cannot tell what was read).
 */
export function planFolds(messages: readonly InboxMessageWire[], fresh: ReadonlySet<string>, boundary: number | null): FoldPlan {
  const folded = new Set<string>();
  const hidden: string[][] = [];
  if (messages.length < 2 || boundary === null) return { folded, hidden };
  const last = messages[messages.length - 1]!;
  // The last real message stays open too when the Inbox's notes trail it: it
  // carries the reply's "Saved for / Delivered to" line.
  const lastReal = lastNonNote(messages);
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 4) hidden.push(run.slice(1, run.length - 2));
    run = [];
  };
  for (const message of messages) {
    const open = fresh.has(message.id) || holdsUnsentPick(message) || message === last || message === lastReal;
    if (open) {
      flush();
      continue;
    }
    folded.add(message.id);
    run.push(message.id);
  }
  flush();
  return { folded, hidden };
}

/** The words an answer reads as: "Pagefind", "Guides, API reference", "skipped". */
export function answerWords(answer: QuestionAnswer): string {
  if (answer.skipped) return 'skipped';
  const parts = [...answer.selected];
  if (answer.other) parts.push(answer.other);
  if (answer.text) parts.push(answer.text);
  return parts.join(', ');
}

/** One answered question on a folded line: its prompt, then the answer. */
export interface AnsweredPart {
  /** The prompt as the line shows it: plain, cut at a word near 40 characters. */
  prompt: string;
  /** The whole prompt, plain: the line's title and its screen-reader label. */
  full: string;
  answer: string;
}

/**
 * A folded line's snippet: the person's answers, or first words (see
 * `foldSnippet`).
 */
export type FoldSnippet = { kind: 'answers'; parts: AnsweredPart[] } | { kind: 'words'; text: string };

/** How long a prompt may run on a folded line before it is cut, so the answer after it stays in view. */
export const SNIPPET_PROMPT_MAX = 40;

/** A prompt without its inline markdown and its closing punctuation. */
function plainPrompt(prompt: string): string {
  return cleanInline(prompt).replace(/\s+/g, ' ').trim().replace(/[?.!:]+$/, '');
}

/** Cut at a word boundary near `max` characters, with "…". */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  // One character more, so a word that ends exactly at `max` is kept whole.
  const space = text.slice(0, max + 1).lastIndexOf(' ');
  return `${(space > max * 0.5 ? text.slice(0, space) : sliceText(text, max)).replace(/[\s,;:.]+$/, '')}…`;
}

function answeredParts(questions: readonly InboxQuestion[]): AnsweredPart[] {
  return questions.map((q) => {
    const full = plainPrompt(q.prompt);
    return { prompt: cutAtWord(full, SNIPPET_PROMPT_MAX), full, answer: answerWords(q.answer!) };
  });
}

const ANSWERS_HEADING_LINE = new RegExp(`^#{1,6}\\s+${QUESTION_ANSWERS_HEADING}\\s*$`);

/**
 * A person's reply without what the store wrote around the person's words
 * (core's `composeInboxReplyBody`): the leading "Answered N questions." / "Skipped N questions." /
 * "Answered N questions, skipped M." and
 * everything from the "Answers to your questions" heading on (the answers,
 * then the annotations' feedback), or, on a reply that answered nothing,
 * from the "No questions answered yet; …" line on.
 */
export function replyWords(body: string): string {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((line) => ANSWERS_HEADING_LINE.test(line.trim()) || INBOX_STILL_OPEN_LINE.test(line.trim()));
  const kept = (at >= 0 ? lines.slice(0, at) : lines).join('\n');
  return kept.replace(/^\s*(?:Answered \d+ questions?(?:, skipped \d+)?|Skipped \d+ questions?)\.\s*/, '');
}

/**
 * A folded line's snippet. An agent message whose live questions were all
 * sent shows the answers: what the person decided is the reason to look
 * back. Otherwise its first words; a message that is only a question block,
 * its first live question's prompt. A person's reply shows its own words;
 * with none, the answers it sent (from `messages`, the thread); else its
 * first words.
 */
export function foldSnippet(message: InboxMessageWire, messages: readonly InboxMessageWire[] = [message]): FoldSnippet {
  if (message.author.kind === 'person') {
    const words = firstWords(replyWords(message.body));
    if (words) return { kind: 'words', text: words };
    const sent = messages.flatMap((m) => (m.questions ?? []).filter((q) => q.sent_reply_id === message.id && q.answer !== null));
    if (sent.length > 0) return { kind: 'answers', parts: answeredParts(sent) };
    return { kind: 'words', text: firstWords(message.body) };
  }
  const questions = (message.questions ?? []).filter(live);
  if (questions.length > 0 && questions.every((q) => q.state === 'sent' && q.answer !== null)) {
    return { kind: 'answers', parts: answeredParts(questions) };
  }
  const words = firstWords(message.body);
  if (!words && questions.length > 0) return { kind: 'words', text: plainPrompt(questions[0]!.prompt) };
  return { kind: 'words', text: words };
}

/** The snippet as one line of text, whole: a line's title and its screen-reader label. */
export function snippetText(snippet: FoldSnippet): string {
  return snippet.kind === 'words' ? snippet.text : snippet.parts.map((p) => `${p.full}: ${p.answer}`).join('; ');
}

/**
 * Inline markdown as plain text: images out, link and wiki-link labels kept,
 * tags out, and paired emphasis marks (`**x**`, `__x__`, `~~x~~`, `*x*`,
 * `_x_`) dropped only where they open and close at word boundaries, so
 * `snake_case` and `2 * 3` keep their characters. Inline code keeps its text
 * (only the backticks go).
 */
export function cleanInline(text: string): string {
  const code: string[] = [];
  let out = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, inner: string) => {
    code.push(inner.trim());
    return `\u0000${code.length - 1}\u0000`;
  });
  out = out
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/<\/?[A-Za-z][^>]*>/g, '');
  // A closing mark ends a word: whitespace, the end, or punctuation that does
  // not run into another word (`__init__.py` is a name, not emphasis).
  const close = `(?=$|\\s|[,;:!?)\\]"'’]|\\.(?!\\w))`;
  for (const mark of ['\\*\\*', '__', '~~', '\\*', '_']) {
    const pair = new RegExp(`(^|[^\\w*~])${mark}(?=\\S)([\\s\\S]*?\\S)${mark}${close}`, 'g');
    out = out.replace(pair, '$1$2');
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)] ?? '');
}

/**
 * The first words of a message's markdown as plain text: question blocks,
 * fences, tables, images and raw HTML dropped, link and emphasis marks
 * removed, whitespace collapsed, cut at a word near `max` characters.
 */
export function firstWords(markdown: string, max = 240): string {
  const lines: string[] = [];
  let fence: string | null = null;
  let directive = 0;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (fence !== null) {
      if (line.startsWith(fence)) fence = null;
      continue;
    }
    const open = /^(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = open[1]!;
      continue;
    }
    if (/^:{3,}\s*[A-Za-z]/.test(line)) {
      directive += 1;
      continue;
    }
    if (/^:{3,}\s*$/.test(line)) {
      if (directive > 0) directive -= 1;
      continue;
    }
    if (directive > 0) continue;
    if (line.startsWith('|') || /^[-*_]{3,}$/.test(line) || /^<\/?[A-Za-z][^>]*>$/.test(line)) continue;
    // Block marks: a heading's hashes, a list or task marker, a quote.
    lines.push(line.replace(/^#{1,6}\s+/, '').replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^>\s?/, ''));
  }
  const text = cleanInline(lines.join(' ')).replace(/\s+/g, ' ').trim();
  return cutAtWord(text, max);
}

/** One thing a message holds, for its folded line. */
export interface Holding {
  kind: 'picks' | 'open' | 'answered' | 'files' | 'annotations' | 'guide' | 'delivered';
  /** What the line shows. */
  text: string;
  /** What a screen reader hears. */
  say: string;
  count?: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a message holds: an agent message's questions (open, picked and not
 * sent, or answered), its files and guided review; a person's reply's sent
 * annotations and whether it was delivered. Open and unsent states are words,
 * never colour alone.
 */
export function holdingsOf(message: InboxMessageWire, options: { delivered: boolean; picked?: (q: InboxQuestion) => boolean }): Holding[] {
  const out: Holding[] = [];
  const questions = (message.questions ?? []).filter(live);
  const isPicked = options.picked ?? ((q: InboxQuestion) => q.state === 'picked');
  const picks = questions.filter((q) => q.state !== 'sent' && isPicked(q)).length;
  const open = questions.filter((q) => q.state !== 'sent' && !isPicked(q)).length;
  const sent = questions.filter((q) => q.state === 'sent').length;
  if (picks > 0) out.push({ kind: 'picks', text: `${plural(picks, 'pick')}, not sent`, say: `${plural(picks, 'pick')} not sent`, count: picks });
  if (open > 0) out.push({ kind: 'open', text: `${open} open ${open === 1 ? 'question' : 'questions'}`, say: `${open} open ${open === 1 ? 'question' : 'questions'}`, count: open });
  if (sent > 0 && open === 0 && picks === 0) out.push({ kind: 'answered', text: `${sent} answered`, say: `${plural(sent, 'question')} answered`, count: sent });
  const files = message.attachments?.length ?? 0;
  if (files > 0) out.push({ kind: 'files', text: String(files), say: plural(files, 'attachment'), count: files });
  if (message.author.kind === 'person' && (message.sent_annotations ?? 0) > 0) {
    const n = message.sent_annotations!;
    out.push({ kind: 'annotations', text: String(n), say: `${plural(n, 'annotation')} sent`, count: n });
  }
  if (message.guide) out.push({ kind: 'guide', text: 'Guided review', say: 'a guided review' });
  if (options.delivered) out.push({ kind: 'delivered', text: 'Delivered', say: 'delivered' });
  return out;
}

/**
 * A person's message reached the agent: a connection delivered it as a turn,
 * or (a reply, not a New message) the asking agent read it.
 */
export function isDelivered(message: InboxMessageWire, root: InboxMessageWire): boolean {
  if (message.author.kind !== 'person') return false;
  if (message.delivery) return true;
  if (message.to) return false;
  return typeof message.seq === 'number' && (root.agent_checked_seq ?? 0) >= message.seq;
}
