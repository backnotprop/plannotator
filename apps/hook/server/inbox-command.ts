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
 *   plannotator inbox status        whether it runs, where, which pid and
 *                                   version (--json too); exit 0 running
 *   plannotator inbox stop          stop it: asked first, then signalled,
 *                                   only once the pid is proven to be it
 *   plannotator inbox restart       stop it, then start it detached; print
 *                                   the URL
 *
 * The status, stop and restart commands follow rmohta's port
 * (rmohta/plannotator, branch feat/plan-library), rebuilt on today's stop
 * and start paths.
 *
 * On demand never pops a tab mid-work: only a person running `plannotator
 * inbox` opens one. The Inbox never registers in `sessions/` (it would hold
 * auto-update back forever); its own registry is `inbox/inbox.json`.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { isNewerStableVersion } from "@plannotator/shared/update-check";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import {
  acquireInboxStartLock,
  INBOX_START_LOCK,
  INBOX_START_LOCK_STALE_MS,
  inboxRegistryPath,
  inboxStatus,
  readInboxRegistry,
  stopInbox,
  waitForInbox,
  type InboxRegistryEntry,
  type InboxStopResult,
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
import { inboxHostSessionFromEnv, inboxQwenShimContext, runInboxMcpShim } from "./inbox-mcp-shim";

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
  return startDetachedInbox(dataDir, acquireInboxStartLock(dataDir), options.tailscale === true);
}

/**
 * The one detached start: with the start lock (`release`, which this
 * releases) spawn the Inbox and wait for it; without it (another starter
 * holds it) only wait for what that starter starts.
 */
