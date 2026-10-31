/**
 * Pi as a `LaunchHost` (inbox-launch-host.ts): "New Pi session" in compose's To.
 *
 * Pi has no background host of its own (no `claude --bg`, no daemon), so the
 * Inbox owns the process: one `pi --mode rpc --session-id <uuid>` per launched
 * session, in its folder, with stdin held open by the Inbox. The uuid is the
 * Pi session's id, so it is both the launch's `session` and its `session_ref`.
 * Pi's RPC mode ends when its stdin closes, so **a Pi session lives only while
 * the Inbox runs**: Stop, Delete and an Inbox exit all end the process (Pi
 * writes its session file as it goes), and a reply starts it again with the
 * same `--session-id`, which reopens that file with the whole conversation;
 * the waiting reply is then delivered.
 *
 * Messages move as for any Pi session: Plannotator's own Pi extension runs in
 * the process (RPC mode reports `ctx.hasUI`), polls the launching Inbox's
 * bridge as host `pi` and session `<uuid>`, takes the root as its first turn
 * and answers through `plannotator_inbox`. The process gets the person's login
 * env through the launch filter, `PLANNOTATOR_DATA_DIR` when the Inbox's data
 * dir is not the default (so it reaches this Inbox), and
 * `PLANNOTATOR_INBOX_TOOL=1` (the Inbox tool is off for Pi by default; a
 * launched session is nothing without it). Nothing goes on argv but the mode,
 * the session id and the name.
 *
 * Pi has no permission prompts of its own. An extension's dialog
 * (`ctx.ui.select/confirm/input/editor`, an `extension_ui_request` on RPC) is
 * free-form: a title and the extension's own option strings, with no tool and
 * no allow or deny. The Inbox cannot put it on the permission card honestly,
 * so it answers `cancelled` at once (fail closed: a permission gate blocks)
 * and says so in the thread: one note from the session, "Pi asked something
 * the Inbox can't show yet (“<title>”); answered Cancel."
 *
 * Open in Terminal hands the session over: while the Inbox's process runs, the
 * Terminal command first waits for that process to end (the Inbox ends it at
 * once), so two processes never write one session file. Copy attach command
 * is offered only while no process of the Inbox's runs it.
 */

import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { getDefaultPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { agentVersionRun, createAgentEnvironmentFor } from "./inbox-agents";
import { shellQuote, versionAtLeast } from "./inbox-launch-claude";
import { launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchHost, LaunchHostContext, LaunchHostResult, LaunchPermissionContext } from "./inbox-launch-host";

export const PI = "pi" as const;
export const PI_NAME = "Pi";
/** The Plannotator Pi extension's floor (its peer dependency); `--session-id` came in 0.76. */
export const PI_LAUNCH_MIN_VERSION = "0.79.1";
/** The stopped line's words (`stoppedNote`): said plainly, as it is. */
export const PI_STOPPED_NOTE = "A Pi session runs only while the Inbox runs. Your reply continues it.";
/** How long a new process may take to answer its first RPC command. */
const READY_MS = 30_000;
/** How long Stop waits for the process to end after its stdin closed, before it signals it. */
const STOP_MS = 5_000;
/** After Open in Terminal: a reply in this window goes to the Terminal's Pi, never to a second process here. */
const HANDOFF_MS = 60_000;
/** The longest dialog title the thread note quotes. */
const NOTE_TITLE_MAX = 80;

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

// ── Pure helpers (unit-tested) ──

/** `pi --version` prints the version alone (`0.85.1`). */
export function parsePiVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
}

/**
 * Whether Pi's settings load Plannotator's Pi extension: a `packages` entry (a string or `{ source }`) or an
 * `extensions` path naming it (`npm:@plannotator/pi-extension`, a git URL, a local checkout's path).
 */
export function piExtensionListed(settingsText: string | null): boolean {
  if (!settingsText) return false;
  let settings: unknown;
  try {
    settings = JSON.parse(settingsText);
  } catch {
    return false;
  }
  if (!settings || typeof settings !== "object") return false;
  const { packages, extensions } = settings as { packages?: unknown; extensions?: unknown };
  const names = [...(Array.isArray(packages) ? packages : []), ...(Array.isArray(extensions) ? extensions : [])].map((entry) =>
    typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source : "",
  );
  return names.some((name) => /plannotator/i.test(name));
}

