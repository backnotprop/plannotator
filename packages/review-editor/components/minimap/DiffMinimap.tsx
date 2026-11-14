import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DiffLayoutSource, ScrollElementModel } from './layoutSource';
import { buildFileRowModel, modelItemHeight, type RowMetrics } from './rowModel';
import { changeBands, fileBoundaries, hitTest, markBands, placeFiles, rasterize, type Band, type MinimapFile, type MinimapHit, type MinimapLayout, type MinimapMark } from './scene';
import { drawMinimap, resolveMinimapColors, type MinimapColors } from './draw';
import type { MinimapFileInput, MinimapNote } from './DiffMinimapSlot';

export interface DiffMinimapProps {
  source: DiffLayoutSource;
  fallbackModel?: { current: ScrollElementModel | null };
  files: readonly MinimapFileInput[];
  viewedPaths: ReadonlySet<string> | undefined;
  notes: readonly MinimapNote[];
  metrics: RowMetrics;
  labelTop: number;
  split: boolean;
  expandUnchanged: boolean;
  pulseRef: React.MutableRefObject<(() => void) | null>;
}

interface Hover {
  y: number;
  hit: MinimapHit;
}

function layoutSignature(layout: MinimapLayout): string {
  let sum = 0;
  let collapsed = 0;
  for (const file of layout.files) {
    sum += file.top * 31 + file.height;
    if (file.collapsed) collapsed++;
  }
  return `${layout.contentHeight}|${layout.files.length}|${sum}|${collapsed}`;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

function regionsOf(bands: readonly Band[], gap: number): number[] {
  const tops = bands.filter((band) => band.kind === 'add' || band.kind === 'del').map((band) => [band.top, band.top + band.height] as const);
  tops.sort((a, b) => a[0] - b[0]);
  const starts: number[] = [];
  let end = -Infinity;
  for (const [top, bottom] of tops) {
    if (top > end + gap) starts.push(top);
    end = Math.max(end, bottom);
  }
  return starts;
}

const DiffMinimap: React.FC<DiffMinimapProps> = ({ source, fallbackModel, files, viewedPaths, notes, metrics, labelTop, split, expandUnchanged, pulseRef }) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, dpr: 1 });
  const [layout, setLayout] = useState<MinimapLayout | null>(null);
  const [colors, setColors] = useState<MinimapColors | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [dragging, setDragging] = useState(false);
  const [valueText, setValueText] = useState('');

  const models = useMemo(() => {
    const map = new Map<string, { path: string; model: ReturnType<typeof buildFileRowModel> }>();
    for (const file of files) map.set(file.id, { path: file.path, model: buildFileRowModel(file.patch, { split, expandUnchanged }) });
    return map;
  }, [files, split, expandUnchanged]);

  useEffect(() => {
    if (!fallbackModel) return;
    fallbackModel.current = {
      ids: files.map((file) => file.id),
      heightOf: (id, collapsed) => {
        const entry = models.get(id);
        return entry ? modelItemHeight(entry.model, metrics, collapsed) : metrics.headerHeight;
      },
      isCollapsed: () => false,
      offsetTop: 0,
    };
    return () => {
      fallbackModel.current = null;
    };
  }, [fallbackModel, files, models, metrics]);

  const minimapFiles = useMemo(() => {
    const map = new Map<string, MinimapFile>();
    for (const [id, { path, model }] of models) map.set(id, { id, path, model, viewed: viewedPaths?.has(path) ?? false });
    return map;
  }, [models, viewedPaths]);

  const marks = useMemo(() => {
    const idsByPath = new Map<string, string[]>();
    for (const file of files) idsByPath.set(file.path, [...(idsByPath.get(file.path) ?? []), file.id]);
    const out: MinimapMark[] = [];
    for (const note of notes) {
      for (const itemId of idsByPath.get(note.filePath) ?? []) {
        out.push({ itemId, kind: note.kind ?? 'comment', side: note.side, lineStart: note.lineStart, lineEnd: note.lineEnd });
      }
    }
    return out;
  }, [files, notes]);

  const signatureRef = useRef('');
  const measure = useCallback(() => {
    const items = source.items();
    if (!items) return;
    const next = placeFiles(items, minimapFiles, metrics, source.contentHeight());
    const signature = layoutSignature(next);
    if (signature === signatureRef.current) return;
    signatureRef.current = signature;
    setLayout(next);
  }, [source, minimapFiles, metrics]);

  useEffect(() => {
    signatureRef.current = '';
    measure();
  }, [measure]);

  useEffect(() => {
    pulseRef.current = measure;
    return () => {
      if (pulseRef.current === measure) pulseRef.current = null;
    };
  }, [measure, pulseRef]);

  useLayoutEffect(() => {
    const strip = columnRef.current;
    if (!strip) return;
    const read = () => setSize({ width: strip.clientWidth, height: strip.clientHeight, dpr: window.devicePixelRatio || 1 });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;
    const read = () => setColors(resolveMinimapColors(probe));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => observer.disconnect();
  }, []);

  const bands = useMemo(
    () => (layout && size.height > 0 ? [...changeBands(layout, metrics, size.height / Math.max(1, layout.contentHeight)), ...markBands(layout, marks, metrics)] : []),
    [layout, marks, metrics, size.height],
  );
  const regions = useMemo(() => regionsOf(bands, source.viewportHeight() / 4), [bands, source]);

  const placeOutline = useCallback(() => {
    const outline = outlineRef.current;
    const content = source.contentHeight();
    if (!outline || content <= 0 || size.height <= 0) return;
    const viewport = source.viewportHeight();
    const height = Math.max(8, Math.min(size.height, (viewport / content) * size.height));
    const top = Math.min(size.height - height, (source.scrollTop() / content) * size.height);
    outline.style.height = `${height}px`;
    outline.style.transform = `translateY(${top}px)`;
  }, [source, size.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout || !colors || size.height <= 0) return;
    const width = Math.round(size.width * size.dpr);
    const height = Math.round(size.height * size.dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawMinimap(ctx, {
      width,
      height,
      dpr: size.dpr,
      coverage: rasterize(bands, layout.contentHeight, height, { smoothRadius: Math.round(1.5 * size.dpr), minSegmentBins: Math.max(1, Math.round(size.dpr)) }),
      boundaries: fileBoundaries(layout).map((top) => (top / layout.contentHeight) * height),
      colors,
    });
    placeOutline();
  }, [layout, bands, colors, size, placeOutline]);

  useEffect(() => {
    let frame = 0;
    const unsubscribe = source.subscribeScroll(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        placeOutline();
      });
    });
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [source, placeOutline]);

  const toContent = (y: number) => (layout && size.height > 0 ? (y / size.height) * layout.contentHeight : 0);
  const describe = (hit: MinimapHit | null) => (hit ? `${hit.file.path}${hit.line ? `:${hit.line}` : ''}` : '');

  const dragRef = useRef<{ grab: number; startY: number; moved: boolean; onOutline: boolean } | null>(null);

  const scrollToStripY = (y: number, grab: number) => {
    if (!layout || size.height <= 0) return;
    source.scrollTo(((y - grab) / size.height) * layout.contentHeight);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !layout) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const outline = outlineRef.current?.getBoundingClientRect();
    const onOutline = !!outline && event.clientY >= outline.top && event.clientY <= outline.bottom;
    const outlineHeight = outline?.height ?? 0;
    const grab = onOutline && outline ? event.clientY - outline.top : outlineHeight / 2;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { grab, startY: y, moved: false, onOutline };
    setDragging(true);
    if (!onOutline) scrollToStripY(y, grab);
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!layout) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const drag = dragRef.current;
    if (drag) {
      if (Math.abs(y - drag.startY) > 2) drag.moved = true;
      if (drag.moved) scrollToStripY(y, drag.grab);
    }
    const hit = hitTest(layout, toContent(y), metrics);
    setHover(hit ? { y, hit } : null);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!drag || drag.moved || drag.onOutline || !layout) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const contentY = toContent(event.clientY - rect.top);
    const hit = hitTest(layout, contentY, metrics);
    setValueText(describe(hit));
    if (hit?.line && source.revealLine(hit.file.id, hit.line, hit.side)) return;
    source.scrollTo(contentY - source.viewportHeight() / 2);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!layout) return;
    const top = source.scrollTop();
    const viewport = source.viewportHeight();
    let target: number | null = null;
    if (event.key === 'ArrowDown') target = regions.find((start) => start > top + viewport / 3 + 1) ?? null;
    else if (event.key === 'ArrowUp') target = [...regions].reverse().find((start) => start < top + viewport / 3 - 1) ?? null;
    else if (event.key === 'PageDown') target = top + viewport * 0.9 + viewport / 3;
    else if (event.key === 'PageUp') target = top - viewport * 0.9 + viewport / 3;
    else if (event.key === 'Home') target = viewport / 3;
    else if (event.key === 'End') target = layout.contentHeight;
    else return;
    event.preventDefault();
    if (target == null) return;
    const next = target - viewport / 3;
    source.scrollTo(next);
    setValueText(describe(hitTest(layout, next + viewport / 3, metrics)));
  };

  const percent = layout && layout.contentHeight > 0 ? Math.round((source.scrollTop() / Math.max(1, layout.contentHeight - source.viewportHeight())) * 100) : 0;

  return (
    <div
      ref={stripRef}
      role="slider"
      tabIndex={0}
      aria-label="Diff overview"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.max(0, Math.min(100, percent))}
      aria-valuetext={valueText || undefined}
      data-diff-minimap=""
      className="group absolute inset-y-0 right-0 w-5 touch-none select-none cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
        setDragging(false);
      }}
      onPointerLeave={() => {
        if (!dragRef.current) setHover(null);
      }}
      onKeyDown={onKeyDown}
    >
      <span ref={probeRef} aria-hidden="true" className="hidden" />
      <div ref={columnRef} data-diff-minimap-strip="" className="absolute inset-y-0 right-0 w-3 border-l border-border/60">
        <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
        <div
          ref={outlineRef}
          aria-hidden="true"
          data-diff-minimap-viewport=""
          className={`pointer-events-none absolute inset-x-0 top-0 border-y transition-colors ${
            dragging ? 'border-foreground/70 bg-foreground/[0.16]' : 'border-foreground/50 bg-foreground/[0.09] group-hover:border-foreground/65'
          }`}
          style={{ willChange: 'transform' }}
        />
        {hover && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 h-px bg-foreground/70" style={{ top: hover.y }} />
        )}
      </div>
      {hover && (
        <div
          aria-hidden="true"
          data-diff-minimap-label=""
          className="pointer-events-none absolute right-full mr-1 whitespace-nowrap rounded border border-border bg-popover px-1.5 py-0.5 text-[12px] leading-4 text-popover-foreground tabular-nums"
          style={{ top: labelTop }}
        >
          {baseName(hover.hit.file.path)}
          {hover.hit.line ? <span className="text-muted-foreground">:{hover.hit.line}</span> : null}
        </div>
      )}
    </div>
  );
};

export default DiffMinimap;
