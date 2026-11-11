import { Maximize2, Minus, Plus } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/utils';
import { diagramHitSource } from '../../utils/diagram-render';
import { isMac, isModKeyHeld } from '../../utils/platform';
import { Button } from '../ui/button';
import { DOUBLE_TAP_MS, DOUBLE_TAP_SLOP_PX } from '../imageZoom';
import { isDiagramControlEvent } from './diagramControls';
import { svgContentSize } from './svgContentSize';
import {
  DRAG_THRESHOLD_PX,
  TOUCH_DRAG_THRESHOLD_PX,
  useDiagramViewport,
  WHEEL_ZOOM_SENSITIVITY,
  ZOOM_STEP,
  type ContentSize,
  type Viewport,
} from './useDiagramViewport';

/** A tap on a part clicks at once, inside the touch, so iOS raises the keyboard for the composer. */

// `svgContentSize` is the canvas's, but the document's fence block needs it without the canvas: it
// lives in its own dependency-free module and is re-exported here so every published path keeps
// resolving.
export { svgContentSize } from './svgContentSize';

/**
 * One arrow-key press pans this far (the diagram moves WITH the arrow, as a scroll would); Shift
 * multiplies it by five.
 */
export const KEY_PAN_PX = 40;

export interface DiagramCanvasHandle {
  readonly viewport: Viewport;
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  readonly panIntoView: ReturnType<typeof useDiagramViewport>['panIntoView'];
}

/**
 * What an Escape on the canvas did: `consumed` closed something the viewer owns (a draft, a
 * selection) and the key goes no further.
 */
export type DiagramEscapeOutcome = 'consumed' | 'pass';

