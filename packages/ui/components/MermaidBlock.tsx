import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Mermaid } from 'mermaid';
import type { Block } from '../types';
import { normalizeMermaidSvgMarkup } from './mermaidSvg';
import {
  MERMAID_CONFIG,
  getMermaidRetryDelayMs,
  loadMermaidRuntime,
  __setMermaidRuntimeLoaderForTests,
} from '../utils/mermaid';
import { loadMathRenderer } from '../utils/math';
import { hasMermaidMath } from '../utils/mermaid-math-slot';
import { applyMermaidTheme, mermaidThemeKey } from '../utils/mermaidTheme';
import { createRuntimeRetryEpoch } from '../utils/runtimeRetry';
import { useTheme } from './ThemeProvider';

/** One Retry re-attempts every block whose runtime import failed (see utils/runtimeRetry). */
const mermaidRetryEpoch = createRuntimeRetryEpoch();

// Re-exported: the config pin test and the lazy-retry test import them from here.
export { MERMAID_CONFIG, __setMermaidRuntimeLoaderForTests };

/**
 * The runtime comes from the slot in utils/mermaid: filled eagerly by
 * Plannotator (utils/mermaid-eager, imported by the editor App), loaded
 * lazily otherwise. See that module for the retry contract.
 */
const getMermaid = loadMermaidRuntime;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

function parseViewBox(svgEl: SVGSVGElement): ViewBox | null {
  const raw = svgEl.getAttribute('viewBox');
  if (!raw) return null;

  const values = raw
    .trim()
    .split(/[\s,]+/)
    .map((value) => Number.parseFloat(value));

  if (values.length !== 4 || values.some((value) => Number.isNaN(value))) {
    return null;
  }

  const [x, y, width, height] = values;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

// Parse base viewBox from Mermaid SVG markup before DOM mount
function parseViewBoxFromMarkup(markup: string): ViewBox | null {
  const viewBoxMatch = markup.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (viewBoxMatch?.[1]) {
    const values = viewBoxMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map((value) => Number.parseFloat(value));

    if (values.length === 4 && values.every((value) => Number.isFinite(value))) {
      const [x, y, width, height] = values;
      if (width > 0 && height > 0) {
        return { x, y, width, height };
      }
    }
  }

  const widthMatch = markup.match(/\bwidth\s*=\s*"([0-9.]+)(?:px)?"/i);
  const heightMatch = markup.match(/\bheight\s*=\s*"([0-9.]+)(?:px)?"/i);
  const width = widthMatch?.[1] ? Number.parseFloat(widthMatch[1]) : NaN;
  const height = heightMatch?.[1] ? Number.parseFloat(heightMatch[1]) : NaN;
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { x: 0, y: 0, width, height };
  }

  return null;
}

// Apply calculated viewBox from zoom and pan state
function applyView(svgEl: SVGSVGElement, base: ViewBox, zoom: number, pan: { x: number; y: number }): void {
  const zoomedWidth = base.width / zoom;
  const zoomedHeight = base.height / zoom;
  const centerX = base.x + base.width / 2;
  const centerY = base.y + base.height / 2;
  const vbX = centerX - zoomedWidth / 2 + pan.x;
  const vbY = centerY - zoomedHeight / 2 + pan.y;
  svgEl.setAttribute('viewBox', `${vbX} ${vbY} ${zoomedWidth} ${zoomedHeight}`);
}

// Compute a fitted base viewBox for the current container ratio
function fitBoundsToContainer(bounds: ViewBox, containerRect: DOMRect): ViewBox {
  const containerWidth = Math.max(containerRect.width, 1);
  const containerHeight = Math.max(containerRect.height, 1);
  const contentRatio = bounds.width / bounds.height;
  const containerRatio = containerWidth / containerHeight;

  if (contentRatio > containerRatio) {
    const targetHeight = bounds.width / containerRatio;
    const extra = (targetHeight - bounds.height) / 2;
    return {
      x: bounds.x,
      y: bounds.y - extra,
      width: bounds.width,
      height: targetHeight,
    };
  }

  const targetWidth = bounds.height * containerRatio;
  const extra = (targetWidth - bounds.width) / 2;
  return {
    x: bounds.x - extra,
    y: bounds.y,
    width: targetWidth,
    height: bounds.height,
  };
}

