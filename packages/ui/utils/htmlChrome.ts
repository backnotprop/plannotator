import { storage } from './storage';
import { isStalePreference } from './preferenceTtl';

/**
 * Cross-session sidebar/panel state for raw-HTML annotate sessions.
 *
 * A raw-HTML session opens with both side surfaces closed so the page gets
 * the viewport; an explicit change the user makes (opening the sidebar or the
 * annotations drawer) persists for later HTML sessions, but only while they
 * keep using HTML annotate: state not refreshed within the staleness TTL
 * (explicit changes or annotation activity re-stamp it) expires back to the
 * defaults. Persisted as a cookie (like every other cross-session UI pref;
 * hook servers run on random ports, and cookies are scoped by domain, not
 * port). Markdown sessions are untouched. A legacy record without a timestamp
 * has an unknowable age and is treated as expired.
 *
 * `toolsHidden` is the header "Hide tools" toggle: while true, ALL floating
 * chrome over the page (sidebar tongue tabs + the comment/attachments
 * cluster) is removed from the DOM. It DEFAULTS to true — an HTML document is
 * authored to fill the viewport, so a first-ever session shows the page and
 * nothing else, and the header eye (plus Mod+Shift+X) is what reveals the
 * tools. Defaulting hidden can never strand a user for the same reason
 * restoring hidden can't: the control that flips it back lives in the header,
 * never in the hidden chrome. A fresh persisted record still wins in both
 * directions, so a user who showed the tools keeps them next session.
 */

const STORAGE_KEY = 'plannotator-html-chrome';

export interface HtmlChromeState {
  /** Whether the left sidebar was open when the user last left. */
  sidebarOpen: boolean;
  /** Whether the right annotations drawer was open when the user last left. */
  panelOpen: boolean;
  /** Whether ALL floating tools over the page were hidden when the user left. */
  toolsHidden: boolean;
}

/**
 * Default: both side surfaces closed AND the floating tools hidden — the page
 * gets the whole viewport until the user asks for the tools.
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

export function getHtmlChromeState(): HtmlChromeState {
  return resolveHtmlChromeState(storage.getItem(STORAGE_KEY));
}

export function saveHtmlChromeState(state: HtmlChromeState): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
}
