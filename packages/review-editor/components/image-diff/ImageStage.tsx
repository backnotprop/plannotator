import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { stepSwipe, swipeClipX, type Size, type StageLayout } from './geometry';
import type { DifferenceMask } from './differences';
import { useImageDiffSettings, type ImageBackground } from './imageDiffSettings';

export const CHECKERBOARD: React.CSSProperties = {
  backgroundImage: 'repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%)',
  backgroundSize: '16px 16px',
};

export const IMAGE_BACKGROUND_STYLE: Record<ImageBackground, React.CSSProperties> = {
  checker: CHECKERBOARD,
  light: { backgroundColor: '#ffffff' },
  dark: { backgroundColor: '#111111' },
};

export interface StageImage {
  url: string;
  alt: string;
  size: Size;
  onNatural?: (size: Size) => void;
  onError?: () => void;
}

function ImageLayer({ image, box, pixelated, style, side }: { image: StageImage; box: Size; pixelated: boolean; style?: React.CSSProperties; side: 'old' | 'new' }) {
  const { background } = useImageDiffSettings();
  return (
    <img
      src={image.url}
      alt={image.alt}
      draggable={false}
      decoding="async"
      data-image-layer={side}
      data-image-background={background}
      className="absolute left-0 top-0 block max-w-none select-none"
      style={{ ...IMAGE_BACKGROUND_STYLE[background], width: box.width, height: box.height, imageRendering: pixelated ? 'pixelated' : 'auto', ...style }}
      onLoad={(event) => {
        const el = event.currentTarget;
        if (el.naturalWidth && el.naturalHeight) image.onNatural?.({ width: el.naturalWidth, height: el.naturalHeight });
      }}
      onError={image.onError}
    />
  );
}

export function StageLabel({ children, side }: { children: React.ReactNode; side: 'left' | 'right' }) {
  return (
    <span
      data-stage-label={side}
      className={`pointer-events-none absolute top-2 z-10 rounded bg-black/70 px-1.5 text-xs leading-5 text-white ${side === 'left' ? 'left-2' : 'right-2'}`}
    >
      {children}
    </span>
  );
}

export function StageLabelRow({ left, right, width, offset = 0 }: { left: string; right?: string; width?: number; offset?: number }) {
  return (
    <div className="mb-1 flex justify-between gap-3 text-xs leading-5 text-muted-foreground" style={{ width: width === undefined ? undefined : Math.max(width, 96), marginLeft: offset }} data-stage-labels-above="">
      <span data-stage-label="left">{left}</span>
      {right && <span data-stage-label="right">{right}</span>}
    </div>
  );
}

export function DifferenceOverlay({ mask, stage, color }: { mask: DifferenceMask; stage: Size; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(stage.width * dpr));
    canvas.height = Math.max(1, Math.round(stage.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(mask.mask, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
  }, [mask, stage.width, stage.height, color]);
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-image-differences=""
      className="pointer-events-none absolute left-0 top-0 opacity-60"
      style={{ width: stage.width, height: stage.height }}
    />
  );
}

export function deviceNudge(position: number, dpr: number): number {
  const device = position * dpr;
  const frac = device - Math.floor(device);
  return frac < 1e-3 ? 0 : (1 - frac) / dpr;
}

function useDevicePixelNudge(ref: React.RefObject<HTMLDivElement | null>): { x: number; y: number } {
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = el.getBoundingClientRect();
      const x = deviceNudge(rect.left, dpr);
      const y = deviceNudge(rect.top, dpr);
      setNudge((prev) => (Math.abs(prev.x - x) < 1e-4 && Math.abs(prev.y - y) < 1e-4 ? prev : { x, y }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, [ref]);
  return nudge;
}

function Viewport({ layout, maxHeight, children, onScrollPosition, scrollTo }: {
  layout: StageLayout;
  maxHeight: number;
  children: React.ReactNode;
  onScrollPosition?: (left: number, top: number) => void;
  scrollTo?: { left: number; top: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollTo || !ref.current) return;
    if (ref.current.scrollLeft !== scrollTo.left) ref.current.scrollLeft = scrollTo.left;
    if (ref.current.scrollTop !== scrollTo.top) ref.current.scrollTop = scrollTo.top;
  }, [scrollTo]);
  const nudge = useDevicePixelNudge(ref);
  const scrolls = layout.stage.height > maxHeight;
  return (
    <div
      ref={ref}
      data-image-viewport=""
      className="relative max-w-full overflow-auto overscroll-contain"
      style={{ maxHeight: scrolls ? maxHeight : undefined, paddingLeft: layout.offsetX + nudge.x, paddingTop: nudge.y }}
      onScroll={onScrollPosition ? (event) => onScrollPosition(event.currentTarget.scrollLeft, event.currentTarget.scrollTop) : undefined}
    >
      {children}
    </div>
  );
}

