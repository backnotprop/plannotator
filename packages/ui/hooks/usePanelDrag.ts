import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { SWIPE_FLICK_MIN_PX, SWIPE_FLICK_SPEED } from './useSwipeStep';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

type DragFrame = { distance: number };

function paint(panel: HTMLElement, frame: DragFrame | null) {
  if (frame) {
    panel.setAttribute('data-pn-panel-drag', 'closing');
    panel.style.setProperty('--pn-panel-drag-distance', `${frame.distance}px`);
  } else {
    panel.removeAttribute('data-pn-panel-drag');
    panel.style.removeProperty('--pn-panel-drag-distance');
  }
}

interface PanelDragOptions {
  selector: string;
  onClose: () => void;
  fallbackWidth?: () => number;
}

/** Track a closing drag without rerendering for every move. */
export function usePanelDrag({ selector, onClose, fallbackWidth }: PanelDragOptions) {
  const reduced = usePrefersReducedMotion();
  const frame = useRef<DragFrame | null>(null);
  const element = useRef<HTMLElement | null>(null);
  const [phase, setPhase] = useState(0);

  // Paint after mounting and after committing the end state. A fresh phase
  // object also handles a complete gesture batched into a single render.
  useLayoutEffect(() => {
    element.current = document.querySelector<HTMLElement>(selector);
    if (element.current) paint(element.current, frame.current);
  }, [phase, selector]);

  const cancel = useCallback(() => {
    if (!frame.current) return;
    frame.current = null;
    setPhase(value => value + 1);
  }, []);

  return {
    cancel,
    gesture: reduced ? undefined : {
      onMove: (distance: number) => {
        frame.current = { distance };
        if (!element.current?.isConnected) element.current = document.querySelector<HTMLElement>(selector);
        if (element.current) paint(element.current, frame.current);
      },
      onEnd: (distance: number | null, velocity = 0) => {
        if (distance !== null) {
          const width = element.current?.getBoundingClientRect().width || fallbackWidth?.()
            || window.visualViewport?.width || window.innerWidth;
          if (distance >= width / 3 || (distance >= SWIPE_FLICK_MIN_PX && velocity >= SWIPE_FLICK_SPEED)) onClose();
        }
        cancel();
      },
    },
  };
}
