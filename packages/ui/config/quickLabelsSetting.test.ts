/**
 * config.json `quickLabels`: Settings → Labels, synced the way
 * `conventionalLabels` is, so the same Quick Labels (and tips) show on every
 * browser and device that reviews the same machine.
 *
 * Guards: (1) config.json wins over the cookie once init() runs, and the
 * cookie is rewritten to match; (2) without a server value the cookie keeps
 * applying and nothing is written back to the server; (3) a save sends the
 * parsed array and Reset to defaults sends null; (4) a server value that is
 * neither an array nor null is dropped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { configStore, ConfigStoreForTest } from './configStore';
import { SETTINGS } from './settings';

const COOKIE = 'plannotator-quick-labels';
const COOKIE_LABELS = [{ id: 'from-cookie', emoji: '🍪', text: 'From cookie', color: 'blue' }];
const SERVER_LABELS = [{ id: 'from-server', emoji: '🖥️', text: 'From server', color: 'red', tip: 'Shared tip' }];

function installBackend(seed: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(seed));
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

function waitForServerSync(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 350));
}

afterEach(() => {
  configStore.resetServerSync();
  resetStorageBackend();
});

describe('quickLabels codec', () => {
  test('round-trips as a parsed array under quickLabels, and null as null', () => {
    const def = SETTINGS.quickLabels;
    expect(def.serverKey).toBe('quickLabels');
    expect(def.toServer(JSON.stringify(SERVER_LABELS))).toEqual({ quickLabels: SERVER_LABELS });
    expect(def.toServer(null)).toEqual({ quickLabels: null });
    expect(def.fromServer({ quickLabels: SERVER_LABELS })).toBe(JSON.stringify(SERVER_LABELS));
    expect(def.fromServer({ quickLabels: null })).toBeNull();
  });

  test('drops a server value that is neither an array nor null', () => {
    const def = SETTINGS.quickLabels;
    for (const bad of ['[]', { id: 'x' }, 1, true]) {
      expect(def.fromServer({ quickLabels: bad })).toBeUndefined();
    }
    expect(def.fromServer({})).toBeUndefined();
  });
});

describe('quickLabels in the store', () => {
  test('config.json wins over the cookie, and the cookie is rewritten to match', () => {
    const values = installBackend({ [COOKIE]: JSON.stringify(COOKIE_LABELS) });
    const store = new ConfigStoreForTest();
    expect(store.get('quickLabels')).toBe(JSON.stringify(COOKIE_LABELS));
    store.init({ quickLabels: SERVER_LABELS });
    expect(store.get('quickLabels')).toBe(JSON.stringify(SERVER_LABELS));
    expect(values.get(COOKIE)).toBe(JSON.stringify(SERVER_LABELS));
  });

  test('a cleared list in config.json resets every browser to the defaults', () => {
    const values = installBackend({ [COOKIE]: JSON.stringify(COOKIE_LABELS) });
    const store = new ConfigStoreForTest();
    store.init({ quickLabels: null });
    expect(store.get('quickLabels')).toBeNull();
    expect(values.has(COOKIE)).toBe(false);
  });

  test('without a server value the cookie keeps applying and nothing is sent', async () => {
    const values = installBackend({ [COOKIE]: JSON.stringify(COOKIE_LABELS) });
    const store = new ConfigStoreForTest();
    const synced: Record<string, unknown>[] = [];
    store.setServerSync((payload) => { synced.push(payload); });
    store.init({});
    expect(store.get('quickLabels')).toBe(JSON.stringify(COOKIE_LABELS));
    expect(values.get(COOKIE)).toBe(JSON.stringify(COOKIE_LABELS));
    await waitForServerSync();
    expect(synced).toEqual([]);
  });

  test('a save sends the parsed array, and Reset to defaults sends null', async () => {
    installBackend();
    const store = new ConfigStoreForTest();
    const synced: Record<string, unknown>[] = [];
    store.setServerSync((payload) => { synced.push(payload); });
    store.set('quickLabels', JSON.stringify(SERVER_LABELS));
    await waitForServerSync();
    store.set('quickLabels', null);
    await waitForServerSync();
    expect(synced).toEqual([{ quickLabels: SERVER_LABELS }, { quickLabels: null }]);
  });
});
