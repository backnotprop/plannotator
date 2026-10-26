import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';

/**
 * A button whose action runs once at a time: a second press while the first
 * is on its way does nothing (Restore twice would move a card twice). It
 * stays focusable while busy (`aria-disabled`, never `disabled`), so the
 * keyboard does not lose its place.
 */
export function OnceButton({ onClick, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { onClick: () => unknown }) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return (
    <button
      {...rest}
      type="button"
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={async () => {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        try {
          await onClick();
        } finally {
          running.current = false;
          if (mounted.current) setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}
