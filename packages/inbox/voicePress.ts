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
    onMouseDown: (event: ReactMouseEvent) => event.preventDefault(),
    onContextMenu: (event: ReactMouseEvent) => event.preventDefault(),
    onClick: (event: ReactMouseEvent) => {
      if (event.detail === 0) target.toggle();
    },
  };
}
