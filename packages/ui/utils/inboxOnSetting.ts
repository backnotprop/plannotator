/**
 * Settings' "Plannotator Inbox" row in plan review, code review and annotate:
 * whether the person turned the Inbox on on this computer
 * (packages/shared/inbox/inbox-on.ts), as the server reports it in
 * `serverConfig.inboxOn` (getServerConfig), and the POST /api/config write
 * `{ inboxOn }` that turns it off (the Inbox stops, Plannotator's untouched
 * notes go) or on again (the record says on; agents get it from their next
 * session).
 *
 * The server sends `inboxOn: true` only while the Inbox is on, so the row
 * shows only to someone who turned the Inbox on; a server that predates it,
 * or a `@plannotator/ui` host such as Workspaces, sends nothing and gets no row.
 */

/** Undefined: no row. Otherwise whether the Inbox is on now. */
export function parseInboxOnSetting(serverConfig: unknown): boolean | undefined {
  if (typeof serverConfig !== 'object' || serverConfig === null) return undefined;
  return (serverConfig as Record<string, unknown>).inboxOn === true ? true : undefined;
}

/**
 * Turns the Inbox off or on through POST /api/config. Resolves with the line
 * the server says (how to turn it back on, after off), or rejects with a
 * readable message when nothing changed.
 */
export async function saveInboxOnSetting(on: boolean, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchImpl('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inboxOn: on }),
    });
  } catch {
    throw new Error('Could not reach Plannotator. Nothing was changed.');
  }
  let body: { error?: unknown; inboxOnLine?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // No JSON body: the status line below is all there is.
  }
  if (!response.ok) throw new Error(typeof body.error === 'string' && body.error ? body.error : `Plannotator answered ${response.status}. Nothing was changed.`);
  return typeof body.inboxOnLine === 'string' ? body.inboxOnLine : undefined;
}
