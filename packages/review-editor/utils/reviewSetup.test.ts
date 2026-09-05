import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { ConfigStoreForTest } from '../../ui/config/configStore';
import { setReviewPanelView } from '../../ui/config/reviewView';
import { initializeReviewSetup, needsReviewSetup } from './reviewSetup';

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

describe('initializeReviewSetup', () => {
  test('a fresh reviewer reaches setup once after normal settings startup', () => {
    installMemoryBackend();
    const store = makeStore();

    // Rendering reads settings before /api/diff initializes server config.
    // Neither step is evidence that the reviewer chose the registry default.
    store.get('displayName');
    store.init();

    expect(initializeReviewSetup(store)).toBe(true);
    expect(store.get('reviewPanelView')).toBe('tree');
    expect(store.get('reviewPanelViewLastUsed')).toBe('tree');
    expect(store.get('defaultDiffType')).toBe('since-base');
    expect(needsReviewSetup()).toBe(false);

    expect(initializeReviewSetup(store)).toBe(false);
    const nextSession = makeStore();
    nextSession.init();
    expect(initializeReviewSetup(nextSession)).toBe(false);
    expect(nextSession.get('reviewPanelView')).toBe('tree');
    expect(nextSession.get('reviewPanelViewLastUsed')).toBe('tree');
  });

  test('an unseen reviewer inherits an existing classic diff default', () => {
    installMemoryBackend({
      'plannotator-default-diff-type': 'uncommitted',
    });
    const store = makeStore();
    store.get('reviewPanelView');
    store.init();

    expect(initializeReviewSetup(store)).toBe(true);
    expect(store.get('reviewPanelView')).toBe('tree');
    expect(store.get('reviewPanelViewLastUsed')).toBe('tree');
    expect(store.get('defaultDiffType')).toBe('uncommitted');
  });

  test('first-run setup preserves the server diff default without writing it back', async () => {
    installMemoryBackend({
      'plannotator-default-diff-type': 'uncommitted',
    });
    const store = makeStore();
    const synced: Record<string, unknown>[] = [];
    store.setServerSync(payload => { synced.push(payload); });
    store.get('reviewPanelView');
    store.init({ diffOptions: { defaultDiffType: 'local-vs-remote' } });

    expect(initializeReviewSetup(store)).toBe(true);
    expect(store.get('reviewPanelView')).toBe('tree');
    expect(store.get('defaultDiffType')).toBe('local-vs-remote');

    await new Promise<void>(resolve => setTimeout(resolve, 350));
    expect(synced).toEqual([]);
  });

  test('an explicit persisted view survives a session that never tripped the seen gate', () => {
    // Non-git / workspace / PR / no-since-base sessions never reach the
    // initializer, so a reviewer can persist a view from Settings while
    // "seen" stays unset. The next plain git session must not seed over it.
    installMemoryBackend({
      'plannotator-review-panel-view-last-used': 'tree',
    });
    const settingsStore = makeStore();
    settingsStore.get('displayName');
    // Even choosing the built-in default is an explicit choice.
    setReviewPanelView('sections', undefined, settingsStore);

    const store = makeStore();
    store.init();

    expect(initializeReviewSetup(store)).toBe(false);
    expect(store.get('reviewPanelView')).toBe('sections');
    expect(store.get('reviewPanelViewLastUsed')).toBe('sections');
    expect(store.get('defaultDiffType')).toBe('since-base');
    // The one-time setup is consumed, so this cannot be re-evaluated later.
    expect(needsReviewSetup()).toBe(false);
  });

  test('a persisted Tree view is left alone rather than re-written', () => {
    installMemoryBackend({
      'plannotator-review-panel-view': 'tree',
      'plannotator-review-panel-view-last-used': 'sections',
    });
    const store = makeStore();
    store.init();

    expect(initializeReviewSetup(store)).toBe(false);
    expect(store.get('reviewPanelView')).toBe('tree');
    // The seeding path would have stamped 'tree' here; the memo is the
    // reviewer's, so a skipped seed must not touch it.
    expect(store.get('reviewPanelViewLastUsed')).toBe('sections');
    expect(needsReviewSetup()).toBe(false);
  });

  test('a returning reviewer keeps both the persisted view and last-used memo', () => {
    installMemoryBackend({
      'plannotator-review-setup-seen': 'true',
      'plannotator-review-panel-view': 'sections',
      'plannotator-review-panel-view-last-used': 'tree',
      'plannotator-default-diff-type': 'since-base',
    });
    const store = makeStore();
    store.get('reviewPanelView');
    store.init();

    expect(initializeReviewSetup(store)).toBe(false);
    expect(store.get('reviewPanelView')).toBe('sections');
    expect(store.get('reviewPanelViewLastUsed')).toBe('tree');
    expect(store.get('defaultDiffType')).toBe('since-base');
  });
});
