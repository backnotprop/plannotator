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
import { INBOX_RUN_JOURNAL_LINES, type InboxRunJournal, type InboxRunRecord } from "./inbox-run-journal";
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
/** How often a running command's output is written to the journal (only when it printed something). */
const JOURNAL_EVERY_MS = 2_000;
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
  /** A lost run's command, checked when the Inbox started again: still running (Stop can end it), ended, or unknown. */
  left_running: boolean | null;
}

/** What a run needs once pressed, read after the press: the program, its env, and the values to hide. */
export interface InboxRunPrepared {
  argv: readonly string[];
  env: Record<string, string>;
  /** Values to hide in output: the secrets it gets, and the login env's tokens. */
  redact: readonly string[];
  /**
   * Its stdin is closed at once (PowerShell, spawned with a pipe, waits for its input to close before it exits), so
   * it cannot wait for typing and is not watched for a prompt.
   */
  closeStdin?: boolean;
}

/** Words for a command too long for Windows' one command line (a spawn's ENAMETOOLONG, or found before it). */
export const INBOX_RUN_TOO_LONG_WORDS = "This command is too long to run here on Windows. Run it in your terminal.";

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
  /** When its process was started (this Inbox's clock), for the journal. */
  spawnedAt: number | null;
  /** Not watched for a prompt (its stdin is closed). */
  noPrompt: boolean;
}

/** A lost run whose command still ran is looked at again at most this often while its card is read. */
export const INBOX_RUN_LOST_RECHECK_MS = 5_000;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const PROMPT_END_RE = /[:?>\]\)]\s*$/;
const PROMPT_WORDS_RE = /password|passphrase|\by\/n\b|\[y\/n\]|\(y\/n\)|yes\/no|press (enter|return|any key)|continue\?|verification code|one-time code/i;
const NEEDS_TERMINAL_RE = /not a tty|no tty present|a terminal is required|stdin is not a terminal|inappropriate ioctl for device|must be run (from|in) a terminal|isn't a tty|not a terminal|no tty available|requires an interactive/i;

/** A line as the line buffer gives it: `cut` when only its head was kept. */
export interface RunLine {
  text: string;
  cut: boolean;
}

/**
 * One line as the card shows it: no colour codes, a progress line at its last state, secrets hidden, capped. Whole
 * values are hidden before the line is cut, and a value whose first characters end what is kept (a cut line, or
 * the line still being written: `open`) loses those too, so no part of a secret is shown. A cut line ends in "…".
 */
export function cleanRunLine(raw: string, secrets: readonly string[], options: { cut?: boolean; open?: boolean } = {}): string {
  const parts = raw.replace(/\r$/, "").split("\r");
  const last = [...parts].reverse().find((part) => part.replace(ANSI_RE, "").trim() !== "") ?? parts[parts.length - 1] ?? "";
  const line = redactSecrets(last.replace(ANSI_RE, ""), secrets);
  if (line.length > INBOX_RUN_LINE_MAX) return `${hideSecretPrefixTail(line.slice(0, INBOX_RUN_LINE_MAX), secrets)}…`;
  if (options.cut) return `${hideSecretPrefixTail(line, secrets)}…`;
  return options.open ? hideSecretPrefixTail(line, secrets) : line;
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
  push(text: string): RunLine[] {
    const lines: RunLine[] = [];
    let from = 0;
    for (let nl = text.indexOf("\n", from); nl !== -1; nl = text.indexOf("\n", from)) {
      lines.push(this.cut ? { text: this.pending, cut: true } : { text: lastStates(this.pending + text.slice(from, nl)), cut: false });
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

  /** The line still being written was cut to its head. */
  get partialCut(): boolean {
    return this.cut;
  }

  /** Ends the stream: its last line, when it had one. */
  end(): RunLine[] {
    const last = { text: this.pending, cut: this.cut };
    this.pending = "";
    this.cut = false;
    return last.text === "" ? [] : [last];
  }
}

/** A spawn's failure in words: a command too long for Windows' command line says so plainly. */
const spawnWords = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENAMETOOLONG" || code === "E2BIG") return INBOX_RUN_TOO_LONG_WORDS;
  return error instanceof Error ? error.message : String(error);
};

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
  left_running: null,
});

/** Finished runs kept whole in memory; older ones keep only what the journal keeps (their card's last lines). */
const FINISHED_KEPT = 20;
/** Past runs (from the journal, and finished ones let go) kept at most. */
const PAST_KEPT = 300;

