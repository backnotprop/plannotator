import {
  configStore,
  markAutoViewedNoticeSeen,
  needsAutoViewedNotice,
  setReviewAutoViewed,
} from '@plannotator/ui/config';

/**
 * Review-side facade for the auto-mark-viewed first-time notice.
 *
 * The gate itself (cookie key + version) lives beside the setting in
 * `@plannotator/ui/config` because BOTH setting writers — Settings > Git and
 * the file-list gear popover — must consume it: someone who found the switch
 * has demonstrably discovered the feature and must never be told about it.
 * This module is the review app's entry point to it, plus the one action the
 * toast itself offers.
 */
export { needsAutoViewedNotice, markAutoViewedNoticeSeen };

/** The notice's "Turn off" action. */
export function turnOffAutoViewed(store: typeof configStore = configStore): void {
  setReviewAutoViewed(false, store);
}

/**
 * Flip the setting from a UI control (Settings, the gear popover). Consumes
 * the notice gate — see above.
 */
export function toggleAutoViewed(next: boolean, store: typeof configStore = configStore): void {
  setReviewAutoViewed(next, store);
}
