import { useFullInboxSwitch } from '../data/actions/fullInbox';

/**
 * Settings → Capabilities → Full Inbox (the owner's mock S5, 2026-11-23): the top row of the card, for someone who
 * chose code review only at some point (settings `full_inbox.chosen`), so they can switch back and forth; a person who
 * never chose sees no new row. Off while the Inbox is for code review only. The switch saves at once (no confirmation);
 * every window follows.
 */
export function FullInboxRow({ saved }: { saved: boolean }) {
  const full = useFullInboxSwitch(saved);
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
        <button type="button" role="switch" className="ib-sw" aria-checked={full.on} aria-labelledby="ib-full-inbox-label" aria-describedby="ib-full-inbox-desc" onClick={full.toggle} />
      </span>
    </div>
  );
}
