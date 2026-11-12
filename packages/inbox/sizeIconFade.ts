import { useCallback, useEffect, useRef, useState } from 'react';

export const SIZE_ICON_SHOW_MS = 3000;

export const SIZE_ICON_TAP_BELOW = 44;

export function tapNearSizeIcon(clientY: number, iconBottom: number): boolean {
  return clientY <= iconBottom + SIZE_ICON_TAP_BELOW;
}

export interface SizeIconFade {
  shown: boolean;
  wake: () => void;
  hold: (held: boolean) => void;
}

export function useSizeIconFade(active: boolean, openKey: string): SizeIconFade {
  const [shown, setShown] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const wake = useCallback(() => {
    setShown(true);
    clear();
    if (held.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setShown(false);
    }, SIZE_ICON_SHOW_MS);
  }, [clear]);

  const hold = useCallback(
    (on: boolean) => {
      const was = held.current;
      held.current = on;
      if (on || was) wake();
    },
    [wake],
  );

  useEffect(() => {
    if (!active) {
      clear();
      return;
    }
    held.current = false;
    wake();
    return clear;
  }, [active, openKey, wake, clear]);

  return { shown, wake, hold };
}
