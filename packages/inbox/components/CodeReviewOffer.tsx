import { useEffect, useRef } from 'react';
import { playCodeReviewArt } from '../codeReviewOfferArt';
import { useReducedMotion } from '../tour/Tour';
import { Modal } from './Updates';

/**
 * Code review's one-time offer (approval "code-review-offer-card", 2026-11-06; the owner picked "Card"): a dialog over
 * the list with the brand kit's static storm on top, the title, what code review brings, and two buttons. Its words are
 * the owner's (the approval's 15:25Z addendum, take 1; the risk line joins with #2664).
 * "Turn on code review" turns Code review on, as Settings → Capabilities does; "Not now", Escape and a click outside
 * leave it off. Every way out is final (the claim already spent it); Settings is the way on later. No keyboard
 * shortcut. Its slot in the line: `CODE_REVIEW_OFFER` (packages/shared/inbox/reveals.ts); its moment:
 * codeReviewOffer.ts.
 */
export function CodeReviewOffer({ phone, onClose, onTurnOn }: { phone: boolean; onClose: () => void; onTurnOn: () => void }) {
  useFirstFocusOnDialog();
  return (
    <Modal labelledBy="ib-cro-title" describedBy="ib-cro-feats" testId="code-review-offer" onClose={onClose} ownKeys fallbackFocus={pageHeading} className={`ib-cro${phone ? ' ib-cro-phone' : ''}`}>
      <CodeReviewOfferArt phone={phone} />
      <div className="ib-cro-body">
        <h2 id="ib-cro-title">A new way to review</h2>
        <ul className="ib-cro-feats" id="ib-cro-feats">
          {/* The risk line goes first, when #2664 (risk filters) merges: "Filter PRs by your own risk rules". */}
          <li>
            <MapIcon />
            <span>A review curator walks you through each change</span>
          </li>
          <li>
            <BoardIcon />
            <span>
              See each change as a <b className="ib-cro-name">Shape</b>, and where it lands in your <b className="ib-cro-name">System</b>
            </span>
          </li>
        </ul>
        <div className="ib-cro-acts">
          <button type="button" className="ib-btn ib-ghost" onClick={onClose} data-code-review-offer-close="">
            Not now
          </button>
          <span className="ib-bsp" />
          <button type="button" className="ib-btn ib-pri" onClick={onTurnOn} data-code-review-offer-on="">
            Turn on code review
          </button>
        </div>
        <p className="ib-cro-note">You can change this in Settings.</p>
      </div>
    </Modal>
  );
}

/** Focus after the dialog when nothing focusable opened it (it opens at once on a fresh load): the page's heading. */
function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('.ib-main h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}

/**
 * First focus on the dialog itself, as the approved Card does: its name is read, no ring shows on a button until the
 * keyboard moves, and Enter turns nothing on by itself. `Modal` focused the primary button first (a child's effect runs
 * before this one) and keeps the opener to give focus back. Tab from the dialog goes to its first button, Shift+Tab to
 * its last, so focus never leaves it.
 */
function useFirstFocusOnDialog() {
  useEffect(() => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-dialog="code-review-offer"]');
    if (!dialog) return;
    dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || document.activeElement !== dialog) return;
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      const to = event.shiftKey ? buttons[buttons.length - 1] : buttons[0];
      if (!to) return;
      event.preventDefault();
      to.focus();
    };
    dialog.addEventListener('keydown', onKey);
    return () => dialog.removeEventListener('keydown', onKey);
  }, []);
}

/** The static storm, cracked open around one sorted column. Decoration only. */
function CodeReviewOfferArt({ phone }: { phone: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const still = useReducedMotion();
  useEffect(() => {
    if (!canvas.current) return;
    return playCodeReviewArt(canvas.current, { unit: phone ? 11 : 14, seed: 7, cx: 0.5 }, still);
  }, [phone, still]);
  return (
    <div className="ib-cro-art" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}

/** A folded map: the walk through the change. */
function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z" />
    </svg>
  );
}

/** A board of boxes and lines: the change drawn. */
function BoardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4.5" width="7.5" height="6" rx="1.2" />
      <rect x="13.5" y="4.5" width="7.5" height="9" rx="1.2" />
      <rect x="3" y="14" width="7.5" height="5.5" rx="1.2" />
      <path d="M10.5 7.5h3M7 10.5V14" />
    </svg>
  );
}
