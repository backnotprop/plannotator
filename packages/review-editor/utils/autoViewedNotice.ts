import {
  configStore,
  markAutoViewedNoticeSeen,
  needsAutoViewedNotice,
  setReviewAutoViewed,
} from '@plannotator/ui/config';

/**
 * The gate itself (cookie key + version) lives beside the setting in `@plannotator/ui/config`
 * because BOTH setting writers — Settings → Review and the file-list gear popover — must consume
 * it: someone who found the switch has demonstrably discovered the feature and must never be told
 * about it.
 */
export { needsAutoViewedNotice, markAutoViewedNoticeSeen };

export function turnOffAutoViewed(store: typeof configStore = configStore): void {
  setReviewAutoViewed(false, store);
}

export function toggleAutoViewed(next: boolean, store: typeof configStore = configStore): void {
  setReviewAutoViewed(next, store);
}
