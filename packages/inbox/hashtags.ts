/**
 * Hashtags (approval "board-hashtags"): `#` at the start of a word in a
 * composer opens the initiatives, drawn by the skill list's own menu
 * (SkillReferenceMenu) and kept by its rules (useSkillReferenceAutocomplete):
 * nothing is active until arrowed onto, so Enter and Tab keep their meaning;
 * with a row active Enter or Tab picks it; Escape closes it once engaged; a
 * bare `#` lets the arrows move the caret. `#` is a composer trigger, never a
 * shortcut. With no initiative yet, `#` is plain text. A query nothing
 * matches closes the list (no "New initiative…" here: the filter makes them).
 *
 * A pick writes `#Shape` (`#CodeReview` for "Code review"). What it does is
 * the server's (store `tagThreadCards`): the person's message puts its
 * thread's card in that initiative; a card made later for the thread starts
 * in it. New card takes the pick as the card's initiative instead (`onPick`).
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  inboxHashtagMayFollow,
  inboxHashtags,
  inboxInitiativeOfTag,
  inboxInitiativeTag,
  inboxInitiativeTaggable,
  inboxInitiativeTagKey,
  type InboxCardWire,
  type InboxInitiative,
  type InboxListRow,
} from '@plannotator/core/inbox-types';
import type { SkillCatalogEntry, SkillReferenceToken } from '@plannotator/ui/utils/skillReferences';
import type { TaggedThreads } from './initiativePeek';

export interface InitiativeTags {
  /** The live initiatives, in the order they were made. */
  initiatives: readonly InboxInitiative[];
  /** Cards in each (live lanes and Done), for the list's quiet second column. */
  counts: ReadonlyMap<string, number>;
  /** The Board's cards (dropped left out): what a sent tag's preview lists (InitiativePeek). */
  cards: readonly InboxCardWire[];
  /** The list's rows by thread id (sections, snoozed, pinned): the preview's thread names and who waits. */
  rows: ReadonlyMap<string, InboxListRow>;
  /** Project names by id: the preview's "Tag · plannotator, workspaces". */
  projects: ReadonlyMap<string, string>;
  /** Per initiative, the latest threads a message tags it in and how many in all (the cards payload's `initiative_threads`). */
  mentions: ReadonlyMap<string, TaggedThreads>;
  /** Read the cards again (an opened preview does, so the threads tagged since are in it). */
  refresh?: () => void;
  /**
   * Where a sent tag links: absent, the Board filtered to it (`initiativeHref`); with the Board off, the tag's list in
   * the Inbox (threadTags.ts `tagHref`, approval "inbox-thread-tags").
   */
  href?: (id: string) => string;
}

const NONE: InitiativeTags = { initiatives: [], counts: new Map(), cards: [], rows: new Map(), projects: new Map(), mentions: new Map() };
/**
 * App provides the Board's initiatives (read with the cards while the Board is on). With the Board off, the list's tags
 * (approval "inbox-thread-tags"), each counted by its threads, and `href` to their lists; an Inbox that keeps no
 * tags gives none, and `#` is plain text.
 */
export const InitiativeTagsContext = createContext<InitiativeTags>(NONE);
export const useInitiativeTags = () => useContext(InitiativeTagsContext);

/** The list's rows, shaped as the skill list's (the menu is reused as is; inbox.css swaps the icon and drops the source). */
export function hashtagRows(initiatives: readonly InboxInitiative[], counts: ReadonlyMap<string, number>): SkillCatalogEntry[] {
  return initiatives.map((i) => {
    const n = counts.get(i.id) ?? 0;
    // The count is a quiet number (the filter menu's), not "4 cards".
    return { name: i.name, root: 'plannotator', description: String(n), humanOnly: false };
  });
}

interface Trigger {
  /** Index of the `#`. */
  start: number;
  query: string;
}

/** The `#query` the caret is at the end of, or null. */
export function findHashtagTrigger(text: string, caret: number): Trigger | null {
  let i = caret;
  while (i > 0 && /[\p{L}\p{N}_-]/u.test(text[i - 1]!)) i--;
  if (i === 0 || text[i - 1] !== '#') return null;
  const start = i - 1;
  // The store's own rule for where a tag starts, so what the list writes is a tag.
  if (!inboxHashtagMayFollow(start > 0 ? text[start - 1]! : '')) return null;
  const query = text.slice(i, caret);
  if (query.length > 40) return null;
  return { start, query };
}

/**
 * The initiatives a query keeps: those whose key starts with it first, then those that hold it. A name that
 * makes no tag ("123", "!!!") is never offered: its pick would name nothing.
 */
