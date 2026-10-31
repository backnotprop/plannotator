/**
 * OpenCode as a launch host (the `LaunchHost` in inbox-launch-host.ts): the
 * person picks "New OpenCode session" in To, and OpenCode starts in the
 * project in the background, with the person's own setup.
 *
 * OpenCode 1.18 has no background service of its own, so the Inbox runs one
 * `opencode serve` per launch: on 127.0.0.1, a port OpenCode picks, a random
 * password (Basic auth, `OPENCODE_SERVER_PASSWORD`), in its own process group
 * (`detached`), stdout and stderr to `launch/<id>/server.log`. Its pid, url and
 * password are in `launch/<id>/server.json` (0600), and nowhere else: never a
 * log, the start log, argv, the run line or the attach command (that reads the
 * file). The server outlives an Inbox restart (a turn keeps running through
 * an update) and the next Inbox adopts it: the pid alive and the password
 * answering. Stop aborts the turn and ends the server's process group (its
 * shell commands too); a reply starts a new server on the same session, which
 * OpenCode keeps in its own database with its history.
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
 *    becomes the thread's permission card (inbox-launch-opencode-permission.ts).
 *  - OpenCode 2 (`opencode2`, whose package also ships `opencode` 2.x) is not
 *    offered: it runs as a service of its own and its plugin has a wake.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { INBOX_PERMISSION_ANSWERED_IN_TERMINAL, INBOX_PERMISSION_NO_LONGER_WAITING, inboxLaunchFullPermissions } from "@plannotator/core/inbox-permission";
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

/** `1.18.23` (OpenCode prints the bare version) → `1.18.23`. */
export function parseOpenCodeVersion(stdout: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(stdout)?.[0] ?? null;
}

/** The url `opencode serve` says it listens on, from its log. */
export function parseListening(log: string): string | null {
  return /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1] ?? null;
}

