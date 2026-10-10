/**
 * `plannotator inbox`: the Plannotator Inbox subcommand.
 *
 *   plannotator inbox               start the Inbox here and open it in the
 *                                   browser, or open the one already running
 *   plannotator inbox --background  start it detached (no browser), print the
 *                                   URL, exit 0; what agents and the shim run
 *   plannotator inbox --no-open     run here without opening a browser
 *   plannotator inbox --tailscale   also publish it over the tailnet for this
 *                                   run (with any of the above; a running
 *                                   Inbox is asked to publish), for the
 *                                   Tailscale login that owns this machine
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
  readInboxRegistry,
  waitForInbox,
  type InboxRegistryEntry,
} from "@plannotator/shared/inbox/registry";
import { handleInboxServerReady, startInboxServer } from "@plannotator/server/inbox";
import type { InboxTailscaleState } from "@plannotator/server/inbox-tailscale";
import { openBrowser } from "@plannotator/server/browser";
import { writeUrlQr } from "@plannotator/server/qr";
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
function spawnDetachedInbox(dataDir: string, tailscale: boolean): void {
  const dir = inboxDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, INBOX_LOG_FILE), "a", 0o600);
  const [command, ...rest] = selfCommand();
  const child = spawn(command!, [...rest, "inbox", "--no-open", ...(tailscale ? ["--tailscale"] : [])], {
    detached: true,
    // Never the starter's folder: a long-lived process would hold the agent's
    // project as its working directory (on Windows that blocks deleting or
    // renaming it). Everything the Inbox reads is an absolute path.
    cwd: dir,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, [LOCK_HELD_ENV]: "1" },
  });
  child.unref();
  closeSync(log);
}

/** Wait for the Inbox to answer as running; null on timeout. */
function waitUntilRunning(dataDir: string): Promise<InboxRegistryEntry | null> {
  return waitForInbox(async () => {
    const next = await inboxStatus(dataDir, 1000);
    return next.state === "running" ? next.entry : null;
  }, START_TIMEOUT_MS);
}

/**
 * A busy Inbox (live pid, port taking the request, no answer yet) is waited
 * for, never replaced: a second process would be a second writer on the store.
 */
async function waitForBusyInbox(dataDir: string, pid: number): Promise<InboxRegistryEntry> {
  const running = await waitUntilRunning(dataDir);
  if (!running) {
    throw new Error(`The Plannotator Inbox (pid ${pid}) is running but not answering; quit it and try again.`);
  }
  return running;
}

/**
 * The running Inbox's registry entry, starting a stopped one detached when
 * needed. Never opens a browser. Throws when it cannot be started.
 */
export async function ensureInboxRunning(dataDir: string, options: { tailscale?: boolean } = {}): Promise<InboxRegistryEntry> {
  const status = await inboxStatus(dataDir);
  if (status.state === "running") return status.entry;
  if (status.state === "busy") return waitForBusyInbox(dataDir, status.entry.pid);
  const release = acquireInboxStartLock(dataDir);
  if (release) {
    try {
      spawnDetachedInbox(dataDir, options.tailscale === true);
    } catch (error) {
      release();
      throw error;
    }
  }
  try {
    const running = await waitUntilRunning(dataDir);
    if (!running) {
      throw new Error(`The Plannotator Inbox did not start; see ${join(inboxDir(dataDir), INBOX_LOG_FILE)}.`);
    }
    return running;
  } finally {
    release?.();
  }
}

/** Where the Inbox is on the tailnet, or why it is not there; the Inbox runs locally either way. Stderr only. */
function reportTailnet(state: { url: string | null; error: string | null; allowed?: readonly string[] } | undefined, requested: boolean): void {
  if (!state) {
    if (requested) process.stderr.write("Over your tailnet: not published.\n");
    return;
  }
  if (state.url) {
    const who = state.allowed?.length ? ` (only ${state.allowed.join(", ")})` : "";
    process.stderr.write(`Over your tailnet: ${state.url}${who}\n`);
    writeUrlQr(state.url);
    return;
  }
  if (state.error) process.stderr.write(`Not published over your tailnet: ${state.error} The Inbox runs on this computer as usual.\n`);
}

/** `--tailscale` is for this run; say how to keep it. */
function reportFlagScope(): void {
  process.stderr.write(
    'Published for this run. To publish at every start, turn on "Over your tailnet" in the Inbox\'s Settings (or set PLANNOTATOR_INBOX_TAILSCALE=1).\n',
  );
}

/**
 * `--tailscale` with an Inbox already running: ask it to publish for this
 * run, through its token-guarded connection route. An Inbox that predates
 * the route answers 404.
 */
