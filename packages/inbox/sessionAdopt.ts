/**
 * A window left open across an Inbox restart keeps writing, when the Inbox
 * that came back is provably the one it loaded from.
 *
 * Every write carries the `serverSession` of the page's first list read, and
 * an Inbox refuses one that is not its own (409 `session_mismatch`): the
 * guard against a page writing to another Inbox on its port, or to a release
 * it was not built for. But a restart of the same Inbox (the person's
 * `plannotator inbox restart`, a crash an agent's connection restarts, a
 * Restart pressed in another tab) tripped it too. The page kept receiving
 * messages and looked whole, while its looks, drafts and sends were refused
 * until a reload.
 *
 * So on the stream's `hello` from a session that is not the page's, the page
 * asks the Inbox's health and takes the new session only when ALL of this
 * holds (anything else leaves the page as it is, refused as before):
 *
 * - the same data, continued: the health's `follows` (the earlier runs of
 *   that data folder, kept in its own `inbox.json` and dropped when the folder
 *   is a copy or a restore: registry.ts `inboxSessionLineage`) names the
 *   page's session, and the store's cursor is not behind what the page read.
 *   This is the proof. An Inbox's `inbox_id` cannot be one: an Inbox that
 *   never linked a machine keeps its id in memory (inbox-links.ts), so it
 *   changes at every start, and a copied folder carries the original's;
 * - the same release as the one the page loaded from (another one shows
 *   "Inbox updated to X · Reload", or refuses, as before);
 * - the health and the hello are the same run's;
 * - and the page has read again what a reload would bring (the list, the open
 *   thread, drafts, settings: `catchUp`), from that same run.
 *
 * Only then do writes carry the new session. A write refused meanwhile says
 * so as it always did; nothing is sent twice.
 */

export interface RestartHello {
  serverSession: string;
  cursor: number;
}

export interface RestartHealth {
  serverSession?: unknown;
  version?: unknown;
  follows?: unknown;
}

export interface SessionAdoptDeps {
  /** The session the page's writes carry now (null before the first list read). */
  pageSession: () => string | null;
  /** The release the Inbox ran when the page loaded (the first list read's `version`). */
  loadedVersion: () => string | null;
  /** The newest store cursor the page has read. */
  pageCursor: () => number | null;
  readHealth: () => Promise<RestartHealth>;
  /** Read again what a reload would bring; answers the session the list came from (null: the read failed). */
  catchUp: () => Promise<string | null>;
  adopt: (session: string) => void;
}

/** `refused` names the one check that failed (a browser proof's log reads it; nothing shows it). */
export type SessionAdoptResult =
  | { state: 'same' }
  | { state: 'adopted' }
  | { state: 'refused'; why: 'not-loaded' | 'cursor-behind' | 'no-health' | 'other-run' | 'other-version' | 'not-followed' | 'not-read' | 'moved-on' };

/** Parse a `hello` frame's data; null when it does not name a session and a cursor. */
export function readHello(data: string): RestartHello | null {
  try {
    const value = JSON.parse(data) as { serverSession?: unknown; cursor?: unknown } | null;
    if (!value || typeof value.serverSession !== 'string' || value.serverSession === '') return null;
    if (typeof value.cursor !== 'number' || !Number.isSafeInteger(value.cursor)) return null;
    return { serverSession: value.serverSession, cursor: value.cursor };
  } catch {
    return null;
  }
}

export async function adoptRestartedInbox(hello: RestartHello, deps: SessionAdoptDeps): Promise<SessionAdoptResult> {
  const refused = (why: Extract<SessionAdoptResult, { state: 'refused' }>['why']): SessionAdoptResult => ({ state: 'refused', why });
  const mine = deps.pageSession();
  if (mine === null || hello.serverSession === mine) return { state: 'same' };
  const loaded = deps.loadedVersion();
  const read = deps.pageCursor();
  if (loaded === null || read === null) return refused('not-loaded');
  // A store behind what the page read is not the store it read (reset, or restored from a backup).
  if (hello.cursor < read) return refused('cursor-behind');
  let health: RestartHealth;
  try {
    health = await deps.readHealth();
  } catch {
    return refused('no-health');
  }
  if (health.serverSession !== hello.serverSession) return refused('other-run');
  if (health.version !== loaded) return refused('other-version');
  if (!Array.isArray(health.follows) || !health.follows.includes(mine)) return refused('not-followed');
  const from = await deps.catchUp().catch(() => null);
  if (from !== hello.serverSession) return refused('not-read');
  // Another restart, or a Reload's own adoption, while this one read: leave it to the hello that follows.
  if (deps.pageSession() !== mine) return refused('moved-on');
  deps.adopt(hello.serverSession);
  return { state: 'adopted' };
}
