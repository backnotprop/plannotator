// The files System keeps per project in the Inbox's data folder. The drawing
// lives here, never in the person's repo (owner ruling 2026-11-06, q-122e6577):
//
//   <dataDir>/system/<project key>/setup.json   the person's choices (written by the Inbox)
//   <dataDir>/system/<project key>/state.json   what the scheduled check last did (written by tick)
//   <dataDir>/system/<project key>/tick.lock    the pid of a running tick
//   <dataDir>/system/<project key>/drawing/     the drawing: system.yaml, sheets/, revisions/
//   <dataDir>/system/<project key>/source/      a clone of the project, at the default branch, for the agent to read
//   <dataDir>/system/<project key>/redraw/      a redraw in progress: a copy of drawing/ the agent edits
//   <dataDir>/system/<project key>/previous/    the drawing before the last redraw
//   <dataDir>/system/<project key>/redraw-summary.txt  the redraw agent's sentences, read and deleted by the tick
//   <dataDir>/system/<project key>/reviews/     revisions of open pull requests
//   <dataDir>/system/<project key>/changed/     files a redraw agent changed in source/, by commit
//   <dataDir>/system/<project key>/failed/      what a refused or cut-off redraw left
//
// Every function takes `dataDir`; nothing here reads ~/.plannotator itself.
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseSetup, type SystemSetup } from '../agent/setup.ts';

/** A project key as the Inbox makes it (`<name>-<6 hex>`): one plain folder name. */
export function checkKey(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) || key.includes('..')) throw new Error(`"${key}" is not a project key`);
  return key;
}

export function systemPaths(dataDir: string, key: string) {
  const dir = join(dataDir, 'system', checkKey(key));
  return {
    dir,
    setup: join(dir, 'setup.json'),
    state: join(dir, 'state.json'),
    lock: join(dir, 'tick.lock'),
    drawing: join(dir, 'drawing'),
    source: join(dir, 'source'),
    redraw: join(dir, 'redraw'),
    previous: join(dir, 'previous'),
    summary: join(dir, 'redraw-summary.txt'),
    reviews: join(dir, 'reviews'),
    changed: join(dir, 'changed'),
    failed: join(dir, 'failed'),
  };
}

export type TickState = {
  v: 1;
  /** The last commit of the default branch the check is done with: gated, or redrawn. */
  gated: string | null;
  gated_at: string | null;
  redrew_at: string | null;
  /** Why the last tick failed, or null. */
  last_error: string | null;
  /** The commit a refused or failed redraw was for: the agent is not run again until main moves past it. */
  failed: string | null;
  /**
   * The last time the tick found a redraw cut off before it ended (by a
   * reboot, a logout or a kill: its copy of the drawing left in redraw/, or
   * changes left in source/) and set it aside to go on: when, and where the
   * files it left are kept.
   */
  set_aside: string | null;
};

export const EMPTY_STATE: TickState = { v: 1, gated: null, gated_at: null, redrew_at: null, last_error: null, failed: null, set_aside: null };

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** The person's setup for a project, or null when there is none or it is not a version 1 setup. */
export async function readSetup(dataDir: string, key: string): Promise<SystemSetup | null> {
  try {
    return parseSetup(JSON.parse(await readFile(systemPaths(dataDir, key).setup, 'utf8')));
  } catch {
    return null;
  }
}

