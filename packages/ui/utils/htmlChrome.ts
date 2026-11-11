import { storage } from './storage';
import { isStalePreference } from './preferenceTtl';

/**
 * `toolsHidden` is the header "Hide tools" toggle: while true, ALL floating chrome over the page
 * (sidebar tongue tabs + the comment/attachments cluster) is removed from the DOM.
 */

const STORAGE_KEY = 'plannotator-html-chrome';

export interface HtmlChromeState {
  sidebarOpen: boolean;
  panelOpen: boolean;
  toolsHidden: boolean;
}

/**
 * Default: both side surfaces closed AND the floating tools hidden — the page gets the whole
 * viewport until the user asks for the tools.
 */
export const DEFAULT_HTML_CHROME_STATE: HtmlChromeState = {
  sidebarOpen: false,
  panelOpen: false,
  toolsHidden: true,
};

/** Pure resolution logic (exported for tests): raw cookie value → state. */
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

/** Inputs to the restore-on-entry decision (see {@link shouldRestoreHtmlChrome}). */
export interface HtmlChromeRestoreConditions {
  isHtmlSurface: boolean;
  wasHtmlSurface: boolean;
  /**
   * This session takes no part in the persisted chrome at all (archive, goal setup): nothing is
   * restored and nothing is written.
   */
  suppressed: boolean;
}

/** Whether to apply the persisted chrome state, i.e. whether this render is an ENTRY into an HTML surface. */
export function shouldRestoreHtmlChrome(conditions: HtmlChromeRestoreConditions): boolean {
  if (!conditions.isHtmlSurface) return false;
  if (conditions.wasHtmlSurface) return false;
  return !conditions.suppressed;
}

/** The record to persist when the chrome changes on an HTML surface. */
export function mergeHtmlChromeState(input: {
  persisted: HtmlChromeState;
  /** The chrome this session is in. */
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
