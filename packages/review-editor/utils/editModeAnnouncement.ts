import { storage } from '@plannotator/ui/utils/storage';
import { configStore } from '@plannotator/ui/config';

/**
 * One-time gate for the Edit Mode (edit-to-suggest) announcement dialog.
 * Cookie-backed like the other announcement gates, so the dismissal survives
 * Plannotator's random localhost ports.
 */
const STORAGE_KEY = 'plannotator-edit-mode-announcement-seen';
// Bump to re-show the announcement after a meaningful revision.
// '3': shimmer label on the enable switch. '2': footer redesigned from a Turn it on / Keep it off button pair to an
// explicit enable switch plus a neutral Done (pre-release, so nobody re-sees).
const CURRENT_VERSION = '3';

export function needsEditModeAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markEditModeAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

/**
 * "Turn it on": persist the real Settings > Editor "Edit Code to Suggest"
 * setting, then mark the announcement seen. Either dialog action marks the
 * announcement seen; only this one changes the setting.
 */
export function enableEditSuggestionsFromAnnouncement(): void {
  configStore.set('editSuggestions', true);
  markEditModeAnnouncementSeen();
}

export interface EditModeAnnouncementGateState {
  /** Latched at mount: the announcement cookie is unseen and the setting is off. */
  announcementPending: boolean;
  /** The app is still fetching its initial diff. */
  isLoading: boolean;
  /** Guided-review intro dialog is visible (first in the chain). */
  guideIntroVisible: boolean;
  /** Look-and-feel announcement is pending (second in the chain). */
  lookAndFeelVisible: boolean;
  /** Review setup chooser is open (third in the chain). */
  reviewSetupVisible: boolean;
}

/**
 * Chain gate for the announcement dialog. It is LAST in the first-run dialog
 * chain (guide intro, then look-and-feel, review setup, then this) and
 * must never stack with any of them. Waiting for isLoading to clear matters:
 * showReviewSetup only latches during the initial diff load, so rendering
 * earlier could flash this dialog under a chain that is about to open.
 */
export function editModeAnnouncementCanShow(state: EditModeAnnouncementGateState): boolean {
  return (
    state.announcementPending &&
    !state.isLoading &&
    !state.guideIntroVisible &&
    !state.lookAndFeelVisible &&
    !state.reviewSetupVisible
  );
}
