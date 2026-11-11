import { storage } from './storage';
import { isStalePreference } from './preferenceTtl';
import type { InputMethod } from '../types';

const STORAGE_KEY = 'plannotator-input-method';
const HTML_STORAGE_KEY = 'plannotator-input-method-html';
const DEFAULT_METHOD: InputMethod = 'drag';
const DEFAULT_HTML_METHOD: InputMethod = 'pinpoint';

export type InputMethodSurface = 'markdown' | 'html';

function parseInputMethod(value: unknown): InputMethod | null {
  if (value === 'word') return 'drag';
  return value === 'drag' || value === 'pinpoint' ? value : null;
}

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

/** Pure resolution logic (exported for tests). */
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
 * Called on annotation activity so an actively-used preference never expires mid-habit; a no-op
 * for the markdown surface.
 */
export function refreshInputMethodStamp(method: InputMethod): void {
  saveInputMethod(method, 'html');
}