/** The argv of one Pi process for a session: RPC mode, its exact session id (made when missing), its name. */
export function piArgv(pi: string, session: string, name: string): string[] {
  // A name that starts with "-" would read as a flag.
  const shown = name.replace(/^-+/, "").trim() || "Inbox";
  return [pi, "--mode", "rpc", "--session-id", session, "--name", shown];
}

/** The process's env: the login env through the launch filter, the Inbox tool on, and this Inbox's data dir when not the default. */
export function piSpawnEnv(login: Readonly<LaunchEnv>, dataDir: string | null): LaunchEnv {
  return { ...launchSpawnEnv(login), PLANNOTATOR_INBOX_TOOL: "1", ...(dataDir ? { PLANNOTATOR_DATA_DIR: dataDir } : {}) };
}

/** What Copy attach command copies: the session, opened in Pi in its folder. */
export function piAttachCommand(folder: string, session: string): string {
  return `cd ${shellQuote(folder)} && pi --session ${session}`;
}

/** Open in Terminal while the Inbox's process `pid` runs: wait for it to end first, so one process writes the session. */
export function piHandoffCommand(folder: string, session: string, pid: number): string {
  return `cd ${shellQuote(folder)} && while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done; pi --session ${session}`;
}

/**
 * A dialog's title as the thread note quotes it: one line, every control or invisible character dropped,
 * Markdown's marks escaped, at most 80 characters.
 */
