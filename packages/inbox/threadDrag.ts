/**
 * Dragging threads (approval "inbox-drag-threads"): one gesture, places that take it, shown only while a thread is
 * being dragged: the reply box (a mention), the list's top edge (Priority) and bottom edge (Quiet and Archive), another
 * row held for a moment (Combine), the panes of a free layout, and the empty thread panel (open it there).
 *
 * Mechanics (CONCEPT.md "Drag mechanics"): a mouse or pen press on a row that moves 5 px picks it up; below that it
 * stays a click. Touch never drags (a phone's press and hold opens the row's sheet, its swipe stays a swipe). A
 * picked row carries every picked row. The row stays in place with its words faded; a pill ghost follows the
 * pointer, saying what a drop would do. Escape, a drop on nothing or leaving the window cancels: the ghost flies back
 * (reduced motion: it just goes). A live region says the pick-up and the result. The click that ends a drag never
 * opens a row.
 *
 * Pointer events only: nothing here fires or listens to native drag events, so a file dragged onto the reply box and
 * words dragged inside it work as before.
 *
 * The list scrolls while a thread is held near its top or bottom (`scroller`, AUTO_SCROLL_BAND), faster nearer the
 * edge. A drop target under the pointer always wins over scrolling: the list's own edge places (Priority on top,
 * Quiet and Archive at the bottom, `edge`) float over the list's ends, and while they show the band is the strip just
 * inside them. A target that takes a drop only at some points (a row, once held: `takesAt`) lets the list scroll
 * elsewhere.
 *
 * The API (the window's one thread drag: every place that takes a dragged thread registers here, none runs its own):
 *  - `pressThreadRow(event, source, root)`: a row's `pointerdown` (useThreadRowDrag.ts wires the list's rows). The
 *    source says which threads a drag carries, the ghost's words, the rows to fade and the list that scrolls.
 *  - `registerThreadDropTarget(target)`: a place that takes threads while it is mounted; returns its unregister.
 *    `layer` (THREAD_DROP_LAYER) settles overlapping targets: of those under the pointer the highest layer wins
 *    (a tie: the one whose element lies inside the other's). The reply box is one target (replyMentions.tsx, layer
 *    `reply`); a pane of a free layout and the empty thread panel register at `pane`, the list's edge places and its
 *    rows (Combine) at `list` (components/listDrops.tsx).
 *  - `sayThreadDrag(words)`: a target's result in the drag's live region. `threadDragging()`: whether one is on.
 *  - `refreshThreadDrag()`: a target's answer changed with no move (a row held long enough): the ghost's word again.
 *  - `threadDragHit(x, y)`: the element under a point, as the engine sees it (a test stands it in). A toast is never
 *    hit: the engine looks under it, so a place a toast lies over still takes the drop.
 *  - A target's `refused(ids)` is what a drop on it says when it refuses ("Already in Priority. Nothing changed.");
 *    a source's `dropped(ids)` runs after a target took the drop (the list's picks end there, as the design's do).
 */

/** What a target answers for the threads being dragged: takes them, refuses them (shown, but a drop does nothing), or is no place for them (hidden). */
export type DropAnswer = 'take' | 'refuse' | null;

/** Where a target lies in the stack of places: of the targets under the pointer the highest layer takes the drop. */
export const THREAD_DROP_LAYER = { list: 10, pane: 20, reply: 30 } as const;

export interface ThreadDropTarget {
  /** The element a drop lands on (its whole box). */
  element: () => HTMLElement | null;
  /** Its layer (THREAD_DROP_LAYER; absent: `list`). */
  layer?: number;
  accepts: (ids: readonly string[]) => DropAnswer;
  /** The ghost's second word over it ("Mention"). */
  what: string;
  /** The drag started (`answer` for these threads) or ended (null): the target shows or hides itself. */
  show: (answer: DropAnswer, ids: readonly string[]) => void;
  /** The pointer is over it (`point`), or left it (null). */
  over: (point: { x: number; y: number } | null) => void;
  /** The drop. `false`: it changed nothing (a "No room" it said), so the source's `dropped` does not run (picking stays). */
  drop: (ids: readonly string[], point: { x: number; y: number }) => void | boolean;
  /** Whether a drop at `point` lands (a row held long enough for Combine). Absent: anywhere on it. Where it does not,
   * the ghost says nothing, the list may scroll, and a drop there is a cancel. */
  takesAt?: (point: { x: number; y: number }) => boolean;
  /** Docked on the list's top or bottom edge while a drag is on: the list's scroll band starts at its inner edge. */
  edge?: 'top' | 'bottom';
  /** Why it refuses these threads ("Already in Priority"): what a drop on it says. Absent: "Cancelled". */
  refused?: (ids: readonly string[]) => string;
}

