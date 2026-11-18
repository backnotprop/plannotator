/**
 * Plannotator Inbox: Run and Secret put together for one Inbox (inbox.ts calls this once): the vault this computer
 * has, the saved names' index, the runs and their journal, the login environment kept warm, the shell, the
 * clipboard and the terminal. A sandboxed test Inbox gets a file vault in its own data dir, no login shell, no
 * clipboard and no keychain.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { childEnv, childPath } from "@plannotator/shared/child-env";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxDoorCaller } from "./inbox-devices";
import type { InboxOpenInLauncher } from "./inbox-open-in";
import { LOGIN_ENV_FALLBACKS } from "./inbox-launch-env";
import { createInboxRuns } from "./inbox-run";
import { fileRunJournal } from "./inbox-run-journal";
import { createInboxRunRoutes, openRunTerminal } from "./inbox-run-routes";
import { runShellFor, systemClipboard } from "./inbox-run-shell";
import { createInboxSecrets } from "./inbox-secrets";
import { fileVault, spawnVaultRun, systemSecretVault } from "./inbox-secret-vault";

/** How long a read login environment is used before it is read again (in the background, never on a press). */
export const INBOX_RUN_ENV_MAX_AGE_MS = 5 * 60_000;

/**
 * The login environment, read once and kept: a press uses the kept copy at once and reads it again behind itself
 * (so a tool installed a moment ago is there on the next press), and a copy older than `maxAgeMs` is read again
 * behind any use. A read that fell back to the Inbox's own env (`isFallback`: the login shell did not answer) is
 * used once and never kept. `peek` is the kept copy, or null before the first good read.
 */
export function keptLoginEnv(read: () => Promise<Record<string, string>>, options: { maxAgeMs?: number; now?: () => number; isFallback?: (env: Record<string, string>) => boolean } = {}) {
  const now = options.now ?? (() => Date.now());
  const maxAge = options.maxAgeMs ?? INBOX_RUN_ENV_MAX_AGE_MS;
  const isFallback = options.isFallback ?? (() => false);
  let kept: Record<string, string> | null = null;
  let at = 0;
  let reading: Promise<Record<string, string>> | null = null;
  const refresh = () => {
    reading ??= read()
      .then((env) => {
        if (!isFallback(env)) {
          kept = env;
          at = now();
        }
        return env;
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  };
  const behind = () => void refresh().catch(() => {});
  return {
    get: async (): Promise<Record<string, string>> => {
      if (!kept) return refresh();
      if (now() - at > maxAge) behind();
      return kept;
    },
    /** For a press: the kept copy now, and a fresh read behind it for the next press. */
    forPress: async (): Promise<Record<string, string>> => {
      if (!kept) return refresh();
      const env = kept;
      behind();
      return env;
    },
    peek: (): Record<string, string> | null => kept,
  };
}

/** macOS keeps /tmp at /private/tmp: a folder there reads as the person wrote it, /tmp/…. */
export const macTmp = (path: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "darwin" && (path === "/private/tmp" || path.startsWith("/private/tmp/")) ? path.slice("/private".length) : path;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `ps -o lstart` in UTC ("Wed Nov 18 13:36:52 2026") as ms since the epoch; null when it reads otherwise. */
export function parsePsStart(text: string): number | null {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  return m && month !== -1 ? Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) : null;
}

/** When a process started, by `ps` (POSIX): ms since the epoch, "gone" when there is no such process, null when it can't tell. */
async function processStartedAt(pid: number): Promise<number | "gone" | null> {
  const ps = ["/bin/ps", "/usr/bin/ps"].find((path) => existsSync(path));
  if (!ps) return null;
  try {
    // In UTC, read as UTC: the Inbox's own time zone (a test runner's UTC, the person's local one) never shifts it.
    const child = Bun.spawn([ps, "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...childEnv(), LC_ALL: "C", TZ: "UTC0" }, windowsHide: true });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0 || text.trim() === "") return "gone";
    return parsePsStart(text);
  } catch {
    return null;
  }
}

/**
 * Whether a lost run's command still runs (POSIX): its process group is there, and its leader is the process this
 * Inbox started (same start time, to the second), or gone while the group lives on (a group id is not given out
 * again while the group exists). Windows: null, unknown.
 */
export async function lostRunStillRunning(pid: number, startedAt: number, platform: NodeJS.Platform = process.platform, startedOf = processStartedAt): Promise<boolean | null> {
  if (platform === "win32") return null;
  try {
    process.kill(-pid, 0);
  } catch {
    return false;
  }
  const started = await startedOf(pid);
  if (started === "gone") return true;
  if (started === null) return null;
  return Math.abs(started - startedAt) <= 2_000;
}

export function createInboxRunSetup(options: {
  store: InboxStore;
  serverSession: string;
  dataDir: string;
  sandbox: boolean;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** Reads the person's login-shell environment (the launch's reader). */
  readLoginEnv: () => Promise<Record<string, string>>;
  door: (req: Request) => InboxDoorCaller | undefined;
  /** This computer as a card says it: in its own window ("your Mac"), or by its name for a phone or a linked machine. */
  computer: (viaDoor: boolean) => string;
  displayFolder: (path: string) => string;
  openInLauncher: InboxOpenInLauncher;
}) {
  const { store, dataDir, sandbox } = options;
  const which = (cmd: string) => Bun.which(cmd, { PATH: childPath() }) ?? null;
  const vault = sandbox
    ? fileVault(join(dataDir, "inbox", "secrets"))
    : systemSecretVault({ platform: process.platform, dir: join(dataDir, "inbox", "secrets"), run: spawnVaultRun, env: process.env, which });
  const pwsh = process.platform === "win32" && !sandbox ? which("pwsh") : null;
  return createInboxRunRoutes({
    store,
    serverSession: options.serverSession,
    readBody: options.readBody,
    json: options.json,
    runs: createInboxRuns({ messageAlive: (id) => store.message(id) !== null, journal: fileRunJournal(join(dataDir, "inbox", "runs.json")), stillRunning: (pid, at) => lostRunStillRunning(pid, at) }),
    secrets: createInboxSecrets({ file: join(dataDir, "inbox", "secrets.json"), vault }),
    vault,
    loginEnv: keptLoginEnv(options.readLoginEnv, { isFallback: (env) => LOGIN_ENV_FALLBACKS.has(env) }),
    shellFor: (env) => runShellFor(process.platform, env, { pwsh }),
    copyToClipboard: sandbox ? async () => false : systemClipboard(process.platform, which),
    door: options.door,
    computer: options.computer,
    displayFolder: (path) => options.displayFolder(macTmp(path)),
    openTerminal: (folder) => openRunTerminal(options.openInLauncher, folder),
  });
}
