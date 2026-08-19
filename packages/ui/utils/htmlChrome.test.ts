/**
 * Sidebar/panel persistence for raw-HTML annotate sessions (DOM-gated).
 *
 * Contract under test: the default HTML session opens with both side surfaces
 * closed; an explicit change the user makes persists across a fresh mount,
 * but only while the record stays fresh: state older than the staleness TTL
 * (or a legacy record with no timestamp) expires back to the defaults.
 * `toolsHidden` (the header "Hide tools" eye toggle) persists like the rest:
 * restoring it hidden is safe because the header toggle is the way back.
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

const DEFAULTS = { sidebarOpen: false, panelOpen: false, toolsHidden: false };
const NOW = 1_800_000_000_000;
const stamp = (state: object, age = 0) => JSON.stringify({ ...state, savedAt: NOW - age });

describe.if(hasDom)('resolveHtmlChromeState (pure)', () => {
  test('first run (nothing saved): both side surfaces closed', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState(null, NOW)).toEqual(DEFAULTS);
  });

  test('malformed cookie values fall back to the defaults', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState('not-json', NOW)).toEqual(DEFAULTS);
    expect(htmlChromeModule!.resolveHtmlChromeState('"just-a-string"', NOW)).toEqual(DEFAULTS);
    expect(htmlChromeModule!.resolveHtmlChromeState(stamp({ sidebarOpen: 'yes' }), NOW)).toEqual(DEFAULTS);
  });

  test('a fresh record wins; partial state merges over the defaults', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState(stamp({ sidebarOpen: true }), NOW)).toEqual({
      sidebarOpen: true,
      panelOpen: false,
      toolsHidden: false,
    });
    expect(
      htmlChromeModule!.resolveHtmlChromeState(stamp({ panelOpen: true }), NOW),
    ).toEqual({ sidebarOpen: false, panelOpen: true, toolsHidden: false });
  });

  test('toolsHidden persists like the rest of the record', () => {
    // The header eye toggle is part of the header (never part of the hidden
    // chrome), so restoring a hidden state cannot strand the user.
    expect(
      htmlChromeModule!.resolveHtmlChromeState(
        stamp({ toolsHidden: true, sidebarOpen: true, panelOpen: true }),
        NOW,
      ),
    ).toEqual({ sidebarOpen: true, panelOpen: true, toolsHidden: true });
  });

  test('a record older than the TTL expires back to the defaults', () => {
    const stale = stamp({ sidebarOpen: true, panelOpen: true }, STALE_PREFERENCE_TTL_MS + 1);
    expect(htmlChromeModule!.resolveHtmlChromeState(stale, NOW)).toEqual(DEFAULTS);
    const inside = stamp({ sidebarOpen: true, panelOpen: true }, STALE_PREFERENCE_TTL_MS - 1);
    expect(htmlChromeModule!.resolveHtmlChromeState(inside, NOW)).toEqual({
      sidebarOpen: true,
      panelOpen: true,
      toolsHidden: false,
    });
  });

  test('a legacy record without a timestamp is treated as expired', () => {
    expect(
      htmlChromeModule!.resolveHtmlChromeState('{"sidebarOpen":true,"panelOpen":true}', NOW),
    ).toEqual(DEFAULTS);
  });
});

describe.if(hasDom)('getHtmlChromeState / saveHtmlChromeState (cookie round trip)', () => {
  test('first run reads the defaults', () => {
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual(DEFAULTS);
  });

  test('a "user opened surfaces" state persists across a fresh mount', () => {
    // Session 1: user opens the sidebar and the drawer, then leaves.
    htmlChromeModule!.saveHtmlChromeState({ sidebarOpen: true, panelOpen: true, toolsHidden: false });
    // Session 2 (fresh mount, same cookies): opens exactly as left.
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual({
      sidebarOpen: true,
      panelOpen: true,
      toolsHidden: false,
    });
  });

  test('a hidden-tools state persists across a fresh mount', () => {
    htmlChromeModule!.saveHtmlChromeState({ sidebarOpen: false, panelOpen: false, toolsHidden: true });
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual({
      sidebarOpen: false,
      panelOpen: false,
      toolsHidden: true,
    });
  });

  test('a "user re-closed everything" state persists too', () => {
    htmlChromeModule!.saveHtmlChromeState({ sidebarOpen: true, panelOpen: true, toolsHidden: true });
    htmlChromeModule!.saveHtmlChromeState({ sidebarOpen: false, panelOpen: false, toolsHidden: false });
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual(DEFAULTS);
  });
});