/** What the last tick wrote; the empty state when there is no state.json or it does not read. */
export async function readState(dataDir: string, key: string): Promise<TickState> {
  try {
    const v = JSON.parse(await readFile(systemPaths(dataDir, key).state, 'utf8')) as Record<string, unknown>;
    if (v?.v !== 1) return { ...EMPTY_STATE };
    return {
      v: 1, gated: str(v.gated), gated_at: str(v.gated_at), redrew_at: str(v.redrew_at),
      last_error: str(v.last_error), failed: str(v.failed), set_aside: str(v.set_aside),
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Write state.json whole: 0600 in a 0700 folder, through a temp file, so a reader never sees half of it. */
export async function writeState(dataDir: string, key: string, state: TickState): Promise<void> {
  const p = systemPaths(dataDir, key);
  await mkdir(p.dir, { recursive: true, mode: 0o700 });
  const tmp = `${p.state}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, p.state);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Timings of tick.lock, an engineering default and not a limit a person meets.
 * The holder touches the lock (its mtime is the heartbeat) every `heartbeatMs`.
 * A lock is broken only when its holder's pid is dead, or its heartbeat is
 * older than `staleMs` (a pid reused by another process, a holder that hangs),
 * and only when a second look still shows the same holder that way: `settleMs`
 * later for a dead pid, `staleSettleMs` later (two and a half heartbeats) for a
 * stale heartbeat, so a live holder that a sleep, a busy wake or a clock jump
 * made late has touched it by then. An empty or unreadable lock younger than
 * `staleMs` is held: a taker on a file system with no hard links writes its lock
 * after making it.
 */
export const LOCK_TIMINGS = { heartbeatMs: 10_000, staleMs: 60_000, settleMs: 1_000, staleSettleMs: 25_000 };

export type LockOptions = {
  pid?: number;
  heartbeatMs?: number;
  staleMs?: number;
  settleMs?: number;
  staleSettleMs?: number;
  /** The hard link the lock is made with; node's unless given (the tests pass one that fails). */
  link?: (existing: string, name: string) => Promise<void>;
  /** Run inside the lock-breaking guard, after the lock was read again and before it is removed (the tests use it to order two takers). */
  beforeBreak?: () => Promise<void>;
};

/**
 * A held tick.lock: call it to let the lock go. `lost` turns true, and
 * `signal` aborts, once the heartbeat finds the lock no longer this holder's
 * (another taker broke it); `check()` looks now. A holder that lost its lock
 * stops: the tick before it swaps a drawing or saves state.json, the Inbox's
 * first draw by stopping its agent (`signal`).
 */
export type HeldLock = (() => Promise<void>) & { readonly lost: boolean; readonly signal: AbortSignal; check: () => Promise<boolean> };

type Holder = { token: string | null; pid: number | null; mtimeMs: number };

/** Who holds the lock at `path`: its token and pid (a bare pid from an older Plannotator), or null when there is no lock. */
async function readHolder(path: string): Promise<Holder | null> {
  const [text, info] = await Promise.all([readFile(path, 'utf8').catch(() => null), stat(path).catch(() => null)]);
  if (text === null || !info) return null;
  let token: string | null = null;
  let pid: number | null = null;
  try {
    const v = JSON.parse(text) as { token?: unknown; pid?: unknown };
    if (typeof v === 'number') pid = v;
    else {
      token = typeof v?.token === 'string' ? v.token : null;
      pid = typeof v?.pid === 'number' ? v.pid : null;
    }
  } catch {
    // empty, or not this format: no holder named
  }
  return { token, pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null, mtimeMs: info.mtimeMs };
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const sameHolder = (a: Holder, b: Holder) => a.token === b.token && a.pid === b.pid && (a.token !== null || a.mtimeMs === b.mtimeMs);


/**
 * Make `name` hold `text`, failing with EEXIST when it is there: a temp file
 * linked to its name, so the file is whole the moment it exists, or when the
 * link fails for any reason but EEXIST (a file system with no hard links: FAT,
 * exFAT, many SMB mounts, some sync folders, each with its own error code;
 * Windows FAT gives EISDIR), an exclusive create, then the write.
 */
async function createWhole(name: string, text: string, pid: number, token: string, linkFn: (a: string, b: string) => Promise<void>): Promise<void> {
  const tmp = `${name}.tmp-${pid}-${token}`;
  await writeFile(tmp, text, { mode: 0o600 });
  try {
    await linkFn(tmp, name);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw e;
  } finally {
    await unlink(tmp).catch(() => {});
  }
  const fh = await open(name, 'wx', 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync().catch(() => {});
  } finally {
    await fh.close();
  }
}

/** Remove the temp files of takers that died between writing one and linking it (`<lock>.tmp-<pid>-<token>`, the guard's too). */
async function removeDeadTemps(path: string): Promise<void> {
  const base = basename(path);
  const names = await readdir(dirname(path)).catch(() => [] as string[]);
  for (const n of names) {
    const m = new RegExp(`^${base.replace(/[.]/g, '\\.')}(?:\\.break)?\\.tmp-(\\d+)-[0-9a-f]+$`).exec(n);
    if (m && !alive(Number(m[1]))) await unlink(join(dirname(path), n)).catch(() => {});
  }
}

/**
 * Take tick.lock, or null when a live holder has it.
 *
 * Who takes it: every tick, and the Inbox's first draw (recipe/DRAW.md) for
 * its whole run, so no tick redraws or swaps the drawing while the drawing
 * agent still writes it (DRAW.md step 6 fixes files after `wanted:` is empty).
 * The draw's holder is a process that lives exactly as long as the drawing
 * agent: the process that runs the agent, taking the lock before it starts
 * the agent and letting it go when the agent ends. It must not be a longer
 * lived process that could restart while the agent runs, and the holder keeps
 * the heartbeat going (this function does it) for as long as it holds. It
 * stops its agent when the lock's `signal` aborts.
 *
 * The lock file holds `{ token, pid }` and is made whole in one step (written
 * to a temp file, then linked to its name, which fails when the name is
 * taken; an exclusive create where hard links fail). A dead or stale lock is
 * removed only under a second lock (`tick.lock.break`), and only while it is
 * still the one the taker looked at twice and the guard is still the taker's,
 * so two takers never both break it and both run. The returned function stops
 * the heartbeat and deletes the lock only while it still holds this taker's
 * token.
 */
export async function takeLock(path: string, o: number | LockOptions = {}): Promise<HeldLock | null> {
  const opts: LockOptions = typeof o === 'number' ? { pid: o } : o;
  const pid = opts.pid ?? process.pid;
  const { heartbeatMs, staleMs, settleMs, staleSettleMs } = { ...LOCK_TIMINGS, ...opts };
  const linkFn = opts.link ?? link;
  const token = randomBytes(12).toString('hex');
  const breakable = (h: Holder) => (h.pid !== null && !alive(h.pid)) || Date.now() - h.mtimeMs > staleMs;
  await removeDeadTemps(path);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await createWhole(path, JSON.stringify({ token, pid }), pid, token, linkFn);
      return held(path, token, heartbeatMs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const first = await readHolder(path);
    if (!first) continue;
    if (!breakable(first)) return null;
    // a second look: a live holder whose heartbeat was late (a Mac waking up, a clock jump) touches it meanwhile
    const pidDead = first.pid !== null && !alive(first.pid);
    await sleep(pidDead ? settleMs : staleSettleMs);
    const second = await readHolder(path);
    if (!second) continue;
    if (!sameHolder(first, second) || !breakable(second)) return null;
    // break it under a second lock, so one taker at a time removes a lock and only the one it looked at twice
    const guard = `${path}.break`;
    const broke = await underGuard(guard, pid, token, staleMs, linkFn, async () => {
      const now = await readHolder(path);
      if (now && !sameHolder(first, now)) return false;
      await opts.beforeBreak?.();
      // a taker that took the guard over as stale while this one paused is breaking now
      if ((await readFile(guard, 'utf8').catch(() => '')) !== token) return false;
      if (now) await unlink(path).catch(() => {});
      return true;
    });
    if (!broke) return null;
  }
  return null;
}

/**
 * Run `fn` holding the lock-breaking guard at `guard`, made whole as tick.lock
 * is; false when another taker holds it (that taker is breaking the lock and
 * takes it next). A guard left by a taker that died while breaking (older
 * than `staleMs`) is removed, and this taker tries again on its next run. The
 * guard is let go only while it still holds this taker's token.
 */
async function underGuard(guard: string, pid: number, token: string, staleMs: number, linkFn: (a: string, b: string) => Promise<void>,
  fn: () => Promise<boolean>): Promise<boolean> {
  try {
    await createWhole(guard, token, pid, token, linkFn);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const info = await stat(guard).catch(() => null);
    if (info && Date.now() - info.mtimeMs > staleMs) await unlink(guard).catch(() => {});
    return false;
  }
  try {
    return await fn();
  } finally {
    if ((await readFile(guard, 'utf8').catch(() => '')) === token) await unlink(guard).catch(() => {});
  }
}

/** A held lock: its heartbeat runs until the release, which deletes the lock only while it holds `token`. */
function held(path: string, token: string, heartbeatMs: number): HeldLock {
  const abort = new AbortController();
  let lost = false;
  const check = async () => {
    if (lost) return false;
    // lost only when the lock is gone or names another holder; a read that fails otherwise (EMFILE, a Windows
    // sharing violation from an antivirus) keeps it, and the next beat looks again
    const text = await readFile(path, 'utf8').then((t) => t, (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : undefined));
    if (text === undefined) return true;
    if (text !== null) {
      try {
        if ((JSON.parse(text) as { token?: unknown })?.token === token) return true;
      } catch {
        // not this holder's lock
      }
    }
    lost = true;
    abort.abort(new Error('tick.lock was taken by another holder'));
    return false;
  };
  const beat = setInterval(() => {
    void check().then((ok) => {
      if (ok) {
        const now = new Date();
        return utimes(path, now, now);
      }
      clearInterval(beat);
    }).catch(() => {});
  }, heartbeatMs);
  beat.unref?.();
  const release = async () => {
    clearInterval(beat);
    if (await check()) await unlink(path).catch(() => {});
  };
  return Object.defineProperties(release, {
    check: { value: check },
    signal: { value: abort.signal },
    lost: { get: () => lost },
  }) as HeldLock;
}
