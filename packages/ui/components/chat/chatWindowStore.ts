/**
 * The floating chat window's own state: minimized, fullscreen, size and the
 * docked or floating position. A plain external store that knows nothing about
 * conversations or the server, so ChatFrame can render from it alone.
 *
 * Geometry: default 420x560, min 360x420, max the frame it floats in minus
 * margins, anchored by its bottom-right offsets so the top-left resize grip
 * grows the window without moving its anchor.
 *
 * Saved geometry belongs to the host. A saved value comes in through
 * `initialGeometry` (or `restore`), every change goes out through
 * `onGeometryChange`, and this module never reads or writes storage itself.
 * Minimized and fullscreen are runtime state: a page load starts minimized.
 */

export const CHAT_WINDOW_DEFAULT = { width: 420, height: 560, right: 16, bottom: 16 } as const;
export const CHAT_WINDOW_MIN = { width: 360, height: 420 } as const;
/** Margin the window keeps from its frame at maximum size. */
export const CHAT_WINDOW_FRAME_MARGIN = 16;

/** The shape a host saves and hands back. */
export interface ChatWindowGeometry {
  readonly w: number;
  readonly h: number;
  readonly right: number;
  readonly bottom: number;
}

/** Clamp a saved dimension into [min, max]; anything non-finite falls back. */
function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function viewportLength(length: number | undefined, fallback: number): number {
  return length !== undefined && Number.isFinite(length) && length > 0 ? length : fallback;
}

/**
 * A saved geometry, clamped to the current viewport: a window sized or parked
 * on a big monitor reopens sane on a laptop. The frame re-clamps against its
 * measured box once it mounts, so this only has to keep the value on screen.
 * Takes `unknown` because a saved value can be corrupted.
 */
function clampSavedGeometry(saved: unknown): ChatWindowGeometry {
  const raw = (typeof saved === 'object' && saved !== null ? saved : {}) as Record<string, unknown>;
  const view = typeof window === 'undefined' ? undefined : window;
  const viewportW = viewportLength(view?.innerWidth, CHAT_WINDOW_DEFAULT.width + CHAT_WINDOW_FRAME_MARGIN * 2);
  const viewportH = viewportLength(view?.innerHeight, CHAT_WINDOW_DEFAULT.height + CHAT_WINDOW_FRAME_MARGIN * 2);
  const maxW = Math.max(CHAT_WINDOW_MIN.width, viewportW - CHAT_WINDOW_FRAME_MARGIN * 2);
  const maxH = Math.max(CHAT_WINDOW_MIN.height, viewportH - CHAT_WINDOW_FRAME_MARGIN * 2);
  const w = clampDimension(raw.w, CHAT_WINDOW_MIN.width, maxW, CHAT_WINDOW_DEFAULT.width);
  const h = clampDimension(raw.h, CHAT_WINDOW_MIN.height, maxH, CHAT_WINDOW_DEFAULT.height);
  return {
    w,
    h,
    right: clampDimension(raw.right, 0, Math.max(0, viewportW - w), CHAT_WINDOW_DEFAULT.right),
    bottom: clampDimension(raw.bottom, 0, Math.max(0, viewportH - h), CHAT_WINDOW_DEFAULT.bottom),
  };
}

export interface ChatWindowStoreOptions {
  /** The host's saved geometry, clamped on the way in. Absent: the default dock. */
  readonly initialGeometry?: unknown;
  /** Runs on every geometry change, drag and resize steps included, so a host
   * that saves it should debounce. Not called for `initialGeometry` or `restore`. */
  readonly onGeometryChange?: (geometry: ChatWindowGeometry) => void;
  /** Runs on every `setMinimized(false)`, before listeners hear of it. */
  readonly onOpen?: () => void;
}

export class ChatWindowStore {
  minimized = true;
  fullscreen = false;
  winW: number = CHAT_WINDOW_DEFAULT.width;
  winH: number = CHAT_WINDOW_DEFAULT.height;
  winRight: number = CHAT_WINDOW_DEFAULT.right;
  winBottom: number = CHAT_WINDOW_DEFAULT.bottom;
  /** True once this window opened in this page's lifetime. */
  openedOnce = false;

  private readonly onOpen: (() => void) | null;
  private readonly onGeometryChange: ((geometry: ChatWindowGeometry) => void) | null;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(options: ChatWindowStoreOptions = {}) {
    this.onOpen = options.onOpen ?? null;
    this.onGeometryChange = options.onGeometryChange ?? null;
    if (options.initialGeometry !== undefined) this.restore(options.initialGeometry);
  }

  // The useSyncExternalStore seam.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = (): number => this.version;
  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** Every geometry write ends here: an unchanged value reports nothing. */
  private commitGeometry(next: ChatWindowGeometry): void {
    if (
      next.w === this.winW &&
      next.h === this.winH &&
      next.right === this.winRight &&
      next.bottom === this.winBottom
    ) {
      return;
    }
    this.winW = next.w;
    this.winH = next.h;
    this.winRight = next.right;
    this.winBottom = next.bottom;
    this.emit();
    this.onGeometryChange?.(next);
  }

  /** Take a saved geometry, clamped. No emit and no report: the value is the host's own. */
  restore(saved: unknown): void {
    const restored = clampSavedGeometry(saved);
    this.winW = restored.w;
    this.winH = restored.h;
    this.winRight = restored.right;
    this.winBottom = restored.bottom;
  }

  /** The current geometry, in the shape `initialGeometry` takes back. */
  geometry(): ChatWindowGeometry {
    return { w: this.winW, h: this.winH, right: this.winRight, bottom: this.winBottom };
  }

  setMinimized(minimized: boolean): void {
    this.minimized = minimized;
    if (!minimized) {
      this.openedOnce = true;
      this.onOpen?.();
    }
    this.emit();
  }

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    if (this.minimized) this.minimized = false;
    this.emit();
  }

  /** Committed by the resize grip, already clamped against the frame. */
  setWindowSize(width: number, height: number): void {
    this.commitGeometry({ ...this.geometry(), w: Math.round(width), h: Math.round(height) });
  }

  /** Committed by the header drag: the bottom-right offsets within the frame. */
  setWindowOffsets(right: number, bottom: number): void {
    this.commitGeometry({ ...this.geometry(), right: Math.round(right), bottom: Math.round(bottom) });
  }

  /** Double-click on the header: back to the default bottom-right dock. */
  resetWindowDock(): void {
    this.commitGeometry({
      ...this.geometry(),
      right: CHAT_WINDOW_DEFAULT.right,
      bottom: CHAT_WINDOW_DEFAULT.bottom,
    });
  }

  /** Re-clamp against the measured frame, on mount and whenever the frame
   * shrinks, so the floating window never strands off the visible frame. */
  clampToFrame(frameWidth: number, frameHeight: number): void {
    if (frameWidth <= 0 || frameHeight <= 0) return;
    const w = Math.min(
      this.winW,
      Math.max(CHAT_WINDOW_MIN.width, frameWidth - CHAT_WINDOW_FRAME_MARGIN * 2),
    );
    const h = Math.min(
      this.winH,
      Math.max(CHAT_WINDOW_MIN.height, frameHeight - CHAT_WINDOW_FRAME_MARGIN * 2),
    );
    this.commitGeometry({
      w,
      h,
      right: Math.max(0, Math.min(this.winRight, frameWidth - w)),
      bottom: Math.max(0, Math.min(this.winBottom, frameHeight - h)),
    });
  }
}
