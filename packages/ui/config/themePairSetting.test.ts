import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { DEFAULT_COLOR_THEME, resetDefaultThemePair } from '../utils/themeRegistry';
import { ConfigStoreForTest } from './configStore';
import { SETTINGS } from './settings';

function installStorage(seed: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

afterEach(() => {
  resetStorageBackend();
  resetDefaultThemePair();
});

describe('theme pair setting', () => {
  test('has no persisted value on a fresh install and defaults to one palette in both halves', () => {
    installStorage();

    expect(SETTINGS.themePair.fromCookie()).toBeUndefined();
    expect(SETTINGS.themePair.defaultValue()).toEqual({
      mode: 'dark',
      light: DEFAULT_COLOR_THEME,
      dark: DEFAULT_COLOR_THEME,
    });
  });

  test('round-trips both halves through cookies', () => {
    const values = installStorage();

    SETTINGS.themePair.toCookie({ mode: 'system', light: 'kanagawa-lotus', dark: 'kanagawa-wave' });
    expect(values.get('plannotator-theme')).toBe('system');
    expect(values.get('plannotator-light-theme')).toBe('kanagawa-lotus');
    expect(values.get('plannotator-dark-theme')).toBe('kanagawa-wave');

    expect(SETTINGS.themePair.fromCookie()).toEqual({
      mode: 'system',
      light: 'kanagawa-lotus',
      dark: 'kanagawa-wave',
    });
  });

  test('seeds both halves from the single palette an older release stored', () => {
    installStorage({ 'plannotator-theme': 'system', 'plannotator-color-theme': 'kanagawa-wave' });

    expect(SETTINGS.themePair.fromCookie()).toEqual({
      mode: 'system',
      light: DEFAULT_COLOR_THEME,
      dark: 'kanagawa-wave',
    });

    // A palette that renders both modes migrates into the whole pair.
    installStorage({ 'plannotator-theme': 'light', 'plannotator-color-theme': 'rose-pine' });
    expect(SETTINGS.themePair.fromCookie()).toEqual({
      mode: 'light',
      light: 'rose-pine',
      dark: 'rose-pine',
    });

    // One half already assigned: the other still comes from the legacy key.
    installStorage({
      'plannotator-theme': 'system',
      'plannotator-color-theme': 'rose-pine',
      'plannotator-dark-theme': 'vesper',
    });
    expect(SETTINGS.themePair.fromCookie()).toEqual({
      mode: 'system',
      light: 'rose-pine',
      dark: 'vesper',
    });
  });

  test('drops a half whose palette cannot render it', () => {
    installStorage({
      'plannotator-theme': 'system',
      'plannotator-light-theme': 'vesper',
      'plannotator-dark-theme': 'kanagawa-lotus',
    });

    expect(SETTINGS.themePair.fromCookie()).toEqual({
      mode: 'system',
      light: DEFAULT_COLOR_THEME,
      dark: DEFAULT_COLOR_THEME,
    });
  });

  test('round-trips through the ~/.plannotator/config.json theme key', () => {
    installStorage();

    expect(SETTINGS.themePair.toServer({ mode: 'system', light: 'rose-pine', dark: 'vesper' })).toEqual({
      theme: { mode: 'system', light: 'rose-pine', dark: 'vesper' },
    });

    expect(SETTINGS.themePair.fromServer({ theme: { mode: 'system', light: 'rose-pine', dark: 'vesper' } })).toEqual({
      mode: 'system',
      light: 'rose-pine',
      dark: 'vesper',
    });

    // A hand-edited config.json is repaired, not trusted.
    expect(SETTINGS.themePair.fromServer({ theme: { mode: 'sepia', light: 'vesper' } })).toEqual({
      mode: 'dark',
      light: DEFAULT_COLOR_THEME,
      dark: DEFAULT_COLOR_THEME,
    });

    // Nothing to say about the theme leaves the cookie/default alone.
    expect(SETTINGS.themePair.fromServer({})).toBeUndefined();
    expect(SETTINGS.themePair.fromServer({ theme: {} })).toBeUndefined();
    expect(SETTINGS.themePair.fromServer({ diffOptions: { diffStyle: 'unified' } })).toBeUndefined();
  });
});

describe('config store seeding', () => {
  test('a seed writes the cookie but never the server', async () => {
    const values = installStorage();
    const store = new ConfigStoreForTest();
    const synced: Record<string, unknown>[] = [];
    store.setServerSync(payload => { synced.push(payload); });

    store.seed('themePair', { mode: 'system', light: 'rose-pine', dark: 'vesper' });
    await new Promise<void>(resolve => setTimeout(resolve, 350));

    expect(store.get('themePair')).toEqual({ mode: 'system', light: 'rose-pine', dark: 'vesper' });
    expect(values.get('plannotator-dark-theme')).toBe('vesper');
    expect(synced).toEqual([]);
  });

  test('a seed never undoes a value the server supplied', () => {
    installStorage();
    const store = new ConfigStoreForTest();

    store.init({ theme: { mode: 'light', light: 'kanagawa-lotus', dark: 'nord' } });
    store.seed('themePair', { mode: 'dark', light: DEFAULT_COLOR_THEME, dark: DEFAULT_COLOR_THEME });

    expect(store.get('themePair')).toEqual({ mode: 'light', light: 'kanagawa-lotus', dark: 'nord' });
  });

  // A write queued before the server config arrives would otherwise flush
  // AFTER it and push the superseded value back into config.json.
  test('init() retracts queued writes for the keys it just overrode', async () => {
    installStorage();
    const store = new ConfigStoreForTest();
    const synced: Record<string, unknown>[] = [];
    store.setServerSync(payload => { synced.push(payload); });

    store.set('themePair', { mode: 'dark', light: DEFAULT_COLOR_THEME, dark: DEFAULT_COLOR_THEME });
    store.set('diffStyle', 'unified');
    store.init({ theme: { mode: 'system', light: 'rose-pine', dark: 'vesper' } });
    await new Promise<void>(resolve => setTimeout(resolve, 350));

    // The theme write is gone; the untouched setting still syncs.
    const merged = Object.assign({}, ...synced) as Record<string, unknown>;
    expect(merged.theme).toBeUndefined();
    expect(merged.diffOptions).toEqual({ diffStyle: 'unified' });
  });
});
