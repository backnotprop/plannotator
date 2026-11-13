import { useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export function useKeyboardFocus(enabled: boolean): [
  boolean,
  { onFocus: (e: FocusEvent<HTMLElement>) => void; onBlur: () => void; onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void },
] {
  const [on, setOn] = useState(false);
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
