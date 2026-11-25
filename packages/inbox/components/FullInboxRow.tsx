import { useState, type ReactNode } from 'react';
import { Switch } from './SettingSwitch';

/**
 * Settings → Capabilities → Full Inbox (the owner's mock S5, 2026-11-23): the top row of the card. Off while the Inbox
 * is for code review only; then it is the one way out, so Capabilities shows no Code review row (and no Board,
 * Checklist or Routines row: they need the full Inbox). The row shows to whoever is or ever was in that mode on this
 * computer (`chosen`), so they can switch back; someone who only ever used the full Inbox sees nothing new. Once shown
 * it stays for as long as Capabilities is open, as System's row does, so a switch here never pulls it out from under
 * the click. The switch saves at once as every Capabilities switch does (data/actions/settings.ts `toggleFullInbox`:
 * a failed save puts it back and Settings says so); every window follows.
 */
export function useFullInboxRow(fullInbox: { on: boolean; chosen?: true } | null | undefined, onToggle: ((next: boolean) => void) | undefined): { reviewOnly: boolean; row: ReactNode } {
  const reviewOnly = fullInbox?.on === false;
  const [seen, setSeen] = useState(false);
  if ((reviewOnly || fullInbox?.chosen === true) && !seen) setSeen(true);
  const shown = fullInbox && onToggle && (reviewOnly || fullInbox.chosen === true || seen);
  return { reviewOnly, row: shown ? <FullInboxRow on={fullInbox.on} onToggle={onToggle} /> : null };
}

export function FullInboxRow({ on, onToggle }: { on: boolean; onToggle: (next: boolean) => void }) {
  return (
    <div className="ib-prow" data-settings-full-inbox="">
      <span className="ib-txt">
        <span className="ib-l" id="ib-full-inbox-label">
          Full Inbox
        </span>
        <span className="ib-desc" id="ib-full-inbox-desc">
          Your agents also send you questions, decisions and finished work. Agents pick this up in their next session.
        </span>
      </span>
      <span className="ib-ctl">
        <Switch on={on} labelledBy="ib-full-inbox-label" onClick={() => onToggle(!on)} />
      </span>
    </div>
  );
}
