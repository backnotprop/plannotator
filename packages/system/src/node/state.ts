import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseSetup, type SystemSetup } from '../agent/setup.ts';

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
  gated: string | null;
  gated_at: string | null;
  redrew_at: string | null;
  last_error: string | null;
  failed: string | null;
  set_aside: string | null;
};

export const EMPTY_STATE: TickState = { v: 1, gated: null, gated_at: null, redrew_at: null, last_error: null, failed: null, set_aside: null };

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export async function readSetup(dataDir: string, key: string): Promise<SystemSetup | null> {
  try {
    return parseSetup(JSON.parse(await readFile(systemPaths(dataDir, key).setup, 'utf8')));
  } catch {
    return null;
  }
}

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

export const LOCK_TIMINGS = { heartbeatMs: 10_000, staleMs: 60_000, settleMs: 1_000, staleSettleMs: 25_000 };

export type LockOptions = {
  pid?: number;
  heartbeatMs?: number;
  staleMs?: number;
  settleMs?: number;
  staleSettleMs?: number;
  /** The hard link the lock is made with; node's unless given (the tests pass one that fails). */
  link?: (existing: string, name: string) => Promise<void>;
  beforeBreak?: () => Promise<void>;
};

export type HeldLock = (() => Promise<void>) & { readonly lost: boolean; readonly signal: AbortSignal; check: () => Promise<boolean> };

type Holder = { token: string | null; pid: number | null; mtimeMs: number };

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
  }
  return { token, pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null, mtimeMs: info.mtimeMs };
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const sameHolder = (a: Holder, b: Holder) => a.token === b.token && a.pid === b.pid && (a.token !== null || a.mtimeMs === b.mtimeMs);


/** Windows FAT gives EISDIR), an exclusive create, then the write. */
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

async function removeDeadTemps(path: string): Promise<void> {
  const base = basename(path);
  const names = await readdir(dirname(path)).catch(() => [] as string[]);
  for (const n of names) {
    const m = new RegExp(`^${base.replace(/[.]/g, '\\.')}(?:\\.break)?\\.tmp-(\\d+)-[0-9a-f]+$`).exec(n);
    if (m && !alive(Number(m[1]))) await unlink(join(dirname(path), n)).catch(() => {});
  }
}

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
    const pidDead = first.pid !== null && !alive(first.pid);
    await sleep(pidDead ? settleMs : staleSettleMs);
    const second = await readHolder(path);
    if (!second) continue;
    if (!sameHolder(first, second) || !breakable(second)) return null;
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
