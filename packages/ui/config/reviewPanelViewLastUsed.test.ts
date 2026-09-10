import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { SETTINGS } from './settings';
import { ConfigStoreForTest } from './configStore';
import {
  getProviderReviewDefaultDiffType,
  setProviderReviewDefaultDiffType,
  setReviewDefaultDiffType,
  setReviewPanelView,
} from './reviewView';

function installMemoryBackend(): Map<string, string> {
  const values = new Map<string, string>();
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

/** Fresh store per test — never the singleton, which lives for the whole
 * bun process and must not be resolved against a throwaway backend. */
function makeStore() {
  const store = new ConfigStoreForTest();
  store.setServerSync(() => {}); // no /api/config in tests
  return store;
}

afterEach(() => {
  resetStorageBackend();
});

describe('reviewPanelViewLastUsed setting', () => {
  test('never persists commits: a commits (or junk) cookie reads as unset', () => {
    const values = installMemoryBackend();

    values.set('plannotator-review-panel-view-last-used', 'commits');
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBeUndefined();

    values.set('plannotator-review-panel-view-last-used', 'unexpected');
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBeUndefined();
  });

  test('round-trips sections/tree; the null default writes no cookie', () => {
    const values = installMemoryBackend();

    // ensureLoaded seeds unrecorded defaults through toCookie — null must
    // not materialize a cookie that a later fromCookie would misread.
    SETTINGS.reviewPanelViewLastUsed.toCookie(null);
    expect(values.has('plannotator-review-panel-view-last-used')).toBe(false);
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBeUndefined();

    SETTINGS.reviewPanelViewLastUsed.toCookie('tree');
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBe('tree');
    SETTINGS.reviewPanelViewLastUsed.toCookie('sections');
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBe('sections');
  });

  test('setReviewPanelView syncs last-used so an explicit Settings choice is not shadowed', () => {
    const values = installMemoryBackend();
    const store = makeStore();

    setReviewPanelView('tree', undefined, store);
    expect(store.get('reviewPanelViewLastUsed')).toBe('tree');
    expect(values.get('plannotator-review-panel-view-last-used')).toBe('tree');
  });

  test('recordLastUsed: false (the self-heal) repairs the pair without stomping the memo', () => {
    installMemoryBackend();
    const store = makeStore();

    setReviewPanelView('tree', undefined, store);
    setReviewPanelView('sections', { recordLastUsed: false }, store);

    // The pair was repaired...
    expect(store.get('reviewPanelView')).toBe('sections');
    expect(store.get('defaultDiffType')).toBe('since-base');
    // ...but the user's last-used view survived.
    expect(store.get('reviewPanelViewLastUsed')).toBe('tree');
  });

  test('keeps provider defaults independent and falls back to provider metadata', () => {
    installMemoryBackend();
    const store = makeStore();
    const jj = {
      id: 'jj',
      label: 'Jujutsu',
      defaultDiffType: 'jj-current',
      diffOptions: [
        { id: 'jj-current', label: 'Current', description: 'Current change' },
        { id: 'jj-line', label: 'Line', description: 'Line of work' },
      ],
      capabilities: { statusSections: false, staging: false, compareTarget: true },
    };

    expect(getProviderReviewDefaultDiffType(jj, store)).toBe('jj-current');
    setProviderReviewDefaultDiffType('jj', 'jj-line', store);
    expect(getProviderReviewDefaultDiffType(jj, store)).toBe('jj-line');
    expect(store.get('defaultDiffType')).toBe('since-base');
  });

  test('reads a provider-declared legacy setting without knowing the provider id', () => {
    installMemoryBackend();
    const store = makeStore();
    store.set('defaultDiffType', 'merge-base');
    const descriptor = {
      id: 'provider-with-legacy-setting',
      label: 'Provider',
      defaultDiffType: 'provider-default',
      diffOptions: [
        { id: 'provider-default', label: 'Default', description: 'Default mode' },
        { id: 'merge-base', label: 'Legacy', description: 'Legacy mode' },
      ],
      capabilities: { statusSections: false, staging: false, compareTarget: true },
      legacyDefaultSetting: 'defaultDiffType',
    };

    expect(getProviderReviewDefaultDiffType(descriptor, store)).toBe('merge-base');
  });

  test('local-vs-remote persists as a Tree-compatible default', () => {
    const values = installMemoryBackend();
    const store = makeStore();
    setReviewPanelView('sections', undefined, store);

    setReviewDefaultDiffType('local-vs-remote', store);

    expect(store.get('defaultDiffType')).toBe('local-vs-remote');
    expect(store.get('reviewPanelView')).toBe('tree');
    expect(values.get('plannotator-default-diff-type')).toBe('local-vs-remote');
  });
});
