import React, { useEffect, useLayoutEffect, useState } from 'react';
import type { DiffFileStatus } from '../types';
import type { ReviewImageData, ReviewImageSide } from '../utils/reviewImage';
import { stageLayout, type Size } from './image-diff/geometry';
import { useImageDiffSettings } from './image-diff/imageDiffSettings';
import { sidesFor, useImageSides, useNearViewport } from './image-diff/useImageSides';
import { SinglePane, StackedStage, type StageImage } from './image-diff/ImageStage';
import { computeDifferences, differencesSupported, type DifferenceMask } from './image-diff/differences';
import { describeImageError, imageCaption, sizeChange } from './image-diff/imageWords';

export interface ImageDiffPreviewProps {
  filePath: string;
  status: DiffFileStatus;
  snapshotId?: string;
  variant: 'single' | 'all-files';
  compact?: boolean;
  fallback: React.ReactNode;
  tooLargeFallback?: React.ReactNode;
  onHeightChange?: () => void;
}

const SIDE_GAP = 16;
const TWO_COLUMN_MIN = 480;

function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function useAccentColor(): string {
  const [color, setColor] = useState('rgb(59 130 246)');
  useEffect(() => {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    if (value) setColor(value);
  }, []);
  return color;
}

export const ImageDiffPreview: React.FC<ImageDiffPreviewProps> = ({
  filePath,
  status,
  snapshotId,
  variant,
  compact = false,
  fallback,
  tooLargeFallback,
  onHeightChange,
}) => {
  const sides = sidesFor(status);
  const [rootRef, visible] = useNearViewport();
  const { states, markDecodeError } = useImageSides({ snapshotId, filePath, status, visible });
  const [natural, setNatural] = useState<Partial<Record<ReviewImageSide, Size>>>({});
  const settings = useImageDiffSettings();
  const [position, setPosition] = useState(0.5);
  const [opacity, setOpacity] = useState(0.5);
  const [scroll, setScroll] = useState<{ left: number; top: number } | null>(null);
  const [mask, setMask] = useState<DifferenceMask | null>(null);
  const accent = useAccentColor();
  const contentRef = React.useRef<HTMLDivElement>(null);
  const width = useWidth(contentRef);

  const loaded = sides.flatMap((side) => (states[side].state === 'ok' ? [{ side, image: (states[side] as { image: ReviewImageData }).image }] : []));
  const errors = sides.flatMap((side) => (states[side].state === 'error' ? [{ side, error: (states[side] as { error: { reason: string; status: number } }).error }] : []));
  const before = loaded.find((s) => s.side === 'old')?.image;
  const after = loaded.find((s) => s.side === 'new')?.image;
  const sizeOf = (side: ReviewImageSide, image?: ReviewImageData): Size | null =>
    image?.width && image?.height ? { width: image.width, height: image.height } : natural[side] ?? null;
  const beforeSize = sizeOf('old', before);
  const afterSize = sizeOf('new', after);
  const unchanged = sides.length === 2 && !!before && !!after && before.digest === after.digest;
  const comparable = sides.length === 2 && !!before && !!after && !unchanged;
  const mode = comparable ? settings.mode : 'side';
  const maxHeight = variant === 'all-files' ? 480 : 640;
  const twoColumns = comparable && mode === 'side' && !compact && width >= TWO_COLUMN_MIN;
  const paneWidth = twoColumns ? Math.floor((width - SIDE_GAP) / 2) : width;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const sized = comparable ? !!beforeSize && !!afterSize : loaded.length > 0 && !!(beforeSize ?? afterSize);
  const layout = sized && width > 0
    ? stageLayout({
        old: unchanged ? null : beforeSize,
        new: afterSize ?? (unchanged ? beforeSize : null),
        available: { width: paneWidth, height: maxHeight },
        zoom: settings.zoom,
        dpr,
      })
    : null;
  const dimensionsDiffer = comparable && !!beforeSize && !!afterSize && (beforeSize.width !== afterSize.width || beforeSize.height !== afterSize.height);

  const wantDifferences = comparable && settings.differences && differencesSupported() && !!beforeSize && !!afterSize;
  const diffKey = `${snapshotId ?? ''}|${filePath}|${before?.digest ?? ''}|${after?.digest ?? ''}`;
  useEffect(() => {
    if (!wantDifferences || !before || !after || !beforeSize || !afterSize) {
      setMask(null);
      return;
    }
    let live = true;
    computeDifferences(diffKey, { url: before.url, size: beforeSize }, { url: after.url, size: afterSize }).then((result) => {
      if (live) setMask(result);
    });
    return () => {
      live = false;
    };
  }, [wantDifferences, diffKey]);

  let shown: 'preview' | 'fallback' | 'too-large' = snapshotId ? 'preview' : 'fallback';
  if (shown === 'preview' && errors.length === sides.length) {
    if (errors.every((e) => e.error.reason === 'not-image')) shown = 'fallback';
    else if (tooLargeFallback && errors.every((e) => e.error.reason === 'too-large' && !(e.error as { width?: number }).width)) shown = 'too-large';
  }

  const heightChangeRef = React.useRef(onHeightChange);
  heightChangeRef.current = onHeightChange;
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !heightChangeRef.current) return;
    let last = -1;
    const report = () => {
      const next = el.getBoundingClientRect().height;
      if (next !== last) {
        last = next;
        heightChangeRef.current?.();
      }
    };
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootRef, shown]);

  const stageImage = (side: ReviewImageSide, image: ReviewImageData, label: string): StageImage => ({
    url: image.url,
    alt: `${label}: ${filePath}`,
    size: (side === 'old' ? layout?.old : layout?.new) ?? layout?.stage ?? { width: 0, height: 0 },
    onNatural: image.width && image.height ? undefined : (size) => setNatural((prev) => (prev[side]?.width === size.width && prev[side]?.height === size.height ? prev : { ...prev, [side]: size })),
    onError: () => markDecodeError(side),
  });

  if (shown === 'fallback') return <>{fallback}</>;
  if (shown === 'too-large') return <>{tooLargeFallback}</>;

  const sideLabel = (side: ReviewImageSide) => (unchanged ? 'Image' : status === 'added' ? 'Added' : status === 'deleted' ? 'Deleted' : side === 'old' ? 'Before' : 'After');
  const reserve = layout ? undefined : { height: Math.min(maxHeight, 160) };

  const pane = (side: ReviewImageSide) => {
    const state = states[side];
    const image = state.state === 'ok' ? state.image : undefined;
    const label = sideLabel(side);
    return (
      <figure key={side} className="m-0 min-w-0" data-image-side={side}>
        {image && layout ? (
          <SinglePane
            image={stageImage(side, image, label)}
            side={side}
            layout={layout}
            box={(side === 'old' ? layout.old : layout.new) ?? layout.stage}
            maxHeight={maxHeight}
            mask={side === 'new' ? mask : null}
            maskColor={accent}
            onScrollPosition={twoColumns ? (left, top) => setScroll({ left, top }) : undefined}
            scrollTo={twoColumns ? scroll : null}
          />
        ) : image ? (
          <img
            src={image.url}
            alt={`${label}: ${filePath}`}
            draggable={false}
            data-image-layer={side}
            className="block max-h-40 max-w-full"
            onLoad={(event) => {
              const el = event.currentTarget;
              setNatural((prev) => (prev[side] ? prev : { ...prev, [side]: { width: el.naturalWidth || 300, height: el.naturalHeight || 150 } }));
            }}
            onError={() => markDecodeError(side)}
          />
        ) : state.state === 'error' ? (
          <p className="py-6 text-xs text-muted-foreground" data-image-error={state.error.reason}>
            {label}: {describeImageError(state.error)}
          </p>
        ) : (
          <div className="animate-pulse rounded-sm bg-muted/50 motion-reduce:animate-none" style={reserve ?? { height: Math.min(maxHeight, 160) }} aria-label="Loading image" />
        )}
        <figcaption className="mt-1 text-xs leading-5 text-muted-foreground tabular-nums">
          {image ? imageCaption(label, sizeOf(side, image), image.bytes) : label}
          {image && side === 'new' && comparable && before && (
            <span data-image-delta="" className="ml-1">{sizeChange(beforeSize, afterSize, before.bytes, image.bytes)}</span>
          )}
        </figcaption>
      </figure>
    );
  };

  const stacked = comparable && (mode === 'swipe' || mode === 'onion') && before && after && layout;

  return (
    <div ref={rootRef} data-image-diff-preview="" data-image-diff-mode={comparable ? mode : 'single'} className="relative border-b border-border px-4 py-3">
      <div ref={contentRef} className="min-w-0">
        {stacked ? (
          <>
            <StackedStage
              mode={mode as 'swipe' | 'onion'}
              before={stageImage('old', before!, 'Before')}
              after={stageImage('new', after!, 'After')}
              layout={layout!}
              maxHeight={maxHeight}
              position={position}
              onPosition={setPosition}
              opacity={opacity}
              mask={mask}
              maskColor={accent}
            />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5 text-muted-foreground tabular-nums">
              <span>{imageCaption('Before', beforeSize, before!.bytes)}</span>
              {mode === 'onion' && (
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(opacity * 100)}
                  onChange={(event) => setOpacity(Number(event.target.value) / 100)}
                  aria-label="After opacity"
                  data-onion-opacity=""
                  className="h-1 w-32 accent-[var(--primary)]"
                />
              )}
              <span>
                {imageCaption('After', afterSize, after!.bytes)}
                <span data-image-delta="" className="ml-1">{sizeChange(beforeSize, afterSize, before!.bytes, after!.bytes)}</span>
              </span>
            </div>
          </>
        ) : (
          <div
            className="grid"
            style={{ gridTemplateColumns: twoColumns ? `${paneWidth}px ${paneWidth}px` : 'minmax(0, 1fr)', columnGap: SIDE_GAP, rowGap: 12 }}
          >
            {(unchanged ? (['new'] as ReviewImageSide[]) : sides).map(pane)}
          </div>
        )}
        {(dimensionsDiffer && mode !== 'side') || unchanged || (mask && comparable) ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground" data-image-note="" data-image-unchanged={unchanged ? '' : undefined}>
            {[
              unchanged && 'Contents unchanged',
              dimensionsDiffer && mode !== 'side' && 'Sizes differ: both aligned top left, not stretched',
              mask && comparable && `${((mask.changed / mask.total) * 100).toFixed(mask.changed / mask.total < 0.01 ? 2 : 1)}% of pixels differ`,
            ].filter(Boolean).join(' · ')}
          </p>
        ) : null}
      </div>
    </div>
  );
};
