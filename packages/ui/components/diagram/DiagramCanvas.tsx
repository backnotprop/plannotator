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
import {
  DRAG_THRESHOLD_PX,
  TOUCH_DRAG_THRESHOLD_PX,
  useDiagramViewport,
  WHEEL_ZOOM_SENSITIVITY,
  ZOOM_STEP,
  type ContentSize,
  type Viewport,
} from './useDiagramViewport';

/**
 * The canvas: the rendered svg inside a transformed wrapper, edge to edge in
 * its host. Wheel and pinch zoom about the pointer, drag pans, `+` `-` `0`
 * (fit) and the arrow keys on the keyboard, a small control in the corner.
 * Click-to-select, drag-to-pan: a press that does not travel the drag
 * threshold (4 px for a mouse or pen, 10 px for a finger) is a click and
 * opens the composer; one that travels is a pan and never opens it. Nothing
 * highlights on a plain mouse-over (the owner removed hover targeting: it
 * read as messy and fought the pan hand); the only pre-click affordance is
 * the ring under the pointer while the platform modifier is held, and it
 * disarms on the key's release, on any other key, and on window blur.
 *
 * What a click means is decided over EVERYTHING under the pointer
 * (`elementsFromPoint`), never the topmost element alone: every edge has an
 * invisible 14 px hit path in a layer above the diagram (the render slot's
 * `widenEdgeHitAreas`), so where an edge meets a node both are under the
 * pointer, and the caller's `pickTarget` takes the node first, then an edge,
 * then a cluster.
 *
 * In the document flow the canvas lets a finger scroll the page vertically
 * (`touch-action: pan-y`); a full-size host that owns the screen passes
 * `touch-none` through `className`. Under strict Mermaid disables click
 * callbacks, and a `click A "https://..."` link binding still renders an
 * `<a href>` that the render slot's sanitizer strips, so the canvas owns
 * every click and there is no armed switch.
 *
 * The render slot hands over a sanitized svg NODE, not markup: the wrapper
 * mounts it with `replaceChildren` once per render, so no html string ever
 * crosses into the app DOM here. The overlay (a sibling of the wrapper,
 * unscaled) is the caller's, rendered through `overlay` with the live
 * viewport so rings reproject on every change.
 */

/** A numeric svg length: `206`, `206pt`, `206px`. */
function svgLength(value: string | null): number {
  if (value === null) return Number.NaN;
  return Number.parseFloat(value);
}

/** The svg's intrinsic size, from its viewBox (Mermaid and Graphviz always
 * write one), else its `width` / `height` attributes (a `pt` or `px` suffix
 * is accepted, as Graphviz writes them). */
export function svgContentSize(svg: SVGSVGElement): ContentSize | null {
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox !== null) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/u)
      .map(Number);
    const width = parts[2];
    const height = parts[3];
    if (
      parts.length === 4 &&
      width !== undefined &&
      height !== undefined &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      return { width, height };
    }
  }
  const width = svgLength(svg.getAttribute('width'));
  const height = svgLength(svg.getAttribute('height'));
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

/** One arrow-key press pans this far (the diagram moves WITH the arrow, as
 * a scroll would); Shift multiplies it by five. */
export const KEY_PAN_PX = 40;

export interface DiagramCanvasHandle {
  readonly viewport: Viewport;
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  readonly panIntoView: ReturnType<typeof useDiagramViewport>['panIntoView'];
}

