import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CodeNavHoverResponse,
  CodeNavRequest,
} from '@plannotator/shared/code-nav';
import { DEFAULT_TOKEN_HOVER_DELAY_MS } from '@plannotator/shared/token-hover';

export type { CodeNavHoverResponse };

/** Grace on leave, so the card's own links are reachable. */
const LEAVE_GRACE_MS = 250;
const MAX_CACHE_ENTRIES = 30;

/**
 * How this hook opens cards.
 *
 * `off` never reaches here: the App withholds the handler props entirely, so
 * the diff views wire no listeners at all. What is left is the shipped hover
 * behavior and the Alt-held gate.
 */
export type TokenHoverMode = 'hover' | 'modifier';

export interface UseTokenHoverOptions {
  /** Default `hover`, which is byte-for-byte the shipped behavior. */
  mode?: TokenHoverMode;
  /** Dwell before any request exists. Sweeping a diff costs zero rg processes. */
  delayMs?: number;
}

/**
 * Marks the card's own subtree. The card carries this attribute and the scroll
 * cancel reads it, so the two stay in step through one name.
 */
export const TOKEN_HOVER_CARD_SELECTOR = '[data-token-hover-card]';

export interface TokenHoverState {
  request: CodeNavRequest;
  data: CodeNavHoverResponse;
  /** Anchor geometry captured when the card opened. */
  rect: DOMRect;
}

export interface UseTokenHoverResult {
  hover: TokenHoverState | null;
  /** Wire to the diff views' `onTokenHoverEnter`. */
  onTokenHoverEnter: (request: CodeNavRequest, tokenElement: HTMLElement) => void;
  /** Wire to the diff views' `onTokenHoverLeave`. */
  onTokenHoverLeave: () => void;
  /** Pointer entered the card: cancel the pending close. */
  onCardEnter: () => void;
  /** Pointer left the card: restart the close timer. */
  onCardLeave: () => void;
  /** Close now and abandon anything pending (gate flips, submission, unmount). */
  close: () => void;
}

/**
 * Alt is a text-editing chord on macOS (Alt+Backspace, Alt+arrow for word
 * moves), so arming on it while the reviewer is writing a comment would pop
 * cards over the diff mid-sentence whenever the pointer happens to be parked
 * there. Typing owns the key; only the pointer's own gesture arms.
 */
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

/**
 * A response is worth a card only when it says something. One stray reference
 * is noise, and an empty card flashing on every hover is worse than no card.
 */
function meetsRenderThreshold(data: CodeNavHoverResponse): boolean {
  if (data.backend !== 'search') return false;
  return data.definition != null || data.references.length >= 2;
}

/**
 * Token hover cards over POST /api/code-nav/hover.
 *
 * Every failure mode resolves to "no card": an unavailable backend, a non-OK
 * response, a timeout, an abort, and a below-threshold answer all render
 * nothing, silently. A hover is an idle gesture and must never nag — the toast
 * belongs to Cmd+click, which is a deliberate action.
 *
 * @param snapshotId the active diff snapshot; a change flushes the cache so a
 *   refreshed diff can never serve positions from the diff before it.
 * @param options the user's trigger mode and dwell. Omitted means the shipped
 *   hover-at-350ms behavior.
 */
