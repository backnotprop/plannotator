/**
 * The Show me picture moves by its header, like the Ask window (owner's
 * request on #2600). It reuses the window's own pointer helpers
 * (`followPointer`, `startsGesture`, `isOnTitleRow` from ui's ChatFrame):
 * pointer events with capture, so a mouse, a pen and a finger all drag it; a
 * press on a header button is that button's, never a drag.
 *
 * - A drag starts only past `DRAG_THRESHOLD` px, so a click (and the first
 *   press of a double-click) never moves it.
 * - The picture stays inside the review pane (its offset parent), and is
 *   clamped again when the pane or the picture resizes.
 * - The offset is the host's (`offset` / `onOffset`), so it outlives the
 *   picture: kept while the review is open, through the corner card and
 *   back. A double-click on the header puts it back (offset 0, 0).
 * - It moves with the CSS `translate` property, never a transition: nothing
 *   animates during a drag, and the sheet's own entrance (`transform`, off
 *   under reduced motion) composes with it.
 *
 * No keys: the picture's place is not a keyboard matter, as the Ask window's.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { followPointer, isOnTitleRow, startsGesture } from '@plannotator/ui/components/chat';

export interface SheetOffset {
  x: number;
  y: number;
}

export const SHEET_HOME: SheetOffset = { x: 0, y: 0 };

/** How far a press moves before it is a drag, in CSS pixels. */
export const DRAG_THRESHOLD = 4;

/** The offset kept inside the element's offset parent (the review pane). */
export function clampSheetOffset(el: HTMLElement, offset: SheetOffset): SheetOffset {
  const pane = el.offsetParent as HTMLElement | null;
  if (!pane) return offset;
  const left = el.offsetLeft;
  const top = el.offsetTop;
  const minX = -left;
  const minY = -top;
  const maxX = Math.max(minX, pane.clientWidth - el.offsetWidth - left);
  const maxY = Math.max(minY, pane.clientHeight - el.offsetHeight - top);
  return { x: Math.round(Math.min(maxX, Math.max(minX, offset.x))), y: Math.round(Math.min(maxY, Math.max(minY, offset.y))) };
}

const same = (a: SheetOffset, b: SheetOffset) => a.x === b.x && a.y === b.y;

export function useSheetDrag({ offset, onOffset, enabled }: { offset: SheetOffset; onOffset: (offset: SheetOffset) => void; enabled: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const onOffsetRef = useRef(onOffset);
  onOffsetRef.current = onOffset;

  // Inside the pane on every open, and again whenever the pane or the picture changes size.
  const reclamp = useCallback(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const kept = clampSheetOffset(el, offsetRef.current);
    if (!same(kept, offsetRef.current)) onOffsetRef.current(kept);
  }, [enabled]);
  useLayoutEffect(() => {
    reclamp();
    const el = ref.current;
    if (!el || !enabled || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reclamp);
    observer.observe(el);
    if (el.offsetParent) observer.observe(el.offsetParent);
    return () => observer.disconnect();
  }, [reclamp, enabled]);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!enabled || !el || !startsGesture(event) || !isOnTitleRow(event)) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const from = offsetRef.current;
    let moving = false;
    const handle = event.currentTarget;
    const end = () => {
      handle.removeEventListener('lostpointercapture', end);
      setDragging(false);
    };
    handle.addEventListener('lostpointercapture', end);
    followPointer(
      handle,
      event.pointerId,
      (move) => {
        const dx = move.clientX - startX;
        const dy = move.clientY - startY;
        if (!moving && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!moving) {
          moving = true;
          setDragging(true);
        }
        onOffsetRef.current(clampSheetOffset(el, { x: from.x + dx, y: from.y + dy }));
      },
      () => onOffsetRef.current(from),
    );
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!enabled || !isOnTitleRow(event)) return;
    onOffsetRef.current(SHEET_HOME);
  };

  return {
    ref,
    dragging,
    style: enabled && (offset.x !== 0 || offset.y !== 0) ? ({ translate: `${offset.x}px ${offset.y}px` } as React.CSSProperties) : undefined,
    headerProps: enabled ? { onPointerDown, onDoubleClick, 'data-show-me-drag': dragging ? 'dragging' : '' } : {},
  };
}
