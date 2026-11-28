/**
 * A thread mentioned in a reply (approval "inbox-drag-threads", piece 1: the mention, treatment A "in the words").
 *
 * In the reply box a mention is a token: a thread id and the range its label holds in the words
 * (`InboxReplyMention`), kept with the draft (`InboxReplyDraft.mentions`). Nothing is ever recovered by matching
 * words: an edit inside a label ends that mention, and the words stay as plain words (`remapReplyMentions`).
 *
 * At Send the window writes the words the agent reads (`inboxThreadMentionWords`): each mention becomes a short
 * reference at its spot, and one list after the words names every mentioned thread, its title as quoted data
 * (another agent may have written it), and how to read it, or that the agent cannot. Every way an agent reads a reply
 * (a wake, read_thread, a queue) carries those words as they are, the way it carries a quote's lead.
 *
 * The window draws a sent mention as a link to the thread and leaves the list out (`linkInboxThreadMentions`); the
 * list's preview and snippets show the title alone (`withoutInboxThreadMentions`, in `replyWords`).
 *
 * The wording is agent-facing text: it is all in INBOX_THREAD_MENTION_WORDS, so a change of words is one edit here.
 */
import { isInboxId, type InboxReplyMention } from './inbox-types';

/**
 * The agent-facing words of a mention, approved by the owner word for word (2026-11-16): one place, so a change of
 * words is one edit. Nothing else in the repo spells these words. A title is never in the person's words: only the
 * list carries it, and it (like a project) is always a JSON string on its own line, which is all that fences it.
 */
export const INBOX_THREAD_MENTION_WORDS = {
  /** In the words, where the person put the mention: the list's number and the thread's id. */
  inline: (n: number, id: string) => `[thread ${n}: ${id}]`,
  /** The list's first line, after the words. */
  heading: 'Threads the person mentioned.',
  /** One thread in the list: its number and id. */
  item: (n: number, id: string) => `${n}. ${id}`,
  /** Its title, as a quoted string (`inboxThreadMentionTitleData`). */
  title: (quoted: string) => `   title: ${quoted}`,
  /** What the list says about it (absent parts are left out). */
  details: (ref: { project?: string | null; archived?: boolean }) => {
    const project = mentionProjectData(ref.project);
    return [project ? `project ${project}` : null, ref.archived ? 'archived' : null].filter(Boolean).join(', ');
  },
  /** The line the details go on. */
  detailsLine: (details: string) => `   ${details}.`,
  /** How to read it. */
  read: (id: string) => `   Read it with read_thread, thread_id ${id}.`,
  /** In place of `read`, when the agent's Inbox cannot reach the thread (a machine its Inbox is not linked to). */
  unreadable: '   It is on another machine: you cannot open it, you have its title only.',
  /** In place of `read`, when the thread is on a linked machine whose Plannotator is too old to share it with agents. */
  needsUpdate: (machine: string) => `   It is on ${machine}, whose Plannotator is too old to share it with you: you have its title only. Updating Plannotator on ${machine} makes it readable.`,
  /** In place of `read`, when the thread is on this window's machine and the reader's own machine is too old to read it there. */
  readerNeedsUpdate: (thread: string, reader: string) => `   It is on ${thread}. Plannotator on ${reader}, where you are, is too old to read threads on ${thread}: you have its title only. Updating Plannotator on ${reader} makes it readable.`,
} as const;

/**
 * Whether the agent a reply goes to can read a mentioned thread: `true` (its Inbox holds it, or reads it from a linked
 * machine), `false` (no link reaches it), or which machine must update first: the thread's (`update: "thread"`) or the
 * reader's own (`update: "reader"`), with both machines' names.
 */
export type InboxThreadMentionReach = boolean | { update: 'thread' | 'reader'; thread: string; reader: string };

/** The longest title a mention carries (more is cut, with "…"). */
export const INBOX_THREAD_MENTION_TITLE_MAX = 120;
/** The most mentions one reply keeps. */
export const INBOX_REPLY_MENTIONS_MAX = 40;
/** The longest label (a title and its project). */
const LABEL_MAX = 200;

/** Text on one line (a title or a project): no control, separator or format characters, runs of spaces as one, at most the max. */
function oneLine(text: string): string {
  const flat = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\p{Cf}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...flat];
  return chars.length > INBOX_THREAD_MENTION_TITLE_MAX ? `${chars.slice(0, INBOX_THREAD_MENTION_TITLE_MAX).join('').trimEnd()}…` : flat;
}

/** A title on one line, as a mention carries it: no control characters, runs of spaces as one, at most the max. */
export function inboxThreadMentionTitle(title: string): string {
  return oneLine(title) || 'Untitled thread';
}

