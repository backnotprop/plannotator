import {
  configStore,
  markAutoViewedNoticeSeen,
  needsAutoViewedNotice,
  setReviewAutoViewed,
} from '@plannotator/ui/config';

export { needsAutoViewedNotice, markAutoViewedNoticeSeen };

export function turnOffAutoViewed(store: typeof configStore = configStore): void {
  setReviewAutoViewed(false, store);
}

export function toggleAutoViewed(next: boolean, store: typeof configStore = configStore): void {
  setReviewAutoViewed(next, store);
}
