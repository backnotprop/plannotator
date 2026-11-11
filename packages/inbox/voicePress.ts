import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { debugLogOn } from './debugLog';

export const HOLD_MS = 300;

export interface VoicePoint {
  dx: number;
  dy: number;
}

export interface VoicePressTarget {
  press(at?: VoicePoint): void;
  release(at?: VoicePoint): void;
  /** The system took the pointer away: no point, since a pointercancel can carry 0,0 or a stale one. */
  lost(): void;
  toggle(): void;
}

function pointAt(event: ReactPointerEvent<HTMLButtonElement>): VoicePoint | undefined {
  if (!debugLogOn()) return undefined;
  try {
    const rect = event.currentTarget.getBoundingClientRect();
    return { dx: Math.round(event.clientX - (rect.left + rect.width / 2)), dy: Math.round(event.clientY - (rect.top + rect.height / 2)) };
  } catch {
    return undefined;
  }
}

export function voicePressProps(target: VoicePressTarget) {
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      target.press(pointAt(event));
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => target.release(pointAt(event)),
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
