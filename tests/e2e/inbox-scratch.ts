/**
 * Temp folders for the Inbox e2e specs, and a teardown that never leaves an
 * Inbox running. A spec makes each folder with `inboxScratch(prefix)` (one
 * `mkdtempSync` under the OS temp dir, remembered) and ends with
 * `await removeInboxScratch()` (every folder) or `removeInboxScratch(root)`
 * (one) in a `finally`, so it runs when a browser close throws, a test fails
 * half way, or `beforeAll` failed before the world was assembled.
 *
 * It signals only an Inbox it can prove the folder started
 * (`provenInbox` in tests/helpers/inbox-process.ts). The candidates are the
 * entries `rememberInboxOf` read after each start (a spec that restarts its
 * Inbox has several; the file names only the latest) and the
 * `inbox/inbox.json` files under the folder. Anything else (a pid reused by
 * another process, the person's own Inbox, an Inbox answering for another
 * session) is never signalled. SIGTERM first (the clean stop takes a tailnet
 * mapping down), SIGKILL what is still the same proven process five seconds
 * later, then the folder goes. A spec that stops its own Inbox mid-test uses
 * `stopScratchInbox`, which goes through the same proof.
 *
 * Why: inbox-tailscale.spec.ts signalled the one pid inbox.json named and
 * removed its folder; an Inbox it had started with `--tailscale` ran on for
 * two days at 100% CPU with its data folder gone. An Inbox now also exits on
 * its own once its data is gone (`onDataGone` in packages/server/inbox.ts);
 * a spec does not rely on that.
 */

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { type InboxEntry, inboxEntryOf, mustSignalInbox, readInboxEntry, stopProvenInboxes, waitGone } from '../helpers/inbox-process';
import { refuseRealDataDir } from '../helpers/real-data-dir';

/** Each scratch folder and the entries remembered for it. */
const roots = new Map<string, Map<string, InboxEntry>>();

const keyOf = (e: InboxEntry) => `${e.pid}:${e.port}:${e.serverSession}`;

/** A new folder under the OS temp dir, removed (with any Inbox it started) by `removeInboxScratch`. */
export function inboxScratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.set(root, new Map());
  return root;
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

/** The scratch folder holding `dataDir`, after refusing the real data directory. */
function rootOf(dataDir: string): string | undefined {
  refuseRealDataDir(dataDir, 'tests/e2e/inbox-scratch.ts');
  return [...roots.keys()].find((r) => inside(dataDir, r));
}

/** Remember the entry in `<dataDir>/inbox/inbox.json` (right after each start), for the scratch folder holding `dataDir`. */
export function rememberInboxOf(dataDir: string): void {
  const root = rootOf(dataDir);
  const entry = root ? inboxEntryOf(dataDir) : null;
  if (root && entry) roots.get(root)!.set(keyOf(entry), entry);
}

/**
 * Stop the Inbox `<dataDir>/inbox/inbox.json` names, mid-test, with `signal`
 * (SIGTERM by default) once it is proven to be the one this scratch folder
 * started, and wait for it to exit. Throws when it cannot be proven: a spec
 * that means to stop its own Inbox must never signal something else.
 * Returns the pid it stopped.
 */
export async function stopScratchInbox(dataDir: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<number> {
  const root = rootOf(dataDir);
  if (!root) throw new Error(`${dataDir} is not inside a scratch folder from inboxScratch()`);
  const entry = await mustSignalInbox(inboxEntryOf(dataDir), root, signal);
  roots.get(root)!.set(keyOf(entry), entry);
  if ((await waitGone([entry.pid], 10_000)).length > 0) throw new Error(`the Inbox (pid ${entry.pid}) did not exit after ${signal}`);
  return entry.pid;
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

/**
 * Stop every Inbox a scratch folder provably started (SIGTERM, then SIGKILL),
 * then remove the folder: `root`, or every folder this spec made.
 */
export async function removeInboxScratch(root?: string): Promise<void> {
  const chosen = root ? [root].filter((r) => roots.has(r)) : [...roots.keys()];
  const targets: { entry: InboxEntry; root: string }[] = [];
  for (const dir of chosen) {
    const entries = new Map(roots.get(dir)!);
    for (const file of registriesUnder(dir, 4)) {
      const entry = readInboxEntry(file);
      if (entry) entries.set(keyOf(entry), entry);
    }
    for (const entry of entries.values()) targets.push({ entry, root: dir });
  }
  await stopProvenInboxes(targets);
  for (const dir of chosen) {
    rmSync(dir, { recursive: true, force: true });
    roots.delete(dir);
  }
}
