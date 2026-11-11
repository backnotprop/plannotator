import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

export const HOLD_MS = 450;
const SLOP = 10;

export function useHoldPress(enabled: boolean, onHold: () => void) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const latest = useRef(onHold);
  latest.current = onHold;
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
    setHolding(false);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled]);
  return {
    holding: enabled && holding,
    props: enabled
      ? {
          onPointerDown: (e: ReactPointerEvent) => {
            held.current = false;
            if (e.pointerType === 'mouse' || e.button !== 0) return;
            stop();
            start.current = { x: e.clientX, y: e.clientY };
            setHolding(true);
            timer.current = setTimeout(() => {
              timer.current = null;
              start.current = null;
              held.current = true;
              setHolding(false);
              navigator.vibrate?.(8);
              latest.current();
            }, HOLD_MS);
          },
          onPointerMove: (e: ReactPointerEvent) => {
            const s = start.current;
            if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP) stop();
          },
          onPointerUp: stop,
          onPointerCancel: stop,
          onPointerLeave: stop,
          // The browser's own long-press menu (Android) would race the tray.
          onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
        }
      : {},
    swallowClick: (): boolean => {
      if (!held.current) return false;
      held.current = false;
      return true;
    },
  };
}