export function useTokenHover(
  snapshotId?: string,
  options: UseTokenHoverOptions = {},
): UseTokenHoverResult {
  const { mode = 'hover', delayMs = DEFAULT_TOKEN_HOVER_DELAY_MS } = options;
  const [hover, setHover] = useState<TokenHoverState | null>(null);
  // Drives the scroll listener: a document-level listener exists only while
  // something is actually pending or open.
  const [engaged, setEngaged] = useState(false);

  /** Alt held right now. Only tracked while the mode actually needs it. */
  const modifierHeldRef = useRef(false);
  /**
   * The last token the pointer entered, kept even when the gate rejected it.
   * A key going down fires no pointer event, so without this the commonest
   * gesture in modifier mode — park on a symbol, THEN hold Alt — would do
   * nothing at all.
   */
  const lastEnterRef = useRef<{ request: CodeNavRequest; element: HTMLElement } | null>(null);
  /** Pointer is inside the card, so a key release must not close it. */
  const pointerInCardRef = useRef(false);

  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Which key the in-flight request belongs to, so a re-entry can join it. */
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
    // The card is gone, so the pointer is not in it any more — and no pointer
    // event will say so, because the card unmounted underneath the pointer
    // rather than being left. Without this reset the flag stays true for the
    // rest of the session and every later Alt release is ignored as "they are
    // reading the card".
    pointerInCardRef.current = false;
    setHover(null);
    setEngaged(false);
  }, [abortInFlight, clearDwell, clearGrace]);

  const readCache = useCallback((key: string): CodeNavHoverResponse | undefined => {
    const cache = cacheRef.current;
    const cached = cache.get(key);
    if (cached) {
      // Refresh recency.
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
        // The answer for the token the pointer is on NOW says nothing. A card
        // still standing for an earlier token is stale the moment that is
        // true, so it goes with it rather than lingering over a symbol the
        // reviewer has already left.
        if (openKeyRef.current != null && openKeyRef.current !== key) {
          openKeyRef.current = null;
          setHover(null);
        }
        setEngaged(false);
        return;
      }
      // The anchor was measured against an element that has since been
      // recycled out of the diff (virtualized scroll, a diff swap). Its rect
      // is 0,0 and would pin the card to the corner of the screen.
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

      // Crossing between fragments of the same identifier fires leave+enter.
      // Keep the open card and its anchor exactly where they are — but this is
      // also where the pointer lands after a brief drift onto a NEIGHBOUR, so
      // the pending work for that neighbour has to die here. Without the three
      // lines below, its answer arrives later, still passes the landing check,
      // and replaces the open card's contents with another token's symbol.
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

        // Leaving and coming back inside the grace window re-arms the dwell
        // while this key's own request is still in flight. Joining it is the
        // single-in-flight contract; launching a second is one more ripgrep
        // process for an answer already on its way.
        if (inFlightKeyRef.current === key) return;

        const controller = new AbortController();
        abortRef.current = controller;
        inFlightKeyRef.current = key;
        void (async () => {
          try {
            const res = await fetch('/api/code-nav/hover', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(request),
              signal: controller.signal,
            });
            if (!res.ok) return;
            const data = (await res.json()) as CodeNavHoverResponse;
            if (controller.signal.aborted || activeKeyRef.current !== key) return;
            writeCache(key, data);
            open(key, request, data, activeElementRef.current ?? tokenElement);
          } catch {
            // Aborts, network failures and malformed answers are all "no card".
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
      // Recorded before the gate, so a later key press has a token to act on.
      lastEnterRef.current = { request, element: tokenElement };
      // The gate sits HERE, ahead of the dwell timer, the cache read and every
      // piece of state: in modifier mode with the key up, a hover costs one
      // boolean read and nothing else.
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
    // The dwell dies with the pointer; the in-flight fetch does not, so a
    // re-entry inside the grace window still lands its own answer.
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

  // Modifier mode only. Three listeners, and only while the mode needs them:
  // in hover mode this effect never runs, so the pipeline is exactly what
  // #1461 shipped.
  useEffect(() => {
    if (mode !== 'modifier') {
      modifierHeldRef.current = false;
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || modifierHeldRef.current) return;
      if (isTypingTarget(event.target)) return;
      modifierHeldRef.current = true;
      // Pressing the key does not re-enter the token under the pointer, so
      // this is what makes "park on a symbol, then hold Alt" work.
      const pending = lastEnterRef.current;
      if (pending) beginHover(pending.request, pending.element);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.altKey || !modifierHeldRef.current) return;
      modifierHeldRef.current = false;
      // Releasing behaves like leaving: the same grace, so the card's own
      // reference links stay reachable. Unless the pointer is already inside
      // the card, in which case a release would yank it out from under
      // someone reading it.
      if (pointerInCardRef.current) return;
      clearDwell();
      startGrace();
    };
    // Alt+Tab leaves the key state stale-held forever otherwise.
    const onBlur = () => {
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
      modifierHeldRef.current = false;
    };
  }, [beginHover, clearDwell, close, mode, startGrace]);

  // The anchor rect is stale the moment the PANE moves, so scrolling closes the
  // card and abandons the pending fetch. Capture phase, because the scroll
  // happens inside the diff pane, not on the document.
  //
  // Scrolling INSIDE the card moves nothing the anchor depends on, and the
  // signature block is a horizontal scroller: closing the card the moment the
  // reviewer scrolls it to read the end of a long signature would make it
  // unreadable by exactly the gesture meant to read it.
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

  // A new diff snapshot invalidates every cached position.
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
