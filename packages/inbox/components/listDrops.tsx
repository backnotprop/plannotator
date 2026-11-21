/**
 * The list's own places for a dragged thread (approval "inbox-drag-threads", drag-system.html): Priority docked on the
 * list's top edge, Archive and Quiet on its bottom edge, and another row held for a moment (Combine). They show only
 * while a thread is carried (threadDrag.ts, the window's one thread drag), float over the list so nothing moves under
 * the pointer (fixed over the list column, drawn in the window's root beside the toast so a toast never covers them),
 * and each drop runs what the row menu already runs, with its toast and Undo:
 *
 *  - Priority: Add to Priority.
 *  - Quiet: Mark read ("Quiet" is not a flag; Mark read is what makes a row quiet). The warning Mark read asks before
 *    it sets questions aside still asks.
 *
 * A place that takes the drop is its icon and name only (the owner, 2026-11-16: no description lines).
 *  - Archive: Archive. Red only while the pointer is over it.
 *  - A row held 500 ms over its middle (60%) opens today's Combine dialog with the carried threads and that one picked
 *    (useListPicks.ts `combineWith`); it never combines by itself. Passing over rows on the way to an edge never arms it,
 *    nor does a row in the list's scroll band.
 *
 * Several picked rows move together: the picks' own actions (PickBar.tsx `runBulk`), one toast and one Undo. A place
 * that takes none of the carried threads still shows, greyed, its second line saying why, and a drop there changes
 * nothing. Never on a phone: the row's sheet and its swipe do the same there.
 */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { inboxRowArchived, type InboxListGroupId, type InboxListRow } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { Icon, type IconName } from '../icons';
import { offersRowMarkRead, setAsideCount } from '../markRead';
import { priorityAction } from '../priority';
import type { RowMenuAction } from '../rowMenu';
import { refreshThreadDrag, registerThreadDropTarget, sayThreadDrag, scrollStep, threadDragging, threadDragHit, THREAD_DROP_LAYER, type DropAnswer } from '../threadDrag';
import { runBulk } from './PickBar';
import type { MenuPicks } from './useListPicks';

export type EdgePlace = 'priority' | 'archive' | 'quiet';

export interface PlaceAnswer {
  answer: DropAnswer;
  /** Why a drop does nothing (a refused place's second line, and what a drop there says); empty where it takes. */
  sub: string;
  /** The carried rows the drop takes. */
  rows: InboxListRow[];
}

export interface DropRules {
  /** The group a row is drawn in ("archived": the Archived group's, which takes no read action). */
  drawn: (row: InboxListRow) => InboxListGroupId | null;
  /** The list offers Mark read (the host has it). */
  canMarkRead: boolean;
  /** Its machine takes Priority from this one. */
  prioritizes: (row: InboxListRow) => boolean;
}

/** What each edge place answers for the carried rows: the row menu's rules (rowMenu.ts) and the picks' (rowPicks.ts). */
export function edgePlaces(rows: readonly InboxListRow[], rules: DropRules): Record<EdgePlace, PlaceAnswer> {
  const many = rows.length > 1;
  const first = rows[0];
  const priority = rows.filter((row) => rules.prioritizes(row) && priorityAction(row) === 'priority-add');
  const read = rules.canMarkRead ? rows.filter((row) => rules.drawn(row) !== 'archived' && offersRowMarkRead(row, rules.drawn(row))) : [];
  const archive = rows.filter((row) => row.resolved_at === null);
  // A place that takes the drop is its name alone (the owner, 2026-11-16: no description lines); Mark read's own
  // warning still names what it sets aside when the drop runs it.
  return {
    priority: priority.length
      ? { answer: 'take', sub: '', rows: priority }
      : {
          answer: rows.length ? 'refuse' : null,
          sub: !first ? '' : first.priority ? 'Already in Priority' : inboxRowArchived(first) ? (many ? 'Unarchive them first' : 'Unarchive it first') : 'Its Inbox keeps no Priority',
          rows: [],
        },
    quiet: !rules.canMarkRead
      ? { answer: null, sub: '', rows: [] }
      : read.length
        ? { answer: 'take', sub: '', rows: read }
        : {
            answer: rows.length ? 'refuse' : null,
            sub: !first ? '' : rules.drawn(first) === 'archived' || inboxRowArchived(first) ? 'Archived: nothing to mark read' : first.section === 'quiet' ? 'Already in Quiet' : (first.read_at ?? null) !== null ? 'Already read' : 'Nothing waits on you here',
            rows: [],
          },
    archive: archive.length ? { answer: 'take', sub: '', rows: archive } : { answer: rows.length ? 'refuse' : null, sub: 'Already archived', rows: [] },
  };
}

