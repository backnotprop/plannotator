import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAX_REVIEW_IMAGE_PREVIEW_LABEL } from '@plannotator/shared/diff-paths';
import type { DiffFileStatus } from '../types';
import {
  fetchReviewImage,
  formatImageBytes,
  peekReviewImage,
  type ReviewImageData,
  type ReviewImageError,
  type ReviewImageSide,
} from '../utils/reviewImage';

/**
 * Before / After preview for a changed image in code review (#1598).
 *
 * Replaces the "Binary or oversized file" notice for a hunkless chunk whose
 * path is an image, when the server advertises `imagePreviewSupported`. It
 * fetches only the sides that exist (After for an addition, Before for a
 * deletion), only while mounted — the all-files view mounts header slots for
 * the virtual window only — and aborts on unmount. When the server cannot show
 * the file as an image at all, `fallback` (the plain notice) renders instead.
 */

type SideState =
  | { state: 'loading' }
  | { state: 'ok'; image: ReviewImageData }
  | { state: 'error'; error: ReviewImageError };

export interface ImageDiffPreviewProps {
  filePath: string;
  status: DiffFileStatus;
  snapshotId?: string;
  /** `all-files` reserves a fixed pane height so the virtualized item is
   *  measured once rather than again when the image decodes. */
  variant: 'single' | 'all-files';
  compact?: boolean;
  /** The plain notice, shown when neither side is a displayable image. */
  fallback: React.ReactNode;
  /** Shown instead of `fallback` when every side is over the byte cap. */
  tooLargeFallback?: React.ReactNode;
  /** Re-measure hook for the virtualized all-files host. */
  onHeightChange?: () => void;
}

const sidesFor = (status: DiffFileStatus): ReviewImageSide[] =>
  status === 'added' ? ['new'] : status === 'deleted' ? ['old'] : ['old', 'new'];

function initialState(snapshotId: string | undefined, path: string, side: ReviewImageSide): SideState {
  const cached = snapshotId ? peekReviewImage(snapshotId, path, side) : undefined;
  return cached ? { state: 'ok', image: cached } : { state: 'loading' };
}

function describeError(error: ReviewImageError): string {
  switch (error.reason) {
    case 'lfs-pointer':
      return 'the file is stored in Git LFS';
    case 'not-image':
      return 'not a recognized image format';
    case 'decode':
      return 'the image could not be decoded';
    case 'too-large':
      if (error.width && error.height) return `${error.width} × ${error.height} px is over the preview limit`;
      return `larger than ${MAX_REVIEW_IMAGE_PREVIEW_LABEL}${error.bytes ? ` (${formatImageBytes(error.bytes)})` : ''}`;
    case 'missing':
      return 'the file could not be found at this version';
    case 'stale':
      return 'the diff changed; refresh the review';
    case 'network':
      return 'the server could not be reached';
    default:
      return 'the file could not be loaded';
  }
}

const CHECKERBOARD: React.CSSProperties = {
  backgroundImage: 'repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%)',
  backgroundSize: '16px 16px',
};

