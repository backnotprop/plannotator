/**
 * Plannotator Inbox: a `:::run` block's command, run when the person presses
 * Run (inbox-run-routes.ts checks who pressed and which bytes).
 *
 * - It runs on this computer, as the person, in the block's folder, with their
 *   login shell's environment and the project's saved secrets (`$NAME`), in
 *   its own process group (Windows: its own tree), stdin held open.
 * - Output: stdout and stderr as they arrive, colour codes stripped, a `\r`
 *   progress line kept at its last state, each saved secret hidden as `••••`,
 *   the last `INBOX_RUN_KEEP_LINES` lines kept.
 * - A run that goes quiet on a prompt (a password, a y/n) says it waits for
 *   typing; one that fails asking for a terminal says that too. Neither is
 *   answered here: the card offers the person's own terminal.
 * - Stop ends the whole group (TERM, then KILL); so do the message's
 *   deletion (a sweep while anything runs) and the Inbox's stop or exit. When
 *   the command exits, what it left running in its group is stopped too.
 * - When it ends, its `onEnd` hears it once (the result goes to the agent).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "./inbox-secrets";

/** Lines a run keeps for its card. */
export const INBOX_RUN_KEEP_LINES = 500;
const LINE_MAX = 2_000;
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
}

export interface InboxRunStart {
  message_id: string;
  key: string;
  /** The program and its arguments, from the environment it runs with (the shell is the login env's). */
  argv: (env: Readonly<Record<string, string>>) => readonly string[];
  cwd: string;
  env: () => Promise<Record<string, string>>;
  /** Saved secret values to hide in output. */
  secrets: readonly string[];
  /** Heard once, when it ends, while its message is still there: the result goes to the agent. */
  onEnd: (ended: InboxRunEnded) => void;
}

export interface InboxRunEnded {
  message_id: string;
  view: InboxRunView;
  outcome: "exited" | "stopped" | "failed_to_start";
  /** It was waiting for typing when it ended (a Stop on a password prompt). */
  waited_for_input: boolean;
}

interface Run {
  start: InboxRunStart;
  view: InboxRunView;
  child: ChildProcess | null;
  stopping: boolean;
  lastOutput: number;
  pending: { out: string; err: string };
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
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line;
}

/** Stops a process group (POSIX) or tree (Windows); quiet when it is already gone. */
export function killRunTree(pid: number | undefined, signal: "SIGTERM" | "SIGKILL", platform: NodeJS.Platform = process.platform): void {
  if (!pid) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Gone already.
  }
}

export function createInboxRuns(options: { messageAlive: (messageId: string) => boolean; now?: () => number; platform?: NodeJS.Platform }) {
  const now = options.now ?? (() => Date.now());
  const platform = options.platform ?? process.platform;
  const runs = new Map<string, Run>();
  const id = (messageId: string, key: string) => `${messageId}/${key}`;
  let sweep: ReturnType<typeof setInterval> | null = null;

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
          continue;
        }
        const quiet = now() - run.lastOutput >= INBOX_RUN_QUIET_MS;
        const partial = run.view.partial.trim();
        const lastLine = run.view.lines[run.view.lines.length - 1] ?? "";
        run.view.waiting_for_input =
          run.view.state === "running" && quiet && ((partial !== "" && (PROMPT_END_RE.test(partial) || PROMPT_WORDS_RE.test(partial))) || (partial === "" && PROMPT_WORDS_RE.test(lastLine)));
      }
      if (live().length === 0) unwatch();
    }, 500);
    (sweep as { unref?: () => void }).unref?.();
  };
  const unwatch = () => {
    if (sweep) clearInterval(sweep);
    sweep = null;
    process.removeListener("exit", onExit);
  };

  const push = (run: Run, stream: "out" | "err", text: string, final = false) => {
    run.lastOutput = now();
    run.view.waiting_for_input = false;
    const all = run.pending[stream] + text;
    const pieces = all.split("\n");
    run.pending[stream] = final ? "" : pieces.pop()!;
    const done = final ? pieces.filter((piece, i) => i < pieces.length - 1 || piece !== "") : pieces;
    for (const piece of done) {
      run.view.lines.push(cleanRunLine(piece, run.start.secrets));
      run.view.total_lines += 1;
    }
    if (run.view.lines.length > INBOX_RUN_KEEP_LINES) run.view.lines.splice(0, run.view.lines.length - INBOX_RUN_KEEP_LINES);
    run.view.partial = cleanRunLine(run.pending.out || run.pending.err, run.start.secrets);
  };

  const finish = (run: Run, outcome: InboxRunEnded["outcome"], code: number | null, signal: string | null, error: string | null = null) => {
    if (run.ended) return;
    run.ended = true;
    const waited = run.view.waiting_for_input;
    for (const timer of run.timers) clearTimeout(timer);
    // What it left running in its group goes with it.
    if (outcome !== "failed_to_start") killRunTree(run.child?.pid, "SIGKILL", platform);
    push(run, "out", "", true);
    push(run, "err", "", true);
    run.view.partial = "";
    const view = run.view;
    view.ended_at = new Date(now()).toISOString();
    view.duration_ms = Math.max(0, now() - Date.parse(view.started_at));
    view.exit_code = code;
    view.signal = signal;
    view.error = error === null ? null : redactSecrets(error, run.start.secrets);
    view.waiting_for_input = false;
    view.state = outcome === "stopped" ? "stopped" : outcome === "failed_to_start" || code !== 0 ? "failed" : "done";
    view.needs_terminal = view.state === "failed" && view.lines.slice(-20).some((line) => NEEDS_TERMINAL_RE.test(line));
    if (live().length === 0) unwatch();
    if (options.messageAlive(run.start.message_id)) run.start.onEnd({ message_id: run.start.message_id, view: { ...view, lines: [...view.lines] }, outcome, waited_for_input: waited });
  };

  const begin = async (run: Run) => {
    let env: Record<string, string>;
    try {
      env = await run.start.env();
    } catch (error) {
      finish(run, "failed_to_start", null, null, error instanceof Error ? error.message : String(error));
      return;
    }
    if (run.stopping || run.ended) {
      if (!run.ended) finish(run, "stopped", null, null);
      return;
    }
    let child: ChildProcess;
    try {
      const [file, ...args] = run.start.argv(env);
      child = spawn(file!, args, { cwd: run.start.cwd, env, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
        view: {
          key: start.key,
          run_id: `run_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          state: "starting",
          exit_code: null,
          signal: null,
          started_at: new Date(now()).toISOString(),
          ended_at: null,
          duration_ms: 0,
          lines: [],
          total_lines: 0,
          partial: "",
          waiting_for_input: false,
          needs_terminal: false,
          error: null,
        },
        child: null,
        stopping: false,
        lastOutput: now(),
        pending: { out: "", err: "" },
        timers: new Set(),
        ended: false,
      };
      runs.set(id(start.message_id, start.key), run);
      watch();
      void begin(run);
      return run.view;
    },
    /** Stop: TERM to the group, KILL after a grace. False when nothing of that key runs. */
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
    /** A message's runs, the running and the last finished of each key, as the card reads them. */
    views(messageId: string): Record<string, InboxRunView> {
      const out: Record<string, InboxRunView> = {};
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
    /** The Inbox stops: every run's group goes now. */
    stopAll(): void {
      for (const run of live()) {
        killRunTree(run.child?.pid, "SIGKILL", platform);
        run.ended = true;
        run.stopping = true;
        for (const timer of run.timers) clearTimeout(timer);
      }
      unwatch();
    },
  };
}

export type InboxRuns = ReturnType<typeof createInboxRuns>;
