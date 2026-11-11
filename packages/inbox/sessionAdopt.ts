/** A window left open across an Inbox restart adopts the new session only when the health proves it is the same Inbox: `follows` names the page's session and the cursor is not behind, same release, same run as the hello, and the page has caught up. Anything else stays refused. */

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
  pageSession: () => string | null;
  loadedVersion: () => string | null;
  pageCursor: () => number | null;
  readHealth: () => Promise<RestartHealth>;
  catchUp: () => Promise<string | null>;
  adopt: (session: string) => void;
}

export type SessionAdoptResult =
  | { state: 'same' }
  | { state: 'adopted' }
  | { state: 'refused'; why: 'not-loaded' | 'cursor-behind' | 'no-health' | 'other-run' | 'other-version' | 'not-followed' | 'not-read' | 'moved-on' };

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
  if (deps.pageSession() !== mine) return refused('moved-on');
  deps.adopt(hello.serverSession);
  return { state: 'adopted' };
}
