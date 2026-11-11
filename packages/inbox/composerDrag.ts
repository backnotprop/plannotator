import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

export const DRAG_SLOP = 4;
export const DRAG_MARGIN = 8;
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

export function clampOffset(want: Offset, home: Box, view: { width: number; height: number }, margin = DRAG_MARGIN): Offset {
  const axis = (value: number, start: number, size: number, room: number) => {
    const min = margin - start;
    const max = room - margin - (start + size);
    if (min > max) return 0;
    return Math.min(max, Math.max(min, value));
  };
  return { x: Math.round(axis(want.x, home.left, home.width, view.width)), y: Math.round(axis(want.y, home.top, home.height, view.height)) };
}

function measure(card: HTMLElement): { home: Box; view: { width: number; height: number } } | null {
  const parent = card.offsetParent as HTMLElement | null;
  if (!parent || !card.offsetWidth || !card.offsetHeight) return null;
  return {
    home: { left: card.offsetLeft - card.offsetWidth / 2, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight },
    view: { width: parent.clientWidth, height: parent.clientHeight },
  };
}

const CONTROLS = 'button, a, input, textarea, select, label, [role="radio"], [contenteditable="true"]';
const onControl = (target: EventTarget | null) => target instanceof Element && target.closest(CONTROLS) !== null;

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

export const MIN_WIDTH = 320;
export const NARROW_WIDTH = 480;

function leastSize(card: HTMLElement): Size {
  const had = { sized: card.hasAttribute('data-fcomp-sized'), narrow: card.hasAttribute('data-fcomp-narrow'), w: card.style.getPropertyValue('--ib-fcomp-rw'), h: card.style.getPropertyValue('--ib-fcomp-rh') };
  card.setAttribute('data-fcomp-sized', '');
  card.setAttribute('data-fcomp-narrow', '');
  card.style.setProperty('--ib-fcomp-rw', `${MIN_WIDTH}px`);
  card.style.removeProperty('--ib-fcomp-rh');
  let over = 0;
  for (const part of card.querySelectorAll<HTMLElement>(':scope > .ib-fcomp-top, :scope > [data-fcomp-body]')) over = Math.max(over, part.scrollWidth - part.clientWidth);
  const field = [...card.querySelectorAll<HTMLTextAreaElement>('[data-fcomp-body] textarea')].find((el) => el.offsetHeight > 0);
  const least = field ? parseFloat(getComputedStyle(field).minHeight) || 0 : 0;
  const h = field ? card.offsetHeight - field.offsetHeight + Math.min(field.offsetHeight, least) : card.offsetHeight;
  card.toggleAttribute('data-fcomp-sized', had.sized);
  card.toggleAttribute('data-fcomp-narrow', had.narrow);
  if (had.w) card.style.setProperty('--ib-fcomp-rw', had.w);
  else card.style.removeProperty('--ib-fcomp-rw');
  if (had.h) card.style.setProperty('--ib-fcomp-rh', had.h);
  return { w: Math.ceil((MIN_WIDTH + over) / 2) * 2, h: Math.ceil(h) };
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
  const want = useRef<Offset>({ x: 0, y: 0 });
  const shown = useRef<Offset>({ x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; from: Offset; moving: boolean } | null>(null);
  const size = useRef<Size | null>(null);
  const sizing = useRef<{ id: number; x: number; y: number; corner: Corner; from: Edges; min: Size; centre: number; foot: number; view: { width: number; height: number } } | null>(null);
  const [resizable, setResizable] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const homing = useRef<ReturnType<typeof setTimeout> | null>(null);

  const endHoming = useCallback(() => {
    if (homing.current) clearTimeout(homing.current);
    homing.current = null;
    cardRef.current?.removeAttribute('data-fcomp-homing');
  }, []);

  const draw = useCallback(
    (how: 'live' | 'ease' | 'instant') => {
      const card = cardRef.current;
      if (!card) return;
      const parent = card.offsetParent as HTMLElement | null;
      const wanted = enabled ? size.current : null;
      const sized = wanted && parent ? { w: Math.min(wanted.w, Math.max(0, parent.clientWidth - 2 * DRAG_MARGIN)), h: Math.min(wanted.h, Math.max(0, parent.clientHeight - 2 * DRAG_MARGIN)) } : wanted;
      writeSize(card, sized);
      const slim = sized !== null && sized.w < NARROW_WIDTH;
      card.toggleAttribute('data-fcomp-narrow', slim);
      setNarrow((had) => (had === slim ? had : slim));
      if (sized) {
        const body = card.querySelector<HTMLElement>(':scope > [data-fcomp-body]');
        const tray = card.querySelector<HTMLElement>(':scope > .ib-fcomp-top');
        const across = Math.max(body ? body.scrollWidth - body.clientWidth : 0, tray ? tray.scrollWidth - tray.clientWidth : 0);
        let fit = sized;
        if (across > 1) {
          fit = { w: fit.w + Math.ceil(across / 2) * 2, h: fit.h };
          writeSize(card, fit);
        }
        if (body && body.scrollHeight > body.clientHeight + 1) writeSize(card, { w: fit.w, h: fit.h + body.scrollHeight - body.clientHeight });
      }
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
    draw(drag.current?.moving || sizing.current ? 'live' : 'instant');
  });

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
    }
  }, []);

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

  return { attach, handle, resizable, narrow, corner };
}
