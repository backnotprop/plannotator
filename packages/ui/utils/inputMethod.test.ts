/**
 * Pinpoint default resolution for the raw-HTML annotate surface (DOM-gated).
 *
 * Decision under test: HTML sessions keep a SEPARATE input-method preference
 * from markdown sessions. First-ever HTML session defaults to Pinpoint even
 * when a markdown-era "drag" cookie exists; an explicit choice made inside an
 * HTML session persists for later HTML sessions only, and only while the user
 * keeps annotating HTML: a record older than the staleness TTL (or a legacy
 * record with no timestamp) expires back to Pinpoint.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from './storage';
import { STALE_PREFERENCE_TTL_MS } from './preferenceTtl';

const hasDom = typeof document !== 'undefined';
const inputMethodModule = hasDom ? await import('./inputMethod') : null;

// In-memory storage so tests don't depend on happy-dom cookie semantics
// (the codebase-standard pattern for persistence tests).
const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

beforeEach(() => {
  if (!hasDom) return;
  memory.clear();
  setStorageBackend(memoryBackend);
});

afterAll(() => {
  resetStorageBackend();
});

const NOW = 1_800_000_000_000;
const fresh = (m: string, age = 0) => JSON.stringify({ m, savedAt: NOW - age });

describe.if(hasDom)('resolveInputMethod (pure)', () => {
  test('HTML surface with nothing saved defaults to pinpoint', () => {
    expect(inputMethodModule!.resolveInputMethod('html', null, null, NOW)).toBe('pinpoint');
  });

  test('markdown surface with nothing saved keeps the drag default', () => {
    expect(inputMethodModule!.resolveInputMethod('markdown', null, null, NOW)).toBe('drag');
  });

  test('a markdown-era saved preference never suppresses the HTML default', () => {
    expect(inputMethodModule!.resolveInputMethod('html', 'drag', null, NOW)).toBe('pinpoint');
  });

  test('an explicit recent HTML-session choice wins over the HTML default', () => {
    expect(inputMethodModule!.resolveInputMethod('html', null, fresh('drag'), NOW)).toBe('drag');
    expect(inputMethodModule!.resolveInputMethod('html', 'pinpoint', fresh('drag'), NOW)).toBe('drag');
  });

  test('an HTML choice older than the TTL expires back to pinpoint', () => {
    const stale = fresh('drag', STALE_PREFERENCE_TTL_MS + 1);
    expect(inputMethodModule!.resolveInputMethod('html', null, stale, NOW)).toBe('pinpoint');
    // Just inside the TTL still honors the choice.
    const inside = fresh('drag', STALE_PREFERENCE_TTL_MS - 1);
    expect(inputMethodModule!.resolveInputMethod('html', null, inside, NOW)).toBe('drag');
  });

  test('a legacy plain-string HTML record (no timestamp) is treated as expired', () => {
    expect(inputMethodModule!.resolveInputMethod('html', null, 'drag', NOW)).toBe('pinpoint');
  });

  test('HTML choice never leaks into markdown resolution', () => {
    expect(inputMethodModule!.resolveInputMethod('markdown', null, fresh('pinpoint'), NOW)).toBe('drag');
    expect(inputMethodModule!.resolveInputMethod('markdown', 'pinpoint', fresh('drag'), NOW)).toBe('pinpoint');
  });

  test('the markdown preference deliberately has no TTL', () => {
    expect(inputMethodModule!.resolveInputMethod('markdown', 'pinpoint', null, NOW)).toBe('pinpoint');
  });

  test('garbage saved values fall back to the surface default', () => {
    expect(inputMethodModule!.resolveInputMethod('html', 'bogus', 'bogus', NOW)).toBe('pinpoint');
    expect(inputMethodModule!.resolveInputMethod('html', null, '{"m":"bogus","savedAt":' + NOW + '}', NOW)).toBe('pinpoint');
    expect(inputMethodModule!.resolveInputMethod('html', null, '{"m":"drag","savedAt":"soon"}', NOW)).toBe('pinpoint');
    expect(inputMethodModule!.resolveInputMethod('markdown', 'bogus', 'bogus', NOW)).toBe('drag');
  });
});

describe.if(hasDom)('getInputMethod / saveInputMethod (cookie round trip)', () => {
  test('first run: HTML resolves pinpoint, markdown resolves drag', () => {
    expect(inputMethodModule!.getInputMethod('html')).toBe('pinpoint');
    expect(inputMethodModule!.getInputMethod('markdown')).toBe('drag');
    expect(inputMethodModule!.getInputMethod()).toBe('drag');
  });

  test('saving on the HTML surface persists (timestamped) for HTML only', () => {
    inputMethodModule!.saveInputMethod('drag', 'html');
    expect(inputMethodModule!.getInputMethod('html')).toBe('drag');
    expect(inputMethodModule!.getInputMethod('markdown')).toBe('drag');

    inputMethodModule!.saveInputMethod('pinpoint', 'html');
    expect(inputMethodModule!.getInputMethod('html')).toBe('pinpoint');
    expect(inputMethodModule!.getInputMethod('markdown')).toBe('drag');
  });

  test('refreshInputMethodStamp re-stamps the HTML record', () => {
    inputMethodModule!.refreshInputMethodStamp('drag');
    const raw = memory.get('plannotator-input-method-html');
    expect(raw).toBeTruthy();
    const record = JSON.parse(raw!) as { m: string; savedAt: number };
    expect(record.m).toBe('drag');
    expect(typeof record.savedAt).toBe('number');
  });

  test('saving on the markdown surface leaves the HTML default intact', () => {
    inputMethodModule!.saveInputMethod('drag', 'markdown');
    expect(inputMethodModule!.getInputMethod('markdown')).toBe('drag');
    expect(inputMethodModule!.getInputMethod('html')).toBe('pinpoint');
  });
});