/** A title as the list carries it: one capped line, backticks made plain quotes (no code span can open). */
const listedTitle = (title: string) => inboxThreadMentionTitle(title).replace(/`/g, "'");

/** A project as the list carries it, like a title (an agent picks its folder's name): a JSON string, or null when empty. */
function mentionProjectData(project: string | null | undefined): string | null {
  const flat = project ? oneLine(project).replace(/`/g, "'") : '';
  return flat ? JSON.stringify(flat) : null;
}

/** A title as the agent reads it: the listed title as a JSON string (its quotes and backslashes escaped). */
export function inboxThreadMentionTitleData(title: string): string {
  return JSON.stringify(listedTitle(title));
}

/** A thread id a mention may carry: a root message id. */
export function isInboxThreadMentionId(value: unknown): value is string {
  return isInboxId('msg', value);
}

/** One mention as a draft keeps it, or null when it is not one (the shape only; where it stands is checked apart). */
function mentionOf(value: unknown): InboxReplyMention | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isInboxThreadMentionId(v.thread_id) || typeof v.title !== 'string' || typeof v.label !== 'string') return null;
  if (typeof v.at !== 'number' || !Number.isInteger(v.at) || v.at < 0) return null;
  if (v.label === '' || v.label.length > LABEL_MAX || v.title === '' || [...v.title].length > INBOX_THREAD_MENTION_TITLE_MAX + 1) return null;
  if (v.project !== undefined && (typeof v.project !== 'string' || v.project.length > LABEL_MAX)) return null;
  if (v.machine !== undefined && !isInboxId('ibx', v.machine)) return null;
  const project = typeof v.project === 'string' ? oneLine(v.project) : '';
  return {
    thread_id: v.thread_id,
    title: v.title,
    label: v.label,
    at: v.at,
    ...(project ? { project } : {}),
    ...(v.archived === true ? { archived: true } : {}),
    ...(typeof v.machine === 'string' ? { machine: v.machine } : {}),
  };
}

/**
 * The mentions that stand in `body`: well formed, each label exactly at its `at`, in order, none overlapping, at
 * most the max. Anything else is dropped (its words stay as plain words). Never throws: a save is never refused for it.
 */
export function standingReplyMentions(body: string, list: unknown): InboxReplyMention[] {
  if (!Array.isArray(list)) return [];
  const kept: InboxReplyMention[] = [];
  const all = list.map(mentionOf).filter((m): m is InboxReplyMention => m !== null && body.startsWith(m.label, m.at));
  all.sort((a, b) => a.at - b.at);
  let end = 0;
  for (const m of all) {
    if (m.at < end || kept.length >= INBOX_REPLY_MENTIONS_MAX) continue;
    kept.push(m);
    end = m.at + m.label.length;
  }
  return kept;
}

/**
 * The part of `from` an edit replaced, and what it became in `to`: `[start, fromEnd)` in `from` is `[start, toEnd)` in
 * `to`. `told`: the caret placed it (else it is the first place that explains the change, which repeated letters can
 * leave ambiguous).
 */
