import { useRef, type MouseEvent, type PointerEvent, type RefObject } from 'react';

/**
 * A native modal's backdrop click closes it. A press that starts inside (selecting the
 * box's words, a drag) and ends on the backdrop fires its click on the dialog too: that
 * one never closes it, or the words typed there go with it.
 */
export function useBackdropClose(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const pressedInside = useRef(false);
  return {
    onPointerDown: (event: PointerEvent) => {
      pressedInside.current = event.target !== ref.current;
    },
    onClick: (event: MouseEvent) => {
      const inside = pressedInside.current;
      pressedInside.current = false;
      if (event.target === ref.current && !inside) onClose();
    },
  };
}