export function filterInitiatives(initiatives: readonly InboxInitiative[], query: string): InboxInitiative[] {
  const key = inboxInitiativeTagKey(query);
  const taggable = initiatives.filter((i) => inboxInitiativeTaggable(i.name));
  if (!key) return taggable;
  const keyed = taggable.map((i) => ({ i, k: inboxInitiativeTagKey(i.name) }));
  return [...keyed.filter((x) => x.k.startsWith(key)), ...keyed.filter((x) => !x.k.startsWith(key) && x.k.includes(key))].map((x) => x.i);
}

type Field = HTMLTextAreaElement | HTMLInputElement;

export interface HashtagMenu {
  items: SkillCatalogEntry[];
  activeIndex: number | null;
  /** Index of the `#` the list is open on (the list hangs under it). */
  start: number;
}

/**
 * The `#` picker on a field. Without `onPick` a pick writes `#Shape ` in place
 * of the `#query`; with it (New card) the `#query` is taken out and `onPick`
 * gets the initiative.
 */
export function useHashtagPicker(options: {
  text: string;
  setText: (text: string) => void;
  fieldRef: React.RefObject<Field | null>;
  tags: InitiativeTags;
  onPick?: (initiative: InboxInitiative) => void;
  bareEscapeDismisses?: boolean;
}) {
  const { text, setText, fieldRef, tags, onPick, bareEscapeDismisses = false } = options;
  const [caret, setCaret] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const trigger = useMemo(() => (tags.initiatives.length > 0 && caret !== null ? findHashtagTrigger(text, caret) : null), [tags.initiatives.length, text, caret]);
  const matches = useMemo(() => (trigger ? filterInitiatives(tags.initiatives, trigger.query) : []), [trigger, tags.initiatives]);
  const items = useMemo(() => hashtagRows(matches, tags.counts), [matches, tags.counts]);
  const open = trigger !== null && items.length > 0 && trigger.start !== dismissedStart;
  const lastStart = useRef<number | null>(null);
  useEffect(() => {
    const start = trigger?.start ?? null;
    if (start !== lastStart.current) {
      lastStart.current = start;
      setDismissedStart(null);
    }
  }, [trigger]);
  const triggerStart = trigger?.start ?? null;
  const triggerQuery = trigger?.query ?? null;
  useEffect(() => setActiveIndex(null), [triggerStart, triggerQuery]);
  const active = activeIndex !== null && activeIndex < items.length ? activeIndex : null;

  const readCaret = useCallback(() => {
    const el = fieldRef.current;
    setCaret(el && document.activeElement === el ? el.selectionStart : null);
  }, [fieldRef]);

  const pending = useRef<{ el: Field; text: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p || p.el.value !== p.text) return;
    pending.current = null;
    if (!p.el.isConnected) return;
    p.el.focus();
    p.el.setSelectionRange(p.caret, p.caret);
  });

  const select = useCallback(
    (index: number) => {
      const el = fieldRef.current;
      const picked = matches[index];
      if (!trigger || !el || !picked) return;
      const end = trigger.start + 1 + trigger.query.length;
      let next: string;
      let at: number;
      if (onPick) {
        // New card: the `#query` leaves the text (and one space with it); the card's initiative says it.
        const before = text.slice(0, trigger.start).replace(/ $/, '');
        const after = text.slice(end);
        next = before + (before && after && !/^\s/.test(after) ? ' ' : '') + after;
        at = before.length;
        onPick(picked);
      } else {
        const tag = inboxInitiativeTag(picked.name);
        const after = text.slice(end);
        const space = /^\s/.test(after) ? '' : ' ';
        next = text.slice(0, trigger.start) + tag + space + after;
        at = trigger.start + tag.length + space.length;
      }
      setText(next);
      setCaret(at);
      setActiveIndex(null);
      setDismissedStart(trigger.start);
      pending.current = { el, text: next, caret: at };
    },
    [fieldRef, matches, onPick, setText, text, trigger],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<Field>): boolean => {
      if (!open || !trigger) return false;
      if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          if (active === null && trigger.query.length === 0) {
            setDismissedStart(trigger.start);
            return false;
          }
          e.preventDefault();
          if (e.key === 'ArrowDown') setActiveIndex(active === null ? 0 : (active + 1) % items.length);
          else setActiveIndex(active === null ? items.length - 1 : (active - 1 + items.length) % items.length);
          return true;
        case 'Enter':
        case 'Tab':
          if (active === null) return false;
          e.preventDefault();
          select(active);
          return true;
        case 'Escape':
          if (!bareEscapeDismisses && active === null && trigger.query.length === 0) return false;
          e.preventDefault();
          e.stopPropagation();
          setActiveIndex(null);
          setDismissedStart(trigger.start);
          return true;
        default:
          return false;
      }
    },
    [active, bareEscapeDismisses, items.length, open, select, trigger],
  );

  /** The tags in the text that name an initiative, painted as the skill references are. */
  const tokens = useMemo<SkillReferenceToken[]>(() => {
    if (tags.initiatives.length === 0) return [];
    return inboxHashtags(text).flatMap((tag) => {
      const initiative = inboxInitiativeOfTag(tag.key, tags.initiatives);
      return initiative ? [{ start: tag.start, end: tag.end, entry: { name: initiative.name, root: 'plannotator' as const, humanOnly: false } }] : [];
    });
  }, [tags.initiatives, text]);

  return { menu: open ? ({ items, activeIndex: active, start: trigger.start } satisfies HashtagMenu) : null, onKeyDown, onSelect: readCaret, select, tokens };
}

