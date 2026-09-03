import { storage } from '@plannotator/ui/utils/storage';
import { configStore } from '@plannotator/ui/config';

/**
 * One-time gate for the token hover card announcement dialog. Cookie-backed
 * like the other announcement gates, so the dismissal survives Plannotator's
 * random localhost ports.
 */
const STORAGE_KEY = 'plannotator-token-hover-announcement-seen';
// Bump to re-show the announcement after a meaningful revision.
const CURRENT_VERSION = '1';

export function needsTokenHoverAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markTokenHoverAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

/**
 * Latch the pending flag at mount.
 *
 * A non-default trigger means the user has already answered the only question
 * this dialog asks. After the boolean-to-trigger migration that is exactly the
 * early adopter who turned cards off with the old switch, and telling someone
 * about a feature they already declined is the worst version of this dialog.
 * The cookie IS consumed in that case: the preference exists, so the dialog
 * has no reason to come back.
 */
export function resolveTokenHoverAnnouncementPending(): boolean {
  if (!needsTokenHoverAnnouncement()) return false;
  if (configStore.get('tokenHoverTrigger') !== 'hover') {
    markTokenHoverAnnouncementSeen();
    return false;
  }
  return true;
}

export interface TokenHoverAnnouncementGateState {
  /** Latched at mount by resolveTokenHoverAnnouncementPending. */
  announcementPending: boolean;
  /** The app is still fetching its initial diff. */
  isLoading: boolean;
  /**
   * Hover cards are possible in this session at all. A GitButler stack or
   * branch view has no live workspace, so there is nothing to announce; the
   * cookie is deliberately NOT consumed for that (see the dialog wiring), so
   * the next ordinary review still shows it.
   */
  featureAvailable: boolean;
  /** Guided-review intro dialog is visible (first in the chain). */
  guideIntroVisible: boolean;
  /** Look-and-feel announcement is pending (second in the chain). */
  lookAndFeelVisible: boolean;
  /** Review setup chooser is open (third in the chain). */
  reviewSetupVisible: boolean;
  /** Edit Mode announcement is visible (fourth in the chain). */
  editModeVisible: boolean;
}

/**
 * Chain gate for the announcement dialog. It is LAST in the first-run dialog
 * chain (guide intro, look-and-feel, review setup, edit mode, then this) and
 * must never stack with any of them. Waiting for isLoading to clear matters:
 * showReviewSetup only latches during the initial diff load, so rendering
 * earlier could flash this dialog under a chain that is about to open.
 */
export function tokenHoverAnnouncementCanShow(
  state: TokenHoverAnnouncementGateState,
): boolean {
  return (
    state.announcementPending &&
    state.featureAvailable &&
    !state.isLoading &&
    !state.guideIntroVisible &&
    !state.lookAndFeelVisible &&
    !state.reviewSetupVisible &&
    !state.editModeVisible
  );
}
