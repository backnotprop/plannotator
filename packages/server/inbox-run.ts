/**
 * Plannotator Inbox: a `:::run` block's command, run when the person presses
 * Run (inbox-run-routes.ts checks who pressed and which bytes).
 *
 * - It runs on this computer, as the person, in the block's folder, with their
 *   login shell's environment and the saved secrets the command names, in its
 *   own process group (Windows: its own tree), stdin held open. The run exists
 *   from the press on: a Stop while it still reads its environment and secrets
 *   ends it before anything starts.
 * - Output: stdout and stderr as they arrive, colour codes stripped, a `\r`
 *   progress line kept at its last state, each secret hidden as `••••` (in the
 *   line still being written too), the last `INBOX_RUN_KEEP_LINES` lines kept.
 *   A line with no end (a binary, a long progress bar) is held to a bounded
 *   head, in time and memory linear in what arrives.
 * - A run that goes quiet on a prompt (a password, a y/n) says it waits for
 *   typing; one that fails asking for a terminal says that too. Neither is
 *   answered here: the card offers the person's own terminal.
 * - Stop ends the whole group (TERM, then KILL); so do the message's
 *   deletion (a sweep while anything runs) and the Inbox's stop or exit. When
 *   the command exits, what it left running in its group is stopped too.
 * - When it ends, its `onEnd` hears it once (the result goes to the agent). An
 *   Inbox that quits ends each run as "the Inbox closed"; one that dies finds
 *   its unfinished runs in the journal on its next start (`recover`).
 */

import { childEnv } from "@plannotator/shared/child-env";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { InboxRunJournal, InboxRunRecord } from "./inbox-run-journal";
import { hideSecretPrefixTail, redactSecrets } from "./inbox-secrets";

/** Lines a run keeps for its card. */
export const INBOX_RUN_KEEP_LINES = 500;
/** The most of one line the card shows; past it, "…". */
export const INBOX_RUN_LINE_MAX = 2_000;
/** What a line with no end may hold before it is cut to its head. */
const PENDING_MAX = INBOX_RUN_LINE_MAX * 2;
/** Quiet this long on a prompt-like last line: it waits for typing. */
export const INBOX_RUN_QUIET_MS = 2_000;
const STOP_GRACE_MS = 2_000;
const CLOSE_GRACE_MS = 500;

export type InboxRunState = "starting" | "running" | "done" | "stopped" | "failed";

export interface InboxRunView {
  key: string;
  run_id: string;
  state: InboxRunState;
  exit_code: number | null;
  signal: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  lines: string[];
  total_lines: number;
  /** The last line so far, not ended with a newline (a prompt, a progress bar). */
  partial: string;
  waiting_for_input: boolean;
  /** It ended asking for a terminal (a sign-in, sudo). */
  needs_terminal: boolean;
  error: string | null;
  /** The Inbox ended while it ran: it quit and stopped it ("closed"), or died and found it after ("lost"). */
  interrupted: "closed" | "lost" | null;
}

/** What a run needs once pressed, read after the press: the program, its env, and the values to hide. */
export interface InboxRunPrepared {
  argv: readonly string[];
  env: Record<string, string>;
  /** Values to hide in output: the secrets it gets, and the login env's tokens. */
  redact: readonly string[];
}

export interface InboxRunStart {
  message_id: string;
  key: string;
  /** The block's title and folder as the card shows them (the journal keeps them for a report after a restart). */
  title: string;
  folder: string;
  cwd: string;
  /** Reads the env and the secrets; throws a sentence the card and the agent read when it cannot start. */
  prepare: () => Promise<InboxRunPrepared>;
  /** Heard once, when it ends, while its message is still there: the result goes to the agent. */
  onEnd: (ended: InboxRunEnded) => void;
}

export interface InboxRunEnded {
  message_id: string;
  view: InboxRunView;
  outcome: "exited" | "stopped" | "failed_to_start" | "inbox_closed";
  /** It was waiting for typing when it ended (a Stop on a password prompt). */
  waited_for_input: boolean;
}

interface Run {
  start: InboxRunStart;
  view: InboxRunView;
  child: ChildProcess | null;
  stopping: boolean;
  lastOutput: number;
  redact: readonly string[];
  out: RunLineBuffer;
  err: RunLineBuffer;
  timers: Set<ReturnType<typeof setTimeout>>;
  ended: boolean;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const PROMPT_END_RE = /[:?>\]\)]\s*$/;
