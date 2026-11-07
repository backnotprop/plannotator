import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

type DragFrame = { distance: number; closing: boolean };

function paint(panel: HTMLElement, frame: DragFrame | null) {
  if (frame) {
    panel.setAttribute('data-pn-panel-drag', frame.closing ? 'closing' : 'opening');
    panel.style.setProperty('--pn-panel-drag-distance', `${frame.distance}px`);
  } else {
    panel.removeAttribute('data-pn-panel-drag');
    panel.style.removeProperty('--pn-panel-drag-distance');
  }
}

interface PanelDragOptions {
  selector: string;
  onOpen: () => void;
  onClose: () => void;
  onPreview?: () => void;
  fallbackWidth?: () => number;
}

/** Mount a preview on the first move, then paint the transform without rerendering. */
export function usePanelDrag({ selector, onOpen, onClose, onPreview, fallbackWidth }: PanelDragOptions) {
  const reduced = usePrefersReducedMotion();
  const frame = useRef<DragFrame | null>(null);
  const element = useRef<HTMLElement | null>(null);
  const [phase, setPhase] = useState({ active: false });

  // Paint after mounting and after committing the end state. A fresh phase
  // object also handles a complete gesture batched into a single render.
  useLayoutEffect(() => {
    element.current = document.querySelector<HTMLElement>(selector);
    if (element.current) paint(element.current, frame.current);
  }, [phase, selector]);

  const cancel = useCallback(() => {
    if (!frame.current) return;
    frame.current = null;
    setPhase({ active: false });
  }, []);

  return {
    active: phase.active,
    cancel,
    gesture: reduced ? undefined : {
      onMove: (distance: number, closing: boolean) => {
        const first = !frame.current;
        frame.current = { distance, closing };
        if (!element.current?.isConnected) element.current = document.querySelector<HTMLElement>(selector);
        if (element.current) paint(element.current, frame.current);
        if (first) {
          onPreview?.();
          setPhase({ active: true });
        }
      },
      onEnd: (distance: number | null, closing: boolean) => {
        if (distance !== null) {
          const width = element.current?.getBoundingClientRect().width || fallbackWidth?.()
            || window.visualViewport?.width || window.innerWidth;
          if (distance >= width / 3) (closing ? onClose : onOpen)();
        }
        cancel();
      },
    },
  };
}
