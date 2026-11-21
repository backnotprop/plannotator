import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Point, Stroke } from './types';
import { renderStroke } from './utils';
import { clampViewport, panBy, zoomAt, type ZoomSize, type ZoomViewport } from '../imageZoom';
import {
  annotatorBase,
  annotatorCanvasRatio,
  annotatorInitialView,
  annotatorLimits,
  annotatorOnPicture,
  annotatorPoint,
  type AnnotatorBox,
} from './zoom';

/** A stroke younger than this when a second finger lands was the start of a pinch: it is dropped, not kept. */
export const PINCH_DROPS_STROKE_MS = 250;
/** A press that travels less than this is a tap, not a stroke. */
const TAP_SLOP_PX = 10;

interface ZoomableCanvasProps {
  imageSrc: string;
  strokes: Stroke[];
  currentStroke: Stroke | null;
  /** A stroke starts at a point in base pixels; `zoom` is the scale on screen, so its width can stay the size chosen. */
  onStrokeStart: (point: Point, zoom: number) => void;
  onStrokeMove: (point: Point) => void;
  onStrokeEnd: () => void;
  /** The stroke so far was the first finger of a pinch: drop it. */
  onStrokeCancel: () => void;
  onImageLoad: (img: HTMLImageElement) => void;
  /** Open on this part of the picture (its own pixels), as the viewer showed it. */
  initialBox?: AnnotatorBox | null;
  /** A tap beside the picture (where a click outside it went before). */
  onBackgroundTap?: () => void;
}

interface Pinch {
  dist: number;
  midX: number;
  midY: number;
}

/**
 * The drawing area on a touch screen (`ImageAnnotator`'s `zoomable`): the
 * picture fills the room between the tools and the hint, and it zooms. One
 * finger (or a pen, or a mouse) draws; two fingers pinch to zoom about their
 * midpoint and pan as they move; a stroke lands where the finger is at any
 * zoom (points are kept in the picture's base pixels, see `zoom.ts`), and its
 * width is the size chosen as seen on screen. A second finger landing in a
 * young stroke drops it (it was the start of a pinch); after a pinch, the
 * finger left behind draws nothing until every finger is up. Transforms only
 * while a gesture runs; the canvas is redrawn sharp at the new zoom after it.
 */
