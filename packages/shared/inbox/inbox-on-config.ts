/**
 * Settings' Plannotator Inbox row in plan review, code review and annotate
 * (packages/ui/utils/inboxOnSetting.ts): the POST /api/config `{ inboxOn }`
 * write, the same on the Bun servers and the Pi servers. Off is the runtime's
 * own Turn off (the Bun servers turn it off in process, inbox-on-settle.ts; Pi
 * asks the CLI, agent-link.ts turnInboxOffWithCli). On is refused: an agent's
 * `curl` to this local server looks like the page's request, and nothing an
 * HTTP request carries proves a person clicked, so the Inbox turns on only
 * by running `plannotator inbox` (inbox-on-command.ts).
 */

/** How to turn it back on, said after every Turn off. */
export const INBOX_TURN_ON_AGAIN = "Turn it back on any time with plannotator inbox.";

export const INBOX_OFF_NOT_SAVED = "Could not turn the Plannotator Inbox off: state.json in Plannotator's data folder could not be written.";
export const INBOX_ON_NOT_SAVED = "Could not turn the Plannotator Inbox on: state.json in Plannotator's data folder could not be written.";

/** The answer to a request that tries to turn the Inbox on from a page. */
export const INBOX_ON_NOT_HERE = "The Inbox turns on only with plannotator inbox.";

/** The answer to `{ inboxOn }`: status and JSON body. `off` turns it off and says whether the record now says off. */
export async function inboxOnConfigWrite(on: boolean, off: () => Promise<boolean>): Promise<{ status: number; body: Record<string, unknown> }> {
  if (on) return { status: 403, body: { error: INBOX_ON_NOT_HERE } };
  return (await off()) ? { status: 200, body: { ok: true, inboxOnLine: INBOX_TURN_ON_AGAIN } } : { status: 500, body: { error: INBOX_OFF_NOT_SAVED } };
}