/**
 * Renders a mermaid diagram block with zoom controls.
 */
const MermaidBlockImpl: React.FC<{ block: Block }> = ({ block }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const expandedOverlayRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  // True when the failure was the runtime import itself (a chunking host's
  // fetch), which is the only failure a Retry can change; a diagram syntax
  // error keeps the panel exactly as it always was.
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  // The (palette, mode) the diagram must follow: the same resolution the
  // code fences use (see useFenceTheme). Outside a ThemeProvider the default
  // context yields the Plannotator dark pair, and with no theme tokens on the
  // document `applyMermaidTheme` keeps the static config, so a host without
  // the provider renders exactly as before. A key change re-runs the render
  // effect below, which is what re-themes an already rendered diagram.
  const { colorTheme, resolvedMode } = useTheme();
  const themeKey = mermaidThemeKey(colorTheme, resolvedMode === 'light' ? 'light' : 'dark');
  // A sibling's Retry re-attempts this block too, but only while its own
  // failure was the shared runtime import; a healthy block or a diagram
  // syntax error is left alone.
  const runtimeUnavailableRef = useRef(runtimeUnavailable);
  runtimeUnavailableRef.current = runtimeUnavailable;
  useEffect(() => mermaidRetryEpoch.subscribe(() => {
    if (!runtimeUnavailableRef.current) return;
    setError(null);
    setRetryToken((token) => token + 1);
  }), []);

  // All zoom/pan state as refs to avoid re-renders
  const zoomLevelRef = useRef(1);
  const isDraggingRef = useRef(false);
  const naturalBoundsRef = useRef<ViewBox | null>(null);
  const baseViewBoxRef = useRef<ViewBox | null>(null);
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const dragStartRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });

  // UI refs for zoom controls
  const zoomInBtnRef = useRef<HTMLButtonElement>(null);
  const zoomOutBtnRef = useRef<HTMLButtonElement>(null);
  const zoomDisplayRef = useRef<HTMLSpanElement>(null);

  // Update zoom level, viewBox, and UI without React re-render
  const updateZoom = useCallback((newZoom: number) => {
    zoomLevelRef.current = newZoom;

    if (containerRef.current && baseViewBoxRef.current) {
      const svgEl = containerRef.current.querySelector('svg');
      if (svgEl instanceof SVGSVGElement) {
        applyView(svgEl, baseViewBoxRef.current, newZoom, panOffsetRef.current);
      }
    }

    if (zoomInBtnRef.current) zoomInBtnRef.current.disabled = newZoom >= MAX_ZOOM;
    if (zoomOutBtnRef.current) zoomOutBtnRef.current.disabled = newZoom <= MIN_ZOOM;
    if (zoomDisplayRef.current) {
      const show = Math.abs(newZoom - 1) > 0.001;
      zoomDisplayRef.current.textContent = show ? `${Math.round(newZoom * 100)}%` : '';
      zoomDisplayRef.current.hidden = !show;
    }
  }, []);

  const fitToCurrentViewport = useCallback(() => {
    if (!containerRef.current || !naturalBoundsRef.current) return;

    const svgEl = containerRef.current.querySelector('svg');
    if (!(svgEl instanceof SVGSVGElement)) return;

    const fitted = fitBoundsToContainer(naturalBoundsRef.current, containerRef.current.getBoundingClientRect());
    baseViewBoxRef.current = fitted;
    panOffsetRef.current = { x: 0, y: 0 };
    updateZoom(1);
    applyView(svgEl, fitted, 1, { x: 0, y: 0 });
  }, [updateZoom]);

  useEffect(() => {
    let cancelled = false;

    // Render mermaid diagram
    const renderDiagram = async () => {
      let mermaid: Mermaid;
      try {
        try {
          mermaid = await getMermaid();
        } catch {
          // Transient chunk failure on a chunking host: one automatic
          // re-attempt with a fresh import() after a short delay. In a
          // single-file build the first await never rejects, so this branch
          // is unreachable there and the success path is unchanged.
          await wait(getMermaidRetryDelayMs());
          if (cancelled) return;
          mermaid = await getMermaid();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
          setRuntimeUnavailable(true);
          setSvg('');
        }
        return;
      }
      try {
        // A `$$` label makes Mermaid render KaTeX. On a host that redirects
        // Mermaid's `katex` import to `utils/mermaid-math-slot` the label is
        // typeset through the math slot, which must be filled by then: warm
        // it with the registered loader first. A filled slot (Plannotator's
        // eager entry) resolves at once; a load failure is left to the
        // render, whose error panel names it with the source.
        if (hasMermaidMath(block.content)) {
          try {
            await loadMathRenderer();
          } catch {
            // Reported by the render below.
          }
          if (cancelled) return;
        }
        // Global initialize, once per (palette, mode) change, before render.
        applyMermaidTheme(mermaid, themeKey);
        const id = `mermaid-${block.id}`;
        const { svg: renderedSvg } = await mermaid.render(id, block.content);
        if (!cancelled) {
          const normalizedSvg = normalizeMermaidSvgMarkup(renderedSvg);
          naturalBoundsRef.current = parseViewBoxFromMarkup(normalizedSvg);
          setSvg(normalizedSvg);
          setError(null);
          setRuntimeUnavailable(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
          setRuntimeUnavailable(false);
          setSvg('');
        }
      }
    };

    renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [block.content, block.id, retryToken, themeKey]);

  // Reset zoom and pan when content changes
  useEffect(() => {
    zoomLevelRef.current = 1;
    naturalBoundsRef.current = null;
    baseViewBoxRef.current = null;
    panOffsetRef.current = { x: 0, y: 0 };
    setIsExpanded(false);
  }, [block.content]);

  // Reset zoom and pan when switching from source back to diagram
  useEffect(() => {
    if (showSource) {
      setIsExpanded(false);
      return;
    }

    zoomLevelRef.current = 1;
    panOffsetRef.current = { x: 0, y: 0 };
    baseViewBoxRef.current = null;
  }, [showSource]);

  useEffect(() => {
    if (!isExpanded) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsExpanded(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isExpanded]);

  // Compute base viewBox from rendered SVG and apply initial view
  useEffect(() => {
    if (!svg || showSource || !containerRef.current) return;

    const svgEl = containerRef.current.querySelector('svg');
    if (!(svgEl instanceof SVGSVGElement)) return;

    svgEl.style.maxWidth = 'none';
    svgEl.style.width = '100%';
    svgEl.style.height = '100%';
    svgEl.style.display = 'block';
    svgEl.style.filter = 'none';
    svgEl.style.willChange = 'auto';
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', '100%');
    svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    let cancelled = false;

    const applyInitialView = () => {
      if (cancelled) return;

      try {
        const base = naturalBoundsRef.current ?? parseViewBox(svgEl);

        if (!base) return;

        naturalBoundsRef.current = base;
        fitToCurrentViewport();
      } catch {
        setError('Failed to measure diagram bounds');
        setSvg('');
      }
    };

    const raf = requestAnimationFrame(() => requestAnimationFrame(applyInitialView));
    const timer = window.setTimeout(applyInitialView, 120);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [fitToCurrentViewport, isExpanded, showSource, svg]);

  const applyWheelZoomDelta = useCallback((deltaY: number) => {
    if (Math.abs(deltaY) < 0.1) {
      return;
    }

    const delta = deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevelRef.current + delta));
    updateZoom(newZoom);
  }, [updateZoom]);

  useEffect(() => {
    if (showSource || !containerRef.current) return;

    const container = containerRef.current;
    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 0.1) return;
      event.preventDefault();
      applyWheelZoomDelta(event.deltaY);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [applyWheelZoomDelta, showSource]);

  useEffect(() => {
    if (showSource || !isExpanded) return;

    const handleExpandedPinchWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!expandedOverlayRef.current) return;

      const eventTarget = event.target;
      if (!(eventTarget instanceof Node) || !expandedOverlayRef.current.contains(eventTarget)) return;

      event.preventDefault();
      event.stopPropagation();
      applyWheelZoomDelta(event.deltaY);
    };

    window.addEventListener('wheel', handleExpandedPinchWheel, { passive: false, capture: true });

    return () => {
      window.removeEventListener('wheel', handleExpandedPinchWheel, { capture: true });
    };
  }, [applyWheelZoomDelta, isExpanded, showSource]);

  const handleZoomIn = useCallback(() => {
    updateZoom(Math.min(zoomLevelRef.current + ZOOM_STEP, MAX_ZOOM));
  }, [updateZoom]);

  const handleZoomOut = useCallback(() => {
    updateZoom(Math.max(zoomLevelRef.current - ZOOM_STEP, MIN_ZOOM));
  }, [updateZoom]);

  const handleFitToScreen = useCallback(() => {
    fitToCurrentViewport();
  }, [fitToCurrentViewport]);

  useEffect(() => {
    if (showSource || !containerRef.current || !naturalBoundsRef.current) return;
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (Math.abs(zoomLevelRef.current - 1) > 0.001) return;
      fitToCurrentViewport();
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [fitToCurrentViewport, isExpanded, showSource, svg]);

  // Drag-to-pan handlers (all ref-based to avoid re-renders)
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    isDraggingRef.current = true;
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    panStartRef.current = { ...panOffsetRef.current };
    if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
  }, []);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (!isDraggingRef.current || !containerRef.current || !baseViewBoxRef.current) return;

    const svgEl = containerRef.current.querySelector('svg');
    if (!(svgEl instanceof SVGSVGElement)) return;

    const rect = svgEl.getBoundingClientRect();
    const base = baseViewBoxRef.current;
    const zoom = zoomLevelRef.current;
    const scaleX = (base.width / zoom) / rect.width;
    const scaleY = (base.height / zoom) / rect.height;

    const dx = event.clientX - dragStartRef.current.x;
    const dy = event.clientY - dragStartRef.current.y;

    panOffsetRef.current = {
      x: panStartRef.current.x - dx * scaleX,
      y: panStartRef.current.y - dy * scaleY,
    };

    applyView(svgEl, base, zoom, panOffsetRef.current);
  }, []);

  const stopDragging = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    if (containerRef.current) containerRef.current.style.cursor = 'grab';
  }, []);

  if (error) {
    return (
      <div className="my-5 rounded-lg border border-destructive/30 bg-destructive/5 overflow-hidden">
        <div className="px-3 py-2 bg-destructive/10 border-b border-destructive/20 flex items-center gap-2">
          <svg className="w-4 h-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-xs text-destructive font-medium">Mermaid Error</span>
          {runtimeUnavailable && (
            <button
              type="button"
              onClick={() => mermaidRetryEpoch.bump()}
              className="ml-auto rounded-md border border-destructive/30 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10"
              title="Retry loading the diagram renderer"
            >
              Retry
            </button>
          )}
        </div>
        <pre className="p-3 text-xs text-destructive/80 overflow-x-auto">{error}</pre>
        <pre className="p-3 text-xs text-muted-foreground bg-muted/30 border-t border-border/30 overflow-x-auto">
          <code>{block.content}</code>
        </pre>
      </div>
    );
  }

  const controls = (
    /* Controls container */
    <div className={`absolute top-2 right-2 flex flex-col gap-1 items-center z-10 ${isExpanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 transition-opacity'}`}>
      {/* Toggle source/diagram button */}
      <button
        onClick={() => setShowSource(!showSource)}
        className="p-1.5 rounded-md bg-muted/85 hover:bg-muted text-muted-foreground hover:text-foreground"
        title={showSource ? 'Show diagram' : 'Show source'}
      >
        {showSource ? (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        )}
      </button>

      {!showSource && svg && (
        <>
          {/* Diagram interaction controls */}
          <div className="flex w-10 flex-col items-center gap-0.5 bg-muted/85 rounded-md p-0.5">
            {/* Expand/exit expanded button */}
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title={isExpanded ? 'Exit expanded view' : 'Expand diagram'}
              aria-label={isExpanded ? 'Exit expanded view' : 'Expand diagram'}
            >
              {isExpanded ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 10h4V6M18 10h-4V6M6 14h4v4M18 14h-4v4" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                </svg>
              )}
            </button>

            {/* Zoom in button */}
            <button
              ref={zoomInBtnRef}
              onClick={handleZoomIn}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
              title="Zoom in"
              aria-label="Zoom in"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
              </svg>
            </button>

            {/* Fit to view button */}
            <button
              onClick={handleFitToScreen}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Fit to view"
              aria-label="Fit to view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="4" strokeLinecap="round" strokeLinejoin="round" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v4M12 18v4M2 12h4M18 12h4" />
              </svg>
            </button>

            {/* Zoom out button */}
            <button
              ref={zoomOutBtnRef}
              onClick={handleZoomOut}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
              </svg>
            </button>
          </div>

          {/* Zoom percentage badge */}
          <span
            ref={zoomDisplayRef}
            hidden
            className="min-w-10 rounded bg-muted/85 px-1 py-0.5 text-[10px] text-center text-muted-foreground tabular-nums leading-tight"
          />
        </>
      )}
    </div>
  );

  const inlineSource = (
    <pre className="rounded-lg text-[13px] overflow-x-auto bg-muted/50 border border-border/30 p-4">
      <code className="pn-code font-mono language-mermaid">{block.content}</code>
    </pre>
  );

  const diagramBody = (
    <div
      ref={containerRef}
      data-pinpoint-ignore=""
      className={`rounded-xl bg-muted/30 border border-border/30 overflow-hidden select-none cursor-grab ${isExpanded ? 'h-full min-h-0' : 'h-[min(65vh,36rem)] min-h-[20rem]'}`}
      dangerouslySetInnerHTML={{ __html: svg }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={stopDragging}
      onMouseLeave={stopDragging}
    />
  );

  return (
    <>
      <div className="my-5 group relative" data-block-id={block.id}>
        {!isExpanded && controls}
        {showSource || !svg ? inlineSource : !isExpanded ? diagramBody : <div className="rounded-xl border border-border/30 bg-muted/10 h-[min(65vh,36rem)] min-h-[20rem]" />}
      </div>

      {!showSource && svg && isExpanded && typeof document !== 'undefined' && createPortal(
        <div ref={expandedOverlayRef} className="fixed inset-0 z-[9999] bg-background/90 backdrop-blur-sm p-4 md:p-6">
          <div className="mx-auto flex h-full max-w-[min(96vw,110rem)] flex-col gap-3">
            <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
              <span className="truncate">Mermaid diagram</span>
              <button
                onClick={() => setIsExpanded(false)}
                className="rounded-md border border-border/60 bg-card/70 px-2.5 py-1.5 text-foreground hover:bg-card"
              >
                Close
              </button>
            </div>
            <div className="group relative flex-1 min-h-0">
              {controls}
              {diagramBody}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export const MermaidBlock = React.memo(
  MermaidBlockImpl,
  (prev, next) =>
    prev.block.id === next.block.id &&
    prev.block.content === next.block.content,
);
