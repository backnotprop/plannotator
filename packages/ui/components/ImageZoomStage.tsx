import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  actualViewport,
  atFit,
  clampViewport,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  DOUBLE_TAP_ZOOM,
  fitScale,
  fitViewport,
  naturalBoxFromPoints,
  overflows,
  paddingInset,
  panBy,
  TAP_SLOP_MOUSE_PX,
  TAP_SLOP_TOUCH_PX,
  WHEEL_LATCH_MS,
  wheelTravel,
  wheelZoomFactor,
  zoomAt,
  viewportForBox,
  visibleNaturalBox,
  zoomLimits,
  type FitAxis,
  type NaturalBox,
  type ZoomClear,
  type ZoomInset,
  type ZoomSize,
  type ZoomViewport,
} from './imageZoom';
import { modKey, modKeySpoken } from '../utils/platform';

export type { FitAxis, NaturalBox } from './imageZoom';

/**
 * Whether the "Use ⌘ + scroll to zoom" hint (#2127) was shown already. A host
 * holds one for the life of its viewer (the lightbox while it is open, the
 * Inbox's file pane) and hands it to every stage it mounts, so the hint shows
 * once per viewer open, not once per image. Without one a stage keeps its own.
 */
export interface WheelHintGate {
  shown: boolean;
}

/** The hint stays this long after the last wheel event that panned. */
export const WHEEL_HINT_HOLD_MS = 2000;
/** The hint's fade out (none under reduced motion). */
export const WHEEL_HINT_FADE_MS = 300;

/** What the hint says, on screen and to a screen reader. */
export const wheelHintText = {
  visible: { before: 'Use', key: modKey, after: '+ scroll to zoom' },
  spoken: `Scrolling moves the image. To zoom, hold ${modKeySpoken} and scroll.`,
};

/** A device with a mouse or trackpad (a touch-only one never sends a wheel, and gets no hint). */
function hasFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(any-pointer: fine)').matches;
}

/** A box being drawn in Region mode (#2100), in the image's own pixels. */
export interface ZoomDraw {
  /** The box so far (`move`), the box drawn (`end`), or null on `cancel`. */
  box: NaturalBox | null;
  phase: 'move' | 'end' | 'cancel';
}

/** Fit (the whole image), Actual size (its own pixels), or anything a gesture left. */
export type ZoomMode = 'fit' | 'actual' | 'zoom';

/** What the host's capture-phase key handler reaches the stage through. */
export interface ImageZoomStageHandle {
  /** The focusable stage, to tell whether a key was aimed at it. */
  element: HTMLDivElement | null;
  /**
   * The browser's own scroll keys while the stage has focus (it stood in for
   * an overflow-auto scroller): ↑ ↓, Page Up / Page Down, Home / End, Space
   * and Shift+Space; ← → too when `arrowsSideways`. Answers whether the key
   * was one of them (the host then prevents its default).
   */
  scrollKey(key: string, shiftKey: boolean, arrowsSideways: boolean): boolean;
  /** Show a box (in the image's own pixels) large and centred (#2100). */
  zoomTo(box: NaturalBox, animate?: boolean): void;
  /** The part of the image on screen now, in its own pixels; null before it loads. */
  visibleBox(): NaturalBox | null;
}

/** One arrow key's travel, as a browser scrolls a page by a line. */
export const KEY_SCROLL_PX = 40;
/** Page Up / Page Down / Space: most of the stage, as a browser pages. */
export const KEY_PAGE_SHARE = 0.875;
/** A synthesized click this long after the tap that asked for it still closes. */
const CLICK_AFTER_TAP_MS = 800;

/** Safari's GestureEvent (trackpad pinch on macOS, two fingers on iOS). */
interface GestureLike extends Event {
  scale: number;
  clientX: number;
  clientY: number;
}

interface StageBox extends ZoomSize {
  left: number;
  top: number;
}

interface Press {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  slop: number;
  moved: boolean;
  /** Region mode: this press draws a box instead of panning. */
  draw?: boolean;
}