const PROMPT_WORDS_RE = /password|passphrase|\by\/n\b|\[y\/n\]|\(y\/n\)|yes\/no|press (enter|return|any key)|continue\?|verification code|one-time code/i;
const NEEDS_TERMINAL_RE = /not a tty|no tty present|a terminal is required|stdin is not a terminal|inappropriate ioctl for device|must be run (from|in) a terminal|isn't a tty|not a terminal|no tty available|requires an interactive/i;

/** One line as the card shows it: no colour codes, a progress line at its last state, secrets hidden, capped. */
export function cleanRunLine(raw: string, secrets: readonly string[]): string {
  const parts = raw.replace(/\r$/, "").split("\r");
  const last = [...parts].reverse().find((part) => part.replace(ANSI_RE, "").trim() !== "") ?? parts[parts.length - 1] ?? "";
  const line = redactSecrets(last.replace(ANSI_RE, ""), secrets);
  return line.length > INBOX_RUN_LINE_MAX ? `${line.slice(0, INBOX_RUN_LINE_MAX)}…` : line;
}

/** Text from its second-to-last `\r` on: the progress line's last two states (the last may be only a clear). */
const lastStates = (text: string): string => {
  const last = text.lastIndexOf("\r");
  if (last <= 0) return text;
  const before = text.lastIndexOf("\r", last - 1);
  return before === -1 ? text : text.slice(before + 1);
};

/**
 * One stream's text cut into lines. Each piece of text is looked at once: complete lines go out as they end, and
 * the line still being written keeps only its last `\r` states, at most `PENDING_MAX` characters (past that, its
 * head until the line ends or a new `\r` state starts).
 */
export class RunLineBuffer {
  private pending = "";
  private cut = false;

  /** The complete lines in `text`, in order. */
  push(text: string): string[] {
    const lines: string[] = [];
    let from = 0;
    for (let nl = text.indexOf("\n", from); nl !== -1; nl = text.indexOf("\n", from)) {
      lines.push(this.cut ? this.pending : lastStates(this.pending + text.slice(from, nl)));
      this.pending = "";
      this.cut = false;
      from = nl + 1;
    }
    const rest = from === 0 ? text : text.slice(from);
    if (this.cut) {
      const cr = rest.lastIndexOf("\r");
      if (cr !== -1 && cr < rest.length - 1) {
        this.pending = rest.slice(cr + 1);
        this.cut = false;
      }
    } else {
      this.pending = lastStates(this.pending + rest);
    }
    if (!this.cut && this.pending.length > PENDING_MAX) {
      this.pending = this.pending.slice(0, INBOX_RUN_LINE_MAX + 1);
      this.cut = true;
    }
    return lines;
  }

  /** The line still being written. */
  get partial(): string {
    return this.pending;
  }

  /** Ends the stream: its last line, when it had one. */
  end(): string[] {
    const last = this.pending;
    this.pending = "";
    this.cut = false;
    return last === "" ? [] : [last];
  }
}

