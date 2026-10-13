/**
 * The reply a person is typing and has not sent, for the update control's
 * restart guard: restarting the Inbox reloads the page, and an unsent reply in
 * the box is the one thing not saved as it is typed (picks, annotations and
 * drafts are saved at once). The open thread reports it; the guard reads it.
 */

let unsent: { subject: string } | null = null;

/** The open thread's reply box: its subject while it holds text, else null. */
export function reportUnsentReply(value: { subject: string } | null): void {
  unsent = value;
}

export function unsentReply(): { subject: string } | null {
  return unsent;
}
