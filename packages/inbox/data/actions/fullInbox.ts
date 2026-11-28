/**
 * The Inbox for code review only, from the window (reviewOnly.ts): Settings' Full Inbox row (data/actions/settings.ts
 * `toggleFullInbox`) and the welcome dialog's switch save `full_inbox: { on }`. Every window, this one included, takes
 * the switch from `event: capabilities` (capabilities.ts); until the answer lands a switch shows the person's choice,
 * and a save that fails puts it back and says so.
 */
import { useEffect, useState } from 'react';
import { post } from '../../api';
import { inboxUrl } from '../../inboxUrl';

export function saveFullInbox(on: boolean): Promise<{ full_inbox?: { on: boolean }; code_review?: { on: boolean } }> {
  return post<{ full_inbox?: { on: boolean }; code_review?: { on: boolean } }>(inboxUrl('/settings'), { full_inbox: { on } });
}

/** The welcome's Full Inbox switch: what it shows (the person's choice until the save answers), its toggle, and whether the last save failed. */
export function useFullInboxSwitch(saved: boolean, save: (on: boolean) => Promise<{ full_inbox?: { on: boolean } }> = saveFullInbox): { on: boolean; failed: boolean; toggle: () => void } {
  const [asked, setAsked] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setAsked(null), [saved]);
  const on = asked ?? saved;
  const toggle = () => {
    const next = !on;
    setAsked(next);
    setFailed(false);
    save(next).then(
      (answer) => {
        if (answer.full_inbox?.on === next) return;
        setAsked(null);
        setFailed(true);
      },
      () => {
        setAsked(null);
        setFailed(true);
      },
    );
  };
  return { on, failed, toggle };
}
