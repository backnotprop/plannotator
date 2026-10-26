/**
 * `plannotator inbox`: the Plannotator Inbox subcommand.
 *
 *   plannotator inbox               start the Inbox here and open it in the
 *                                   browser, or open the one already running
 *   plannotator inbox --background  start it detached (no browser), print the
 *                                   URL, exit 0; what agents and the shim run
 *   plannotator inbox --no-open     run here without opening a browser
 *   plannotator inbox --open        open it in the browser, starting it
 *                                   detached first when it is not running;
 *                                   print the URL, exit 0 (never blocks: what
 *                                   the /plannotator-inbox commands run)
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
import { exposureWarning, type InboxTailscaleState } from "@plannotator/server/inbox-tailscale";
import { openBrowser, openBrowserDetached } from "@plannotator/server/browser";
import { isRemoteSession } from "@plannotator/server/remote";
import { agentSpec, createAgentEnvironment, formatConnectReport, inboxConnectDisabled } from "@plannotator/server/inbox-agents";
import { addInboxNote, INBOX_NOTE_BODY, inboxNotesDisabled, markNotesAsked } from "@plannotator/server/inbox-agent-notes";
import { INBOX_AGENT_LABELS, INBOX_AUTO_SEND_AFTER_MS, INBOX_NOTE_AGENT_IDS, type InboxConnectReport, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { writeUrlQr } from "@plannotator/server/qr";
import { getCliVersion } from "./cli";
import { inboxHostSessionFromEnv, runInboxMcpShim } from "./inbox-mcp-shim";

export const INBOX_LOG_FILE = "inbox.log";
/** Set by a starter that holds the start lock for the detached Inbox it spawns. */
const LOCK_HELD_ENV = "PLANNOTATOR_INBOX_LOCK_HELD";
/**
 * Set on an Inbox started detached (`--background`, a connection or the shim
 * starting a stopped one, the window's Restart): such a start never connects
 * agents, which only a person's `plannotator inbox` does. Scrubbed at start.
 * LOCK_HELD_ENV alone means the same (an older Inbox's spawn, which predates
 * this marker; see runInboxCommand).
 */
const DETACHED_ENV = "PLANNOTATOR_INBOX_DETACHED";
/** How long a starter waits for a detached Inbox to answer its health check. */
const START_TIMEOUT_MS = 20_000;

/**
 * The argv that runs this same CLI: the compiled binary alone, or bun plus the
 * entry script. Exported for `plannotator inbox --help`, whose agent guide
 * names it, as the window's connect snippets do (`mcp_command`).
 */
export function selfCommand(): string[] {
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
    env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, [LOCK_HELD_ENV]: "1", [DETACHED_ENV]: "1" },
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

/** `--open` over SSH: no browser opened on the remote host, so say how to reach the Inbox. */
export function inboxRemoteOpenHint(port: number): string {
  return `No browser opened: this is a remote session. Forward the port (ssh -L ${port}:127.0.0.1:${port} <this host>) and open the URL, or run plannotator inbox --tailscale.`;
}

