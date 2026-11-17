/**
 * Threads mentioned in a reply (approval "inbox-drag-threads", piece 1, treatment A "in the words").
 *
 * A mention is a token the draft carries: the thread's id, its title when it was mentioned, and the range its label
 * holds in the words (`InboxReplyMention`, core inbox-thread-mention.ts). It is saved with the draft
 * (`InboxReplyDraft.mentions`), so another device, a reload or Take back has it too, and it goes with the draft at
 * Send or Discard. Nothing here is ever recovered from the words: an edit moves the mentions after it, ends any it
 * touches (its words stay as plain words), and words never become a mention.
 *
 * Per reply (the thread it answers) this module holds two views: the box's (its words and mentions after the
 * person's last edit, `commitReplyEdit`) and the draft's (as the Inbox last answered it, `noteDraftMentions`). The
 * words on screen take the mentions of the one that holds exactly those words, else the box's moved by the change
 * (`mentionsFor`). The field paints them and the Send writes them (`replyWordsWithMentions`), so what the box shows
 * is what is sent.
 *
 * It is also the one way into a reply box from outside it: the row menu's Mention in reply, a drop and the phone's
 * sheet all call `requestMention`. The box that is open for that thread takes the mention at once; a closed one opens
 * (`useMentionBoxOpener`) and takes it as its field mounts.
 */
import { useEffect, useRef } from 'react';
import { inboxThreadMentionWords, remapReplyMentions, standingReplyMentions } from '@plannotator/core/inbox-thread-mention';
import type { InboxReplyDraft, InboxReplyMention } from '@plannotator/core/inbox-types';
import { readRoute } from './app/route';
import { writeRoute } from './app/writeRoute';
import { machineOf, selfMachineId } from './inboxUrl';

/** A thread as a mention names it: its id, title, project, whether it is archived, and the machine whose Inbox holds it. */
export interface MentionRef {
  id: string;
  title: string;
  project?: string | null;
  archived?: boolean;
  /** The linked machine whose Inbox holds the thread (absent: this window's own Inbox). */
  machine?: string | null;
}

/** The project after the title only when it is not the reply's own ("Rate limit for the public API · ledger-api"). */
export function mentionLabel(ref: Pick<MentionRef, 'title' | 'project'>, replyProject: string | null): string {
  return ref.project && replyProject !== null && ref.project !== replyProject ? `${ref.title} · ${ref.project}` : ref.title;
}

/** A mention of `ref` at `at` in the words, as the draft keeps it. */
export function mentionAt(ref: MentionRef, label: string, at: number): InboxReplyMention {
  return {
    thread_id: ref.id,
    title: ref.title,
    label,
    at,
    ...(ref.project ? { project: ref.project } : {}),
    ...(ref.archived ? { archived: true } : {}),
    ...(ref.machine ? { machine: ref.machine } : {}),
  };
}

// ── The mentions of each reply ─────────────────────────────────────────────────────────────────────────────────────

type Held = { text: string; mentions: readonly InboxReplyMention[] };
/** The box's words and mentions after the person's last edit, per reply. */
const boxes = new Map<string, Held>();
/** The draft's words and mentions as the Inbox last answered, per reply. */
const drafts = new Map<string, Held>();
/**
 * The words each reply's box has had and the mentions they last held, newest last (at most `UNDO_KEPT`): the browser's
 * own undo and redo put earlier words back, and with them those mentions. `sets`: every set of mentions (threads and
 * places) those exact words have held; with more than one, an undo to them cannot tell which, and brings back none.
 */
type Remembered = Held & { sets: Set<string> };
const undoable = new Map<string, Remembered[]>();
const UNDO_KEPT = 100;
const setOf = (mentions: readonly InboxReplyMention[]) => mentions.map((m) => `${m.thread_id}@${m.at}`).join(',');
function remember(threadId: string, held: Held): void {
  const list = undoable.get(threadId) ?? [];
  const was = list.find((h) => h.text === held.text);
  const sets = new Set(was?.sets ?? []);
  if (held.mentions.length > 0) sets.add(setOf(held.mentions));
  const next = list.filter((h) => h !== was);
  next.push({ ...held, sets });
  if (next.length > UNDO_KEPT) next.shift();
  undoable.set(threadId, next);
}
/** What an undo or redo to `text` brings back: its last mentions, unless those words held others too (or none since). */
function restorable(threadId: string, text: string): readonly InboxReplyMention[] | null {
  const held = undoable.get(threadId)?.find((h) => h.text === text);
  return held && held.mentions.length > 0 && held.sets.size === 1 ? held.mentions : null;
}
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version += 1;
  for (const listener of [...listeners]) listener();
};

