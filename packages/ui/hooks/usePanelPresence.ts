import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

// Keep in step with the panel transitions in theme.css.
export const PANEL_TRANSITION_MS = 180;

/** Retain an inert panel while it slides out; reopening cancels its removal. */
export function usePanelPresence(open: boolean, animated = true) {
  const reduced = usePrefersReducedMotion();
  const [retained, setRetained] = useState(open);

  useEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    if (!animated || reduced) {
      setRetained(false);
      return;
    }
    if (!retained) return;
    const timer = setTimeout(() => setRetained(false), PANEL_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [open, animated, reduced, retained]);

  return {
    present: open || (animated && !reduced && retained),
    closing: !open && animated && !reduced && retained,
  };
}
