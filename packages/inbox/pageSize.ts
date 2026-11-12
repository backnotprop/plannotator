export const PAGE_DESKTOP_WIDTH = 1280;

export type PageSize = 'phone' | 'desktop';

export const PAGE_SIZE_KEY = 'plannotator-inbox-page-size';
export const PAGE_SIZE_KEPT = 200;

export const PAGE_WIDE_RATIO = 1.5;

export function pageIsWide(report: { width: number; viewport: number }): boolean {
  return report.viewport > 0 && report.width >= report.viewport * PAGE_WIDE_RATIO;
}

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

export function readPageSize(file: string, store: Store | null = defaultStore()): PageSize | null {
  return readMap(store)[file] ?? null;
}

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
  }
}

export function shownPageSize(choice: PageSize | null, wide: boolean): PageSize {
  return choice ?? (wide ? 'desktop' : 'phone');
}