function signed(value: number, unit: string): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value)}${unit}`;
}

function signedBytes(delta: number): string {
  return `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${formatImageBytes(Math.abs(delta))}`;
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
  const [states, setStates] = useState<Record<ReviewImageSide, SideState>>(() => ({
    old: initialState(snapshotId, filePath, 'old'),
    new: initialState(snapshotId, filePath, 'new'),
  }));
  // Natural sizes the <img> reports, for formats without server dimensions (SVG).
  const [natural, setNatural] = useState<Partial<Record<ReviewImageSide, { width: number; height: number }>>>({});

  // Lazy: fetch only once the card is actually near the viewport. The
  // all-files view mounts header slots for its virtual window, and before
  // items are measured that window can briefly span dozens of cards.
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = rootRef.current;
    if (visible || !el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  const sidesKey = sides.join(',');
  useEffect(() => {
    if (!snapshotId || !visible) return;
    const controller = new AbortController();
    for (const side of sidesKey.split(',') as ReviewImageSide[]) {
      const cached = peekReviewImage(snapshotId, filePath, side);
      if (cached) {
        setStates((prev) => (prev[side].state === 'ok' ? prev : { ...prev, [side]: { state: 'ok', image: cached } }));
        continue;
      }
      setStates((prev) => ({ ...prev, [side]: { state: 'loading' } }));
      fetchReviewImage(snapshotId, filePath, side, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setStates((prev) => ({
            ...prev,
            [side]: result.ok ? { state: 'ok', image: result.image } : { state: 'error', error: result.error },
          }));
        })
        .catch(() => {
          // Aborted on unmount / snapshot change: nothing to update.
        });
    }
    return () => controller.abort();
  }, [snapshotId, filePath, sidesKey, visible]);

  const sideStates = sides.map((side) => ({ side, ...states[side] }));
  const loaded = sideStates.filter((s): s is { side: ReviewImageSide; state: 'ok'; image: ReviewImageData } => s.state === 'ok');
  const errors = sideStates.filter((s): s is { side: ReviewImageSide; state: 'error'; error: ReviewImageError } => s.state === 'error');

  const unchanged = sides.length === 2 && loaded.length === 2 && loaded[0].image.digest === loaded[1].image.digest;
  const dimsOf = (side: ReviewImageSide, image?: ReviewImageData) =>
    image?.width && image?.height ? { width: image.width, height: image.height } : natural[side];
  // Owner ruling: tall images (and narrow or compact layouts) stack Before
  // above After; stacked tall panes get more height, which is what makes the
  // stack worth it.
  const tall = loaded.some(({ side, image }) => {
    const d = dimsOf(side, image);
    return !!d && d.height > d.width * 1.2;
  });
  const shownSides = unchanged ? (['new'] as ReviewImageSide[]) : sides;
  const stacked = compact || (tall && shownSides.length === 2);
  const paneHeight = variant === 'all-files' ? (stacked && tall ? 480 : 360) : (stacked && tall ? 640 : 480);

  // Nothing displayable on any side: the plain notice explains it better than
  // a row of error lines would (a `.png` that is really a zip, say).
  let mode: 'preview' | 'fallback' | 'too-large' = snapshotId ? 'preview' : 'fallback';
  if (mode === 'preview' && errors.length === sides.length) {
    if (errors.every((e) => e.error.reason === 'not-image')) mode = 'fallback';
    else if (tooLargeFallback && errors.every((e) => e.error.reason === 'too-large' && !e.error.width)) {
      mode = 'too-large';
    }
  }

  // Re-measure the virtualized item whenever this block's own height changes
  // (layout flip, error line). Pane heights are fixed, so image decode alone
  // never changes it. The fallback notices re-measure themselves.
  const lastHeight = useRef<number>(-1);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeightChange) return;
    const report = () => {
      const height = el.getBoundingClientRect().height;
      if (height !== lastHeight.current) {
        lastHeight.current = height;
        onHeightChange();
      }
    };
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  if (mode === 'fallback') return <>{fallback}</>;
  if (mode === 'too-large') return <>{tooLargeFallback}</>;

  const before = loaded.find((s) => s.side === 'old')?.image;
  const after = loaded.find((s) => s.side === 'new')?.image;
  const beforeDims = dimsOf('old', before);
  const afterDims = dimsOf('new', after);

  const renderPane = (side: ReviewImageSide) => {
    const state = states[side];
    const image = state.state === 'ok' ? state.image : undefined;
    const dims = dimsOf(side, image);
    const label = unchanged ? 'Image' : side === 'old' ? 'Before' : 'After';
    const showDelta = !unchanged && side === 'new' && before && after;
    return (
      <figure key={side} className="m-0 min-w-0 flex flex-col gap-1.5" data-image-side={side}>
        <figcaption className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</figcaption>
        <div
          className="relative flex items-center justify-center overflow-hidden rounded border border-border bg-background/60 p-2"
          // All-files reserves the height up front (one measurement); the
          // single-file view sizes to the image, up to the same cap.
          style={variant === 'all-files' ? { height: paneHeight } : { minHeight: 120 }}
        >
          {state.state === 'loading' && (
            <div className="absolute inset-0 animate-pulse bg-muted/40" aria-label="Loading image" />
          )}
          {image && (
            <img
              src={image.url}
              alt={`${label}: ${filePath}`}
              draggable={false}
              className="max-h-full max-w-full object-contain"
              style={variant === 'all-files' ? CHECKERBOARD : { ...CHECKERBOARD, maxHeight: paneHeight - 18 }}
              onLoad={(event) => {
                const el = event.currentTarget;
                if (el.naturalWidth && el.naturalHeight) {
                  setNatural((prev) => ({ ...prev, [side]: { width: el.naturalWidth, height: el.naturalHeight } }));
                }
              }}
              onError={() =>
                setStates((prev) => ({ ...prev, [side]: { state: 'error', error: { status: 200, reason: 'decode' } } }))
              }
            />
          )}
          {state.state === 'error' && (
            <p className="px-4 text-center text-xs text-muted-foreground" data-image-error={state.error.reason}>
              Preview unavailable: {describeError(state.error)}
            </p>
          )}
        </div>
        <div className="min-h-[1rem] text-[11px] leading-4 text-muted-foreground tabular-nums">
          {image && (
            <>
              {dims ? `${dims.width} × ${dims.height} · ` : ''}
              {formatImageBytes(image.bytes)}
              {showDelta && (
                <span className="ml-2" data-image-delta="">
                  {beforeDims && afterDims && (beforeDims.width !== afterDims.width || beforeDims.height !== afterDims.height)
                    ? `(${signed(afterDims.width - beforeDims.width, '')} × ${signed(afterDims.height - beforeDims.height, ' px')}, `
                    : '('}
                  {signedBytes(after.bytes - before.bytes)})
                </span>
              )}
            </>
          )}
        </div>
      </figure>
    );
  };

  return (
    <div
      ref={rootRef}
      data-image-diff-preview=""
      className="border-b border-border bg-muted/30 px-4 py-3"
    >
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: stacked || shownSides.length === 1
            ? 'minmax(0, 1fr)'
            // Two columns while each gets at least 240px; narrower hosts wrap
            // to one column (Before above After) with no JS measurement.
            : 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
        }}
      >
        {shownSides.map(renderPane)}
      </div>
      {unchanged && (
        <p className="mt-2 text-xs text-muted-foreground" data-image-unchanged="">
          Contents unchanged.
        </p>
      )}
    </div>
  );
};
