import { storage } from '@plannotator/ui/utils/storage';
import { configStore, getPersistedReviewPanelView, setReviewPanelView } from '@plannotator/ui/config';

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

/**
 * Seed the setup choice for a genuinely new reviewer and mark the one-time
 * setup as consumed. Returning reviewers are left completely untouched so
 * their persisted view and last-used memo keep deciding the opening panel.
 *
 * @returns Whether the caller should show the first-run setup dialog.
 */
export function initializeReviewSetup(store: typeof configStore = configStore): boolean {
  if (!needsReviewSetup()) return false;

  // The seen cookie is not the only evidence of a returning reviewer. Sessions
  // that never reach this gate (non-git, workspace, PR, or no since-base) still
  // let Settings persist a panel view, so a reviewer can hold an explicit
  // choice while "seen" stays unset. Seeding Tree there would overwrite it.
  // A persisted view IS the decision: consume the one-time setup and leave it.
  if (getPersistedReviewPanelView() !== undefined) {
    markReviewSetupSeen();
    return false;
  }

  // Selecting Tree preserves whichever defaultDiffType the store resolved.
  // The shared setter also records Tree as last-used, so accepting the dialog
  // opens this first review in Tree without writing server-backed config.
  setReviewPanelView('tree', undefined, store);
  markReviewSetupSeen();
  return true;
}