export interface ThreadDragSource {
  /** The threads a drag from this row carries (it and every picked row, when it is picked). */
  ids: () => string[];
  /** The ghost's words for them: the title, or "3 threads". */
  label: (ids: readonly string[]) => string;
  /** The row elements of these threads (faded while they are carried). */
  rows: (ids: readonly string[]) => HTMLElement[];
  /** Words for the live region: what was picked up. */
  spoken: (ids: readonly string[]) => string;
  /** The list that scrolls while a thread is held near its top or bottom edge. Absent: none scrolls. */
  scroller?: () => HTMLElement | null;
  /** A target took the drop (after its `drop` ran): the list's picks end, as after any drop. */
  dropped?: (ids: readonly string[]) => void;
}

/** How near the list's top or bottom edge (px) a held thread scrolls it, and the fastest step (px a frame). */
export const AUTO_SCROLL_BAND = 48;
const AUTO_SCROLL_MAX = 14;

const THRESHOLD = 5;
const targets = new Set<ThreadDropTarget>();

/** A drop target is one while it is registered (the reply box's field, while it is mounted). */
export function registerThreadDropTarget(target: ThreadDropTarget): () => void {
  targets.add(target);
  if (drag) target.show(target.accepts(drag.ids), drag.ids);
  return () => {
    targets.delete(target);
    if (drag?.over === target) drag.over = null;
  };
}

interface Drag {
  ids: string[];
  ghost: HTMLElement;
  what: HTMLElement;
  origin: { x: number; y: number };
  over: ThreadDropTarget | null;
  rows: HTMLElement[];
  root: HTMLElement;
  scroller: HTMLElement | null;
  /** The scroll step now (px a frame, negative is up) and its frame. */
  scroll: { step: number; frame: number | null };
  /** Where the pointer was last. */
  point: { x: number; y: number };
  source: ThreadDragSource;
}

let drag: Drag | null = null;
let press: { x: number; y: number; source: ThreadDragSource; root: HTMLElement; pointerId: number } | null = null;
/**
 * The element under a point, under any toast: a toast (an Undo for seconds after a write) can lie over a place, and a
 * drop must never land on a toast, nor a toast hide the place under it.
 */
function underToasts(x: number, y: number): Element | null {
  if (typeof document.elementsFromPoint !== 'function') return document.elementFromPoint(x, y);
  return document.elementsFromPoint(x, y).find((el) => !el.closest('[data-inbox-toast]')) ?? null;
}
/** Hit testing (a test swaps it: its DOM lays nothing out). */
let hitTest: (x: number, y: number) => Element | null = underToasts;

export function setThreadDragHitTestForTests(test: ((x: number, y: number) => Element | null) | null): void {
  hitTest = test ?? underToasts;
}

/** The element under a point, as the engine hit tests it. */
export function threadDragHit(x: number, y: number): Element | null {
  return hitTest(x, y);
}

/** A target's answer changed while the pointer stood still: the ghost's word and the scroll again, at the same point. */
export function refreshThreadDrag(): void {
  if (drag) move(drag.point.x, drag.point.y);
}

