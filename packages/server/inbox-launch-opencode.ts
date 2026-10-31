/**
 * OpenCode as a launch host (the `LaunchHost` in inbox-launch-host.ts): the
 * person picks "New OpenCode session" in To, and OpenCode starts in the
 * project in the background, with the person's own setup.
 *
 * OpenCode 1.18 has no background service of its own, so the Inbox runs one
 * `opencode serve` per launch: on 127.0.0.1, on a free port the Inbox picks
 * (never OpenCode's default 4096), a random password (Basic auth,
 * `OPENCODE_SERVER_PASSWORD`), in its own process group (`detached`), stdout
 * and stderr to `launch/<id>/server.log`. Its pid, start time, url and
 * password are in `launch/<id>/server.json` (0600), written right after the
 * spawn. The password is also in the env of the server and of what it runs
 * (its shell commands, a terminal's `opencode attach`), which the same user
 * can read; never in a log, the start log, argv, the run line or the attach
 * command (that reads the file).
 *
 * The server outlives an Inbox restart (a turn keeps running through an
 * update) and the next Inbox adopts it only once it is proved to be ours: the
 * pid still runs `opencode serve` on our port, started when we recorded, as
 * its own process group's leader; it refuses a call with no password and
 * answers ours; and it has the session. No signal ever goes to a pid that is
 * not proved ours that way. Stop aborts the turn and ends the server's
 * process group (its shell commands too); a reply starts a new server on the
 * same session, which OpenCode keeps in its own database with its history. A
 * server idle for 30 minutes (no turn, no prompt) is stopped the same way; a
 * reply continues it.
 *
 *  - start: the server, then `POST /session` in the folder (`permission`: an
 *    allow-all ruleset for a launch with full permissions, else none, so the
 *    person's own OpenCode permission config decides). No first turn.
 *  - the channel: OpenCode 1 has no Plannotator wake, so the host runs the
 *    shared `InboxWake` (packages/shared/inbox/agent-link.ts, the one Pi and
 *    OpenCode 2's plugin run) for the session, inside the Inbox: it polls the
 *    Inbox's own bridge as `opencode` (so `live`, Delivered and a reply's
 *    restart work as for Claude Code's mod) and puts each item into the session
 *    with `POST /session/<id>/prompt_async`, once the session is idle (busy
 *    from the server's `session.status` events, a pending permission or
 *    question).
 *  - the agent answers with Plannotator's OpenCode plugin's
 *    `plannotator_inbox` tool. The server's env sets `PLANNOTATOR_DATA_DIR`
 *    (when it is not the default) and `PLANNOTATOR_INBOX_TOOL=1`, so the
 *    plugin reaches this Inbox and has the tool in this server only, and
 *    `PLANNOTATOR_LAUNCH=<id>`, which tells the plugin its replies come back
 *    as turns. So To offers OpenCode only when the plugin is in the person's
 *    OpenCode config.
 *  - permission prompts: `permission.asked` on the server's event stream
 *    becomes the thread's permission card (inbox-launch-opencode-permission.ts),
 *    the session's own and its subagents' (child sessions, `parentID`).
 *  - OpenCode 2 (`opencode2`, whose package also ships `opencode` 2.x) is not
 *    offered: it runs as a service of its own and its plugin has a wake.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { INBOX_PERMISSION_ANSWERED_IN_TERMINAL, INBOX_PERMISSION_NO_LONGER_WAITING, inboxLaunchFullPermissions, type InboxPermissionChoice } from "@plannotator/core/inbox-permission";
import { INBOX_HOST_NAMES, type InboxLaunchRecord, type InboxMessage } from "@plannotator/core/inbox-types";
import { getDefaultPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { InboxAgentConnection, InboxWake, type InboxWakeTarget } from "@plannotator/shared/inbox/agent-link";
import { agentVersionRun, openCodePluginInstalled, type AgentRunResult } from "./inbox-agents";
import { versionAtLeast } from "./inbox-launch-claude";
import { launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchHost, LaunchHostContext, LaunchHostPermissions, LaunchHostResult, LaunchPermissionContext } from "./inbox-launch-host";
import { createLaunchQuestions } from "./inbox-launch-permission";
import { openCodePermissionEvent, openCodePermissionTerms, openCodeReply, readOpenCodePermission, type OpenCodePermissionRequest } from "./inbox-launch-opencode-permission";

/** The oldest OpenCode a launch runs: `serve` with the session, permission and event routes used here (checked on 1.18.23). */
export const OPENCODE_LAUNCH_MIN_VERSION = "1.18.0";
export const OPENCODE_NAME = INBOX_HOST_NAMES.opencode ?? "OpenCode";
const OPENCODE = "opencode" as const;
/** How long a new server may take to say where it listens and answer. */
const SERVER_UP_MS = 30_000;
/** How long Stop waits for the server's group to go after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3_000;
/** How long one call to the server may take. */
const CALL_MS = 10_000;
/** A server with no turn and no prompt this long is stopped (a reply continues the session). */
export const OPENCODE_IDLE_STOP_MS = 30 * 60_000;
/** OpenCode's own default port: never taken by a launch (the person's `opencode serve` may want it). */
const OPENCODE_DEFAULT_PORT = 4096;
/** How many failed health checks in a row, a second apart, before a dropped event stream counts as the server gone. */
const HEALTH_TRIES = 3;
/** How long after a reply of ours OpenCode's cascade (its other prompts of the session answered with it) is read as ours. */
const CASCADE_MS = 15_000;
/** How long a failed permission reply waits before it is sent again. */
const REPLY_RETRY_MS = 2_000;
/** How long a server of ours (by its process) may fail to answer an adoption before it is ended. */
const UNPROVED_MS = 60_000;

/** A card OpenCode answered itself with the person's earlier Deny (OpenCode's reject rejects the session's other prompts). */
export const OPENCODE_DENIED_EARLIER = "Denied with your earlier answer.";
/** A card OpenCode answered itself with the person's Allow for this session (its `always` covers it). */
export const OPENCODE_ALLOWED_EARLIER = "Allowed by your Allow for this session.";
/** The words after "OpenCode stopped." for a server the host stopped for being idle (`stoppedNote`). */
export const openCodeIdleNote = (minutes: number) => `It was idle for ${minutes} minute${minutes === 1 ? "" : "s"}. Your reply continues it.`;

