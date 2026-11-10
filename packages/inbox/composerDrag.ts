/**
 * Moving full screen's composer card (FullScreenComposer.tsx) out of the way of what it covers.
 *
 * - The person drags the card by its tray (the strip the tabs sit in): its empty part, never a tab or the chevron.
 *   A press that moves less than `DRAG_SLOP` is no drag.
 * - Where it was put holds only while that file is open (`fileKey`): another file, or the same one closed and opened
 *   again, shows the card at its home (bottom centre). Kept in this component only: no cookie, no storage, no server.
 * - The whole card stays inside the view it floats over, `DRAG_MARGIN` in. What the person asked for is kept (`want`)
 *   and what is drawn is that, clamped: a card that grows as words are typed, or a window made smaller, pushes it back
 *   in, and it returns to where it was put when there is room again.
 * - A double click on the tray puts it back home, with a short ease (none under reduced motion: inbox.css).
 * - The move is a transform (`--ib-fcomp-dx`, `--ib-fcomp-dy`, read by inbox.css), written straight to the element:
 *   no render per pointer move, no layout change. Measured from layout boxes (`offsetLeft` …), which no transform
 *   changes, so a card in flight to the corner control measures the same as one at rest.
 * - A phone's card is docked across the width: no drag there (`enabled` false).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

/** How far a press must move before it is a drag (px). */
export const DRAG_SLOP = 4;
/** The room kept between the card and the edges of the view (px). */
export const DRAG_MARGIN = 8;
/** The longest the ease home can take (the transition's end clears it sooner). */
const HOMING_MS = 260;

export interface Offset {
  x: number;
  y: number;
}
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `want`, held so that a card at `home` (its box with no move) stays `margin` inside a view of `view`'s size. */
export function clampOffset(want: Offset, home: Box, view: { width: number; height: number }, margin = DRAG_MARGIN): Offset {
  const axis = (value: number, start: number, size: number, room: number) => {
    const min = margin - start;
    const max = room - margin - (start + size);
    // No room for the card and its margins: it stays home.
    if (min > max) return 0;
    return Math.min(max, Math.max(min, value));
  };
  return { x: Math.round(axis(want.x, home.left, home.width, view.width)), y: Math.round(axis(want.y, home.top, home.height, view.height)) };
}

/** The card's home box and its view's size, from layout (the card is centred on its `left` by translateX(-50%)). */
function measure(card: HTMLElement): { home: Box; view: { width: number; height: number } } | null {
  const parent = card.offsetParent as HTMLElement | null;
  if (!parent || !card.offsetWidth || !card.offsetHeight) return null;
  return {
    home: { left: card.offsetLeft - card.offsetWidth / 2, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight },
    view: { width: parent.clientWidth, height: parent.clientHeight },
  };
}

/** A press on one of these is theirs, never a drag. */
const CONTROLS = 'button, a, input, textarea, select, label, [role="radio"], [contenteditable="true"]';
const onControl = (target: EventTarget | null) => target instanceof Element && target.closest(CONTROLS) !== null;

function write(el: HTMLElement, at: Offset): void {
  if (at.x === 0 && at.y === 0) {
    el.style.removeProperty('--ib-fcomp-dx');
    el.style.removeProperty('--ib-fcomp-dy');
    return;
  }
  el.style.setProperty('--ib-fcomp-dx', `${at.x}px`);
  el.style.setProperty('--ib-fcomp-dy', `${at.y}px`);
}

