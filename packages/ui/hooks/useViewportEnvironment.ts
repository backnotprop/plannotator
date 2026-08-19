import { useEffect, useMemo, useSyncExternalStore } from 'react';

export interface VisualViewportSnapshot {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  scale: number;
}

export interface ViewportEnvironmentInput {
  layoutWidth: number;
  layoutHeight: number;
  visualViewport?: VisualViewportSnapshot | null;
}

export interface ViewportEnvironment {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  keyboardInset: number;
}

export interface ViewportEdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface VisibleViewportBounds {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

const ZERO_ENVIRONMENT: ViewportEnvironment = {
  width: 0,
  height: 0,
  offsetTop: 0,
  offsetLeft: 0,
  keyboardInset: 0,
};

const ZERO_INSETS: ViewportEdgeInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

const VIEWPORT_PROPERTIES = [
  '--pn-viewport-width',
  '--pn-viewport-height',
  '--pn-viewport-offset-top',
  '--pn-viewport-offset-left',
  '--pn-keyboard-inset',
] as const;

type ViewportProperty = (typeof VIEWPORT_PROPERTIES)[number];

let subscriberCount = 0;
let stopObserving: (() => void) | null = null;
let currentEnvironment: ViewportEnvironment | null = null;
const environmentListeners = new Set<() => void>();

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number, fallback: number): number {
  const finite = finiteOr(value, fallback);
  return finite > 0 ? finite : fallback;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Converts the visual viewport into application-stage geometry. Pinch zoom is
 * intentionally represented by offsets only: reshaping the app while a user
 * zooms and pans would fight accessibility zoom. At the normal scale, browser
 * chrome and the software keyboard are allowed to reduce the usable stage.
 */
export function calculateViewportEnvironment({
  layoutWidth,
  layoutHeight,
  visualViewport,
}: ViewportEnvironmentInput): ViewportEnvironment {
  const safeLayoutWidth = Math.max(0, finiteOr(layoutWidth, 0));
  const safeLayoutHeight = Math.max(0, finiteOr(layoutHeight, 0));

  if (!visualViewport) {
    return {
      width: rounded(safeLayoutWidth),
      height: rounded(safeLayoutHeight),
      offsetTop: 0,
      offsetLeft: 0,
      keyboardInset: 0,
    };
  }

  const scale = positiveOr(visualViewport.scale, 1);
  const offsetTop = Math.max(0, finiteOr(visualViewport.offsetTop, 0));
  const offsetLeft = Math.max(0, finiteOr(visualViewport.offsetLeft, 0));
  const isPinchZoomed = Math.abs(scale - 1) > 0.01;
  if (isPinchZoomed) {
    return {
      width: rounded(safeLayoutWidth),
      height: rounded(safeLayoutHeight),
      offsetTop: rounded(offsetTop),
      offsetLeft: rounded(offsetLeft),
      keyboardInset: 0,
    };
  }

  const scaledWidth = positiveOr(visualViewport.width, safeLayoutWidth);
  const scaledHeight = positiveOr(visualViewport.height, safeLayoutHeight);
  const availableWidth = Math.max(0, safeLayoutWidth - offsetLeft);
  const availableHeight = Math.max(0, safeLayoutHeight - offsetTop);
  const width = safeLayoutWidth > 0 ? Math.min(scaledWidth, availableWidth) : scaledWidth;
  const height = safeLayoutHeight > 0 ? Math.min(scaledHeight, availableHeight) : scaledHeight;

  return {
    width: rounded(Math.max(0, width)),
    height: rounded(Math.max(0, height)),
    offsetTop: rounded(offsetTop),
    offsetLeft: rounded(offsetLeft),
    keyboardInset: rounded(Math.max(0, safeLayoutHeight - offsetTop - height)),
  };
}

/**
 * Converts the observed viewport into usable fixed-position bounds. Padding
 * and safe-area insets are inputs so positioning remains deterministic and
 * testable instead of reading CSS environment variables in every overlay.
 */
export function calculateVisibleViewportBounds(
  environment: ViewportEnvironment,
  edgePadding = 0,
  insets: Partial<ViewportEdgeInsets> = ZERO_INSETS,
): VisibleViewportBounds {
  const padding = Math.max(0, finiteOr(edgePadding, 0));
  const safeInsets = {
    top: Math.max(0, finiteOr(insets.top ?? 0, 0)),
    right: Math.max(0, finiteOr(insets.right ?? 0, 0)),
    bottom: Math.max(0, finiteOr(insets.bottom ?? 0, 0)),
    left: Math.max(0, finiteOr(insets.left ?? 0, 0)),
  };
  const left = environment.offsetLeft + padding + safeInsets.left;
  const top = environment.offsetTop + padding + safeInsets.top;
  const right = Math.max(
    left,
    environment.offsetLeft + environment.width - padding - safeInsets.right,
  );
  const bottom = Math.max(
    top,
    environment.offsetTop + environment.height - padding - safeInsets.bottom,
  );

  return {
    top: rounded(top),
    right: rounded(right),
    bottom: rounded(bottom),
    left: rounded(left),
    width: rounded(Math.max(0, right - left)),
    height: rounded(Math.max(0, bottom - top)),
  };
}

export function shouldUseExpandedComposer({
  bounds,
  coarsePointer,
}: {
  bounds: VisibleViewportBounds;
  coarsePointer: boolean;
}): boolean {
  return coarsePointer || bounds.width < 640 || bounds.height < 420;
}

/** Returns whether the device's primary pointing input is coarse. */
export function hasPrimaryCoarsePointer(targetWindow?: Window): boolean {
  const resolvedWindow = targetWindow ?? (typeof window === 'undefined' ? undefined : window);
  if (!resolvedWindow?.matchMedia) return false;
  return resolvedWindow.matchMedia('(pointer: coarse)').matches;
}

function readViewportEnvironment(targetWindow: Window): ViewportEnvironment {
  const visualViewport = targetWindow.visualViewport;
  return calculateViewportEnvironment({
    layoutWidth: targetWindow.innerWidth,
    layoutHeight: targetWindow.innerHeight,
    visualViewport: visualViewport
      ? {
          width: visualViewport.width,
          height: visualViewport.height,
          offsetTop: visualViewport.offsetTop,
          offsetLeft: visualViewport.offsetLeft,
          scale: visualViewport.scale,
        }
      : null,
  });
}

function environmentsEqual(
  left: ViewportEnvironment | null,
  right: ViewportEnvironment,
): boolean {
  return !!left
    && left.width === right.width
    && left.height === right.height
    && left.offsetTop === right.offsetTop
    && left.offsetLeft === right.offsetLeft
    && left.keyboardInset === right.keyboardInset;
}

function getViewportEnvironmentSnapshot(): ViewportEnvironment {
  if (currentEnvironment) return currentEnvironment;
  if (typeof window === 'undefined') return ZERO_ENVIRONMENT;
  currentEnvironment = readViewportEnvironment(window);
  return currentEnvironment;
}

function cssValues(environment: ViewportEnvironment): Record<ViewportProperty, string> {
  return {
    '--pn-viewport-width': `${environment.width}px`,
    '--pn-viewport-height': `${environment.height}px`,
    '--pn-viewport-offset-top': `${environment.offsetTop}px`,
    '--pn-viewport-offset-left': `${environment.offsetLeft}px`,
    '--pn-keyboard-inset': `${environment.keyboardInset}px`,
  };
}

function startViewportEnvironmentObserver(
  targetWindow: Window,
  targetDocument: Document,
): () => void {
  const rootStyle = targetDocument.documentElement.style;
  const previousValues = new Map<ViewportProperty, string>();
  const writtenValues = new Map<ViewportProperty, string>();
  for (const property of VIEWPORT_PROPERTIES) {
    previousValues.set(property, rootStyle.getPropertyValue(property));
  }

  let animationFrame: number | null = null;

  const write = () => {
    animationFrame = null;
    const nextEnvironment = readViewportEnvironment(targetWindow);
    const changed = !environmentsEqual(currentEnvironment, nextEnvironment);
    currentEnvironment = nextEnvironment;
    const nextValues = cssValues(nextEnvironment);
    for (const property of VIEWPORT_PROPERTIES) {
      const nextValue = nextValues[property];
      if (writtenValues.get(property) === nextValue) continue;
      rootStyle.setProperty(property, nextValue);
      writtenValues.set(property, nextValue);
    }
    if (changed) environmentListeners.forEach(listener => listener());
  };

  const scheduleWrite = () => {
    if (animationFrame !== null) return;
    animationFrame = targetWindow.requestAnimationFrame(write);
  };

  const visualViewport = targetWindow.visualViewport;
  targetWindow.addEventListener('resize', scheduleWrite);
  targetWindow.addEventListener('orientationchange', scheduleWrite);
  targetWindow.addEventListener('pageshow', scheduleWrite);
  targetDocument.addEventListener('visibilitychange', scheduleWrite);
  visualViewport?.addEventListener('resize', scheduleWrite);
  visualViewport?.addEventListener('scroll', scheduleWrite);
  write();

  return () => {
    targetWindow.removeEventListener('resize', scheduleWrite);
    targetWindow.removeEventListener('orientationchange', scheduleWrite);
    targetWindow.removeEventListener('pageshow', scheduleWrite);
    targetDocument.removeEventListener('visibilitychange', scheduleWrite);
    visualViewport?.removeEventListener('resize', scheduleWrite);
    visualViewport?.removeEventListener('scroll', scheduleWrite);
    if (animationFrame !== null) targetWindow.cancelAnimationFrame(animationFrame);

    for (const property of VIEWPORT_PROPERTIES) {
      const previousValue = previousValues.get(property) ?? '';
      if (previousValue) rootStyle.setProperty(property, previousValue);
      else rootStyle.removeProperty(property);
    }
  };
}

function acquireViewportEnvironment(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  subscriberCount += 1;
  if (subscriberCount === 1) {
    stopObserving = startViewportEnvironmentObserver(window, document);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount !== 0) return;
    stopObserving?.();
    stopObserving = null;
    currentEnvironment = null;
  };
}

function subscribeViewportEnvironment(listener: () => void): () => void {
  environmentListeners.add(listener);
  const release = acquireViewportEnvironment();
  return () => {
    environmentListeners.delete(listener);
    release();
  };
}

/**
 * Keeps Plannotator's shared viewport CSS properties synchronized without
 * putting high-frequency browser geometry into React state.
 */
export function useViewportEnvironment(): void {
  useEffect(() => acquireViewportEnvironment(), []);
}

/**
 * Reactive bounds for fixed overlays. It shares the root observer and its
 * animation-frame coalescing, so composer consumers do not add parallel
 * Visual Viewport listeners.
 */
export function useVisibleViewportBounds(edgePadding = 0): VisibleViewportBounds {
  const environment = useSyncExternalStore(
    subscribeViewportEnvironment,
    getViewportEnvironmentSnapshot,
    () => ZERO_ENVIRONMENT,
  );
  return useMemo(
    () => calculateVisibleViewportBounds(environment, edgePadding),
    [edgePadding, environment],
  );
}
