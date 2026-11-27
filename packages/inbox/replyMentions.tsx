/**
 * The reply box's half of a thread mention (approval "inbox-drag-threads", piece 1, treatment A "in the words"):
 * the field paints each mention the draft carries as a token (`tokens`, painted like the `#` and `/` tokens), every
 * edit moves them (`commit`, threadMentions.ts), Backspace right after one takes it whole, a pasted thread link (or
 * thread id) of this Inbox becomes one, a mention the reply's agent cannot open is said under the field, and the box
 * is a drop target while a thread is dragged (threadDrag.ts, layer `reply`): a tint over the box, a pill that says
 * what a drop does, and a caret where the mention will land, snapped to the end of a word.
 *
 * What goes in is typed in as if by the person (one undo step, the host's onChange runs), so ⌘Z takes it back; the
 * browser's undo and redo also bring back the mentions the words had then (threadMentions.ts `commitReplyEdit`). A
 * token is one piece for the caret: a click or key that would put the caret inside one puts it at its nearer edge
 * (from an edge, a step in goes across it), so typing and pasting land beside it.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { SkillReferenceToken } from '@plannotator/ui/utils/skillReferences';
import type { InboxReplyMention } from '@plannotator/core/inbox-types';
import { useInboxQueryClient } from './data/client';
import { knownMentionRef, resolveMentionRef } from './data/threadMentionRefs';
import { registerThreadDropTarget, sayThreadDrag, THREAD_DROP_LAYER, type DropAnswer } from './threadDrag';
import {
  addReplyMentions,
  backspaceMention,
  commitReplyEdit,
  forgetReplyThread,
  mentionAt,
  mentionLabel,
  mentionReadable,
  mentionsFor,
  noteReplyThread,
  registerMentionTaker,
  replyMentionsVersion,
  snapToWordEnd,
  subscribeReplyMentions,
  withMentionsAt,
  type MentionRef,
} from './threadMentions';
import { isTouchScreen } from './phone';

/** A thread link this Inbox gave out (`…/#thread=msg_…`, Copy link), or a bare thread id: the thread's id, else null. */
export function pastedThreadId(text: string): string | null {
  const one = text.trim();
  if (/\s/.test(one)) return null;
  const bare = /^(msg_[0-9A-Za-z]{6,64})$/.exec(one);
  if (bare) return bare[1]!;
  const link = /^(?:https?:\/\/[^\s/#]+)?\/?#(?:[^\s#]*&)?thread=(msg_[0-9A-Za-z]{6,64})(?:&[^\s#]*)?$/.exec(one);
  return link ? link[1]! : null;
}

/**
 * The token's paint (inbox.css `[data-skill-ref-token^="ib-mention"]`): a thread, or an archived one in grey. The
 * prefix is no plugin's name, so a skill reference (`plugin:skill`) never paints as a mention.
 */
const tokenName = (m: InboxReplyMention) => `${m.archived ? 'ib-mention-archived' : 'ib-mention'}:${m.thread_id}`;

/** How a mention is named to assistive technology: its title, and what is not ordinary about it. */
function spokenMention(m: Pick<InboxReplyMention, 'title' | 'archived'> & { project?: string | null }, unreadable = false): string {
  const notes = [m.project ? `project ${m.project}` : null, m.archived ? 'archived' : null, unreadable ? 'its agent cannot open it' : null].filter(Boolean);
  return `${m.title}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/** The quiet line under the field when the reply's agent cannot open a mentioned thread (another machine's). */
export function unreadableMentionLine(titles: readonly string[]): string {
  return titles.length === 1
    ? `The agent you reply to is on another machine and cannot open “${titles[0]}”: it gets the title only.`
    : `The agent you reply to is on another machine and cannot open ${titles.length} of these threads: it gets their titles only.`;
}

/** The field's words at a point on screen, through its painted mirror (the textarea itself has no text positions). */
function offsetAtPoint(wrap: HTMLElement, x: number, y: number): number | null {
  const mirror = wrap.querySelector<HTMLElement>('.ib-rmirror');
  const field = wrap.querySelector<HTMLTextAreaElement>('textarea');
  if (!mirror || !field) return null;
  const doc = wrap.ownerDocument as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  // For the one reading, the mirror takes the hit and the textarea lets it through (no paint happens in between).
  const was = [mirror.style.pointerEvents, field.style.pointerEvents];
  mirror.style.pointerEvents = 'auto';
  field.style.pointerEvents = 'none';
  let node: Node | null = null;
  let offset = 0;
  try {
    if (typeof doc.caretRangeFromPoint === 'function') {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) [node, offset] = [range.startContainer, range.startOffset];
    } else if (typeof doc.caretPositionFromPoint === 'function') {
      const at = doc.caretPositionFromPoint(x, y);
      if (at) [node, offset] = [at.offsetNode, at.offset];
    }
  } finally {
    mirror.style.pointerEvents = was[0]!;
    field.style.pointerEvents = was[1]!;
  }
  if (!node || !mirror.contains(node)) return null;
  if (node.nodeType !== Node.TEXT_NODE) return field.value.length;
  // The words before it: every text node of the mirror ahead of this one, then the offset inside it.
  let count = 0;
  const walk = doc.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n === node) return Math.min(count + offset, field.value.length);
    count += n.textContent?.length ?? 0;
  }
  return null;
}

/** Where a caret at `offset` is drawn, relative to the field's box (null: not laid out). */
function caretBox(wrap: HTMLElement, offset: number): { left: number; top: number; height: number } | null {
  const mirror = wrap.querySelector<HTMLElement>('.ib-rmirror');
  if (!mirror) return null;
  const walk = wrap.ownerDocument.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (left <= len) {
      const range = wrap.ownerDocument.createRange();
      range.setStart(n, left);
      range.collapse(true);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      const box = wrap.getBoundingClientRect();
      if (!rect || (rect.height === 0 && rect.top === 0)) return null;
      return { left: rect.left - box.left, top: rect.top - box.top, height: rect.height || 20 };
    }
    left -= len;
  }
  return null;
}

/** The text typed in at `at` as the person would type it: one undo step, the host's onChange runs. */
function typeIn(field: HTMLTextAreaElement, at: number, insert: string, caret: number): void {
  let done = false;
  field.setSelectionRange(at, at);
  if (!isTouchScreen() && typeof document.execCommand === 'function') {
    field.focus({ preventScroll: true });
    if (document.activeElement === field) done = document.execCommand('insertText', false, insert);
  }
  if (!done) {
    // The prototype's setter, or React sees its own value and calls no onChange.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, `${field.value.slice(0, at)}${insert}${field.value.slice(at)}`);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  field.setSelectionRange(caret, caret);
}

/** The same for taking words out (`[from, to)`). */
function typeOut(field: HTMLTextAreaElement, from: number, to: number): void {
  let done = false;
  field.setSelectionRange(from, to);
  if (typeof document.execCommand === 'function' && document.activeElement === field) done = document.execCommand('delete', false);
  if (!done) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, `${field.value.slice(0, from)}${field.value.slice(to)}`);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  field.setSelectionRange(from, from);
}

/** The drop's look on the reply box (inbox.css): a faint tint while a thread is carried, the file-drop look over it. */
type DropLook = { answer: DropAnswer; over: boolean; count: number; caret: { left: number; top: number; height: number } | null };
const NO_LOOK: DropLook = { answer: null, over: false, count: 0, caret: null };

export interface ReplyMentionsHost {
  /** The thread the reply answers. */
  threadId: string;
  text: string;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  wrapRef: RefObject<HTMLDivElement | null>;
  /** A dictation take is live: what goes in lands at the end of the words, and the take follows it. */
  voiceLive: boolean;
  /** A field that takes no mentions (New message, compose, a comment): nothing here runs. */
  off?: boolean;
}

const NO_MENTIONS: readonly InboxReplyMention[] = [];

export function useReplyMentions({ threadId, text, fieldRef, wrapRef, voiceLive, off = false }: ReplyMentionsHost) {
  const client = useInboxQueryClient();
  const version = useSyncExternalStore(subscribeReplyMentions, replyMentionsVersion, replyMentionsVersion);
  // The mentions standing in the words on screen: the same ones the Send writes (threadMentions.ts `mentionsFor`).
  // `version`: read again when the store changes.
  const mentions = useMemo(() => (off ? NO_MENTIONS : mentionsFor(threadId, text)), [off, threadId, text, version]);
  const tokens = useMemo<SkillReferenceToken[]>(() => mentions.map((m) => ({ start: m.at, end: m.at + m.label.length, entry: { name: tokenName(m), root: 'plannotator', humanOnly: false } })), [mentions]);
  const describedId = `ib-tmention-${useId().replace(/:/g, '')}`;
  const noteId = `${describedId}-note`;
  const standing = useMemo(() => [...new Map(mentions.map((m) => [m.thread_id, m])).values()], [mentions]);
  // Worked out for the reply's own agent at every draw, so a change of reply (or of its machine) shows at once.
  const unreadable = standing.filter((m) => !mentionReadable(threadId, m));
  const live = useRef({ voiceLive });
  live.current = { voiceLive };
  /** The words as the field last had them: an edit is told from them to the new words. */
  const seen = useRef(text);
  seen.current = text;

  /**
   * The person changed the words (`caret`: where the caret is after it, when known): the mentions move with them.
   * `undo`: the browser's undo or redo, which brings back the mentions those words had.
   */
  const commit = useCallback(
    (next: string, caret?: number | null, undo = false) => {
      if (off) return;
      const from = seen.current;
      seen.current = next;
      commitReplyEdit(threadId, from, next, caret, undo);
    },
    [off, threadId],
  );

  /** Where the caret was last seen: a step in from a token's edge goes across it. */
  const lastCaret = useRef<number | null>(null);
  /** A caret inside a token moves to its nearer edge (across it, when it stepped in from one). */
  const onSelect = useCallback(() => {
    const field = fieldRef.current;
    if (off || !field) return;
    const at = field.selectionStart;
    const was = lastCaret.current;
    lastCaret.current = at;
    if (at !== field.selectionEnd) return;
    const inside = mentionsFor(threadId, field.value).find((m) => at > m.at && at < m.at + m.label.length);
    if (!inside) return;
    const end = inside.at + inside.label.length;
    const to = was === inside.at ? end : was === end ? inside.at : at - inside.at < end - at ? inside.at : end;
    field.setSelectionRange(to, to);
    lastCaret.current = to;
  }, [fieldRef, threadId, off]);

  /** A mention already in the words lights up instead of going in twice. */
  const flash = useCallback(
    (ids: readonly string[]) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      for (const id of ids) {
        for (const el of wrap.querySelectorAll<HTMLElement>(`[data-skill-ref-token$=":${CSS.escape(id)}"]`)) {
          el.removeAttribute('data-flash');
          void el.offsetWidth;
          el.setAttribute('data-flash', '');
          setTimeout(() => el.removeAttribute('data-flash'), 800);
        }
      }
    },
    [wrapRef],
  );

  /** Put mentions in at `where` (an offset; null: the caret when the field has focus, else the end of the words). */
  const putIn = useCallback(
    (refs: readonly MentionRef[], where: number | null) => {
      const field = fieldRef.current;
      if (!field || field.readOnly || field.disabled) return false;
      const now = field.value;
      const there = new Set(mentionsFor(threadId, now).map((m) => m.thread_id));
      const seen = new Set<string>();
      const fresh = refs.filter((ref) => ref.id !== threadId && !there.has(ref.id) && !seen.has(ref.id) && seen.add(ref.id));
      const again = refs.filter((ref) => there.has(ref.id)).map((ref) => ref.id);
      if (again.length) flash(again);
      if (fresh.length === 0) {
        if (again.length) sayThreadDrag('Already mentioned in your reply.');
        return true;
      }
      const replyProject = knownMentionRef(client, threadId)?.project ?? null;
      const labels = fresh.map((ref) => mentionLabel(ref, replyProject));
      const focused = field.ownerDocument.activeElement === field;
      const spot = live.current.voiceLive ? now.length : where ?? (focused ? field.selectionEnd : now.length);
      const put = withMentionsAt(now, besideMentions(now, snapToWordEnd(now, spot), mentionsFor(threadId, now)), labels);
      // Typed in first (the field's onChange moves the mentions already there), then the new ones join at their ranges.
      typeIn(field, put.at, put.insert, put.caret);
      if (field.value === put.text) addReplyMentions(threadId, field.value, fresh.map((ref, i) => mentionAt(ref, labels[i]!, put.starts[i]!)));
      noteReplyThread(threadId);
      requestAnimationFrame(() => flash(fresh.map((ref) => ref.id)));
      sayThreadDrag(`Mentioned ${fresh.map((ref) => spokenMention(ref, !mentionReadable(threadId, ref))).join(', ')} in your reply.`);
      return true;
    },
    [client, fieldRef, flash, threadId],
  );
  const putInRef = useRef(putIn);
  putInRef.current = putIn;

  // The reply the person writes in is the one a phone's Mention in reply goes to, until they empty it.
  useEffect(() => {
    if (off || !fieldRef.current || fieldRef.current.ownerDocument.activeElement !== fieldRef.current) return;
    if (text.trim() !== '') noteReplyThread(threadId);
    else forgetReplyThread(threadId);
  }, [off, text, threadId, fieldRef]);

  // The way in from outside: the row menu's Mention in reply, a phone's sheet.
  useEffect(() => (off ? undefined : registerMentionTaker(threadId, (refs) => void putInRef.current(refs, null))), [threadId, off]);

  // The drop target: the whole reply box (or full screen's card), only while a thread is carried.
  const [look, setLook] = useState<DropLook>(NO_LOOK);
  const boxOf = useCallback(() => wrapRef.current?.closest<HTMLElement>('.ib-rbox, .ib-fcomp') ?? wrapRef.current ?? null, [wrapRef]);
  useEffect(
    () =>
      off ? undefined : registerThreadDropTarget({
        element: boxOf,
        layer: THREAD_DROP_LAYER.reply,
        what: 'Mention',
        accepts: (ids) => {
          const field = fieldRef.current;
          if (!field || field.readOnly || field.disabled) return null;
          return ids.every((id) => id === threadId) ? 'refuse' : 'take';
        },
        show: (answer, ids) => {
          const box = boxOf();
          if (box) {
            if (answer) box.setAttribute('data-thread-drop', answer === 'refuse' ? 'refuse' : 'target');
            else box.removeAttribute('data-thread-drop');
          }
          setLook(answer ? { answer, over: false, count: ids.filter((id) => id !== threadId).length, caret: null } : NO_LOOK);
        },
        over: (point) => {
          const box = boxOf();
          const wrap = wrapRef.current;
          if (box && box.getAttribute('data-thread-drop') !== 'refuse') box.setAttribute('data-thread-drop', point ? 'over' : 'target');
          if (!point || !wrap) {
            setLook((l) => (l.over || l.caret ? { ...l, over: false, caret: null } : l));
            return;
          }
          const field = fieldRef.current;
          const raw = live.current.voiceLive ? (field?.value.length ?? 0) : offsetAtPoint(wrap, point.x, point.y);
          const caret = raw === null || !field ? null : caretBox(wrap, besideMentions(field.value, snapToWordEnd(field.value, raw), mentionsFor(threadId, field.value)));
          setLook((l) => (l.over && sameCaret(l.caret, caret) ? l : { ...l, over: true, caret }));
        },
        drop: (ids, point) => {
          const wrap = wrapRef.current;
          const field = fieldRef.current;
          const at = wrap && field && !live.current.voiceLive ? offsetAtPoint(wrap, point.x, point.y) : null;
          const refs = ids.filter((id) => id !== threadId).flatMap((id) => {
            const ref = knownMentionRef(client, id);
            return ref ? [ref] : [];
          });
          putInRef.current(refs, at ?? (field ? field.value.length : null));
        },
      }),
    [boxOf, client, fieldRef, threadId, wrapRef, off],
  );

  /** Backspace right after a mention takes it whole (an ordinary Backspace otherwise). True: it took the key. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (off || event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return false;
      const field = event.currentTarget;
      if (field.selectionStart !== field.selectionEnd) return false;
      const gone = backspaceMention(field.value, field.selectionStart, mentionsFor(threadId, field.value));
      if (!gone) return false;
      event.preventDefault();
      typeOut(field, gone.caret, gone.caret + (field.value.length - gone.text.length));
      sayThreadDrag(`Removed the mention of ${gone.mention.title}.`);
      return true;
    },
    [threadId, off],
  );

  /** A pasted thread link (or id) of this Inbox becomes a mention; anything else pastes as it would. */
  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
      const field = fieldRef.current;
      if (off || !field || event.target !== field || field.readOnly) return;
      if (event.clipboardData.files.length > 0) return;
      const pasted = event.clipboardData.getData('text/plain');
      const id = pastedThreadId(pasted);
      if (!id) return;
      const from = field.selectionStart;
      const to = field.selectionEnd;
      const known = knownMentionRef(client, id);
      if (known) {
        event.preventDefault();
        if (to > from) typeOut(field, from, to);
        putIn([known], from);
        return;
      }
      // Not in the list (an archived thread, one of another project): the link pastes as words at once, and one read
      // turns it into the mention only while those words still stand, untouched. Typing meanwhile never loses a word,
      // and nothing else is ever taken out. No thread of this Inbox: it stays as words.
      void resolveMentionRef(client, id).then((ref) => {
        const now = fieldRef.current;
        if (!now || !ref || ref.id === threadId || now.readOnly) return;
        const at = pastedStill(now.value, pasted, from);
        if (at === null) return;
        typeOut(now, at, at + pasted.length);
        putIn([ref], at);
      });
    },
    [client, fieldRef, putIn, threadId, off],
  );

  const box = look.answer ? boxOf() : null;
  const overlay = (
    <>
      {standing.length > 0 && (
        <span id={describedId} className="ib-sr">
          {`Mentions: ${standing.map((m) => spokenMention(m, unreadable.includes(m))).join('; ')}.`}
        </span>
      )}
      {unreadable.length > 0 && (
        <p id={noteId} className="ib-tmnote" data-mention-unreadable="">
          {unreadableMentionLine(unreadable.map((m) => m.title))}
        </p>
      )}
      {look.over && look.caret && <span className="ib-tcaret" aria-hidden="true" style={{ left: look.caret.left, top: look.caret.top, height: look.caret.height }} />}
      {box &&
        createPortal(
          <div className="ib-tdrop" data-thread-drop-label={look.answer ?? ''} aria-hidden="true">
            <span>
              <ThreadGlyph />
              {look.answer === 'refuse' ? 'This is the thread you are in' : look.count > 1 ? `Drop to mention ${look.count} threads` : 'Drop to mention this thread'}
            </span>
          </div>,
          box,
        )}
    </>
  );
  const describedBy = [standing.length > 0 ? describedId : null, unreadable.length > 0 ? noteId : null].filter(Boolean).join(' ') || undefined;
  return { tokens, commit, onSelect, onKeyDown, onPaste, overlay, describedBy };
}

/** A spot inside a mention's label moves to the label's nearer edge: nothing goes in inside a token. */
export function besideMentions(text: string, offset: number, mentions: readonly InboxReplyMention[]): number {
  const at = Math.max(0, Math.min(offset, text.length));
  const inside = mentions.find((m) => at > m.at && at < m.at + m.label.length);
  if (!inside) return at;
  const end = inside.at + inside.label.length;
  return at - inside.at < end - at ? inside.at : end;
}

/**
 * Where the pasted words stand now: at the offset they went in at, else their one place in the words (the person
 * typed before them meanwhile). Null: edited, gone or there twice; the paste stays as words.
 */
export function pastedStill(text: string, pasted: string, at: number): number | null {
  if (pasted === '') return null;
  if (text.startsWith(pasted, at)) return at;
  const first = text.indexOf(pasted);
  return first >= 0 && text.indexOf(pasted, first + 1) < 0 ? first : null;
}

const sameCaret = (a: DropLook['caret'], b: DropLook['caret']) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.height === b.height);

/** The thread mark the mocks draw (two speech bubbles). */
export function ThreadGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
      <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
    </svg>
  );
}
