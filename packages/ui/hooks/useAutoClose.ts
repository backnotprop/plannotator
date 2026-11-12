import { useState, useEffect, useCallback } from 'react';
import { getAutoCloseDelay, setAutoCloseDelay } from '../utils/storage';

type AutoClosePhase =
  | { phase: 'idle' }
  | { phase: 'counting'; remaining: number }
  | { phase: 'prompt' }
  | { phase: 'closed' }
  | { phase: 'closeFailed' };

interface UseAutoCloseReturn {
  state: AutoClosePhase;
  enableAndStart: () => void;
}

type GlimpseWindow = Window & {
  glimpse?: {
    close?: () => void;
  };
};

function requestGlimpseClose(): boolean {
  const glimpseClose = (window as GlimpseWindow).glimpse?.close;
  if (typeof glimpseClose === 'function') {
    glimpseClose();
    return true;
  }

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ __plannotator_glimpse_close: true }, '*');
    return true;
  }

  return false;
}

function tryClose(onFail: () => void): void {
  const requestedNativeClose = requestGlimpseClose();
  if (requestedNativeClose) {
    return;
  }

  window.close();
  setTimeout(() => {
    if (!window.closed) onFail();
  }, 300);
}

export function useAutoClose(active: boolean): UseAutoCloseReturn {
  const [state, setState] = useState<AutoClosePhase>({ phase: 'idle' });

  useEffect(() => {
    if (!active) return;

    const delay = getAutoCloseDelay();
    if (delay === '0') {
      tryClose(() => setState({ phase: 'closeFailed' }));
      setState({ phase: 'closed' });
    } else if (delay !== 'off') {
      setState({ phase: 'counting', remaining: Number(delay) });
    } else {
      setState({ phase: 'prompt' });
    }
  }, [active]);

  useEffect(() => {
    if (state.phase !== 'counting') return;
    if (state.remaining <= 0) {
      tryClose(() => setState({ phase: 'closeFailed' }));
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