function editOf(from: string, to: string, caret?: number | null): { start: number; fromEnd: number; toEnd: number; told?: true } {
  const grow = to.length - from.length;
  // The caret after the edit tells an ambiguous one apart ("CI" typed before "CI"): an insertion ending at it, or a
  // deletion starting there, when that explains the change.
  if (typeof caret === 'number' && caret >= 0 && caret <= to.length) {
    if (grow > 0 && caret - grow >= 0 && to.slice(0, caret - grow) === from.slice(0, caret - grow) && to.slice(caret) === from.slice(caret - grow)) {
      return { start: caret - grow, fromEnd: caret - grow, toEnd: caret, told: true };
    }
    if (grow < 0 && to.slice(0, caret) === from.slice(0, caret) && to.slice(caret) === from.slice(caret - grow)) {
      return { start: caret, fromEnd: caret - grow, toEnd: caret, told: true };
    }
  }
  let start = 0;
  const most = Math.min(from.length, to.length);
  while (start < most && from[start] === to[start]) start++;
  let tail = 0;
  while (tail < most - start && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++;
  return { start, fromEnd: from.length - tail, toEnd: to.length - tail };
}

/**
 * The mentions of `from` as they stand in `to`, after one edit (`caret`: where the caret is after it, when known): a
 * mention before the edit stays, one after it moves with it, one the edit touched ends. Words never become a mention.
 */
export function remapReplyMentions(mentions: readonly InboxReplyMention[], from: string, to: string, caret?: number | null): InboxReplyMention[] {
  if (from === to) return [...mentions];
  if (mentions.length === 0) return [];
  const edit = clearOfMentions(editOf(from, to, caret), mentions, from, to);
  const shift = edit.toEnd - edit.fromEnd;
  const out: InboxReplyMention[] = [];
  for (const m of mentions) {
    const end = m.at + m.label.length;
    if (end <= edit.start) out.push(m);
    else if (m.at >= edit.fromEnd) out.push({ ...m, at: m.at + shift });
  }
  return standingReplyMentions(to, out);
}

/** How far an ambiguous edit is slid looking for a place clear of the mentions. */
const SLIDE_MAX = 64;

/**
 * An insertion or deletion no caret placed can often sit in several places that explain the change the same way
 * ("M" typed before "Mn 1" reads as typed after its "M"). Of those, the nearest one that touches no mention: an edit
 * never ends a mention it did not touch. One the caret placed, or a replacement, is as it is.
 */
function clearOfMentions(edit: ReturnType<typeof editOf>, mentions: readonly InboxReplyMention[], from: string, to: string): ReturnType<typeof editOf> {
  if (edit.told) return edit;
  const inserted = edit.toEnd - edit.start;
  const removed = edit.fromEnd - edit.start;
  if ((inserted > 0) === (removed > 0)) return edit;
  const touches = (at: number) =>
    mentions.some((m) => {
      const end = m.at + m.label.length;
      return removed > 0 ? at < end && at + removed > m.at : at > m.at && at < end;
    });
  if (!touches(edit.start)) return edit;
  // Every place at or before the first that explains it: the words before it match (they did up to `start`).
  for (let at = edit.start - 1; at >= Math.max(0, edit.start - SLIDE_MAX); at--) {
    const same = removed > 0 ? from.slice(at + removed) === to.slice(at) : from.slice(at) === to.slice(at + inserted);
    if (!same) break;
    if (!touches(at)) return removed > 0 ? { start: at, fromEnd: at + removed, toEnd: at } : { start: at, fromEnd: at, toEnd: at + inserted };
  }
  return edit;
}

/** The words with each mention's label replaced by its title as listed (a draft read the way its sent words read back). */
export function inboxReplyMentionTitles(body: string, mentions: readonly InboxReplyMention[]): string {
  let out = '';
  let at = 0;
  for (const m of standingReplyMentions(body, mentions)) {
    out += body.slice(at, m.at) + listedTitle(m.title);
    at = m.at + m.label.length;
  }
  return out + body.slice(at);
}

/** The line for a mention a machine must update before the agent reads it: the thread's machine, or the reader's own. */
function needsUpdateLine(reach: Exclude<InboxThreadMentionReach, boolean>): string {
  const thread = oneLine(reach.thread) || 'another machine';
  const reader = oneLine(reach.reader) || 'your machine';
  return reach.update === 'thread' ? INBOX_THREAD_MENTION_WORDS.needsUpdate(thread) : INBOX_THREAD_MENTION_WORDS.readerNeedsUpdate(thread, reader);
}

/**
 * The words the agent reads: each mention's label replaced, at its spot, by its reference, then a blank line and the
 * list, each thread once in the order first mentioned. `readable`: whether the agent's own Inbox can read the thread,
 * its own or a linked machine's (else it is told it cannot open it, or which machine must update first). No mention
 * standing: the words as they are.
 */
export function inboxThreadMentionWords(words: string, mentions: readonly InboxReplyMention[], readable: (mention: InboxReplyMention) => InboxThreadMentionReach = () => true): string {
  const W = INBOX_THREAD_MENTION_WORDS;
  const standing = standingReplyMentions(words, mentions);
  if (standing.length === 0) return words;
  const order = new Map<string, { n: number; mention: InboxReplyMention }>();
  let out = '';
  let at = 0;
  for (const m of standing) {
    if (!order.has(m.thread_id)) order.set(m.thread_id, { n: order.size + 1, mention: m });
    out += words.slice(at, m.at) + W.inline(order.get(m.thread_id)!.n, m.thread_id);
    at = m.at + m.label.length;
  }
  out += words.slice(at);
  const lines: string[] = [W.heading];
  for (const { n, mention } of order.values()) {
    lines.push(W.item(n, mention.thread_id), W.title(inboxThreadMentionTitleData(mention.title)));
    const details = W.details(mention);
    if (details) lines.push(W.detailsLine(details));
    const reach = readable(mention);
    lines.push(reach === true ? W.read(mention.thread_id) : reach === false ? W.unreadable : needsUpdateLine(reach));
  }
  return `${out.trimEnd()}\n\n${lines.join('\n')}`;
}

const ITEM_LINE = /^(\d{1,3})\. (msg_[A-Za-z0-9]{6,64})$/;
const TITLE_LINE = (() => {
  const [head] = INBOX_THREAD_MENTION_WORDS.title('\u0000').split('\u0000');
  return { head: head! };
})();
const INDENT = '   ';

/** A list's title line read back: the title, or null when the line is not one. */
function titleOfLine(line: string): string | null {
  if (!line.startsWith(TITLE_LINE.head)) return null;
  try {
    const value = JSON.parse(line.slice(TITLE_LINE.head.length)) as unknown;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** A mention the list names: its number, id and title. */
interface ListedMention {
  n: number;
  id: string;
  title: string;
}

/**
 * A body split from its mention list: the threads the list names and the body without the list, or null when it
 * holds none. The list starts at a line that is exactly the heading, right after a blank line (or the start), and
 * runs through its item, title and indented lines; what follows it (the answers the store adds) stays.
 */
export function splitInboxThreadMentions(body: string): { mentions: ListedMention[]; rest: string } | null {
  if (!body.includes(INBOX_THREAD_MENTION_WORDS.heading)) return null;
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== INBOX_THREAD_MENTION_WORDS.heading || (i > 0 && lines[i - 1]!.trim() !== '')) continue;
    const mentions: ListedMention[] = [];
    let end = i + 1;
    while (end < lines.length) {
      const item = ITEM_LINE.exec(lines[end]!);
      const title = item ? titleOfLine(lines[end + 1] ?? '') : null;
      if (item && title !== null) {
        mentions.push({ n: Number(item[1]), id: item[2]!, title });
        end += 2;
      } else if (mentions.length > 0 && lines[end]!.startsWith(INDENT) && lines[end]!.trim() !== '') end++;
      else break;
    }
    if (mentions.length === 0) continue;
    const before = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    const after = lines.slice(end).join('\n').replace(/^\n+/, '');
    return { mentions, rest: before && after ? `${before}\n\n${after}` : before || after };
  }
  return null;
}

/** Each reference in `text` drawn by `draw`, in order: `at` where its drawing starts in the result. */
function drawInline(text: string, mentions: readonly ListedMention[], draw: (m: ListedMention) => string): { text: string; drawn: { m: ListedMention; at: number; length: number }[] } {
  const refs = mentions.map((m) => ({ m, ref: INBOX_THREAD_MENTION_WORDS.inline(m.n, m.id) }));
  let out = '';
  let at = 0;
  const drawn: { m: ListedMention; at: number; length: number }[] = [];
  for (;;) {
    let next: { m: ListedMention; ref: string; index: number } | null = null;
    for (const r of refs) {
      const index = text.indexOf(r.ref, at);
      if (index >= 0 && (!next || index < next.index)) next = { ...r, index };
    }
    if (!next) break;
    out += text.slice(at, next.index);
    const shown = draw(next.m);
    drawn.push({ m: next.m, at: out.length, length: shown.length });
    out += shown;
    at = next.index + next.ref.length;
  }
  return { text: out + text.slice(at), drawn };
}

/** Markdown link text: the characters that would end or break it escaped. */
const linkText = (title: string) => title.replace(/[\\[\]`*_~]/g, (c) => `\\${c}`);

/** A sent mention's link: the Inbox's own route to the thread, marked as a mention (`&mention`) for its look. */
export const inboxThreadMentionHref = (id: string) => `#thread=${id}&mention`;

/**
 * A person's words as the window draws them: each mention a link to its thread, and the list left out. The body as
 * it is when it holds no list.
 */
export function linkInboxThreadMentions(body: string): string {
  const split = splitInboxThreadMentions(body);
  if (!split) return body;
  return drawInline(split.rest, split.mentions, (m) => `[${linkText(inboxThreadMentionTitle(m.title))}](${inboxThreadMentionHref(m.id)})`).text;
}

/** A person's words for a preview or snippet: each mention its title alone, and the list left out. */
export function withoutInboxThreadMentions(body: string): string {
  const split = splitInboxThreadMentions(body);
  if (!split) return body;
  return drawInline(split.rest, split.mentions, (m) => inboxThreadMentionTitle(m.title)).text;
}

/** A sent reply's words back as a draft (Take back): each mention its title again, kept as a mention, the list gone. */
export function inboxThreadMentionsTakenBack(body: string): { body: string; mentions: InboxReplyMention[] } {
  const split = splitInboxThreadMentions(body);
  if (!split) return { body, mentions: [] };
  const back = drawInline(split.rest, split.mentions, (m) => inboxThreadMentionTitle(m.title));
  const mentions = back.drawn.map(({ m, at }) => ({ thread_id: m.id, title: inboxThreadMentionTitle(m.title), label: inboxThreadMentionTitle(m.title), at }));
  return { body: back.text, mentions: standingReplyMentions(back.text, mentions) };
}
