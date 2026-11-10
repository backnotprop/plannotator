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
 *
 * Resizing (the owner, 2026-11-09: "after I move it, if some like resized corner panels show up"). Once the card is
 * off its home, its four corners resize it (`resizable`, `corner()`): the corner under the pointer moves and the
 * opposite one stays. Never smaller than the card is by itself (its own width; its height with the field at its
 * least), never past the view's margin. The size is two more variables (`--ib-fcomp-rw`, `--ib-fcomp-rh`, with
 * `data-fcomp-sized`), kept and dropped with the place: another file or the double click gives the card's own size
 * back. A card at home has no corners. Pointer only: the app's resize handles (ResizeHandle) take no keys either.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

/** How far a press must move before it is a drag (px). */
export const DRAG_SLOP = 4;
/** The room kept between the card and the edges of the view (px). */
export const DRAG_MARGIN = 8;
/** The longest the ease home can take (the transition's end clears it sooner). */
const HOMING_MS = 260;

export type Corner = 'nw' | 'ne' | 'sw' | 'se';
export const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];
export interface Size {
  w: number;
  h: number;
}
interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The card's box after `corner` is dragged by (dx, dy) from `from`: that corner moves, the opposite one stays. Never
 * under `min`, never past `margin` inside the view. The width stays even, so the card's centre (what its transform
 * moves) lands on a whole pixel and the fixed edge does not shimmer.
 */
export function resizeBox(from: Edges, corner: Corner, dx: number, dy: number, min: Size, view: { width: number; height: number }, margin = DRAG_MARGIN): Edges {
  const next = { ...from };
  const hold = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  if (corner.endsWith('e')) next.right = hold(Math.round(from.right + dx), from.left + min.w, Math.max(from.left + min.w, view.width - margin));
  else next.left = hold(Math.round(from.left + dx), Math.min(margin, from.right - min.w), from.right - min.w);
  if (corner.startsWith('s')) next.bottom = hold(Math.round(from.bottom + dy), from.top + min.h, Math.max(from.top + min.h, view.height - margin));
  else next.top = hold(Math.round(from.top + dy), Math.min(margin, from.bottom - min.h), from.bottom - min.h);
  if ((next.right - next.left) % 2 !== 0) {
    if (corner.endsWith('e')) next.right += next.right - next.left > min.w ? -1 : 1;
    else next.left += next.right - next.left > min.w ? 1 : -1;
  }
  return next;
}

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

/** The size the person gave the card, or its own (`null`). */
function writeSize(el: HTMLElement, size: Size | null): void {
  if (!size) {
    el.removeAttribute('data-fcomp-sized');
    el.style.removeProperty('--ib-fcomp-rw');
    el.style.removeProperty('--ib-fcomp-rh');
    return;
  }
  el.style.setProperty('--ib-fcomp-rw', `${size.w}px`);
  el.style.setProperty('--ib-fcomp-rh', `${size.h}px`);
  el.setAttribute('data-fcomp-sized', '');
}