/** Whether threads are being dragged now. */
export function threadDragging(): boolean {
  return drag !== null;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The window's one live region for drags (polite). */
function say(root: HTMLElement, words: string): void {
  let live = root.querySelector<HTMLElement>(':scope > [data-thread-drag-live]');
  if (!live) {
    live = document.createElement('div');
    live.className = 'ib-sr';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('data-thread-drag-live', '');
    root.appendChild(live);
  }
  // Emptied first, so the same words said twice are heard twice.
  live.textContent = '';
  const node = live;
  setTimeout(() => (node.textContent = words), 30);
}

/** Say something in the drag's live region (a target's result: "Mentioned … in your reply."). */
export function sayThreadDrag(words: string, root?: HTMLElement | null): void {
  const at = root ?? document.querySelector<HTMLElement>('.pn-inbox') ?? document.body;
  say(at, words);
}

/**
 * A press on a row (its `pointerdown`): a mouse or pen press with the main button may become a drag. Nothing is
 * prevented here, so the press is still a click, a ⌘-click or a Shift-click until it moves 5 px.
 */
export function pressThreadRow(event: PointerEvent, source: ThreadDragSource, root: HTMLElement): void {
  if (event.button !== 0 || event.pointerType === 'touch' || drag) return;
  // A pen on a screen with no fine pointer (an iPad's) scrolls the list: it never drags.
  if (event.pointerType === 'pen' && typeof matchMedia === 'function' && !matchMedia('(pointer: fine)').matches) return;
  if (press) stopListening();
  press = { x: event.clientX, y: event.clientY, source, root, pointerId: event.pointerId };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  // From the press on: a press whose release is lost (the window lost focus) never arms a drag later.
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
}

function stopListening(): void {
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', onBlur);
}

function onMove(event: PointerEvent): void {
  // The main button is no longer held (its release went elsewhere): the press, or the drag, ends here.
  if ((event.buttons & 1) === 0) {
    if (drag) cancel();
    else stopListening();
    press = null;
    return;
  }
  if (press && !drag) {
    if (event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= THRESHOLD) return;
    start(event);
    return;
  }
  if (drag) move(event.clientX, event.clientY);
}

function onUp(event: PointerEvent): void {
  if (drag) end(event.clientX, event.clientY);
  else stopListening();
  press = null;
}

function onCancel(): void {
  if (drag) cancel();
  else stopListening();
  press = null;
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (!drag) {
    // Before a drag: Escape only drops the press (the key goes on as it would).
    stopListening();
    press = null;
    return;
  }
  // Escape is the drag's: it never closes the thread or a sheet under it.
  event.preventDefault();
  event.stopPropagation();
  cancel();
}

function onBlur(): void {
  if (drag) cancel();
  else stopListening();
  press = null;
}

/**
 * The click that ends a drag (on the row it started on) opens nothing. A drop released at `at` swallows only the
 * click there, the release's own: a drop on a place the drop takes away (Archive, Priority) gets no click from the
 * browser at all (nothing the press and the release share is left), and the person's next click elsewhere within the
 * 400 ms (the drop's toast's Undo) is theirs. With no release point (Escape, the window left) any click in the 400 ms
 * is the drag's.
 */
function swallowNextClick(at: { x: number; y: number } | null): void {
  const off = () => window.removeEventListener('click', swallow, true);
  const swallow = (event: MouseEvent) => {
    off();
    if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > THRESHOLD) return;
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', swallow, true);
  setTimeout(off, 400);
}

function start(event: PointerEvent): void {
  if (!press) return;
  const { source, root } = press;
  const ids = source.ids();
  if (ids.length === 0) return;
  // A drag never leaves a half-made text selection behind.
  window.getSelection()?.removeAllRanges();
  const ghost = document.createElement('div');
  ghost.className = `ib-tdrag${ids.length > 1 ? ' ib-tdrag-stack' : ''}${reduced() ? '' : ' ib-tdrag-lift'}`;
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('data-thread-ghost', '');
  const title = document.createElement('span');
  title.className = 'ib-tdrag-t';
  title.textContent = source.label(ids);
  ghost.appendChild(title);
  if (ids.length > 1) {
    const count = document.createElement('span');
    count.className = 'ib-tdrag-n';
    count.textContent = String(ids.length);
    ghost.appendChild(count);
  }
  const what = document.createElement('span');
  what.className = 'ib-tdrag-w';
  ghost.appendChild(what);
  root.appendChild(ghost);
  const rows = source.rows(ids);
  for (const row of rows) row.setAttribute('data-thread-lifted', '');
  drag = { ids, ghost, what, origin: { x: press.x, y: press.y }, over: null, rows, root, scroller: source.scroller?.() ?? null, scroll: { step: 0, frame: null }, point: { x: event.clientX, y: event.clientY }, source };
  document.documentElement.setAttribute('data-thread-drag', '');
  for (const target of targets) target.show(target.accepts(ids), ids);
  say(root, `${source.spoken(ids)} Drop it on the reply box, the top or bottom of the list, or hold it on another thread. Escape cancels.`);
  move(event.clientX, event.clientY);
}

/** The target a drop at (x, y) goes to: of those whose element holds the point, the highest layer, then the innermost. */
function targetAt(x: number, y: number): ThreadDropTarget | null {
  const hit = hitTest(x, y);
  if (!hit) return null;
  let best: { target: ThreadDropTarget; el: HTMLElement; layer: number } | null = null;
  for (const target of targets) {
    const el = target.element();
    if (!el || !el.contains(hit)) continue;
    const layer = target.layer ?? THREAD_DROP_LAYER.list;
    if (!best || layer > best.layer || (layer === best.layer && best.el.contains(el))) best = { target, el, layer };
  }
  return best?.target ?? null;
}

function place(ghost: HTMLElement, x: number, y: number): void {
  const width = ghost.offsetWidth || 200;
  // Near the window's right edge the ghost flips to the pointer's left.
  const gx = x + 14 + width > window.innerWidth - 8 ? x - width - 14 : x + 14;
  ghost.style.transform = `translate(${Math.round(gx)}px, ${Math.round(y - 17)}px)`;
}

function move(x: number, y: number): void {
  if (!drag) return;
  place(drag.ghost, x, y);
  const target = targetAt(x, y);
  if (target !== drag.over) {
    drag.over?.over(null);
    drag.over = target;
  }
  const answer = target ? target.accepts(drag.ids) : null;
  drag.point = { x, y };
  // `over` first: a target whose word depends on the point (a pane's side, a held row) has it before it is read.
  if (target && answer === 'take') target.over({ x, y });
  const lands = !!target && answer === 'take' && (target.takesAt?.({ x, y }) ?? true);
  drag.what.textContent = lands && target ? target.what : '';
  drag.ghost.toggleAttribute('data-refused', answer === 'refuse');
  autoScroll(drag, lands || answer === 'refuse' ? 0 : scrollStep(drag.scroller, x, y));
}

/**
 * The scroll a held thread at (x, y) asks of the list: 0 outside its edge bands, more the nearer the edge. A place
 * docked on an edge (`edge`) moves that band inside it: on the place itself nothing scrolls.
 */
export function scrollStep(list: HTMLElement | null, x: number, y: number): number {
  if (!list || list.scrollHeight <= list.clientHeight) return 0;
  const box = list.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return 0;
  let top = box.top;
  let bottom = box.bottom;
  for (const target of targets) {
    const el = target.edge ? target.element() : null;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom) continue;
    if (target.edge === 'top') top = Math.max(top, r.bottom);
    else bottom = Math.min(bottom, r.top);
  }
  if (y < top || y > bottom) return 0;
  const depth = (into: number) => Math.ceil(AUTO_SCROLL_MAX * (1 - into / AUTO_SCROLL_BAND));
  if (y < top + AUTO_SCROLL_BAND && list.scrollTop > 0) return -depth(y - top);
  if (y > bottom - AUTO_SCROLL_BAND && list.scrollTop + list.clientHeight < list.scrollHeight) return depth(bottom - y);
  return 0;
}

