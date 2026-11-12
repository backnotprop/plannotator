import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

const STAR_REACH = { mouse: 7, touch: 16 } as const;
const SECOND_PRESS_MS = 400;
const SECOND_PRESS_PX = 24;

let pointer: string = 'mouse';
let lastStarPress: { threadId: string; x: number; y: number; at: number } | null = null;

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

function secondPress(event: ReactMouseEvent<HTMLElement>, threadId: string): boolean {
  if (event.detail === 0 || lastStarPress?.threadId !== threadId) return false;
  return (
    (event.detail >= 2 || Date.now() - lastStarPress.at <= SECOND_PRESS_MS) &&
    Math.abs(event.clientX - lastStarPress.x) <= SECOND_PRESS_PX &&
    Math.abs(event.clientY - lastStarPress.y) <= SECOND_PRESS_PX
  );
}

export function pressRow(event: ReactMouseEvent<HTMLElement>, threadId: string, onOpen: () => void, onUnstar?: () => void): void {
  if (secondPress(event, threadId)) return;
  if (onUnstar && pressedStar(event)) {
    lastStarPress = { threadId, x: event.clientX, y: event.clientY, at: Date.now() };
    onUnstar();
    return;
  }
  onOpen();
}