/** What `launch/<id>/server.json` holds (0600): the server's process, where it listens, its password. */
export interface OpenCodeServer {
  pid: number;
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** One launched session the Inbox is connected to now: its server, its event stream, its wake. */
interface Connection {
  launchId: string;
  session: string;
  folder: string;
  server: OpenCodeServer;
  /** Ends the event stream and the wake. */
  abort: AbortController;
  busy: boolean;
  /** Permission requests the server holds now, by id. */
  permissions: Map<string, OpenCodePermissionRequest>;
  /** OpenCode's own question tool waits on someone (it is answered in OpenCode, never here). */
  questions: Set<string>;
  wake: InboxWake | null;
  /** Gone: the server stopped answering, or Stop. */
  closed: boolean;
}

/** A permission question the thread holds for a server's request. */
interface Asked {
  launchId: string;
  request: OpenCodePermissionRequest;
  /** Answered (the reply went, or is going) or withdrawn: nothing more to do. */
  done: boolean;
}

export function createOpenCodeLaunchHost(ctx: LaunchHostContext) {
  const connections = new Map<string, Connection>();
  /** Starts and resumes under way, by launch id: one at a time. */
  const opening = new Map<string, Promise<Connection | null>>();
  let perm: LaunchPermissionContext | null = null;
  let questions: ReturnType<typeof createLaunchQuestions> | null = null;
  /** Permission questions by message id. */
  const asked = new Map<string, Asked>();
  const terms = () => openCodePermissionTerms(ctx.displayFolder);

  const serverFile = (launchId: string) => join(ctx.launchDir(launchId), "server.json");
  const readServer = (launchId: string): OpenCodeServer | null => {
    try {
      const value = JSON.parse(readFileSync(serverFile(launchId), "utf8")) as Partial<OpenCodeServer>;
      return typeof value.pid === "number" && typeof value.url === "string" && typeof value.password === "string" ? (value as OpenCodeServer) : null;
    } catch {
      return null;
    }
  };
  const writeServer = (launchId: string, server: OpenCodeServer) => {
    mkdirSync(ctx.launchDir(launchId), { recursive: true, mode: 0o700 });
    // One line, `"password":"<hex>"`: the attach command's `sed` reads it there.
    writeFileSync(serverFile(launchId), `${JSON.stringify({ pid: server.pid, url: server.url, password: server.password })}\n`, { mode: 0o600 });
    chmodSync(serverFile(launchId), 0o600);
  };

  const call = async (server: OpenCodeServer, method: string, path: string, folder: string, body?: unknown, ms = CALL_MS): Promise<{ status: number; body: unknown } | null> => {
    try {
      const url = `${server.url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(folder)}`;
      const response = await fetch(url, {
        method,
        headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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

  /** The `opencode` the Inbox runs: on the plain env's PATH, else OpenCode's own install folder. */
  const findOpenCode = async (): Promise<string | null> => {
    const e = await ctx.environment();
    const found = e.which("opencode");
    if (found) return found;
    const installed = join(ctx.homeDir, ".opencode", "bin", "opencode");
    return !process.env.PLANNOTATOR_TEST_SANDBOX && existsSync(installed) ? installed : null;
  };

  // ── The server: one per launch ──

  /** End a server's process group: SIGTERM, then SIGKILL after the grace. */
  const endServer = async (server: OpenCodeServer) => {
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-server.pid, s);
      } catch {
        try {
          process.kill(server.pid, s);
        } catch {
          // Gone.
        }
      }
    };
    if (!alive(server.pid)) return;
    signal("SIGTERM");
    const deadline = Date.now() + KILL_GRACE_MS;
    while (alive(server.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    signal("SIGKILL");
  };

  /** Start `opencode serve` for a launch, in its folder, with the login env; null and the cause when it did not come up. */
  const startServer = async (launch: InboxLaunchRecord, login: LaunchEnv): Promise<{ server: OpenCodeServer } | { failure: string; missing?: boolean }> => {
    const bin = await findOpenCode();
    if (!bin) return { failure: "opencode is not on the Inbox's PATH or in ~/.opencode/bin.", missing: true };
    const dir = ctx.launchDir(launch.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const password = randomBytes(24).toString("hex");
    const isDefaultDataDir = resolve(ctx.dataDir) === resolve(getDefaultPlannotatorDataDir(ctx.homeDir));
    const env = openCodeServerEnv(login, { launchId: launch.id, password, dataDir: isDefaultDataDir ? null : ctx.dataDir });
    const logPath = join(dir, "server.log");
    rmSync(logPath, { force: true });
    const fd = openSync(logPath, "a", 0o600);
    let pid: number | undefined;
    try {
      const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: launch.folder, env, detached: true, stdio: ["ignore", fd, fd] });
      pid = child.pid;
      child.on("error", () => {});
      child.unref();
    } finally {
      closeSync(fd);
    }
    if (!pid) return { failure: "opencode serve did not start." };
    const deadline = Date.now() + SERVER_UP_MS;
    let url: string | null = null;
    while (Date.now() < deadline && alive(pid)) {
      url ??= parseListening(readFileSync(logPath, "utf8"));
      if (url && (await healthy({ pid, url, password }, launch.folder))) {
        const server = { pid, url, password };
        writeServer(launch.id, server);
        ctx.startLog(launch.id, `opencode serve (pid ${pid}) listening on ${url}`);
        return { server };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    const said = readFileSync(logPath, "utf8").trim().split("\n").slice(-5).join("\n");
    await endServer({ pid, url: url ?? "", password });
    ctx.startLog(launch.id, `opencode serve did not come up:\n${said}`);
    return { failure: `opencode serve did not come up${said ? `: ${said.split("\n").at(-1)}` : "."}` };
  };

  // ── The connection: the server's events and the session's wake ──

  const rootOfLaunch = (launchId: string): InboxMessage | null => perm?.rootOf(launchId) ?? null;

  const onPermission = async (conn: Connection, request: OpenCodePermissionRequest) => {
    if (request.sessionID !== conn.session || conn.permissions.has(request.id)) return;
    conn.permissions.set(request.id, request);
    const root = rootOfLaunch(conn.launchId);
    if (!root || !questions) return;
    const event = openCodePermissionEvent(request, conn.folder);
    const question = questions.questionFor(root, event, { ...terms(), ...(await questions.targetNow(root, event)) });
    // Not askable here (a detail that cannot be shown exactly): the server keeps it; the line says it waits in OpenCode.
    const messageId = questions.ask(root, event, request.id, question);
    if (messageId && !asked.has(messageId)) asked.set(messageId, { launchId: conn.launchId, request, done: false });
    settleSoon();
  };

  /** Someone else answered (`opencode attach`): the question goes, as answered in Terminal. */
  const onReplied = (conn: Connection, requestId: string) => {
    conn.permissions.delete(requestId);
    for (const [messageId, entry] of asked) {
      if (entry.request.id !== requestId || entry.done) continue;
      entry.done = true;
      questions?.withdraw(messageId, INBOX_PERMISSION_ANSWERED_IN_TERMINAL);
    }
  };

  const handleEvent = (conn: Connection, event: { type?: unknown; properties?: Record<string, unknown> }) => {
    const p = event.properties ?? {};
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
      case "permission.asked": {
        const request = readOpenCodePermission(p);
        if (request) void onPermission(conn, request);
        return;
      }
      case "permission.replied":
        if (p.sessionID === conn.session && typeof p.requestID === "string") onReplied(conn, p.requestID);
        return;
      case "question.asked":
        if (p.sessionID === conn.session && typeof p.id === "string") conn.questions.add(p.id);
        return;
      case "question.replied":
      case "question.rejected":
        if (typeof p.requestID === "string") conn.questions.delete(p.requestID);
        return;
    }
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
        // What the server holds now, in case a prompt came before the stream (a start, an adoption).
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
      if (!alive(conn.server.pid) || !(await healthy(conn.server, conn.folder))) {
        lost(conn, "the server stopped");
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  /** The server's pending permissions and the session's status, read once (after a (re)connect). */
  const catchUp = async (conn: Connection) => {
    const status = await call(conn.server, "GET", "/session/status", conn.folder);
    if (status?.status === 200 && status.body && typeof status.body === "object") {
      const type = ((status.body as Record<string, { type?: unknown }>)[conn.session] ?? {}).type;
      conn.busy = type === "busy" || type === "retry";
    }
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
    const conn: Connection = { launchId: launch.id, session, folder: launch.folder, server, abort: new AbortController(), busy: false, permissions: new Map(), questions: new Set(), wake: null, closed: false };
    connections.set(session, conn);
    void readEvents(conn);
    const target: InboxWakeTarget = {
      isBusy: () => conn.closed || conn.busy || conn.permissions.size > 0 || conn.questions.size > 0,
      async deliver(text) {
        const sent = await call(conn.server, "POST", `/session/${encodeURIComponent(session)}/prompt_async`, conn.folder, { parts: [{ type: "text", text }] });
        if (!sent || sent.status >= 300) throw new Error(`OpenCode did not take the turn (${sent ? sent.status : "no answer"})`);
        conn.busy = true;
      },
      notify: (message) => ctx.log(`Inbox launch ${launch.id}: ${message}`),
      projectPath: () => conn.folder,
    };
    const wake = new InboxWake(new InboxAgentConnection({ dataDir: ctx.dataDir, host: OPENCODE, agentName: OPENCODE_NAME, tools: [] }), session, target);
    conn.wake = wake;
    wake.start();
    return conn;
  };

  /** A launch's server, running and answering: the connection now, else adopted from server.json, else null. */
  const adopt = async (launch: InboxLaunchRecord): Promise<Connection | null> => {
    const session = launch.session_ref;
    if (!session) return null;
    const known = connections.get(session);
    if (known && !known.closed) return known;
    const server = readServer(launch.id);
    if (!server) return null;
    if (alive(server.pid) && (await healthy(server, launch.folder))) return connect(launch, session, server);
    rmSync(serverFile(launch.id), { force: true });
    return null;
  };

  /** One open (start or resume) per launch at a time. */
  const once = (launchId: string, open: () => Promise<Connection | null>): Promise<Connection | null> => {
    const under = opening.get(launchId);
    if (under) return under;
    const p = open().finally(() => opening.delete(launchId));
    opening.set(launchId, p);
    return p;
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
          const event = openCodePermissionEvent(entry.request, root.launch!.folder);
          const expected = questions.questionFor(root, event, { ...terms(), ...questions.askedTarget(messageId, event) });
          const answer = questions.settled(messageId, event, expected, terms());
          if (!answer) continue;
          entry.done = true;
          if (answer.status !== "decided") continue;
          const conn = connections.get(entry.request.sessionID);
          if (!conn || conn.closed) continue;
          const reply = openCodeReply(answer.choice, answer.reason);
          const sent = await call(conn.server, "POST", `/permission/${encodeURIComponent(entry.request.id)}/reply`, conn.folder, reply);
          conn.permissions.delete(entry.request.id);
          ctx.log(`Inbox launch ${entry.launchId}: permission ${entry.request.id} answered ${reply.reply} (${sent ? sent.status : "no answer"})`);
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
      const opened = await startServer(launch, input.login);
      if ("failure" in opened) return { ok: false as const, code: opened.missing ? ("missing" as const) : ("failed" as const), text: opened.failure };
      const { server } = opened;
      const permission = inboxLaunchFullPermissions(launch) ? [{ permission: "*", pattern: "*", action: "allow" }] : undefined;
      const made = await call(server, "POST", "/session", launch.folder, { title: input.name, ...(permission ? { permission } : {}) });
      const session = made?.status === 200 && made.body && typeof made.body === "object" ? (made.body as { id?: unknown }).id : null;
      if (typeof session !== "string" || !/^ses[A-Za-z0-9_-]+$/.test(session)) {
        await endServer(server);
        rmSync(serverFile(launch.id), { force: true });
        ctx.startLog(launch.id, `POST /session answered ${made ? made.status : "nothing"}`);
        return { ok: false as const, code: "failed" as const, text: "OpenCode started but made no session." };
      }
      ctx.startLog(launch.id, `session ${session}${permission ? " (full permissions)" : ""}`);
      connect({ ...launch, session_ref: session }, session, server);
      return { ok: true as const, session, ref: session };
    },

    /** Each launched session's server: waiting on a prompt the card does not hold (or OpenCode's own question), working, idle, or stopped. */
    async sessions() {
      const roots = perm?.roots() ?? [];
      for (const root of roots) if (root.launch!.session_ref && !connections.get(root.launch!.session_ref)) await adopt(root.launch!);
      return (ref: string) => {
        const conn = connections.get(ref);
        if (!conn || conn.closed) return { status: null, state: "stopped", waitingFor: null };
        const unasked = [...conn.permissions.keys()].some((id) => ![...asked.values()].some((entry) => entry.request.id === id));
        if (conn.questions.size > 0) return { status: "waiting", state: "running", waitingFor: "question" };
        if (unasked) return { status: "waiting", state: "running", waitingFor: "permission prompt" };
        return { status: conn.busy ? "busy" : "idle", state: "running", waitingFor: null };
      };
    },

    /** The wake's bridge poll. */
    live: (session: string) => ctx.bridge.runStateOf(session),

    /** A reply to a session that is not live: its server again (adopted, else a new one), and its wake. */
    async resume(launch: InboxLaunchRecord) {
      const session = launch.session_ref;
      if (!session) return { exitCode: 1, text: "no session", failure: { code: "failed" as const, text: "That session never started." } };
      let failure: string | null = null;
      const conn = await once(launch.id, async () => {
        const adopted = await adopt(launch);
        if (adopted) return adopted;
        const opened = await startServer(launch, await ctx.loginEnv());
        if ("failure" in opened) {
          failure = opened.failure;
          return null;
        }
        const found = await call(opened.server, "GET", `/session/${encodeURIComponent(session)}`, launch.folder);
        if (found?.status !== 200) {
          await endServer(opened.server);
          rmSync(serverFile(launch.id), { force: true });
          failure = "OpenCode no longer has this session.";
          return null;
        }
        return connect(launch, session, opened.server);
      });
      if (conn) return { exitCode: 0, text: `opencode serve ${conn.server.url}`, failure: null };
      return { exitCode: 1, text: failure ?? "did not start", failure: { code: "failed" as const, text: failure ?? "OpenCode did not start again." } };
    },

    /** Abort the turn, then end the server's process group (its shell commands too). */
    async stop(ref: string) {
      const conn = connections.get(ref);
      const root = (perm?.roots() ?? []).find((r) => r.launch!.session_ref === ref);
      const server = conn?.server ?? (root ? readServer(root.launch!.id) : null);
      if (conn) close(conn);
      if (!server) return resultOf(0, "not running");
      if (alive(server.pid)) await call(server, "POST", `/session/${encodeURIComponent(ref)}/abort`, conn?.folder ?? root?.launch!.folder ?? "/", undefined, 2_000);
      await endServer(server);
      const launchId = conn?.launchId ?? root?.launch!.id;
      if (launchId) rmSync(serverFile(launchId), { force: true });
      return resultOf(0, `stopped opencode serve (pid ${server.pid})`);
    },

    /** Delete, after stop: `opencode session delete` (no plugins). */
    async remove(ref: string) {
      const bin = await findOpenCode();
      if (!bin) return resultOf(1, "opencode is not on PATH");
      const e = await ctx.environment();
      const root = (perm?.roots() ?? []).find((r) => r.launch!.session_ref === ref);
      const ran: AgentRunResult = await e.run([bin, "session", "delete", ref, "--pure"], { timeoutMs: 30_000, ...(root ? { cwd: root.launch!.folder } : {}) });
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
        /** Every second: adopt a server an earlier Inbox started; answer what the person answered. */
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
