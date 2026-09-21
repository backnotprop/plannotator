/**
 * The one-time gate for the auto-mark-viewed notice.
 *
 * Two regressions to guard: the toast re-appearing every session (an
 * unversioned or unwritten seen-marker), and the toast appearing to someone
 * who already found the off switch, which is both redundant and a little
 * insulting.
 *
 * Storage is a memory backend and the config store is a fresh instance, so
 * nothing here touches real cookies or ~/.plannotator.
 */
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
    // The marker is versioned so a meaningful revision of the behavior or the
    // copy can re-introduce itself instead of being silently swallowed.
    installMemoryBackend({ 'plannotator-auto-viewed-notice-seen': '0' });
    expect(needsAutoViewedNotice()).toBe(true);
  });

  test("the notice's Turn off action actually turns the setting off", () => {
    // The load-bearing half of the toast: the copy is not pinned here (that
    // would snapshot prose), the ACTION's effect is.
    installMemoryBackend();
    const store = makeStore();
    expect(store.get('reviewAutoViewed')).toBe(true);
    turnOffAutoViewed(store);
    expect(store.get('reviewAutoViewed')).toBe(false);
    // Using the switch is proof of discovery — never explain it afterwards.
    expect(needsAutoViewedNotice()).toBe(false);
  });

  test('toggling the setting from a UI control also consumes the gate', () => {
    // Settings > Git and the file-list gear both route through here, so a
    // reviewer who turned the feature ON deliberately is not then told about
    // it the first time it fires.
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
    // Default-ON is the maintainer's decision; a broken cookie round-trip
    // would quietly turn the feature off for everyone on their next session.
    const values = installMemoryBackend();
    const store = makeStore();
    expect(store.get('reviewAutoViewed')).toBe(true);
    toggleAutoViewed(false, store);
    expect(values.get('plannotator-review-auto-viewed')).toBe('false');
    expect(makeStore().get('reviewAutoViewed')).toBe(false);
  });
});
