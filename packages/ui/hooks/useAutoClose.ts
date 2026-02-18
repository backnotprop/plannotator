import { useState, useEffect, useCallback } from 'react';
import { getAutoCloseDelay, setAutoCloseDelay } from '../utils/storage';

/**
 * Phases of the auto-close lifecycle after a form submission.
 *
 * - idle:       nothing submitted yet
 * - counting:   countdown is ticking (seconds remaining in `remaining`)
 * - prompt:     auto-close is disabled; offer the user a checkbox to opt in
 * - closed:     window.close() was called (terminal state)
 */
type AutoClosePhase =
  | { phase: 'idle' }
  | { phase: 'counting'; remaining: number }
  | { phase: 'prompt' }
  | { phase: 'closed' };

interface UseAutoCloseReturn {
  state: AutoClosePhase;
  /** User opted in via the checkbox — persist "3s" and start countdown. */
  enableAndStart: () => void;
}

/**
 * Manages the auto-close countdown that runs after a submission overlay appears.
 *
 * @param active - pass `true` once the overlay should appear (i.e. form was submitted)
 */
export function useAutoClose(active: boolean): UseAutoCloseReturn {
  const [state, setState] = useState<AutoClosePhase>({ phase: 'idle' });

  // On activation, read persisted delay and transition to the right phase.
  useEffect(() => {
    if (!active) return;

    const delay = getAutoCloseDelay();
    if (delay === '0') {
      window.close();
      setState({ phase: 'closed' });
    } else if (delay !== 'off') {
      setState({ phase: 'counting', remaining: Number(delay) });
    } else {
      setState({ phase: 'prompt' });
    }
  }, [active]);

  // Tick the countdown once per second.
  useEffect(() => {
    if (state.phase !== 'counting') return;
    if (state.remaining <= 0) {
      window.close();
      setState({ phase: 'closed' });
      return;
    }
    const timer = setTimeout(
      () => setState((prev) => (prev.phase === 'counting' ? { phase: 'counting', remaining: prev.remaining - 1 } : prev)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [state]);

  const enableAndStart = useCallback(() => {
    setAutoCloseDelay('3');
    setState({ phase: 'counting', remaining: 3 });
  }, []);

  return { state, enableAndStart };
}
