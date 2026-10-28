import React, { useMemo } from 'react';
import { imageRegionFileName, imageRegionSize, parseImageRegion, type ImageRegion } from '@plannotator/core/image-region';
import type { Annotation } from '../types';
import type { NaturalBox, StageRect, ZoomSize, ZoomViewport } from './imageZoom';
import { naturalBoxToStage } from './imageZoom';
import { getImageSrc } from './ImageThumbnail';

/**
 * The URL a markdown image's src (as written) loads from, the way the
 * document renders it: http(s), data: and blob: as written, anything else
 * through the host's image route relative to `baseDir`. For the crop
 * thumbnails of region cards in the document's annotations panel.
 */
export function loadableImageSrc(src: string, baseDir?: string): string {
  return /^(https?:\/\/|data:|blob:)/i.test(src) ? src : getImageSrc(src, baseDir);
}

/**
 * The pieces of image region comments (#2100, approval
 * "image-region-comments", variant C): the Move | Region strip, the boxes
 * drawn over the image in the viewer, the crop thumbnail and the card body
 * the annotations panel shows. The lightbox (`ImageLightbox`) composes them.
 */

/** The validated region of an annotation, or null (a malformed region is no region). */
export function regionOf(annotation: Pick<Annotation, 'imageRegion'>): ImageRegion | null {
  return annotation.imageRegion == null ? null : parseImageRegion(annotation.imageRegion);
}

/**
 * Each region comment's number on its image: 1, 2, … in the order they were
 * made, counted per image (the src as written). Replies are not regions.
 */
export function imageRegionNumbers(annotations: readonly Annotation[]): Map<string, number> {
  const bySrc = new Map<string, Annotation[]>();
  for (const ann of annotations) {
    const region = regionOf(ann);
    if (!region) continue;
    const list = bySrc.get(region.src) ?? [];
    list.push(ann);
    bySrc.set(region.src, list);
  }
  const out = new Map<string, number>();
  for (const list of bySrc.values()) {
    [...list].sort((a, b) => a.createdA - b.createdA).forEach((ann, i) => out.set(ann.id, i + 1));
  }
  return out;
}

const ICON = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const HandIcon: React.FC<{ size?: number }> = ({ size = 15 }) => (
  <svg {...ICON} width={size} height={size}>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-7a1.5 1.5 0 0 1 3 0V12M14 11.5V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-4.7-2.3L3.6 15.4a1.6 1.6 0 0 1 2.4-2l2 2" />
  </svg>
);

export const RegionIcon: React.FC<{ size?: number }> = ({ size = 15 }) => (
  <svg {...ICON} width={size} height={size}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <path d="M12 9v6M9 12h6" />
  </svg>
);

export const ChatIcon: React.FC<{ size?: number }> = ({ size = 15 }) => (
  <svg {...ICON} width={size} height={size}>
    <path d="M7.5 8.25h9m-9 3H12M3 20.25V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v9a2.25 2.25 0 0 1-2.25 2.25H7.5L3 20.25Z" />
  </svg>
);

/**
 * A crop of the image showing the region, as a CSS background (no canvas, no
 * second request: the browser reuses the image it already loaded). The crop
 * keeps the region's shape within `maxWidth` × `maxHeight`.
 */
export const RegionThumb: React.FC<{
  src: string;
  region: ImageRegion;
  maxWidth?: number;
  maxHeight?: number;
}> = ({ src, region, maxWidth = 76, maxHeight = 48 }) => {
  const { box, naturalWidth, naturalHeight } = region;
  const s = Math.min(maxWidth / box.w, maxHeight / box.h);
  const width = Math.max(4, Math.round(box.w * s));
  const height = Math.max(4, Math.round(box.h * s));
  return (
    <div
      aria-hidden="true"
      data-region-thumb=""
      className="flex-none rounded-[5px] bg-white bg-no-repeat ring-1 ring-border/80"
      style={{
        width,
        height,
        backgroundImage: `url(${JSON.stringify(src)})`,
        backgroundSize: `${naturalWidth * s}px ${naturalHeight * s}px`,
        backgroundPosition: `${-box.x * s}px ${-box.y * s}px`,
      }}
    />
  );
};

