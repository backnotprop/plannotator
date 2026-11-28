/**
 * Filter by typing's motion in the list itself (the motion study of 2026-11-24; the field's own is titleFilterMotion.ts):
 *
 * - A key narrows the list: a row (or a band) that stops matching shrinks and fades where it was (120 ms; its words go
 *   in the first 84 ms), and the rows under it glide up into the space as it closes. A band's count that changes fades
 *   in from 0.3. Rows a wider match brings back fade in where they land.
 * - The field closes: the rows still drawn glide to their places in the whole list while the rows coming back fade in
 *   where they land, in the field's 180 ms.
 * - Reduced motion, or no Web Animations: none of it; the list changes at once.
 *
 * Bounded work, whatever the list's size: only the rows and bands in view (at most `CAP`) are measured before the
 * change and after it, found by a binary search down each group in view. A leaving row is not kept in React: a copy of
 * it (inert, hidden from assistive technology, no thread id) plays its exit over the list and goes. Only transforms and
 * opacity are animated, so no frame lays the list out again; the filter pass itself is untouched.
 */
import { reducedMotion } from './titleFilterMotion';

const CALM = 'cubic-bezier(0.25, 0.8, 0.25, 1)';
/** A row that stops matching. */
export const LEAVE_MS = 120;
/** The field's close, which the whole list's return shares. */
export const RETURN_MS = 180;
/** At most this many rows and bands move at once: about two screens of rows. */
const CAP = 40;
/** A copy playing its exit (never a row of the list). */
const GHOST = 'data-tflt-ghost';

interface Seen {
  rect: DOMRect;
  /** The group it was drawn in (a band or a row's). */
  group: HTMLElement;
  /** A band's count. */
  count: string | null;
}

/** The rows and bands in view before a change, where they were on screen. */
export interface ListShot {
  body: HTMLElement;
  box: DOMRect;
  units: Map<HTMLElement, Seen>;
}

/** Our animations on a row, stopped when the next change measures it. */
const running = new WeakMap<HTMLElement, Animation[]>();

const isGhost = (el: Element) => el.hasAttribute(GHOST);

/** The rows and bands of the list in view (`.ib-lbody > .ib-group > *`), top to bottom, at most `CAP`. */
function unitsInView(body: HTMLElement, view: DOMRect): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const group of body.children) {
    if (!group.classList.contains('ib-group') || isGhost(group)) continue;
    const box = group.getBoundingClientRect();
    if (box.bottom <= view.top) continue;
    if (box.top >= view.bottom) break;
    const kids = group.children;
    // The first child whose bottom is past the view's top (a group's children run down the page).
    let lo = 0;
    let hi = kids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid]!.getBoundingClientRect().bottom <= view.top) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < kids.length; i += 1) {
      const kid = kids[i] as HTMLElement;
      const rect = kid.getBoundingClientRect();
      if (rect.top >= view.bottom) break;
      if (rect.height === 0) continue;
      out.push(kid);
      if (out.length >= CAP) return out;
    }
  }
  return out;
}

/** Before a change: the rows and bands in view. Null: nothing to animate (reduced motion, no layout, no list). */
export function shootList(body: HTMLElement | null | undefined): ListShot | null {
  if (!body || typeof body.animate !== 'function' || reducedMotion()) return null;
  const box = body.getBoundingClientRect();
  if (box.height === 0) return null;
  const units = new Map<HTMLElement, Seen>();
  for (const el of unitsInView(body, box)) {
    units.set(el, { rect: el.getBoundingClientRect(), group: el.parentElement as HTMLElement, count: el.querySelector('.ib-n')?.textContent ?? null });
  }
  return units.size > 0 ? { body, box, units } : null;
}

function play(el: HTMLElement, frames: Keyframe[], ms: number, easing = CALM) {
  const animation = el.animate(frames, { duration: ms, easing });
  running.set(el, [...(running.get(el) ?? []), animation]);
  const done = () => {
    const left = (running.get(el) ?? []).filter((a) => a !== animation);
    if (left.length > 0) running.set(el, left);
    else running.delete(el);
  };
  Promise.resolve(animation.finished).then(done, done);
}

