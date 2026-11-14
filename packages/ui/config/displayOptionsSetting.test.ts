/**
 * config.json `displayOptions`: the plan / annotate Display settings and the
 * markdown selection mode, under one server key the way the diff options share
 * `diffOptions`.
 *
 * Guards: (1) a value config.json does not offer is dropped, so the cookie or
 * default keeps applying; (2) config.json wins over the cookie once init()
 * runs, which is what makes a new host or a cleared cookie open with the same
 * look; (3) two settings changed together reach the server as one merged
 * `displayOptions`, never one object replacing the other; (4) Settings' Display
 * toggles send only the key that changed, so untouched defaults are not
 * written into config.json.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { getUIPreferences, saveUIPreferences } from '../utils/uiPreferences';
import { configStore, ConfigStoreForTest } from './configStore';
import { SETTINGS } from './settings';

function installBackend(seed: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(seed));
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

/** The registry name, the displayOptions field, a valid value, and values config.json may not supply. */
const LEAVES = [
  { name: 'documentTextSize', field: 'textSize', value: 19, bad: [16, '19'] },
  { name: 'documentFontFamily', field: 'fontFamily', value: 'Georgia', bad: [1, null] },
  { name: 'gridEnabled', field: 'showGrid', value: true, bad: ['true', 1] },
  { name: 'diagramShadow', field: 'diagramShadow', value: 0, bad: [101, '0'] },
  { name: 'tocEnabled', field: 'autoOpenSidebar', value: false, bad: ['false', 0] },
  { name: 'stickyActionsEnabled', field: 'stickyActions', value: false, bad: ['false', 0] },
  { name: 'planWidth', field: 'planWidth', value: 'wide', bad: ['huge', 1280] },
  { name: 'taterMode', field: 'taterMode', value: true, bad: ['true', 1] },
  { name: 'inputMethod', field: 'inputMethod', value: 'pinpoint', bad: ['click', true] },
] as const;

type LeafName = (typeof LEAVES)[number]['name'];

function def(name: LeafName) {
  return SETTINGS[name] as unknown as {
    serverKey?: string;
    fromServer: (sc: Record<string, unknown>) => unknown;
    toServer: (v: unknown) => Record<string, unknown>;
  };
}

afterEach(() => {
  configStore.resetServerSync();
  resetStorageBackend();
});

describe('displayOptions codecs', () => {
  for (const leaf of LEAVES) {
    test(`${leaf.name} round-trips as displayOptions.${leaf.field} and drops a value it does not offer`, () => {
      const d = def(leaf.name);
      expect(d.serverKey).toBe('displayOptions');
      expect(d.toServer(leaf.value)).toEqual({ displayOptions: { [leaf.field]: leaf.value } });
      expect(d.fromServer({ displayOptions: { [leaf.field]: leaf.value } })).toBe(leaf.value);
      for (const bad of leaf.bad) {
        expect(d.fromServer({ displayOptions: { [leaf.field]: bad } })).toBeUndefined();
      }
      expect(d.fromServer({})).toBeUndefined();
      expect(d.fromServer({ displayOptions: [leaf.value] })).toBeUndefined();
    });
  }

  test('the selection mode keeps reading the retired `word` as Select', () => {
    installBackend({ 'plannotator-input-method': 'word' });
    expect(SETTINGS.inputMethod.fromCookie()).toBe('drag');
    expect(SETTINGS.inputMethod.fromServer({ displayOptions: { inputMethod: 'word' } })).toBe('drag');
  });
});

describe('displayOptions in the store', () => {
  test('config.json wins over the cookie, and the cookie is rewritten to match', () => {
    const values = installBackend({
      'plannotator-document-text-size': '13',
      'plannotator-input-method': 'drag',
      'plannotator-plan-width': 'compact',
    });
    const store = new ConfigStoreForTest();
    expect(store.get('documentTextSize')).toBe(13);
    store.init({ displayOptions: { textSize: 19, inputMethod: 'pinpoint', planWidth: 'wide' } });
    expect(store.get('documentTextSize')).toBe(19);
    expect(store.get('inputMethod')).toBe('pinpoint');
    expect(store.get('planWidth')).toBe('wide');
    expect(values.get('plannotator-document-text-size')).toBe('19');
    expect(values.get('plannotator-input-method')).toBe('pinpoint');
  });

  test('a browser with no cookies gets the config.json values', () => {
    installBackend();
    const store = new ConfigStoreForTest();
    store.init({ displayOptions: { fontFamily: 'Georgia', taterMode: true, stickyActions: false } });
    expect(store.get('documentFontFamily')).toBe('Georgia');
    expect(store.get('taterMode')).toBe(true);
    expect(store.get('stickyActionsEnabled')).toBe(false);
  });

  test('two settings changed together reach the server as one merged displayOptions', async () => {
    installBackend();
    const store = new ConfigStoreForTest();
    const synced: Record<string, unknown>[] = [];
    store.setServerSync((payload) => { synced.push(payload); });
    store.set('documentTextSize', 17);
    store.set('inputMethod', 'pinpoint');
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    expect(synced).toEqual([{ displayOptions: { textSize: 17, inputMethod: 'pinpoint' } }]);
  });

  test('saving Display preferences sends only the key that changed', async () => {
    installBackend();
    configStore.loadFromBackend();
    const synced: Record<string, unknown>[] = [];
    configStore.setServerSync((payload) => { synced.push(payload); });
    const prefs = getUIPreferences();
    expect(prefs).toEqual({ tocEnabled: true, stickyActionsEnabled: true, planWidth: 'compact' });
    saveUIPreferences({ ...prefs, planWidth: 'wide' });
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    expect(synced).toEqual([{ displayOptions: { planWidth: 'wide' } }]);
    expect(getUIPreferences().planWidth).toBe('wide');
  });
});