/** A drawn box smaller than this on screen (either side) is a tap, not a box. */
export const MIN_DRAW_SCREEN_PX = 6;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The lightbox's image, zoomable (#2067). The image is drawn at its own size
 * and moved with a transform only (translate + scale), so a gesture never
 * lays anything out.
 *
 * - Ctrl/⌘ + wheel, and a trackpad pinch (which the browser sends as a wheel
 *   with ctrlKey), zoom about the pointer.
 * - A plain wheel scrolls the image when it is larger than the stage (as a
 *   page scrolls, Shift or a sideways swipe for the other axis), and zooms
 *   about the pointer when the whole image is on screen, where there is
 *   nothing to scroll. One wheel gesture keeps the meaning it started with.
 * - The first time a plain wheel scrolls the image (once per `wheelHint`
 *   gate: per viewer open), a pill in the middle of the stage says
 *   "Use ⌘ + scroll to zoom" ("Ctrl" off macOS) and a polite live region says
 *   it once (#2127). It takes no pointer, stays while the wheel keeps
 *   scrolling and 2 s after, then fades (no fade under reduced motion); a
 *   Ctrl/⌘ + wheel, a pinch or a press hides it at once. Never on a
 *   touch-only device, never for Ctrl/⌘ + wheel or a pinch.
 * - Mouse or one-finger drag pans when there is something to pan; two
 *   fingers pinch-zoom about their midpoint and pan with it.
 * - Double click (or double tap) on the image zooms to twice the Fit scale
 *   about that point, and back to Fit.
 * - Limits: Fit (never above 1) to 800%.
 * - Safari's gesture events (its trackpad pinch) zoom too, and are prevented.
 * - The stage takes focus (it replaced an overflow-auto scroller) and pans
 *   with the browser's scroll keys through `scrollKey`, which the host's
 *   capture-phase key handler calls.
 * - A tap beside the image calls `onBackgroundTap` from the click that
 *   follows it, so the overlay is still there to take a touch's synthesized
 *   click instead of the page beneath.
 *
 * `mode` is the host's (its Fit / Actual size control); a gesture reports
 * `zoom` (or `fit` when it lands back on the Fit scale) through
 * `onModeChange`. The host keys the stage by the image, so stepping to
 * another image starts at Fit. Discrete jumps (the control, a double click)
 * ease over 180 ms unless the reader prefers reduced motion; gestures never
 * animate.
 *
 * Host seams (all optional; the lightbox passes none of them): `fitAxis`
 * (Fit fills the width or height, the smallest scale stays the whole
 * image), `padding` (Fit leaves that many pixels on every side), `overlay`
 * (drawn over the image in the same transform, e.g. a marked-up copy, so it
 * stays aligned at any zoom), `clear` (rows the host floats things over: Fit
 * and the pan's limits work between them, the image still slides under them
 * when zoomed, and those rows still take the fingers), and `onImageLoad` /
 * `onImageError`. `clear` and Region mode do not go together: `children` and
 * `onViewChange` speak of the stage without it.
 *
 * Region comments (#2100) add three more, also optional: `drawing` (a
 * primary press and drag draws a box, reported through `onDraw` in the
 * image's own pixels, instead of panning; two fingers still pinch and pan,
 * and a second finger cancels the box), `onViewChange` (every viewport, so a
 * host can draw boxes in stage pixels at a constant stroke), and `children`
 * (drawn over the stage, untransformed). The handle's `zoomTo` shows a box
 * large and centred, and `visibleBox` is the part of the image on screen.
 */
export const ImageZoomStage = forwardRef<ImageZoomStageHandle, {
  src: string;
  alt: string;
  mode: ZoomMode;
  onModeChange: (mode: ZoomMode) => void;
  /** The current scale (1 = Actual size), on every change. */
  onScaleChange?: (scale: number) => void;
  /** The share of the stage Fit may fill on each axis. */
  inset?: ZoomInset;
  /** Fit leaves this many CSS pixels on every side (wins over `inset`). */
  padding?: number;
  /** Which way Fit fits (default: the whole image). */
  fitAxis?: FitAxis;
  /** Rows at the stage's top and bottom that the host floats things over (default: none). */
  clear?: ZoomClear;
  /** Drawn over the image at its own size, in the image's transform. */
  overlay?: React.ReactNode;
  /** The image's own size, once it has loaded. */
  onImageLoad?: (size: ZoomSize) => void;
  /** The image failed to load; the host shows its own message (the stage then shows none). */
  onImageError?: () => void;
  /** A tap (a click that did not pan) beside the image, e.g. to close. */
  onBackgroundTap?: () => void;
  /** The stage's box, its position included (`relative` when absent). */
  className?: string;
  imageClassName?: string;
  /** The image's corner radius at Actual size; kept constant on screen at every scale. */
  radius?: number;
  stageAttributes?: Record<string, string>;
  /** The stage's accessible name (it takes focus, as a scroller would). */
  label: string;
  /** A longer description of the stage (its `aria-describedby` text), e.g. how Region mode draws. */
  description?: string;
  /** Region mode: a primary drag draws a box (`onDraw`) instead of panning. */
  drawing?: boolean;
  /** The box being drawn, its end, or its cancel (Region mode). */
  onDraw?: (draw: ZoomDraw) => void;
  /** Every viewport the image takes, with the stage's size; `eased` when the image moves there over 180 ms (draw boxes the same way). */
  onViewChange?: (view: ZoomViewport, stage: ZoomSize, eased: boolean) => void;
  /** Drawn over the stage, untransformed, in stage pixels (after the image). */
  children?: React.ReactNode;
  /** The "⌘ + scroll to zoom" hint's gate, shared across the viewer's stages; `false` turns the hint off. Absent: once per stage. */
  wheelHint?: WheelHintGate | false;
}>(function ImageZoomStage({ src, alt, mode, onModeChange, onScaleChange, inset, padding, fitAxis, clear, overlay, onImageLoad, onImageError, onBackgroundTap, className, imageClassName, radius = 6, stageAttributes, label, description, drawing = false, onDraw, onViewChange, children, wheelHint }, ref) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [dims, setDims] = useState<ZoomSize | null>(null);
  const [failed, setFailed] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [panning, setPanning] = useState(false);

  const insetRef = useRef(inset);
  insetRef.current = inset;
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  const axisRef = useRef<FitAxis>(fitAxis ?? 'contain');
  axisRef.current = fitAxis ?? 'contain';
  const clearTop = clear?.top ?? 0;
  const clearBottom = clear?.bottom ?? 0;
  const clearRef = useRef({ top: clearTop, bottom: clearBottom });
  clearRef.current = { top: clearTop, bottom: clearBottom };
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dimsRef = useRef<ZoomSize | null>(null);
  const boxRef = useRef<StageBox | null>(null);
  const viewRef = useRef<ZoomViewport | null>(null);
  const modeRef = useRef(mode);
  const reportedRef = useRef<ZoomMode>(mode);
  const callbacks = useRef({ onModeChange, onScaleChange, onBackgroundTap, onImageLoad, onImageError, onDraw, onViewChange });
  callbacks.current = { onModeChange, onScaleChange, onBackgroundTap, onImageLoad, onImageError, onDraw, onViewChange };
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const descriptionId = React.useId();
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const press = useRef<Press | null>(null);
  const pinch = useRef<{ dist: number; midX: number; midY: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const latch = useRef<{ kind: 'zoom' | 'pan'; until: number } | null>(null);
  // A background tap closes from the click that follows it, never from the
  // pointerup: closing on pointerup unmounted the overlay before a touch's
  // synthesized click, which then landed on whatever lay underneath.
  const closeArmed = useRef(0);
  const safariGesture = useRef<{ scale: number } | null>(null);

  // The "⌘ + scroll to zoom" hint (#2127).
  const ownGate = useRef<WheelHintGate>({ shown: false });
  const gateRef = useRef<WheelHintGate | false>(wheelHint ?? ownGate.current);
  gateRef.current = wheelHint ?? ownGate.current;
  /** Mounted once shown; `visible` drives its opacity. */
  const [hint, setHint] = useState<{ visible: boolean } | null>(null);
  const [hintSpoken, setHintSpoken] = useState('');
  const hintVisible = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideHint = useCallback(() => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = null;
    if (!hintVisible.current) return;
    hintVisible.current = false;
    setHint({ visible: false });
    // Said once already; an empty region is not read again as part of the stage.
    setHintSpoken('');
  }, []);
  /** A plain wheel scrolled the image: show the hint the first time, keep it while the wheel keeps scrolling. */
  const wheelPanned = useCallback(() => {
    const gate = gateRef.current;
    if (!hintVisible.current) {
      if (!gate || gate.shown || !hasFinePointer()) return;
      gate.shown = true;
      hintVisible.current = true;
      setHint({ visible: true });
      setHintSpoken(wheelHintText.spoken);
    }
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(hideHint, WHEEL_HINT_HOLD_MS);
  }, [hideHint]);
  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  const measure = useCallback((): StageBox | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    // The box every viewport is worked out in: the stage between the clear rows, its corner where the viewport's 0, 0 is drawn (`paint`).
    const { top, bottom } = clearRef.current;
    boxRef.current = { width: r.width, height: r.height - top - bottom, left: r.left, top: r.top + top };
    return boxRef.current;
  }, []);

  const insetNow = (): ZoomInset | undefined => (paddingRef.current !== undefined && boxRef.current ? paddingInset(boxRef.current, paddingRef.current) : insetRef.current);
  const limits = () => zoomLimits(dimsRef.current!, boxRef.current!, insetNow());
  /** The Fit scale (the whole image, or its width or height). */
  const fitNow = () => fitScale(dimsRef.current!, boxRef.current!, insetNow(), axisRef.current);
  const ready = () => !!dimsRef.current && !!boxRef.current && boxRef.current.width > 0 && boxRef.current.height > 0;

  const paint = useCallback(
    (el: HTMLElement, view: ZoomViewport, animate: boolean) => {
      el.style.transition = animate && !prefersReducedMotion() ? 'transform 180ms cubic-bezier(0.2, 0, 0, 1)' : 'none';
      el.style.transform = `translate(${view.x}px, ${view.y + clearRef.current.top}px) scale(${view.scale})`;
      el.style.borderRadius = `${radius / view.scale}px`;
    },
    [radius],
  );

  // The overlay mounts and unmounts on its own (a comment's drawing shown or
  // not): it takes the image's transform the moment it is attached.
  const attachOverlay = useCallback(
    (el: HTMLDivElement | null) => {
      overlayRef.current = el;
      if (el && viewRef.current) paint(el, viewRef.current, false);
    },
    [paint],
  );

  const apply = useCallback(
    (view: ZoomViewport, animate = false) => {
      viewRef.current = view;
      if (imgRef.current) paint(imgRef.current, view, animate);
      if (overlayRef.current) paint(overlayRef.current, view, animate);
      if (dimsRef.current && boxRef.current) setOverflowing(overflows(view, dimsRef.current, boxRef.current));
      callbacks.current.onScaleChange?.(view.scale);
      if (boxRef.current) callbacks.current.onViewChange?.(view, { width: boxRef.current.width, height: boxRef.current.height }, animate && !prefersReducedMotion());
    },
    [paint],
  );

  /** A gesture moved the image: report Fit when it is back at the Fit scale, else zoom. */
  const gesture = (view: ZoomViewport) => {
    apply(view);
    const next: ZoomMode = atFit(view, fitNow()) ? 'fit' : 'zoom';
    if (next !== reportedRef.current) {
      reportedRef.current = next;
      modeRef.current = next;
      callbacks.current.onModeChange(next);
    }
  };

  const applyMode = useCallback(
    (next: ZoomMode, animate: boolean) => {
      if (!ready()) return;
      const image = dimsRef.current!;
      const box = boxRef.current!;
      if (next === 'fit') apply(fitViewport(image, box, insetNow(), axisRef.current), animate);
      else if (next === 'actual') apply(actualViewport(image, box, insetNow()), animate);
      else if (viewRef.current) apply(clampViewport(viewRef.current, image, box, limits()), animate);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apply],
  );

  // The host's control: Fit or Actual size (a mode we reported ourselves is already on screen).
  useLayoutEffect(() => {
    modeRef.current = mode;
    if (mode === reportedRef.current) return;
    reportedRef.current = mode;
    applyMode(mode, true);
  }, [mode, applyMode]);

  // The host changed how Fit fits (its padding, the fit axis): Fit refits, anything else stays within the new limits.
  const fitShape = useRef({ padding, fitAxis });
  useLayoutEffect(() => {
    if (fitShape.current.padding === padding && fitShape.current.fitAxis === fitAxis) return;
    fitShape.current = { padding, fitAxis };
    measure();
    if (!ready() || !viewRef.current) return;
    if (modeRef.current === 'fit') applyMode('fit', false);
    else apply(clampViewport(viewRef.current, dimsRef.current!, boxRef.current!, limits()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padding, fitAxis, measure, applyMode, apply]);

  // The host's clear rows changed (what floats came or went): Fit eases to the new space, anything else stays where it is on screen, within it.
  const clearShape = useRef({ top: clearTop, bottom: clearBottom });
  useLayoutEffect(() => {
    const movedBy = clearShape.current.top - clearTop;
    if (movedBy === 0 && clearShape.current.bottom === clearBottom) return;
    clearShape.current = { top: clearTop, bottom: clearBottom };
    measure();
    if (!ready() || !viewRef.current) return;
    if (modeRef.current === 'fit') return applyMode('fit', true);
    const kept = clampViewport({ ...viewRef.current, y: viewRef.current.y + movedBy }, dimsRef.current!, boxRef.current!, limits());
    if (modeRef.current === 'zoom') gesture(kept);
    else apply(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearTop, clearBottom, measure, applyMode, apply]);

  // The image's own size, once it has loaded (or at once when it was cached).
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      const size = { width: img.naturalWidth, height: img.naturalHeight };
      setDims(size);
      callbacks.current.onImageLoad?.(size);
    }
  }, []);

  useLayoutEffect(() => {
    dimsRef.current = dims;
    if (!dims) return;
    measure();
    applyMode(modeRef.current === 'zoom' ? 'fit' : modeRef.current, false);
  }, [dims, measure, applyMode]);

  // The stage resized (the window, a phone turned): Fit refits, anything else keeps its scale within the new limits.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      measure();
      if (!ready()) return;
      if (modeRef.current === 'fit' || !viewRef.current) applyMode('fit', false);
      else if (modeRef.current === 'zoom') gesture(clampViewport(viewRef.current, dimsRef.current!, boxRef.current!, limits()));
      else apply(clampViewport(viewRef.current, dimsRef.current!, boxRef.current!, limits()));
    });
    observer.observe(stage);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, applyMode, apply]);

  // Wheel and trackpad pinch. A non-passive listener, so preventDefault keeps
  // the browser from zooming the page (Ctrl+wheel, pinch) or swiping back.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const latched = latch.current && now < latch.current.until ? latch.current : null;
      // One layout read at the start of a gesture, never between writes.
      if (!latched || !boxRef.current) measure();
      if (!ready() || !viewRef.current) return;
      const image = dimsRef.current!;
      const box = boxRef.current!;
      const { dx, dy } = wheelTravel(event, box.height);
      const px = Number.isFinite(event.clientX) ? event.clientX - box.left : box.width / 2;
      const py = Number.isFinite(event.clientY) ? event.clientY - box.top : box.height / 2;
      if (event.ctrlKey || event.metaKey) {
        latch.current = null;
        hideHint();
        if (Math.abs(dy) < 0.1 || safariGesture.current) return;
        gesture(zoomAt(viewRef.current, wheelZoomFactor(dy), px, py, image, box, limits()));
        return;
      }
      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return;
      const kind = latched ? latched.kind : overflows(viewRef.current, image, box) ? 'pan' : 'zoom';
      latch.current = { kind, until: now + WHEEL_LATCH_MS };
      if (kind === 'pan') {
        gesture(panBy(viewRef.current, -dx, -dy, image, box, limits()));
        wheelPanned();
      } else if (Math.abs(dy) > Math.abs(dx)) {
        // A sideways swipe over a fitted image is not a zoom.
        gesture(zoomAt(viewRef.current, wheelZoomFactor(dy), px, py, image, box, limits()));
      }
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, hideHint, wheelPanned]);

  // Safari sends a trackpad pinch (and, on iOS, two fingers) as gesture
  // events, not Ctrl + wheel, and zooms the page with them unless they are
  // prevented. On iOS the same fingers also arrive as pointers, which the
  // pinch below already follows, so a gesture then only prevents the page zoom.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onStart = (event: Event) => {
      event.preventDefault();
      measure();
      hideHint();
      safariGesture.current = { scale: 1 };
    };
    const onChange = (event: Event) => {
      event.preventDefault();
      const g = event as GestureLike;
      const last = safariGesture.current ?? { scale: 1 };
      const scale = Number.isFinite(g.scale) && g.scale > 0 ? g.scale : last.scale;
      safariGesture.current = { scale };
      if (pointers.current.size >= 2 || !ready() || !viewRef.current) return;
      const box = boxRef.current!;
      const px = Number.isFinite(g.clientX) ? g.clientX - box.left : box.width / 2;
      const py = Number.isFinite(g.clientY) ? g.clientY - box.top : box.height / 2;
      gesture(zoomAt(viewRef.current, scale / last.scale, px, py, dimsRef.current!, box, limits()));
    };
    const onEnd = (event: Event) => {
      event.preventDefault();
      safariGesture.current = null;
    };
    stage.addEventListener('gesturestart', onStart, { passive: false });
    stage.addEventListener('gesturechange', onChange, { passive: false });
    stage.addEventListener('gestureend', onEnd, { passive: false });
    return () => {
      stage.removeEventListener('gesturestart', onStart);
      stage.removeEventListener('gesturechange', onChange);
      stage.removeEventListener('gestureend', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, hideHint]);

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return stageRef.current;
      },
      scrollKey(key: string, shiftKey: boolean, arrowsSideways: boolean) {
        let dx = 0;
        let dy = 0;
        const page = (boxRef.current?.height ?? 0) * KEY_PAGE_SHARE;
        switch (key) {
          case 'ArrowUp': dy = KEY_SCROLL_PX; break;
          case 'ArrowDown': dy = -KEY_SCROLL_PX; break;
          case 'ArrowLeft': if (!arrowsSideways) return false; dx = KEY_SCROLL_PX; break;
          case 'ArrowRight': if (!arrowsSideways) return false; dx = -KEY_SCROLL_PX; break;
          case 'PageUp': dy = page; break;
          case 'PageDown': dy = -page; break;
          case ' ': dy = shiftKey ? page : -page; break;
          case 'Home': dy = Number.MAX_SAFE_INTEGER; break;
          case 'End': dy = -Number.MAX_SAFE_INTEGER; break;
          default: return false;
        }
        measure();
        if (ready() && viewRef.current) gesture(panBy(viewRef.current, dx, dy, dimsRef.current!, boxRef.current!, limits()));
        return true;
      },
      zoomTo(box: NaturalBox, animate = true) {
        measure();
        if (!ready()) return;
        const view = viewportForBox(box, dimsRef.current!, boxRef.current!, limits());
        apply(view, animate);
        const next: ZoomMode = atFit(view, fitNow()) ? 'fit' : 'zoom';
        if (next !== reportedRef.current) {
          reportedRef.current = next;
          modeRef.current = next;
          callbacks.current.onModeChange(next);
        }
      },
      visibleBox() {
        measure();
        if (!ready() || !viewRef.current) return null;
        return visibleNaturalBox(viewRef.current, dimsRef.current!, boxRef.current!);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [measure],
  );

  const toggleZoomAt = (px: number, py: number) => {
    if (!ready() || !viewRef.current) return;
    const lim = limits();
    const fit = fitNow();
    if (!atFit(viewRef.current, fit)) {
      reportedRef.current = 'fit';
      modeRef.current = 'fit';
      apply(fitViewport(dimsRef.current!, boxRef.current!, insetNow(), axisRef.current), true);
      callbacks.current.onModeChange('fit');
      return;
    }
    const target = Math.min(lim.max, fit * DOUBLE_TAP_ZOOM);
    const view = zoomAt(viewRef.current, target / viewRef.current.scale, px, py, dimsRef.current!, boxRef.current!, lim);
    reportedRef.current = 'zoom';
    modeRef.current = 'zoom';
    apply(view, true);
    callbacks.current.onModeChange('zoom');
  };

  const tap = (clientX: number, clientY: number) => {
    const box = boxRef.current;
    const view = viewRef.current;
    const image = dimsRef.current;
    if (!box || !view || !image) {
      lastTap.current = null;
      closeArmed.current = Date.now();
      return;
    }
    const px = clientX - box.left;
    const py = clientY - box.top;
    const onImage = px >= view.x && px <= view.x + image.width * view.scale && py >= view.y && py <= view.y + image.height * view.scale;
    if (!onImage) {
      lastTap.current = null;
      closeArmed.current = Date.now();
      return;
    }
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.t <= DOUBLE_TAP_MS && Math.hypot(clientX - prev.x, clientY - prev.y) <= DOUBLE_TAP_SLOP_PX) {
      lastTap.current = null;
      toggleZoomAt(px, py);
      return;
    }
    lastTap.current = { t: now, x: clientX, y: clientY };
  };

  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return { dist: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), midX: (a!.x + b!.x) / 2, midY: (a!.y + b!.y) / 2 };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    closeArmed.current = 0;
    hideHint();
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    measure();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic pointer (tests) has nothing to capture.
      }
    }
    if (pointers.current.size === 2) {
      pinch.current = pinchState();
      if (press.current) {
        // A second finger turns a box being drawn into a pinch.
        if (press.current.draw) {
          press.current.draw = false;
          callbacks.current.onDraw?.({ box: null, phase: 'cancel' });
        }
        press.current.moved = true;
      }
      return;
    }
    if (pointers.current.size > 2) return;
    press.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      slop: event.pointerType === 'touch' ? TAP_SLOP_TOUCH_PX : TAP_SLOP_MOUSE_PX,
      moved: false,
      draw: drawingRef.current,
    };
  };

  /** The box a draw press spans now, in the image's own pixels (null off the image or too small). */
  const drawnBox = (p: Press, clientX: number, clientY: number): NaturalBox | null => {
    const box = boxRef.current;
    const view = viewRef.current;
    const image = dimsRef.current;
    if (!box || !view || !image) return null;
    if (Math.abs(clientX - p.startX) < MIN_DRAW_SCREEN_PX || Math.abs(clientY - p.startY) < MIN_DRAW_SCREEN_PX) return null;
    return naturalBoxFromPoints(view, { x: p.startX - box.left, y: p.startY - box.top }, { x: clientX - box.left, y: clientY - box.top }, image);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!ready() || !viewRef.current) return;
    const image = dimsRef.current!;
    const box = boxRef.current!;
    if (pinch.current && pointers.current.size >= 2) {
      const next = pinchState();
      const prev = pinch.current;
      let view = zoomAt(viewRef.current, next.dist / prev.dist, next.midX - box.left, next.midY - box.top, image, box, limits());
      view = panBy(view, next.midX - prev.midX, next.midY - prev.midY, image, box, limits());
      pinch.current = next;
      gesture(view);
      return;
    }
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    if (!p.moved) {
      if (Math.hypot(event.clientX - p.startX, event.clientY - p.startY) < p.slop) return;
      p.moved = true;
      if (!p.draw && overflows(viewRef.current, image, box)) setPanning(true);
    }
    if (p.draw) {
      callbacks.current.onDraw?.({ box: drawnBox(p, event.clientX, event.clientY), phase: 'move' });
      return;
    }
    const dx = event.clientX - p.lastX;
    const dy = event.clientY - p.lastY;
    p.lastX = event.clientX;
    p.lastY = event.clientY;
    gesture(panBy(viewRef.current, dx, dy, image, box, limits()));
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      // The finger left behind carries on panning from where it is, never as a tap.
      const [rest] = [...pointers.current.entries()];
      if (rest) {
        const [id, at] = rest;
        press.current = { id, startX: at.x, startY: at.y, lastX: at.x, lastY: at.y, slop: 0, moved: true };
      } else {
        press.current = null;
      }
      return;
    }
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    press.current = null;
    setPanning(false);
    if (p.draw && p.moved) {
      const drawn = cancelled ? null : drawnBox(p, event.clientX, event.clientY);
      callbacks.current.onDraw?.(drawn ? { box: drawn, phase: 'end' } : { box: null, phase: 'cancel' });
      return;
    }
    if (!cancelled && !p.moved) tap(event.clientX, event.clientY);
  };

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const armed = closeArmed.current;
    closeArmed.current = 0;
    if (!armed || Date.now() - armed > CLICK_AFTER_TAP_MS || !callbacks.current.onBackgroundTap) return;
    // The overlay goes away with this click, so nothing beneath receives it.
    event.preventDefault();
    event.stopPropagation();
    callbacks.current.onBackgroundTap();
  };

  const cursor = drawing ? 'crosshair' : panning ? 'grabbing' : overflowing ? 'grab' : onBackgroundTap ? 'zoom-out' : 'default';
  return (
    <div
      ref={stageRef}
      className={`touch-none select-none overflow-hidden outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${className ?? 'relative'}`}
      style={{ cursor }}
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e, false)}
      onPointerCancel={(e) => endPointer(e, true)}
      {...stageAttributes}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0) {
            const size = { width: img.naturalWidth, height: img.naturalHeight };
            setDims(size);
            callbacks.current.onImageLoad?.(size);
          }
        }}
        onError={() => {
          setFailed(true);
          callbacks.current.onImageError?.();
        }}
        className={imageClassName}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          maxWidth: 'none',
          maxHeight: 'none',
          width: dims ? `${dims.width}px` : undefined,
          height: dims ? `${dims.height}px` : undefined,
          transformOrigin: '0 0',
          opacity: dims ? 1 : 0,
          // Beside the image a click closes (zoom-out); on it, a click does nothing.
          cursor: drawing ? 'crosshair' : onBackgroundTap && !overflowing ? 'default' : undefined,
        }}
        data-lightbox-image=""
      />
      {overlay != null && dims && (
        <div
          ref={attachOverlay}
          style={{ position: 'absolute', left: 0, top: 0, width: `${dims.width}px`, height: `${dims.height}px`, transformOrigin: '0 0', pointerEvents: 'none', overflow: 'hidden' }}
          data-zoom-overlay=""
        >
          {overlay}
        </div>
      )}
      {children}
      {hint && (
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-black/75 px-4 py-2 text-sm font-medium text-white shadow-lg motion-safe:transition-opacity motion-reduce:transition-none"
          style={{ opacity: hint.visible ? 1 : 0, transitionDuration: hint.visible ? '150ms' : `${WHEEL_HINT_FADE_MS}ms` }}
          aria-hidden="true"
          data-wheel-hint={hint.visible ? 'shown' : 'hidden'}
        >
          {wheelHintText.visible.before}{' '}
          <kbd className="mx-0.5 inline-block min-w-[1.5em] rounded border border-white/40 bg-white/10 px-1.5 py-px text-center font-sans text-[0.95em] leading-tight">{wheelHintText.visible.key}</kbd>{' '}
          {wheelHintText.visible.after}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite" data-wheel-hint-live="">
        {hintSpoken}
      </span>
      {description && (
        <span id={descriptionId} hidden>
          {description}
        </span>
      )}
      {failed && !onImageError && (
        <div className="absolute inset-0 flex items-center justify-center text-sm opacity-70" data-lightbox-failed="">
          This image could not be loaded.
        </div>
      )}
    </div>
  );
});
