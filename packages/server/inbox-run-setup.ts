/**
 * Plannotator Inbox: Run and Secret put together for one Inbox (inbox.ts calls this once): the vault this computer
 * has, the saved names' index, the runs and their journal, the login environment kept warm, the shell, the
 * clipboard and the terminal. A sandboxed test Inbox gets a file vault in its own data dir, no login shell, no
 * clipboard and no keychain.
 */

import { join } from "node:path";
import { childPath } from "@plannotator/shared/child-env";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxDoorCaller } from "./inbox-devices";
import type { InboxOpenInLauncher } from "./inbox-open-in";
import { createInboxRuns } from "./inbox-run";
import { fileRunJournal } from "./inbox-run-journal";
import { createInboxRunRoutes, openRunTerminal } from "./inbox-run-routes";
import { runShellFor, systemClipboard } from "./inbox-run-shell";
import { createInboxSecrets } from "./inbox-secrets";
import { fileVault, spawnVaultRun, systemSecretVault } from "./inbox-secret-vault";

/** How long a read login environment is used before it is read again (in the background, never on a press). */
export const INBOX_RUN_ENV_MAX_AGE_MS = 5 * 60_000;

/**
 * The login environment, read once and kept: a press uses the kept copy at once, and a copy older than `maxAgeMs`
 * is read again behind it. `peek` is the kept copy, or null before the first read ends.
 */
export function keptLoginEnv(read: () => Promise<Record<string, string>>, options: { maxAgeMs?: number; now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());
  const maxAge = options.maxAgeMs ?? INBOX_RUN_ENV_MAX_AGE_MS;
  let kept: Record<string, string> | null = null;
  let at = 0;
  let reading: Promise<Record<string, string>> | null = null;
  const refresh = () => {
    reading ??= read()
      .then((env) => {
        kept = env;
        at = now();
        return env;
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  };
  return {
    get: async (): Promise<Record<string, string>> => {
      if (!kept) return refresh();
      if (now() - at > maxAge) void refresh().catch(() => {});
      return kept;
    },
    peek: (): Record<string, string> | null => kept,
  };
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
  computer: () => string;
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
    runs: createInboxRuns({ messageAlive: (id) => store.message(id) !== null, journal: fileRunJournal(join(dataDir, "inbox", "runs.json")) }),
    secrets: createInboxSecrets({ file: join(dataDir, "inbox", "secrets.json"), vault }),
    vault,
    loginEnv: keptLoginEnv(options.readLoginEnv),
    shellFor: (env) => runShellFor(process.platform, env, { pwsh }),
    copyToClipboard: sandbox ? async () => false : systemClipboard(process.platform, which),
    door: options.door,
    computer: options.computer,
    displayFolder: options.displayFolder,
    openTerminal: (folder) => openRunTerminal(options.openInLauncher, folder),
  });
}
