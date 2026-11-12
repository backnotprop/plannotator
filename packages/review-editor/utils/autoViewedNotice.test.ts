import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { ConfigStoreForTest } from '../../ui/config/configStore';
import {
  markAutoViewedNoticeSeen,
  needsAutoViewedNotice,
  toggleAutoViewed,
  turnOffAutoViewed,
} from './autoViewedNotice';

function installMemoryBackend(initial: Readonly<Record<string, string>> = {}): Map<string, string> {
  const values = new Map(Object.entries(initial));
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

function makeStore(): ConfigStoreForTest {
  const store = new ConfigStoreForTest();
  store.setServerSync(() => {});
  return store;
}

afterEach(() => {
  resetStorageBackend();
});

describe('auto-mark-viewed notice gate', () => {
  test('needed once, then never again', () => {
    installMemoryBackend();
    expect(needsAutoViewedNotice()).toBe(true);
    markAutoViewedNoticeSeen();
    expect(needsAutoViewedNotice()).toBe(false);
  });

  test('a stale marker from an older version re-opens the gate', () => {
    installMemoryBackend({ 'plannotator-auto-viewed-notice-seen': '0' });
    expect(needsAutoViewedNotice()).toBe(true);
  });

  test("the notice's Turn off action actually turns the setting off", () => {
    installMemoryBackend();
    const store = makeStore();
    expect(store.get('reviewAutoViewed')).toBe(true);
    turnOffAutoViewed(store);
    expect(store.get('reviewAutoViewed')).toBe(false);
    expect(needsAutoViewedNotice()).toBe(false);
  });

  test('toggling the setting from a UI control also consumes the gate', () => {
    installMemoryBackend();
    const store = makeStore();
    toggleAutoViewed(false, store);
    expect(store.get('reviewAutoViewed')).toBe(false);
    expect(needsAutoViewedNotice()).toBe(false);

    toggleAutoViewed(true, store);
    expect(store.get('reviewAutoViewed')).toBe(true);
    expect(needsAutoViewedNotice()).toBe(false);
  });

  test('the setting defaults on and survives a store reload from its cookie', () => {
    const values = installMemoryBackend();
    const store = makeStore();
    expect(store.get('reviewAutoViewed')).toBe(true);
    toggleAutoViewed(false, store);
    expect(values.get('plannotator-review-auto-viewed')).toBe('false');
    expect(makeStore().get('reviewAutoViewed')).toBe(false);
  });
});