/** The least the card can be: its own width, and its height with the field on screen at its least. */
function leastSize(card: HTMLElement): Size {
  const sized = card.hasAttribute('data-fcomp-sized');
  // Its own width is read with the person's size off for the moment (nothing is painted in between).
  if (sized) card.removeAttribute('data-fcomp-sized');
  const w = card.offsetWidth;
  if (sized) card.setAttribute('data-fcomp-sized', '');
  const field = [...card.querySelectorAll<HTMLTextAreaElement>('[data-fcomp-body] textarea')].find((el) => el.offsetHeight > 0);
  const least = field ? parseFloat(getComputedStyle(field).minHeight) || 0 : 0;
  const h = field ? card.offsetHeight - field.offsetHeight + Math.min(field.offsetHeight, least) : card.offsetHeight;
  return { w: Math.ceil(w / 2) * 2, h: Math.ceil(h) };
}

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
  /** The size the person gave the card (null: its own), and the corner being dragged. */
  const size = useRef<Size | null>(null);
  const sizing = useRef<{ id: number; x: number; y: number; corner: Corner; from: Edges; min: Size; centre: number; foot: number; view: { width: number; height: number } } | null>(null);
  /** The card is off its home or has a size of its own: its corners resize it. */
  const [resizable, setResizable] = useState(false);
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
      // The size first: the card's home box is read with it on.
      const parent = card.offsetParent as HTMLElement | null;
      const wanted = enabled ? size.current : null;
      const sized = wanted && parent ? { w: Math.min(wanted.w, Math.max(0, parent.clientWidth - 2 * DRAG_MARGIN)), h: Math.min(wanted.h, Math.max(0, parent.clientHeight - 2 * DRAG_MARGIN)) } : wanted;
      writeSize(card, sized);
      // More in the card than the height holds (files on the reply, an error line): it grows to hold it.
      // Read on the body, which takes what the height leaves: the corners hang past the card's own edge.
      const body = sized ? card.querySelector<HTMLElement>('[data-fcomp-body]') : null;
      if (sized && body && body.scrollHeight > body.clientHeight + 1) writeSize(card, { w: sized.w, h: sized.h + body.scrollHeight - body.clientHeight });
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
      const can = enabled && (next.x !== 0 || next.y !== 0 || sized !== null);
      setResizable((had) => (had === can ? had : can));
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
      size.current = null;
      drag.current = null;
      sizing.current = null;
      cardRef.current?.removeAttribute('data-fcomp-dragging');
    }
    // Every render: the card may have grown (words, a tab), and the comments list may have opened.
    draw(drag.current?.moving || sizing.current ? 'live' : 'instant');
  });

  // The view or the card changed size with no render (the window, a side panel, a field growing by itself).
  useEffect(() => {
    if (!enabled) return;
    const card = cardRef.current;
    const again = () => draw(drag.current?.moving || sizing.current ? 'live' : 'instant');
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

  const endSizing = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const now = sizing.current;
    if (!now || now.id !== event.pointerId) return;
    sizing.current = null;
    cardRef.current?.removeAttribute('data-fcomp-dragging');
    cardRef.current?.removeAttribute('data-fcomp-resizing');
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Already released.
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
        size.current = null;
        draw('ease');
      },
    };
  }, [enabled, draw, end, endHoming]);

  /** One corner's handlers (FullScreenComposer draws the four while `resizable`). */
  const corner = useCallback(
    (which: Corner) => ({
      'data-fcomp-resize': which,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        const card = cardRef.current;
        const measured = card ? measure(card) : null;
        if (!card || !measured || sizing.current || drag.current || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.stopPropagation();
        const { home, view } = measured;
        const left = home.left + shown.current.x;
        const top = home.top + shown.current.y;
        sizing.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          corner: which,
          from: { left, top, right: left + home.width, bottom: top + home.height },
          min: leastSize(card),
          // What the card's transform is counted from: its centre across, its foot down. Neither moves as it resizes.
          centre: home.left + home.width / 2,
          foot: home.top + home.height,
          view,
        };
        endHoming();
        card.setAttribute('data-fcomp-dragging', '');
        card.setAttribute('data-fcomp-resizing', which);
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // No such pointer any more.
        }
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const now = sizing.current;
        if (!now || now.id !== event.pointerId) return;
        const box = resizeBox(now.from, now.corner, event.clientX - now.x, event.clientY - now.y, now.min, now.view);
        size.current = { w: box.right - box.left, h: box.bottom - box.top };
        want.current = { x: (box.left + box.right) / 2 - now.centre, y: box.bottom - now.foot };
        draw('live');
      },
      onPointerUp: endSizing,
      onPointerCancel: endSizing,
      onLostPointerCapture: endSizing,
      onMouseDown: (event: ReactMouseEvent<HTMLElement>) => event.preventDefault(),
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => event.stopPropagation(),
    }),
    [draw, endHoming, endSizing],
  );

  return { attach, handle, resizable, corner };
}