const PLACES: { place: EdgePlace; edge: 'top' | 'bottom'; label: string; icon: IconName; what: string; action: RowMenuAction }[] = [
  { place: 'priority', edge: 'top', label: 'Priority', icon: 'toTop', what: 'Priority', action: 'priority-add' },
  { place: 'archive', edge: 'bottom', label: 'Archive', icon: 'archive', what: 'Archive', action: 'archive' },
  { place: 'quiet', edge: 'bottom', label: 'Quiet', icon: 'checkCircle', what: 'Quiet', action: 'read' },
];

/** The rows' drag help (their `aria-describedby`, InboxList.tsx), with their `aria-roledescription` "draggable thread". */
export const THREAD_DRAG_HELP_ID = 'ib-thread-drag-help';

/** The drag help's words: only the places this list offers (Quiet where it marks read, Combine where it combines). */
export function dragHelp(canMarkRead: boolean, combines: boolean): string {
  const ways = ['to the reply box to mention it', 'to the top for Priority', canMarkRead ? 'to the bottom for Quiet or Archive' : 'to the bottom for Archive'];
  if (combines) ways.push('hold over another thread to combine');
  return `Drag ${ways.slice(0, -1).join(', ')}, or ${ways.at(-1)}. Or open the menu with Shift F10.`;
}

/**
 * Whether a pointer here can drag a row (threadDrag.ts): a main pointer that is fine, or a fine one that hovers (a mouse
 * or trackpad on a touch screen). Touch never drags, nor a pen where the main pointer is not fine (an iPad's Pencil),
 * so a touch screen with only those says nothing of a drag.
 */
function rowsDraggable(): boolean {
  if (typeof matchMedia !== 'function') return true;
  return matchMedia('(pointer: fine)').matches || (matchMedia('(any-pointer: fine)').matches && matchMedia('(any-hover: hover)').matches);
}
const DRAG_MEDIA = ['(pointer: fine)', '(any-pointer: fine)', '(any-hover: hover)'];
function onDragMedia(changed: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const lists = DRAG_MEDIA.map((query) => matchMedia(query));
  lists.forEach((list) => list.addEventListener?.('change', changed));
  return () => lists.forEach((list) => list.removeEventListener?.('change', changed));
}
/** `rowsDraggable`, kept current: a trackpad connected (or gone) mid-session changes it without another render. */
export function useRowsDraggable(): boolean {
  return useSyncExternalStore(onDragMedia, rowsDraggable, () => true);
}

/** The drag help's id while the list's rows can be dragged (RowMenu.tsx provides it); null where they cannot. */
export const RowDragHelp = createContext<string | null>(null);

/** A row's description and role words: its badge's words (`words`), then the drag help where a drag can happen. */
export function useRowDragA11y(words?: string): { 'aria-roledescription'?: string; 'aria-describedby'?: string } {
  const help = useContext(RowDragHelp);
  const describedBy = [words, help].filter(Boolean).join(' ');
  return { 'aria-roledescription': help ? 'draggable thread' : undefined, 'aria-describedby': describedBy || undefined };
}

/** How long a row is held before it takes a Combine, and the middle of it that counts (approval: 500 ms, 60%). */
export const COMBINE_DWELL_MS = 500;
const COMBINE_MIDDLE = 0.2;
/** The room "Combine with this thread" needs on a one-line row, in px. */
const COMBINE_LABEL_MIN = 190;

