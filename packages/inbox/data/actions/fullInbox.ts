/**
 * The Inbox for code review only, from the window (reviewOnly.ts): Settings' Full Inbox row and the welcome dialog's
 * switch save `full_inbox: { on }`; the welcome is claimed once it shows (`review_welcome: true`). Every window,
 * this one included, takes the switch from `event: capabilities` (capabilities.ts); until the answer lands a switch
 * shows the person's choice, and a save that fails puts it back.
 */
import { useEffect, useState } from 'react';
import { post } from '../../api';
import { inboxUrl } from '../../inboxUrl';

export function saveFullInbox(on: boolean): Promise<{ full_inbox?: { on: boolean } }> {
  return post<{ full_inbox?: { on: boolean } }>(inboxUrl('/settings'), { full_inbox: { on } });
}

/** The welcome showed in this window: it never shows again, here or anywhere. Nothing to say if it fails. */
export function claimReviewWelcome(): void {
  void post(inboxUrl('/settings'), { review_welcome: true }).catch(() => {});
}

/** A Full Inbox switch: what it shows (the person's choice until the save answers) and its toggle. */
export function useFullInboxSwitch(saved: boolean): { on: boolean; failed: boolean; toggle: () => void } {
  const [asked, setAsked] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setAsked(null), [saved]);
  const on = asked ?? saved;
  const toggle = () => {
    const next = !on;
    setAsked(next);
    setFailed(false);
    saveFullInbox(next).then(
      (answer) => {
        if (answer.full_inbox?.on !== next) setAsked(null);
      },
      () => {
        setAsked(null);
        setFailed(true);
      },
    );
  };
  return { on, failed, toggle };
}
