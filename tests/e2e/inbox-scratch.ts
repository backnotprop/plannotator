/**
 * Temp folders for the Inbox e2e specs, and a teardown that never leaves an
 * Inbox running. A spec makes each folder with `inboxScratch(prefix)` (one
 * `mkdtempSync` under the OS temp dir, remembered) and ends with
 * `await removeInboxScratch()` (every folder) or `removeInboxScratch(root)`
 * (one) in a `finally`, so it runs when a browser close throws, a test fails
 * half way, or `beforeAll` failed before the world was assembled.
 *
 * It signals only an Inbox it can prove the folder started. The candidates
 * are the entries `rememberInboxOf` read after each start (a spec that
 * restarts its Inbox has several; the file names only the latest) and the
 * `inbox/inbox.json` files under the folder. A candidate's command line must
 * still be `plannotator inbox ...` or `index.ts inbox ...`, and then either:
 *
 *  - `GET http://127.0.0.1:<port>/api/inbox/health` answers that entry's
 *    pid AND serverSession, or
 *  - nothing answers on the port, and `lsof` shows the process's working
 *    directory inside the folder (a detached Inbox runs in `<data>/inbox`).
 *
 * Anything else (a pid reused by another process, the person's own Inbox,
 * an Inbox answering for another session) is never signalled. SIGTERM first
 * (the clean stop takes a tailnet mapping down), SIGKILL what is still the
 * same proven process five seconds later, then the folder goes.
 *
 * Why: inbox-tailscale.spec.ts signalled the one pid inbox.json named and
 * removed its folder; an Inbox it had started with `--tailscale` ran on for
 * two days at 100% CPU with its data folder gone. An Inbox now also exits on
 * its own once its data is gone (`onDataGone` in packages/server/inbox.ts);
 * a spec does not rely on that.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/** What an Inbox wrote about itself: enough to recognise it again. */
interface InboxEntry {
  pid: number;
  port: number;
  serverSession: string;
}

/** Each scratch folder and the entries remembered for it. */
const roots = new Map<string, Map<string, InboxEntry>>();

const keyOf = (e: InboxEntry) => `${e.pid}:${e.port}:${e.serverSession}`;

function readEntry(file: string): InboxEntry | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<InboxEntry>;
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 1) return null;
    if (typeof value.port !== 'number' || typeof value.serverSession !== 'string') return null;
    return { pid: value.pid, port: value.port, serverSession: value.serverSession };
  } catch {
    return null;
  }
}

/** A new folder under the OS temp dir, removed (with any Inbox it started) by `removeInboxScratch`. */
export function inboxScratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.set(root, new Map());
  return root;
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

/** Remember the entry in `<dataDir>/inbox/inbox.json` (right after each start), for the scratch folder holding `dataDir`. */
export function rememberInboxOf(dataDir: string): void {
  const root = [...roots.keys()].find((r) => inside(dataDir, r));
  const entry = root ? readEntry(join(dataDir, 'inbox', 'inbox.json')) : null;
  if (root && entry) roots.get(root)!.set(keyOf(entry), entry);
}

/** Every `inbox/inbox.json` under `dir`, a few levels down (data dirs sit at root/data or root/home/.plannotator). */
function registriesUnder(dir: string, depth: number, found: string[] = []): string[] {
  if (depth < 0) return found;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === 'inbox' && existsSync(join(path, 'inbox.json'))) found.push(join(path, 'inbox.json'));
    else registriesUnder(path, depth - 1, found);
  }
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The command line runs the Inbox: `.../plannotator inbox ...` (the binary) or `... index.ts inbox ...` (from source); never `inbox mcp`. */
function runsInbox(pid: number): boolean {
  const args = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '';
  return /(?:^|[\s/])(?:plannotator|index\.ts) inbox(?:\s|$)/.test(args) && !/ inbox mcp(?:\s|$)/.test(args);
}

/** What the port says: the Inbox's own health answer, nothing (refused or no answer), or something else. */
async function health(port: number): Promise<{ pid: number; serverSession: string } | 'nothing' | 'other'> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { pid?: unknown; serverSession?: unknown };
    return typeof body.pid === 'number' && typeof body.serverSession === 'string' ? { pid: body.pid, serverSession: body.serverSession } : 'other';
  } catch (error) {
    // A refused connection or a timeout is "nothing answers"; a page that is not JSON is someone else.
    return error instanceof SyntaxError ? 'other' : 'nothing';
  }
}

/** The process's working directory, from `lsof` (`n<path>` after the `fcwd` line), or null. */
function cwdOf(pid: number): string | null {
  const out = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout ?? '';
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/** This entry's process is the Inbox the folder started (see the header). */
async function proven(entry: InboxEntry, root: string): Promise<boolean> {
  if (entry.pid === process.pid || !alive(entry.pid) || !runsInbox(entry.pid)) return false;
  const answer = await health(entry.port);
  if (answer === 'other') return false;
  if (answer !== 'nothing') return answer.pid === entry.pid && answer.serverSession === entry.serverSession;
  const cwd = cwdOf(entry.pid);
  return cwd !== null && inside(cwd, root);
}

async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = left.filter(alive);
  }
  return left;
}

/**
 * Stop every Inbox a scratch folder provably started (SIGTERM, then SIGKILL),
 * then remove the folder: `root`, or every folder this spec made.
 */
export async function removeInboxScratch(root?: string): Promise<void> {
  const chosen = root ? [root].filter((r) => roots.has(r)) : [...roots.keys()];
  const targets = new Map<number, { entry: InboxEntry; root: string }>();
  for (const dir of chosen) {
    const entries = new Map(roots.get(dir)!);
    for (const file of registriesUnder(dir, 4)) {
      const entry = readEntry(file);
      if (entry) entries.set(keyOf(entry), entry);
    }
    for (const entry of entries.values()) {
      if (!targets.has(entry.pid) && (await proven(entry, dir))) targets.set(entry.pid, { entry, root: dir });
    }
  }
  const pids = [...targets.keys()];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  for (const pid of await waitGone(pids, 5_000)) {
    // Proven again, so a pid reused meanwhile is never killed.
    const { entry, root: dir } = targets.get(pid)!;
    if (!(await proven(entry, dir))) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone meanwhile.
    }
  }
  await waitGone(pids, 2_000);
  for (const dir of chosen) {
    rmSync(dir, { recursive: true, force: true });
    roots.delete(dir);
  }
}
