import React, { useRef, useState, useEffect, useCallback } from 'react';
import mermaid from 'mermaid';
import type { Block } from '../types';

// Initialize mermaid with dark theme and strict security
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  themeVariables: {
    primaryColor: '#3b82f6',
    primaryTextColor: '#f8fafc',
    primaryBorderColor: '#475569',
    lineColor: '#64748b',
    secondaryColor: '#1e293b',
    tertiaryColor: '#0f172a',
    background: '#1e293b',
    mainBkg: '#1e293b',
    nodeBorder: '#475569',
    clusterBkg: '#1e293b',
    clusterBorder: '#475569',
    titleColor: '#f8fafc',
    edgeLabelBackground: '#1e293b',
  },
  flowchart: {
    htmlLabels: true,
    curve: 'basis',
  },
});

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;

function applyView(svgEl: Element, base: ViewBox, zoom: number, pan: { x: number; y: number }): void {
  const zoomedWidth = base.width / zoom;
  const zoomedHeight = base.height / zoom;
  const centerX = base.x + base.width / 2;
  const centerY = base.y + base.height / 2;
  const vbX = centerX - zoomedWidth / 2 + pan.x;
  const vbY = centerY - zoomedHeight / 2 + pan.y;
  svgEl.setAttribute('viewBox', `${vbX} ${vbY} ${zoomedWidth} ${zoomedHeight}`);
}

/**
 * Renders a mermaid diagram block with zoom controls.
 */
export const MermaidBlock: React.FC<{ block: Block }> = ({ block }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(true);

  // All zoom/pan state as refs to avoid re-renders
  const zoomLevelRef = useRef(1.0);
  const isDraggingRef = useRef(false);
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
      if (svgEl) applyView(svgEl, baseViewBoxRef.current, newZoom, panOffsetRef.current);
    }

    if (zoomInBtnRef.current) zoomInBtnRef.current.disabled = newZoom >= MAX_ZOOM;
    if (zoomOutBtnRef.current) zoomOutBtnRef.current.disabled = newZoom <= MIN_ZOOM;
    if (zoomDisplayRef.current) {
      const show = Math.abs(newZoom - 1.0) > 0.001;
      zoomDisplayRef.current.textContent = show ? `${Math.round(newZoom * 100)}%` : '';
      zoomDisplayRef.current.hidden = !show;
    }
  }, []);

  // Render mermaid diagram
  useEffect(() => {
    const renderDiagram = async () => {
      try {
        const id = `mermaid-${block.id}`;
        const { svg: renderedSvg } = await mermaid.render(id, block.content);
        const cleaned = renderedSvg
          .replace(/ width="[^"]*"/, '')
          .replace(/ height="[^"]*"/, '');
        setSvg(cleaned);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to render diagram');
        setSvg('');
      }
    };

    renderDiagram();
  }, [block.content, block.id]);

  // Reset zoom and pan when content changes
  useEffect(() => {
    zoomLevelRef.current = 1.0;
    baseViewBoxRef.current = null;
    panOffsetRef.current = { x: 0, y: 0 };
  }, [block.content]);

  // Reset zoom and pan when switching from source back to diagram
  useEffect(() => {
    if (!showSource) {
      zoomLevelRef.current = 1.0;
      panOffsetRef.current = { x: 0, y: 0 };
      baseViewBoxRef.current = null;
    }
  }, [showSource]);

  // Compute base viewBox from rendered SVG and apply initial view
  useEffect(() => {
    if (!svg || showSource || !containerRef.current) return;

    const svgEl = containerRef.current.querySelector('svg');
    if (!svgEl) return;

    try {
      const contentGroup = svgEl.querySelector('g');
      if (!contentGroup) return;

      const bbox = (contentGroup as SVGGraphicsElement).getBBox();
      const padding = 8;

      const base: ViewBox = {
        x: bbox.x - padding,
        y: bbox.y - padding,
        width: bbox.width + padding * 2,
        height: bbox.height + padding * 2,
      };

      baseViewBoxRef.current = base;
      applyView(svgEl, base, 1.0, { x: 0, y: 0 });
    } catch {
      // Ignore errors from getBBox on hidden elements
    }
  }, [svg, showSource]);

  // Wheel zoom support
  useEffect(() => {
    if (showSource || !containerRef.current) return;

    const container = containerRef.current;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevelRef.current + delta));
      updateZoom(newZoom);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [showSource, updateZoom]);

  const handleZoomIn = useCallback(() => {
    updateZoom(Math.min(zoomLevelRef.current + ZOOM_STEP, MAX_ZOOM));
  }, [updateZoom]);

  const handleZoomOut = useCallback(() => {
    updateZoom(Math.max(zoomLevelRef.current - ZOOM_STEP, MIN_ZOOM));
  }, [updateZoom]);

  const handleFitToScreen = useCallback(() => {
    panOffsetRef.current = { x: 0, y: 0 };
    updateZoom(1.0);
  }, [updateZoom]);

  // Drag-to-pan handlers (all ref-based to avoid re-renders)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    panStartRef.current = { ...panOffsetRef.current };
    if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current || !containerRef.current || !baseViewBoxRef.current) return;

    const svgEl = containerRef.current.querySelector('svg');
    if (!svgEl) return;

    const rect = svgEl.getBoundingClientRect();
    const base = baseViewBoxRef.current;
    const zoom = zoomLevelRef.current;
    const scaleX = (base.width / zoom) / rect.width;
    const scaleY = (base.height / zoom) / rect.height;

    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;

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
        </div>
        <pre className="p-3 text-xs text-destructive/80 overflow-x-auto">{error}</pre>
        <pre className="p-3 text-xs text-muted-foreground bg-muted/30 border-t border-border/30 overflow-x-auto">
          <code>{block.content}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="my-5 group relative" data-block-id={block.id}>
      {/* Controls container */}
      <div className="absolute top-2 right-2 flex flex-col gap-1 items-end opacity-0 group-hover:opacity-100 transition-opacity z-10">
        {/* Toggle source/diagram button */}
        <button
          onClick={() => setShowSource(!showSource)}
          className="p-1.5 rounded-md bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground"
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

        {/* Zoom controls - visible only in diagram mode */}
        {!showSource && svg && (
          <div className="flex flex-col gap-0.5 bg-muted/80 rounded-md p-0.5">
            <button
              ref={zoomInBtnRef}
              onClick={handleZoomIn}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
              title="Zoom in"
              aria-label="Zoom in"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button
              onClick={handleFitToScreen}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Fit to screen"
              aria-label="Fit to screen"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
              </svg>
            </button>
            <button
              ref={zoomOutBtnRef}
              onClick={handleZoomOut}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
              </svg>
            </button>
            <span
              ref={zoomDisplayRef}
              hidden
              className="text-[10px] text-center text-muted-foreground tabular-nums leading-tight"
            />
          </div>
        )}
      </div>

      {/* Code block always in DOM for sizing; invisible when showing diagram */}
      <pre className={`rounded-lg text-[13px] overflow-x-auto bg-muted/50 border border-border/30 p-4${!showSource ? ' invisible' : ''}`}>
        <code className="hljs font-mono language-mermaid">{block.content}</code>
      </pre>

      {/* Diagram overlay - same size as code block */}
      {!showSource && svg && (
        <div
          ref={containerRef}
          className="absolute inset-0 rounded-lg bg-muted/30 border border-border/30 p-4 overflow-hidden flex justify-center select-none cursor-grab"
          dangerouslySetInnerHTML={{ __html: svg }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopDragging}
          onMouseLeave={stopDragging}
        />
      )}
    </div>
  );
};
