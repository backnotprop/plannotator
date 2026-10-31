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
 * so it answers `cancelled` at once (the extension gets what a dismissed
 * dialog gives it) and says so in the thread: one note from the session, "Pi
 * asked something the Inbox can't show yet (“<title>”); answered Cancel."
 *
 * One writer per session file, always. Open in Terminal hands the session
 * over: once the terminal shows, the Inbox's process ends (its turn aborted);
 * the Terminal command waits for it and runs Pi with the Inbox tool on (so it
 * takes the replies through the bridge); no process starts here, no second
 * terminal opens on it and no attach command is offered until the bridge saw
 * the Terminal's Pi and then lost it (or, when it never came, a minute after)
 * and no process runs the session any more. A restart under way is marked:
 * Stop, Delete and Open in Terminal cancel it, before its spawn or right after
 * it came up. And nothing starts while any other process's command line runs
 * the session (`--session-id <uuid>`), which holds across an Inbox restart.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { getDefaultPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { agentVersionRun, createAgentEnvironmentFor } from "./inbox-agents";
import { shellQuote, versionAtLeast } from "./inbox-launch-claude";
import { launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchHost, LaunchHostContext, LaunchHostResult, LaunchLive, LaunchPermissionContext } from "./inbox-launch-host";

export const PI = "pi" as const;
export const PI_NAME = "Pi";
/** The Plannotator Pi extension's floor (its peer dependency); `--session-id` came in 0.76. */
export const PI_LAUNCH_MIN_VERSION = "0.79.1";
/** The stopped line's words (`stoppedNote`) when this Inbox never ran the session (it was restarted): said plainly, as it is. */
export const PI_STOPPED_NOTE = "A Pi session runs only while the Inbox runs. Your reply continues it.";
/** The stopped line's words while Open in Terminal's hand-off holds. */
export const PI_HANDOFF_NOTE = "It is open in Terminal: that Pi takes your replies while it runs.";
/** The stopped line's words once the Terminal's Pi quit (or never came). */
export const PI_HANDED_BACK_NOTE = "It was opened in Terminal and is not running there now. Your reply continues it here.";
/** How long a new process may take to answer its first RPC command. */
const READY_MS = 30_000;
/** How long Stop waits for the process to end after its stdin closed, before it signals it. */
const STOP_MS = 5_000;
/**
 * After Open in Terminal, until the bridge sees the Terminal's Pi: how long a reply still starts nothing here.
 * Once it was seen, the hand-off lasts until it is gone, however long that is.
 */
const HANDOFF_MS = 60_000;
/** After Open in Terminal: how long the Inbox's Pi waits for the terminal to show before it keeps the session after all. */
const TERMINAL_OPEN_MS = 30_000;
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
  // The npm package, or a checkout or URL of Plannotator's pi-extension; not any name with "plannotator" in it.
  return names.some((name) => /@plannotator\/pi-extension/i.test(name) || (/plannotator/i.test(name) && /pi-extension/i.test(name)));
}

/** The argv of one Pi process for a session: RPC mode, its exact session id (made when missing), its name (Pi takes the next argument as it is). */
export function piArgv(pi: string, session: string, name: string): string[] {
  return [pi, "--mode", "rpc", "--session-id", session, "--name", name.trim() || "Inbox"];
}

/** The process's env: the login env through the launch filter, the Inbox tool on, and this Inbox's data dir when not the default. */
export function piSpawnEnv(login: Readonly<LaunchEnv>, dataDir: string | null): LaunchEnv {
  return { ...launchSpawnEnv(login), PLANNOTATOR_INBOX_TOOL: "1", ...(dataDir ? { PLANNOTATOR_DATA_DIR: dataDir } : {}) };
}

/**
 * Pi in a terminal on the session: the Inbox tool on (so the Terminal's Pi takes the replies through this
 * Inbox's bridge, and the Inbox sees it live), this Inbox's data dir when not the default, and the exact
 * session id (`--session-id` opens the session's file, or starts the session when Pi has written none yet).
 */
