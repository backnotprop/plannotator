import { useEffect, useRef } from 'react';
import { inboxApi } from '../api';
import { playCodeReviewArt } from '../codeReviewOfferArt';
import { useReducedMotion } from '../tour/Tour';
import { Modal } from './Updates';

/**
 * Code review's one-time offer (approval "code-review-offer-card", 2026-11-06; the owner picked "Card"): a dialog over
 * the list with the brand kit's static storm on top, the title, what code review brings, and two buttons. Its four
 * lines and their icons are the owner's (approval "inbox-code-review-offer", 2026-11-23: icon row "D · Mix" and the
 * curator line chosen from three; the old line naming Shape and System is gone).
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
        <CodeReviewFeatures id="ib-cro-feats" />
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

/** App's offer, open: Not now (Escape, a click outside) is final, and the line's next offer waits three days. */
export function CodeReviewOfferOpen({ phone, close, onTurnOn }: { phone: boolean; close: () => void; onTurnOn: () => void }) {
  return (
    <CodeReviewOffer
      phone={phone}
      onClose={() => {
        void inboxApi.revealNotNow('code_review');
        close();
      }}
      onTurnOn={onTurnOn}
    />
  );
}

/**
 * What code review brings, the four lines in the owner's order with their icons (row "D · Mix"): the offer's and the
 * welcome dialog's (ReviewWelcome.tsx, approval round 3 of the review-only Inbox), one list.
 */
export function CodeReviewFeatures({ id }: { id: string }) {
  return (
    <ul className="ib-cro-feats" id={id}>
      <li>
        <RiskIcon />
        <span>Filter PRs by your own risk rules</span>
      </li>
      <li>
        <CuratorIcon />
        <span>A review curator works with you on everything you ship</span>
      </li>
      <li>
        <MapIcon />
        <span>A guided review walks you through each change</span>
      </li>
      <li>
        <PicturesIcon />
        <span>Big pictures of what changed and why</span>
      </li>
    </ul>
  );
}

/** Focus after the dialog when nothing focusable opened it (it opens at once on a fresh load): the page's heading. */
export function pageHeading(): HTMLElement | null {
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
export function useFirstFocusOnDialog(testId = 'code-review-offer') {
  useEffect(() => {
    const dialog = document.querySelector<HTMLDialogElement>(`dialog[data-dialog="${testId}"]`);
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
  }, [testId]);
}

/** The static storm, cracked open around one sorted column. Decoration only. */
export function CodeReviewOfferArt({ phone }: { phone: boolean }) {
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

/*
 * The four icons (approval "inbox-code-review-offer", row "D · Mix"): drawn by `.ib-cro-feats svg` (18 px, stroke
 * 1.5, no fill); a child's own `stroke-width` or `opacity` overrides it for that child only.
 */

/** Three risk bars at Medium, as the product draws risk: two solid, the third faint. Drawn for this row. */
function RiskIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path strokeWidth="2.25" d="M6 19.5v-4.5M12 19.5v-9" />
      <path strokeWidth="2.25" opacity=".38" d="M18 19.5V5.25" />
    </svg>
  );
}

/** A stack of work with the front item checked: the review curator. Drawn for this row. */
function CuratorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.5 3.75h9M5.25 7.125h13.5" />
      <rect x="3" y="10.5" width="18" height="9.75" rx="1.5" />
      <path d="m9 15.375 2.25 2.25 3.75-4.5" />
    </svg>
  );
}

/** A folded map: the guided review (Heroicons outline `map`, MIT; the same path as inbox-thread/icons.tsx). */
function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z" />
    </svg>
  );
}

/** Two linked boxes: the big pictures (lucide `workflow`, ISC, drawn at the row's 1.5 stroke). */
function PicturesIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect width="8" height="8" x="13" y="13" rx="2" />
    </svg>
  );
}