/** The number badge of a region (the same number the box on the image carries). */
export const RegionNumber: React.FC<{ n: number; selected?: boolean; className?: string }> = ({ n, selected = false, className = '' }) => (
  <span
    aria-hidden="true"
    className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9.5px] font-bold tabular-nums text-white ${selected ? 'bg-primary' : 'bg-annotation-comment'} ${className}`}
  >
    {n}
  </span>
);

/**
 * What a region card shows in place of a quote: the crop, the file, the
 * box's size in the image's own pixels and the image's line.
 */
export const RegionCardInfo: React.FC<{ region: ImageRegion; thumbSrc?: string | null }> = ({ region, thumbSrc }) => (
  <div className="mb-1.5 flex items-center gap-2.5" data-region-card-info="">
    {thumbSrc && <RegionThumb src={thumbSrc} region={region} />}
    <div className="min-w-0 font-mono text-[10.5px] leading-normal text-muted-foreground">
      <div className="truncate">{imageRegionFileName(region.src)}</div>
      <div className="truncate">
        {imageRegionSize(region)}
        {region.sourceLine !== null && <> · line {region.sourceLine}</>}
      </div>
    </div>
  </div>
);

/** One region drawn on the image. */
export interface RegionBoxItem {
  id: string;
  n: number;
  box: NaturalBox;
  /** Its comment, for the box's accessible name. */
  text?: string;
}

const boxStyle = (rect: StageRect, eased: boolean): React.CSSProperties => ({
  position: 'absolute',
  left: rect.left,
  top: rect.top,
  width: rect.width,
  height: rect.height,
  transition: eased ? 'left 180ms cubic-bezier(0.2, 0, 0, 1), top 180ms cubic-bezier(0.2, 0, 0, 1), width 180ms cubic-bezier(0.2, 0, 0, 1), height 180ms cubic-bezier(0.2, 0, 0, 1), opacity 150ms' : 'opacity 150ms',
});

/**
 * The boxes over the image, in stage pixels (so a stroke and a badge keep
 * their size at every zoom): the saved regions (numbered, the comment
 * colour), the selected one (ringed, the rest and the image dimmed), the box
 * being drawn (dashed, with its size in the image's own pixels) and the box
 * waiting for its comment (solid, numbered).
 */
export const RegionBoxLayer: React.FC<{
  view: ZoomViewport | null;
  stage: ZoomSize | null;
  eased: boolean;
  regions: readonly RegionBoxItem[];
  selectedId: string | null;
  /** The box being drawn now. */
  draft: NaturalBox | null;
  /** The box waiting for its comment, and its number. */
  pending: { box: NaturalBox; n: number } | null;
  /** Saved boxes take a click (Move mode); in Region mode the drag draws through them. */
  interactive: boolean;
  onPick: (id: string) => void;
  /** The pending box's element, the comment box's anchor. */
  pendingRef?: React.Ref<HTMLDivElement>;
}> = ({ view, stage, eased, regions, selectedId, draft, pending, interactive, onPick, pendingRef }) => {
  if (!view || !stage) return null;
  const anySelected = selectedId !== null && regions.some((r) => r.id === selectedId);
  const badge = 'absolute -left-3 -top-3 flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-[11.5px] font-bold tabular-nums text-white shadow-[0_0_0_2px_var(--background),0_2px_6px_-2px_rgb(0_0_0/0.4)]';
  return (
    <div className="pointer-events-none absolute inset-0" data-region-layer="">
      {regions.map((r) => {
        const rect = naturalBoxToStage(view, r.box);
        const selected = r.id === selectedId;
        return (
          <div
            key={r.id}
            data-region-box={r.id}
            data-region-selected={selected ? '' : undefined}
            aria-hidden="true"
            onPointerDown={interactive ? (e) => e.stopPropagation() : undefined}
            onClick={interactive ? (e) => { e.stopPropagation(); onPick(r.id); } : undefined}
            className={
              selected
                ? 'rounded-[3px] border-[3px] border-primary shadow-[0_0_0_9999px_rgb(15_20_30/0.3),0_0_0_6px_color-mix(in_oklch,var(--primary)_30%,transparent)]'
                : `rounded-[3px] border-2 border-annotation-comment bg-annotation-comment/10 ${anySelected ? 'opacity-35' : ''}`
            }
            style={{ ...boxStyle(rect, eased), pointerEvents: interactive ? 'auto' : 'none', cursor: interactive ? 'pointer' : undefined }}
          >
            <span className={`${badge} ${selected ? 'bg-primary' : 'bg-annotation-comment'}`}>{r.n}</span>
          </div>
        );
      })}
      {pending && (() => {
        const rect = naturalBoxToStage(view, pending.box);
        return (
          <div ref={pendingRef} data-region-pending="" aria-hidden="true" className="rounded-[3px] border-2 border-primary bg-primary/[0.07]" style={boxStyle(rect, eased)}>
            <span className={`${badge} bg-primary`}>{pending.n}</span>
          </div>
        );
      })()}
      {draft && (() => {
        const rect = naturalBoxToStage(view, draft);
        const below = rect.top + rect.height + 30 <= stage.height;
        return (
          <>
            <div data-region-draft="" aria-hidden="true" className="rounded-[3px] border-2 border-dashed border-primary bg-primary/[0.07]" style={boxStyle(rect, false)} />
            <div
              data-region-size=""
              aria-hidden="true"
              className="absolute whitespace-nowrap rounded-[5px] bg-[rgb(28_32_42/0.88)] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-white"
              style={{
                left: Math.max(4, rect.left + rect.width - 2),
                top: below ? rect.top + rect.height + 8 : Math.max(4, rect.top - 26),
                transform: 'translateX(-100%)',
              }}
            >
              {draft.w} × {draft.h}
            </div>
          </>
        );
      })()}
    </div>
  );
};

/**
 * The Move | Region switch and the comment count (approval variant C):
 * floating over the image on a desktop, a bottom bar on a phone. The switch
 * is a radio group (arrows move between the two, as a segmented control);
 * the count opens the drawer of this image's region comments.
 */
export const RegionToolStrip: React.FC<{
  tool: 'move' | 'region';
  onToolChange: (tool: 'move' | 'region') => void;
  /** False on a read-only document: only the count shows. */
  canDraw: boolean;
  count: number;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  drawerId: string;
  phone: boolean;
  countRef?: React.Ref<HTMLButtonElement>;
}> = ({ tool, onToolChange, canDraw, count, drawerOpen, onToggleDrawer, drawerId, phone, countRef }) => {
  const moveRef = React.useRef<HTMLButtonElement>(null);
  const regionRef = React.useRef<HTMLButtonElement>(null);
  const seg = phone ? 'h-10 px-3.5 text-[13px]' : 'h-7 px-2.5 text-[12px]';
  const choose = (next: 'move' | 'region') => {
    onToolChange(next);
    (next === 'move' ? moveRef : regionRef).current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      choose(tool === 'move' ? 'region' : 'move');
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      choose(tool === 'move' ? 'region' : 'move');
    } else if (e.key === 'Home') {
      e.preventDefault();
      choose('move');
    } else if (e.key === 'End') {
      e.preventDefault();
      choose('region');
    }
  };
  const radio = (value: 'move' | 'region', label: string, icon: React.ReactNode, ref: React.Ref<HTMLButtonElement>) => {
    const on = tool === value;
    return (
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={on}
        tabIndex={on ? 0 : -1}
        data-region-tool={value}
        onClick={() => onToolChange(value)}
        className={`inline-flex items-center gap-1.5 rounded-[7px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${seg} ${
          on ? `bg-card shadow-[0_1px_2px_rgb(0_0_0/0.2)] ${value === 'region' ? 'text-primary' : 'text-foreground'}` : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {icon}
        {label}
      </button>
    );
  };
  return (
    <div
      data-region-strip=""
      className={`pointer-events-auto flex items-center gap-1.5 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-[0_10px_30px_-16px_rgb(0_0_0/0.45)]`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {canDraw && (
        <>
          <div
            role="radiogroup"
            aria-label="Image tool"
            onKeyDown={onKeyDown}
            className="inline-flex gap-0.5 rounded-[9px] border border-border/30 bg-muted/50 p-0.5"
          >
            {radio('move', 'Move', <HandIcon size={phone ? 17 : 15} />, moveRef)}
            {radio('region', 'Region', <RegionIcon size={phone ? 17 : 15} />, regionRef)}
          </div>
          <span className="h-5 w-px bg-border" aria-hidden="true" />
        </>
      )}
      <button
        ref={countRef}
        type="button"
        data-region-count=""
        aria-expanded={drawerOpen}
        aria-controls={drawerId}
        aria-label={`${count} ${count === 1 ? 'comment' : 'comments'} on this image`}
        onClick={onToggleDrawer}
        className={`inline-flex items-center gap-1.5 rounded-[7px] font-medium tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${seg} ${
          drawerOpen ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <ChatIcon size={phone ? 17 : 15} />
        {count}
      </button>
    </div>
  );
};

/** The annotations among `all` that are region comments on the image `src` (as written). */
export function useImageRegionAnnotations(all: readonly Annotation[], src: string | null | undefined): Annotation[] {
  return useMemo(() => {
    if (!src) return [];
    return all.filter((ann) => regionOf(ann)?.src === src).sort((a, b) => a.createdA - b.createdA);
  }, [all, src]);
}

/**
 * The document line an image is written on: its block's first line plus the
 * line breaks before `](src` in the block's text (a paragraph, a list item, a
 * table, a quote's own markdown). The block's first line when the reference
 * cannot be found; null when the block has no line.
 */
export function imageSourceLine(block: { content: string; startLine?: number }, src: string): number | null {
  if (typeof block.startLine !== 'number' || block.startLine < 1) return null;
  let at = imageReferenceIndex(block.content, src);
  if (at < 0) at = block.content.indexOf(src);
  if (at < 0) return block.startLine;
  return block.startLine + (block.content.slice(0, at).match(/\n/g)?.length ?? 0);
}

/**
 * Where the markdown image reference to `src` starts in `text` (`](src)`,
 * `](src "title")`, `](<src>)`), or -1. The src must be the whole reference:
 * `a.png` never matches `](data.png)` or `](a.png.bak)`.
 */
export function imageReferenceIndex(text: string, src: string): number {
  if (!src) return -1;
  for (const opener of [`](${src}`, `](<${src}>`]) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(opener, from);
      if (at < 0) break;
      const next = text.charAt(at + opener.length);
      if (next === ')' || /\s/.test(next)) return at;
      from = at + 1;
    }
  }
  return -1;
}
