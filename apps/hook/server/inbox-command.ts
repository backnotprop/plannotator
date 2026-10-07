/**
 * `plannotator inbox`: the Plannotator Inbox subcommand.
 *
 *   plannotator inbox               start the Inbox here and open it in the
 *                                   browser, or open the one already running
 *   plannotator inbox --background  start it detached (no browser), print the
 *                                   URL, exit 0; what agents and the shim run
 *   plannotator inbox --no-open     run here without opening a browser
 *   plannotator inbox mcp           the stdio MCP entry for any agent
 *
 * On demand never pops a tab mid-work: only a person running `plannotator
 * inbox` opens one. The Inbox never registers in `sessions/` (it would hold
 * auto-update back forever); its own registry is `inbox/inbox.json`.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import {
  acquireInboxStartLock,
  inboxStatus,
  waitForInbox,
  type InboxRegistryEntry,
} from "@plannotator/shared/inbox/registry";
import { handleInboxServerReady, startInboxServer } from "@plannotator/server/inbox";
import { openBrowser } from "@plannotator/server/browser";
import { getCliVersion } from "./cli";
import { runInboxMcpShim } from "./inbox-mcp-shim";

export const INBOX_LOG_FILE = "inbox.log";
/** Set by a starter that holds the start lock for the detached Inbox it spawns. */
const LOCK_HELD_ENV = "PLANNOTATOR_INBOX_LOCK_HELD";
/** How long a starter waits for a detached Inbox to answer its health check. */
const START_TIMEOUT_MS = 20_000;

/** The argv that runs this same CLI: the compiled binary alone, or bun plus the entry script. */
function selfCommand(): string[] {
  const script = process.argv[1];
  if (script && /\.(?:[cm]?[jt]s)$/.test(script) && existsSync(script)) return [process.execPath, script];
  return [process.execPath];
}

/** Spawn `plannotator inbox --no-open` in its own session, output to inbox/inbox.log. */
function spawnDetachedInbox(dataDir: string): void {
  const dir = inboxDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, INBOX_LOG_FILE), "a", 0o600);
  const [command, ...rest] = selfCommand();
  const child = spawn(command!, [...rest, "inbox", "--no-open"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, [LOCK_HELD_ENV]: "1" },
  });
  child.unref();
  closeSync(log);
}

/**
 * The running Inbox's registry entry, starting a stopped one detached when
 * needed. Never opens a browser. Throws when it cannot be started.
 */
export async function ensureInboxRunning(dataDir: string): Promise<InboxRegistryEntry> {
  const status = await inboxStatus(dataDir);
  if (status.state === "running") return status.entry;
  const release = acquireInboxStartLock(dataDir);
  if (release) {
    try {
      spawnDetachedInbox(dataDir);
    } catch (error) {
      release();
      throw error;
    }
  }
  try {
    const running = await waitForInbox(async () => {
      const next = await inboxStatus(dataDir, 1000);
      return next.state === "running" ? next.entry : null;
    }, START_TIMEOUT_MS);
    if (!running) {
      throw new Error(`The Plannotator Inbox did not start; see ${join(inboxDir(dataDir), INBOX_LOG_FILE)}.`);
    }
    return running;
  } finally {
    release?.();
  }
}

/** Run the Inbox server in this process until a signal or the stop route ends it. */
async function serveInbox(dataDir: string, open: boolean): Promise<never> {
  // A detached Inbox runs under its starter's lock; anyone else takes it, so
  // two people (or a person and an agent) never start two writers on one store.
  const lockHeldByStarter = process.env[LOCK_HELD_ENV] === "1";
  delete process.env[LOCK_HELD_ENV];
  const release = lockHeldByStarter ? null : acquireInboxStartLock(dataDir);
  if (!lockHeldByStarter && !release) {
    const running = await waitForInbox(async () => {
      const next = await inboxStatus(dataDir, 1000);
      return next.state === "running" ? next.entry : null;
    }, START_TIMEOUT_MS);
    if (!running) {
      process.stderr.write("Another Plannotator Inbox is starting and did not come up; try again.\n");
      process.exit(1);
    }
    process.stderr.write(`Plannotator Inbox: ${running.url}\n`);
    if (open) await openBrowser(running.url);
    process.exit(0);
  }
  let inbox: Awaited<ReturnType<typeof startInboxServer>>;
  try {
    const status = await inboxStatus(dataDir);
    if (status.state === "running") {
      process.stderr.write(`Plannotator Inbox: ${status.entry.url}\n`);
      if (open) await openBrowser(status.entry.url);
      process.exit(0);
    }
    inbox = await startInboxServer({
      dataDir,
      version: getCliVersion() ?? "dev",
      // The stop route (uninstall --purge) ends the process.
      onStopRequested: () => process.exit(0),
    });
  } finally {
    release?.();
  }
  const shutdown = (code: number) => {
    inbox.stop();
    process.exit(code);
  };
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
  await handleInboxServerReady(inbox, { open });
  return new Promise<never>(() => {});
}

function usageError(message: string): never {
  process.stderr.write(`${message}\nRun 'plannotator inbox --help' for usage.\n`);
  process.exit(1);
}

export async function runInboxCommand(args: readonly string[]): Promise<never> {
  const dataDir = getPlannotatorDataDir();

  if (args[0] === "mcp") {
    if (args.length > 1) usageError(`Unknown inbox mcp option: ${args[1]}`);
    await runInboxMcpShim({
      dataDir,
      cwd: process.env.PLANNOTATOR_CWD || process.cwd(),
      ensureRunning: () => ensureInboxRunning(dataDir),
    });
    process.exit(0);
  }

  let background = false;
  let noOpen = false;
  for (const arg of args) {
    if (arg === "--background") background = true;
    else if (arg === "--no-open") noOpen = true;
    else usageError(`Unknown inbox option: ${arg}`);
  }

  if (background) {
    try {
      const entry = await ensureInboxRunning(dataDir);
      process.stdout.write(`${entry.url}\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  const status = await inboxStatus(dataDir);
  if (status.state === "running") {
    process.stderr.write(`Plannotator Inbox: ${status.entry.url}\n`);
    if (!noOpen) await openBrowser(status.entry.url);
    process.exit(0);
  }
  return serveInbox(dataDir, !noOpen);
}