/** What an Escape on the canvas did: `consumed` closed something the viewer
 * owns (a draft, a selection) and the key goes no further; `pass` lets it
 * reach whatever holds the canvas (a popout's close). */
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
  /** The engine's selector of every element the pointer can address
   * (the finder's, through the renderer slot). */
  targetSelector: string;
  /** Choose among the addressable elements under the pointer, topmost
   * first (the viewer's rule: a node, then an edge, then a cluster).
   * Default: the topmost. */
  pickTarget?: (candidates: readonly Element[]) => Element | null;
  /** A parse error keeps the last render under the strip, dimmed. */
  dimmed: boolean;
  /** The mounted svg root after each injection (null on unmount). */
  onSvgRoot: (root: SVGSVGElement | null) => void;
  onHoverElement: (element: Element | null) => void;
  onClickElement: (element: Element | null, shiftKey: boolean) => void;
  onEscape: () => DiagramEscapeOutcome;
  /** The overlay layer, given the live viewport and host. */
  overlay: (handle: DiagramCanvasHandle) => ReactNode;
  children?: ReactNode;
  /** Take the keyboard on mount so `+`, `-`, `0` and Escape work at once
   * (a popout). Off in the document flow, where it would steal the focus
   * from the reader. */
  autoFocus?: boolean;
  /** `touch-none` for a host that owns the whole screen (a popout); the
   * default lets a finger scroll the page past an inline diagram. */
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<ContentSize | null>(null);
  const { viewport, fit, zoomBy, panBy, panIntoView } = useDiagramViewport(hostRef, content);

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

  // Wheel zoom needs a non-passive listener (React's onWheel is passive,
  // so preventDefault there cannot stop the page from scrolling).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const onWheel = (event: WheelEvent) => {
      // A sub-pixel delta (a trackpad coming to rest, a horizontal swipe)
      // is neither a zoom nor a reason to hold the page's scroll.
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
      // Everything under the pointer, topmost first. Without a layout
      // engine (happy-dom) the event's own target is all there is.
      const doc = wrapper.ownerDocument;
      const stack =
        typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(event.clientX, event.clientY) : [];
      const under = stack.length > 0 ? stack : event.target instanceof Element ? [event.target] : [];
      const candidates: Element[] = [];
      for (const el of under) {
        if (!wrapper.contains(el)) continue;
        // A hit path stands for the visible edge it was made from.
        const node = diagramHitSource(el) ?? el;
        const target = node.closest(targetSelector);
        if (target !== null && wrapper.contains(target) && !candidates.includes(target)) candidates.push(target);
      }
      if (candidates.length === 0) return null;
      return pickTarget ? pickTarget(candidates) : (candidates[0] ?? null);
    },
    [pickTarget, targetSelector],
  );

  // The modifier-gated ring disarms the way the token hover cards do: on
  // the modifier's release, on any other key while it is held (Cmd+C is a
  // copy, not a question about the part under the pointer), and on blur.
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

  // Press bookkeeping: where the pointer went down and whether it became a
  // pan. Pointer capture keeps the pan alive past the host's edge.
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

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
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
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = pressRef.current;
      if (press === null || press.id !== event.pointerId) {
        // Nothing highlights on a plain mouse-over; the ring under the
        // pointer exists only under the platform modifier.
        onHoverElement(isModKeyHeld(event) ? targetUnder(event) : null);
        return;
      }
      if (!press.panning) {
        const travelled = Math.hypot(event.clientX - press.x, event.clientY - press.y);
        if (travelled < press.threshold) return;
        press.panning = true;
        setPanning(true);
        onHoverElement(null);
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }
      panBy(event.clientX - press.lastX, event.clientY - press.lastY);
      press.lastX = event.clientX;
      press.lastY = event.clientY;
    },
    [onHoverElement, panBy, targetUnder],
  );

  const endPress = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, click: boolean) => {
      const press = pressRef.current;
      if (press === null || press.id !== event.pointerId) return;
      pressRef.current = null;
      if (press.panning) {
        setPanning(false);
        const target = event.currentTarget;
        if (typeof target.hasPointerCapture === 'function' && target.hasPointerCapture(event.pointerId)) {
          target.releasePointerCapture(event.pointerId);
        }
        return;
      }
      if (click) onClickElement(targetUnder(event), event.shiftKey);
    },
    [onClickElement, targetUnder],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // Keys act on the canvas itself, never on the composer's textarea.
      if (event.target !== event.currentTarget) return;
      // Mod+0, Mod+-, Alt+Arrow belong to the browser (page zoom, history).
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
        // Screen chrome: never printed (rings and badges are, they are the
        // comments). On a narrow screen the strip takes the left edge so it
        // never stacks under a host's own bottom-right controls.
        data-print-hide=""
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
