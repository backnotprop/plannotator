import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CodeNavHoverResponse,
  CodeNavRequest,
} from '@plannotator/shared/code-nav';
import { DEFAULT_TOKEN_HOVER_DELAY_MS } from '@plannotator/shared/token-hover';
import { isModKeyHeld, modEventKey } from '@plannotator/ui/utils/platform';

export type { CodeNavHoverResponse };

const LEAVE_GRACE_MS = 250;
const MAX_CACHE_ENTRIES = 30;

export type TokenHoverMode = 'hover' | 'modifier';

export type TokenHoverResolver = (
  request: CodeNavRequest,
  signal: AbortSignal,
) => Promise<CodeNavHoverResponse | null>;

const fetchResolver: TokenHoverResolver = async (request, signal) => {
  const res = await fetch('/api/code-nav/hover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) return null;
  return (await res.json()) as CodeNavHoverResponse;
};

export interface UseTokenHoverOptions {
  mode?: TokenHoverMode;
  delayMs?: number;
  resolve?: TokenHoverResolver;
  onModifierGate?: (armed: boolean, tokenElement: HTMLElement | null) => void;
}

export const TOKEN_HOVER_CARD_SELECTOR = '[data-token-hover-card]';

export interface TokenHoverState {
  request: CodeNavRequest;
  data: CodeNavHoverResponse;
  rect: DOMRect;
}

export interface UseTokenHoverResult {
  hover: TokenHoverState | null;
  onTokenHoverEnter: (request: CodeNavRequest, tokenElement: HTMLElement) => void;
  onTokenHoverLeave: () => void;
  onCardEnter: () => void;
  onCardLeave: () => void;
  close: () => void;
}

/**
 * Where a key event actually came from. composedPath()[0] pierces shadow DOM: window-level e.target
 * retargets to the shadow HOST (e.g.
 */
function eventOrigin(event: KeyboardEvent): EventTarget | null {
  return event.composedPath?.()[0] ?? event.target;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

function cacheKey(request: CodeNavRequest): string {
  return `${request.symbol}|${request.filePath}|${request.side}`;
}

function meetsRenderThreshold(data: CodeNavHoverResponse): boolean {
  if (data.backend !== 'search') return false;
  return data.definition != null || data.references.length >= 2;
}

export function useTokenHover(
  snapshotId?: string,
  options: UseTokenHoverOptions = {},
): UseTokenHoverResult {
  const {
    mode = 'hover',
    delayMs = DEFAULT_TOKEN_HOVER_DELAY_MS,
    resolve = fetchResolver,
    onModifierGate,
  } = options;
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const modifierGateRef = useRef(onModifierGate);
  modifierGateRef.current = onModifierGate;
  const [hover, setHover] = useState<TokenHoverState | null>(null);
  const [engaged, setEngaged] = useState(false);

  const modifierHeldRef = useRef(false);
  const lastEnterRef = useRef<{ request: CodeNavRequest; element: HTMLElement } | null>(null);
  /** Pointer is inside the card, so a key release must not close it. */
  const pointerInCardRef = useRef(false);

  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const activeElementRef = useRef<HTMLElement | null>(null);
  const openKeyRef = useRef<string | null>(null);
  const cacheRef = useRef(new Map<string, CodeNavHoverResponse>());

  const clearDwell = useCallback(() => {
    if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
    dwellTimerRef.current = null;
  }, []);

  const clearGrace = useCallback(() => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    graceTimerRef.current = null;
  }, []);

  const abortInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightKeyRef.current = null;
  }, []);

  const close = useCallback(() => {
    clearDwell();
    clearGrace();
    abortInFlight();
    activeKeyRef.current = null;
    openKeyRef.current = null;
    lastEnterRef.current = null;
    // The card is gone, so the pointer is not in it any more — and no pointer event will say so,
    // because the card unmounted underneath the pointer rather than being left.
    pointerInCardRef.current = false;
    setHover(null);
    setEngaged(false);
  }, [abortInFlight, clearDwell, clearGrace]);

  const readCache = useCallback((key: string): CodeNavHoverResponse | undefined => {
    const cache = cacheRef.current;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
    }
    return cached;
  }, []);

  const writeCache = useCallback((key: string, data: CodeNavHoverResponse) => {
    const cache = cacheRef.current;
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, data);
  }, []);

  const open = useCallback(
    (key: string, request: CodeNavRequest, data: CodeNavHoverResponse, element: HTMLElement) => {
      if (!meetsRenderThreshold(data)) {
        if (openKeyRef.current != null && openKeyRef.current !== key) {
          openKeyRef.current = null;
          setHover(null);
        }
        setEngaged(false);
        return;
      }
      if (!element.isConnected) {
        close();
        return;
      }
      openKeyRef.current = key;
      setHover({ request, data, rect: element.getBoundingClientRect() });
    },
    [close],
  );

  const beginHover = useCallback(
    (request: CodeNavRequest, tokenElement: HTMLElement) => {
      clearGrace();
      const key = cacheKey(request);

      if (openKeyRef.current === key) {
        clearDwell();
        activeKeyRef.current = key;
        if (inFlightKeyRef.current !== null && inFlightKeyRef.current !== key) {
          abortInFlight();
        }
        return;
      }

      clearDwell();
      if (activeKeyRef.current !== key) {
        if (inFlightKeyRef.current !== null && inFlightKeyRef.current !== key) {
          abortInFlight();
        }
      }
      activeKeyRef.current = key;
      // A joined in-flight request must anchor to the span the pointer is on
      // now, not the one it was on when the request launched.
      activeElementRef.current = tokenElement;
      setEngaged(true);

      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null;
        if (activeKeyRef.current !== key) return;

        const cached = readCache(key);
        if (cached) {
          open(key, request, cached, tokenElement);
          return;
        }

        if (inFlightKeyRef.current === key) return;

        const controller = new AbortController();
        abortRef.current = controller;
        inFlightKeyRef.current = key;
        void (async () => {
          try {
            const data = await resolveRef.current(request, controller.signal);
            if (data == null) return;
            if (controller.signal.aborted || activeKeyRef.current !== key) return;
            writeCache(key, data);
            open(key, request, data, activeElementRef.current ?? tokenElement);
          } catch {
          } finally {
            if (abortRef.current === controller) {
              abortRef.current = null;
              inFlightKeyRef.current = null;
            }
          }
        })();
      }, delayMs);
    },
    [abortInFlight, clearDwell, clearGrace, delayMs, open, readCache, writeCache],
  );

  const onTokenHoverEnter = useCallback(
    (request: CodeNavRequest, tokenElement: HTMLElement) => {
      lastEnterRef.current = { request, element: tokenElement };
      if (mode === 'modifier' && !modifierHeldRef.current) return;
      beginHover(request, tokenElement);
    },
    [beginHover, mode],
  );

  const startGrace = useCallback(() => {
    clearGrace();
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      close();
    }, LEAVE_GRACE_MS);
  }, [clearGrace, close]);

  const onTokenHoverLeave = useCallback(() => {
    lastEnterRef.current = null;
    clearDwell();
    startGrace();
  }, [clearDwell, startGrace]);

  const onCardEnter = useCallback(() => {
    pointerInCardRef.current = true;
    clearGrace();
  }, [clearGrace]);
  const onCardLeave = useCallback(() => {
    pointerInCardRef.current = false;
    startGrace();
  }, [startGrace]);

  useEffect(() => {
    if (mode !== 'modifier') {
      modifierHeldRef.current = false;
      return;
    }
    const notifyGate = (armed: boolean) => {
      modifierGateRef.current?.(armed, lastEnterRef.current?.element ?? null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isModKeyHeld(event)) return;
      if (event.key !== modEventKey) {
        if (!modifierHeldRef.current) return;
        modifierHeldRef.current = false;
        clearDwell();
        notifyGate(false);
        if (!pointerInCardRef.current) startGrace();
        return;
      }
      if (isTypingTarget(eventOrigin(event))) return;
      if (modifierHeldRef.current) return;
      modifierHeldRef.current = true;
      const pending = lastEnterRef.current;
      notifyGate(true);
      if (pending) beginHover(pending.request, pending.element);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isModKeyHeld(event) || !modifierHeldRef.current) return;
      modifierHeldRef.current = false;
      notifyGate(false);
      if (pointerInCardRef.current) return;
      clearDwell();
      startGrace();
    };
    const onBlur = () => {
      if (modifierHeldRef.current) notifyGate(false);
      modifierHeldRef.current = false;
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (modifierHeldRef.current) notifyGate(false);
      modifierHeldRef.current = false;
    };
  }, [beginHover, clearDwell, close, mode, startGrace]);

  // Capture phase, because the scroll happens inside the diff pane, not on the document.
  useEffect(() => {
    if (!engaged) return;
    const cancel = (event: Event) => {
      const node = event.target;
      const element =
        node instanceof Element
          ? node
          : node instanceof Node
            ? node.parentElement
            : null;
      if (element?.closest(TOKEN_HOVER_CARD_SELECTOR)) return;
      close();
    };
    document.addEventListener('scroll', cancel, true);
    document.addEventListener('wheel', cancel, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', cancel, true);
      document.removeEventListener('wheel', cancel, true);
    };
  }, [engaged, close]);

  useEffect(() => {
    cacheRef.current.clear();
    close();
  }, [snapshotId, close]);

  useEffect(() => close, [close]);

  return {
    hover,
    onTokenHoverEnter,
    onTokenHoverLeave,
    onCardEnter,
    onCardLeave,
    close,
  };
}
