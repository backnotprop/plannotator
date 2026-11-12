import { Fragment } from 'react';
import { Modal } from './Updates';

export interface GrillMeTipCopy {
  title: string;
  body: string;
  reach: string;
}

export const GRILL_ME_TIP_COPY_A: GrillMeTipCopy = {
  title: 'Try /grill-me here',
  body: 'Plannotator gives grill-me an optimized experience: its questions come to your Inbox as cards you can answer anytime.',
  reach: 'Pick /grill-me in a reply or a new message. Nothing to turn on.',
};

export const GRILL_ME_TIP_COPY_B: GrillMeTipCopy = {
  title: 'Try /grill-me here',
  body: 'Pick /grill-me in a reply or a new message, and its interview comes back here, one card per question: pick an answer, add a note, take your time.',
  reach: 'Works with any grill-me skill you have. Nothing to turn on.',
};

export const GRILL_ME_TIP_COPY: GrillMeTipCopy = GRILL_ME_TIP_COPY_A;

export const GRILL_ME_TIP_ART = {
  question: 'Which dark palette?',
  context: 'Each picture is your app in that palette.',
  choices: [
    { label: 'Dim', tone: 'dim' },
    { label: 'Night', tone: 'night' },
  ],
  recommended: 1,
  why: "your light theme already uses GitHub's colours.",
  note: 'Keep the blue accent',
} as const;

const COMMAND = '/grill-me';

function withCommand(text: string) {
  return text.split(COMMAND).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <code>{COMMAND}</code>}
      {part}
    </Fragment>
  ));
}

export function GrillMeTip({ phone, onClose, copy = GRILL_ME_TIP_COPY }: { phone: boolean; onClose: () => void; copy?: GrillMeTipCopy }) {
  return (
    <Modal labelledBy="ib-gm-title" describedBy="ib-gm-desc" testId="grill-me-tip" onClose={onClose} ownKeys className={`ib-bi ib-bro ib-gm${phone ? ' ib-bi-phone' : ''}`}>
      <h2 id="ib-gm-title">{withCommand(copy.title)}</h2>
      <div className="ib-gm-art" aria-hidden="true">
        <p className="q">{GRILL_ME_TIP_ART.question}</p>
        <p className="ctx">{GRILL_ME_TIP_ART.context}</p>
        <div className="tiles">
          {GRILL_ME_TIP_ART.choices.map((choice, i) => (
            <div key={choice.label} className={i === GRILL_ME_TIP_ART.recommended ? 'tile on' : 'tile'}>
              <span className={`pic ${choice.tone}`}>
                <i />
                <i />
                <i />
              </span>
              <span className="cap">
                <span className="dot" />
                {choice.label}
                {i === GRILL_ME_TIP_ART.recommended && <span className="tag">Recommended</span>}
              </span>
            </div>
          ))}
        </div>
        <p className="why">
          <b>Why {GRILL_ME_TIP_ART.choices[GRILL_ME_TIP_ART.recommended].label}:</b> {GRILL_ME_TIP_ART.why}
        </p>
        <div className="note">
          {GRILL_ME_TIP_ART.note}
          <span className="caret" />
        </div>
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