function piTerminalRun(session: string, dataDir: string | null): string {
  return `PLANNOTATOR_INBOX_TOOL=1 ${dataDir ? `PLANNOTATOR_DATA_DIR=${shellQuote(dataDir)} ` : ""}pi --session-id ${shellQuote(session)}`;
}

/**
 * Through `/bin/sh -c`, so it reads the same in whatever shell the person's terminal runs (fish has no
 * `while …; do …; done`, nor `NAME=value cmd` before 3.1). The shell's own argv then names the session too,
 * so the Inbox sees the terminal take it (`--session-id <uuid>`) before Pi itself is up.
 */
function shNeutral(command: string): string {
  return `/bin/sh -c ${shellQuote(command)}`;
}

/** What Copy attach command copies: the session, opened in Pi in its folder. */
export function piAttachCommand(folder: string, session: string, dataDir: string | null = null): string {
  return shNeutral(`cd ${shellQuote(folder)} && ${piTerminalRun(session, dataDir)}`);
}

/** Open in Terminal while the Inbox's process `pid` runs: wait for it to end first, so one process writes the session. */
export function piHandoffCommand(folder: string, session: string, pid: number, dataDir: string | null = null): string {
  // `|| exit 1`: no folder, no Pi (never one in the shell's own folder, before the Inbox's has ended).
  return shNeutral(`cd ${shellQuote(folder)} || exit 1; while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done; ${piTerminalRun(session, dataDir)}`);
}

/**
 * Every process whose command line runs the Pi session `session` (`--session-id <uuid>`), from one
 * `ps -A -o pid=,ppid=,command=` listing; never one of `exclude` or a process under one (a `pi` wrapper
 * that does not exec, as Volta's shim, runs Pi as its child).
 */
export function piSessionProcesses(listing: string, session: string, exclude: Iterable<number> = []): { pid: number; rpc: boolean }[] {
  const rows: { pid: number; command: string }[] = [];
  const parent = new Map<number, number>();
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    parent.set(Number(match[1]), Number(match[2]));
    rows.push({ pid: Number(match[1]), command: match[3]! });
  }
  const skip = new Set(exclude);
  const under = (pid: number) => {
    for (let at: number | undefined = pid, hops = 0; at !== undefined && at > 1 && hops < 64; at = parent.get(at), hops++) if (skip.has(at)) return true;
    return false;
  };
  const found: { pid: number; rpc: boolean }[] = [];
  for (const { pid, command } of rows) {
    // Quoted (a terminal's `sh -c`) or not (Pi's own argv), and never a longer id that starts the same.
    if (under(pid) || !new RegExp(`--session-id\\s+'?${session}(?![0-9a-f-])`, "i").test(command)) continue;
    found.push({ pid, rpc: /--mode\s+rpc\b/.test(command) });
  }
  return found;
}

/**
 * A dialog's title as the thread note quotes it: one line, every control or invisible character dropped,
 * Markdown's marks escaped, at most 80 characters.
 */
export function piDialogTitle(title: unknown): string {
  const flat = String(typeof title === "string" ? title : "")
    // Controls, bidi and other invisible format characters go; the zero-width joiner stays (it holds an emoji together).
    .replace(/(?:(?!‍)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}])+/gu, " ")
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

/** Why the Inbox ended a process (null on the process: it ended on its own). */
type PiEnding = "stop" | "handoff" | "restart" | "close";

interface PiProcess {
  launchId: string;
  session: string;
  proc: ReturnType<typeof Bun.spawn>;
  exited: boolean;
  exitCode: number | null;
  busy: boolean;
  ending: PiEnding | null;
  waiters: Map<string, (event: Record<string, unknown>) => void>;
  stderr: string;
  ended: Promise<number>;
  /** The session's bridge poll count once it ended: a later poll is another Pi's (the bridge keeps this one live for 30 s). */
  pollsAtExit: number | null;
}

/** A restart under way (`resume`): what cancelled it, if anything, and when it is over. */
interface PiSpawning {
  cancel: "stop" | "handoff" | null;
  done: Promise<void>;
}

