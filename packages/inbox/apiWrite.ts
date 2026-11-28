/**
 * A write the person waits on (a Send, its draft saves, picks, action marks, comments) ends: a connection that dies
 * without a word (a phone changing networks, a laptop waking, a proxy dropping the answer) used to hold the button
 * for good, because a POST had no limit. `fetchWithin` gives up once nothing has arrived for `WRITE_IDLE_MS`: no
 * answer yet, or an answer whose body stopped coming. Every byte of the answer starts the wait again, so a slow link
 * that is still moving is never cut off. A fetch cannot see its request body leave, so the wait for the answer also
 * covers sending the body: that is why the limit is long (a write's body is small: words, ids; a file goes before
 * the Send, as an upload with its own progress).
 *
 * A write given up may still have landed. Only a write the server answers again by its key (a reply, a new message,
 * a new thread) or that is safe to make twice (a draft's compare-and-set, a pick at a revision, a comment by its id)
 * goes through here: the caller's retry is the person's next press, never a loop.
 */
import { wholeBody } from './apiBody';

/**
 * Past a forward to a linked machine (4 s, then held) and the copy of a reply's files, and far past a small JSON
 * write on a slow phone link; short enough that the person gets Send back while they still care.
 */
export const WRITE_IDLE_MS = 20_000;
/** A small read inside a Send (the draft, the thread for a conflict, the skills its words name). */
export const SEND_READ_MS = 10_000;
/**
 * A write that starts an agent session (`to: { launch }`: New message's start, a reply to "New … session"). The Inbox
 * checks and prepares the launch before it answers, with nothing sent meanwhile: the agent's version and sign-in checks
 * (10 s each at most), the login shell (5 s), a folder outside home (3 s), Trust and start's lock (12 s), the tags of
 * far sessions (1.5 s): well under a minute. The agent itself, and a clone, start after the answer. A linked computer's
 * Inbox answers within 4 s (it holds the write when that computer is away). Past this, the network is gone, not slow.
 */
export const LAUNCH_IDLE_MS = 90_000;

let idleMs = WRITE_IDLE_MS;
let readMs = SEND_READ_MS;
let launchMs = LAUNCH_IDLE_MS;

/** How long a small read inside a Send waits with nothing arriving. */
export const sendReadMs = (): number => readMs;

/** Tests only: shorter waits, so a test sees the limits (a launch's in the same proportion); `null` puts the real ones back. */
export function setWriteIdleForTests(ms: number | null): void {
  idleMs = ms ?? WRITE_IDLE_MS;
  readMs = ms ?? SEND_READ_MS;
  launchMs = ms === null ? LAUNCH_IDLE_MS : Math.round((ms * LAUNCH_IDLE_MS) / WRITE_IDLE_MS);
}

/** A write with nothing arriving in time. Unlike a refusal it may have landed: only its key makes trying again safe. */
export class InboxWriteTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no answer in ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'InboxWriteTimeout';
  }
}

/** What a write passes to `post` to be given up this way. */
export const WITHIN = { within: true } as const;

/** A write's limit by where it goes: one that starts an agent session waits `LAUNCH_IDLE_MS` (its key makes Send again safe: the Inbox answers it again and starts nothing). */
export const withinFor = (to: object | undefined): { within: true | 'launch' } => (to && 'launch' in to ? { within: 'launch' } : WITHIN);

/** The fetch a `post` makes: `fetchWithin` with the limit `within` names, or plain `fetch` with none. */
export const fetchFor = (within: boolean | 'launch' | undefined): typeof fetchWithin =>
  within ? (input, init) => fetchWithin(input, init, within === 'launch' ? launchMs : idleMs) : (input, init) => fetch(input, init);

/** Statuses whose Response may carry no body. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** `fetch`, with the whole answer read before it returns (a status with no body as it is), given up after `limit` with nothing arriving. */
export async function fetchWithin(input: string, init: RequestInit, limit = idleMs): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    controller.abort();
  };
  let timer = setTimeout(expire, limit);
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(expire, limit);
  };
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (NO_BODY.has(response.status)) return response;
    const whole = await wholeBody(response, progress);
    if (timedOut) throw new InboxWriteTimeout(limit);
    return whole;
  } catch (cause) {
    throw timedOut ? new InboxWriteTimeout(limit) : cause;
  } finally {
    clearTimeout(timer);
  }
}
