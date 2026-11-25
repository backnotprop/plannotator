import { useEffect, useState } from 'react';
import { claimReviewWelcome, useFullInboxSwitch } from '../data/actions/fullInbox';
import { CodeReviewFeatures, CodeReviewOfferArt, pageHeading, useFirstFocusOnDialog } from './CodeReviewOffer';
import { Modal } from './Updates';

/**
 * The welcome to the Inbox for code review (the owner's mocks: round 2's "A, the switch row"; round 3's icon row
 * "D · Mix" and curator line, FINAL-WORDS.md): shown once, on the first load after `plannotator inbox --review` turned
 * the Inbox on here (settings `review_welcome`), and claimed as it opens, so no other window or load shows it again.
 * Code review's offer shell (`.ib-cro`: the static storm, the title, the four lines), then a switch row for the full
 * Inbox, off, and one button. The switch saves at once, as Settings' Full Inbox row does; "Start reviewing", Escape and
 * a click outside only close it. No keyboard shortcut.
 */
export function ReviewWelcome({ due, fullInbox, phone }: { due: boolean; fullInbox: boolean; phone: boolean }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!due || open || done) return;
    setOpen(true);
    claimReviewWelcome();
  }, [due, open, done]);
  if (!open || done) return null;
  return <ReviewWelcomeDialog fullInbox={fullInbox} phone={phone} onClose={() => setDone(true)} />;
}

function ReviewWelcomeDialog({ fullInbox, phone, onClose }: { fullInbox: boolean; phone: boolean; onClose: () => void }) {
  useFirstFocusOnDialog('review-welcome');
  const full = useFullInboxSwitch(fullInbox);
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
        <div className="ib-cro-acts ib-rwel-acts">
          <button type="button" className="ib-btn ib-pri" onClick={onClose} data-review-welcome-start="">
            Start reviewing
          </button>
        </div>
      </div>
    </Modal>
  );
}