export function createInboxRuns(options: {
  messageAlive: (messageId: string) => boolean;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Quiet this long on a prompt: it waits for typing. Tests shorten it. */
  quietMs?: number;
  /** How often the sweep looks (deleted messages, waiting for typing). */
  sweepMs?: number;
  journal?: InboxRunJournal;
  /**
   * Whether a lost run's command still runs, by its process group and the time it started: true (Stop can end it),
   * false (it ended), null (this computer cannot tell). Absent: unknown.
   */
  stillRunning?: (pid: number, startedAt: number, seenAt: number) => Promise<boolean | null>;
  /** A message's run changed (it started, ended, was stopped, or a lost one was found ended): its cards read again. */
  onChange?: (messageId: string) => void;
}) {
  const changed = (messageId: string) => {
    try {
      options.onChange?.(messageId);
    } catch {
      // A listener's failure is not the run's.
    }
  };
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
  const recordOf = (run: Run): InboxRunRecord => ({
    message_id: run.start.message_id,
    key: run.start.key,
    title: run.start.title,
    folder: run.start.folder,
    view: { ...run.view, lines: run.view.lines.slice(-INBOX_RUN_JOURNAL_LINES), duration_ms: run.ended ? run.view.duration_ms : Math.max(0, now() - Date.parse(run.view.started_at)) },
    live: !run.ended,
    pid: run.ended ? null : (run.child?.pid ?? null),
    spawned_at: run.spawnedAt,
    seen_at: run.ended ? null : now(),
  });
  let journalAt = 0;
  let journalStale = false;
  const writeJournal = () => {
    journalAt = now();
    journalStale = false;
    if (!options.journal) return;
    const records = new Map(past);
    for (const run of runs.values()) records.set(id(run.start.message_id, run.start.key), recordOf(run));
    options.journal.save([...records.values()]);
  };
  // Finished runs past the first few keep only their record (what the journal has), so memory stays bounded.
  const finishedOrder: string[] = [];
  const letGo = (runId: string) => {
    finishedOrder.push(runId);
    while (finishedOrder.length > FINISHED_KEPT) {
      const oldest = finishedOrder.shift()!;
      const run = runs.get(oldest);
      if (!run || !run.ended) continue;
      runs.delete(oldest);
      past.set(oldest, recordOf(run));
    }
    while (past.size > PAST_KEPT) past.delete(past.keys().next().value!);
  };
  if (lost.length > 0) writeJournal();

  const live = () => [...runs.values()].filter((run) => !run.ended);
  /**
   * Whether a lost run's command still runs, looked at again now: its pid may since have gone to another program
   * (the start time tells them apart). Only a definite "ended" (false) stops the card offering Stop; one `ps` that
   * could not tell (null) leaves "still running" as it was (and Stop, pressed then, signals nothing). Never a signal here.
   */
  const lostChecked = new Map<InboxRunRecord, number>();
  /** Who hears of a lost run (`recover`'s listener): told again, once, when one it heard "still running" ends by itself. */
  let tellLost: ((record: InboxRunRecord) => void) | null = null;
  const toldEnded = (record: InboxRunRecord) => {
    if (!options.messageAlive(record.message_id)) return;
    try {
      tellLost?.(record);
    } catch {
      // A listener's failure is not the run's.
    }
  };
  const recheckLost = async (record: InboxRunRecord): Promise<boolean | null> => {
    lostChecked.set(record, now());
    const pid = record.pid ?? null;
    const left = pid && record.spawned_at && options.stillRunning ? await options.stillRunning(pid, record.spawned_at, record.seen_at ?? record.spawned_at).catch(() => null) : null;
    if (left === false && record.view.left_running === true) {
      record.pid = null;
      record.view = { ...record.view, left_running: left };
      writeJournal();
      changed(record.message_id);
      // It ended by itself: the agent, last told it still ran, hears that it ended.
      toldEnded(record);
    }
    return left;
  };
  /**
   * Stop on a lost run's card whose command still runs: TERM to its group, then KILL after a grace, each only after
   * looking again that it is still that command (a pid given to another program since is never signalled). The
   * record, or null when there was nothing of its own to stop.
   */
  const stopLeftRunning = async (messageId: string, key: string): Promise<InboxRunRecord | null> => {
    const record = past.get(id(messageId, key));
    if (!record || record.view.left_running !== true || !record.pid || !record.spawned_at) return null;
    const pid = record.pid;
    const startedAt = record.spawned_at;
    const seenAt = record.seen_at ?? startedAt;
    if ((await recheckLost(record)) !== true) return null;
    killRunTree(pid, "SIGTERM", platform);
    const timer = setTimeout(() => {
      void (async () => {
        if (options.stillRunning && (await options.stillRunning(pid, startedAt, seenAt).catch(() => null)) === true) killRunTree(pid, "SIGKILL", platform);
      })();
    }, STOP_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
    record.pid = null;
    // The person stopped it: the card says so, not that it ended by itself.
    record.view = { ...record.view, left_running: false, signal: "SIGTERM" };
    writeJournal();
    changed(messageId);
    return record;
  };
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
        if (run.noPrompt) continue;
        const quiet = now() - run.lastOutput >= quietMs;
        const partial = run.view.partial.trim();
        const lastLine = run.view.lines[run.view.lines.length - 1] ?? "";
        run.view.waiting_for_input =
          run.view.state === "running" && quiet && ((partial !== "" && (PROMPT_END_RE.test(partial) || PROMPT_WORDS_RE.test(partial))) || (partial === "" && PROMPT_WORDS_RE.test(lastLine)));
      }
      // What a running command printed reaches the journal every few seconds, so a lost run's card keeps it.
      if (journalStale && now() - journalAt >= JOURNAL_EVERY_MS) writeJournal();
      if (live().length === 0) unwatch();
    }, options.sweepMs ?? 500);
    (sweep as { unref?: () => void }).unref?.();
  };
  const unwatch = () => {
    if (sweep) clearInterval(sweep);
    sweep = null;
    process.removeListener("exit", onExit);
  };

  const add = (run: Run, lines: readonly RunLine[]) => {
    for (const line of lines) {
      run.view.lines.push(cleanRunLine(line.text, run.redact, { cut: line.cut }));
      run.view.total_lines += 1;
    }
    if (run.view.lines.length > INBOX_RUN_KEEP_LINES) run.view.lines.splice(0, run.view.lines.length - INBOX_RUN_KEEP_LINES);
  };
  const push = (run: Run, stream: "out" | "err", text: string) => {
    run.lastOutput = now();
    journalStale = true;
    run.view.waiting_for_input = false;
    add(run, run[stream].push(text));
    // The line still being written: a secret's first characters are hidden before its last arrive.
    const open = run.out.partial ? run.out : run.err;
    run.view.partial = cleanRunLine(open.partial, run.redact, { open: true, cut: open.partialCut });
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
    letGo(id(run.start.message_id, run.start.key));
    changed(run.start.message_id);
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
    run.noPrompt = prepared.closeStdin === true;
    if (run.stopping || run.ended) {
      if (!run.ended) finish(run, "stopped", null, null);
      return;
    }
    let child: ChildProcess;
    try {
      const [file, ...args] = prepared.argv;
      child = spawn(file!, args, { cwd: run.start.cwd, env: prepared.env, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish(run, "failed_to_start", null, null, spawnWords(error));
      return;
    }
    run.child = child;
    run.spawnedAt = now();
    run.view.state = "running";
    // Its process is in the journal from here: an Inbox that dies can find it again (recover).
    writeJournal();
    changed(run.start.message_id);
    if (prepared.closeStdin) child.stdin?.end();
    run.lastOutput = now();
    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    child.stdout?.on("data", (chunk: Buffer) => push(run, "out", decoders.out.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => push(run, "err", decoders.err.write(chunk)));
    child.stdin?.on("error", () => {});
    child.on("error", (error) => finish(run, "failed_to_start", null, null, spawnWords(error)));
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
        spawnedAt: null,
        noPrompt: false,
      };
      const runId = id(start.message_id, start.key);
      const index = finishedOrder.indexOf(runId);
      if (index !== -1) finishedOrder.splice(index, 1);
      runs.set(runId, run);
      past.delete(runId);
      writeJournal();
      watch();
      void begin(run);
      return run.view;
    },
    /** Stop: TERM to the group, KILL after a grace; before it started, it never starts. False when nothing runs here. */
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
    /** Stop on a lost run that still runs (looked at again first); its record when it was stopped. */
    stopLost: stopLeftRunning,
    /**
     * A card of this message is being read: a lost run said to be still running is looked at again (at most every
     * few seconds), so its words and its Stop stay true once it ends or its pid goes to another program.
     */
    recheck(messageId: string): void {
      for (const record of past.values()) {
        if (record.message_id !== messageId || record.view.left_running !== true) continue;
        if (now() - (lostChecked.get(record) ?? 0) < INBOX_RUN_LOST_RECHECK_MS) continue;
        void recheckLost(record);
      }
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
    /**
     * The runs this Inbox found unfinished from before it started, each heard once (the agent gets a word), after
     * looking whether each command still runs. Those found running before keep being looked at too.
     */
    async recover(onLost: (record: InboxRunRecord) => void): Promise<void> {
      tellLost = onLost;
      const fresh = lost.splice(0);
      const endedSince: InboxRunRecord[] = [];
      const again = [...past.values()].filter((record) => record.view.left_running === true && !fresh.includes(record));
      for (const record of [...fresh, ...again]) {
        const pid = record.pid ?? null;
        const left = pid && record.spawned_at && options.stillRunning ? await options.stillRunning(pid, record.spawned_at, record.seen_at ?? record.spawned_at).catch(() => null) : null;
        // One `ps` that could not tell never undoes "still running" found before (only a definite end does).
        const kept = left === null && record.view.left_running === true && !fresh.includes(record) ? true : left;
        if (kept === false && record.view.left_running === true && !fresh.includes(record)) endedSince.push(record);
        record.view = { ...record.view, left_running: kept };
        lostChecked.set(record, now());
        if (kept !== true) record.pid = null;
      }
      if (fresh.length > 0 || again.length > 0) writeJournal();
      for (const record of fresh) if (options.messageAlive(record.message_id)) onLost(record);
      for (const record of endedSince) toldEnded(record);
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