export function SinglePane(props: {
  image: StageImage;
  side: 'old' | 'new';
  layout: StageLayout;
  box: Size;
  maxHeight: number;
  mask?: DifferenceMask | null;
  maskColor: string;
  label?: string;
  labelAbove?: boolean;
  onScrollPosition?: (left: number, top: number) => void;
  scrollTo?: { left: number; top: number } | null;
}) {
  const { layout } = props;
  return (
    <>
    {props.label && props.labelAbove && <StageLabelRow left={props.label} />}
    <Viewport layout={layout} maxHeight={props.maxHeight} onScrollPosition={props.onScrollPosition} scrollTo={props.scrollTo}>
      <div data-image-stage="" className="relative" style={{ width: layout.stage.width, height: layout.stage.height }}>
        <ImageLayer image={props.image} box={props.box} pixelated={layout.pixelated} side={props.side} />
        {props.mask && <DifferenceOverlay mask={props.mask} stage={layout.stage} color={props.maskColor} />}
        {props.label && !props.labelAbove && <StageLabel side="left">{props.label}</StageLabel>}
      </div>
    </Viewport>
    </>
  );
}

export function StackedStage(props: {
  mode: 'swipe' | 'onion';
  before: StageImage;
  after: StageImage;
  layout: StageLayout;
  maxHeight: number;
  position: number;
  onPosition: (position: number) => void;
  opacity: number;
  mask?: DifferenceMask | null;
  maskColor: string;
  labelsAbove?: boolean;
}) {
  const { layout, mode } = props;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const clipX = swipeClipX(props.position, layout.stage.width, dpr);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const positionAt = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    props.onPosition(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };
  const swipe = mode === 'swipe';
  const overlayLabels = swipe && !props.labelsAbove;
  return (
    <>
    {swipe && props.labelsAbove && <StageLabelRow left="Before" right="After" width={layout.stage.width} offset={layout.offsetX} />}
    <Viewport layout={layout} maxHeight={props.maxHeight}>
      <div
        ref={stageRef}
        data-image-stage=""
        data-image-mode={mode}
        className={`relative ${swipe ? 'cursor-ew-resize touch-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-primary' : ''}`}
        style={{ width: layout.stage.width, height: layout.stage.height }}
        {...(swipe
          ? {
              role: 'slider',
              tabIndex: 0,
              'aria-label': 'Swipe between before and after',
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(props.position * 100),
              'aria-valuetext': `${Math.round(props.position * 100)}% before`,
              onKeyDown: (event: React.KeyboardEvent) => {
                const next = stepSwipe(props.position, event.key, event.shiftKey);
                if (next === null) return;
                event.preventDefault();
                event.stopPropagation();
                props.onPosition(next);
              },
              onPointerDown: (event: React.PointerEvent) => {
                dragging.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                positionAt(event.clientX);
              },
              onPointerMove: (event: React.PointerEvent) => {
                if (dragging.current) positionAt(event.clientX);
              },
              onPointerUp: () => {
                dragging.current = false;
              },
              onPointerCancel: () => {
                dragging.current = false;
              },
            }
          : {})}
      >
        <ImageLayer
          image={props.before}
          box={props.before.size}
          pixelated={layout.pixelated}
          side="old"
          style={swipe ? { clipPath: `inset(0 ${Math.max(0, props.before.size.width - clipX)}px 0 0)` } : undefined}
        />
        <ImageLayer
          image={props.after}
          box={props.after.size}
          pixelated={layout.pixelated}
          side="new"
          style={swipe ? { clipPath: `inset(0 0 0 ${clipX}px)` } : { opacity: props.opacity }}
        />
        {props.mask && <DifferenceOverlay mask={props.mask} stage={layout.stage} color={props.maskColor} />}
        {overlayLabels && <StageLabel side="left">Before</StageLabel>}
        {overlayLabels && <StageLabel side="right">After</StageLabel>}
        {swipe && (
          <div aria-hidden="true" data-swipe-divider="" className="pointer-events-none absolute top-0 bottom-0" style={{ left: clipX }}>
            <div className="absolute inset-y-0 -left-px w-0.5 bg-primary" />
            {layout.stage.width >= 96 && (
              <div className="absolute top-1/2 -left-3 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />
                </svg>
              </div>
            )}
          </div>
        )}
      </div>
    </Viewport>
    </>
  );
}