async function publishRunningInbox(entry: InboxRegistryEntry): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/control/tailscale`, {
      method: "POST",
      headers: { Authorization: `Bearer ${entry.token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) {
      process.stderr.write("The running Inbox is an older version without --tailscale; quit it and run plannotator inbox --tailscale again.\n");
      return;
    }
    if (!response.ok) {
      process.stderr.write(`The running Inbox did not publish over your tailnet (HTTP ${response.status}).\n`);
      return;
    }
    const body = (await response.json()) as { tailscale?: InboxTailscaleState };
    reportTailnet(body.tailscale, true);
    if (body.tailscale?.url && body.tailscale.source === "flag") reportFlagScope();
  } catch (error) {
    process.stderr.write(`Could not reach the running Inbox: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** Run the Inbox server in this process until a signal or the stop route ends it. */
async function serveInbox(dataDir: string, open: boolean, htmlContent: string | undefined, tailscale: boolean): Promise<never> {
  // A detached Inbox runs under its starter's lock; anyone else takes it, so
  // two people (or a person and an agent) never start two writers on one store.
  const lockHeldByStarter = process.env[LOCK_HELD_ENV] === "1";
  delete process.env[LOCK_HELD_ENV];
  const release = lockHeldByStarter ? null : acquireInboxStartLock(dataDir);
  if (!lockHeldByStarter && !release) {
    const running = await waitUntilRunning(dataDir);
    if (!running) {
      process.stderr.write("Another Plannotator Inbox is starting and did not come up; try again.\n");
      process.exit(1);
    }
    process.stderr.write(`Plannotator Inbox: ${running.url}\n`);
    if (tailscale) await publishRunningInbox(running);
    if (open) await openBrowser(running.url);
    process.exit(0);
  }
  let inbox: Awaited<ReturnType<typeof startInboxServer>>;
  try {
    const status = await inboxStatus(dataDir);
    if (status.state === "running" || status.state === "busy") {
      const entry = status.state === "running" ? status.entry : await waitForBusyInbox(dataDir, status.entry.pid);
      process.stderr.write(`Plannotator Inbox: ${entry.url}\n`);
      if (tailscale) await publishRunningInbox(entry);
      if (open) await openBrowser(entry.url);
      process.exit(0);
    }
    inbox = await startInboxServer({
      dataDir,
      version: getCliVersion() ?? "dev",
      htmlContent,
      selfCommand: selfCommand(),
      publishTailnet: tailscale,
      // The stop route (uninstall --purge) ends the process.
      onStopRequested: () => process.exit(0),
      // The window's Restart: this server has stopped listening, so the
      // registry reads stopped; start the binary on disk detached (its own
      // start lock, the last port first) and end this process. A run
      // published only by --tailscale passes it on.
      onRestartRequested: () => {
        ensureInboxRunning(dataDir, { tailscale: inbox.tailscale.runOnly() })
          .catch((error) => process.stderr.write(`Restart failed: ${error instanceof Error ? error.message : String(error)}\n`))
          .finally(() => process.exit(0));
      },
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
  const tailnet = inbox.tailscale.state();
  if (tailnet.on) {
    reportTailnet(tailnet, tailscale);
    if (tailnet.url && tailnet.source === "flag") reportFlagScope();
  }
  return new Promise<never>(() => {});
}

function usageError(message: string): never {
  process.stderr.write(`${message}\nRun 'plannotator inbox --help' for usage.\n`);
  process.exit(1);
}

export interface InboxCommandAssets {
  /** The built window (`apps/hook/dist/inbox.html`), embedded by the binary. */
  htmlContent?: string;
}

export async function runInboxCommand(args: readonly string[], assets: InboxCommandAssets = {}): Promise<never> {
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
  let tailscale = false;
  for (const arg of args) {
    if (arg === "--background") background = true;
    else if (arg === "--no-open") noOpen = true;
    else if (arg === "--tailscale") tailscale = true;
    else usageError(`Unknown inbox option: ${arg}`);
  }

  if (background) {
    try {
      const before = await inboxStatus(dataDir);
      const entry = await ensureInboxRunning(dataDir, { tailscale });
      // Stdout stays the local URL alone (agents read it); the tailnet goes to stderr.
      if (tailscale && (before.state === "running" || before.state === "busy")) await publishRunningInbox(entry);
      else reportTailnet(readInboxRegistry(dataDir)?.tailscale ?? entry.tailscale, tailscale);
      process.stdout.write(`${entry.url}\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  const status = await inboxStatus(dataDir);
  if (status.state === "running" || status.state === "busy") {
    let entry: InboxRegistryEntry;
    try {
      entry = status.state === "running" ? status.entry : await waitForBusyInbox(dataDir, status.entry.pid);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    process.stderr.write(`Plannotator Inbox: ${entry.url}\n`);
    if (tailscale) await publishRunningInbox(entry);
    if (!noOpen) await openBrowser(entry.url);
    process.exit(0);
  }
  return serveInbox(dataDir, !noOpen, assets.htmlContent, tailscale);
}
