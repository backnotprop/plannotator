/**
 * The mic button's gesture, on its own so it can change without touching the rest: press and let go quickly to
 * toggle, hold to talk, and while holding slide off the button to arm a cancel. The owner judges the slide by testing
 * it on a phone: `DRAG_OFF_PX` and `slidOff` are all of it.
 *
 * Space or Enter on the focused button toggles, as a button does. That is the button's own activation, not a shortcut.
 */
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/** Let go sooner than this and it was a tap. */
export const HOLD_MS = 300;
/** This far outside the button arms the cancel. */
export const DRAG_OFF_PX = 56;

export interface VoicePressTarget {
  press(): void;
  release(): void;
  slide(off: boolean): void;
  /** The system took the pointer away. */
  lost(): void;
  toggle(): void;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function slidOff(box: Box, x: number, y: number): boolean {
  return Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom)) > DRAG_OFF_PX;
}

export function voicePressProps(target: VoicePressTarget) {
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      target.press();
    },
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
      target.slide(slidOff(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY));
    },
    onPointerUp: () => target.release(),
    onPointerCancel: () => target.lost(),
    // The caret stays in the text: a mouse press would otherwise move focus to the button.
    onMouseDown: (event: ReactMouseEvent) => event.preventDefault(),
    // A long press on a phone is the talk, not the callout.
    onContextMenu: (event: ReactMouseEvent) => event.preventDefault(),
    onClick: (event: ReactMouseEvent) => {
      // detail 0: the keyboard. A pointer's click was already the press and release.
      if (event.detail === 0) target.toggle();
    },
  };
}
