/**
 * Threads mentioned in a reply (approval "inbox-drag-threads", piece 1, treatment A "in the words").
 *
 * The reply box holds plain words; a mention is a thread's label (its title, and its project when that is not the
 * reply's) standing in them. This module keeps, per reply (the thread it answers), which threads the person mentioned
 * and under which label, so the field paints each label that still stands as a token and the Send writes the words
 * the agent reads (core inbox-thread-mention.ts). Typing inside a label turns it back into plain words: it no longer
 * matches. The list is kept in this browser (localStorage), so a reload or another thread and back keeps the tokens.
 *
 * It is also the one way into a reply box from outside it: the row menu's Mention in reply, a drop and the phone's
 * sheet all call `requestMention`. The box that is open for that thread takes the mention at once; a closed one opens
 * (`useMentionBoxOpener`) and takes it as its field mounts.
 */
import { useEffect, useRef } from 'react';
import { inboxThreadMentionWords, type InboxThreadMentionRef, type InboxThreadMentionSpan } from '@plannotator/core/inbox-thread-mention';
import { readRoute } from './app/route';
import { writeRoute } from './app/writeRoute';

/** A mention as the reply box holds it: the thread, and the label its words show. */
export interface ReplyMention extends InboxThreadMentionRef {
  label: string;
}

/** The project after the title only when it is not the reply's own ("Rate limit for the public API · ledger-api"). */
export function mentionLabel(ref: InboxThreadMentionRef, replyProject: string | null): string {
  return ref.project && replyProject !== null && ref.project !== replyProject ? `${ref.title} · ${ref.project}` : ref.title;
}

const STORE_KEY = 'plannotator-inbox-reply-mentions';
/** At most this many replies keep their mentions (the oldest goes), and this many mentions each. */
const REPLIES_MAX = 60;
const PER_REPLY_MAX = 40;

type Saved = Record<string, { at: number; mentions: ReplyMention[] }>;
let saved: Saved | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function load(): Saved {
  if (saved) return saved;
  saved = {};
  try {
    const raw = storage()?.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [thread, entry] of Object.entries(parsed as Saved)) {
        if (entry && Array.isArray(entry.mentions)) saved[thread] = { at: Number(entry.at) || 0, mentions: entry.mentions.filter((m) => m && typeof m.id === 'string' && typeof m.label === 'string' && m.label !== '') };
      }
    }
  } catch {
    // Unreadable: none kept.
  }
  return saved;
}

function persist(): void {
  const all = load();
  const threads = Object.keys(all).sort((a, b) => all[b]!.at - all[a]!.at);
  for (const thread of threads.slice(REPLIES_MAX)) delete all[thread];
  try {
    storage()?.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // Full or refused: the mentions still work on this page.
  }
  for (const listener of [...listeners]) listener();
}

const NONE: readonly ReplyMention[] = [];

/** Every mention this reply has had, oldest first (a label may no longer stand in the words). The same array until it changes (a store snapshot). */
export function replyMentions(threadId: string): readonly ReplyMention[] {
  return load()[threadId]?.mentions ?? NONE;
}

/** Keep these mentions for the reply (one per thread: a newer label replaces the older). */
export function keepReplyMentions(threadId: string, mentions: readonly ReplyMention[]): void {
  if (mentions.length === 0) return;
  const all = load();
  const ids = new Set(mentions.map((m) => m.id));
  const kept = [...(all[threadId]?.mentions ?? []).filter((m) => !ids.has(m.id)), ...mentions].slice(-PER_REPLY_MAX);
  all[threadId] = { at: Date.now(), mentions: kept };
  persist();
}

/** For a test: forget every reply's mentions and the last reply, here and in storage. */
export function resetReplyMentionsForTests(): void {
  saved = null;
  lastReply = undefined;
  try {
    storage()?.removeItem(STORE_KEY);
    storage()?.removeItem(LAST_KEY);
  } catch {
    // No storage: nothing kept there.
  }
}

export function subscribeReplyMentions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One label standing in the words: which mention, and where. */
export interface MentionSpan {
  mention: ReplyMention;
  start: number;
  end: number;
}

/**
 * Where the mentions' labels stand in the words, in order, never overlapping: at one place the longest label wins (a
 * title that starts another), and every place a label stands counts (what is painted is what is sent).
 */