function autoScroll(d: Drag, step: number): void {
  d.scroll.step = step;
  if (step === 0 || d.scroll.frame !== null || typeof requestAnimationFrame !== 'function') return;
  const tick = () => {
    d.scroll.frame = null;
    if (drag !== d || d.scroll.step === 0 || !d.scroller) return;
    d.scroller.scrollTop += d.scroll.step;
    d.scroll.frame = requestAnimationFrame(tick);
  };
  d.scroll.frame = requestAnimationFrame(tick);
}

function finish(accepted: boolean, releasedAt: { x: number; y: number } | null = null): Drag | null {
  const d = drag;
  if (!d) return null;
  drag = null;
  if (d.scroll.frame !== null) cancelAnimationFrame(d.scroll.frame);
  d.scroll = { step: 0, frame: null };
  stopListening();
  d.over?.over(null);
  for (const target of targets) target.show(null, d.ids);
  for (const row of d.rows) row.removeAttribute('data-thread-lifted');
  document.documentElement.removeAttribute('data-thread-drag');
  swallowNextClick(releasedAt);
  if (accepted || reduced()) d.ghost.remove();
  else {
    // Back to where it was picked up: nothing happened.
    d.ghost.classList.remove('ib-tdrag-lift');
    d.ghost.classList.add('ib-tdrag-back');
    place(d.ghost, d.origin.x, d.origin.y);
    setTimeout(() => d.ghost.remove(), 220);
  }
  return d;
}

function end(x: number, y: number): void {
  if (!drag) return;
  const target = targetAt(x, y);
  const answer = target ? target.accepts(drag.ids) : null;
  const take = target && answer === 'take' && (target.takesAt?.({ x, y }) ?? true) ? target : null;
  // A refusing place says why (read before `show(null)` clears what it knows).
  const reason = target && answer === 'refuse' ? target.refused?.(drag.ids) : undefined;
  const source = drag.source;
  const d = finish(take !== null, { x, y });
  if (!d) return;
  if (take) {
    if (take.drop(d.ids, { x, y }) !== false) source.dropped?.(d.ids);
  } else say(d.root, `${reason ?? 'Cancelled'}. Nothing changed.`);
}

function cancel(): void {
  const d = finish(false);
  if (d) say(d.root, 'Cancelled. Nothing changed.');
}