/** `1.18.23` (OpenCode prints the bare version) → `1.18.23`. */
export function parseOpenCodeVersion(stdout: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(stdout)?.[0] ?? null;
}

/** The url `opencode serve` says it listens on, from its log. */
export function parseListening(log: string): string | null {
  return /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1] ?? null;
}

/** What `launch/<id>/server.json` holds (0600): the server's process and when it started, where it listens, its password. */
export interface OpenCodeServer {
  pid: number;
  /** The process's start time as `ps -o lstart=` prints it, read right after the spawn: a reused pid has another. */
  started: string;
  url: string;
  password: string;
}

/** One shell word: single-quoted. */
const shellWord = (word: string) => (/^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/**
 * The command that opens the session in a terminal: `opencode attach` to the launch's running server (its
 * password read from server.json by the shell, never written in the command), else `opencode --session` in
 * the folder, which opens the same session from OpenCode's database.
 */
export function openCodeAttachCommand(folder: string, session: string, server: { url: string; file: string } | null): string {
  if (!server) return `cd ${shellWord(folder)} && opencode --session ${shellWord(session)}`;
  const password = `"$(sed -n 's/.*"password":"\\([0-9a-f]*\\)".*/\\1/p' ${shellWord(server.file)})"`;
  return `cd ${shellWord(folder)} && OPENCODE_SERVER_PASSWORD=${password} opencode attach ${shellWord(server.url)} --session ${shellWord(session)}`;
}

/** The env names a launched server never inherits: another OpenCode server's password, from the Inbox's or the shell's env. */
const SERVER_DROP = new Set(["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]);

/** The server's env: the login env through the launch filter, then this launch's own names. */
export function openCodeServerEnv(login: Readonly<LaunchEnv>, input: { launchId: string; password: string; dataDir: string | null }): LaunchEnv {
  const env = Object.fromEntries(Object.entries(launchSpawnEnv(login)).filter(([name]) => !SERVER_DROP.has(name)));
  return {
    ...env,
    OPENCODE_SERVER_PASSWORD: input.password,
    // The plugin's Inbox tool in this server only, reaching this Inbox; its replies come back as turns.
    PLANNOTATOR_INBOX_TOOL: "1",
    PLANNOTATOR_LAUNCH: input.launchId,
    ...(input.dataDir ? { PLANNOTATOR_DATA_DIR: input.dataDir } : {}),
  };
}

/** One process as `ps` shows it: its process group, its start time, its command line; null when it is not running. */
export function openCodeProcessOf(pid: number): { pgid: number; started: string; command: string } | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const ran = spawnSync("/bin/ps", ["-o", "pgid=,lstart=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
  const line = (ran.stdout ?? "").trim().split("\n")[0] ?? "";
  const match = /^(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(line);
  return match ? { pgid: Number(match[1]), started: match[2]!.replace(/\s+/g, " "), command: match[3]! } : null;
}

/** Whether a command line is `opencode serve` on 127.0.0.1 and `port`, as a launch starts it. */
export function isOpenCodeServe(command: string, port: number): boolean {
  return /opencode/.test(command) && new RegExp(`(^|\\s)serve --hostname 127\\.0\\.0\\.1 --port ${port}(\\s|$)`).test(command);
}

const portOf = (url: string) => Number(/:(\d+)$/.exec(url)?.[1] ?? NaN);

/** A free loopback port the kernel hands out, never OpenCode's default. */
async function freePort(): Promise<number> {
  for (let i = 0; i < 8; i++) {
    const port = await new Promise<number>((resolveP, reject) => {
      const probe = createServer();
      probe.unref();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolveP(port));
      });
    });
    if (port !== OPENCODE_DEFAULT_PORT) return port;
  }
  throw new Error("no free port");
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One launched session the Inbox is connected to now: its server, its event stream, its wake. */
interface Connection {
  launchId: string;
  session: string;
  folder: string;
  server: OpenCodeServer;
  /** Ends the event stream and the wake. */
  abort: AbortController;
  busy: boolean;
  /** A turn is being handed to the server now. */
  delivering: boolean;
  /** Permission requests the server holds now (the session's and its subagents'), by id. */
  permissions: Map<string, OpenCodePermissionRequest>;
  /** OpenCode's own question tool waits on someone (it is answered in OpenCode, never here). */
  questions: Set<string>;
  /** The session's subagents (child sessions, any depth): id → title. */
  children: Map<string, string | null>;
  /** Sessions looked up and found not to be ours. */
  strangers: Set<string>;
  /** The replies the Inbox sent, by request id, and the last one (OpenCode cascades it to the session's other prompts). */
  sent: Set<string>;
  lastSent: { reply: "once" | "always" | "reject"; session: string; at: number } | null;
  /** Since when nothing runs and nothing waits (null: something does). */
  idleSince: number | null;
  wake: InboxWake | null;
  /** Gone: the server stopped answering, Stop, or idle. */
  closed: boolean;
}

/** A permission question the thread holds for a server's request. */
interface Asked {
  launchId: string;
  /** The launched session (a subagent's prompt is answered on its parent's server). */
  session: string;
  request: OpenCodePermissionRequest;
  /** The card's note ("From a subagent …"), or null. */
  note: string | null;
  /** The person's choice, kept until the server took it. */
  answer: { choice: InboxPermissionChoice; reason: string | null } | null;
  /** Not before then: the last reply did not go. */
  retryAt: number;
  /** Answered (the server took the reply) or withdrawn: nothing more to do. */
  done: boolean;
}

/** A start or resume under way: Stop and Delete set `cancelled` and wait for it. */
interface Opening {
  promise: Promise<Connection | null>;
  token: { cancelled: boolean };
}

export function createOpenCodeLaunchHost(ctx: LaunchHostContext, options: { idleMs?: number; now?: () => number } = {}) {
  const idleMs = options.idleMs ?? OPENCODE_IDLE_STOP_MS;
  const now = options.now ?? Date.now;
  const connections = new Map<string, Connection>();
  /** Starts and resumes under way, by launch id: one at a time. */
  const opening = new Map<string, Opening>();
  /** Sessions stopped for being idle (the run line says so until a reply continues them): session → minutes. */
  const idleStopped = new Map<string, number>();
  /** Launches whose server (ours by its process) did not answer an adoption, since when. */
  const unproved = new Map<string, number>();
  let perm: LaunchPermissionContext | null = null;
  let questions: ReturnType<typeof createLaunchQuestions> | null = null;
  /** Permission questions by message id. */
  const asked = new Map<string, Asked>();
  const terms = (note: string | null = null) => ({ ...openCodePermissionTerms(ctx.displayFolder), note });

  const serverFile = (launchId: string) => join(ctx.launchDir(launchId), "server.json");
  const readServer = (launchId: string): OpenCodeServer | null => {
    try {
      const value = JSON.parse(readFileSync(serverFile(launchId), "utf8")) as Partial<OpenCodeServer>;
      return typeof value.pid === "number" && typeof value.started === "string" && typeof value.url === "string" && typeof value.password === "string" ? (value as OpenCodeServer) : null;
    } catch {
      return null;
    }
  };
  /** Write server.json (0600); false when the launch's folder is gone (Delete removed it): it is never made again here. */
  const writeServer = (launchId: string, server: OpenCodeServer): boolean => {
    if (!existsSync(ctx.launchDir(launchId))) return false;
    // One line, `"password":"<hex>"`: the attach command's `sed` reads it there.
    writeFileSync(serverFile(launchId), `${JSON.stringify({ pid: server.pid, started: server.started, url: server.url, password: server.password })}\n`, { mode: 0o600 });
    chmodSync(serverFile(launchId), 0o600);
    return true;
  };
  const dropServerFile = (launchId: string, server: OpenCodeServer) => {
    if (readServer(launchId)?.pid === server.pid) rmSync(serverFile(launchId), { force: true });
  };

  const call = async (server: OpenCodeServer, method: string, path: string, folder: string, body?: unknown, ms = CALL_MS, auth = true): Promise<{ status: number; body: unknown } | null> => {
    try {
      const url = `${server.url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(folder)}`;
      const response = await fetch(url, {
        method,
        headers: { ...(auth ? { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(ms),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed };
    } catch {
      return null;
    }
  };
  const healthy = async (server: OpenCodeServer, folder: string) => (await call(server, "GET", "/global/health", folder, undefined, 3_000))?.status === 200;

  /** The process is still the server we started: `opencode serve` on its port, the start time we recorded, its own group's leader. */
  const ours = (server: OpenCodeServer): boolean => {
    const found = openCodeProcessOf(server.pid);
    return !!found && found.pgid === server.pid && found.started === server.started && isOpenCodeServe(found.command, portOf(server.url));
  };
  /** A server that answers without the password (2xx): not one of ours, whatever its process. */
  const takesAnyone = async (server: OpenCodeServer, folder: string) => {
    const open = await call(server, "GET", "/global/health", folder, undefined, 3_000, false);
    return !!open && open.status >= 200 && open.status < 300;
  };

  /** The `opencode` the Inbox runs: on the plain env's PATH, else OpenCode's own install folder. */
  const findOpenCode = async (): Promise<string | null> => {
    const e = await ctx.environment();
    const found = e.which("opencode");
    if (found) return found;
    const installed = join(ctx.homeDir, ".opencode", "bin", "opencode");
    return !process.env.PLANNOTATOR_TEST_SANDBOX && existsSync(installed) ? installed : null;
  };

  // ── The server: one per launch ──

  /**
   * End a server's process group: SIGTERM, then SIGKILL after the grace. Only a process proved ours (`ours`,
   * checked again before each signal): a reused pid, or another program, is never signalled.
   */
  const endServer = async (server: OpenCodeServer, why: string): Promise<boolean> => {
    if (!alive(server.pid)) return true;
    if (!ours(server)) {
      ctx.log(`Inbox launch: pid ${server.pid} is not our opencode serve any more; not signalled (${why})`);
      return false;
    }
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-server.pid, s);
      } catch {
        // Gone.
      }
    };
    signal("SIGTERM");
    const deadline = Date.now() + KILL_GRACE_MS;
    while (alive(server.pid) && Date.now() < deadline) await sleep(100);
    if (alive(server.pid) && ours(server)) signal("SIGKILL");
    return true;
  };

  const readLog = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };

  /** Start `opencode serve` for a launch, in its folder, with the login env; null and the cause when it did not come up. */
  const startServer = async (launch: InboxLaunchRecord, login: LaunchEnv, token: { cancelled: boolean }): Promise<{ server: OpenCodeServer } | { failure: string; missing?: boolean; cancelled?: boolean }> => {
    const bin = await findOpenCode();
    if (!bin) return { failure: "opencode is not on the Inbox's PATH or in ~/.opencode/bin.", missing: true };
    const dir = ctx.launchDir(launch.id);
    if (token.cancelled) return { failure: "stopped", cancelled: true };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const password = randomBytes(24).toString("hex");
    const isDefaultDataDir = resolve(ctx.dataDir) === resolve(getDefaultPlannotatorDataDir(ctx.homeDir));
    const env = openCodeServerEnv(login, { launchId: launch.id, password, dataDir: isDefaultDataDir ? null : ctx.dataDir });
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const logPath = join(dir, "server.log");
    rmSync(logPath, { force: true });
    let pid: number | undefined;
    try {
      const fd = openSync(logPath, "a", 0o600);
      try {
        const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: launch.folder, env, detached: true, stdio: ["ignore", fd, fd] });
        pid = child.pid;
        child.on("error", () => {});
        child.unref();
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return { failure: `opencode serve did not start: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!pid) return { failure: "opencode serve did not start." };
    const started = openCodeProcessOf(pid)?.started;
    if (!started) return { failure: `opencode serve exited at once${readLog(logPath).trim() ? `: ${readLog(logPath).trim().split("\n").at(-1)}` : "."}` };
    const server: OpenCodeServer = { pid, started, url, password };
    // At once, before the wait: an Inbox that dies now leaves a server the next one can prove and end.
    const kept = writeServer(launch.id, server);
    const deadline = Date.now() + SERVER_UP_MS;
    while (kept && !token.cancelled && existsSync(dir) && Date.now() < deadline && alive(pid)) {
      if (parseListening(readLog(logPath)) === url && (await healthy(server, launch.folder))) {
        if (token.cancelled || !existsSync(dir)) break;
        ctx.startLog(launch.id, `opencode serve (pid ${pid}) listening on ${url}`);
        return { server };
      }
      await sleep(150);
    }
    const gone = token.cancelled || !existsSync(dir);
    const said = readLog(logPath).trim().split("\n").slice(-5).join("\n");
    await endServer(server, gone ? "stopped while it started" : "did not come up");
    dropServerFile(launch.id, server);
    if (gone) return { failure: "stopped", cancelled: true };
    ctx.startLog(launch.id, `opencode serve did not come up:\n${said}`);
    return { failure: `opencode serve did not come up${said ? `: ${said.split("\n").at(-1)}` : "."}` };
  };

  // ── The connection: the server's events and the session's wake ──

  const rootOfLaunch = (launchId: string): InboxMessage | null => perm?.rootOf(launchId) ?? null;

  /** Whether a session is the launched one or one of its subagents (looked up up the parent chain once). */
  const ownSession = async (conn: Connection, id: string): Promise<"own" | "child" | null> => {
    if (id === conn.session) return "own";
    if (conn.children.has(id)) return "child";
    if (conn.strangers.has(id)) return null;
    const chain: { id: string; title: string | null }[] = [];
    let at = id;
    for (let depth = 0; depth < 8; depth++) {
      const found = await call(conn.server, "GET", `/session/${encodeURIComponent(at)}`, conn.folder);
      const info = found?.status === 200 && found.body && typeof found.body === "object" ? (found.body as { parentID?: unknown; title?: unknown }) : null;
      if (!info) break;
      chain.push({ id: at, title: typeof info.title === "string" ? info.title : null });
      const parent = typeof info.parentID === "string" ? info.parentID : null;
      if (!parent) break;
      if (parent === conn.session || conn.children.has(parent)) {
        for (const link of chain) conn.children.set(link.id, link.title);
        return "child";
      }
      at = parent;
    }
    // Not found (yet) is not a stranger: a lookup that failed is tried again on the next prompt.
    if (chain.length > 0) conn.strangers.add(id);
    return null;
  };

  /** The card's note for a subagent's prompt. */
  const subagentNote = (conn: Connection, session: string) => {
    const title = conn.children.get(session);
    return `From a subagent${title ? ` (${title})` : ""}.`;
  };

  /** Ask a request's question; one withdrawn before (a server that was gone a moment) is asked anew. */
  const askFor = (root: InboxMessage, request: OpenCodePermissionRequest, note: string | null, folder: string, target: Record<string, unknown>): string | null => {
    if (!questions) return null;
    const event = openCodePermissionEvent(request, folder);
    const question = questions.questionFor(root, event, { ...terms(note), ...target });
    for (let round = 0; round < 6; round++) {
      const messageId = questions.ask(root, event, round === 0 ? request.id : `${request.id}~${round}`, question);
      if (!messageId) return null;
      const state = perm?.store.questionsOf(messageId)[0]?.state;
      if (state !== "superseded" && state !== "closed") return messageId;
    }
    return null;
  };

  const onPermission = async (conn: Connection, request: OpenCodePermissionRequest) => {
    if (conn.permissions.has(request.id)) return;
    const whose = await ownSession(conn, request.sessionID);
    if (!whose || conn.closed || conn.permissions.has(request.id)) return;
    conn.permissions.set(request.id, request);
    conn.idleSince = null;
    const root = rootOfLaunch(conn.launchId);
    if (!root || !questions) return;
    const note = whose === "child" ? subagentNote(conn, request.sessionID) : null;
    const event = openCodePermissionEvent(request, conn.folder);
    // Not askable here (a detail that cannot be shown exactly): the server keeps it; the line says it waits in OpenCode.
    const messageId = askFor(root, request, note, conn.folder, await questions.targetNow(root, event));
    if (messageId && !asked.has(messageId)) asked.set(messageId, { launchId: conn.launchId, session: conn.session, request, note, answer: null, retryAt: 0, done: false });
    settleSoon();
  };

  /** A request was answered: by us, by OpenCode's cascade of our earlier answer, or by someone in `opencode attach`. */
  const onReplied = (conn: Connection, requestId: string, reply: unknown, session: string) => {
    conn.permissions.delete(requestId);
    if (conn.sent.has(requestId)) return;
    const last = conn.lastSent;
    const recent = !!last && last.session === session && now() - last.at < CASCADE_MS;
    const text =
      recent && reply === "reject" && last!.reply === "reject"
        ? OPENCODE_DENIED_EARLIER
        : recent && reply === "always" && last!.reply === "always"
          ? OPENCODE_ALLOWED_EARLIER
          : INBOX_PERMISSION_ANSWERED_IN_TERMINAL;
    for (const [messageId, entry] of asked) {
      if (entry.request.id !== requestId || entry.done) continue;
      entry.done = true;
      questions?.withdraw(messageId, text);
    }
  };

  const handleEvent = (conn: Connection, event: { type?: unknown; properties?: Record<string, unknown> }) => {
    const p = event.properties ?? {};
    const mine = (id: unknown) => typeof id === "string" && (id === conn.session || conn.children.has(id));
    switch (event.type) {
      case "session.status": {
        if (p.sessionID !== conn.session) return;
        const type = (p.status as { type?: unknown } | undefined)?.type;
        conn.busy = type === "busy" || type === "retry";
        return;
      }
      case "session.idle":
        if (p.sessionID === conn.session) conn.busy = false;
        return;
      case "session.created":
      case "session.updated": {
        const info = p.info as { id?: unknown; parentID?: unknown; title?: unknown } | undefined;
        if (info && typeof info.id === "string" && mine(info.parentID)) conn.children.set(info.id, typeof info.title === "string" ? info.title : null);
        return;
      }
      case "permission.asked": {
        const request = readOpenCodePermission(p);
        if (request) void onPermission(conn, request);
        return;
      }
      case "permission.replied":
        if (mine(p.sessionID) && typeof p.requestID === "string") onReplied(conn, p.requestID, p.reply, p.sessionID as string);
        return;
      case "question.asked":
        if (mine(p.sessionID) && typeof p.id === "string") conn.questions.add(p.id);
        return;
      case "question.replied":
      case "question.rejected":
        if (typeof p.requestID === "string") conn.questions.delete(p.requestID);
        return;
    }
  };

  /** Whether the server still answers, asked a few times a second apart (one slow answer is not a gone server). */
  const stillThere = async (conn: Connection) => {
    for (let i = 0; i < HEALTH_TRIES; i++) {
      if (conn.closed || !alive(conn.server.pid)) return false;
      if (await healthy(conn.server, conn.folder)) return true;
      if (i < HEALTH_TRIES - 1) await sleep(1_000);
    }
    return false;
  };

  /** The server's `/event` stream, read until the connection closes; a drop is read again while the server answers. */
  const readEvents = async (conn: Connection) => {
    while (!conn.closed) {
      try {
        const response = await fetch(`${conn.server.url}/event?directory=${encodeURIComponent(conn.folder)}`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${conn.server.password}`).toString("base64")}`, accept: "text/event-stream" },
          signal: conn.abort.signal,
        });
        if (!response.ok || !response.body) throw new Error(`event stream ${response.status}`);
        // What the server holds now, in case a prompt came before the stream (a start, an adoption, a drop).
        void catchUp(conn);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let at: number;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const data = chunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("");
            if (!data) continue;
            try {
              handleEvent(conn, JSON.parse(data));
            } catch {
              // One event it cannot read: the next.
            }
          }
        }
      } catch {
        // Dropped, refused or aborted: looked at below.
      }
      if (conn.closed) return;
      if (!(await stillThere(conn))) {
        lost(conn, "the server stopped");
        return;
      }
      await sleep(500);
    }
  };

  /** The session's status, read from the server (after a (re)connect, a failed delivery, before an idle stop). */
  const readStatus = async (conn: Connection) => {
    const status = await call(conn.server, "GET", "/session/status", conn.folder);
    if (status?.status === 200 && status.body && typeof status.body === "object") {
      const type = ((status.body as Record<string, { type?: unknown }>)[conn.session] ?? {}).type;
      conn.busy = type === "busy" || type === "retry";
      return true;
    }
    return false;
  };

  /** The server's pending permissions and the session's status, read once (after a (re)connect). */
  const catchUp = async (conn: Connection) => {
    await readStatus(conn);
    const pending = await call(conn.server, "GET", "/permission", conn.folder);
    if (pending?.status === 200 && Array.isArray(pending.body)) {
      for (const item of pending.body) {
        const request = readOpenCodePermission(item);
        if (request) await onPermission(conn, request);
      }
    }
  };

  /** The connection is gone (the server stopped by itself): its questions go, its wake stops. */
  const lost = (conn: Connection, why: string) => {
    if (conn.closed) return;
    close(conn);
    ctx.log(`Inbox launch ${conn.launchId}: OpenCode ${why}`);
    withdrawLaunch(conn.launchId, INBOX_PERMISSION_NO_LONGER_WAITING);
    perm?.onChange();
  };

  const close = (conn: Connection) => {
    conn.closed = true;
    conn.abort.abort();
    conn.wake?.dispose();
    conn.wake = null;
    if (connections.get(conn.session) === conn) connections.delete(conn.session);
  };

  const withdrawLaunch = (launchId: string, text: string) => {
    for (const [messageId, entry] of asked) {
      if (entry.launchId !== launchId || entry.done) continue;
      entry.done = true;
      questions?.withdraw(messageId, text);
    }
  };

  /** Connect to a launch's running server: its events, then the session's wake. */
  const connect = (launch: InboxLaunchRecord, session: string, server: OpenCodeServer): Connection => {
    const known = connections.get(session);
    if (known && !known.closed) return known;
    idleStopped.delete(session);
    const conn: Connection = {
      launchId: launch.id,
      session,
      folder: launch.folder,
      server,
      abort: new AbortController(),
      busy: false,
      delivering: false,
      permissions: new Map(),
      questions: new Set(),
      children: new Map(),
      strangers: new Set(),
      sent: new Set(),
      lastSent: null,
      idleSince: null,
      wake: null,
      closed: false,
    };
    connections.set(session, conn);
    void readEvents(conn);
    const target: InboxWakeTarget = {
      isBusy: () => conn.closed || conn.busy || conn.delivering || conn.permissions.size > 0 || conn.questions.size > 0,
      async deliver(text) {
        // Busy before the call: the turn starts with it, and an idle stop never ends a server taking one.
        conn.busy = true;
        conn.delivering = true;
        conn.idleSince = null;
        try {
          const sent = await call(conn.server, "POST", `/session/${encodeURIComponent(session)}/prompt_async`, conn.folder, { parts: [{ type: "text", text }] });
          if (!sent || sent.status >= 300) {
            conn.busy = false;
            void readStatus(conn);
            throw new Error(`OpenCode did not take the turn (${sent ? sent.status : "no answer"})`);
          }
        } finally {
          conn.delivering = false;
        }
      },
      notify: (message) => ctx.log(`Inbox launch ${launch.id}: ${message}`),
      projectPath: () => conn.folder,
    };
    const wake = new InboxWake(new InboxAgentConnection({ dataDir: ctx.dataDir, host: OPENCODE, agentName: OPENCODE_NAME, tools: [] }), session, target);
    conn.wake = wake;
    wake.start();
    return conn;
  };

  /**
   * A launch's server from server.json, adopted only when proved ours: the process (`ours`), then it refuses a
   * call with no password, answers ours (a few tries), and has the session. A file naming a process that is not
   * ours is dropped and nothing is signalled; a server of ours that cannot be proved (it never came up, it does
   * not answer, it lost the session) is ended.
   */
  const adoptFromFile = async (launch: InboxLaunchRecord, session: string): Promise<Connection | null> => {
    const server = readServer(launch.id);
    if (!server) return null;
    if (!alive(server.pid) || !ours(server)) {
      ctx.log(`Inbox launch ${launch.id}: server.json names pid ${server.pid}, which is not our opencode serve; dropped`);
      rmSync(serverFile(launch.id), { force: true });
      return null;
    }
    if (await takesAnyone(server, launch.folder)) {
      ctx.log(`Inbox launch ${launch.id}: the server at ${server.url} answers without the password: not ours; dropped, not signalled`);
      rmSync(serverFile(launch.id), { force: true });
      return null;
    }
    let noSession = false;
    for (let i = 0; i < HEALTH_TRIES && !noSession; i++) {
      const open = await call(server, "GET", "/global/health", launch.folder, undefined, 3_000, false);
      if (open?.status === 401 && (await healthy(server, launch.folder))) {
        const found = await call(server, "GET", `/session/${encodeURIComponent(session)}`, launch.folder);
        if (found?.status === 200) {
          unproved.delete(launch.id);
          return connect(launch, session, server);
        }
        noSession = found?.status === 404;
      }
      if (i < HEALTH_TRIES - 1 && !noSession) await sleep(1_000);
    }
    // Ours by its process, but not answering now: tried again on later sweeps for a while (a server busy for a
    // moment keeps its turn and its prompts), then ended.
    const since = unproved.get(launch.id) ?? now();
    unproved.set(launch.id, since);
    if (!noSession && now() - since < UNPROVED_MS) return null;
    unproved.delete(launch.id);
    ctx.log(`Inbox launch ${launch.id}: our opencode serve (pid ${server.pid}) ${noSession ? "no longer has the session" : "does not answer"}; ended`);
    await endServer(server, "not proved");
    dropServerFile(launch.id, server);
    return null;
  };

  /** A launch's server, running and answering: the connection now, else adopted from server.json, else null. */
  const adopt = async (launch: InboxLaunchRecord): Promise<Connection | null> => {
    const session = launch.session_ref;
    if (!session) return null;
    const known = connections.get(session);
    if (known && !known.closed) return known;
    return adoptFromFile(launch, session);
  };

  /** One open (start or resume) per launch at a time; Stop and Delete cancel it (`cancelOpening`). */
  const once = (launchId: string, open: (token: { cancelled: boolean }) => Promise<Connection | null>): Promise<Connection | null> => {
    const under = opening.get(launchId);
    if (under) return under.promise;
    const token = { cancelled: false };
    const promise = open(token)
      .catch((error) => {
        ctx.log(`Inbox launch ${launchId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
      .finally(() => opening.delete(launchId));
    opening.set(launchId, { promise, token });
    return promise;
  };
  /** Cancel a start or resume under way and wait for it; what it opened anyway is closed and ended. */
  const cancelOpening = async (launchId: string) => {
    const under = opening.get(launchId);
    if (!under) return;
    under.token.cancelled = true;
    const conn = await under.promise;
    if (conn && !conn.closed) await shut(conn, "stopped while it started");
  };

  /** Close a connection and end its server (abort the turn first). */
  const shut = async (conn: Connection, why: string) => {
    close(conn);
    if (alive(conn.server.pid) && ours(conn.server)) await call(conn.server, "POST", `/session/${encodeURIComponent(conn.session)}/abort`, conn.folder, undefined, 2_000);
    await endServer(conn.server, why);
    dropServerFile(conn.launchId, conn.server);
  };

  // ── Idle: a server with nothing to do is stopped; a reply continues the session ──

  const idleSweep = () => {
    for (const conn of [...connections.values()]) {
      if (conn.closed) continue;
      const quiet = !conn.busy && !conn.delivering && conn.permissions.size === 0 && conn.questions.size === 0 && !opening.has(conn.launchId);
      if (!quiet) {
        conn.idleSince = null;
        continue;
      }
      conn.idleSince ??= now();
      if (now() - conn.idleSince < idleMs) continue;
      conn.idleSince = null;
      void (async () => {
        // Read once more from the server: a turn or a prompt the events have not shown keeps it.
        if (!(await readStatus(conn)) || conn.busy || conn.closed || conn.delivering) return;
        const pending = await call(conn.server, "GET", "/permission", conn.folder);
        if (pending?.status === 200 && Array.isArray(pending.body) && pending.body.length > 0) return;
        ctx.log(`Inbox launch ${conn.launchId}: OpenCode idle for ${Math.round(idleMs / 60_000)} min; its server stopped (a reply continues the session)`);
        idleStopped.set(conn.session, Math.max(1, Math.round(idleMs / 60_000)));
        await shut(conn, "idle");
        perm?.onChange();
      })();
    }
  };

  // ── Permission questions: the person's answer goes back to the server ──

  let settling = false;
  let settleAgain = false;
  const settle = async () => {
    if (settling) {
      settleAgain = true;
      return;
    }
    settling = true;
    try {
      do {
        settleAgain = false;
        for (const [messageId, entry] of asked) {
          if (entry.done || !questions) continue;
          const root = rootOfLaunch(entry.launchId);
          if (!root) {
            entry.done = true;
            continue;
          }
          if (!entry.answer) {
            const event = openCodePermissionEvent(entry.request, root.launch!.folder);
            const expected = questions.questionFor(root, event, { ...terms(entry.note), ...questions.askedTarget(messageId, event) });
            const answer = questions.settled(messageId, event, expected, terms(entry.note));
            if (!answer) continue;
            if (answer.status !== "decided") {
              entry.done = true;
              continue;
            }
            entry.answer = { choice: answer.choice, reason: answer.reason };
          }
          if (now() < entry.retryAt) continue;
          // Not connected now (an Inbox restart, before the adoption): the answer waits for the server.
          const conn = connections.get(entry.session);
          if (!conn || conn.closed) continue;
          const reply = openCodeReply(entry.answer.choice, entry.answer.reason);
          // Before the call: OpenCode answers the session's other prompts with it at once (its cascade).
          conn.sent.add(entry.request.id);
          conn.lastSent = { reply: reply.reply, session: entry.request.sessionID, at: now() };
          const sent = await call(conn.server, "POST", `/permission/${encodeURIComponent(entry.request.id)}/reply`, conn.folder, reply);
          const took = !!sent && ((sent.status >= 200 && sent.status < 300) || sent.status === 404);
          ctx.log(`Inbox launch ${entry.launchId}: permission ${entry.request.id} answered ${reply.reply} (${sent ? sent.status : "no answer"}${took ? "" : ", tried again soon"})`);
          if (!took) {
            entry.retryAt = now() + REPLY_RETRY_MS;
            continue;
          }
          entry.done = true;
          conn.permissions.delete(entry.request.id);
        }
        for (const [messageId, entry] of asked) if (entry.done) asked.delete(messageId);
      } while (settleAgain);
    } finally {
      settling = false;
    }
  };
  let queued = false;
  const settleSoon = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void settle();
    });
  };

  const resultOf = (exitCode: number, text: string): LaunchHostResult => ({ exitCode, text });
  const launchOfRef = (ref: string) => (perm?.roots() ?? []).find((r) => r.launch!.session_ref === ref)?.launch ?? null;

  const host = {
    agent: OPENCODE,
    name: OPENCODE_NAME,
    shellNames: [] as string[],

    /** `opencode` 1.18 or newer and older than 2 (OpenCode 2 is not this host), and Plannotator's plugin in the person's OpenCode config. */
    async available(): Promise<LaunchAvailability> {
      const path = await findOpenCode();
      if (!path) return { ok: false, missing: true, reason: "opencode is not on the Inbox's PATH or in ~/.opencode/bin" };
      const e = await ctx.environment();
      const version = parseOpenCodeVersion((await agentVersionRun(e, path, { timeoutMs: 10_000 })).stdout);
      if (!version || !versionAtLeast(version, OPENCODE_LAUNCH_MIN_VERSION)) return { ok: false, missing: false, reason: `OpenCode ${version ?? "?"} is older than ${OPENCODE_LAUNCH_MIN_VERSION}` };
      if (versionAtLeast(version, "2.0.0")) return { ok: false, missing: false, reason: `OpenCode ${version} is OpenCode 2, which the Inbox cannot start yet` };
      if (!openCodePluginInstalled(e)) return { ok: false, missing: false, reason: "Plannotator's OpenCode plugin is not in your OpenCode config" };
      return { ok: true, version };
    },

    /** Settings → Agents' switch: full permissions (an allow-all ruleset), else the person's own OpenCode permissions. */
    startOf: () => {
      const full = ctx.config().fullPermissions === true;
      return { full, ownMode: !full, bypass: false };
    },

    /** OpenCode asks no folder trust. */
    trusts: () => true,

    /** The server, then the session. No first turn: the wake delivers the root once the engine moved it there. */
    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
      let failure: { code: "missing" | "failed"; text: string } | null = null;
      let made: { session: string } | null = null;
      await once(launch.id, async (token) => {
        const opened = await startServer(launch, input.login, token);
        if ("failure" in opened) {
          failure = { code: opened.missing ? "missing" : "failed", text: opened.cancelled ? "Stopped while it started." : opened.failure };
          return null;
        }
        const { server } = opened;
        const permission = inboxLaunchFullPermissions(launch) ? [{ permission: "*", pattern: "*", action: "allow" }] : undefined;
        const answered = await call(server, "POST", "/session", launch.folder, { title: input.name, ...(permission ? { permission } : {}) });
        const session = answered?.status === 200 && answered.body && typeof answered.body === "object" ? (answered.body as { id?: unknown }).id : null;
        if (typeof session !== "string" || !/^ses[A-Za-z0-9_-]+$/.test(session) || token.cancelled) {
          await endServer(server, "no session");
          dropServerFile(launch.id, server);
          if (!token.cancelled) ctx.startLog(launch.id, `POST /session answered ${answered ? answered.status : "nothing"}`);
          failure = { code: "failed", text: token.cancelled ? "Stopped while it started." : "OpenCode started but made no session." };
          return null;
        }
        ctx.startLog(launch.id, `session ${session}${permission ? " (full permissions)" : ""}`);
        made = { session };
        return connect({ ...launch, session_ref: session }, session, server);
      });
      const done = made as { session: string } | null;
      if (done) return { ok: true as const, session: done.session, ref: done.session };
      const failed = (failure as { code: "missing" | "failed"; text: string } | null) ?? { code: "failed" as const, text: "OpenCode did not start." };
      return { ok: false as const, code: failed.code, text: failed.text };
    },

    /** Each launched session's server: waiting on a prompt the card does not hold (or OpenCode's own question), working, idle, or stopped. */
    async sessions() {
      const roots = perm?.roots() ?? [];
      for (const root of roots) {
        const launch = root.launch!;
        if (launch.session_ref && !connections.get(launch.session_ref) && !opening.has(launch.id)) await once(launch.id, () => adopt(launch));
      }
      return (ref: string) => {
        const conn = connections.get(ref);
        if (!conn || conn.closed) return { status: null, state: "stopped", waitingFor: null };
        const unasked = [...conn.permissions.keys()].some((id) => ![...asked.values()].some((entry) => entry.request.id === id));
        if (conn.questions.size > 0) return { status: "waiting", state: "running", waitingFor: "question" };
        if (unasked) return { status: "waiting", state: "running", waitingFor: "permission prompt" };
        return { status: conn.busy ? "busy" : "idle", state: "running", waitingFor: null };
      };
    },

    /** The wake's bridge poll, while the Inbox is connected to the session's server (a stopped one is not live at once). */
    live: (session: string) => {
      const conn = connections.get(session);
      return conn && !conn.closed ? ctx.bridge.runStateOf(session) : null;
    },

    /** A reply to a session that is not live: its server again (adopted, else a new one), and its wake. */
    async resume(launch: InboxLaunchRecord) {
      const session = launch.session_ref;
      if (!session) return { exitCode: 1, text: "no session", failure: { code: "failed" as const, text: "That session never started." } };
      let failure: string | null = null;
      let cancelled = false;
      const conn = await once(launch.id, async (token) => {
        const adopted = await adopt(launch);
        if (adopted) return adopted;
        if (token.cancelled) {
          cancelled = true;
          return null;
        }
        const opened = await startServer(launch, await ctx.loginEnv(), token);
        if ("failure" in opened) {
          cancelled = opened.cancelled === true;
          failure = opened.failure;
          return null;
        }
        const found = await call(opened.server, "GET", `/session/${encodeURIComponent(session)}`, launch.folder);
        if (found?.status !== 200 || token.cancelled) {
          await endServer(opened.server, token.cancelled ? "stopped while it started" : "no session");
          dropServerFile(launch.id, opened.server);
          cancelled = token.cancelled;
          failure = "OpenCode no longer has this session.";
          return null;
        }
        return connect(launch, session, opened.server);
      });
      if (conn) return { exitCode: 0, text: `opencode serve ${conn.server.url}`, failure: null };
      // Stopped or deleted while it started again: no failure to show ("You stopped").
      if (cancelled) return { exitCode: 0, text: "stopped while it started", failure: null };
      return { exitCode: 1, text: failure ?? "did not start", failure: { code: "failed" as const, text: failure ?? "OpenCode did not start again." } };
    },

    /** Cancel a start under way, abort the turn, then end the server's process group (its shell commands too). */
    async stop(ref: string) {
      const launch = connections.get(ref) ? null : launchOfRef(ref);
      const launchId = connections.get(ref)?.launchId ?? launch?.id ?? null;
      if (launchId) await cancelOpening(launchId);
      idleStopped.delete(ref);
      const conn = connections.get(ref);
      if (conn) {
        await shut(conn, "Stop");
        return resultOf(0, `stopped opencode serve (pid ${conn.server.pid})`);
      }
      const server = launchId ? readServer(launchId) : null;
      if (!server || !launchId) return resultOf(0, "not running");
      // A server from an earlier Inbox, not adopted: ended only when proved ours (never one that takes anyone).
      if (!alive(server.pid) || !ours(server) || (await takesAnyone(server, launch?.folder ?? "/"))) {
        rmSync(serverFile(launchId), { force: true });
        return resultOf(0, `pid ${server.pid} is not our server; not signalled`);
      }
      await call(server, "POST", `/session/${encodeURIComponent(ref)}/abort`, launch?.folder ?? "/", undefined, 2_000);
      await endServer(server, "Stop");
      dropServerFile(launchId, server);
      return resultOf(0, `stopped opencode serve (pid ${server.pid})`);
    },

    /** Delete, after stop: `opencode session delete` (no plugins). */
    async remove(ref: string) {
      const bin = await findOpenCode();
      if (!bin) return resultOf(1, "opencode is not on PATH");
      const e = await ctx.environment();
      const launch = launchOfRef(ref);
      const ran: AgentRunResult = await e.run([bin, "session", "delete", ref, "--pure"], { timeoutMs: 30_000, ...(launch ? { cwd: launch.folder } : {}) });
      return resultOf(ran.exitCode, `${ran.stdout}${ran.stderr}`);
    },

    /** OpenCode keeps nothing for a plain folder beyond its sessions (removed by Delete). */
    purge: async () => ({ exitCode: 0, text: "", skipped: "OpenCode keeps nothing for the folder beyond its sessions" }),

    attach(launch: InboxLaunchRecord): string | null {
      if (!launch.session_ref) return null;
      const conn = connections.get(launch.session_ref);
      const server = conn && !conn.closed ? conn.server : null;
      return openCodeAttachCommand(launch.folder, launch.session_ref, server ? { url: server.url, file: serverFile(launch.id) } : null);
    },
    terminal: (launch: InboxLaunchRecord): string => host.attach(launch) ?? `cd ${shellWord(launch.folder)} && opencode`,

    /** A server this host stopped for being idle: "OpenCode stopped. It was idle for 30 minutes. Your reply continues it." Else today's line. */
    stoppedNote(launch: InboxLaunchRecord): string | null {
      const minutes = launch.session_ref ? idleStopped.get(launch.session_ref) : undefined;
      return minutes ? openCodeIdleNote(minutes) : null;
    },

    /** The Inbox stops: its event streams and wakes go; the servers run on, adopted by the next Inbox. */
    close() {
      for (const conn of [...connections.values()]) close(conn);
    },

    permissions(context: LaunchPermissionContext): LaunchHostPermissions {
      perm = context;
      questions = createLaunchQuestions({
        store: context.store,
        name: OPENCODE_NAME,
        displayFolder: context.displayFolder,
        onChange: context.onChange,
        log: context.log ?? (() => {}),
      });
      // An answer is a store line: it goes back at once, not at the next sweep.
      context.store.subscribe(() => {
        if (asked.size > 0) settleSoon();
      });
      let adopting = false;
      return {
        /** Every second: adopt a server an earlier Inbox started; answer what the person answered; stop an idle server. */
        sweep() {
          if (!adopting) {
            const waiting = context.roots().filter((root) => {
              const ref = root.launch!.session_ref;
              return ref && !connections.has(ref) && !opening.has(root.launch!.id) && existsSync(serverFile(root.launch!.id));
            });
            if (waiting.length > 0) {
              adopting = true;
              void Promise.all(waiting.map((root) => once(root.launch!.id, () => adopt(root.launch!))))
                .then((found) => {
                  if (found.some(Boolean)) context.onChange();
                })
                .finally(() => {
                  adopting = false;
                });
            }
          }
          if (asked.size > 0) settleSoon();
          idleSweep();
        },
        withdrawAll(root: InboxMessage) {
          withdrawLaunch(root.launch!.id, INBOX_PERMISSION_NO_LONGER_WAITING);
          questions!.withdrawAll(root);
        },
        forget(launchId: string) {
          for (const [messageId, entry] of asked) if (entry.launchId === launchId) asked.delete(messageId);
        },
      };
    },
  } satisfies LaunchHost;
  return host;
}
