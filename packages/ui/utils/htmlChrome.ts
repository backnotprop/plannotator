import { storage } from './storage';
import { isStalePreference } from './preferenceTtl';

/**
 * Cross-session chrome visibility for raw-HTML annotate sessions.
 *
 * A raw-HTML session should open as close to "just the page" as possible, so
 * the default is minimal paint: tools hidden, sidebar closed, annotations
 * drawer closed. An explicit change the user makes (showing tools, opening the
 * drawer) persists for later HTML sessions, but only while they keep using
 * HTML annotate: state not refreshed within the staleness TTL (explicit
 * changes or annotation activity re-stamp it) expires back to the minimal
 * defaults. Persisted as a cookie (like every other cross-session UI pref;
 * hook servers run on random ports, and cookies are scoped by domain, not
 * port). Markdown sessions are untouched. A legacy record without a timestamp
 * has an unknowable age and is treated as expired, which one-time resets
 * everyone to the minimal defaults.
 */

const STORAGE_KEY = 'plannotator-html-chrome';

export interface HtmlChromeState {
  /** The header "Hide tools" toggle — true hides all annotation chrome. */
  toolsHidden: boolean;
  /** Whether the left sidebar was open when the user last left. */
  sidebarOpen: boolean;
  /** Whether the right annotations drawer was open when the user last left. */
  panelOpen: boolean;
}

/** Default: minimal paint — everything hidden, both side surfaces closed. */
export const DEFAULT_HTML_CHROME_STATE: HtmlChromeState = {
  toolsHidden: true,
  sidebarOpen: false,
  panelOpen: false,
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
      toolsHidden: typeof record.toolsHidden === 'boolean'
        ? record.toolsHidden
        : DEFAULT_HTML_CHROME_STATE.toolsHidden,
      sidebarOpen: typeof record.sidebarOpen === 'boolean'
        ? record.sidebarOpen
        : DEFAULT_HTML_CHROME_STATE.sidebarOpen,
      panelOpen: typeof record.panelOpen === 'boolean'
        ? record.panelOpen
        : DEFAULT_HTML_CHROME_STATE.panelOpen,
    };
  } catch {
    return DEFAULT_HTML_CHROME_STATE;
  }
}

export function getHtmlChromeState(): HtmlChromeState {
  return resolveHtmlChromeState(storage.getItem(STORAGE_KEY));
}

export function saveHtmlChromeState(state: HtmlChromeState): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
}
