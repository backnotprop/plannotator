import { Fragment } from 'react';
import { Modal } from './Updates';

/** The words of the grill-me tip. Every `/grill-me` in them is drawn as inline code. */
export interface GrillMeTipCopy {
  title: string;
  body: string;
  /** The muted second line. */
  reach: string;
}

/** Variant A, the one shown (DRAFT: the words wait on the owner's OK). */
export const GRILL_ME_TIP_COPY_A: GrillMeTipCopy = {
  title: 'Have you tried /grill-me?',
  body: 'Plannotator gives grill-me an optimized experience: its questions come to your Inbox as cards you can answer anytime.',
  reach: 'Nothing to turn on. Works with any grill-me skill, in Claude Code, Pi and OpenCode.',
};

/** Variant B, kept for the owner to swap in (`GRILL_ME_TIP_COPY`). */
export const GRILL_ME_TIP_COPY_B: GrillMeTipCopy = {
  title: '/grill-me, in your Inbox',
  body: 'Run /grill-me and its interview comes here, one card per question: pick an answer, add a note, take your time.',
  reach: 'Plannotator does this for any grill-me skill. Nothing to turn on.',
};

/** The words the card shows. */
export const GRILL_ME_TIP_COPY: GrillMeTipCopy = GRILL_ME_TIP_COPY_A;

/** The picture: one question card as the Inbox draws it (decorative). */
export const GRILL_ME_TIP_ART = {
  question: 'How should dark mode turn on?',
  choices: ['Follow the system setting only', 'A toggle only', 'Follow the system, plus a toggle'],
  /** The choice marked Recommended (its index). */
  recommended: 2,
  meta: 'grill-me · 1 of a few · answer anytime',
} as const;

const COMMAND = '/grill-me';

/** A line of the copy, each `/grill-me` as inline code. */
function withCommand(text: string) {
  return text.split(COMMAND).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <code>{COMMAND}</code>}
      {part}
    </Fragment>
  ));
}

/**
 * The grill-me tip (DRAFT; the owner, 2026-11-08: "similar to the bro mode pop-up ... have you tried /grill-me yet?
 * ... There's nothing to turn on"): a one-time card of the line (reveals.ts `grill_me_tip`) on Bro mode's card (navy,
 * dot grid, the Experimental chip), with a small picture of one question card. Nothing to turn on, so one button:
 * "Got it". Escape and a click outside close it too; every way out is final, as the claim already stamped it. No
 * keyboard shortcut.
 */
export function GrillMeTip({ phone, onClose, copy = GRILL_ME_TIP_COPY }: { phone: boolean; onClose: () => void; copy?: GrillMeTipCopy }) {
  return (
    <Modal labelledBy="ib-gm-title" describedBy="ib-gm-desc" testId="grill-me-tip" onClose={onClose} ownKeys className={`ib-bi ib-bro ib-gm${phone ? ' ib-bi-phone' : ''}`}>
      <h2 id="ib-gm-title">{withCommand(copy.title)}</h2>
      <span className="ib-chip ib-bro-exp" data-grill-me-tip-experimental="">
        Experimental
      </span>
      <div className="ib-gm-art" aria-hidden="true">
        <p className="q">{GRILL_ME_TIP_ART.question}</p>
        <ul>
          {GRILL_ME_TIP_ART.choices.map((choice, i) =>
            i === GRILL_ME_TIP_ART.recommended ? (
              <li key={choice} className="rec">
                {choice} <span className="tag">Recommended</span>
              </li>
            ) : (
              <li key={choice}>{choice}</li>
            ),
          )}
        </ul>
        <div className="meta">{GRILL_ME_TIP_ART.meta}</div>
      </div>
      <div className="ib-bi-text">
        <p id="ib-gm-desc">{withCommand(copy.body)}</p>
        <p className="ib-bro-reach">{withCommand(copy.reach)}</p>
      </div>
      <div className="ib-bi-acts">
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri ib-bi-copy" onClick={onClose} data-grill-me-tip-ok="">
          Got it
        </button>
      </div>
    </Modal>
  );
}