export function DiagramCanvas({
  svgNode,
  targetSelector,
  pickTarget,
  dimmed,
  onSvgRoot,
  onHoverElement,
  onClickElement,
  onEscape,
  overlay,
  children,
  autoFocus,
  className,
}: {
  /** The last good render's sanitized svg root, or null before the first. */
  svgNode: SVGSVGElement | null;
  targetSelector: string;
  pickTarget?: (candidates: readonly Element[]) => Element | null;
  dimmed: boolean;
  /** The mounted svg root after each injection (null on unmount). */
  onSvgRoot: (root: SVGSVGElement | null) => void;
  onHoverElement: (element: Element | null) => void;
  onClickElement: (element: Element | null, shiftKey: boolean) => void;
  onEscape: () => DiagramEscapeOutcome;
  overlay: (handle: DiagramCanvasHandle) => ReactNode;
  children?: ReactNode;
  /** Off in the document flow, where it would steal the focus from the reader. */
  autoFocus?: boolean;
  /**
   * `touch-none` for a host that owns the whole screen (a popout); the default lets a finger
   * scroll the page past an inline diagram.
   */
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<ContentSize | null>(null);
  const { viewport, fit, zoomBy, toggleZoom, panBy, panIntoView } = useDiagramViewport(hostRef, content);

  // Mount the sanitized node once per render and size the wrapper to the
  // diagram's own box so the transform scales real pixels.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) return;
    if (svgNode === null) {
      wrapper.replaceChildren();
      setContent(null);
      onSvgRoot(null);
      return;
    }
    wrapper.replaceChildren(svgNode);
    const size = svgContentSize(svgNode);
    if (size !== null) {
      svgNode.style.width = '100%';
      svgNode.style.height = '100%';
      svgNode.style.maxWidth = 'none';
    }
    setContent(size);
    onSvgRoot(svgNode);
    return () => onSvgRoot(null);
  }, [onSvgRoot, svgNode]);

  useEffect(() => {
    if (autoFocus) hostRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 0.1) return;
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), event.clientX, event.clientY);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const targetUnder = useCallback(
    (event: ReactPointerEvent): Element | null => {
      const wrapper = wrapperRef.current;
      if (wrapper === null) return null;
      // The zoom strip and the composer are painted OVER the canvas and are not in the svg, so the
      // walk below would step past them to whatever part sits underneath. A press on chrome
      // addresses no part.
      if (isDiagramControlEvent(event)) return null;
      const doc = wrapper.ownerDocument;
      const stack =
        typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(event.clientX, event.clientY) : [];
      const under = stack.length > 0 ? stack : event.target instanceof Element ? [event.target] : [];
      const candidates: Element[] = [];
      for (const el of under) {
        if (!wrapper.contains(el)) continue;
        const node = diagramHitSource(el) ?? el;
        const target = node.closest(targetSelector);
        if (target !== null && wrapper.contains(target) && !candidates.includes(target)) candidates.push(target);
      }
      if (candidates.length === 0) return null;
      return pickTarget ? pickTarget(candidates) : (candidates[0] ?? null);
    },
    [pickTarget, targetSelector],
  );

  useEffect(() => {
    const win = hostRef.current?.ownerDocument.defaultView;
    if (!win) return;
    const modKey = isMac ? 'Meta' : 'Control';
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === modKey) onHoverElement(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== modKey) onHoverElement(null);
    };
    const onBlur = () => onHoverElement(null);
    win.addEventListener('keyup', onKeyUp);
    win.addEventListener('keydown', onKeyDown);
    win.addEventListener('blur', onBlur);
    return () => {
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('blur', onBlur);
    };
  }, [onHoverElement]);

  const pressRef = useRef<{
    id: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    threshold: number;
    panning: boolean;
  } | null>(null);
  const [panning, setPanning] = useState(false);

  const fingersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);
  const pinchOf = useCallback(() => {
    const [a, b] = [...fingersRef.current.values()];
    if (a === undefined || b === undefined) return null;
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  }, []);

  // A finger's tap on empty space waits out the double-tap window before it clicks (a tap on a
  // part clicks at once, inside the touch, so iOS raises the keyboard for the composer it opens):
  // where and when it landed, and its click while it waits.
  const pendingTapRef = useRef<{ t: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const onClickElementRef = useRef(onClickElement);
  onClickElementRef.current = onClickElement;
  const cancelTap = useCallback(() => {
    const pending = pendingTapRef.current;
    if (pending === null) return;
    pendingTapRef.current = null;
    clearTimeout(pending.timer);
  }, []);
  useEffect(() => cancelTap, [cancelTap]);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const doc = host.ownerDocument;
    const onDown = (event: PointerEvent) => {
      if (pendingTapRef.current === null) return;
      const target = event.target;
      // A badge is a button, so a control.
      const onCanvas = target instanceof Node && host.contains(target);
      if (!onCanvas || isDiagramControlEvent(event)) cancelTap();
    };
    doc.addEventListener('pointerdown', onDown, true);
    return () => doc.removeEventListener('pointerdown', onDown, true);
  }, [cancelTap]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (isDiagramControlEvent(event)) {
      pressRef.current = null;
      return;
    }
    if (event.pointerType === 'touch') {
      // The first finger down starts afresh (a lift the canvas never saw
      // leaves no finger behind).
      if (event.isPrimary) {
        fingersRef.current.clear();
        pinchRef.current = null;
      }
      fingersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (fingersRef.current.size >= 2) {
        pinchRef.current = pinchOf();
        if (pressRef.current?.panning) setPanning(false);
        pressRef.current = null;
        cancelTap();
        return;
      }
    }
    pressRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      // A fingertip wobbles more than a mouse: a tap must still be a tap.
      threshold: event.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD_PX : DRAG_THRESHOLD_PX,
      panning: false,
    };
  }, [cancelTap, pinchOf]);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (fingersRef.current.has(event.pointerId)) {
        fingersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const prev = pinchRef.current;
        const next = prev === null ? null : pinchOf();
        if (prev !== null && next !== null) {
          panBy(next.midX - prev.midX, next.midY - prev.midY);
          zoomBy(next.dist / prev.dist, next.midX, next.midY);
          pinchRef.current = next;
          return;
        }
      }
      const press = pressRef.current;
      if (press === null || press.id !== event.pointerId) {
        onHoverElement(isModKeyHeld(event) ? targetUnder(event) : null);
        return;
      }
      if (!press.panning) {
        const travelled = Math.hypot(event.clientX - press.x, event.clientY - press.y);
        if (travelled < press.threshold) return;
        press.panning = true;
        setPanning(true);
        onHoverElement(null);
        cancelTap();
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }
      panBy(event.clientX - press.lastX, event.clientY - press.lastY);
      press.lastX = event.clientX;
      press.lastY = event.clientY;
    },
    [cancelTap, onHoverElement, panBy, pinchOf, targetUnder, zoomBy],
  );

  const endPress = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, click: boolean) => {
      if (fingersRef.current.delete(event.pointerId) && pinchRef.current !== null) {
        // Two still down pinch on from where they are; one left behind pans on, and is never a
        // tap.
        pinchRef.current = pinchOf();
        const rest = fingersRef.current.size === 1 ? [...fingersRef.current][0] : undefined;
        pressRef.current =
          rest === undefined
            ? null
            : { id: rest[0], x: rest[1].x, y: rest[1].y, lastX: rest[1].x, lastY: rest[1].y, threshold: 0, panning: true };
        return;
      }
      const press = pressRef.current;
      if (press === null || press.id !== event.pointerId) return;
      pressRef.current = null;
      // Released over a control (the press began on the canvas): not a click on the diagram, and
      // `targetUnder` answering null would otherwise read as "comment on the whole diagram".
      if (isDiagramControlEvent(event)) {
        if (press.panning) setPanning(false);
        return;
      }
      if (press.panning) {
        setPanning(false);
        const target = event.currentTarget;
        if (typeof target.hasPointerCapture === 'function' && target.hasPointerCapture(event.pointerId)) {
          target.releasePointerCapture(event.pointerId);
        }
        return;
      }
      if (!click) return;
      const element = targetUnder(event);
      if (event.pointerType !== 'touch') {
        onClickElement(element, event.shiftKey);
        return;
      }
      // The second tap of a double tap begun on empty space zooms, and the first one's click never
      // lands.
      const now = Date.now();
      const pending = pendingTapRef.current;
      cancelTap();
      if (pending !== null && now - pending.t <= DOUBLE_TAP_MS && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <= DOUBLE_TAP_SLOP_PX) {
        toggleZoom(event.clientX, event.clientY);
        return;
      }
      // A part clicks at once, inside the touch (iOS shows the keyboard only
      // for a focus made there); a double tap on it opens its composer.
      if (element !== null) {
        onClickElement(element, event.shiftKey);
        return;
      }
      const shiftKey = event.shiftKey;
      const timer = setTimeout(() => {
        if (pendingTapRef.current?.timer !== timer) return;
        pendingTapRef.current = null;
        onClickElementRef.current(null, shiftKey);
      }, DOUBLE_TAP_MS);
      pendingTapRef.current = { t: now, x: event.clientX, y: event.clientY, timer };
    },
    [cancelTap, onClickElement, pinchOf, targetUnder, toggleZoom],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // Keys act on the canvas itself, never on the composer's textarea.
      if (event.target !== event.currentTarget) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case '+':
        case '=':
          zoomBy(ZOOM_STEP);
          break;
        case '-':
        case '_':
          zoomBy(1 / ZOOM_STEP);
          break;
        case '0':
          fit();
          break;
        case 'ArrowLeft':
          panBy(event.shiftKey ? KEY_PAN_PX * 5 : KEY_PAN_PX, 0);
          break;
        case 'ArrowRight':
          panBy(event.shiftKey ? -KEY_PAN_PX * 5 : -KEY_PAN_PX, 0);
          break;
        case 'ArrowUp':
          panBy(0, event.shiftKey ? KEY_PAN_PX * 5 : KEY_PAN_PX);
          break;
        case 'ArrowDown':
          panBy(0, event.shiftKey ? -KEY_PAN_PX * 5 : -KEY_PAN_PX);
          break;
        case 'Escape': {
          if (onEscape() !== 'consumed') return;
          event.stopPropagation();
          break;
        }
        default:
          return;
      }
      event.preventDefault();
    },
    [fit, onEscape, panBy, zoomBy],
  );

  const handle = useMemo<DiagramCanvasHandle>(() => ({ viewport, hostRef, panIntoView }), [panIntoView, viewport]);

  return (
    <div
      ref={hostRef}
      data-diagram-canvas=""
      tabIndex={0}
      aria-label="Diagram canvas. Drag or arrow keys to pan, wheel or plus and minus to zoom, 0 to fit, click a part to comment."
      className={cn(
        'relative h-full w-full touch-pan-y select-none overflow-hidden outline-none',
        panning ? 'cursor-grabbing' : 'cursor-grab',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endPress(event, true)}
      onPointerCancel={(event) => endPress(event, false)}
      onPointerLeave={() => onHoverElement(null)}
      onKeyDown={onKeyDown}
    >
      <div
        ref={wrapperRef}
        data-diagram-svg=""
        className={cn('absolute left-0 top-0 origin-top-left transition-opacity duration-150', dimmed && 'opacity-40')}
        style={{
          width: content?.width,
          height: content?.height,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      />
      {overlay(handle)}
      {children}
      <div
        // Screen chrome: never printed (rings and badges are, they are the comments).
        data-print-hide=""
        data-diagram-control=""
        data-diagram-zoom-strip=""
        className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card/85 p-0.5 backdrop-blur max-md:bottom-4 max-md:left-4 max-md:right-auto"
        role="group"
        aria-label="Zoom"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Zoom out"
          title="Zoom out (-)"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          <Minus aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Fit diagram" title="Fit (0)" onClick={fit}>
          <Maximize2 aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Zoom in"
          title="Zoom in (+)"
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