function halt(el: HTMLElement) {
  for (const animation of running.get(el) ?? []) animation.cancel();
  running.delete(el);
}

/** A copy of a row or band that has left, shrinking and fading where it was, over the list. */
function playExit(body: HTMLElement, box: DOMRect, el: HTMLElement, seen: Seen, ms: number) {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const node of [copy, ...copy.querySelectorAll<HTMLElement>('[id], [data-thread-id], [data-section-id]')]) {
    node.removeAttribute('id');
    node.removeAttribute('data-thread-id');
    node.removeAttribute('data-section-id');
  }
  Object.assign(copy.style, { width: `${seen.rect.width}px`, height: `${seen.rect.height}px`, margin: '0', contentVisibility: 'visible', transformOrigin: 'top' });
  // In a copy of its group, so the list's own rules still draw it; out of the flow, where it was on screen.
  const ghost = document.createElement('div');
  ghost.className = seen.group.className;
  ghost.setAttribute(GHOST, '');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  const left = seen.rect.left - box.left - body.clientLeft + body.scrollLeft;
  const top = seen.rect.top - box.top - body.clientTop + body.scrollTop;
  Object.assign(ghost.style, { position: 'absolute', left: `${left}px`, top: `${top}px`, margin: '0', padding: '0', border: '0', background: 'none', pointerEvents: 'none' });
  ghost.append(copy);
  body.append(ghost);
  // Its bottom edge closes on the curve the rows under it glide up on; its words go first.
  const exit = copy.animate(
    [
      { opacity: 1, transform: 'scaleY(1)' },
      { opacity: 0, offset: 0.7 },
      { opacity: 0, transform: 'scaleY(0)' },
    ],
    { duration: ms, easing: CALM, fill: 'forwards' },
  );
  const gone = () => ghost.remove();
  Promise.resolve(exit.finished).then(gone, gone);
}

/**
 * After the change, in the same task (the list is drawn, not yet painted): rows that left play their exit, rows still
 * drawn glide from where they were, rows new in view fade in. `ms`: `LEAVE_MS` for a key, `RETURN_MS` for the close.
 */
export function playListChange(shot: ListShot | null, ms: number) {
  if (!shot || !shot.body.isConnected) return;
  const { body, box, units } = shot;
  const view = body.getBoundingClientRect();
  const exits: [HTMLElement, Seen][] = [];
  const moves: [HTMLElement, number][] = [];
  const counts: HTMLElement[] = [];
  /** How far the lowest row still drawn moved: rows coming into view under it came from as far below. */
  let lastShift: number | null = null;
  for (const [el, seen] of units) {
    if (!el.isConnected) {
      exits.push([el, seen]);
      continue;
    }
    halt(el);
    const rect = el.getBoundingClientRect();
    const shift = seen.rect.top - rect.top;
    lastShift = shift;
    if (Math.abs(shift) >= 1 && Math.abs(shift) < view.height) moves.push([el, shift]);
    const count = el.querySelector<HTMLElement>('.ib-n');
    if (count && seen.count !== null && count.textContent !== seen.count) counts.push(count);
  }
  const fresh = unitsInView(body, view).filter((el) => !units.has(el));
  // Every write after every read: one layout for the whole change.
  for (const [el, seen] of exits) playExit(body, box, el, seen, ms);
  for (const [el, shift] of moves) play(el, [{ transform: `translateY(${shift}px)` }, { transform: 'none' }], ms);
  for (const count of counts) play(count, [{ opacity: 0.3 }, { opacity: 1 }], ms, 'linear');
  for (const el of fresh) {
    halt(el);
    if (lastShift !== null && lastShift > 0 && lastShift < view.height) play(el, [{ transform: `translateY(${lastShift}px)` }, { transform: 'none' }], ms);
    else play(el, [{ opacity: 0 }, { opacity: 1 }], ms);
  }
}