export function mentionSpans(text: string, mentions: readonly ReplyMention[]): MentionSpan[] {
  const found: MentionSpan[] = [];
  for (const mention of mentions) {
    if (!mention.label) continue;
    for (let at = text.indexOf(mention.label); at >= 0; at = text.indexOf(mention.label, at + mention.label.length)) {
      found.push({ mention, start: at, end: at + mention.label.length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: MentionSpan[] = [];
  let pos = 0;
  for (const span of found) {
    if (span.start < pos) continue;
    out.push(span);
    pos = span.end;
  }
  return out;
}

/** The words the agent reads for this reply: each standing mention in its place, then the list (core). */
export function replyWordsWithMentions(threadId: string, words: string): string {
  const spans = mentionSpans(words, replyMentions(threadId));
  if (spans.length === 0) return words;
  return inboxThreadMentionWords(words, spans.map((s): InboxThreadMentionSpan => ({ ref: s.mention, start: s.start, end: s.end })));
}

/** A drop never splits a word: an offset inside one moves to its end. */
export function snapToWordEnd(text: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, text.length));
  while (at > 0 && at < text.length && /\S/.test(text[at - 1]!) && /\S/.test(text[at]!)) at++;
  return at;
}

/**
 * The words with labels put in at `offset` (several are comma separated), with the spaces the spot needs: one before
 * unless it follows a space or starts the words, one after unless a space already follows. `caret`: just after them.
 */
export function withMentionsAt(text: string, offset: number, labels: readonly string[]): { text: string; caret: number; insert: string; at: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  const before = text[at - 1];
  const after = text[at];
  const lead = before !== undefined && !/\s/.test(before) ? ' ' : '';
  const trail = after !== undefined && /\s/.test(after) ? '' : ' ';
  const insert = `${lead}${labels.join(', ')}${trail}`;
  return { text: `${text.slice(0, at)}${insert}${text.slice(at)}`, caret: at + insert.length, insert, at };
}

/**
 * Backspace with the caret right after a label (or after the one space a mention put after it) takes the label
 * whole, and that space. Null: an ordinary Backspace.
 */
export function backspaceMention(text: string, caret: number, mentions: readonly ReplyMention[]): { text: string; caret: number; mention: ReplyMention } | null {
  for (const span of mentionSpans(text, mentions)) {
    const spaced = span.end < text.length && text[span.end] === ' ' && caret === span.end + 1;
    if (caret !== span.end && !spaced) continue;
    const from = span.start;
    const to = spaced ? span.end + 1 : span.end;
    return { text: `${text.slice(0, from)}${text.slice(to)}`, caret: from, mention: span.mention };
  }
  return null;
}

// ── The way in from outside the box ────────────────────────────────────────────────────────────────────────────────

/** A reply box's field, open for its thread: it puts mentions in (at its caret, else at the end of its words). */
type MentionTaker = (refs: readonly InboxThreadMentionRef[]) => void;
const takers = new Map<string, MentionTaker>();
const waiting = new Map<string, InboxThreadMentionRef[]>();
const openers = new Map<string, () => void>();

/** The reply box's field registers while it is mounted; what waited for it goes in at once. */
export function registerMentionTaker(threadId: string, take: MentionTaker): () => void {
  takers.set(threadId, take);
  const queued = waiting.get(threadId);
  if (queued) {
    waiting.delete(threadId);
    // After the box has drawn its words (it opened for these).
    setTimeout(() => takers.get(threadId)?.(queued), 0);
  }
  return () => {
    if (takers.get(threadId) === take) takers.delete(threadId);
  };
}

/** Whether a reply box is open for this thread now. */
export function mentionTakerOpen(threadId: string): boolean {
  return takers.has(threadId);
}

/** Put these threads in the reply to `threadId`: the open box takes them now; a closed one opens and takes them. */
export function requestMention(threadId: string, refs: readonly InboxThreadMentionRef[]): void {
  const shown = refs.filter((ref) => ref.id !== threadId);
  if (shown.length === 0) return;
  const take = takers.get(threadId);
  if (take) {
    take(shown);
    return;
  }
  waiting.set(threadId, [...(waiting.get(threadId) ?? []), ...shown]);
  openers.get(threadId)?.();
}

/**
 * The thread pane's half: a mention asked for while its box is closed opens the box (`open`, the pane's own opener),
 * unless a Send is on its way (the box takes no words then; it opens once the Send ends).
 */
export function useMentionBoxOpener(threadId: string, boxOpen: boolean, busy: boolean, open: () => void): void {
  const openRef = useRef(open);
  openRef.current = open;
  const state = useRef({ boxOpen, busy });
  state.current = { boxOpen, busy };
  useEffect(() => {
    const opener = () => {
      if (!state.current.boxOpen && !state.current.busy) openRef.current();
    };
    openers.set(threadId, opener);
    if (waiting.has(threadId)) opener();
    return () => {
      if (openers.get(threadId) === opener) openers.delete(threadId);
    };
  }, [threadId]);
  useEffect(() => {
    if (!busy && !boxOpen && waiting.has(threadId)) openRef.current();
  }, [busy, boxOpen, threadId]);
}

// ── Which reply a menu's Mention in reply goes to ──────────────────────────────────────────────────────────────────

const LAST_KEY = 'plannotator-inbox-last-reply';
let lastReply: string | null | undefined;

/** The reply the person last wrote in (a phone's sheet names it, and it is the reply when no thread is open). */
export function noteReplyThread(threadId: string): void {
  if (lastReply === threadId) return;
  lastReply = threadId;
  try {
    storage()?.setItem(LAST_KEY, threadId);
  } catch {
    // Refused: kept for this page only.
  }
}

function lastReplyThread(): string | null {
  if (lastReply === undefined) {
    try {
      lastReply = storage()?.getItem(LAST_KEY) ?? null;
    } catch {
      lastReply = null;
    }
  }
  return lastReply;
}

/**
 * The reply a Mention in reply goes to: the thread open beside the list (a computer), else the reply the person last
 * wrote in (a phone, or no thread open). Null: none, and the item is not offered.
 */
export function mentionTarget(phone: boolean): string | null {
  const route = readRoute();
  const open = !phone && (route.page === 'inbox' || route.page === 'reviews') ? (route.thread ?? null) : null;
  return open ?? lastReplyThread();
}

/**
 * Mention these threads in the reply `target`. A phone (or a computer with that thread not open) goes to the thread
 * first: its box opens with the mention at the end of its words.
 */
export function mentionInReply(target: string, refs: readonly InboxThreadMentionRef[]): void {
  const route = readRoute();
  if (route.thread !== target && !mentionTakerOpen(target)) writeRoute({ ...route, page: route.page === 'reviews' ? 'reviews' : 'inbox', thread: target, file: null, msg: null });
  requestMention(target, refs);
}