export const ZoomableCanvas: React.FC<ZoomableCanvasProps> = ({
  imageSrc,
  strokes,
  currentStroke,
  onStrokeStart,
  onStrokeMove,
  onStrokeEnd,
  onStrokeCancel,
  onImageLoad,
  initialBox,
  onBackgroundTap,
}) => {
  const areaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<ZoomSize | null>(null);
  const [area, setArea] = useState<ZoomSize | null>(null);
  // Taken once, when the picture and the area are both known, and kept while the screen is open: strokes are in base
  // pixels, so a base that followed a rotation would move every stroke already drawn (zoom.ts `annotatorBase`).
  const [base, setBase] = useState<ZoomSize | null>(null);
  useLayoutEffect(() => {
    if (!base && natural && area && area.width > 0 && area.height > 0) setBase(annotatorBase(natural, area));
  }, [base, natural, area]);
  const viewRef = useRef<ZoomViewport>({ x: 0, y: 0, scale: 1 });
  const placed = useRef(false);
  /** Canvas pixels per base pixel: raised after a zoom so strokes stay sharp. */
  const [ratio, setRatio] = useState(1);

  const callbacks = useRef({ onStrokeStart, onStrokeMove, onStrokeEnd, onStrokeCancel, onBackgroundTap });
  callbacks.current = { onStrokeStart, onStrokeMove, onStrokeEnd, onStrokeCancel, onBackgroundTap };
  // Read until the picture is placed (the viewer's box can arrive a render after the screen opens).
  const initialRef = useRef(initialBox);
  if (!placed.current) initialRef.current = initialBox;

  const paint = useCallback(() => {
    const view = viewRef.current;
    if (contentRef.current) contentRef.current.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }, []);
  const sharpen = useCallback(() => {
    if (!base) return;
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    setRatio(annotatorCanvasRatio(base, viewRef.current.scale, dpr));
  }, [base]);

  // The drawing area's size (the room between the tools and the hint).
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setArea((prev) => (prev && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5 ? prev : { width: r.width, height: r.height }));
    };
    read();
    // A turn of the phone resizes the window; the observer sees the area itself (the tools wrapping, a split view).
    window.addEventListener('resize', read);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    observer?.observe(el);
    return () => {
      window.removeEventListener('resize', read);
      observer?.disconnect();
    };
  }, []);

  // The first view: the part the viewer showed; after a resize, the same view kept within the new limits (the base,
  // and so every stroke, stays as it is).
  useLayoutEffect(() => {
    if (!natural || !base || !area || base.width <= 0) return;
    viewRef.current = placed.current
      ? clampViewport(viewRef.current, base, area, annotatorLimits(natural, base, area))
      : annotatorInitialView(natural, base, area, initialRef.current);
    placed.current = true;
    paint();
    sharpen();
  }, [natural, base, area, paint, sharpen]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !base) return;
    const width = Math.max(1, Math.round(base.width * ratio));
    const height = Math.max(1, Math.round(base.height * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = canvas.width / base.width;
    strokes.forEach((stroke) => renderStroke(ctx, stroke, k));
    if (currentStroke) renderStroke(ctx, currentStroke, k);
  }, [strokes, currentStroke, base, ratio]);

  useEffect(() => {
    render();
  }, [render]);

  // Safari zooms the page on a pinch unless its gesture events are prevented.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const stop = (event: Event) => event.preventDefault();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(type, stop, { passive: false });
    return () => {
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) el.removeEventListener(type, stop);
    };
  }, []);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** The stroke under way; `touched`: some point of it was on the picture (one that never was is no stroke). */
  const stroke = useRef<{ id: number; startedAt: number; touched: boolean } | null>(null);
  const press = useRef<{ id: number; x: number; y: number; moved: boolean; onPicture: boolean } | null>(null);
  const pinch = useRef<Pinch | null>(null);
  const areaBox = useRef<{ left: number; top: number }>({ left: 0, top: 0 });

  const pinchNow = (): Pinch => {
    const [a, b] = [...pointers.current.values()];
    return { dist: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), midX: (a!.x + b!.x) / 2, midY: (a!.y + b!.y) / 2 };
  };
  const pointAt = (event: React.PointerEvent): Point => {
    const p = annotatorPoint(viewRef.current, event.clientX - areaBox.current.left, event.clientY - areaBox.current.top);
    return { x: p.x, y: p.y, pressure: event.pressure };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!base || !area || !natural) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer (tests) has nothing to capture.
    }
    const r = event.currentTarget.getBoundingClientRect();
    areaBox.current = { left: r.left, top: r.top };
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      const ax = event.clientX - r.left;
      const ay = event.clientY - r.top;
      press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, onPicture: annotatorOnPicture(viewRef.current, base, ax, ay) };
      stroke.current = { id: event.pointerId, startedAt: event.timeStamp, touched: press.current.onPicture };
      callbacks.current.onStrokeStart(pointAt(event), viewRef.current.scale);
      return;
    }
    if (pointers.current.size > 2) {
      // A third finger (a palm): the pinch goes on with the first two, measured afresh so nothing jumps.
      pinch.current = pinchNow();
      return;
    }
    if (pointers.current.size === 2) {
      // The second finger: a pinch. A young stroke was its first finger (dropped); a long one is kept as drawn.
      if (stroke.current) {
        if (event.timeStamp - stroke.current.startedAt < PINCH_DROPS_STROKE_MS) callbacks.current.onStrokeCancel();
        else callbacks.current.onStrokeEnd();
        stroke.current = null;
      }
      press.current = null;
      pinch.current = pinchNow();
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!base || !area || !natural) return;
    if (pinch.current && pointers.current.size >= 2) {
      const next = pinchNow();
      const prev = pinch.current;
      const limits = annotatorLimits(natural, base, area);
      // About the fingers' last middle, then moved with it: the picture point between them stays between them.
      let view = zoomAt(viewRef.current, next.dist / prev.dist, prev.midX - areaBox.current.left, prev.midY - areaBox.current.top, base, area, limits);
      view = panBy(view, next.midX - prev.midX, next.midY - prev.midY, base, area, limits);
      pinch.current = next;
      viewRef.current = view;
      paint();
      return;
    }
    const p = press.current;
    if (p && p.id === event.pointerId && !p.moved && Math.hypot(event.clientX - p.x, event.clientY - p.y) >= TAP_SLOP_PX) p.moved = true;
    if (stroke.current && stroke.current.id === event.pointerId) {
      if (!stroke.current.touched) stroke.current.touched = annotatorOnPicture(viewRef.current, base, event.clientX - areaBox.current.left, event.clientY - areaBox.current.top);
      callbacks.current.onStrokeMove(pointAt(event));
    }
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (stroke.current && stroke.current.id === event.pointerId) {
      // Never on the picture (a tap or a slip beside it): nothing to keep, so Undo never takes an invisible stroke.
      const kept = !cancelled && stroke.current.touched;
      stroke.current = null;
      if (kept) callbacks.current.onStrokeEnd();
      else callbacks.current.onStrokeCancel();
      const p = press.current;
      press.current = null;
      if (!cancelled && p && !p.moved && !p.onPicture) callbacks.current.onBackgroundTap?.();
    }
    if (pinch.current && pointers.current.size < 2) {
      // A finger left down after a pinch draws nothing: only a new first finger starts a stroke.
      pinch.current = null;
      sharpen();
    } else if (pinch.current) {
      // One of three fingers lifted: the pinch goes on with the two left, measured afresh so nothing jumps.
      pinch.current = pinchNow();
    }
  };

  return (
    <div
      ref={areaRef}
      className="relative min-h-0 w-full flex-1 touch-none select-none overflow-hidden"
      data-pn-image-annotator-area=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endPointer(event, false)}
      onPointerCancel={(event) => endPointer(event, true)}
    >
      <div
        ref={contentRef}
        className="absolute left-0 top-0"
        style={{ width: base ? `${base.width}px` : undefined, height: base ? `${base.height}px` : undefined, transformOrigin: '0 0', opacity: base ? 1 : 0 }}
        data-pn-image-annotator-content=""
      >
        <img
          ref={imageRef}
          src={imageSrc}
          alt="Annotate"
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            if (img.naturalWidth > 0) setNatural({ width: img.naturalWidth, height: img.naturalHeight });
            onImageLoad(img);
          }}
          className="block rounded-lg"
          style={base ? { width: `${base.width}px`, height: `${base.height}px`, maxWidth: 'none', maxHeight: 'none' } : { maxWidth: 'none' }}
        />
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      </div>
    </div>
  );
};
