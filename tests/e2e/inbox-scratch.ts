/**
 * Temp folders for the Inbox e2e specs, and a teardown that never leaves an
 * Inbox running. A spec makes each folder with `inboxScratch(prefix)` (one
 * `mkdtempSync` under the OS temp dir, remembered) and ends with
 * `await removeInboxScratch()` (every folder) or `removeInboxScratch(root)`
 * (one) in a `finally`, so it runs when a browser close throws, a test fails
 * half way, or `beforeAll` failed before the world was assembled.
 *
 * It signals only Inboxes these folders started: the pid `rememberInboxOf`
 * read after each start (a spec that restarts its Inbox has several; the
 * registry names only the latest) and the pid in every `inbox/inbox.json`
 * under the folder, each only while its command line is still a `plannotator
 * inbox` (a stale pid may name another process by now). SIGTERM first (the
 * clean stop takes a tailnet mapping down), SIGKILL whatever is alive five
 * seconds later, then the folder goes.
 *
 * Why: inbox-tailscale.spec.ts signalled the one pid inbox.json named and
 * removed its folder; an Inbox it had started with `--tailscale` ran on for
 * two days at 100% CPU with its data folder gone. An Inbox now also exits on
 * its own once its folder is gone (`onDataGone` in packages/server/inbox.ts);
 * a spec does not rely on that.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/** Each scratch folder and the Inbox pids remembered for it. */
const roots = new Map<string, Set<number>>();

/** A new folder under the OS temp dir, removed (with any Inbox it holds) by `removeInboxScratch`. */
export function inboxScratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.set(root, new Set());
  return root;
}

/** Remember the pid in `<dataDir>/inbox/inbox.json` (right after each start), for the scratch folder holding `dataDir`. */
export function rememberInboxOf(dataDir: string): void {
  const root = [...roots.keys()].find((r) => dataDir === r || dataDir.startsWith(`${r}${sep}`));
  if (!root) return;
  try {
    const pid = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')).pid;
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1) roots.get(root)!.add(pid);
  } catch {
    // Not written (yet).
  }
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

/** Still an Inbox (`... inbox ...` on its command line): a pid from a stale entry may name some other process by now. */
function isInbox(pid: number): boolean {
  const args = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '';
  return /\binbox\b/.test(args) && !/\binbox mcp\b/.test(args);
}

async function waitGone(targets: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = targets.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = left.filter(alive);
  }
  return left;
}

/**
 * Stop every Inbox a scratch folder started (SIGTERM, then SIGKILL), then
 * remove the folder: `root`, or every folder this spec made.
 */
export async function removeInboxScratch(root?: string): Promise<void> {
  const chosen = root ? [root].filter((r) => roots.has(r)) : [...roots.keys()];
  const found = new Set<number>();
  for (const dir of chosen) {
    for (const pid of roots.get(dir)!) found.add(pid);
    for (const file of registriesUnder(dir, 4)) {
      try {
        const pid = JSON.parse(readFileSync(file, 'utf8')).pid;
        if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1) found.add(pid);
      } catch {
        // Unreadable: the pids remembered at start cover it.
      }
    }
  }
  const targets = [...found].filter((pid) => pid !== process.pid && alive(pid) && isInbox(pid));
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  for (const pid of await waitGone(targets, 5_000)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone meanwhile.
    }
  }
  await waitGone(targets, 2_000);
  for (const dir of chosen) {
    rmSync(dir, { recursive: true, force: true });
    roots.delete(dir);
  }
}
