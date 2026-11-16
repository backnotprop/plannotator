/**
 * What this window keeps of Start review thread across a reload and both boards (Reviews' pane and its own page), in
 * localStorage:
 *  - each group's Send key for a while, so a press again after one that failed or went late replays that Send (the
 *    Inbox answers the thread it wrote, on whichever machine took it, and never starts a second agent);
 *  - each thread whose PRs could not be tied to it, so those PRs read as in review and the tie is tried again until it
 *    holds (`pulls/owner` sets the same owner again harmlessly).
 */
const STORE = 'plannotator-inbox-pr-review-starts';
/** How long a group's Send key is reused by a press again. */
export const REVIEW_KEY_REUSE_MS = 10 * 60_000;
/** How long an untied thread keeps its PRs in review here while its tie keeps failing. */
const UNTIED_KEEP_MS = 24 * 60 * 60_000;

export interface ReviewStart {
  machine: string | null;
  keys: string[];
  /** The Send's idempotency key. */
  send: string;
  at: number;
  /** The thread, once it started; `untied` while its PRs are not tied to it. */
  thread: string | null;
  untied: boolean;
}

const sameGroup = (a: Pick<ReviewStart, 'machine' | 'keys'>, machine: string | null, keys: readonly string[]) =>
  a.machine === machine && a.keys.length === keys.length && [...a.keys].sort().join(' ') === [...keys].sort().join(' ');

const kept = (start: ReviewStart, now: number) => now - start.at < (start.untied ? UNTIED_KEEP_MS : REVIEW_KEY_REUSE_MS);

function read(now = Date.now()): ReviewStart[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORE) ?? '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (s): s is ReviewStart =>
        !!s && typeof s.send === 'string' && typeof s.at === 'number' && Array.isArray(s.keys) && s.keys.every((k: unknown) => typeof k === 'string') && kept(s, now),
    );
  } catch {
    return [];
  }
}

function write(starts: ReviewStart[]): void {
  try {
    if (starts.length === 0) window.localStorage.removeItem(STORE);
    else window.localStorage.setItem(STORE, JSON.stringify(starts));
  } catch {
    // Without storage a press again sends a new key, as before.
  }
}

/** The Send key for a group: the one a press used within `REVIEW_KEY_REUSE_MS`, else `fresh()`, kept before the Send. */
export function sendKeyFor(machine: string | null, keys: readonly string[], fresh: () => string): string {
  const starts = read();
  const was = starts.find((s) => !s.thread && sameGroup(s, machine, keys));
  if (was) return was.send;
  const send = fresh();
  write([...starts, { machine, keys: [...keys], send, at: Date.now(), thread: null, untied: false }]);
  return send;
}

/** The Send never left (its hold was cancelled): a press again sends anew, since the same key answers the cancelled hold. */
export function forgetSend(send: string): void {
  write(read().filter((s) => s.send !== send));
}

/** The group's Send started `thread`; `untied` when its PRs could not be tied to it. */
export function noteStarted(send: string, thread: string, untied: boolean): void {
  write(read().flatMap((s) => (s.send !== send ? [s] : untied ? [{ ...s, thread, untied, at: Date.now() }] : [])));
}

/** The untied thread's PRs are tied now. */
export function noteTied(thread: string): void {
  write(read().filter((s) => s.thread !== thread));
}

/** The threads started here whose PRs are not tied to them yet. */
export function untiedStarts(): ReviewStart[] {
  return read().filter((s) => s.untied && s.thread);
}
