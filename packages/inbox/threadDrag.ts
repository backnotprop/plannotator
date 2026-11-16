/**
 * Dragging threads (approval "inbox-drag-threads"): one gesture, places that take it, shown only while a thread is
 * being dragged. Piece 1 has one place, the reply box (a mention); the list's top and bottom edges (Priority, Quiet
 * and Archive) and Combine register here the same way when they come.
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
 * Quiet and Archive at the bottom, the next piece) register as targets over those bands and stop the scroll while
 * the pointer is on them; the band stays the strip just inside them.
 */

/** What a target answers for the threads being dragged: takes them, refuses them (shown, but a drop does nothing), or is no place for them (hidden). */
export type DropAnswer = 'take' | 'refuse' | null;

export interface ThreadDropTarget {
  /** The element a drop lands on (its whole box). */
  element: () => HTMLElement | null;
  accepts: (ids: readonly string[]) => DropAnswer;
  /** The ghost's second word over it ("Mention"). */
  what: string;
  /** The drag started (`answer` for these threads) or ended (null): the target shows or hides itself. */
  show: (answer: DropAnswer, ids: readonly string[]) => void;
  /** The pointer is over it (`point`), or left it (null). */
  over: (point: { x: number; y: number } | null) => void;
  drop: (ids: readonly string[], point: { x: number; y: number }) => void;
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
}

let drag: Drag | null = null;
let press: { x: number; y: number; source: ThreadDragSource; root: HTMLElement; pointerId: number } | null = null;
/** Hit testing (a test swaps it: its DOM lays nothing out). */
let hitTest: (x: number, y: number) => Element | null = (x, y) => document.elementFromPoint(x, y);

export function setThreadDragHitTestForTests(test: ((x: number, y: number) => Element | null) | null): void {
  hitTest = test ?? ((x, y) => document.elementFromPoint(x, y));
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
  press = { x: event.clientX, y: event.clientY, source, root, pointerId: event.pointerId };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
}

function stopListening(): void {
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', onBlur);
}

function onMove(event: PointerEvent): void {
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
  if (event.key !== 'Escape' || !drag) return;
  // Escape is the drag's: it never closes the thread or a sheet under it.
  event.preventDefault();
  event.stopPropagation();
  cancel();
}

function onBlur(): void {
  if (drag) cancel();
}

/** The click that ends a drag (on the row it started on) opens nothing. */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, true), 400);
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
  drag = { ids, ghost, what, origin: { x: press.x, y: press.y }, over: null, rows, root, scroller: source.scroller?.() ?? null, scroll: { step: 0, frame: null } };
  document.documentElement.setAttribute('data-thread-drag', '');
  for (const target of targets) target.show(target.accepts(ids), ids);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
  say(root, `${source.spoken(ids)} Drop it on the reply box to mention it. Escape cancels.`);
  move(event.clientX, event.clientY);
}

function targetAt(x: number, y: number): ThreadDropTarget | null {
  const hit = hitTest(x, y);
  if (!hit) return null;
  for (const target of targets) {
    const el = target.element();
    if (el && el.contains(hit)) return target;
  }
  return null;
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
  drag.what.textContent = answer === 'take' && target ? target.what : '';
  drag.ghost.toggleAttribute('data-refused', answer === 'refuse');
  if (target && answer === 'take') target.over({ x, y });
  autoScroll(drag, target ? 0 : scrollStep(drag.scroller, x, y));
}

/** The scroll a held thread at (x, y) asks of the list: 0 outside its edge bands, more the nearer the edge. */
export function scrollStep(list: HTMLElement | null, x: number, y: number): number {
  if (!list || list.scrollHeight <= list.clientHeight) return 0;
  const box = list.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return 0;
  const depth = (into: number) => Math.ceil(AUTO_SCROLL_MAX * (1 - into / AUTO_SCROLL_BAND));
  if (y < box.top + AUTO_SCROLL_BAND && list.scrollTop > 0) return -depth(y - box.top);
  if (y > box.bottom - AUTO_SCROLL_BAND && list.scrollTop + list.clientHeight < list.scrollHeight) return depth(box.bottom - y);
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

function finish(accepted: boolean): Drag | null {
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
  swallowNextClick();
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
  const take = target && target.accepts(drag.ids) === 'take' ? target : null;
  const d = finish(take !== null);
  if (!d) return;
  if (take) take.drop(d.ids, { x, y });
  else say(d.root, 'Cancelled. Nothing changed.');
}

function cancel(): void {
  const d = finish(false);
  if (d) say(d.root, 'Cancelled. Nothing changed.');
}