export function subscribeReplyMentions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Raised by every change here (a store snapshot). */
export function replyMentionsVersion(): number {
  return version;
}

const NONE: readonly InboxReplyMention[] = [];

/** The mentions `held` has, as they stand in `text`: as held, or moved by the change (one edit, or the words trimmed). */
function heldIn(held: Held, text: string): readonly InboxReplyMention[] | null {
  if (held.text === text) return held.mentions;
  const lead = held.text.length - held.text.trimStart().length;
  if (held.text.trim() === text) return standingReplyMentions(text, held.mentions.map((m) => ({ ...m, at: m.at - lead })));
  return null;
}

/**
 * The mentions standing in the reply's words `text`: those of the view (box, then draft) that holds exactly these
 * words (or them trimmed, as a Send takes them), else the box's (or the draft's) moved by the change. Never words
 * matched against titles.
 */
export function mentionsFor(threadId: string, text: string): readonly InboxReplyMention[] {
  const box = boxes.get(threadId);
  const draft = drafts.get(threadId);
  const exact = (box && heldIn(box, text)) ?? (draft && heldIn(draft, text));
  if (exact) return exact;
  const from = box ?? draft;
  if (!from || from.mentions.length === 0) return NONE;
  return remapReplyMentions(from.mentions, from.text, text);
}

/** The draft as the Inbox holds it now (a read, a save's answer; null: none): its mentions, for the words it holds. */
export function noteDraftMentions(threadId: string, draft: Pick<InboxReplyDraft, 'body' | 'mentions'> | null | undefined): void {
  const was = drafts.get(threadId);
  if (!draft) {
    if (drafts.delete(threadId)) changed();
    return;
  }
  const mentions = standingReplyMentions(draft.body, draft.mentions ?? []);
  if (was && was.text === draft.body && sameMentions(was.mentions, mentions)) return;
  drafts.set(threadId, { text: draft.body, mentions });
  changed();
}

const sameMentions = (a: readonly InboxReplyMention[], b: readonly InboxReplyMention[]) =>
  a.length === b.length && a.every((m, i) => m.thread_id === b[i]!.thread_id && m.at === b[i]!.at && m.label === b[i]!.label && m.title === b[i]!.title);

/**
 * What a save of the reply's words `text` says of its mentions: those standing in them, once this window knows the
 * reply's mentions (the person edited here, or a draft was read). Otherwise nothing: the draft keeps its own, moved
 * with its words (a window that never knew them never drops them).
 */
export function replyMentionsSave(threadId: string, text: string): { mentions?: readonly InboxReplyMention[] } {
  return boxes.has(threadId) || drafts.has(threadId) ? { mentions: mentionsFor(threadId, text) } : {};
}

/**
 * The person changed the words from `from` to `to` (`caret`: where the caret is after it): the mentions move with them.
 * `undo`: the browser's undo or redo did it (`historyUndo`, `historyRedo`), so words the box had before come back with
 * the mentions they held then (⌘Z after Backspace took a mention brings the mention back, not only its words).
 */
export function commitReplyEdit(threadId: string, from: string, to: string, caret?: number | null, undo = false): void {
  if (from === to && boxes.get(threadId)?.text === to) return;
  const before = mentionsFor(threadId, from);
  const box = boxes.get(threadId);
  if (before.length > 0) remember(threadId, { text: from, mentions: before });
  const back = undo ? restorable(threadId, to) : null;
  if (back) {
    boxes.set(threadId, { text: to, mentions: standingReplyMentions(to, back) });
    changed();
    return;
  }
  if (before.length === 0 && (!box || box.mentions.length === 0)) {
    if (box) boxes.set(threadId, { text: to, mentions: NONE });
    // Words typed by hand: the newest truth for them is no mention, so a later undo to them brings none back.
    if (!undo && undoable.has(threadId)) remember(threadId, { text: to, mentions: NONE });
    return;
  }
  const mentions = remapReplyMentions(before, from, to, caret);
  boxes.set(threadId, { text: to, mentions });
  remember(threadId, { text: to, mentions });
  changed();
}

/** New mentions in the words `text` (just typed in): beside those already standing, one per range. */
export function addReplyMentions(threadId: string, text: string, added: readonly InboxReplyMention[]): void {
  const held = { text, mentions: standingReplyMentions(text, [...mentionsFor(threadId, text), ...added]) };
  boxes.set(threadId, held);
  remember(threadId, held);
  changed();
}

/** The reply was sent or discarded: its mentions go with its words (the draft's, as the Inbox answers next, stay apart). */
export function clearReplyMentions(threadId: string, opts: { draft?: boolean } = {}): void {
  undoable.delete(threadId);
  const had = boxes.delete(threadId);
  const hadDraft = opts.draft ? drafts.delete(threadId) : false;
  if (had || hadDraft) changed();
}

