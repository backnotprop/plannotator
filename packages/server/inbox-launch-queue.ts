/**
 * The launch dialog's place in the Inbox's line of one-time dialogs (the launch switch, packages/shared/launch-switch.ts;
 * the page, packages/inbox/launchDialog.tsx).
 *
 * While a campaign is due here (on, inside its dates, never shown on this computer) the dialog goes first: the line
 * holds (reveals.ts `launchDue`), so nothing else is armed while the page claims it. The hold lasts only until a claim
 * is answered, either way (yes, no, or an error answered as no): from then on the line runs as usual, whatever the
 * page does next. So a page whose claim came back late or no, or a data folder where the stamp cannot be written,
 * never freezes the line until the launch's end. `due` stays true while it is unshown, so a page that loads later still
 * claims it at once; it no longer holds the others.
 *
 * `startsIn`: the time until a kept "on" launch starts, so a page left open reads its settings again then and claims
 * it from the kept copy, with no request to the site.
 *
 * `after`: a dialog that goes before it (the welcome to the code review Inbox, inbox-review-only.ts, still unshown).
 * While it waits, the launch is neither due nor holding the line, so that dialog comes first and the two never draw
 * at once; once it is shown, the launch is next.
 */
import { launchInstant, launchSwitchAction, readLaunchKept, type LaunchSwitchAction, type LaunchSwitchService } from "@plannotator/shared/launch-switch";

export interface InboxLaunchQueue {
  /** The page may claim it (settings `reveal.launch`). */
  due(): boolean;
  /** The line holds for it (reveals.ts `launchDue`). */
  holdsLine(): boolean;
  /** ms until a kept "on" launch starts, or null. */
  startsIn(now: number): number | null;
  /** `POST /api/inbox/launch-switch`'s action; a claim answered releases the line. */
  action(action: LaunchSwitchAction, body: unknown): { status: number; body: unknown };
}

export function createInboxLaunchQueue(service: LaunchSwitchService, dataDir: () => string, after: () => boolean = () => false): InboxLaunchQueue {
  let released = false;
  const due = () => {
    if (after()) return false;
    try {
      return service.claim().show;
    } catch {
      return false;
    }
  };
  return {
    due,
    holdsLine: () => !released && due(),
    startsIn(now) {
      try {
        const { doc } = readLaunchKept(dataDir());
        const start = doc?.on === true ? launchInstant(doc.startsAt) : null;
        return start !== null && start > now ? start - now : null;
      } catch {
        return null;
      }
    },
    action(action, body) {
      try {
        return launchSwitchAction(service, action, body);
      } catch {
        return { status: 200, body: action === "answer" ? { ok: false } : { show: false } };
      } finally {
        if (action === "claim") released = true;
      }
    },
  };
}