/**
 * Open in Terminal's hand-off of a session: the Inbox's process the Terminal waits for (`pid`), the bridge's
 * poll count once that process was gone (`baseline`, null until then), and whether the Terminal's Pi polled since.
 */
interface PiHandoff {
  pid: number | null;
  since: number;
  baseline: number | null;
  sawLive: boolean;
}

/** `launch/<id>/pi-session.json`: the session file Pi named, and whether it was on disk when its last process ended. */
interface PiSessionRecord {
  file: string;
  written: boolean;
}

/**
 * Every process's pid, parent and whole command line (`ps -A -ww -o pid=,ppid=,command=`, the same on
 * macOS and Linux); null when ps could not run (then no one can tell what runs a session).
 */
function processListing(ps: string): string | null {
  try {
    const run = Bun.spawnSync([ps, "-A", "-ww", "-o", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
    return run.exitCode === 0 ? run.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** How long one process listing answers for every session (it runs only when a session is in question). */
const LISTING_MS = 1_500;

/** Pi as a `LaunchHost`; `close` ends every process it owns. The options are for tests. */
export function createPiLaunchHost(ctx: LaunchHostContext, options: { handoffMs?: number; terminalOpenMs?: number; ps?: string } = {}) {
  const handoffMs = options.handoffMs ?? HANDOFF_MS;
  const terminalOpenMs = options.terminalOpenMs ?? TERMINAL_OPEN_MS;
  const ps = options.ps ?? (existsSync("/bin/ps") ? "/bin/ps" : "ps");
  /** Pi's own folder (`PI_CODING_AGENT_DIR` from the login shell or the Inbox, else `~/.pi/agent`). */
  const agentDir = () => ctx.shell()?.PI_CODING_AGENT_DIR ?? ctx.ownEnv().PI_CODING_AGENT_DIR ?? join(ctx.homeDir, ".pi", "agent");
  const settingsText = () => {
    try {
      return readFileSync(join(agentDir(), "settings.json"), "utf8");
    } catch {
      return null;
    }
  };
  /** This Inbox's data dir for a Pi it starts or a terminal runs; null when it is the default (Pi finds it alone). */
  const dataDirArg = () => (resolve(ctx.dataDir) === resolve(getDefaultPlannotatorDataDir(ctx.homeDir)) ? null : ctx.dataDir);

  /** The running (or last) process of each session, by session id. */
  const procs = new Map<string, PiProcess>();
  /** Restarts under way, by session id. */
  const spawning = new Map<string, PiSpawning>();
  /** Open in Terminal's hand-offs that still hold, by session id. */
  const handoffs = new Map<string, PiHandoff>();
  /** Sessions whose hand-off is over, with no process here since (the stopped line's cause). */
  const handedBack = new Set<string>();
  /** The engine's permission context, for the thread notes (set once by `permissions`). */
  let threads: LaunchPermissionContext | null = null;
  let rpcIds = 0;

  const running = (session: string): PiProcess | null => {
    const p = procs.get(session);
    return p && !p.exited ? p : null;
  };
  const recordFile = (launchId: string) => join(ctx.launchDir(launchId), "pi-session.json");
  const readRecord = (launchId: string): PiSessionRecord | null => {
    try {
      const record = JSON.parse(readFileSync(recordFile(launchId), "utf8")) as { file?: unknown; written?: unknown };
      return typeof record.file === "string" ? { file: record.file, written: record.written === true } : null;
    } catch {
      return null;
    }
  };
  /** Only into a launch folder that is still there (a Delete removes it). */
  const writeRecord = (launchId: string, record: PiSessionRecord) => {
    try {
      if (existsSync(ctx.launchDir(launchId))) writeFileSync(recordFile(launchId), JSON.stringify(record));
    } catch {}
  };
  /** Whether Pi has written the session file by now (a process ended, or the Inbox stops). */
  const noteWritten = (launchId: string) => {
    const record = readRecord(launchId);
    if (record && !record.written && existsSync(record.file)) writeRecord(launchId, { ...record, written: true });
  };

  /** The last process listing, shared by every session for `LISTING_MS`. */
  let listing: { at: number; text: string | null } | null = null;
  let psFailLogged = false;
  const list = () => {
    listing = { at: Date.now(), text: processListing(ps) };
    if (listing.text === null && !psFailLogged) {
      psFailLogged = true;
      ctx.log(`Inbox launch: ${ps} -A -ww -o pid=,ppid=,command= did not run; no Pi restarts while it cannot`);
    }
    return listing.text;
  };
  /**
   * The processes that run `session` and are not this Inbox's own Pi or under it: a terminal's Pi (or the
   * shell about to run it), or an RPC Pi an earlier Inbox could not end. `fresh`: list again now. null: ps
   * could not run, so any process may hold the session.
   */
  const othersOn = (session: string, fresh = false): { pid: number; rpc: boolean }[] | null => {
    const text = fresh || !listing || Date.now() - listing.at > LISTING_MS ? list() : listing.text;
    if (text === null) return null;
    const own = [...procs.values()].filter((p) => !p.exited).map((p) => p.proc.pid);
    return piSessionProcesses(text, session, own).filter((found) => found.pid !== process.pid);
  };
  /**
   * Sessions this Inbox found held by a process of no hand-off of its own (a Terminal's Pi the Inbox
   * knew before it was started again, a Pi started by hand): it starts nothing beside them while they run.
   */
  const elsewhere = new Set<string>();
  /** The first time any session is in question, the Pis that already run (once per Inbox). */
  let looked = false;
  const lookOnce = () => {
    if (looked) return;
    looked = true;
    const text = list() ?? "";
    for (const match of text.matchAll(/--session-id\s+'?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)) elsewhere.add(match[1]!.toLowerCase());
  };
  /** Whether a process of no hand-off of this Inbox's still runs `session` (checked again at most every `LISTING_MS`). */
  const heldElsewhere = (session: string): boolean => {
    lookOnce();
    if (!elsewhere.has(session)) return false;
    const others = othersOn(session);
    if (others === null || others.some((found) => !found.rpc)) return true;
    elsewhere.delete(session);
    return false;
  };

  /**
   * Whether Open in Terminal's hand-off still holds the session, moving it on: it holds while the Inbox's
   * process ends, then until the bridge saw the Terminal's Pi and lost it again (when that Pi never came,
   * until `handoffMs` after the Inbox's process was gone), and in either case while a process still runs the
   * session (a Terminal's Pi that never reached the bridge, or the shell about to start it).
   */
  const handingOff = (session: string): boolean => {
    const h = handoffs.get(session);
    if (!h) return false;
    const old = procs.get(session);
    if (h.pid !== null && old && !old.exited && old.proc.pid === h.pid) return true;
    const live = ctx.bridge.runStateOf(session);
    if (h.baseline === null) {
      h.baseline = live?.polls ?? 0;
      h.since = Date.now();
    } else if (live && live.polls > h.baseline) h.sawLive = true;
    if (h.sawLive ? live : Date.now() - h.since < handoffMs) return true;
    // Unknown (ps could not run): over, and a reply's restart refuses for want of a listing, with a line that says so.
    if ((othersOn(session)?.length ?? 0) > 0) return true;
    handoffs.delete(session);
    handedBack.add(session);
    ctx.log(`Inbox launch: Pi session ${session} is back from Terminal (${h.sawLive ? "its Pi quit" : "its Pi never connected"})`);
    threads?.onChange();
    return false;
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

  /** One note from the session in the launch's thread (a dialog answered Cancel, a session file that is gone). */
  const note = (launchId: string, session: string, body: string, key: string) => {
    const root = threads?.rootOf(launchId);
    if (!threads || !root) return;
    try {
      const latest = threads.store.threadMessageIds(root.thread_id).at(-1) ?? root.id;
      threads.store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: PI, session, name: PI_NAME }, body, reply_to: latest, idempotency_key: key });
      threads.onChange();
    } catch (error) {
      ctx.log(`Inbox launch ${launchId}: a note was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** A dialog no one here can show: Cancel at once, and one note in the launch's thread saying so. */
  const dialog = (p: PiProcess, event: Record<string, unknown>) => {
    send(p, { type: "extension_ui_response", id: event.id, cancelled: true });
    ctx.startLog(p.launchId, `extension dialog ${String(event.method)} answered cancelled: ${String(event.title ?? "").slice(0, 200)}`);
    ctx.log(`Inbox launch ${p.launchId}: a Pi extension dialog (${String(event.method)}) answered Cancel`);
    note(p.launchId, p.session, piDialogNote(event.title), `pi-dialog-${p.launchId}-${String(event.id)}`);
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

  type SpawnResult = { ok: true } | { ok: false; cancelled: boolean; missing: boolean; text: string; output: string };
  /** One Pi process for `session` in the launch's folder; resolves once it answered (or could not). Nothing is spawned once `cancelled()`. */
  const spawnPi = async (launch: InboxLaunchRecord, session: string, name: string, login: Readonly<LaunchEnv>, cancelled: () => boolean): Promise<SpawnResult> => {
    const env = piSpawnEnv(login.PATH ? login : (await ctx.environment()).env as LaunchEnv, dataDirArg());
    const path = createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env }).which("pi") ?? (await ctx.environment()).which("pi");
    if (!path) return { ok: false, cancelled: false, missing: true, text: "pi is not on the login PATH.", output: "pi not found" };
    // The last moment a Stop, Delete or Open in Terminal can keep the process from being made at all.
    if (cancelled()) return { ok: false, cancelled: true, missing: false, text: "", output: "" };
    const argv = piArgv(path, session, name);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { cwd: launch.folder, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, cancelled: false, missing: false, text: `Pi did not start: ${text}`, output: text };
    }
    const p: PiProcess = { launchId: launch.id, session, proc, exited: false, exitCode: null, busy: false, ending: null, waiters: new Map(), stderr: "", ended: null as never, pollsAtExit: null };
    p.ended = proc.exited.then((code) => {
      p.exited = true;
      p.exitCode = code;
      p.busy = false;
      p.pollsAtExit = ctx.bridge.runStateOf(session)?.polls ?? 0;
      noteWritten(launch.id);
      // A hand-off waiting for this process counts the bridge's polls from now: any later one is the Terminal's Pi.
      if (handoffs.get(session)?.pid === proc.pid) handingOff(session);
      // Never into a launch folder a Delete removed meanwhile.
      if (existsSync(ctx.launchDir(launch.id))) {
        ctx.startLog(launch.id, `pi ${session}: exited ${code}${p.ending ? ` (${p.ending})` : ""}${p.stderr.trim() ? `\n[stderr]\n${p.stderr.trim().slice(-2000)}` : ""}`);
      }
      threads?.onChange();
      return code;
    });
    procs.set(session, p);
    handedBack.delete(session);
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
      if (typeof data.sessionFile === "string") writeRecord(launch.id, { file: data.sessionFile, written: existsSync(data.sessionFile) });
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
    return { ok: false, cancelled: false, missing: false, text: `Pi did not start: ${why}`, output: `pi ${argv.slice(1).join(" ")}\n${p.stderr.trim().slice(-2000)}` };
  };

  /** End a process: abort its turn, close its stdin (Pi then shuts down), and signal it only if it lingers. */
  const end = async (p: PiProcess, why: PiEnding): Promise<number | null> => {
    if (p.exited) return p.exitCode;
    p.ending ??= why;
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

  /** The Inbox stops: every process gets abort, then the end of its stdin; a restart under way starts nothing. */
  const close = () => {
    for (const mark of spawning.values()) mark.cancel = "stop";
    for (const p of procs.values()) {
      if (p.exited) continue;
      p.ending ??= "close";
      send(p, { type: "abort", id: `inbox-${++rpcIds}` });
      try {
        (p.proc.stdin as { end(): void }).end();
      } catch {}
      // The next Inbox reads it: a file Pi wrote in this run counts as written.
      noteWritten(p.launchId);
      // Fires only while the Inbox still runs; past its exit, the next Inbox starts nothing beside a Pi that lingers (`othersOn`).
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

  type ResumeResult = LaunchHostResult & { failure: { code: "untrusted" | "failed"; text: string } | null };
  const nothing = (text: string): ResumeResult => ({ exitCode: 0, text, failure: null });
  const say = (words: string) => `echo ${shellQuote(words)}`;

  /**
   * Open in Terminal with the Inbox's process running: it ends only once the terminal shows (its shell names
   * the session), so a Terminal that did not open stops nothing. None within `TERMINAL_OPEN_MS`: the hand-off
   * is withdrawn and the Inbox's Pi keeps the session. With no listing (ps could not run) it ends at once.
   */
  const handOver = async (p: PiProcess, session: string) => {
    const until = Date.now() + terminalOpenMs;
    while (!p.exited && Date.now() < until) {
      if ((othersOn(session, true) ?? [p]).length > 0) {
        await end(p, "handoff");
        return;
      }
      await Bun.sleep(300);
    }
    if (!p.exited && handoffs.get(session)?.pid === p.proc.pid) {
      handoffs.delete(session);
      ctx.log(`Inbox launch ${p.launchId}: no terminal took Pi session ${session}; the Inbox's Pi keeps it`);
      threads?.onChange();
    }
  };

  /** The highest bridge poll count seen per session: a session held elsewhere reads one above it (Stop waits for a higher one). */
  const pollsSeen = new Map<string, number>();

  return {
    agent: PI,
    name: PI_NAME,
    // Of a login-shell read: where Pi keeps its settings and sessions.
    shellNames: ["PI_CODING_AGENT_DIR"],

    /** `pi` on the plain env's PATH, new enough, and Pi's settings load Plannotator's Pi extension (it is what connects the session). */
    async available(): Promise<LaunchAvailability> {
      const e = await ctx.environment();
      const path = e.which("pi");
      if (!path) return { ok: false, missing: true, reason: "pi is not on the Inbox's PATH" };
      // The file read first: no Pi start at all while the extension is not there.
      if (!piExtensionListed(settingsText())) return { ok: false, missing: false, reason: "Plannotator's Pi extension is not installed (pi install npm:@plannotator/pi-extension)" };
      const version = parsePiVersion((await agentVersionRun(e, path, { timeoutMs: 10_000 })).stdout);
      if (!version || !versionAtLeast(version, PI_LAUNCH_MIN_VERSION)) return { ok: false, missing: false, reason: `Pi ${version ?? "?"} is older than ${PI_LAUNCH_MIN_VERSION}` };
      return { ok: true, version };
    },

    /** Pi has no permission modes: nothing to fix on the record. */
    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    /** Pi never refuses a folder: in RPC mode its project trust only decides which project resources load. */
    trusts: () => true,

    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
      const session = randomUUID();
      const result = await spawnPi(launch, session, input.name, input.login, () => false);
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

    /**
     * The extension's bridge poll (as any Pi session's): the Terminal's Pi counts too. While the session is
     * open in a terminal and that Pi is not on the bridge (yet, or again after an Inbox restart), it reads as
     * held: the reply waits for that Pi, and the engine starts nothing beside it.
     */
    live(session: string): LaunchLive | null {
      const real = ctx.bridge.runStateOf(session);
      if (real) {
        pollsSeen.set(session, Math.max(pollsSeen.get(session) ?? 0, real.polls));
        return real;
      }
      if (handingOff(session) || heldElsewhere(session)) return { busy: null, busySince: null, polls: (pollsSeen.get(session) ?? 0) + 1 };
      return null;
    },

    /**
     * A new process on the same `--session-id`: Pi reopens the session file, and the waiting reply is delivered.
     * Nothing starts while one runs and is connected, while Open in Terminal's hand-off holds, or once a Stop,
     * Delete or Open in Terminal came during the restart; a process that runs but never connected is ended first.
     */
    async resume(launch: InboxLaunchRecord): Promise<ResumeResult> {
      const session = launch.session_ref!;
      if (spawning.has(session)) return nothing("starting already");
      if (handingOff(session) || heldElsewhere(session)) return nothing("open in a terminal: that Pi takes the reply; nothing started here");
      const old = running(session);
      if (old && ctx.bridge.runStateOf(session)) return nothing("already running here");
      // Marked before the first await: a Stop, Delete or Open in Terminal from now on cancels this restart.
      let finish!: () => void;
      const mark: PiSpawning = { cancel: null, done: new Promise<void>((done) => (finish = done)) };
      spawning.set(session, mark);
      const cancelledText = () => (mark.cancel === "stop" ? "stopped during the restart" : "opened in Terminal during the restart");
      try {
        // Running but never connected (Try again): that one ends, a new one starts.
        if (old) await end(old, "restart");
        const login = await ctx.loginEnv().catch((): LaunchEnv => ({}));
        if (mark.cancel) return nothing(`${cancelledText()}: nothing started`);
        // Never a second writer: any other process on this session (a terminal's Pi, or the shell about to start
        // it; an RPC Pi an earlier Inbox could not end) keeps this restart off.
        const others = othersOn(session, true);
        if (others === null) {
          ctx.startLog(launch.id, `pi ${session}: ${ps} -A -ww -o pid=,ppid=,command= did not run, so no one can tell whether another Pi runs this session; nothing started`);
          return { exitCode: 1, text: `${ps} did not run`, failure: { code: "failed", text: "The Inbox could not list processes (ps), so it cannot tell whether another Pi runs this session. Pi did not start again." } };
        }
        const terminal = others.find((found) => !found.rpc);
        if (terminal) {
          elsewhere.add(session);
          ctx.log(`Inbox launch ${launch.id}: pid ${terminal.pid} runs Pi session ${session} in a terminal; nothing started`);
          return nothing(`pid ${terminal.pid} runs this session in a terminal: the reply waits for that Pi; nothing started`);
        }
        if (others.length > 0) {
          const pid = others[0]!.pid;
          ctx.log(`Inbox launch ${launch.id}: pid ${pid} still runs Pi session ${session}; not started again`);
          return { exitCode: 1, text: `pid ${pid} still runs pi --mode rpc --session-id ${session}`, failure: { code: "failed", text: `A Pi process from before (pid ${pid}) still runs this session, so it did not start again.` } };
        }
        const record = readRecord(launch.id);
        const gone = record?.written === true && !existsSync(record.file);
        const result = await spawnPi(launch, session, nameOf(launch), login, () => mark.cancel !== null);
        if (mark.cancel) {
          const p = running(session);
          if (p) await end(p, mark.cancel);
          return nothing(`${cancelledText()}: ${p ? "ended as it came up" : "nothing started"}`);
        }
        if (!result.ok) return { exitCode: 1, text: result.output, failure: { code: "failed", text: result.text } };
        if (gone) {
          ctx.startLog(launch.id, `pi ${session}: its session file ${record!.file} is gone; Pi started the session again empty`);
          note(launch.id, session, `Pi's session file for this thread is gone (${ctx.displayFolder(record!.file)}), so Pi continues with no memory of what came before.`, `pi-gone-${launch.id}-${Date.now()}`);
        }
        return nothing(`pi --session-id ${session}: ready`);
      } finally {
        spawning.delete(session);
        finish();
      }
    },

    /** The process ends (abort, then its stdin); a restart under way is cancelled and waited for. */
    async stop(ref: string): Promise<LaunchHostResult> {
      const mark = spawning.get(ref);
      if (mark) mark.cancel = "stop";
      const p = running(ref);
      const code = p ? await end(p, "stop") : null;
      if (mark) {
        await mark.done;
        return { exitCode: 0, text: "stopped during a restart: nothing left running" };
      }
      if (!p) return { exitCode: 0, text: "not running in this Inbox" };
      return { exitCode: code ?? 1, text: code === null ? "did not end; killed" : `ended ${code}` };
    },
    /** Pi keeps no list of sessions: nothing to remove (its session file stays, as a transcript does). */
    remove: async (): Promise<LaunchHostResult> => ({ exitCode: 0, text: "Pi keeps no session list" }),
    /**
     * Delete of a scratch folder: the Pi session files whose header names that folder exactly, in Pi's default
     * sessions folder for it, and that folder once empty. Nothing else, never through a link.
     */
    async purge(folder: string): Promise<LaunchHostResult & { skipped?: string }> {
      // Pi names the folder as resolved; one reached through a link may be named either way.
      const names = new Set([resolve(folder)]);
      try {
        names.add(realpathSync(folder));
      } catch {}
      const removed: string[] = [];
      let dirs = 0;
      for (const cwd of names) {
        const dir = piSessionDirOf(agentDir(), cwd);
        try {
          if (!lstatSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        dirs += 1;
        for (const name of readdirSync(dir)) {
          const file = join(dir, name);
          const header = name.endsWith(".jsonl") && lstatSync(file).isFile() ? piSessionCwd(file) : null;
          if (!header || !names.has(header)) continue;
          rmSync(file, { force: true });
          removed.push(name);
        }
        try {
          if (readdirSync(dir).length === 0) rmdirSync(dir);
        } catch {}
      }
      if (dirs === 0) return { exitCode: 0, text: "", skipped: "no Pi sessions folder for it" };
      return { exitCode: 0, text: `removed ${removed.length} Pi session file(s)` };
    },

    /**
     * Only while nothing else has the session: no process of the Inbox's, no restart, no hand-off, no
     * terminal's Pi on it, and no Pi on the bridge as it (one the person started from this command: a poll
     * after the Inbox's own process ended).
     */
    attach(launch: InboxLaunchRecord): string | null {
      const session = launch.session_ref;
      if (!session || running(session) || spawning.has(session) || handingOff(session) || heldElsewhere(session)) return null;
      const live = ctx.bridge.runStateOf(session);
      if (live && live.polls > (procs.get(session)?.pollsAtExit ?? -1)) return null;
      return piAttachCommand(launch.folder, session, dataDirArg());
    },
    /**
     * Open in Terminal: hand the session over. The Inbox's process ends once the terminal shows (its turn
     * aborted), and the command waits for it; a restart under way is cancelled; nothing starts here until the
     * hand-off is over. While a hand-off holds, or another process runs the session, only words.
     */
    terminal(launch: InboxLaunchRecord): string {
      if (!launch.session_ref) return shNeutral(`cd ${shellQuote(launch.folder)} && pi`);
      const session = launch.session_ref;
      // Never a second Pi on the session: the first terminal's may still be starting.
      if (handingOff(session)) {
        return say(handoffs.get(session)?.sawLive ? "This Pi session is open in another terminal. Quit Pi there first." : "This Pi session is opening in another terminal. If you closed it, try again in a minute.");
      }
      if ((othersOn(session, true)?.length ?? 0) > 0) return say("This Pi session is open in another process. Quit Pi there first.");
      const mark = spawning.get(session);
      if (mark) mark.cancel ??= "handoff";
      const p = running(session);
      handedBack.delete(session);
      handoffs.set(session, { pid: p?.proc.pid ?? null, since: Date.now(), baseline: null, sawLive: false });
      if (!p) {
        handingOff(session);
        return piAttachCommand(launch.folder, session, dataDirArg());
      }
      void handOver(p, session);
      return piHandoffCommand(launch.folder, session, p.proc.pid, dataDirArg());
    },

    /** No prompts to carry: the context is kept for the thread notes; each sweep moves the hand-offs on. */
    permissions(context: LaunchPermissionContext) {
      threads = context;
      return {
        sweep() {
          for (const session of [...handoffs.keys()]) handingOff(session);
        },
        withdrawAll() {},
      };
    },

    /** The words after "Pi stopped." when the person did not press Stop: why this session is not running. */
    stoppedNote(launch: InboxLaunchRecord): string | null {
      const session = launch.session_ref;
      if (!session) return null;
      if (handoffs.has(session)) return PI_HANDOFF_NOTE;
      if (handedBack.has(session)) return PI_HANDED_BACK_NOTE;
      const p = procs.get(session);
      // It ended on its own (a crash, or Pi quit): not the Inbox's doing.
      if (p?.exited && p.ending === null) return `Pi ended on its own (exit ${p.exitCode ?? "unknown"}). Your reply continues it.`;
      return PI_STOPPED_NOTE;
    },

    close,
  } satisfies LaunchHost;
}
