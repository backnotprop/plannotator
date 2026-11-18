/**
 * Plannotator Inbox: Show in Rex for an agent on a linked machine (inbox-machines.md).
 *
 * The window asks through the machine link (`POST /api/inbox/m/<machine>/rex/show`, rule 8's `now`: a press in this
 * window, sent while that machine is online or not at all), and that machine's Inbox asks the Rex apps attached to
 * its own Rex server (`inbox-rex.ts` `show`, reach `away`): Rex's ids mean something only on the server that holds
 * them, so no other Rex can be asked about that pane. The person's own Rex app is one of those apps when it is
 * attached to that machine (Rex's "Add Remote Host…"). Once that machine says an app went there, this computer brings
 * its own Rex app to the front, as a Show for an agent of its own does: `session.select` leaves it behind the browser.
 */
import type { InboxRex } from "./inbox-rex";

/** The forward's path for a Show in Rex on a linked machine. */
const FAR_SHOW = /^\/api\/inbox\/m\/[^/]+\/rex\/show$/;

/**
 * `answer` as it is. When it is a linked machine's "shown" to this computer's own window, this computer's Rex app
 * comes to the front (best effort, never waited on).
 */
export async function inboxRaiseAfterFarShow(path: string, answer: Response, rex: Pick<InboxRex, "raise">): Promise<Response> {
  if (!FAR_SHOW.test(path) || !answer.ok) return answer;
  const body = (await answer.clone().json().catch(() => null)) as { shown?: unknown } | null;
  if (body?.shown === true) void rex.raise().catch(() => undefined);
  return answer;
}
