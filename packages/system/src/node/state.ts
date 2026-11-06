// The files System keeps per project in the Inbox's data folder:
//
//   <dataDir>/system/<project key>/setup.json   the person's choices (written by the Inbox)
//   <dataDir>/system/<project key>/state.json   what the scheduled check last did (written by tick)
//   <dataDir>/system/<project key>/tick.lock    the pid of a running tick
//   <dataDir>/system/<project key>/worktree/    the drawing's own git worktree
//   <dataDir>/system/<project key>/reviews/     revisions of open pull requests
//   <dataDir>/system/<project key>/failed/      what a refused redraw left, by commit
//
// Every function takes `dataDir`; nothing here reads ~/.plannotator itself.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    worktree: join(dir, 'worktree'),
    reviews: join(dir, 'reviews'),
    failed: join(dir, 'failed'),
  };
}

export type TickState = {
  v: 1;
  /** The last commit of the default branch the check is done with: gated, or redrawn. */
  gated: string | null;
  gated_at: string | null;
  redrew_at: string | null;
  /** The open redraw pull request's link, once one was opened. */
  redraw_pr: string | null;
  /** Why the last tick failed, or null. */
  last_error: string | null;
  /** The commit a refused or failed redraw was for: the agent is not run again until main moves past it. */
  failed: string | null;
};

export const EMPTY_STATE: TickState = { v: 1, gated: null, gated_at: null, redrew_at: null, redraw_pr: null, last_error: null, failed: null };

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
      v: 1, gated: str(v.gated), gated_at: str(v.gated_at), redrew_at: str(v.redrew_at), redraw_pr: str(v.redraw_pr),
      last_error: str(v.last_error), failed: str(v.failed),
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
 * Take tick.lock, or null when a live tick holds it. A lock whose pid is dead
 * (a tick that crashed or was killed) is taken over. The returned function
 * lets it go, only while it still names this process.
 */
export async function takeLock(path: string, pid = process.pid): Promise<(() => Promise<void>) | null> {
  const release = async () => {
    const held = await readFile(path, 'utf8').catch(() => '');
    if (held.trim() === String(pid)) await unlink(path).catch(() => {});
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(pid), { flag: 'wx', mode: 0o600 });
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = Number((await readFile(path, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return null;
      await unlink(path).catch(() => {});
    }
  }
  return null;
}
