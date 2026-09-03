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
 * Latch the pending flag at mount. PURE, like its `needsEditModeAnnouncement()
 * && !configStore.get('editSuggestions')` sibling: a React state initializer
 * can run more than once (StrictMode, a re-render before the store commits),
 * so the cookie write that goes with this decision lives in an effect
 * (`shouldConsumeTokenHoverAnnouncement` below), never here.
 *
 * A non-default trigger means the user has already answered the only question
 * this dialog asks. After the boolean-to-trigger migration that is exactly the
 * early adopter who turned cards off with the old switch, and telling someone
 * about a feature they already declined is the worst version of this dialog.
 */
export function resolveTokenHoverAnnouncementPending(): boolean {
  return needsTokenHoverAnnouncement() && configStore.get('tokenHoverTrigger') === 'hover';
}

/**
 * True when the announcement should be retired without ever being shown: the
 * reviewer already expressed the preference it exists to collect, so it has no
 * reason to come back. The App runs this once in an effect and marks it seen.
 *
 * Distinct from a session that merely CANNOT run hover cards (a GitButler
 * stack view), which skips the dialog while deliberately keeping the cookie.
 */
export function shouldConsumeTokenHoverAnnouncement(): boolean {
  return needsTokenHoverAnnouncement() && configStore.get('tokenHoverTrigger') !== 'hover';
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
