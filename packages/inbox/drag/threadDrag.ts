/**
 * The Inbox's one drag system: what can be picked up (a list row's thread, a pane by its header) and where it can be
 * put (the thread panes; later the reply box's mention and the list's Priority and Quiet edges). Sources and targets
 * register here and nowhere else, so a new target is one `registerDropTarget` call and no source changes.
 *
 * - Pointer events only (mouse and pen; touch never drags: a phone and a tablet scroll the list). A press that moves
 *   less than `DRAG_SLOP` is a click, as before; once it is a drag, the click that ends it is swallowed.
 * - While a drag is on, a pill follows the pointer with what is carried and what letting go does there ("Open beside",
 *   "Open here", "Move here"). Targets draw their own preview (`over`), only while a drag is on.
 * - Where several targets take a point, the highest `layer` wins: a reply box (LAYER.reply) inside a pane (LAYER.pane)
 *   takes the drop, so the pane's zone never swallows it. A target returns null from `hit` for a point it declines.
 * - Escape, a lost pointer or a window that loses focus cancels: nothing moves. What was picked up and where it went
 *   is said in a polite live region.
 * - A list row is a source only while some target takes threads: with the free layout off nothing registers, so a
 *   row press is exactly today's.
 */

export type DragPayload =
  | { kind: 'thread'; threadId: string; label: string }
  | { kind: 'pane'; paneId: string; label: string };

/** What letting go at a point does: the pill's words, and anything the target needs for the drop. */
export interface DropHit {
  action: string;
  data?: unknown;
}

export interface DropTarget {
  id: string;
  /** The higher wins where targets overlap (LAYER). */
  layer: number;
  accepts: (payload: DragPayload) => boolean;
  hit: (x: number, y: number, payload: DragPayload) => DropHit | null;
  /** Draw (a hit) or clear (null) the target's preview. */
  over?: (hit: DropHit | null, payload: DragPayload) => void;
  drop: (hit: DropHit, payload: DragPayload) => void;
}

/** The layers in use and reserved, so separate branches stack their targets the same way. */
export const LAYER = { pane: 10, listEdge: 20, reply: 30 } as const;

/** How far a press must move before it is a drag (px). */
export const DRAG_SLOP = 5;

const targets = new Map<string, DropTarget>();
let rowSource: (() => void) | null = null;
let live: HTMLElement | null = null;

/** The window the drag's pill and live region go in, so they take its tokens (the theme, the Soft switches). */
const host = (): HTMLElement => document.querySelector<HTMLElement>('.pn-inbox') ?? document.body;