export function piDialogTitle(title: unknown): string {
  const flat = String(typeof title === "string" ? title : "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const short = [...flat].length > NOTE_TITLE_MAX ? `${[...flat].slice(0, NOTE_TITLE_MAX - 1).join("").trimEnd()}…` : flat;
  // Only marks the Inbox's inline Markdown both formats and unescapes (InlineMarkdown's
  // backslash rule): an escaped `:` or `<` would show its backslash; React keeps `<` text.
  return short.replace(/[\\`*_[\]~#>|$!&{}]/g, (mark) => `\\${mark}`);
}

/** The thread note for a dialog the Inbox answered Cancel. */
export function piDialogNote(title: unknown): string {
  const shown = piDialogTitle(title);
  return shown ? `Pi asked something the Inbox can't show yet (“${shown}”); answered Cancel.` : "Pi asked something the Inbox can't show yet; answered Cancel.";
}

/** Pi's default sessions folder for `cwd` under `agentDir` (its `getDefaultSessionDirPath`). */
export function piSessionDirOf(agentDir: string, cwd: string): string {
  return join(resolve(agentDir), "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** The `cwd` of a Pi session file's header line, or null. */
export function piSessionCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, read).toString("utf8").split("\n", 1)[0] ?? "") as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" ? header.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ── The process ──

interface PiProcess {
  launchId: string;
  session: string;
  proc: ReturnType<typeof Bun.spawn>;
  exited: boolean;
  exitCode: number | null;
  busy: boolean;
  waiters: Map<string, (event: Record<string, unknown>) => void>;
  stderr: string;
  ended: Promise<number>;
}

/** Pi as a `LaunchHost`; `close` (also `dispose`) ends every process it owns. */
export function createPiLaunchHost(ctx: LaunchHostContext) {
  /** Pi's own folder (`PI_CODING_AGENT_DIR` from the login shell or the Inbox, else `~/.pi/agent`). */
  const agentDir = () => ctx.shell()?.PI_CODING_AGENT_DIR ?? ctx.ownEnv().PI_CODING_AGENT_DIR ?? join(ctx.homeDir, ".pi", "agent");
  const settingsText = () => {
    try {
      return readFileSync(join(agentDir(), "settings.json"), "utf8");
    } catch {
      return null;
    }
  };
  const isDefaultDataDir = () => resolve(ctx.dataDir) === resolve(getDefaultPlannotatorDataDir(ctx.homeDir));

  /** The running (or last) process of each session, by session id. */
  const procs = new Map<string, PiProcess>();
  /** Open in Terminal handed these sessions over (until when): a reply goes to the Terminal's Pi. */
  const handedOff = new Map<string, number>();
  /** The engine's permission context, for the thread note (set once by `permissions`). */
  let threads: LaunchPermissionContext | null = null;
  let rpcIds = 0;

  const running = (session: string): PiProcess | null => {
    const p = procs.get(session);
    return p && !p.exited ? p : null;
  };
  const send = (p: PiProcess, command: Record<string, unknown>) => {
    try {
      const stdin = p.proc.stdin as { write(text: string): void; flush?(): void };
      stdin.write(`${JSON.stringify(command)}\n`);
      stdin.flush?.();
    } catch {
      // Gone: its exit is recorded by `ended`.
    }
  };
  const request = (p: PiProcess, command: Record<string, unknown>, ms: number): Promise<Record<string, unknown> | null> =>
    new Promise((done) => {
      const id = `inbox-${++rpcIds}`;
      const timer = setTimeout(() => {
        p.waiters.delete(id);
        done(null);
      }, ms);
      p.waiters.set(id, (event) => {
        clearTimeout(timer);
        done(event);
      });
      void p.ended.then(() => {
        clearTimeout(timer);
        p.waiters.delete(id);
        done(null);
      });
      send(p, { ...command, id });
    });

  /** A dialog no one here can show: Cancel at once, and one note in the launch's thread saying so. */
  const dialog = (p: PiProcess, event: Record<string, unknown>) => {
    send(p, { type: "extension_ui_response", id: event.id, cancelled: true });
    const note = piDialogNote(event.title);
    ctx.startLog(p.launchId, `extension dialog ${String(event.method)} answered cancelled: ${String(event.title ?? "").slice(0, 200)}`);
    ctx.log(`Inbox launch ${p.launchId}: a Pi extension dialog (${String(event.method)}) answered Cancel`);
    const root = threads?.rootOf(p.launchId);
    if (!threads || !root) return;
    try {
      const latest = threads.store.threadMessageIds(root.thread_id).at(-1) ?? root.id;
      threads.store.sendMessage({
        project_id: root.project_id,
        author: { kind: "agent", host: PI, session: p.session, name: PI_NAME },
        body: note,
        reply_to: latest,
        idempotency_key: `pi-dialog-${p.launchId}-${String(event.id)}`,
      });
      threads.onChange();
    } catch (error) {
      ctx.log(`Inbox launch ${p.launchId}: the dialog note was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const onLine = (p: PiProcess, line: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type === "response" && typeof event.id === "string") {
      const waiter = p.waiters.get(event.id);
      if (waiter) {
        p.waiters.delete(event.id);
        waiter(event);
      }
      return;
    }
    if (event.type === "agent_start") p.busy = true;
    else if (event.type === "agent_settled" || (event.type === "agent_end" && event.willRetry !== true)) p.busy = false;
    else if (event.type === "extension_ui_request" && DIALOGS.has(String(event.method))) dialog(p, event);
  };

  /** One Pi process for `session` in the launch's folder; resolves once it answered (or could not). */
  const spawnPi = async (
    launch: InboxLaunchRecord,
    session: string,
    name: string,
    login: Readonly<LaunchEnv>,
  ): Promise<{ ok: true } | { ok: false; missing: boolean; text: string; output: string }> => {
    const env = piSpawnEnv(login.PATH ? login : (await ctx.environment()).env as LaunchEnv, isDefaultDataDir() ? null : ctx.dataDir);
    const path = createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env }).which("pi") ?? (await ctx.environment()).which("pi");
    if (!path) return { ok: false, missing: true, text: "pi is not on the login PATH.", output: "pi not found" };
    const argv = piArgv(path, session, name);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { cwd: launch.folder, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, missing: false, text: `Pi did not start: ${text}`, output: text };
    }
    const p: PiProcess = { launchId: launch.id, session, proc, exited: false, exitCode: null, busy: false, waiters: new Map(), stderr: "", ended: null as never };
    p.ended = proc.exited.then((code) => {
      p.exited = true;
      p.exitCode = code;
      p.busy = false;
      ctx.startLog(launch.id, `pi ${session}: exited ${code}${p.stderr.trim() ? `\n[stderr]\n${p.stderr.trim().slice(-2000)}` : ""}`);
      threads?.onChange();
      return code;
    });
    procs.set(session, p);
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          // Strict JSONL: LF only (U+2028 is valid inside a JSON string).
          for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            const line = buffer.slice(0, at).replace(/\r$/, "");
            buffer = buffer.slice(at + 1);
            if (line.trim()) onLine(p, line);
          }
        }
      } catch {
        // The pipe closed with the process.
      }
    })();
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) p.stderr = `${p.stderr}${decoder.decode(chunk, { stream: true })}`.slice(-8000);
      } catch {
        // Closed.
      }
    })();
    const state = await request(p, { type: "get_state" }, READY_MS);
    const data = state?.data as { sessionId?: unknown; sessionFile?: unknown } | undefined;
    if (state?.success === true && data?.sessionId === session) {
      ctx.startLog(launch.id, `pi ${argv.slice(1).join(" ")}\nready: session ${session}${typeof data.sessionFile === "string" ? `, ${data.sessionFile}` : ""}`);
      return { ok: true };
    }
    // Never leave a process running that did not come up as the session asked for.
    if (!p.exited) {
      try {
        (p.proc.stdin as { end(): void }).end();
      } catch {}
      p.proc.kill("SIGTERM");
    }
    await Promise.race([p.ended, Bun.sleep(2_000)]);
    const why = p.stderr.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200) ?? (state ? String(state.error ?? "it answered something else") : "it did not answer");
    return { ok: false, missing: false, text: `Pi did not start: ${why}`, output: `pi ${argv.slice(1).join(" ")}\n${p.stderr.trim().slice(-2000)}` };
  };

  /** End a process: abort its turn, close its stdin (Pi then shuts down), and signal it only if it lingers. */
  const end = async (p: PiProcess): Promise<number | null> => {
    if (p.exited) return p.exitCode;
    await request(p, { type: "abort" }, 2_000);
    try {
      (p.proc.stdin as { end(): void }).end();
    } catch {}
    const code = await Promise.race([p.ended, Bun.sleep(STOP_MS).then(() => null)]);
    if (code !== null) return code;
    p.proc.kill("SIGTERM");
    return Promise.race([p.ended, Bun.sleep(2_000).then(() => {
      p.proc.kill("SIGKILL");
      return null;
    })]);
  };

  const close = () => {
    for (const p of procs.values()) {
      if (p.exited) continue;
      try {
        (p.proc.stdin as { end(): void }).end();
      } catch {}
      const timer = setTimeout(() => {
        if (!p.exited) p.proc.kill("SIGTERM");
      }, 2_000);
      (timer as { unref?: () => void }).unref?.();
    }
  };

  const nameOf = (launch: InboxLaunchRecord) => {
    const root = threads?.rootOf(launch.id);
    return root?.thread_name ?? root?.subject ?? "Inbox";
  };

  return {
    agent: PI,
    name: PI_NAME,
    // Of a login-shell read: where Pi keeps its settings and sessions.
    shellNames: ["PI_CODING_AGENT_DIR"],
    loginOnResume: true,
    stoppedNote: PI_STOPPED_NOTE,

    /** `pi` on the plain env's PATH, new enough, and Pi's settings load Plannotator's Pi extension (it is what connects the session). */
    async available(): Promise<LaunchAvailability> {
      const e = await ctx.environment();
      const path = e.which("pi");
      if (!path) return { ok: false, missing: true, reason: "pi is not on the Inbox's PATH" };
      const version = parsePiVersion((await agentVersionRun(e, path, { timeoutMs: 10_000 })).stdout);
      if (!version || !versionAtLeast(version, PI_LAUNCH_MIN_VERSION)) return { ok: false, missing: false, reason: `Pi ${version ?? "?"} is older than ${PI_LAUNCH_MIN_VERSION}` };
      if (!piExtensionListed(settingsText())) return { ok: false, missing: false, reason: "Plannotator's Pi extension is not installed (pi install npm:@plannotator/pi-extension)" };
      return { ok: true, version };
    },

    /** Pi has no permission modes: nothing to fix on the record. */
    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    /** Pi never refuses a folder: in RPC mode its project trust only decides which project resources load. */
    trusts: () => true,

    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
      const session = randomUUID();
      const result = await spawnPi(launch, session, input.name, input.login);
      if (!result.ok) {
        ctx.startLog(launch.id, result.output);
        return { ok: false as const, code: result.missing ? ("missing" as const) : ("failed" as const), text: result.text };
      }
      return { ok: true as const, session, ref: session };
    },

    /** What this Inbox's processes say: running (busy or idle), stopped once one ended, absent when none ran here. */
    async sessions() {
      return (ref: string) => {
        const p = procs.get(ref);
        if (!p) return "absent" as const;
        return p.exited ? { status: null, state: "stopped", waitingFor: null } : { status: p.busy ? "busy" : "idle", state: "running", waitingFor: null };
      };
    },

    /** The extension's bridge poll (as any Pi session's): a Pi opened in Terminal on the session counts too. */
    live: (session: string) => ctx.bridge.runStateOf(session),

    /** A new process on the same `--session-id`: Pi reopens the session file, and the waiting reply is delivered. */
    async resume(launch: InboxLaunchRecord, input?: { login: LaunchEnv }): Promise<LaunchHostResult & { failure: { code: "untrusted" | "failed"; text: string } | null }> {
      const session = launch.session_ref!;
      if (running(session)) return { exitCode: 0, text: "already running here", failure: null };
      const until = handedOff.get(session);
      if (until !== undefined && Date.now() < until) return { exitCode: 0, text: "opened in Terminal: the reply goes to that Pi; nothing started here", failure: null };
      const result = await spawnPi(launch, session, nameOf(launch), input?.login ?? {});
      if (result.ok) return { exitCode: 0, text: `pi --session-id ${session}: ready`, failure: null };
      return { exitCode: 1, text: result.output, failure: { code: "failed", text: result.text } };
    },

    async stop(ref: string): Promise<LaunchHostResult> {
      const p = running(ref);
      if (!p) return { exitCode: 0, text: "not running in this Inbox" };
      const code = await end(p);
      return { exitCode: code ?? 1, text: code === null ? "did not end; killed" : `ended ${code}` };
    },
    /** Pi keeps no list of sessions: nothing to remove (its session file stays, as a transcript does). */
    remove: async (): Promise<LaunchHostResult> => ({ exitCode: 0, text: "Pi keeps no session list" }),
    /**
     * Delete of a scratch folder: the Pi session files whose header names that folder exactly, in Pi's default
     * sessions folder for it, and that folder once empty. Nothing else, never through a link.
     */
    async purge(folder: string): Promise<LaunchHostResult & { skipped?: string }> {
      const dir = piSessionDirOf(agentDir(), folder);
      try {
        if (!lstatSync(dir).isDirectory()) return { exitCode: 0, text: "", skipped: "its sessions folder is not a folder" };
      } catch {
        return { exitCode: 0, text: "", skipped: "no Pi sessions folder for it" };
      }
      const removed: string[] = [];
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (!name.endsWith(".jsonl") || !lstatSync(file).isFile() || piSessionCwd(file) !== resolve(folder)) continue;
        rmSync(file, { force: true });
        removed.push(name);
      }
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir);
      } catch {}
      return { exitCode: 0, text: `removed ${removed.length} Pi session file(s)` };
    },

    /** Only while no process of the Inbox's runs the session: two processes must never write one session file. */
    attach: (launch: InboxLaunchRecord) => (launch.session_ref && !running(launch.session_ref) ? piAttachCommand(launch.folder, launch.session_ref) : null),
    /** Open in Terminal: hand the session over. The Inbox's process ends now, and the command waits for it first. */
    terminal(launch: InboxLaunchRecord): string {
      if (!launch.session_ref) return `cd ${shellQuote(launch.folder)} && pi`;
      const p = running(launch.session_ref);
      if (!p) return piAttachCommand(launch.folder, launch.session_ref);
      handedOff.set(launch.session_ref, Date.now() + HANDOFF_MS);
      void end(p);
      return piHandoffCommand(launch.folder, launch.session_ref, p.proc.pid);
    },

    /** No prompts to carry: the context is kept for the dialog note. */
    permissions(context: LaunchPermissionContext) {
      threads = context;
      return { sweep() {}, withdrawAll() {} };
    },

    dispose: close,
    close,
  } satisfies LaunchHost & { close(): void };
}
