/**
 * Moving a pane of the free layout by its header (inboxSplitView). A list row's thread is carried by the window's one
 * thread drag (../threadDrag.ts, `pressThreadRow`), never here: the panes register there as a row's drop target
 * (panes/paneDrop.ts, THREAD_DROP_LAYER.pane), so a row press starts exactly one drag. This module only carries a
 * pane, from a press on its header (panes/paneKeeper.tsx), which is never on a row: the two never start together, and
 * a pane press while a thread is being dragged starts nothing.
 *
 * - Pointer events only (mouse and pen; touch never drags). A press that moves less than `DRAG_SLOP` is a click, as
 *   before; once it is a drag, the click that ends it is swallowed.
 * - While a pane is carried, a pill follows the pointer with its title and what letting go does there ("Move here").
 *   The target draws its own preview (`over`).
 * - Escape, a lost pointer or a window that loses focus cancels: nothing moves. What moved where is said in a polite
 *   live region.
 */
import { threadDragging } from '../threadDrag';

export type DragPayload = { kind: 'pane'; paneId: string; label: string };

/** What letting go at a point does: the pill's words, and anything the target needs for the drop. */
export interface DropHit {
  action: string;
  data?: unknown;
}

export interface DropTarget {
  id: string;
  accepts: (payload: DragPayload) => boolean;
  hit: (x: number, y: number, payload: DragPayload) => DropHit | null;
  /** Draw (a hit) or clear (null) the target's preview. */
  over?: (hit: DropHit | null, payload: DragPayload) => void;
  drop: (hit: DropHit, payload: DragPayload) => void;
}

/** How far a press must move before it is a drag (px). */
export const DRAG_SLOP = 5;

const targets = new Map<string, DropTarget>();
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

/** A target takes dropped panes until the returned function is called. */
export function registerDropTarget(target: DropTarget): () => void {
  targets.set(target.id, target);
  return () => {
    if (targets.get(target.id) === target) targets.delete(target.id);
  };
}

/** The target that takes a point. */
export function targetAt(x: number, y: number, payload: DragPayload): { target: DropTarget; hit: DropHit } | null {
  for (const target of targets.values()) {
    if (!target.accepts(payload)) continue;
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
      action.textContent = words ?? '';
      el.toggleAttribute('data-none', words === null);
      // Beside the pointer, flipped to its left or above it near the window's edge so it stays whole.
      const { width, height } = el.getBoundingClientRect();
      const left = x + 14 + width > window.innerWidth - 8 ? x - 14 - width : x + 14;
      const top = y + 12 + height > window.innerHeight - 8 ? y - 12 - height : y + 12;
      el.style.transform = `translate(${Math.round(Math.max(8, left))}px, ${Math.round(Math.max(8, top))}px)`;
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
  if (event.button !== 0 || event.pointerType === 'touch' || threadDragging()) return;
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
