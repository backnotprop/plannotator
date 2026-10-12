/**
 * When the list on screen catches up, and how it moves when it does (design
 * record "inbox-open-stays-put", variant B, approved 2026-10-12; not in this
 * repo). While any thread is open the list holds still: opening a row records
 * the look and unbolds that row in place. The list settles (takes the
 * person's own reads and actions) when the thread is closed, the folder
 * changes, Decisions or Settings open, or Show is pressed.
 *
 * On a wide window the list is beside the thread, so closing it is the
 * moment to settle: the list widens first, then, a beat later, the rows
 * slide to their places, so the widening and the move read as two things.
 * Where the thread covers the list (a phone, a stacked window) the switch
 * below decides.
 *
 * The motion is FLIP over the Web Animations API: measure every row, change
 * the list, measure again, play each row from where it was. Composite only
 * (transform, opacity), interruptible (a settle that starts mid-flight starts
 * from where the rows are on screen), and nothing moves under
 * prefers-reduced-motion: the list changes in one frame.
 */

/**
 * Where the thread covers the list (a phone, a stacked window): when does the
 * list catch up? Owner's answer, 2026-10-12: "The list exactly as you left
 * it". Back shows the list as the person left it (their row in place, no
 * longer bold, focus on it); it settles while the next thread covers it, or
 * on Show or a folder change.
 *
 * `'on-back'` is the other option the owner was offered: settle when the
 * person goes Back, with the same slide as a wide window. Changing this one
 * value is the whole switch.
 */
export const COVERED_LIST_SETTLES: 'while-covered' | 'on-back' = 'while-covered';

/**
 * The beat between the list widening (the thread closed) and the rows
 * moving. Long enough for the eye to take the widening as its own change,
 * short enough that the settle still reads as the result of closing.
 */
export const SETTLE_BEAT_MS = 160;

/**
 * Rows already on screen moving to new places: an on-screen move, so a
 * symmetric ease-in-out (the named ease-in-out-cubic), at the low end of
 * "standard UI" so a list the person sees many times a day stays quick.
 */
export const SETTLE_MOVE_MS = 220;
export const SETTLE_MOVE_EASE = 'cubic-bezier(0.645, 0.045, 0.355, 1)';
/** A row that left the rows on screen (for folded Quiet) fades where it was: an exit, faster than the move, ease-out. */
export const SETTLE_LEAVE_MS = 160;
/**
 * A row or band that joined the rows on screen fades in where it lands: an
 * entrance, ease-out (the codebase's strong ease-out), after most of the
 * slide, so the rows moving past its place do not cross it while it appears.
 */
export const SETTLE_ENTER_MS = 160;
export const SETTLE_ENTER_DELAY_MS = 120;
export const SETTLE_EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
/** The id every settle animation carries, so a new settle can cancel the last one's. */
export const SETTLE_ANIMATION_ID = 'ib-settle';

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface SettlePlan {
  /** Rows on screen before and after: play each from `dx, dy` back to its place. */
  moves: { key: string; dx: number; dy: number }[];
  /** Rows only after: fade in. */
  enters: string[];
  /** Rows only before: fade out where they were. */
  leaves: string[];
}

function visible(box: Box, viewport: { top: number; bottom: number }): boolean {
  return box.top + box.height > viewport.top && box.top < viewport.bottom;
}

/**
 * What to play, from every row's box before and after the change. Pure.
 * A row is left alone when it did not move (under a pixel), when its shape
 * changed (the row was redrawn at another width: a FLIP would stretch it),
 * and when it is out of the list's viewport both before and after (nobody
 * sees it, so it costs nothing). Rows that enter or leave count only where
 * they can be seen.
 */
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

/** The list's scroll box (the full list, or the column beside a thread). */
export function listBody(root: ParentNode | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('.ib-listcol .ib-lbody') ?? null;
}

/** The elements that move: each row (with its hover action), a phone's row, and each section's band. */
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

/** The rows' order and boxes before the list changes, and a copy of each row to fade out if it leaves. */
export interface SettleSnapshot {
  order: string[];
  boxes: Map<string, Box>;
  elements: Map<string, HTMLElement>;
  bodyBox: Box;
  scrollTop: number;
}

/** Stop a settle that is still playing (its rows jump to their places) and drop its fading copies. */
function stopPlaying(body: HTMLElement): void {
  for (const ghost of body.querySelectorAll('.ib-settle-ghost')) ghost.remove();
  if (typeof body.getAnimations !== 'function') return;
  for (const animation of body.getAnimations({ subtree: true })) if (animation.id === SETTLE_ANIMATION_ID) animation.cancel();
}

/**
 * Measure the rows before the list changes. Read-only: the boxes include any
 * settle still in flight, so the next one starts from where the rows are on
 * screen (interruptible), and the old animations are stopped only in
 * `playSettle`, after the change, together with the new reads.
 */
export function captureSettle(body: HTMLElement): SettleSnapshot {
  const elements = movers(body);
  const boxes = new Map<string, Box>();
  for (const [key, el] of elements) boxes.set(key, boxOf(el));
  return { order: [...elements.keys()].filter((k) => k.startsWith('row:')).map((k) => k.slice(4)), boxes, elements, bodyBox: boxOf(body), scrollTop: body.scrollTop };
}

/**
 * Play the change from `before`: reads first (every row's new box), then
 * writes (the animations), never interleaved. Returns the plan it played.
 */
export function playSettle(body: HTMLElement, before: SettleSnapshot): SettlePlan {
  stopPlaying(body);
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
    // A copy of the row that left, drawn where it was and faded out: the slide
    // shows where the rows went, the fade shows that this one left.
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
    // In the list's content box (it scrolls with the rows), from where the row was when measured.
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

/**
 * The row to put focus on when the one that had it left the rows on screen
 * (it went to folded Quiet): the row that now sits in its slot, the next one
 * in the old order still on screen, else the one before it. Pure.
 */
export function rowInSlot(order: readonly string[], gone: string, present: (id: string) => boolean): string | null {
  const at = order.indexOf(gone);
  if (at < 0) return null;
  for (const id of order.slice(at + 1)) if (present(id)) return id;
  for (const id of order.slice(0, at).reverse()) if (present(id)) return id;
  return null;
}
