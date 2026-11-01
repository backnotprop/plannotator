/**
 * The mic button's gesture: press and let go quickly to toggle, hold to talk. The pointer is captured, so a hold ends
 * where the finger comes up, on the button or off it.
 *
 * Space or Enter on the focused button toggles, as a button does. That is the button's own activation, not a shortcut.
 */
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/** Let go sooner than this and it was a tap. */
export const HOLD_MS = 300;

export interface VoicePressTarget {
  press(): void;
  release(): void;
  /** The system took the pointer away. */
  lost(): void;
  toggle(): void;
}

export function voicePressProps(target: VoicePressTarget) {
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      target.press();
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