/** Say `words` in the drag's polite live region. */
export function announce(words: string): void {
  if (typeof document === 'undefined') return;
  if (!live || !live.isConnected) {
    live = document.createElement('div');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.dataset.dragLive = '';
    Object.assign(live.style, { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' });
    host().appendChild(live);
  }
  live.textContent = '';
  const at = live;
  // A new text node after a clear, so the same words twice are said twice.
  queueMicrotask(() => {
    at.textContent = words;
  });
}

/** A target takes drops until the returned function is called. */
export function registerDropTarget(target: DropTarget): () => void {
  targets.set(target.id, target);
  syncRowSource();
  return () => {
    if (targets.get(target.id) === target) targets.delete(target.id);
    syncRowSource();
  };
}

export const takesThreads = (): boolean => [...targets.values()].some((target) => target.accepts({ kind: 'thread', threadId: '', label: '' }));

/** The target that takes a point, the highest layer first. */
export function targetAt(x: number, y: number, payload: DragPayload): { target: DropTarget; hit: DropHit } | null {
  const order = [...targets.values()].filter((target) => target.accepts(payload)).sort((a, b) => b.layer - a.layer);
  for (const target of order) {
    const hit = target.hit(x, y, payload);
    if (hit) return { target, hit };
  }
  return null;
}

/** The pill that follows the pointer. */
function makeGhost(label: string): { el: HTMLElement; at: (x: number, y: number, action: string | null) => void } {
  const el = document.createElement('div');
  el.className = 'ib-dragghost';
  el.setAttribute('aria-hidden', 'true');
  const what = document.createElement('span');
  what.className = 'ib-dragghost-what';
  what.textContent = label;
  const action = document.createElement('span');
  action.className = 'ib-dragghost-act';
  el.append(what, action);
  host().appendChild(el);
  return {
    el,
    at(x, y, words) {
      el.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`;
      action.textContent = words ?? '';
      el.toggleAttribute('data-none', words === null);
    },
  };
}

export interface DragStart {
  /** The press that may become a drag. */
  event: PointerEvent;
  payload: DragPayload;
  /** The drag began (past the slop). */
  onBegin?: () => void;
  /** The drag ended: `dropped` when a target took it. */
  onEnd?: (dropped: boolean) => void;
}

/** A press that becomes a drag once it moves `DRAG_SLOP`; until then nothing happens and the click is the press's. */
export function pressToDrag({ event, payload, onBegin, onEnd }: DragStart): void {
  if (event.button !== 0 || event.pointerType === 'touch') return;
  const startX = event.clientX;
  const startY = event.clientY;
  const pointer = event.pointerId;
  let ghost: ReturnType<typeof makeGhost> | null = null;
  let current: { target: DropTarget; hit: DropHit } | null = null;
  const show = (next: { target: DropTarget; hit: DropHit } | null) => {
    if (current && current.target !== next?.target) current.target.over?.(null, payload);
    if (next) next.target.over?.(next.hit, payload);
    current = next;
  };
  const moved = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    if (!ghost) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP) return;
      ghost = makeGhost(payload.label);
      document.documentElement.dataset.ibDragging = payload.kind;
      window.getSelection()?.removeAllRanges();
      onBegin?.();
      announce(`Picked up ${payload.label}. Escape cancels.`);
    }
    e.preventDefault();
    const next = targetAt(e.clientX, e.clientY, payload);
    show(next);
    ghost.at(e.clientX, e.clientY, next?.hit.action ?? null);
  };
  const finish = (drop: boolean, e?: PointerEvent) => {
    window.removeEventListener('pointermove', moved, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel);
    if (!ghost) return;
    ghost.el.remove();
    delete document.documentElement.dataset.ibDragging;
    // The click that ends a drag is not a click on what was under the press; the next press, or a click that never
    // came, ends the swallow.
    const clear = () => {
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('pointerdown', clear, true);
    };
    const swallow = (click: MouseEvent) => {
      click.preventDefault();
      click.stopPropagation();
      clear();
    };
    window.addEventListener('click', swallow, true);
    window.addEventListener('pointerdown', clear, true);
    setTimeout(clear, 0);
    const at = drop && e ? targetAt(e.clientX, e.clientY, payload) : null;
    show(null);
    if (at) at.target.drop(at.hit, payload);
    else announce(`${payload.label} put back.`);
    onEnd?.(!!at);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId === pointer) finish(true, e);
  };
  const cancel = () => finish(false);
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !ghost) return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  window.addEventListener('pointermove', moved, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('blur', cancel);
}

/** A list row's thread, picked up by a press on the row (not on a control inside it). */
function rowPress(event: PointerEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest<HTMLElement>('.ib-lbody [data-thread-id]');
  if (!row || target!.closest('input, textarea, [contenteditable="true"], [role="menuitem"]') || !takesThreads()) return;
  if (row.closest('[data-picking]') || row.getAttribute('aria-pressed') !== null) return;
  const threadId = row.dataset.threadId!;
  const label = row.querySelector('.ib-subj')?.textContent?.trim() || 'Thread';
  pressToDrag({ event, payload: { kind: 'thread', threadId, label: label.length > 60 ? `${label.slice(0, 57)}…` : label } });
}

/** The rows are a source while a target takes threads. */
function syncRowSource(): void {
  if (typeof document === 'undefined') return;
  const on = takesThreads();
  if (on && !rowSource) {
    document.addEventListener('pointerdown', rowPress, true);
    rowSource = () => document.removeEventListener('pointerdown', rowPress, true);
  } else if (!on && rowSource) {
    rowSource();
    rowSource = null;
  }
}
