import { useRef, type TouchEvent as ReactTouchEvent } from 'react';

/** How far a finger may move and still tap. */
const TAP_SLOP_PX = 10;
/** A click this soon after a touch press is that press's own click. */
const OWN_CLICK_MS = 800;

/**
 * A button pressed by one tap of a finger, from the touch itself. A browser can drop the click of a tap that comes
 * right after a flick (Chromium does, for the touch that stops a fling), which would leave Undo needing a second
 * tap right after a row's swipe. The press runs on the finger's lift; the click that may follow is that press, so
 * it runs nothing. A mouse, a pen and the keyboard still press it by its click.
 */
export function useTouchPress(onPress: (() => void) | undefined) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const pressedAt = useRef(-Infinity);
  return {
    onTouchStart: (event: ReactTouchEvent<HTMLElement>) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      start.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchMove: (event: ReactTouchEvent<HTMLElement>) => {
      const from = start.current;
      const touch = event.touches[0];
      if (from && touch && Math.hypot(touch.clientX - from.x, touch.clientY - from.y) > TAP_SLOP_PX) start.current = null;
    },
    onTouchCancel: () => {
      start.current = null;
    },
    onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => {
      const from = start.current;
      start.current = null;
      const touch = event.changedTouches[0];
      if (!onPress || !from || !touch || Math.hypot(touch.clientX - from.x, touch.clientY - from.y) > TAP_SLOP_PX) return;
      if (event.cancelable) event.preventDefault();
      pressedAt.current = performance.now();
      onPress();
    },
    onClick: () => {
      if (performance.now() - pressedAt.current < OWN_CLICK_MS) return;
      onPress?.();
    },
  };
}
