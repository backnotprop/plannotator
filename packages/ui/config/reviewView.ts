import { configStore } from './configStore';
import { SETTINGS } from './settings';
import { storage } from '../utils/storage';

export interface ReviewSettingsDiffOption {
  id: string;
  label: string;
  description: string;
}

/** The default-diff choices Settings → Review offers for one VCS. */
export interface VcsReviewSettingsDescriptor {
  id: string;
  label: string;
  defaultDiffType: string;
  diffOptions: ReviewSettingsDiffOption[];
}

/** Invariant: the Sections (Git status) view can only render the since-base diff. */

type PanelViewConfigStore = typeof configStore;

export function setReviewPanelView(
  view: 'sections' | 'tree',
  options?: { recordLastUsed?: boolean },
  store: PanelViewConfigStore = configStore,
): void {
  store.set('reviewPanelView', view);
  if (options?.recordLastUsed !== false) {
    store.set('reviewPanelViewLastUsed', view);
  }
  if (view === 'sections' && store.get('defaultDiffType') !== 'since-base') {
    store.set('defaultDiffType', 'since-base');
  }
}

/** The panel view the reviewer has actually persisted, or `undefined` when they never chose one. */
export function getPersistedReviewPanelView(): 'sections' | 'tree' | undefined {
  return SETTINGS.reviewPanelView.fromCookie();
}

export type ReviewDefaultDiffType =
  | 'since-base'
  | 'local-vs-remote'
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
    store.set('reviewPanelViewLastUsed', 'tree');
  }
}

/** The saved default diff for a VCS other than Git (today: Jujutsu), read from `reviewDefaults[id]`. */
export function getProviderReviewDefaultDiffType(
  descriptor: VcsReviewSettingsDescriptor,
  store: PanelViewConfigStore = configStore,
): string {
  const configured = store.get('reviewDefaults')[descriptor.id]?.defaultDiffType;
  return configured && descriptor.diffOptions.some((option) => option.id === configured)
    ? configured
    : descriptor.defaultDiffType;
}

export function setProviderReviewDefaultDiffType(
  providerId: string,
  value: string,
  store: PanelViewConfigStore = configStore,
): void {
  store.set('reviewDefaults', {
    ...store.get('reviewDefaults'),
    [providerId]: { defaultDiffType: value },
  });
}

const AUTO_VIEWED_NOTICE_SEEN_KEY = 'plannotator-auto-viewed-notice-seen';
const AUTO_VIEWED_NOTICE_VERSION = '1';

export function needsAutoViewedNotice(): boolean {
  return storage.getItem(AUTO_VIEWED_NOTICE_SEEN_KEY) !== AUTO_VIEWED_NOTICE_VERSION;
}

export function markAutoViewedNoticeSeen(): void {
  storage.setItem(AUTO_VIEWED_NOTICE_SEEN_KEY, AUTO_VIEWED_NOTICE_VERSION);
}

/** The only writer of `reviewAutoViewed` outside the notice's own "Turn off" action. */
export function setReviewAutoViewed(
  value: boolean,
  store: PanelViewConfigStore = configStore,
): void {
  markAutoViewedNoticeSeen();
  store.set('reviewAutoViewed', value);
}
