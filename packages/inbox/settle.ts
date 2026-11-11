import { shellSpring } from './shell/shell-motion';

export const COVERED_LIST_SETTLES: 'while-covered' | 'on-back' = 'while-covered';

export const SETTLE_BEAT_MS = 160;

export const SETTLE_AFTER_SIDEBAR_MS = Math.round(shellSpring.duration * 1000) + 40;

export const SETTLE_MOVE_MS = 220;
export const SETTLE_MOVE_EASE = 'cubic-bezier(0.645, 0.045, 0.355, 1)';
export const SETTLE_LEAVE_MS = 160;
export const SETTLE_ENTER_MS = 160;
export const SETTLE_ENTER_DELAY_MS = 120;
export const SETTLE_EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const SHOW_LIT_AFTER_SLIDE_MS = Math.max(SETTLE_MOVE_MS, SETTLE_ENTER_DELAY_MS + SETTLE_ENTER_MS);
export const SHOW_LIT_MS = 3000;
export const SETTLE_ANIMATION_ID = 'ib-settle';

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface SettlePlan {
  moves: { key: string; dx: number; dy: number }[];
  enters: string[];
  leaves: string[];
}

function visible(box: Box, viewport: { top: number; bottom: number }): boolean {
  return box.top + box.height > viewport.top && box.top < viewport.bottom;
}

export function planSettle(before: ReadonlyMap<string, Box>, after: ReadonlyMap<string, Box>, viewport: { top: number; bottom: number }): SettlePlan {
  const plan: SettlePlan = { moves: [], enters: [], leaves: [] };
  for (const [key, now] of after) {
    const was = before.get(key);
    if (!was) {
      if (visible(now, viewport)) plan.enters.push(key);
      continue;
    }
    if (Math.abs(was.width - now.width) > 2) continue;
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    if (!visible(was, viewport) && !visible(now, viewport)) continue;
    plan.moves.push({ key, dx, dy });
  }
  for (const [key, was] of before) if (!after.has(key) && visible(was, viewport)) plan.leaves.push(key);
  return plan;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function listBody(root: ParentNode | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('.ib-listcol .ib-lbody') ?? null;
}

const MOVERS = ':scope > .ib-group > .ib-rw[data-row], :scope > .ib-group > .ib-mrow[data-thread-id], :scope > .ib-group > .ib-band';

function keyOf(el: HTMLElement): string {
  const row = el.getAttribute('data-row') ?? el.getAttribute('data-thread-id');
  if (row) return `row:${row}`;
  return `band:${el.closest('[data-section-id]')?.getAttribute('data-section-id') ?? ''}`;
}

function movers(body: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const el of body.querySelectorAll<HTMLElement>(MOVERS)) out.set(keyOf(el), el);
  return out;
}

function boxOf(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export interface SettleSnapshot {
  order: string[];
  boxes: Map<string, Box>;
  elements: Map<string, HTMLElement>;
  bodyBox: Box;
  scrollTop: number;
}

export function stopSettle(body: HTMLElement): void {
  for (const ghost of body.querySelectorAll('.ib-settle-ghost')) ghost.remove();
  if (typeof body.getAnimations !== 'function') return;
  for (const animation of body.getAnimations({ subtree: true })) if (animation.id === SETTLE_ANIMATION_ID) animation.cancel();
}

/** Measure the rows before the list changes. Read-only: the boxes include any settle in flight, so the next one starts from where the rows are on screen. */
export function captureSettle(body: HTMLElement): SettleSnapshot {
  const elements = movers(body);
  const boxes = new Map<string, Box>();
  for (const [key, el] of elements) boxes.set(key, boxOf(el));
  return { order: [...elements.keys()].filter((k) => k.startsWith('row:')).map((k) => k.slice(4)), boxes, elements, bodyBox: boxOf(body), scrollTop: body.scrollTop };
}

export function playSettle(body: HTMLElement, before: SettleSnapshot): SettlePlan {
  stopSettle(body);
  const now = movers(body);
  const after = new Map<string, Box>();
  for (const [key, el] of now) after.set(key, boxOf(el));
  const bodyBox = boxOf(body);
  const plan = planSettle(before.boxes, after, { top: bodyBox.top, bottom: bodyBox.top + bodyBox.height });
  if (typeof HTMLElement.prototype.animate !== 'function') return plan;
  for (const { key, dx, dy } of plan.moves) {
    // Above what is fading in or out on its way (a row is positioned; z-index holds only while it moves).
    now.get(key)!.animate([{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 1 }, { transform: 'none', zIndex: 1 }], {
      id: SETTLE_ANIMATION_ID,
      duration: SETTLE_MOVE_MS,
      easing: SETTLE_MOVE_EASE,
    });
  }
  for (const key of plan.enters) {
    now.get(key)!.animate([{ opacity: 0 }, { opacity: 1 }], {
      id: SETTLE_ANIMATION_ID,
      duration: SETTLE_ENTER_MS,
      delay: SETTLE_ENTER_DELAY_MS,
      easing: SETTLE_EASE_OUT,
      fill: 'backwards',
    });
  }
  for (const key of plan.leaves) {
    const source = before.elements.get(key);
    const was = before.boxes.get(key)!;
    if (!source) continue;
    const ghost = source.cloneNode(true) as HTMLElement;
    for (const el of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]) {
      el.removeAttribute('data-row');
      el.removeAttribute('data-thread-id');
      el.removeAttribute('id');
      el.removeAttribute('aria-current');
    }
    ghost.classList.add('ib-settle-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('inert', '');
    ghost.style.top = `${was.top - before.bodyBox.top + before.scrollTop}px`;
    ghost.style.left = `${was.left - before.bodyBox.left}px`;
    ghost.style.width = `${was.width}px`;
    ghost.style.height = `${was.height}px`;
    body.appendChild(ghost);
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { id: SETTLE_ANIMATION_ID, duration: SETTLE_LEAVE_MS, easing: SETTLE_EASE_OUT, fill: 'forwards' });
    const drop = () => ghost.remove();
    fade.onfinish = drop;
    fade.oncancel = drop;
  }
  return plan;
}

export function rowInSlot(order: readonly string[], gone: string, present: (id: string) => boolean): string | null {
  const at = order.indexOf(gone);
  if (at < 0) return null;
  for (const id of order.slice(at + 1)) if (present(id)) return id;
  for (const id of order.slice(0, at).reverse()) if (present(id)) return id;
  return null;
}
