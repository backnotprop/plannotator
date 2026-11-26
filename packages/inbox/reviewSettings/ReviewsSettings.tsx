/**
 * Settings → Reviews in the Inbox: code review's own Settings → Reviews page
 * (@plannotator/ui `ReviewSettingsPage`), hosted through its seams, never a
 * copy: the Inbox's controls (InboxReviewControls.tsx), its writer and its
 * rows (inboxReviewSettings.ts). A chunk of its own (`#reviews-settings`,
 * lazyParts.tsx), so the window's first paint never carries it.
 */
import { ReviewSettingsPage } from '@plannotator/ui/components/settings/ReviewSettingsPage';
import { SEM_DIFF_OPINION_SETTINGS_ROUTE } from '@plannotator/ui/components/settings/PowerUpSettings';
import { INBOX_REVIEW_SETTINGS_CONTROLS, InboxReviewPhone } from './InboxReviewControls';
import { INBOX_REVIEW_ROWS, inboxOpinionFetch, inboxReviewSettingChange } from './inboxReviewSettings';

export interface ReviewsSettingsProps {
  /** A phone draws every diff Unified, so the page offers no Split or Unified; its choice lists open as sheets. */
  phone?: boolean;
}

export default function ReviewsSettings({ phone = false }: ReviewsSettingsProps) {
  return (
    <div className="ib-rs" data-settings-reviews="">
      <InboxReviewPhone.Provider value={phone}>
        <ReviewSettingsPage
          controls={INBOX_REVIEW_SETTINGS_CONTROLS}
          opinionRoute={SEM_DIFF_OPINION_SETTINGS_ROUTE}
          opinionFetch={inboxOpinionFetch}
          onChange={inboxReviewSettingChange}
          rows={INBOX_REVIEW_ROWS}
          isCompactTouchLayout={phone}
        />
      </InboxReviewPhone.Provider>
    </div>
  );
}