/** Where the Inbox is on the tailnet, or why it is not there; the Inbox runs locally either way. Stderr only. */
function reportTailnet(state: Partial<InboxTailscaleState> & { url: string | null; error: string | null } | undefined, requested: boolean): void {
  if (!state) {
    if (requested) process.stderr.write("Over your tailnet: not published.\n");
    return;
  }
  if (state.exposed?.length) process.stderr.write(`Warning: ${exposureWarning(state.exposed)} Open Settings > Over your tailnet to replace it.\n`);
  if (requested && state.on === false && state.source === "env") {
    process.stderr.write("Not published over your tailnet: PLANNOTATOR_INBOX_TAILSCALE turns it off in the Inbox's environment.\n");
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

/** What connecting the agents did, on stderr (stdout is unchanged). Nothing when nothing changed. */
function reportConnect(report: InboxConnectReport | undefined): void {
  if (!report) return;
  for (const line of formatConnectReport(report)) process.stderr.write(`${line}\n`);
}

/**
 * `plannotator inbox` with an Inbox already running (an agent may have
 * started it with --background): ask it to connect the agents on this
 * computer, through its token-guarded connection route. An Inbox that
 * predates the route answers 404, and connects nothing.
 */
async function connectRunningInbox(entry: InboxRegistryEntry): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/control/connect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${entry.token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(40_000),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { connect?: InboxConnectReport };
    reportConnect(body.connect);
  } catch {
    // The agents are connected at the next run.
  }
}

/** Run the Inbox server in this process until a signal or the stop route ends it. */
async function serveInbox(dataDir: string, open: boolean, htmlContent: string | undefined, tailscale: boolean, connect: boolean): Promise<never> {
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
    if (connect) await connectRunningInbox(running);
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
      if (connect) await connectRunningInbox(entry);
      process.exit(0);
    }
    inbox = await startInboxServer({
      dataDir,
      version: getCliVersion() ?? "dev",
      htmlContent,
      selfCommand: selfCommand(),
      publishTailnet: tailscale,
      // Testing knob: how long a reply waits on a busy agent before it goes in by itself (default 5 minutes).
      ...autoSendAfterMsFromEnv(),
      // The stop route (uninstall --purge) ends the process.
      onStopRequested: () => process.exit(0),
      // Its data folder (or inbox.json) is gone or another Inbox's: nothing
      // can reach this one and it has no store, so it ends (the server has
      // stopped and said why on stderr) instead of running on headless.
      onDataGone: () => process.exit(0),
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
  // Off the request path: the window is already open, and its note dialog shows
  // what this did once it is done (GET /api/inbox/agents).
  if (connect) void inbox.connectAgents().then(reportConnect, () => {});
  const tailnet = inbox.tailscale.state();
  if (tailnet.on || tailscale) {
    // This process's stderr already carries the server's own exposure warning.
    reportTailnet({ ...tailnet, exposed: [] }, tailscale);
    if (tailnet.url && tailnet.source === "flag") reportFlagScope();
  }
  return new Promise<never>(() => {});
}

/**
 * `plannotator inbox --notes codex,gemini`: add the Inbox note to these
 * agents' instructions files (inbox-agent-notes.ts), for the install prompt
 * once the person agreed in chat, and mark the window's one-time question as
 * answered. Starts nothing. Exit 0 when every note is there, 1 otherwise.
 */
async function writeNotes(dataDir: string, list: string): Promise<number> {
  const ids = [...new Set(list.split(",").map((id) => id.trim()).filter(Boolean))];
  const unknown = ids.filter((id) => !(INBOX_NOTE_AGENT_IDS as readonly string[]).includes(id));
  if (ids.length === 0 || unknown.length > 0) {
    process.stderr.write(`Unknown agent${unknown.length === 1 ? "" : "s"} for --notes: ${unknown.join(", ") || "(none)"}. Use any of: ${INBOX_NOTE_AGENT_IDS.join(", ")}.\n`);
    return 1;
  }
  const environment = createAgentEnvironment();
  if (inboxNotesDisabled(environment.env)) {
    process.stderr.write("PLANNOTATOR_INBOX_NOTES=0 is set: notes are off, nothing was written.\n");
    return 1;
  }
  let ok = true;
  const added: InboxNoteAgentId[] = [];
  for (const id of ids as InboxNoteAgentId[]) {
    const label = INBOX_AGENT_LABELS[id];
    if (id === "cursor") {
      process.stdout.write(`${INBOX_NOTE_BODY}\n\n`);
      process.stderr.write("Cursor User Rules are managed in Cursor Settings → Rules. Copy the block above there; Plannotator cannot detect, update or remove a copied rule.\n");
      added.push(id);
      continue;
    }
    // Never a file for an agent that is not on this computer.
    if (!agentSpec(id).detect(environment)) {
      ok = false;
      process.stderr.write(`${label}: not added (${label} was not found on this computer).\n`);
      continue;
    }
    const change = addInboxNote(id, dataDir, environment);
    if (!change.ok) {
      ok = false;
      process.stderr.write(`${label}: not added (${change.reason}).\n`);
      continue;
    }
    added.push(id);
    const said = {
      added: `Added a marked section to ${change.path}`,
      created: `Created ${change.path}`,
      updated: `Updated the note in ${change.path}`,
      unchanged: `${change.path} already has the note`,
      "kept-edited": `${change.path} has the note as you edited it; left as it is`,
      shared: `${change.path} already has the note (a file another agent reads too)`,
      "kept-shared": "",
      removed: "",
      deleted: "",
    }[change.action];
    process.stderr.write(`${label}: ${said}.\n`);
  }
  // The window never asks about an agent whose note is there now; the others are still asked, once each.
  await markNotesAsked(added, { dataDir, selfCommand: selfCommand(), environment });
  if (ok && added.some((id) => id !== "cursor")) process.stderr.write("Managed notes are read from each agent's next session. Remove them in the Inbox's Settings or with plannotator uninstall.\n");
  return ok ? 0 : 1;
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
  // Only a person's `plannotator inbox` connects agents, never a detached start.
  // An Inbox older than DETACHED_ENV (0.28.17 and before) spawns its detached
  // starts (its Restart into an updated binary, --background, a connection)
  // with only LOCK_HELD_ENV, which every detached start has carried since the
  // first Inbox and a person's run never does; so it counts as detached too.
  const detached = process.env[DETACHED_ENV] === "1" || process.env[LOCK_HELD_ENV] === "1";
  delete process.env[DETACHED_ENV];
  // PLANNOTATOR_INBOX_CONNECT=0 in this shell skips it, also on an Inbox an agent started.
  const connect = !detached && !inboxConnectDisabled(process.env);

  if (args[0] === "mcp") {
    if (args.length > 1) usageError(`Unknown inbox mcp option: ${args[1]}`);
    await runInboxMcpShim({
      dataDir,
      cwd: process.env.PLANNOTATOR_CWD || process.cwd(),
      ensureRunning: () => ensureInboxRunning(dataDir),
      hostSession: inboxHostSessionFromEnv(process.env),
    });
    process.exit(0);
  }

  if (args[0] === "--notes") {
    if (args.length !== 2) usageError("--notes takes one list of agents, e.g. --notes codex,gemini, and no other option.");
    process.exit(await writeNotes(dataDir, args[1]!));
  }

  let background = false;
  let noOpen = false;
  let open = false;
  let tailscale = false;
  for (const arg of args) {
    if (arg === "--background") background = true;
    else if (arg === "--no-open") noOpen = true;
    else if (arg === "--open") open = true;
    else if (arg === "--tailscale") tailscale = true;
    else if (arg === "--notes") usageError("--notes goes first and alone: plannotator inbox --notes codex,gemini");
    else usageError(`Unknown inbox option: ${arg}`);
  }

  if (open && (background || noOpen)) {
    usageError(`--open does not go with ${background ? "--background" : "--no-open"}: it starts the Inbox in the background itself and opens it.`);
  }

  if (background || open) {
    try {
      const before = await inboxStatus(dataDir);
      const entry = await ensureInboxRunning(dataDir, { tailscale });
      // Stdout stays the local URL alone (agents read it); the tailnet goes to stderr.
      if (tailscale && (before.state === "running" || before.state === "busy")) await publishRunningInbox(entry);
      else reportTailnet(readInboxRegistry(dataDir)?.tailscale ?? entry.tailscale, tailscale);
      // --open: the person asked for the window (the /plannotator-inbox
      // commands). The opener is never waited for: a browser it starts may
      // hold its output open for as long as it runs.
      if (open && (await openBrowserDetached(entry.url, { isRemote: isRemoteSession() })) === "remote") {
        process.stderr.write(`${inboxRemoteOpenHint(entry.port)}\n`);
      }
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
    if (connect) await connectRunningInbox(entry);
    process.exit(0);
  }
  return serveInbox(dataDir, !noOpen, assets.htmlContent, tailscale, connect);
}

/**
 * `PLANNOTATOR_INBOX_AUTO_SEND_MS`: a testing knob for the end-to-end proof
 * on the compiled binary (approval "inbox-busy-agent-reply"): how long a
 * reply waits on a busy agent before the Inbox puts it into the running turn
 * by itself. A whole number of milliseconds from 1,000 up to the default; it
 * can only make the wait shorter, and only in a build that is not a release
 * (`version` not X.Y.Z, e.g. `0.0.0-dev` or a source run) or under the test
 * sandbox (`PLANNOTATOR_TEST_SANDBOX`). A release ignores it, so an agent that
 * starts the Inbox cannot make replies jump into turns. Anything else is
 * ignored (the default, `INBOX_AUTO_SEND_AFTER_MS`, 5 minutes).
 */
export function autoSendAfterMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  version: string | undefined = getCliVersion(),
): { autoSendAfterMs?: number } {
  const release = typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);
  if (release && !env.PLANNOTATOR_TEST_SANDBOX) return {};
  const raw = env.PLANNOTATOR_INBOX_AUTO_SEND_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return {};
  const ms = Number(raw);
  return Number.isSafeInteger(ms) && ms >= 1_000 && ms <= INBOX_AUTO_SEND_AFTER_MS ? { autoSendAfterMs: ms } : {};
}