export interface ListDropsProps {
  /** The list's body (`.ib-lbody`): the edges float over its ends, its rows take Combine. */
  body: RefObject<HTMLElement | null>;
  rowOf: (threadId: string) => InboxListRow | null;
  sectionOf?: (threadId: string) => InboxListGroupId | null;
  canMarkRead: boolean;
  prioritizesOf?: (row: InboxListRow) => boolean;
  /** The row menu's actions (App.tsx `rowAction`): one row's drop runs exactly what its menu item runs. Mark read
   *  resolves false when its set-aside warning was cancelled. */
  onAction: (row: InboxListRow, action: RowMenuAction) => unknown;
  picks?: MenuPicks;
  /** The row menu's focus rule after a write (useContextMenuTrigger.ts `follow`): a dropped row's focus goes where its menu item's would. */
  follow?: (threadId: string, moves?: boolean) => void;
  /** No drag here: a phone, or a list with no actions. */
  off: boolean;
}

interface Shown {
  places: Record<EdgePlace, PlaceAnswer>;
  /** Where the places dock, in the window (they are fixed): over the list column's sides, the body's top, the column's bottom. */
  frame: { left: number; right: number; top: number; bottom: number };
  /** The window's root they draw in: beside the toast, so they draw above it (the shell is its own stacking context). */
  into: HTMLElement;
}

/** The row button a hit lands in (a wide row's wrapper holds it). */
function rowAt(list: HTMLElement, hit: Element | null): HTMLElement | null {
  const own = hit?.closest<HTMLElement>('[data-thread-id]') ?? hit?.closest<HTMLElement>('[data-row]')?.querySelector<HTMLElement>('[data-thread-id]') ?? null;
  return own && list.contains(own) ? own : null;
}