/** Stops a process group (POSIX) or tree (Windows); quiet when it is already gone. Never blocks the Inbox. */
export function killRunTree(pid: number | undefined, signal: "SIGTERM" | "SIGKILL", platform: NodeJS.Platform = process.platform): void {
  if (!pid) return;
  if (platform === "win32") {
    try {
      const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", env: childEnv() });
      child.on("error", () => {});
      child.unref();
    } catch {
      // No taskkill: nothing more to do.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Gone already.
  }
}

const emptyView = (key: string, runId: string, startedAt: string): InboxRunView => ({
  key,
  run_id: runId,
  state: "starting",
  exit_code: null,
  signal: null,
  started_at: startedAt,
  ended_at: null,
  duration_ms: 0,
  lines: [],
  total_lines: 0,
  partial: "",
  waiting_for_input: false,
  needs_terminal: false,
  error: null,
  interrupted: null,
});

export function createInboxRuns(options: {
  messageAlive: (messageId: string) => boolean;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Quiet this long on a prompt: it waits for typing. Tests shorten it. */
  quietMs?: number;
  /** How often the sweep looks (deleted messages, waiting for typing). */
  sweepMs?: number;
  journal?: InboxRunJournal;
}) {
  const now = options.now ?? (() => Date.now());
  const platform = options.platform ?? process.platform;
  const quietMs = options.quietMs ?? INBOX_RUN_QUIET_MS;
  const runs = new Map<string, Run>();
  const id = (messageId: string, key: string) => `${messageId}/${key}`;
  let sweep: ReturnType<typeof setInterval> | null = null;

  // The last run of each block from before this Inbox started; the unfinished ones are the lost.
  const past = new Map<string, InboxRunRecord>();
  for (const record of options.journal?.load() ?? []) {
    if (options.messageAlive(record.message_id)) past.set(id(record.message_id, record.key), record);
  }
  const lost = [...past.values()].filter((record) => record.live);
  for (const record of lost) {
    record.live = false;
    record.view = { ...record.view, state: "stopped", partial: "", waiting_for_input: false, interrupted: "lost" };
  }
  const writeJournal = () => {
    if (!options.journal) return;
    const records = new Map(past);
    for (const run of runs.values()) {
      records.set(id(run.start.message_id, run.start.key), { message_id: run.start.message_id, key: run.start.key, title: run.start.title, folder: run.start.folder, view: { ...run.view, lines: [...run.view.lines] }, live: !run.ended });
    }
    options.journal.save([...records.values()]);
  };
  if (lost.length > 0) writeJournal();

  const live = () => [...runs.values()].filter((run) => !run.ended);
  const killAllNow = () => {
    for (const run of live()) killRunTree(run.child?.pid, "SIGKILL", platform);
  };
  const onExit = () => killAllNow();

  const watch = () => {
    if (sweep) return;
    process.once("exit", onExit);
    sweep = setInterval(() => {
      for (const run of live()) {
        if (!options.messageAlive(run.start.message_id)) {
          // The message went (a thread or project deleted): stop it, and say nothing to anyone.
          run.ended = true;
          killRunTree(run.child?.pid, "SIGKILL", platform);
          for (const timer of run.timers) clearTimeout(timer);
          runs.delete(id(run.start.message_id, run.start.key));
          past.delete(id(run.start.message_id, run.start.key));
          writeJournal();
          continue;
        }
        const quiet = now() - run.lastOutput >= quietMs;
        const partial = run.view.partial.trim();
        const lastLine = run.view.lines[run.view.lines.length - 1] ?? "";
        run.view.waiting_for_input =
          run.view.state === "running" && quiet && ((partial !== "" && (PROMPT_END_RE.test(partial) || PROMPT_WORDS_RE.test(partial))) || (partial === "" && PROMPT_WORDS_RE.test(lastLine)));
      }
      if (live().length === 0) unwatch();
    }, options.sweepMs ?? 500);
    (sweep as { unref?: () => void }).unref?.();
  };
  const unwatch = () => {
    if (sweep) clearInterval(sweep);
    sweep = null;
    process.removeListener("exit", onExit);
  };

  const add = (run: Run, lines: readonly string[]) => {
    for (const line of lines) {
      run.view.lines.push(cleanRunLine(line, run.redact));
      run.view.total_lines += 1;
    }
    if (run.view.lines.length > INBOX_RUN_KEEP_LINES) run.view.lines.splice(0, run.view.lines.length - INBOX_RUN_KEEP_LINES);
  };
  const push = (run: Run, stream: "out" | "err", text: string) => {
    run.lastOutput = now();
    run.view.waiting_for_input = false;
    add(run, run[stream].push(text));
    // The line still being written: a secret's first characters are hidden before its last arrive.
    run.view.partial = hideSecretPrefixTail(cleanRunLine(run.out.partial || run.err.partial, run.redact), run.redact);
  };

  const finish = (run: Run, outcome: InboxRunEnded["outcome"], code: number | null, signal: string | null, error: string | null = null) => {
    if (run.ended) return;
    run.ended = true;
    const waited = run.view.waiting_for_input;
    for (const timer of run.timers) clearTimeout(timer);
    // What it left running in its group goes with it.
    if (outcome !== "failed_to_start") killRunTree(run.child?.pid, "SIGKILL", platform);
    add(run, run.out.end());
    add(run, run.err.end());
    run.view.partial = "";
    const view = run.view;
    view.ended_at = new Date(now()).toISOString();
    view.duration_ms = Math.max(0, now() - Date.parse(view.started_at));
    view.exit_code = code;
    view.signal = signal;
    view.error = error === null ? null : redactSecrets(error, run.redact);
    view.waiting_for_input = false;
    view.interrupted = outcome === "inbox_closed" ? "closed" : null;
    view.state = outcome === "stopped" || outcome === "inbox_closed" ? "stopped" : outcome === "failed_to_start" || code !== 0 ? "failed" : "done";
    view.needs_terminal = view.state === "failed" && view.lines.slice(-20).some((line) => NEEDS_TERMINAL_RE.test(line));
    if (live().length === 0) unwatch();
    writeJournal();
    if (options.messageAlive(run.start.message_id)) run.start.onEnd({ message_id: run.start.message_id, view: { ...view, lines: [...view.lines] }, outcome, waited_for_input: waited });
  };

  const begin = async (run: Run) => {
    let prepared: InboxRunPrepared;
    try {
      prepared = await run.start.prepare();
    } catch (error) {
      if (run.stopping) finish(run, "stopped", null, null);
      else finish(run, "failed_to_start", null, null, error instanceof Error ? error.message : String(error));
      return;
    }
    run.redact = prepared.redact;
    if (run.stopping || run.ended) {
      if (!run.ended) finish(run, "stopped", null, null);
      return;
    }
    let child: ChildProcess;
    try {
      const [file, ...args] = prepared.argv;
      child = spawn(file!, args, { cwd: run.start.cwd, env: prepared.env, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish(run, "failed_to_start", null, null, error instanceof Error ? error.message : String(error));
      return;
    }
    run.child = child;
    run.view.state = "running";
    run.lastOutput = now();
    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    child.stdout?.on("data", (chunk: Buffer) => push(run, "out", decoders.out.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => push(run, "err", decoders.err.write(chunk)));
    child.stdin?.on("error", () => {});
    child.on("error", (error) => finish(run, "failed_to_start", null, null, error.message));
    child.on("exit", (code, signal) => {
      // The output may still be arriving: give the pipes a moment, then end whether or not they closed.
      const end = () => finish(run, run.stopping ? "stopped" : "exited", code, signal);
      const timer = setTimeout(end, CLOSE_GRACE_MS);
      run.timers.add(timer);
      child.once("close", () => {
        clearTimeout(timer);
        end();
      });
    });
  };

  return {
    start(start: InboxRunStart): InboxRunView {
      const existing = runs.get(id(start.message_id, start.key));
      if (existing && !existing.ended) throw Object.assign(new Error("This command is already running."), { code: "run_running" });
      const run: Run = {
        start,
        view: emptyView(start.key, `run_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, new Date(now()).toISOString()),
        child: null,
        stopping: false,
        lastOutput: now(),
        redact: [],
        out: new RunLineBuffer(),
        err: new RunLineBuffer(),
        timers: new Set(),
        ended: false,
      };
      runs.set(id(start.message_id, start.key), run);
      past.delete(id(start.message_id, start.key));
      writeJournal();
      watch();
      void begin(run);
      return run.view;
    },
    /** Stop: TERM to the group, KILL after a grace; before it started, it never starts. False when nothing runs. */
    stop(messageId: string, key: string): boolean {
      const run = runs.get(id(messageId, key));
      if (!run || run.ended) return false;
      run.stopping = true;
      if (!run.child) return true;
      killRunTree(run.child.pid, "SIGTERM", platform);
      const timer = setTimeout(() => killRunTree(run.child?.pid, "SIGKILL", platform), STOP_GRACE_MS);
      (timer as { unref?: () => void }).unref?.();
      run.timers.add(timer);
      return true;
    },
    /** A message's runs, the running and the last finished of each key (from before a restart too), as the card reads them. */
    views(messageId: string): Record<string, InboxRunView> {
      const out: Record<string, InboxRunView> = {};
      for (const record of past.values()) if (record.message_id === messageId) out[record.key] = { ...record.view, lines: [...record.view.lines] };
      for (const run of runs.values()) {
        if (run.start.message_id !== messageId) continue;
        const duration = run.ended ? run.view.duration_ms : Math.max(0, now() - Date.parse(run.view.started_at));
        out[run.start.key] = { ...run.view, duration_ms: duration, lines: [...run.view.lines] };
      }
      return out;
    },
    running(): number {
      return live().length;
    },
    /** The runs this Inbox found unfinished from before it started, each heard once (the agent gets a word). */
    recover(onLost: (record: InboxRunRecord) => void): void {
      for (const record of lost.splice(0)) if (options.messageAlive(record.message_id)) onLost(record);
    },
    /** The Inbox stops: every run's group goes now, and each is reported as the Inbox closing. */
    stopAll(): void {
      for (const run of live()) {
        run.stopping = true;
        finish(run, "inbox_closed", null, null);
      }
      unwatch();
    },
  };
}

export type InboxRuns = ReturnType<typeof createInboxRuns>;
