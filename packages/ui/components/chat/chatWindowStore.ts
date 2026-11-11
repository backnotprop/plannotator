/** The floating chat window's own state: minimized, fullscreen, size and the docked or floating position. */

export const CHAT_WINDOW_DEFAULT = { width: 420, height: 560, right: 16, bottom: 16 } as const;
export const CHAT_WINDOW_MIN = { width: 360, height: 420 } as const;
export const CHAT_WINDOW_FRAME_MARGIN = 16;

/** The shape a host saves and hands back. */
export interface ChatWindowGeometry {
  readonly w: number;
  readonly h: number;
  readonly right: number;
  readonly bottom: number;
}

function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Takes `unknown` because a saved value can be corrupted. */
function parseSavedGeometry(saved: unknown): ChatWindowGeometry {
  const raw = (typeof saved === 'object' && saved !== null ? saved : {}) as Record<string, unknown>;
  const limit = Number.POSITIVE_INFINITY;
  return {
    w: clampDimension(raw.w, CHAT_WINDOW_MIN.width, limit, CHAT_WINDOW_DEFAULT.width),
    h: clampDimension(raw.h, CHAT_WINDOW_MIN.height, limit, CHAT_WINDOW_DEFAULT.height),
    right: clampDimension(raw.right, 0, limit, CHAT_WINDOW_DEFAULT.right),
    bottom: clampDimension(raw.bottom, 0, limit, CHAT_WINDOW_DEFAULT.bottom),
  };
}

/**
 * What a chosen geometry draws as in a measured frame: as large as the frame minus its margins,
 * never under the minimum, and never off the frame.
 */
export function fitChatWindow(
  wanted: ChatWindowGeometry,
  frame: { readonly width: number; readonly height: number },
): ChatWindowGeometry {
  const w = Math.min(wanted.w, Math.max(CHAT_WINDOW_MIN.width, frame.width - CHAT_WINDOW_FRAME_MARGIN * 2));
  const h = Math.min(wanted.h, Math.max(CHAT_WINDOW_MIN.height, frame.height - CHAT_WINDOW_FRAME_MARGIN * 2));
  return {
    w,
    h,
    right: Math.max(0, Math.min(wanted.right, frame.width - w)),
    bottom: Math.max(0, Math.min(wanted.bottom, frame.height - h)),
  };
}

export interface ChatWindowStoreOptions {
  readonly initialGeometry?: unknown;
  readonly onGeometryChange?: (geometry: ChatWindowGeometry) => void;
  readonly onOpen?: () => void;
}

export class ChatWindowStore {
  minimized = true;
  fullscreen = false;
  winW: number = CHAT_WINDOW_DEFAULT.width;
  winH: number = CHAT_WINDOW_DEFAULT.height;
  winRight: number = CHAT_WINDOW_DEFAULT.right;
  winBottom: number = CHAT_WINDOW_DEFAULT.bottom;
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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = (): number => this.version;
  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

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

  /** An open window redraws; no report, because the value is the host's own. */
  restore(saved: unknown): void {
    const restored = parseSavedGeometry(saved);
    this.winW = restored.w;
    this.winH = restored.h;
    this.winRight = restored.right;
    this.winBottom = restored.bottom;
    this.emit();
  }

  geometry(): ChatWindowGeometry {
    return { w: this.winW, h: this.winH, right: this.winRight, bottom: this.winBottom };
  }

  private open(): void {
    this.minimized = false;
    this.openedOnce = true;
    this.onOpen?.();
  }

  setMinimized(minimized: boolean): void {
    if (minimized) this.minimized = true;
    else this.open();
    this.emit();
  }

  toggleFullscreen(): void {
    if (this.minimized) {
      this.fullscreen = true;
      this.open();
    } else {
      this.fullscreen = !this.fullscreen;
    }
    this.emit();
  }

  setWindowSize(width: number, height: number): void {
    this.commitGeometry({ ...this.geometry(), w: Math.round(width), h: Math.round(height) });
  }

  setWindowOffsets(right: number, bottom: number): void {
    this.commitGeometry({ ...this.geometry(), right: Math.round(right), bottom: Math.round(bottom) });
  }

  resetWindowDock(): void {
    this.commitGeometry({
      ...this.geometry(),
      right: CHAT_WINDOW_DEFAULT.right,
      bottom: CHAT_WINDOW_DEFAULT.bottom,
    });
  }
}
