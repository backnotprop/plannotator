/**
 * The launch dialog in the Inbox (the launch switch, packages/shared/launch-switch.ts; the dialog,
 * @plannotator/ui LaunchDialog). Ahead of every other one-time dialog: while a campaign is due on this computer
 * (settings `reveal.launch`) the page claims it right away, with no 40-minute gap before it, and the Inbox holds its
 * line until that claim is answered (packages/server/inbox-launch-queue.ts), so nothing else is armed meanwhile. It
 * waits only for the first-run screen and the tour, an update and anything typed or open over the page. At every
 * width, the phone-width page and a page opened from another device included (only the native phone app leaves it
 * out). Once it draws, the other reveals hold back for the gap (reveal.ts `noteOneTimeDialogShown`), and the Inbox
 * counts the gap from its stamp.
 */
import { useLaunchAnnouncement, type LaunchClient } from '@plannotator/ui/components/LaunchAnnouncement';
import { post } from './api';
import { inboxUrl } from './inboxUrl';
import { noteOneTimeDialogShown } from './reveal';

/** `POST /api/inbox/launch-switch` (`action`: claim, shown, answer), on this computer's Inbox. */
export const inboxLaunchClient: LaunchClient = {
  claim: () => post(inboxUrl('/launch-switch'), { action: 'claim' }),
  shown: (campaign) => post(inboxUrl('/launch-switch'), { action: 'shown', campaign }),
  answer: (answer, campaign) => post(inboxUrl('/launch-switch'), { action: 'answer', answer, campaign }).catch(() => undefined),
};

export interface InboxLaunchDialogProps {
  /** The Inbox says a campaign is due here (settings `reveal.launch`). */
  due: boolean;
  /** The list has loaded, past the first-run screen and the tour, with no update under way. */
  ready: boolean;
  /** Something typed or open over the page now. */
  heldBack: () => boolean;
  /** Tests: the route and the art. */
  client?: LaunchClient;
  loadArt?: (src: string) => Promise<boolean>;
}

export function InboxLaunchDialog({ due, ready, heldBack, client = inboxLaunchClient, loadArt }: InboxLaunchDialogProps) {
  const launch = useLaunchAnnouncement({
    ready,
    eligible: due,
    firstRunWindow: false,
    blocked: heldBack(),
    onDrawn: noteOneTimeDialogShown,
    client,
    ...(loadArt ? { loadArt } : {}),
  });
  return <>{launch.dialog}</>;
}
