import { configStore } from './configStore';
import { SETTINGS } from './settings';

/**
 * The ONLY writers for the coupled setting pair (reviewPanelView,
 * defaultDiffType).
 *
 * Invariant: the Sections (Git status) view can only render the since-base
 * diff. So:
 *   - choosing the sections view forces defaultDiffType = 'since-base'
 *   - choosing a non-since-base default diff snaps the view to 'tree'
 *   - tree + since-base IS valid — switching to Tree leaves the diff, and
 *     choosing since-base leaves the view
 *
 * Hand-mirroring these rules at call sites is how the split-brain bug
 * happened (a writer persisted one half of the pair; configStore.init()
 * then re-corrupted it from the server every session). Never write either
 * setting directly — always go through these setters. configStore.init()
 * remains the one non-writer that can produce a conflicted pair from a
 * stale config.json; the App-level load reconciler heals that case by
 * calling setReviewPanelView('sections', { recordLastUsed: false }).
 */

/** Store seam for tests (fresh ConfigStoreForTest); production always uses the singleton. */
type PanelViewConfigStore = typeof configStore;

export function setReviewPanelView(
  view: 'sections' | 'tree',
  options?: { recordLastUsed?: boolean },
  store: PanelViewConfigStore = configStore,
): void {
  store.set('reviewPanelView', view);
  // An explicit persisted choice also becomes the last-used view — otherwise
  // a stale last-used cookie would immediately shadow what the user just
  // picked in Settings / the setup dialog. recordLastUsed: false is for
  // NON-choices: the App self-heal repairs a conflicted persisted pair
  // without any user action, so it must not overwrite the user's memo.
  if (options?.recordLastUsed !== false) {
    store.set('reviewPanelViewLastUsed', view);
  }
  if (view === 'sections' && store.get('defaultDiffType') !== 'since-base') {
    store.set('defaultDiffType', 'since-base');
  }
}

/**
 * The panel view the reviewer has actually persisted, or `undefined` when they
 * never chose one. Distinct from `configStore.get('reviewPanelView')`, which
 * cannot tell a stored choice apart from the built-in default, which is the
 * difference first-run seeding has to respect before it writes over anything.
 */
export function getPersistedReviewPanelView(): 'sections' | 'tree' | undefined {
  return SETTINGS.reviewPanelView.fromCookie();
}

export type ReviewDefaultDiffType =
  | 'since-base'
  | 'uncommitted'
  | 'unstaged'
  | 'staged'
  | 'merge-base'
  | 'all';

export function setReviewDefaultDiffType(
  value: ReviewDefaultDiffType,
  store: PanelViewConfigStore = configStore,
): void {
  store.set('defaultDiffType', value);
  if (value !== 'since-base' && store.get('reviewPanelView') !== 'tree') {
    store.set('reviewPanelView', 'tree');
    // The snap is an explicit-choice consequence (the user picked a classic
    // diff default), so it syncs the memo like any explicit view write.
    store.set('reviewPanelViewLastUsed', 'tree');
  }
}
