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

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { type InboxEntry, inboxEntryOf, mustSignalInbox, readInboxEntry, refuseRealHome, stopProvenInboxes, waitGone } from '../helpers/inbox-process';
import { NO_BROWSER } from '../helpers/no-browser';
import { refuseRealDataDir } from '../helpers/real-data-dir';

/** Each scratch folder and the entries remembered for it. */
const roots = new Map<string, Map<string, InboxEntry>>();

const keyOf = (e: InboxEntry) => `${e.pid}:${e.port}:${e.serverSession}`;

/**
 * A new folder under the OS temp dir, removed (with any Inbox it started) by `removeInboxScratch`. Its data dir
 * (`<root>/data`, where nearly every spec points PLANNOTATOR_DATA_DIR) starts with launch off (`launchOff`).
 */
export function inboxScratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.set(root, new Map());
  launchOff(join(root, 'data'));
  return root;
}

/**
 * Starting agents from New message is on by default since 0.29, and with it on, opening New message (or the Board)
 * looks `claude` up on the Inbox's PATH and runs `claude --version`: on the runner's PATH that is the stub
 * (tests/e2e/agent-cli-stubs.ts), whose teardown fails the run, and the login shell is read too. So an e2e world
 * starts with launch off (`inboxLaunch.enabled: false`, merged into config.json); a spec about launch turns it on
 * in its own config, with its fakes on a PATH of its own. A spec that writes config.json whole keeps this key.
 */
export function launchOff(dataDir: string): void {
  refuseRealDataDir(dataDir, 'tests/e2e/inbox-scratch.ts launchOff');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'config.json');
  const config = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(file, JSON.stringify({ ...config, ...E2E_LAUNCH_OFF }));
}

/** The config.json key every e2e world starts with (`launchOff`): spread it into a config a spec writes whole. */
export const E2E_LAUNCH_OFF = { inboxLaunch: { enabled: false } } as const;

/**
 * What every Plannotator process a spec starts under `root` needs: a scratch
 * HOME (with none, `os.homedir()` falls back to the account's home), a scratch
 * data dir, no browser and no ping. Spread it into the spawn env, then add the
 * spec's own variables. HOME is `root/home` unless the spec names its own
 * (`{ home: root }` when the world's folders sit under HOME, as `~/src/…` does);
 * either way it must be a scratch folder. tests/e2e-spawn-home.test.ts fails on
 * an e2e env that sets a data dir with neither a scratch HOME nor this.
 */
export function scratchEnv(root: string, options: { home?: string } = {}): { HOME: string; PLANNOTATOR_DATA_DIR: string; PLANNOTATOR_BROWSER: string; NO_ANON_PING: string } {
  const HOME = refuseRealHome(options.home ?? join(root, 'home'), 'tests/e2e/inbox-scratch.ts scratchEnv');
  mkdirSync(HOME, { recursive: true });
  const PLANNOTATOR_DATA_DIR = join(root, 'data');
  refuseRealDataDir(PLANNOTATOR_DATA_DIR, 'tests/e2e/inbox-scratch.ts scratchEnv');
  return { HOME, PLANNOTATOR_DATA_DIR, PLANNOTATOR_BROWSER: NO_BROWSER, NO_ANON_PING: '1' };
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
    // A short retry: a process that is still exiting may write into the folder while it is removed (ENOTEMPTY).
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    roots.delete(dir);
  }
}