/** The list's edge places and its rows as drop targets, while a thread is carried. */
export function ListDrops(props: ListDropsProps) {
  const live = useRef(props);
  live.current = props;
  const [shown, setShown] = useState<Shown | null>(null);
  const [hot, setHot] = useState<EdgePlace | null>(null);
  const [combineAt, setCombineAt] = useState<LabelBox | null>(null);
  const slots = useRef<Record<EdgePlace, HTMLDivElement | null>>({ priority: null, archive: null, quiet: null });

  useEffect(() => {
    if (props.off) return;
    const rules = (): DropRules => {
      const { sectionOf, canMarkRead, prioritizesOf } = live.current;
      return { drawn: (row) => sectionOf?.(row.thread_id) ?? null, canMarkRead, prioritizes: (row) => prioritizesOf?.(row) ?? true };
    };
    const rowsOf = (ids: readonly string[]) => ids.flatMap((id) => live.current.rowOf(id) ?? []);
    // One answer per drag: the carried ids are the same array from pick-up to drop.
    let asked: { ids: readonly string[]; places: Record<EdgePlace, PlaceAnswer> } | null = null;
    const placesFor = (ids: readonly string[]) => {
      if (asked?.ids !== ids) asked = { ids, places: edgePlaces(rowsOf(ids), rules()) };
      return asked.places;
    };
    const offs = PLACES.map(({ place, edge, what, action }) =>
      registerThreadDropTarget({
        element: () => slots.current[place],
        layer: THREAD_DROP_LAYER.list,
        edge,
        what,
        accepts: (ids) => placesFor(ids)[place].answer,
        refused: (ids) => placesFor(ids)[place].sub,
        // One state for the three places: Priority's `show` sets it, at the drag's start (whatever it answers) and end.
        show: (_answer, ids) => {
          if (place !== 'priority') return;
          setHot(null);
          asked = null;
          const list = live.current.body.current;
          const column = list?.parentElement;
          if (!threadDragging() || !list || !column) return setShown(null);
          const col = column.getBoundingClientRect();
          const frame = { left: col.left + 8, right: window.innerWidth - col.right + 8, top: list.getBoundingClientRect().top + 6, bottom: window.innerHeight - col.bottom + 8 };
          setShown({ places: placesFor(ids), frame, into: list.closest<HTMLElement>('.pn-inbox') ?? document.body });
        },
        over: (point) => setHot((was) => (point ? place : was === place ? null : was)),
        drop: (ids) => {
          const taken = placesFor(ids)[place].rows;
          const { picks, onAction, follow } = live.current;
          // Several picked rows: the picks' own action (each row it takes, one toast, one Undo), and picking ends
          // (threadDrag.ts `dropped`), focus going where the pick bar's Done puts it. One row: its menu item, and
          // focus follows the row as after that item (Priority moves it; Archive and Mark read may take it away).
          let ran: unknown;
          if (ids.length > 1 && picks) ran = runBulk(picks.act, action === 'read' || action === 'archive' ? action : 'priority-add');
          else if (taken[0]) {
            follow?.(taken[0].thread_id, action === 'priority-add');
            ran = onAction(taken[0], action);
          } else return false;
          // Mark read may ask first (its set-aside warning) and a Cancel there writes nothing: picking stays until it
          // went on, then ends as any drop's does.
          if (action !== 'read' || setAsideCount(taken).threads === 0) return;
          void Promise.resolve(ran).then((went) => went !== false && live.current.picks?.dropped?.());
          return false;
        },
      }),
    );
    offs.push(registerCombine(live, setCombineAt));
    return () => offs.forEach((off) => off());
  }, [props.off]);

  if (props.off) return null;
  const help = (
    <span id={THREAD_DRAG_HELP_ID} className="ib-sr">
      {dragHelp(props.canMarkRead, props.picks?.combineWith !== undefined)}
    </span>
  );
  if (!shown) return help;
  const combineLabel = combineAt && (
    <div className="ib-tcomb" data-end={combineAt.end ? '' : undefined} aria-hidden="true" style={{ left: combineAt.left, top: combineAt.top, width: combineAt.width, height: combineAt.height }}>
      <Icon name="swap" size={14} />
      Combine with this thread
    </div>
  );
  const slot = (place: EdgePlace) => {
    const meta = PLACES.find((entry) => entry.place === place)!;
    const answer = shown.places[place];
    if (!answer.answer) return null;
    return (
      <div
        key={place}
        ref={(el) => void (slots.current[place] = el)}
        className="ib-tslot"
        data-thread-place={place}
        data-hot={hot === place && answer.answer === 'take' ? '' : undefined}
        data-refused={answer.answer === 'refuse' ? '' : undefined}
      >
        <span className="ib-tslot-ic">
          <Icon name={meta.icon} size={16} />
        </span>
        <span className="ib-tslot-txt">
          {meta.label}
          {answer.answer === 'refuse' && answer.sub && <span className="ib-tslot-sub">{answer.sub}</span>}
        </span>
      </div>
    );
  };
  const bottom = (['archive', 'quiet'] as const).filter((place) => shown.places[place].answer);
  const { frame } = shown;
  return (
    <>
      {help}
      {createPortal(
        <>
          {shown.places.priority.answer && (
            <div className="ib-tedge ib-tedge-top" style={{ left: frame.left, right: frame.right, top: frame.top }} aria-hidden="true" data-thread-edge="top">
              {slot('priority')}
            </div>
          )}
          {bottom.length > 0 && (
            <div className="ib-tedge ib-tedge-bottom" style={{ left: frame.left, right: frame.right, bottom: frame.bottom }} aria-hidden="true" data-thread-edge="bottom">
              {bottom.map(slot)}
            </div>
          )}
        </>,
        shown.into,
      )}
      {combineLabel}
    </>
  );
}

/** Where the Combine words sit over a held row, in the list column. */
type LabelBox = { left: number; top: number; width: number; height: number; end?: boolean };

/**
 * The list's rows as one Combine target: a row held over its middle for COMBINE_DWELL_MS fills, says "Combine with this
 * thread", and takes the drop, which opens the Combine dialog. Moving off it, into the scroll band or to another row
 * starts again.
 */
