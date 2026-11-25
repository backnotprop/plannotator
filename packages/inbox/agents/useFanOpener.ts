import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { FAN_DWELL_MS, FAN_PRESS_MS, type FanOpenedBy } from './FaceFan';

/**
 * How a mark opens and closes its picker (FaceFan.tsx): a click or a tap, the pointer resting on it for FAN_DWELL_MS,
 * Enter or Space, or a long press on a touch screen; a second click closes the one a click opened. An agent's mark
 * (AgentMark.tsx) and a project's (components/ProjectRow.tsx) behave the same. `paused`: a dialog of the mark is open,
 * so a rest of the pointer opens nothing. `onOpen`: runs each time it opens.
 */
export function useFanOpener({ paused, onOpen }: { paused: boolean; onOpen?: () => void }) {
  const [fan, setFan] = useState<{ open: boolean; by: FanOpenedBy } | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  // Just closed: the pointer resting where it was (the fan's plate gone from under it) opens nothing until it moves.
  const quiet = useRef(false);
  // Closed by a click on the mark: nothing opens again until the pointer leaves it.
  const held = useRef(false);
  // The fan was opened, or kept, by a click: the next click on the mark closes it. One opened by a rest of the pointer
  // is kept by a click (the click that the rest beat), not closed.
  const sticky = useRef(false);
  // The kind of pointer of the last press: a tap opens the finger's fan.
  const pointer = useRef<string>('mouse');
  useEffect(
    () => () => {
      clearTimeout(dwell.current);
      if (press.current) clearTimeout(press.current.timer);
    },
    [],
  );
  const openFan = (by: FanOpenedBy, byClick = false) => {
    clearTimeout(dwell.current);
    sticky.current = byClick;
    setFan({ open: true, by });
    onOpen?.();
  };
  const closeFan = (hold = false) => {
    quiet.current = true;
    sticky.current = false;
    if (hold) held.current = true;
    clearTimeout(dwell.current);
    setFan((was) => (was ? { ...was, open: false } : was));
  };
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  // A click on the mark (or on the fan's plate over it, FaceFan.tsx) opens the picker, or closes the one it opened.
  const toggle = (by: FanOpenedBy) => {
    clearTimeout(dwell.current);
    if (!fan?.open) return openFan(by, true);
    if (sticky.current) return closeFan(true);
    sticky.current = true;
  };
  const rest = () => {
    clearTimeout(dwell.current);
    dwell.current = setTimeout(() => openFan('hover'), FAN_DWELL_MS);
  };
  const handlers = {
    onClick: (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // A long press opened the picker: its lift is not a click.
      if (pressed.current) {
        pressed.current = false;
        return;
      }
      toggle(event.detail === 0 ? 'keyboard' : pointer.current === 'touch' ? 'touch' : 'hover');
    },
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType === 'touch' || fan?.open || paused || quiet.current) return;
      rest();
    },
    onPointerLeave: () => {
      quiet.current = false;
      held.current = false;
      clearTimeout(dwell.current);
    },
    onPointerDown: (event: PointerEvent) => {
      clearTimeout(dwell.current);
      pressed.current = false;
      pointer.current = event.pointerType;
      if (event.pointerType !== 'touch') return;
      endPress();
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          press.current = null;
          pressed.current = true;
          openFan('touch');
        }, FAN_PRESS_MS),
      };
    },
    onPointerMove: (event: PointerEvent) => {
      if (quiet.current && !held.current && event.pointerType !== 'touch' && !fan?.open && !paused) {
        quiet.current = false;
        rest();
      }
      if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) endPress();
    },
    onPointerUp: endPress,
    onPointerCancel: endPress,
    onContextMenu: (event: MouseEvent) => {
      if (pressed.current || press.current) event.preventDefault();
    },
    // A long press here opens the picker, never the row's menu (its ContextMenu hears touches on the row).
    onTouchStart: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    // Enter or Space opens the picker, focus in it (its own keys move in it).
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) openFan('keyboard');
    },
    onKeyUp: (event: KeyboardEvent) => {
      if (event.key === ' ') event.preventDefault();
    },
  };
  return {
    fan,
    closeFan,
    /** The plate's click over the mark: the mark's own click. */
    onMark: () => toggle(pointer.current === 'touch' ? 'touch' : 'hover'),
    /** A dialog of the mark closed: the pointer resting on the mark opens nothing until it moves. */
    quietNow: () => {
      quiet.current = true;
    },
    handlers,
  };
}