/**
 * Where the `#` sits across the field, in viewport x: a hidden mirror with the
 * field's metrics lays out the text before it (wrapping as a textarea does; one
 * line for an input), less the field's own scroll. Null when not laid out.
 */
export function caretLeft(field: Field, position: number): number | null {
  const doc = field.ownerDocument;
  const view = doc.defaultView;
  const rect = field.getBoundingClientRect();
  if (!view || (rect.width === 0 && rect.height === 0)) return null;
  const style = view.getComputedStyle(field);
  const mirror = doc.createElement('div');
  for (const key of ['boxSizing', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'borderStyle', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'fontFeatureSettings', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'direction'] as const) {
    (mirror.style as unknown as Record<string, string>)[key] = style[key] as string;
  }
  const area = field instanceof HTMLTextAreaElement;
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-9999px',
    whiteSpace: area ? 'pre-wrap' : 'pre',
    overflowWrap: area ? 'break-word' : 'normal',
    width: area ? `${field.clientWidth + parseFloat(style.borderLeftWidth || '0') + parseFloat(style.borderRightWidth || '0')}px` : 'auto',
    boxSizing: 'border-box',
  });
  mirror.textContent = field.value.slice(0, position);
  const marker = doc.createElement('span');
  marker.textContent = '#';
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);
  try {
    return rect.left + marker.offsetLeft - field.scrollLeft;
  } finally {
    mirror.remove();
  }
}

/** The list's own width at most (inbox.css `--ib-hash-max`): its left edge is moved in only as far as it still fits. */
export const HASHTAG_MENU_MAX = 300;
/** From the list's left edge to a row's text (border 1, list padding 4, row padding 10): the names start under the `#`. */
const HASHTAG_TEXT_INSET = 15;

/** The list's left edge in its anchor: under the `#` (a hair to its left, so the row's text lines up), never past the anchor's right. */
export function hashtagMenuLeft(field: Field | null, start: number, anchorLeft: number, anchorWidth: number): number {
  const x = field ? caretLeft(field, start) : null;
  if (x === null) return 0;
  return Math.round(Math.max(0, Math.min(x - anchorLeft - HASHTAG_TEXT_INSET, anchorWidth - HASHTAG_MENU_MAX)));
}

/** The Board filtered to an initiative, as a link in the window's own address. */
export function initiativeHref(id: string): string {
  return `#board&initiative=${encodeURIComponent(id)}`;
}

/**
 * A message's text with each tag that names a live initiative made a link to
 * the Board filtered to it (`[#Shape](#board&initiative=ini_…)`; display
 * only), or where `href` says (the tag's list, with the Board off). Tags in code, or naming nothing, stay as written.
 */
export function linkHashtags(text: string, initiatives: readonly InboxInitiative[], href: (id: string) => string = initiativeHref): string {
  if (initiatives.length === 0 || !text.includes('#')) return text;
  // A markdown link's own text (`[part of #Shape](…)`): a link inside a link is none. Its destination holds no
  // tag at all (core blanks it).
  const linkTexts = [...text.matchAll(/\[([^\[\]\n]*)\]\(/g)].map((m) => [m.index!, m.index! + m[0].length] as const);
  let out = '';
  let last = 0;
  for (const tag of inboxHashtags(text)) {
    const initiative = inboxInitiativeOfTag(tag.key, initiatives);
    if (!initiative) continue;
    if (linkTexts.some(([from, to]) => tag.start > from && tag.end < to)) continue;
    out += text.slice(last, tag.start) + `[#${tag.tag}](${href(initiative.id)})`;
    last = tag.end;
  }
  return out + text.slice(last);
}
