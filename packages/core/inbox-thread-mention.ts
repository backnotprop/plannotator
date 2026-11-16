/**
 * A thread mentioned in a reply (approval "inbox-drag-threads", piece 1: the mention, treatment A "in the words").
 *
 * In the reply box a mention is the thread's title painted as a token where it was dropped (or picked from the row
 * menu, or pasted as a thread link). The window keeps the thread's id beside the words, and at Send it writes the
 * words the agent reads: the mention stays at its spot as `"Title" (thread msg_…)`, and one short list after the
 * words names every mentioned thread with how to read it. Every way an agent reads a reply (a wake, read_thread, a
 * queue) carries those words as they are, the way it carries a quote's lead (inbox-reply-quote.ts).
 *
 * The window draws a sent mention as a link to the thread and leaves the list out (`linkInboxThreadMentions`); the
 * list's preview and snippets show the title alone (`withoutInboxThreadMentions`, in `replyWords`).
 *
 * The wording is agent-facing text: it is all in INBOX_THREAD_MENTION_WORDS, so a change of words is one edit here.
 */
import { isInboxId } from './inbox-types';

/** A mentioned thread as the reply names it to the agent. */
export interface InboxThreadMentionRef {
  /** The thread's id (its root message id, `msg_…`). */
  id: string;
  /** The thread's title as the list shows it. */
  title: string;
  /** The thread's project name, when known. */
  project?: string | null;
  /** The thread is archived (read_thread still reads it). */
  archived?: boolean;
  /** The thread lives on another machine's Inbox: an agent here cannot read it. */
  elsewhere?: boolean;
}

/**
 * The agent-facing words of a mention. WORDING PENDING THE OWNER'S APPROVAL (word for word, with a clean-room test):
 * one place, so the approved words are one edit. Nothing else in the repo spells these words.
 */
export const INBOX_THREAD_MENTION_WORDS = {
  /** In the words, where the person put the mention. */
  inline: (title: string, id: string) => `"${title}" (thread ${id})`,
  /** The list's first line, after the words. */
  heading: 'Threads the person mentioned:',
  /** One thread in the list: its id and title on the first line. */
  item: (id: string, title: string) => `- ${id} "${title}"`,
  /** What the list says about it, on the line under (absent parts are left out). */
  details: (ref: { project?: string | null; archived?: boolean; elsewhere?: boolean }) =>
    [ref.project ? `project ${ref.project}` : null, ref.archived ? 'archived' : null, ref.elsewhere ? 'on another machine, not readable from here' : null].filter(Boolean).join(', '),
  /** How to read it, on the last line. */
  read: (id: string) => `Read it with read_thread, thread_id ${id}.`,
} as const;

/** The longest title a mention carries (more is cut, with "…"). */
export const INBOX_THREAD_MENTION_TITLE_MAX = 120;

/** A title on one line, as a mention carries it: no control characters, runs of spaces as one, at most the max. */
export function inboxThreadMentionTitle(title: string): string {
  const flat = title
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\p{Cf}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...flat];
  const cut = chars.length > INBOX_THREAD_MENTION_TITLE_MAX ? `${chars.slice(0, INBOX_THREAD_MENTION_TITLE_MAX).join('').trimEnd()}…` : flat;
  return cut || 'Untitled thread';
}

/** A thread id a mention may carry: a root message id. */
export function isInboxThreadMentionId(value: unknown): value is string {
  return isInboxId('msg', value);
}

/** One mention in the reply box's words: which thread, and where its label stands in them (`[start, end)`). */
export interface InboxThreadMentionSpan {
  ref: InboxThreadMentionRef;
  start: number;
  end: number;
}

/** The list after the words: each thread once, in the order the words first mention it. '' with none. */
export function inboxThreadMentionList(refs: readonly InboxThreadMentionRef[]): string {
  const W = INBOX_THREAD_MENTION_WORDS;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    const title = inboxThreadMentionTitle(ref.title);
    lines.push(W.item(ref.id, title));
    const details = W.details(ref);
    if (details) lines.push(`  ${details}.`);
    if (!ref.elsewhere) lines.push(`  ${W.read(ref.id)}`);
  }
  return lines.length > 0 ? `${W.heading}\n${lines.join('\n')}` : '';
}

