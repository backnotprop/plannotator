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
/** How long the Inbox's own env stands in for a login shell that did not answer, while it is read again behind. */
export const INBOX_RUN_ENV_FALLBACK_MS = 60_000;

/**
 * The login environment, read once and kept: a press uses the kept copy at once and reads it again behind itself
 * (so a tool installed a moment ago is there on the next press), and a copy older than `maxAgeMs` is read again
 * behind any use. A read that fell back to the Inbox's own env (`isFallback`: the login shell did not answer)
 * stands in for at most `fallbackMs` (so a shell that never answers does not make every press wait for it), each use
 * reading again behind it; a good read replaces it at once. `peek` is the kept copy, or null before the first read.
 */
export function keptLoginEnv(read: () => Promise<Record<string, string>>, options: { maxAgeMs?: number; fallbackMs?: number; now?: () => number; isFallback?: (env: Record<string, string>) => boolean } = {}) {
  const now = options.now ?? (() => Date.now());
  const maxAge = options.maxAgeMs ?? INBOX_RUN_ENV_MAX_AGE_MS;
  const fallbackMs = options.fallbackMs ?? INBOX_RUN_ENV_FALLBACK_MS;
  const isFallback = options.isFallback ?? (() => false);
  let kept: Record<string, string> | null = null;
  let keptFallback = false;
  let at = 0;
  let reading: Promise<Record<string, string>> | null = null;
  const refresh = () => {
    reading ??= read()
      .then((env) => {
        const fallback = isFallback(env);
        // A fallback never replaces a good read; a good read always replaces a fallback. Its minute counts from the
        // first stand-in taken, so a shell that keeps not answering is waited for again once a minute, not never.
        if (!fallback) {
          kept = env;
          keptFallback = false;
          at = now();
        } else if (!kept || (keptFallback && now() - at > fallbackMs)) {
          kept = env;
          keptFallback = true;
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
  /** The kept copy while it may be used: a good read, or a fallback younger than `fallbackMs`. */
  const usable = () => (kept && (!keptFallback || now() - at <= fallbackMs) ? kept : null);
  return {
    get: async (): Promise<Record<string, string>> => {
      const env = usable();
      if (!env) return refresh();
      if (keptFallback || now() - at > maxAge) behind();
      return env;
    },
    /** For a press: the kept copy now, and a fresh read behind it for the next press. */
    forPress: async (): Promise<Record<string, string>> => {
      const env = usable();
      if (!env) return refresh();
      behind();
      return env;
    },
    peek: (): Record<string, string> | null => usable(),
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

/** `ps -o lstart= -p <pid>`: its words and exit code, or null when there is no `ps` or it could not run. */
export type PsStart = (pid: number) => Promise<{ code: number; text: string } | null>;
const psStart: PsStart = async (pid) => {
  const ps = ["/bin/ps", "/usr/bin/ps"].find((path) => existsSync(path));
  if (!ps) return null;
  try {
    // In UTC, read as UTC: the Inbox's own time zone (a test runner's UTC, the person's local one) never shifts it.
    const child = Bun.spawn([ps, "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...childEnv(), LC_ALL: "C", TZ: "UTC0" }, windowsHide: true });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, text };
  } catch {
    return null;
  }
};

/**
 * When a process started, by `ps` (POSIX): ms since the epoch, "gone" when there is no such process, null when it
 * can't tell. `ps` saying nothing counts as "gone" only when it answers for this Inbox's own process the same way
 * it should: a `ps` without `-o lstart` (BusyBox) or one that fails is unknown, never a run still going.
 */
export async function processStartedAt(pid: number, ps: PsStart = psStart): Promise<number | "gone" | null> {
  const asked = await ps(pid);
  if (!asked) return null;
  if (asked.code === 0 && asked.text.trim() !== "") return parsePsStart(asked.text);
  const self = await ps(process.pid);
  return self && self.code === 0 && parsePsStart(self.text) !== null ? "gone" : null;
}

/** The start times of a process group's live processes (ms), or null when `ps` cannot tell. */
export type GroupStarts = (pgid: number) => Promise<number[] | null>;
const psGroupStarts: GroupStarts = async (pgid) => {
  const ps = ["/bin/ps", "/usr/bin/ps"].find((path) => existsSync(path));
  if (!ps) return null;
  try {
    const child = Bun.spawn([ps, "-A", "-o", "pgid=,lstart="], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...childEnv(), LC_ALL: "C", TZ: "UTC0" }, windowsHide: true });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) return null;
    const starts: number[] = [];
    for (const line of text.split("\n")) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!m || Number(m[1]) !== pgid) continue;
      const at = parsePsStart(m[2]!);
      if (at === null) return null;
      starts.push(at);
    }
    return starts;
  } catch {
    return null;
  }
};

/**
 * Whether a lost run's command still runs (POSIX): its process group is there, and its leader is the process this
 * Inbox started (same start time, to the second), or the leader is gone and a process of the group started between
 * the run's start and when the Inbox last wrote it down (`seenAt`): a group by that id made since by another program
 * has none such. Anything it cannot tell: null, unknown (no signal). Windows: null.
 */
export async function lostRunStillRunning(
  pid: number,
  startedAt: number,
  platform: NodeJS.Platform = process.platform,
  startedOf = processStartedAt,
  seenAt: number = startedAt,
  groupStarts: GroupStarts = psGroupStarts,
): Promise<boolean | null> {
  if (platform === "win32") return null;
  try {
    process.kill(-pid, 0);
  } catch {
    return false;
  }
  const started = await startedOf(pid);
  if (started === null) return null;
  if (started !== "gone") return Math.abs(started - startedAt) <= 2_000;
  // The leader is gone while a group by its id lives on: ours only with a process of it from while ours ran.
  const starts = await groupStarts(pid);
  if (starts === null) return null;
  return starts.some((at) => at >= startedAt - 2_000 && at <= seenAt + 2_000) ? true : null;
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
  /** A message's run state changed (null: every message, a secret saved or removed): windows read those cards again. */
  changed: (messageIds: readonly string[] | null) => void;
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
    runs: createInboxRuns({ messageAlive: (id) => store.message(id) !== null, journal: fileRunJournal(join(dataDir, "inbox", "runs.json")), stillRunning: (pid, at, seen) => lostRunStillRunning(pid, at, process.platform, processStartedAt, seen), onChange: (id) => options.changed([id]) }),
    secrets: createInboxSecrets({ file: join(dataDir, "inbox", "secrets.json"), vault }),
    vault,
    loginEnv: keptLoginEnv(options.readLoginEnv, { isFallback: (env) => LOGIN_ENV_FALLBACKS.has(env) }),
    shellFor: (env) => runShellFor(process.platform, env, { pwsh }),
    copyToClipboard: sandbox ? async () => false : systemClipboard(process.platform, which),
    door: options.door,
    computer: options.computer,
    displayFolder: (path) => options.displayFolder(macTmp(path)),
    openTerminal: (folder) => openRunTerminal(options.openInLauncher, folder),
    changed: options.changed,
  });
}
