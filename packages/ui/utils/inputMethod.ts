import { storage } from './storage';
import { isStalePreference } from './preferenceTtl';
import type { InputMethod } from '../types';

const STORAGE_KEY = 'plannotator-input-method';
const HTML_STORAGE_KEY = 'plannotator-input-method-html';
const DEFAULT_METHOD: InputMethod = 'drag';
/**
 * Raw-HTML sessions default to Pinpoint: arbitrary pages are element-shaped,
 * not prose-shaped, so click-an-element is the natural first gesture.
 */
const DEFAULT_HTML_METHOD: InputMethod = 'pinpoint';

/** Which document surface the input method applies to. */
export type InputMethodSurface = 'markdown' | 'html';

function parseInputMethod(value: unknown): InputMethod | null {
  return value === 'drag' || value === 'pinpoint' ? value : null;
}

/**
 * The HTML preference is stored as JSON `{ m, savedAt }` so it can expire.
 * A plain legacy string (pre-TTL cookie) has an unknowable age and is treated
 * as expired, which one-time resets everyone to the Pinpoint default.
 */
function parseHtmlRecord(raw: string | null, now: number): InputMethod | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (isStalePreference(record.savedAt, now)) return null;
    return parseInputMethod(record.m);
  } catch {
    return null;
  }
}

/**
 * Pure resolution logic (exported for tests).
 *
 * Persistence decision: the two surfaces keep SEPARATE preferences. The legacy
 * shared key was only ever written from markdown sessions, so honoring it for
 * HTML would let a markdown-era "drag" choice silently suppress the new HTML
 * default. HTML sessions therefore read/write their own key: first run
 * defaults to Pinpoint, an explicit switch made inside an HTML session wins on
 * later HTML sessions, and a switch not refreshed within the staleness TTL
 * (explicit change or annotation activity, see refreshInputMethodStamp)
 * expires back to Pinpoint — without touching the markdown default, which
 * deliberately has no TTL.
 */
export function resolveInputMethod(
  surface: InputMethodSurface,
  savedShared: string | null,
  savedHtml: string | null,
  now: number = Date.now(),
): InputMethod {
  if (surface === 'html') {
    return parseHtmlRecord(savedHtml, now) ?? DEFAULT_HTML_METHOD;
  }
  return parseInputMethod(savedShared) ?? DEFAULT_METHOD;
}

export function getInputMethod(surface: InputMethodSurface = 'markdown'): InputMethod {
  return resolveInputMethod(
    surface,
    storage.getItem(STORAGE_KEY),
    storage.getItem(HTML_STORAGE_KEY),
  );
}

export function saveInputMethod(
  method: InputMethod,
  surface: InputMethodSurface = 'markdown',
): void {
  if (surface === 'html') {
    storage.setItem(HTML_STORAGE_KEY, JSON.stringify({ m: method, savedAt: Date.now() }));
    return;
  }
  storage.setItem(STORAGE_KEY, method);
}

/**
 * Re-stamp the persisted HTML preference with the given method and a fresh
 * timestamp. Called on annotation activity so an actively-used preference
 * never expires mid-habit; a no-op for the markdown surface.
 */
export function refreshInputMethodStamp(method: InputMethod): void {
  saveInputMethod(method, 'html');
}