/**
 * The words the agent reads: each mention's label replaced, at its spot, by the inline form, then a blank line and
 * the list. Spans that overlap, fall outside the words or are empty are left as plain words. No span: the words as
 * they are.
 */
export function inboxThreadMentionWords(words: string, spans: readonly InboxThreadMentionSpan[]): string {
  const kept = [...spans].filter((s) => s.start >= 0 && s.end <= words.length && s.end > s.start).sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  const used: InboxThreadMentionRef[] = [];
  for (const span of kept) {
    if (span.start < at) continue;
    out += words.slice(at, span.start) + INBOX_THREAD_MENTION_WORDS.inline(inboxThreadMentionTitle(span.ref.title), span.ref.id);
    at = span.end;
    used.push(span.ref);
  }
  if (used.length === 0) return words;
  out += words.slice(at);
  return `${out.trimEnd()}\n\n${inboxThreadMentionList(used)}`;
}

/** The list's item line, read back: its id and title. */
const ITEM_LINE = /^- (msg_[A-Za-z0-9]{6,64}) "(.*)"$/;

/**
 * A body split from its mention list: the threads the list names (id and title, in order) and the body without the
 * list, or null when it holds none. The list starts at a line that is exactly the heading, right after a blank line
 * (or the start), and runs through its item lines and their indented lines.
 */
export function splitInboxThreadMentions(body: string): { mentions: { id: string; title: string }[]; rest: string } | null {
  if (!body.includes(INBOX_THREAD_MENTION_WORDS.heading)) return null;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.replace(/\r$/, '') !== INBOX_THREAD_MENTION_WORDS.heading) continue;
    if (i > 0 && lines[i - 1]!.trim() !== '') continue;
    const mentions: { id: string; title: string }[] = [];
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end]!.replace(/\r$/, '');
      const item = ITEM_LINE.exec(line);
      if (item) mentions.push({ id: item[1]!, title: item[2]! });
      else if (!(mentions.length > 0 && line.startsWith('  ') && line.trim() !== '')) break;
      end++;
    }
    if (mentions.length === 0) continue;
    const before = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    const after = lines.slice(end).join('\n').replace(/^\n+/, '');
    return { mentions, rest: before && after ? `${before}\n\n${after}` : before || after };
  }
  return null;
}

/** Replace each mention's inline form in `text` by `draw(mention)`: the threads the list names, longest title first. */
function replaceInline(text: string, mentions: readonly { id: string; title: string }[], draw: (m: { id: string; title: string }) => string): string {
  let out = text;
  for (const m of [...mentions].sort((a, b) => b.title.length - a.title.length)) {
    out = out.split(INBOX_THREAD_MENTION_WORDS.inline(m.title, m.id)).join(draw(m));
  }
  return out;
}

/** Markdown link text: the characters that would end or break it escaped. */
const linkText = (title: string) => title.replace(/[\\[\]`*_~]/g, (c) => `\\${c}`);

/**
 * A person's words as the window draws them: each mention a link to its thread (`[Title](#thread=msg_…)`, the
 * Inbox's own route), and the list left out. The body as it is when it holds no list.
 */
export function linkInboxThreadMentions(body: string): string {
  const split = splitInboxThreadMentions(body);
  if (!split) return body;
  return replaceInline(split.rest, split.mentions, (m) => `[${linkText(m.title)}](#thread=${m.id})`);
}

/** A person's words for a preview or snippet: each mention its title alone, and the list left out. */
export function withoutInboxThreadMentions(body: string): string {
  const split = splitInboxThreadMentions(body);
  if (!split) return body;
  return replaceInline(split.rest, split.mentions, (m) => m.title);
}
