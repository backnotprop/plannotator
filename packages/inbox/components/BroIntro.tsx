import { Modal } from './Updates';

/**
 * Bro mode's one-time offer (approval "bro-mode", 2026-11-05): the Checklist reveal's frame, type and buttons (`.ib-bi`),
 * few words and no picture. "Turn it on" turns Bro mode on; "Not now", Escape and a click outside close it and leave it
 * off. Every way out is final: the claim already stamped it. No keyboard shortcut.
 */
export function BroIntro({ phone, onClose, onTurnOn }: { phone: boolean; onClose: () => void; onTurnOn: () => void }) {
  return (
    <Modal labelledBy="ib-bro-title" describedBy="ib-bro-desc" testId="bro-intro" onClose={onClose} ownKeys className={`ib-bi${phone ? ' ib-bi-phone' : ''}`}>
      <div className="ib-bi-text">
        <h2 id="ib-bro-title">Bro mode</h2>
        <p id="ib-bro-desc">Agents write to your Inbox in plain words, like one person to another.</p>
        <p className="ib-bi-q">It starts with their next session after you turn it on.</p>
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
