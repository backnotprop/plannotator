import { storage as packageStorage } from "../../utils/storage";

export const DOCKED_RAIL_MEDIA_QUERY = "(min-width: 768px)";

/**
 * Where the rail keeps its open flag. Defaults to the package's storage
 * (`utils/storage`: cookies, or the backend a host set with
 * `configurePlannotatorUI({ storageBackend })`).
 */
export interface RailStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RailStorageKeys {
  readonly open: string;
  /** Read and written by `useResizablePanel`, so the width always goes through the package's storage. */
  readonly width: string;
}

export const RAIL_STORAGE_KEYS: RailStorageKeys = {
  open: "plannotator-frame-rail-open",
  width: "plannotator-frame-rail-width",
};

export const DEFAULT_RAIL_STORAGE: RailStorage = packageStorage;

export function railStorageKeys(keys?: Partial<RailStorageKeys>): RailStorageKeys {
  return { ...RAIL_STORAGE_KEYS, ...keys };
}

export const RAIL_WIDTH = {
  defaultWidth: 306,
  minWidth: 240,
  maxWidth: 400,
} as const;

export function readStoredRailOpen(
  storage: RailStorage = DEFAULT_RAIL_STORAGE,
  key: string = RAIL_STORAGE_KEYS.open,
): boolean | null {
  try {
    const stored = storage.getItem(key);
    return stored === null ? null : stored === "1";
  } catch {
    return null;
  }
}

export function writeStoredRailOpen(
  open: boolean,
  storage: RailStorage = DEFAULT_RAIL_STORAGE,
  key: string = RAIL_STORAGE_KEYS.open,
): void {
  try {
    storage.setItem(key, open ? "1" : "0");
  } catch {}
}

export function savedRailWidth(key: string = RAIL_STORAGE_KEYS.width): number {
  try {
    const saved = Number(packageStorage.getItem(key));
    if (saved >= RAIL_WIDTH.minWidth && saved <= RAIL_WIDTH.maxWidth) return saved;
  } catch {}
  return RAIL_WIDTH.defaultWidth;
}

const MIN_DOCUMENT_PANE_PX = 280;

const ROW_SLACK_PX = 32;

export function railFitsRow(rowWidth: number, railWidth: number, sidePanelsWidth: number): boolean {
  return rowWidth - railWidth - sidePanelsWidth - ROW_SLACK_PX >= MIN_DOCUMENT_PANE_PX;
}
