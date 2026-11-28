import { useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

type FocusHandlers = { onFocus?: (e: FocusEvent<HTMLElement>) => void; onBlur?: () => void; onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void };

/**
 * Not `enabled` and not on: the three handlers would do nothing (focus sets nothing, Escape and blur find it off), so
 * none are made. A list mounts every row of its open groups (about 2,200 on a large Inbox) and only a Stopped or
 * Holding row is enabled: three closures per row for nothing.
 */
const NONE: FocusHandlers = {};

export function useKeyboardFocus(enabled: boolean): [boolean, FocusHandlers] {
  const [on, setOn] = useState(false);
  if (!enabled && !on) return [on, NONE];
  return [
    on,
    {
      onKeyDown: (e) => {
        if (!on || e.key !== 'Escape' || e.target !== e.currentTarget || e.defaultPrevented) return;
        e.preventDefault();
        setOn(false);
      },
      onFocus: (e) => {
        if (!enabled || e.target !== e.currentTarget) return;
        let visible = false;
        try {
          visible = e.currentTarget.matches(':focus-visible');
        } catch {
          visible = false;
        }
        setOn(visible);
      },
      onBlur: () => setOn(false),
    },
  ];
}
