/**
 * Which press on a list row lands on its star (the owner, 2026-11-05: a star showing can be clicked to unstar). The star
 * is drawn inside the row's own button (a button cannot hold a button), so the row's click decides: by the target, and by
 * where the press fell for the reach around the star. Enter and Space (a click with no pointer) always open the thread:
 * the keyboard unstars from the row's menu.
 */
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/** How far past the 13 px star a press still counts, by the pointer's type: a 45 px target for a touch. */
const STAR_REACH = { mouse: 7, touch: 16 } as const;
/** A double click or double tap: the second press of one is this soon and this near the first. */
const SECOND_PRESS_MS = 400;
const SECOND_PRESS_PX = 24;

let pointer: string = 'mouse';
let lastStarPress: { threadId: string; x: number; y: number; at: number } | null = null;

/** The row's pointerdown: a click does not say in every browser which pointer made it. */
export function notePressPointer(event: ReactPointerEvent<HTMLElement>): void {
  pointer = event.pointerType;
}

function pressedStar(event: ReactMouseEvent<HTMLElement>): boolean {
  const star = event.currentTarget.querySelector<HTMLElement>('[data-star-press]');
  if (!star) return false;
  if (event.target instanceof Element && event.target.closest('[data-star-press]')) return true;
  if (event.detail === 0) return false;
  const reach = pointer === 'touch' ? STAR_REACH.touch : STAR_REACH.mouse;
  const box = star.getBoundingClientRect();
  return event.clientX >= box.left - reach && event.clientX <= box.right + reach && event.clientY >= box.top - reach && event.clientY <= box.bottom + reach;
}

/** The rest of a double press on a star: it must not open the thread the first press just unstarred. */
function secondPress(event: ReactMouseEvent<HTMLElement>, threadId: string): boolean {
  if (event.detail === 0 || lastStarPress?.threadId !== threadId) return false;
  return (
    Date.now() - lastStarPress.at <= SECOND_PRESS_MS &&
    Math.abs(event.clientX - lastStarPress.x) <= SECOND_PRESS_PX &&
    Math.abs(event.clientY - lastStarPress.y) <= SECOND_PRESS_PX
  );
}

/** A click on a list row: its star unstars, the rest of the row opens the thread. */
export function pressRow(event: ReactMouseEvent<HTMLElement>, threadId: string, onOpen: () => void, onUnstar?: () => void): void {
  if (secondPress(event, threadId)) return;
  if (onUnstar && pressedStar(event)) {
    lastStarPress = { threadId, x: event.clientX, y: event.clientY, at: Date.now() };
    onUnstar();
    return;
  }
  onOpen();
}
