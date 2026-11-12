import spriteSheet from '../assets/tater-sidebar.webp';
import { Modal } from './Updates';

export const BRO_CREDIT = {
  seenBy: 'https://x.com/dillon_mulroy/status/2079238358358778142',
  by: 'https://github.com/backnotprop/bro/blob/main/skills/bro/SKILL.md',
} as const;

export function BroIntro({ phone, onClose, onTurnOn }: { phone: boolean; onClose: () => void; onTurnOn: () => void }) {
  return (
    <Modal labelledBy="ib-bro-title" describedBy="ib-bro-desc" testId="bro-intro" onClose={onClose} ownKeys className={`ib-bi ib-bro${phone ? ' ib-bi-phone' : ''}`}>
      <h2 id="ib-bro-title">
        Bro <br />
        mode
        <span className="ib-bro-tater" aria-hidden="true">
          <span className="ib-bro-strip" style={{ backgroundImage: `url(${spriteSheet})` }} />
        </span>
      </h2>
      <span className="ib-chip ib-bro-exp" data-bro-intro-experimental="">
        Experimental
      </span>
      <div className="ib-bi-text">
        <p id="ib-bro-desc">Agents write to your Inbox in plain words, like one person to another.</p>
        <p className="ib-bro-reach">
          Applies to new agent sessions. In open Claude Code sessions, run <code>/reload-plugins plannotator</code>.
        </p>
        <p className="ib-bro-credit">
          <code>/bro</code> as seen by{' '}
          <a href={BRO_CREDIT.seenBy} target="_blank" rel="noopener noreferrer">
            @dillon_mulroy
          </a>
          , repo:{' '}
          <a href={BRO_CREDIT.by} target="_blank" rel="noopener noreferrer">
            backnotprop/bro
          </a>
        </p>
      </div>
      <div className="ib-bi-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onClose} data-bro-intro-close="">
          Not now
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri ib-bi-copy" onClick={onTurnOn} data-bro-intro-on="">
          Turn it on
        </button>
      </div>
    </Modal>
  );
}