/** For a test: forget every reply's mentions and the last reply. */
export function resetReplyMentionsForTests(): void {
  boxes.clear();
  undoable.clear();
  drafts.clear();
  lastReply = undefined;
  try {
    storage()?.removeItem(LAST_KEY);
  } catch {
    // No storage: nothing kept there.
  }
  changed();
}

/** The machine whose Inbox the reply's agent reads: the reply thread's (every recipient of a reply is a session there). */
export function replyReaderMachine(threadId: string): string | null {
  return machineOf(threadId) ?? selfMachineId();
}

/** Whether the agent the reply to `threadId` goes to can open the mentioned thread (its Inbox holds it). */
export function mentionReadable(threadId: string, mention: { machine?: string | null }): boolean {
  return (mention.machine ?? selfMachineId()) === replyReaderMachine(threadId);
}

/** The words the agent reads for this reply: each mention standing in them in its place, then the list (core). */
export function replyWordsWithMentions(threadId: string, words: string): string {
  const mentions = mentionsFor(threadId, words);
  if (mentions.length === 0) return words;
  return inboxThreadMentionWords(words, mentions, (m) => mentionReadable(threadId, m));
}

/** A drop never splits a word: an offset inside one moves to its end. */
export function snapToWordEnd(text: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, text.length));
  while (at > 0 && at < text.length && /\S/.test(text[at - 1]!) && /\S/.test(text[at]!)) at++;
  return at;
}

/**
 * The words with labels put in at `offset` (several are comma separated), with the spaces the spot needs: one before
 * unless it follows a space or starts the words, one after unless a space already follows. `caret`: just after them;
 * `starts`: where each label starts in the new words.
 */
export function withMentionsAt(text: string, offset: number, labels: readonly string[]): { text: string; caret: number; insert: string; at: number; starts: number[] } {
  const at = Math.max(0, Math.min(offset, text.length));
  const before = text[at - 1];
  const after = text[at];
  const lead = before !== undefined && !/\s/.test(before) ? ' ' : '';
  const trail = after !== undefined && /\s/.test(after) ? '' : ' ';
  const insert = `${lead}${labels.join(', ')}${trail}`;
  const starts: number[] = [];
  let next = at + lead.length;
  for (const label of labels) {
    starts.push(next);
    next += label.length + 2;
  }
  return { text: `${text.slice(0, at)}${insert}${text.slice(at)}`, caret: at + insert.length, insert, at, starts };
}

/**
 * Backspace with the caret right after a mention (or after the one space a mention put after it) takes the mention
 * whole, and that space. Null: an ordinary Backspace.
 */
export function backspaceMention(text: string, caret: number, mentions: readonly InboxReplyMention[]): { text: string; caret: number; mention: InboxReplyMention } | null {
  for (const m of standingReplyMentions(text, mentions)) {
    const end = m.at + m.label.length;
    const spaced = end < text.length && text[end] === ' ' && caret === end + 1;
    if (caret !== end && !spaced) continue;
    const to = spaced ? end + 1 : end;
    return { text: `${text.slice(0, m.at)}${text.slice(to)}`, caret: m.at, mention: m };
  }
  return null;
}

// ── The way in from outside the box ────────────────────────────────────────────────────────────────────────────────

/** A reply box's field, open for its thread: it puts mentions in (at its caret, else at the end of its words). */
type MentionTaker = (refs: readonly MentionRef[]) => void;
const takers = new Map<string, MentionTaker>();
const waiting = new Map<string, MentionRef[]>();
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
export function requestMention(threadId: string, refs: readonly MentionRef[]): void {
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

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The reply the person last wrote in (the menu names it, and it is the reply when no thread is open). */
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
 * wrote in (a phone, or no thread open). `open`: whether that reply is the thread open now (the menu names it when not).
 * Null: none, and the item is not offered.
 */
export function mentionTarget(phone: boolean): { thread: string; open: boolean } | null {
  const route = readRoute();
  const open = !phone && (route.page === 'inbox' || route.page === 'reviews') ? (route.thread ?? null) : null;
  if (open) return { thread: open, open: true };
  const last = lastReplyThread();
  return last ? { thread: last, open: false } : null;
}

/**
 * Mention these threads in the reply `target`. A phone (or a computer with that thread not open) goes to the thread
 * first: its box opens with the mention at the end of its words.
 */
export function mentionInReply(target: string, refs: readonly MentionRef[]): void {
  const route = readRoute();
  if (route.thread !== target && !mentionTakerOpen(target)) writeRoute({ ...route, page: route.page === 'reviews' ? 'reviews' : 'inbox', thread: target, file: null, msg: null });
  requestMention(target, refs);
}
