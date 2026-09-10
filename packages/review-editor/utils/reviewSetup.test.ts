import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { ConfigStoreForTest } from '../../ui/config/configStore';
import { setReviewPanelView } from '../../ui/config/reviewView';
import {
  initializeReviewSetup,
  needsReviewSetup,
  shouldOfferReviewSetup,
  shouldRepairPanelPair,
} from './reviewSetup';
import type { ReviewSetupSession } from './reviewSetup';

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

function plainGitSession(overrides: Partial<ReviewSetupSession> = {}): ReviewSetupSession {
  return {
    hasGitContext: true,
    isWorkspace: false,
    isPR: false,
    vcsType: 'git',
    sinceBaseAvailable: true,
    ...overrides,
  };
}

describe('shouldOfferReviewSetup', () => {
  test('a caller-pinned session never offers the dialog', () => {
    // Failure caught: a pinned session opening a dialog whose dismiss handler
    // runs handleDiffSwitch(defaultDiffType) — silently discarding --base /
    // --diff-type.
    expect(shouldOfferReviewSetup(plainGitSession({ openStatePinned: true }))).toBe(false);
  });

  test('an ordinary plain-git session still offers it', () => {
    // Failure caught: over-broad guards silently disabling first-run setup
    // for everyone.
    expect(shouldOfferReviewSetup(plainGitSession())).toBe(true);
    expect(shouldOfferReviewSetup(plainGitSession({ openStatePinned: false }))).toBe(true);
  });

  test('the pre-existing disqualifiers still apply', () => {
    expect(shouldOfferReviewSetup(plainGitSession({ hasGitContext: false }))).toBe(false);
    expect(shouldOfferReviewSetup(plainGitSession({ isWorkspace: true }))).toBe(false);
    expect(shouldOfferReviewSetup(plainGitSession({ isPR: true }))).toBe(false);
    expect(shouldOfferReviewSetup(plainGitSession({ vcsType: 'jj' }))).toBe(false);
    expect(shouldOfferReviewSetup(plainGitSession({ sinceBaseAvailable: false }))).toBe(false);
  });

  test('a pinned mount leaves the one-time seen cookie unset', () => {
    // Failure caught: burning the reviewer's one-time setup on a session that
    // never showed it — the reason the predicate must precede (and
    // short-circuit past) initializeReviewSetup() in App's && chain.
    installMemoryBackend();
    const store = makeStore();
    const offered =
      shouldOfferReviewSetup(plainGitSession({ openStatePinned: true })) &&
      initializeReviewSetup(store);
    expect(offered).toBe(false);
    expect(needsReviewSetup()).toBe(true);
  });

  test('App composes the predicate BEFORE initializeReviewSetup in the && chain', () => {
    // Source-level pin: initializeReviewSetup() consumes the seen cookie as a
    // side effect of being CALLED, so ordering (not just the boolean result)
    // is the implementation. A refactor that calls initializeReviewSetup()
    // first would pass every pure test above while still burning the cookie.
    const appSource = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf-8');
    expect(appSource).toMatch(/shouldOfferReviewSetup\(\{[\s\S]{0,400}?\}\)\s*&&\s*initializeReviewSetup\(\)/);
  });
});

describe('shouldRepairPanelPair', () => {
  const conflictedPair = {
    openStatePinned: false,
    sectionsCapable: true,
    isFirstRunSetup: false,
    persistedPanelView: 'sections',
    defaultDiffType: 'uncommitted',
  };

  test('a caller-pinned session never repairs (no settings write, no diff override)', () => {
    // Failure caught: a config.json write and a handleDiffSwitch('since-base')
    // triggered by a session defined by writing nothing.
    expect(shouldRepairPanelPair({ ...conflictedPair, openStatePinned: true })).toBe(false);
  });

  test('an unpinned conflicted pair still self-heals', () => {
    // Failure caught: over-broad guards silently disabling the repair for
    // everyone.
    expect(shouldRepairPanelPair(conflictedPair)).toBe(true);
  });

  test('a consistent pair, first-run, or sections-incapable session does not repair', () => {
    expect(shouldRepairPanelPair({ ...conflictedPair, defaultDiffType: 'since-base' })).toBe(false);
    expect(shouldRepairPanelPair({ ...conflictedPair, isFirstRunSetup: true })).toBe(false);
    expect(shouldRepairPanelPair({ ...conflictedPair, sectionsCapable: false })).toBe(false);
    expect(shouldRepairPanelPair({ ...conflictedPair, persistedPanelView: 'tree' })).toBe(false);
  });
});
