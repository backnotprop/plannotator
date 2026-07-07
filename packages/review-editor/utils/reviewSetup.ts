import { storage } from '@plannotator/ui/utils/storage';

/**
 * First-run gate for the code-review setup dialog (panel-view default + the
 * tree view's default diff type). Cookie-based, mirroring the plan app's
 * look-and-feel announcement gate.
 */
const SEEN_KEY = 'plannotator-review-setup-seen';

export function needsReviewSetup(): boolean {
  return storage.getItem(SEEN_KEY) !== 'true';
}

export function markReviewSetupSeen(): void {
  storage.setItem(SEEN_KEY, 'true');
}
