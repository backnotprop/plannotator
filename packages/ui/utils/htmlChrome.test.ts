/**
 * Chrome persistence for raw-HTML annotate sessions (DOM-gated).
 *
 * Contract under test: the default HTML session opens minimal (all chrome
 * hidden, sidebar closed, annotations drawer closed); an explicit change the
 * user makes persists across a fresh mount, but only while the record stays
 * fresh: state older than the staleness TTL (or a legacy record with no
 * timestamp) expires back to the minimal defaults.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from './storage';
import { STALE_PREFERENCE_TTL_MS } from './preferenceTtl';

const hasDom = typeof document !== 'undefined';
const htmlChromeModule = hasDom ? await import('./htmlChrome') : null;

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

const MINIMAL = { toolsHidden: true, sidebarOpen: false, panelOpen: false };
const NOW = 1_800_000_000_000;
const stamp = (state: object, age = 0) => JSON.stringify({ ...state, savedAt: NOW - age });

describe.if(hasDom)('resolveHtmlChromeState (pure)', () => {
  test('first run (nothing saved): everything hidden, both side surfaces closed', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState(null, NOW)).toEqual(MINIMAL);
  });

  test('malformed cookie values fall back to the minimal default', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState('not-json', NOW)).toEqual(MINIMAL);
    expect(htmlChromeModule!.resolveHtmlChromeState('"just-a-string"', NOW)).toEqual(MINIMAL);
    expect(htmlChromeModule!.resolveHtmlChromeState(stamp({ toolsHidden: 'yes' }), NOW)).toEqual(MINIMAL);
  });

  test('a fresh record wins; partial state merges over the defaults', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState(stamp({ toolsHidden: false }), NOW)).toEqual({
      toolsHidden: false,
      sidebarOpen: false,
      panelOpen: false,
    });
    expect(
      htmlChromeModule!.resolveHtmlChromeState(stamp({ toolsHidden: false, panelOpen: true }), NOW),
    ).toEqual({ toolsHidden: false, sidebarOpen: false, panelOpen: true });
  });

  test('a record older than the TTL expires back to the minimal defaults', () => {
    const stale = stamp({ toolsHidden: false, sidebarOpen: true, panelOpen: true }, STALE_PREFERENCE_TTL_MS + 1);
    expect(htmlChromeModule!.resolveHtmlChromeState(stale, NOW)).toEqual(MINIMAL);
    const inside = stamp({ toolsHidden: false, sidebarOpen: true, panelOpen: true }, STALE_PREFERENCE_TTL_MS - 1);
    expect(htmlChromeModule!.resolveHtmlChromeState(inside, NOW)).toEqual({
      toolsHidden: false,
      sidebarOpen: true,
      panelOpen: true,
    });
  });

  test('a legacy record without a timestamp is treated as expired', () => {
    expect(
      htmlChromeModule!.resolveHtmlChromeState('{"toolsHidden":false,"sidebarOpen":true}', NOW),
    ).toEqual(MINIMAL);
  });
});

describe.if(hasDom)('getHtmlChromeState / saveHtmlChromeState (cookie round trip)', () => {
  test('first run reads the minimal default', () => {
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual(MINIMAL);
  });

  test('a "user showed tools / opened surfaces" state persists across a fresh mount', () => {
    // Session 1: user shows tools, opens the sidebar and the drawer, then leaves.
    htmlChromeModule!.saveHtmlChromeState({ toolsHidden: false, sidebarOpen: true, panelOpen: true });
    // Session 2 (fresh mount, same cookies): opens exactly as left.
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual({
      toolsHidden: false,
      sidebarOpen: true,
      panelOpen: true,
    });
  });

  test('a "user re-hid everything" state persists too', () => {
    htmlChromeModule!.saveHtmlChromeState({ toolsHidden: false, sidebarOpen: true, panelOpen: true });
    htmlChromeModule!.saveHtmlChromeState({ toolsHidden: true, sidebarOpen: false, panelOpen: false });
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual(MINIMAL);
  });
});
