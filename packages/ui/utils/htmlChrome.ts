import { storage } from './storage';
import { isStalePreference } from './preferenceTtl';

const STORAGE_KEY = 'plannotator-html-chrome';

export interface HtmlChromeState {
  sidebarOpen: boolean;
  panelOpen: boolean;
  toolsHidden: boolean;
}

export const DEFAULT_HTML_CHROME_STATE: HtmlChromeState = {
  sidebarOpen: false,
  panelOpen: false,
  toolsHidden: true,
};

export function resolveHtmlChromeState(
  raw: string | null,
  now: number = Date.now(),
): HtmlChromeState {
  if (!raw) return DEFAULT_HTML_CHROME_STATE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_HTML_CHROME_STATE;
    }
    const record = parsed as Record<string, unknown>;
    if (isStalePreference(record.savedAt, now)) return DEFAULT_HTML_CHROME_STATE;
    return {
      sidebarOpen: typeof record.sidebarOpen === 'boolean'
        ? record.sidebarOpen
        : DEFAULT_HTML_CHROME_STATE.sidebarOpen,
      panelOpen: typeof record.panelOpen === 'boolean'
        ? record.panelOpen
        : DEFAULT_HTML_CHROME_STATE.panelOpen,
      toolsHidden: typeof record.toolsHidden === 'boolean'
        ? record.toolsHidden
        : DEFAULT_HTML_CHROME_STATE.toolsHidden,
    };
  } catch {
    return DEFAULT_HTML_CHROME_STATE;
  }
}

export interface HtmlChromeRestoreConditions {
  isHtmlSurface: boolean;
  wasHtmlSurface: boolean;
  suppressed: boolean;
}

export function shouldRestoreHtmlChrome(conditions: HtmlChromeRestoreConditions): boolean {
  if (!conditions.isHtmlSurface) return false;
  if (conditions.wasHtmlSurface) return false;
  return !conditions.suppressed;
}

export function mergeHtmlChromeState(input: {
  persisted: HtmlChromeState;
  live: HtmlChromeState;
  sideSurfacesOwned: boolean;
}): HtmlChromeState {
  if (!input.sideSurfacesOwned) return input.live;
  return {
    sidebarOpen: input.persisted.sidebarOpen,
    panelOpen: input.persisted.panelOpen,
    toolsHidden: input.live.toolsHidden,
  };
}

export function getHtmlChromeState(): HtmlChromeState {
  return resolveHtmlChromeState(storage.getItem(STORAGE_KEY));
}

export function saveHtmlChromeState(state: HtmlChromeState): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
}
