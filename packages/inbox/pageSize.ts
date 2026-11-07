/**
 * The size of an HTML page on a phone (approval "inbox-html-attachments-phone",
 * part B "Fit the page", addendum 2026-11-07), like Safari's "Request Desktop
 * Website". "Desktop size" lays the page out at a laptop's width and scales it
 * down to the phone's width; "Phone size" lays it out at the phone's width,
 * as before.
 *
 * - A page wider than the phone opens on Desktop size by itself: the page's
 *   bridge reports how wide it lays out (`content-width`) and a page wider
 *   than its frame was made for a wider screen.
 * - A press is remembered per file (its path), on this device, so a reload or
 *   the same file sent again opens the way it was left. The remembered choice
 *   wins over the page's own width.
 * - Phone only; a desktop never shows the control and nothing changes there.
 *
 * Stored in localStorage as one small map, the newest choices kept.
 */

/** The width a page lays out at on Desktop size: a laptop's. */
export const PAGE_DESKTOP_WIDTH = 1280;

export type PageSize = 'phone' | 'desktop';

export const PAGE_SIZE_KEY = 'plannotator-inbox-page-size';
/** How many files keep a remembered size; the oldest choice goes first. */
export const PAGE_SIZE_KEPT = 200;

/**
 * How much wider than its frame a page must lay out to count as made for a wider screen. Desktop layouts are 768 px
 * or wider (about 2x a phone); one long hash or URL in a phone-friendly page is about 500 px (1.28x on 390).
 */
export const PAGE_WIDE_RATIO = 1.5;

/**
 * A page lays out clearly wider than its frame (at least PAGE_WIDE_RATIO times):
 * it was made for a wider screen. A phone-friendly page with one long hash, URL
 * or unwrapped line pokes out a little and stays on Phone size; a page that fits
 * (or a frame already at desktop width) is not wide either.
 */
export function pageIsWide(report: { width: number; viewport: number }): boolean {
  return report.viewport > 0 && report.width >= report.viewport * PAGE_WIDE_RATIO;
}

/** The scale that fits a desktop-width page in a box this wide (never larger than 1). */
export function desktopFitScale(boxWidth: number): number {
  return boxWidth > 0 ? Math.min(1, boxWidth / PAGE_DESKTOP_WIDTH) : 1;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): Store | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readMap(store: Store | null): Record<string, PageSize> {
  if (!store) return {};
  try {
    const parsed: unknown = JSON.parse(store.getItem(PAGE_SIZE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, PageSize> = {};
    for (const [key, value] of Object.entries(parsed)) if (value === 'phone' || value === 'desktop') out[key] = value;
    return out;
  } catch {
    return {};
  }
}

/** The size the person picked for this file, or null before they pick. */
export function readPageSize(file: string, store: Store | null = defaultStore()): PageSize | null {
  return readMap(store)[file] ?? null;
}

/** Remember a picked size for this file (newest last, the oldest dropped past PAGE_SIZE_KEPT). */
export function writePageSize(file: string, size: PageSize, store: Store | null = defaultStore()): void {
  if (!store) return;
  const map = readMap(store);
  delete map[file];
  map[file] = size;
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - PAGE_SIZE_KEPT))) delete map[key];
  try {
    store.setItem(PAGE_SIZE_KEY, JSON.stringify(map));
  } catch {
    // Private mode or a full store: the size holds for this view only.
  }
}

/** The size a page shows at: the person's pick, else Desktop size when the page is wide. */
export function shownPageSize(choice: PageSize | null, wide: boolean): PageSize {
  return choice ?? (wide ? 'desktop' : 'phone');
}