async function startDetachedInbox(dataDir: string, release: (() => void) | null, tailscale: boolean): Promise<InboxRegistryEntry> {
  if (release) {
    try {
      spawnDetachedInbox(dataDir, tailscale);
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
    // Never a note, written or to copy, for an agent that is not on this computer.
    if (!agentSpec(id).detect(environment)) {
      ok = false;
      process.stderr.write(`${label}: not added (${label} was not found on this computer).\n`);
      continue;
    }
    if (id === "cursor") {
      // Cursor keeps its rules in the app: nothing is written; the note (without the markers) goes to stdout to copy.
      process.stdout.write(`${INBOX_NOTE_BODY}\n\n`);
      process.stderr.write("Cursor: nothing written. Cursor keeps its rules in the app: copy the note above into Customize → Rules in Cursor. Plannotator can't see, update or remove that copy.\n");
      added.push(id);
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
  if (ok && added.some((id) => id !== "cursor")) process.stderr.write("Each agent reads it from its next session. Remove it in the Inbox's Settings or with plannotator uninstall.\n");
  return ok ? 0 : 1;
}

/**
 * `plannotator inbox status [--json]`. Exit 0: running. 1: not running (it
 * never ran with this data dir, or the process its record names is gone).
 * 2: not answering (a live process holds its port but does not answer).
 */
async function statusCommand(dataDir: string, asJson: boolean): Promise<number> {
  const status = await inboxStatus(dataDir);
  const entry = status.state === "missing" ? null : status.entry;
  const cliVersion = getCliVersion() ?? "dev";
  const code = status.state === "running" ? 0 : status.state === "busy" ? 2 : 1;
  if (asJson) {
    const report = {
      state: status.state === "busy" ? "not_answering" : status.state === "missing" ? "never_started" : status.state,
      running: status.state === "running",
      // Why a record names no running Inbox: the process exited, another Inbox has the port, or the pid is another program's.
      reason: status.state === "stopped" ? status.reason : null,
      url: entry?.url ?? null,
      port: entry?.port ?? null,
      pid: entry?.pid ?? null,
      version: status.state === "running" ? status.health.version : (entry?.version ?? null),
      started_at: entry?.startedAt ?? null,
      tailnet_url: status.state === "running" ? (entry?.tailscale?.url ?? null) : null,
      data_dir: dataDir,
      record: inboxRegistryPath(dataDir),
      cli_version: cliVersion,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return code;
  }
  const out = (line: string) => process.stdout.write(`${line}\n`);
  if (status.state === "missing") {
    out("Plannotator Inbox: not running (it has never run with this data dir)");
  } else if (status.state === "stopped") {
    const why = { dead_pid: "that process has exited", other_session: "its port answers for another Inbox now", no_answer: `nothing answers on its port; pid ${status.entry.pid} may be another program now` }[status.reason];
    out("Plannotator Inbox: not running");
    out(`  last ran: pid ${status.entry.pid} on port ${status.entry.port}, version ${status.entry.version}, started ${status.entry.startedAt} (${why})`);
  } else {
    const live = status.entry;
    out(status.state === "running" ? "Plannotator Inbox: running" : `Plannotator Inbox: not answering (pid ${live.pid} holds port ${live.port} but did not answer)`);
    out(`  URL:      ${live.url}`);
    if (status.state === "running" && live.tailscale?.url) out(`  tailnet:  ${live.tailscale.url}`);
    out(`  pid:      ${live.pid}`);
    out(`  version:  ${status.state === "running" ? status.health.version : live.version}`);
    out(`  started:  ${live.startedAt}`);
  }
  out(`  data dir: ${dataDir}`);
  if (status.state === "running" && status.health.version !== cliVersion) {
    // Restart runs this binary, so it is advised only when that is an update, never a downgrade.
    out(
      isNewerStableVersion(cliVersion, status.health.version)
        ? `This plannotator is ${cliVersion}; plannotator inbox restart starts it in the Inbox's place.`
        : `This plannotator is ${cliVersion}; the Inbox runs ${status.health.version}.`,
    );
  }
  return code;
}

/**
 * A start lock another starter holds: wait for its start to finish (it
 * releases the lock), so what it starts is the Inbox this command then
 * stops. One older than the stale age (a starter that died) is removed.
 * Answers whether a stale one was removed.
 */
async function waitOutStartLock(dataDir: string): Promise<boolean> {
  const lock = join(inboxDir(dataDir), INBOX_START_LOCK);
  // A lock kept fresh this long (a restart refreshes its own) is left to its holder; the stop goes on.
  const deadline = Date.now() + 2 * INBOX_START_LOCK_STALE_MS;
  for (;;) {
    let age: number;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      return false;
    }
    if (age > INBOX_START_LOCK_STALE_MS) {
      rmSync(lock, { recursive: true, force: true });
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The start lock for `restart`, waiting out a starter that holds it; null when it cannot be had. */
async function takeStartLock(dataDir: string): Promise<(() => void) | null> {
  const deadline = Date.now() + INBOX_START_LOCK_STALE_MS + 1_000;
  for (;;) {
    const release = acquireInboxStartLock(dataDir);
    if (release || Date.now() >= deadline) return release;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** One line for what `stopInbox` did, and whether nothing of this data dir's runs now. */
function stopReport(result: InboxStopResult, hadRecord: boolean): { ok: boolean; line: string } {
  if (result.state === "stopped") {
    const how = {
      stop_route: "",
      SIGTERM: ": it did not stop when asked, so it was sent SIGTERM",
      SIGKILL: ": it outlived SIGTERM, so it was killed (SIGKILL)",
    }[result.by];
    return { ok: true, line: `Stopped the Plannotator Inbox (pid ${result.pid})${how}.` };
  }
  if (result.state === "not_running") {
    if (!result.stale) return { ok: true, line: hadRecord ? "No Plannotator Inbox is running." : "No Plannotator Inbox is running (it has never run with this data dir)." };
    const { pid, reason } = result.stale;
    const why = {
      dead_pid: `its record named pid ${pid}, which has already exited`,
      other_session: `its port answers for another Inbox now, which was left alone`,
      no_answer: `its record names pid ${pid}, which is another program now (pids are reused); it was left alone`,
      not_ours: `its record names the Inbox of another data dir (pid ${pid}; this data dir looks copied from that one), which was left alone`,
    }[reason];
    return { ok: true, line: `No Plannotator Inbox is running: ${why}.` };
  }
  const why = {
    busy: `is not answering, and pid ${result.pid} could not be proven to be the Inbox, so nothing was sent to it`,
    unproven: `did not stop when asked, and pid ${result.pid} could not be proven to be the Inbox, so nothing was sent to it`,
    survived: "is still running after SIGTERM and SIGKILL",
  }[result.reason];
  const end = process.platform === "win32" ? "end it in Task Manager" : `end it yourself (kill ${result.pid})`;
  return { ok: false, line: `The Plannotator Inbox (pid ${result.pid}) ${why}. If it is the Inbox, ${end} and run this again.` };
}

/** `plannotator inbox stop`. Exit 0 when no Inbox of this data dir runs afterwards, 1 when one still does. */
async function stopCommand(dataDir: string): Promise<number> {
  if (await waitOutStartLock(dataDir)) process.stderr.write("Removed a stale start lock (a start that never finished).\n");
  const hadRecord = readInboxRegistry(dataDir) !== null;
  const report = stopReport(await stopInbox(dataDir, { escalate: true }), hadRecord);
  if (!report.ok) {
    process.stderr.write(`${report.line}\n`);
    return 1;
  }
  process.stdout.write(`${report.line}\n`);
  return 0;
}

/**
 * `plannotator inbox restart [--tailscale]`: stop the Inbox (as `stop`
 * does), then start it detached through the one detached start, never a
 * browser tab, and print its URL on stdout. A run published only by
 * `--tailscale` is published again. The start lock is held from before the
 * stop until the new Inbox answers, so an agent that finds the Inbox stopped
 * in between waits for this start instead of racing it.
 */
async function restartCommand(dataDir: string, tailscale: boolean): Promise<number> {
  const release = await takeStartLock(dataDir);
  if (!release) {
    process.stderr.write("Another Plannotator Inbox start holds the start lock and did not finish; try again.\n");
    return 1;
  }
  let handedOver = false;
  try {
    const hadRecord = readInboxRegistry(dataDir) !== null;
    const stopped = await stopInbox(dataDir, { escalate: true });
    const report = stopReport(stopped, hadRecord);
    process.stderr.write(`${report.line}\n`);
    if (!report.ok) return 1;
    if (stopped.state === "not_running" && stopped.stale?.reason === "not_ours") {
      // A start would find that Inbox through this record and start nothing: say so instead of naming it as restarted.
      process.stderr.write("Nothing was restarted: while that Inbox runs, this data dir's record names it.\n");
      return 1;
    }
    // The stop can take a while; the lock's age starts again, so no starter takes it as stale meanwhile.
    try {
      const now = new Date();
      utimesSync(join(inboxDir(dataDir), INBOX_START_LOCK), now, now);
    } catch {
      // Best effort.
    }
    handedOver = true;
    const entry = await startDetachedInbox(dataDir, release, tailscale || (stopped.state === "stopped" && stopped.tailscaleRunOnly));
    process.stderr.write(`Started the Plannotator Inbox (pid ${entry.pid}, version ${entry.version}).\n`);
    reportTailnet(readInboxRegistry(dataDir)?.tailscale ?? entry.tailscale, tailscale);
    process.stdout.write(`${entry.url}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (!handedOver) release();
  }
}

function usageError(message: string): never {
  process.stderr.write(`${message}\nRun 'plannotator inbox --help' for usage.\n`);
  process.exit(1);
}

export interface InboxCommandAssets {
  /** The built window (`apps/hook/dist/inbox.html`), embedded by the binary. */
  htmlContent?: string;
  /** The global `--json` flag (index.ts takes it out of the arguments first); `status` reads it, `stop` and `restart` refuse it. */
  json?: boolean;
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
      qwen: inboxQwenShimContext(process.env, homedir(), process.cwd(), process.ppid),
    });
    process.exit(0);
  }

  if (args[0] === "status") {
    if (args.length > 1) usageError(`Unknown inbox status option: ${args[1]} (status takes only --json)`);
    process.exit(await statusCommand(dataDir, assets.json === true));
  }

  // index.ts takes the global --json out of the arguments; only status prints JSON.
  if ((args[0] === "stop" || args[0] === "restart") && assets.json === true) {
    usageError(`inbox ${args[0]} has no --json output; plannotator inbox status --json reports the Inbox as JSON.`);
  }

  if (args[0] === "stop") {
    if (args.length > 1) usageError(`Unknown inbox stop option: ${args[1]}`);
    process.exit(await stopCommand(dataDir));
  }

  if (args[0] === "restart") {
    const rest = args.slice(1);
    const unknown = rest.find((arg) => arg !== "--tailscale");
    if (unknown) usageError(`Unknown inbox restart option: ${unknown} (restart takes only --tailscale)`);
    process.exit(await restartCommand(dataDir, rest.includes("--tailscale")));
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