function registerCombine(live: { current: ListDropsProps }, setLabel: (box: LabelBox | null) => void): () => void {
  let carried: readonly string[] | null = null;
  let row: HTMLElement | null = null;
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: { x: number; y: number } | null = null;
  /** The row a drop at the pointer lands on (`takesAt`'s answer), kept past the drag's end: the engine ends it (`over`
   * null, `show` null) before it hands over the drop. */
  let landed: string | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    row?.removeAttribute('data-thread-combine');
    row = null;
    armed = false;
    setLabel(null);
  };
  const combinable = (id: string) => live.current.picks?.takes(id) === true && !!live.current.rowOf(id);
  /** The row under a point that may take a Combine of the carried threads, or null. */
  const candidate = (point: { x: number; y: number }): HTMLElement | null => {
    const list = live.current.body.current;
    if (!list || !carried) return null;
    const el = rowAt(list, threadDragHit(point.x, point.y));
    const id = el?.getAttribute('data-thread-id');
    if (!el || !id || carried.includes(id) || !combinable(id)) return null;
    const box = el.getBoundingClientRect();
    const at = box.height > 0 ? (point.y - box.top) / box.height : 0.5;
    if (at <= COMBINE_MIDDLE || at >= 1 - COMBINE_MIDDLE) return null;
    // A row in the list's scroll band is passing by, not held.
    if (scrollStep(list, point.x, point.y) !== 0) return null;
    return el;
  };
  /** The words go over the row's end: its preview line on a three-line row, its right columns on a wide one. */
  const showLabel = (el: HTMLElement) => {
    // The list column: the edges' and these words' box (the body's parent, where ListDrops draws).
    const column = live.current.body.current?.parentElement;
    if (!column) return;
    const at = el.getBoundingClientRect();
    const from = column.getBoundingClientRect();
    // A three-line row: over line 3 (the preview). A one-line row: at its right end, over the counts and the time
    // (hidden while it takes the drop), clear of the ghost at the pointer.
    const line = el.querySelector<HTMLElement>(':scope > .ib-l3')?.getBoundingClientRect();
    if (line && line.height > 0) {
      setLabel({ left: line.left - from.left, top: line.top - from.top, width: Math.max(0, at.right - line.left - 12), height: line.height });
      return;
    }
    const left = Math.max(at.left + 12, at.right - 12 - COMBINE_LABEL_MIN);
    setLabel({ left: left - from.left, top: at.top - from.top, width: Math.max(0, at.right - 12 - left), height: at.height, end: true });
  };
  return registerThreadDropTarget({
    element: () => live.current.body.current,
    layer: THREAD_DROP_LAYER.list,
    what: 'Combine',
    accepts: (ids) => (live.current.picks?.combineWith && ids.every(combinable) ? 'take' : null),
    show: (answer, ids) => {
      if (answer) landed = null;
      clear();
      carried = answer ? ids : null;
    },
    over: (point) => {
      last = point;
      const next = point ? candidate(point) : null;
      if (next === row) return;
      clear();
      if (!next) return;
      row = next;
      row.setAttribute('data-thread-combine', 'arming');
      const held = next;
      timer = setTimeout(() => {
        timer = null;
        // Still the row under the pointer (the list may have moved under a still pointer).
        if (row !== held || !last || candidate(last) !== held) return clear();
        armed = true;
        held.setAttribute('data-thread-combine', 'on');
        showLabel(held);
        const title = (held.querySelector('.ib-title') ?? held.querySelector('.ib-subj'))?.textContent?.trim() || 'this thread';
        sayThreadDrag(`Let go to combine with ${title}.`);
        refreshThreadDrag();
      }, COMBINE_DWELL_MS);
    },
    takesAt: (point) => {
      landed = armed && row && candidate(point) === row ? row.getAttribute('data-thread-id') : null;
      return landed !== null;
    },
    drop: (ids) => {
      const onto = landed;
      landed = null;
      const combine = live.current.picks?.combineWith;
      if (!onto || !combine) return false;
      combine([...ids, onto]);
      sayThreadDrag(`Combine ${formatCount(ids.length + 1)} threads: choose who writes it, or Cancel.`);
    },
  });
}