export function useComposerDrag(enabled: boolean, fileKey: string | undefined) {
  const cardRef = useRef<HTMLElement | null>(null);
  /** Where the person put the card, and where it is drawn (that, clamped). */
  const want = useRef<Offset>({ x: 0, y: 0 });
  const shown = useRef<Offset>({ x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; from: Offset; moving: boolean } | null>(null);
  const homing = useRef<ReturnType<typeof setTimeout> | null>(null);

  const endHoming = useCallback(() => {
    if (homing.current) clearTimeout(homing.current);
    homing.current = null;
    cardRef.current?.removeAttribute('data-fcomp-homing');
  }, []);

  /**
   * Draws `want`, clamped. `live`: a drag, which has its own no-transition rule. `ease`: the way home.
   * `instant`: a clamp or a new file, which must not ride the card's own transform transition (the flight back
   * from the corner control).
   */
  const draw = useCallback(
    (how: 'live' | 'ease' | 'instant') => {
      const card = cardRef.current;
      if (!card) return;
      const measured = enabled ? measure(card) : null;
      const next = !enabled ? { x: 0, y: 0 } : measured ? clampOffset(want.current, measured.home, measured.view) : shown.current;
      const moved = next.x !== shown.current.x || next.y !== shown.current.y || (next.x !== 0 || next.y !== 0) !== card.hasAttribute('data-fcomp-moved');
      shown.current = next;
      if (moved) {
        if (how === 'ease') {
          card.setAttribute('data-fcomp-homing', '');
          if (homing.current) clearTimeout(homing.current);
          homing.current = setTimeout(endHoming, HOMING_MS);
        } else {
          endHoming();
          if (how === 'instant') card.style.setProperty('transition', 'none');
        }
        write(card, next);
        card.toggleAttribute('data-fcomp-moved', next.x !== 0 || next.y !== 0);
        if (how === 'instant') {
          void card.offsetWidth;
          card.style.removeProperty('transition');
        }
      }
      // The comments list opens just above the card (its sibling): it goes where the card is, kept under the view's top.
      const list = card.previousElementSibling;
      if (list instanceof HTMLElement && list.classList.contains('ib-anncard')) {
        write(list, { x: next.x, y: list.offsetHeight ? Math.max(next.y, Math.min(0, DRAG_MARGIN - list.offsetTop)) : next.y });
      }
    },
    [enabled, endHoming],
  );

  const attach = useCallback(
    (el: HTMLElement | null) => {
      cardRef.current = el;
      if (!el) return;
      // A card drawn again (unfolded from its pill) is put where it was.
      shown.current = { x: 0, y: 0 };
      draw('instant');
    },
    [draw],
  );

  // Another file: home again. In a layout effect, so the new file's card is never painted where the last one was.
  const lastKey = useRef(fileKey);
  useLayoutEffect(() => {
    if (lastKey.current !== fileKey) {
      lastKey.current = fileKey;
      want.current = { x: 0, y: 0 };
      drag.current = null;
      cardRef.current?.removeAttribute('data-fcomp-dragging');
    }
    // Every render: the card may have grown (words, a tab), and the comments list may have opened.
    draw(drag.current?.moving ? 'live' : 'instant');
  });

  // The view or the card changed size with no render (the window, a side panel, a field growing by itself).
  useEffect(() => {
    if (!enabled) return;
    const card = cardRef.current;
    const again = () => draw(drag.current?.moving ? 'live' : 'instant');
    window.addEventListener('resize', again);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(again);
    if (card) {
      observer?.observe(card);
      if (card.offsetParent) observer?.observe(card.offsetParent);
    }
    return () => {
      window.removeEventListener('resize', again);
      observer?.disconnect();
    };
  });

  useEffect(() => endHoming, [endHoming]);

  const end = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const now = drag.current;
    if (!now || now.id !== event.pointerId) return;
    drag.current = null;
    cardRef.current?.removeAttribute('data-fcomp-dragging');
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Already released (the pointer was cancelled).
    }
  }, []);

  /** The tray's handlers. Empty when the card does not move (a phone). */
  const handle = useMemo(() => {
    if (!enabled) return {};
    return {
      'data-fcomp-drag': '',
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (drag.current || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0) || onControl(event.target)) return;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, from: shown.current, moving: false };
        try {
          // The drag goes on over the page under the card (an HTML page is a frame, which would take the pointer).
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // No such pointer any more: the drag ends with the next up or cancel.
        }
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const now = drag.current;
        if (!now || now.id !== event.pointerId) return;
        const dx = event.clientX - now.x;
        const dy = event.clientY - now.y;
        if (!now.moving) {
          if (Math.hypot(dx, dy) < DRAG_SLOP) return;
          now.moving = true;
          endHoming();
          cardRef.current?.setAttribute('data-fcomp-dragging', '');
        }
        want.current = { x: now.from.x + dx, y: now.from.y + dy };
        draw('live');
        // Held at an edge, the card is put where it stopped, not where the pointer went.
        want.current = shown.current;
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      // A press on the tray keeps focus where it was (the field keeps its caret and its words) and selects no text.
      onMouseDown: (event: ReactMouseEvent<HTMLElement>) => {
        if (!onControl(event.target)) event.preventDefault();
      },
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        if (onControl(event.target)) return;
        want.current = { x: 0, y: 0 };
        draw('ease');
      },
    };
  }, [enabled, draw, end, endHoming]);

  return { attach, handle };
}
