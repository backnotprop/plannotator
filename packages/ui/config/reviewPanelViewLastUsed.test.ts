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

  const jj = {
    id: 'jj',
    label: 'Jujutsu',
    defaultDiffType: 'jj-current',
    diffOptions: [
      { id: 'jj-current', label: 'Current', description: 'Current change' },
      { id: 'jj-line', label: 'Line', description: 'Line of work' },
    ],
  };

  test('the Jujutsu default is its own value: Git writes never touch it, and it never touches Git', () => {
    installMemoryBackend();
    const store = makeStore();

    expect(getProviderReviewDefaultDiffType(jj, store)).toBe('jj-current');
    setProviderReviewDefaultDiffType('jj', 'jj-line', store);
    expect(getProviderReviewDefaultDiffType(jj, store)).toBe('jj-line');
    expect(store.get('defaultDiffType')).toBe('since-base');

    setReviewDefaultDiffType('merge-base', store);
    setReviewPanelView('sections', undefined, store);
    expect(getProviderReviewDefaultDiffType(jj, store)).toBe('jj-line');
    // Git stays on its original key only; no copy that could go stale.
    expect(store.get('reviewDefaults').git).toBeUndefined();
  });

  test('a Git-shaped or unknown saved jj value reads as jj-current', () => {
    installMemoryBackend();
    const store = makeStore();
    for (const bad of ['since-base', 'merge-base', 'jj-nope']) {
      setProviderReviewDefaultDiffType('jj', bad, store);
      expect(getProviderReviewDefaultDiffType(jj, store)).toBe('jj-current');
    }
  });

  test('settings saved before Jujutsu defaults keep working without a rewrite', () => {
    const values = installMemoryBackend();
    values.set('plannotator-default-diff-type', 'branch');
    const store = makeStore();
    // The old cookie, including its retired alias, is still the Git default.
    expect(store.get('defaultDiffType')).toBe('merge-base');
    // And the old config.json key still wins on load.
    store.init({ diffOptions: { defaultDiffType: 'unstaged' } });
    expect(store.get('defaultDiffType')).toBe('unstaged');
    expect(getProviderReviewDefaultDiffType(jj, store)).toBe('jj-current');
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

describe('reviewPanelView default', () => {
  test('a profile with no cookie resolves to Tree', () => {
    // Owner ruling (#1463 / #1474): the first-run "Set up your review view"
    // chooser is gone, so the registry default IS the opening view for a new
    // reviewer. Tree is also the view every diff type can render, which is
    // what makes the coupled (reviewPanelView, defaultDiffType) pair
    // consistent with no reconciliation.
    installMemoryBackend();
    const store = makeStore();

    expect(SETTINGS.reviewPanelView.fromCookie()).toBeUndefined();
    expect(store.get('reviewPanelView')).toBe('tree');
    // Nothing is snapped: the resolved diff default is untouched by the view.
    expect(store.get('defaultDiffType')).toBe('since-base');
  });

  test('an existing Git status cookie still wins over the new default', () => {
    // Failure caught: the default flip reaching reviewers who already chose
    // Git status — the one group this change must be invisible to.
    const values = installMemoryBackend();
    values.set('plannotator-review-panel-view', 'sections');
    const store = makeStore();

    expect(store.get('reviewPanelView')).toBe('sections');
  });
});
