import { useFullInboxSwitch } from '../data/actions/fullInbox';
import { CodeReviewFeatures, CodeReviewOfferArt, pageHeading, useFirstFocusOnDialog } from './CodeReviewOffer';
import { Modal } from './Updates';

/**
 * The welcome to the Inbox for code review (the owner's mocks: round 2's "A, the switch row"; round 3's icon row
 * "D · Mix" and curator line, FINAL-WORDS.md). A dialog of the line (`review_welcome`, reviewOnly.ts
 * `useReviewWelcome`): App draws it only once its claim answered that this is the first showing ever. Code review's
 * offer shell (`.ib-cro`: the static storm, the title, the four lines), then a switch row for the full Inbox, off, and
 * one button. The switch saves at once, as Settings' Full Inbox row does; a save that fails puts it back and says so
 * (Settings' own words for a setting not saved). "Start reviewing", Escape and a click outside only close it. No
 * keyboard shortcut.
 */
export function ReviewWelcome({ fullInbox, phone, onClose, save }: { fullInbox: boolean; phone: boolean; onClose: () => void; save?: Parameters<typeof useFullInboxSwitch>[1] }) {
  useFirstFocusOnDialog('review-welcome');
  const full = useFullInboxSwitch(fullInbox, save);
  return (
    <Modal labelledBy="ib-rwel-title" describedBy="ib-rwel-feats" testId="review-welcome" onClose={onClose} ownKeys fallbackFocus={pageHeading} className={`ib-cro ib-rwel${phone ? ' ib-cro-phone' : ''}`}>
      <CodeReviewOfferArt phone={phone} />
      <div className="ib-cro-body">
        <h2 id="ib-rwel-title">Welcome to the code review Inbox</h2>
        <CodeReviewFeatures id="ib-rwel-feats" />
        <div className="ib-rwel-full">
          <span className="ib-txt">
            <span className="ib-l" id="ib-rwel-full-label">
              The full Plannotator Inbox
            </span>
            <span className="ib-desc" id="ib-rwel-full-desc">
              Your agents send you questions, decisions and finished work. It's off for now: turn it on here, or any time in Settings.
            </span>
          </span>
          <button
            type="button"
            role="switch"
            className="ib-sw"
            aria-checked={full.on}
            aria-labelledby="ib-rwel-full-label"
            aria-describedby="ib-rwel-full-desc"
            onClick={full.toggle}
            data-review-welcome-full=""
          />
        </div>
        {full.failed && (
          <p className="ib-rwel-failed" role="alert" data-review-welcome-failed="">
            The setting was not saved.
          </p>
        )}
        <div className="ib-cro-acts ib-rwel-acts">
          <button type="button" className="ib-btn ib-pri" onClick={onClose} data-review-welcome-start="">
            Start reviewing
          </button>
        </div>
      </div>
    </Modal>
  );
}
