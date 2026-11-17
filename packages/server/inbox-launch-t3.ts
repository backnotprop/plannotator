/**
 * T3 Code's launch host (issue #3590): New message → To → T3 Code and a project, and the Inbox starts a new T3
 * thread there, always in a new git worktree, with the person's message as its first turn. The thread is T3's from
 * then on: T3 runs it with the project's default model and permission mode, and its permission prompts wait in T3's
 * own app. The person's replies go in through the T3 wake that exists already (`t3 thread send`, inbox-t3-local.ts).
 *
 * The one command, T3's documented host command for outside scripts (T3's docs/user/outside-agents.md, "Scripts on
 * the host"; the flags as T3's own `apps/server/src/cli/thread.ts` declares them):
 *
 *   t3 thread start . - --worktree <base branch> --title <thread name> --json
 *
 * run in the project's folder (`.` is the T3 project that holds it, or a git worktree of its repository), the
 * message on stdin (`-`), so no shell and no process list ever sees it. Its env is the T3 wake's (`t3ChildEnv`), with
 * the person's login PATH. `--json` prints `{ threadId, projectId, runId }` (T3's `ThreadLaunchResult`).
 *
 * - The base branch is the branch the project's folder has checked out now (read from its `.git`, no git run), or
 *   `HEAD` when it is detached: the work starts from what the person sees in that folder, local commits included
 *   (T3 bases the worktree on that ref as it is here; it fetches only when asked to start from the remote).
 * - T3 picks the new worktree's branch and folder: a temporary `t3/<8 hex>` branch, renamed in the background by
 *   T3's own branch naming settings, in T3's worktrees folder (`<T3 home>/worktrees` unless T3's settings move it).
 * - T3 must be running (`t3 thread` talks to the running server), and the folder must be in a project T3 knows. When
 *   T3 refuses, its own words are the run line's cause, with Try again; a folder T3 does not know reads in plain words.
 * - No Stop, attach or terminal: T3 has no host command for them. Delete forgets the launch here; the thread stays in T3.
 *
 * The first turn is what the T3 wake would send the thread (the engine's `firstTurn`, inbox.ts), and the engine
 * records the root as delivered as it moves it to the new thread, so no wake sends it again (`startsWithTurn`).
 * Not on Windows, where the T3 wake does not run `t3` either.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { INBOX_T3_HOST, INBOX_T3_NAME, isT3ThreadId, type InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { agentHomeAllowed, type AgentEnvironment } from "./inbox-agents";
import { shellQuote } from "./inbox-launch-claude";
import type { LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchHost, LaunchHostContext, LaunchHostResult, LaunchLive } from "./inbox-launch-host";
import { INBOX_T3_SEND_TIMEOUT_MS, t3ChildEnv, t3CommandOf } from "./inbox-t3-local";

/** T3's words for a folder in no project it knows (cli/thread.ts `ThreadProjectNotFoundError`). */
const T3_NO_PROJECT = /^No T3 Code project matches /;
/** T3's words when its app is not running: no server for this home, or a runtime file whose server does not answer. */
const T3_NOT_RUNNING = /^(No running T3 Code server uses |Could not reach the T3 Code server)/;
/** What the person reads when T3 Code is not open (never T3's path or "server"). */
export const T3_LAUNCH_NOT_OPEN = "T3 Code isn't open on this computer. Open it, then try again.";
/** The most of T3's own words a failed start's line quotes. */
const CAUSE_MAX = 300;

export const T3_LAUNCH_MISSING = "T3 Code's t3 command is not on this computer";
/** Why a new folder (scratch, Create a folder, a clone) is refused: T3 starts only in a repository it knows. */
export const T3_LAUNCH_NEW_FOLDER = "T3 Code starts only in a project's git repository, in a new worktree.";

/** The git repository a folder is in: its top folder and its git dir (a linked worktree's `.git` file followed). Null outside one. */
export function gitRepoOf(folder: string): { top: string; gitDir: string } | null {
  let dir = resolve(folder);
  for (;;) {
    const dotGit = join(dir, ".git");
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return { top: dir, gitDir: dotGit };
      if (stat.isFile()) {
        const said = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
        if (said) return { top: dir, gitDir: isAbsolute(said) ? said : resolve(dir, said) };
      }
    } catch {
      // Not here: one folder up.
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The worktree's base: the branch the folder has checked out (`.git/HEAD`), `HEAD` when detached; null outside a repository. */
export function t3BaseOf(folder: string): string | null {
  const repo = gitRepoOf(folder);
  if (!repo) return null;
  let head = "";
  try {
    head = readFileSync(join(repo.gitDir, "HEAD"), "utf8").trim();
  } catch {
    return "HEAD";
  }
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1]?.trim();
  // A name git would take as an option is never passed (git refuses to make one).
  return branch && !branch.startsWith("-") ? branch : "HEAD";
}

/** The thread T3 started, from `--json`'s line (`{ threadId, projectId, runId }`); null when none is there. */
export function t3StartedThreadOf(stdout: string): string | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const said = (JSON.parse(line) as { threadId?: unknown } | null)?.threadId;
      if (isT3ThreadId(said)) return said;
    } catch {
      // T3 logged something first.
    }
  }
  return null;
}

/** Each absolute path in T3's words cut to its last name (`/Users/me/code/shop` → `shop`): the person never reads a path. */
export function t3WithoutPaths(text: string): string {
  return text.replace(/(^|[\s('"`=,])(~?\/[^\s'"`()<>,]*|[A-Za-z]:\\[^\s'"`()<>,]*)/g, (_all, lead: string, path: string) => {
    const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";
    return `${lead}${name.replace(/[.,;:]+$/, "") || "a folder"}${/[.,;:]$/.test(path) ? path.slice(-1) : ""}`;
  });
}

/**
 * Why a start failed, as the run line says it after "T3 Code didn't start.": the host's own plain sentence for what
 * it recognises (T3 not open, a folder T3 doesn't know), else T3's last line, one line, 300 characters at most, with
 * no path in it.
 */
export function t3StartCause(text: string, project: string): string {
  const last = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).pop() ?? "";
  if (T3_NO_PROJECT.test(last)) return `${project} isn't a project in T3 Code yet. Add its folder in T3 Code, then try again.`;
  if (T3_NOT_RUNNING.test(last)) return T3_LAUNCH_NOT_OPEN;
  const plain = t3WithoutPaths(last);
  const said = plain.length > CAUSE_MAX ? `${plain.slice(0, CAUSE_MAX - 1).trimEnd()}…` : plain;
  if (!said) return "T3 Code did not say why.";
  return /[.!?…]$/.test(said) ? said : `${said}.`;
}

/**
 * The `t3` to run, or null. A test run (PLANNOTATOR_TEST_SANDBOX) takes only one in its scratch home's temp folder,
 * never a `t3` on the person's PATH, so no test can start a thread in their real T3 Code.
 */
function t3For(e: AgentEnvironment): string | null {
  const command = t3CommandOf(e);
  if (!command || !agentHomeAllowed(e)) return null;
  return agentHomeAllowed({ homeDir: command, env: e.env }) ? command : null;
}

/** The run line's cause for a `t3 thread start` that gave no thread: it timed out, said nothing usable, or refused. */
export function t3StartFailure(result: { timedOut?: boolean; exitCode: number | null; stdout: string; stderr: string }, project: string): string {
  if (result.timedOut) return `T3 Code didn't answer within ${Math.round(INBOX_T3_SEND_TIMEOUT_MS / 1000)} seconds. It may have started the thread, so look in T3 Code before you try again.`;
  if (result.exitCode === 0) return "T3 Code started a thread but didn't say which. Look in T3 Code before you try again.";
  return t3StartCause(`${result.stdout}\n${result.stderr}`, project);
}

export function createT3LaunchHost(ctx: LaunchHostContext) {
  const nothing = (text: string): LaunchHostResult => ({ exitCode: 0, text });
  return {
    agent: INBOX_T3_HOST,
    name: INBOX_T3_NAME,
    shellNames: [],
    startsWithTurn: true,
    worktree: true,

    async available(): Promise<LaunchAvailability> {
      // Not on Windows: `t3.cmd` goes through cmd.exe, which the T3 wake does not trust with a message either.
      if (ctx.platform === "win32") return { ok: false, missing: true, reason: T3_LAUNCH_MISSING, code: "missing" };
      const e = await ctx.environment();
      // A test run uses T3 only in a scratch home, never the person's own ~/.t3 or a `t3` on their PATH.
      if (!t3For(e)) return { ok: false, missing: true, reason: T3_LAUNCH_MISSING, code: "missing" };
      return { ok: true, version: "" };
    },

    startsIn(folder: string | null): string | null {
      if (folder === null) return T3_LAUNCH_NEW_FOLDER;
      if (gitRepoOf(folder)) return null;
      return `${ctx.displayFolder(folder)} isn't a git repository. T3 Code starts its work in a new worktree of one.`;
    },

    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    trusts: () => true,

    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv; firstTurn?: string }) {
      const e = await ctx.environment();
      const command = ctx.platform === "win32" ? null : t3For(e);
      if (!command) return { ok: false as const, code: "missing" as const, text: `${T3_LAUNCH_MISSING}.` };
      const project = basename(launch.folder);
      const base = t3BaseOf(launch.folder);
      if (!base) return { ok: false as const, code: "failed" as const, text: `${ctx.displayFolder(launch.folder)} isn't a git repository any more.` };
      const message = input.firstTurn ?? "";
      if (!message.trim()) return { ok: false as const, code: "failed" as const, text: "The message is empty." };
      const title = input.name.replace(/\s+/g, " ").trim();
      const argv = [command, "thread", "start", ".", "-", "--worktree", base, ...(title ? ["--title", title] : []), "--json"];
      const env = { ...t3ChildEnv(e), ...(input.login.PATH ? { PATH: input.login.PATH } : {}) };
      const result = await e.run(argv, { timeoutMs: INBOX_T3_SEND_TIMEOUT_MS, cwd: launch.folder, env, cleanEnv: true, stdin: message });
      // The message is never written down here: only the command and what T3 said.
      ctx.startLog(launch.id, `${["t3", ...argv.slice(1)].map((arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : shellQuote(arg))).join(" ")} (in ${launch.folder}, the message on stdin)\nexit ${result.timedOut ? "timed out" : result.exitCode}\n${`${result.stdout}\n${result.stderr}`.trim().slice(-2000)}`);
      const thread = !result.timedOut && result.exitCode === 0 ? t3StartedThreadOf(result.stdout) : null;
      if (!thread) return { ok: false as const, code: "failed" as const, text: t3StartFailure(result, project) };
      ctx.startLog(launch.id, `T3 thread ${thread}, in a new worktree from ${base}`);
      return { ok: true as const, session: thread, ref: thread };
    },

    // T3 keeps the thread: there is nothing to list, stop or start again from here.
    sessions: async () => null,
    /**
     * Its Claude's Plannotator mod, where it polls as the thread, says when a turn runs. Otherwise the thread is
     * T3's, alive as long as T3 keeps it: never "not connected" or "stopped" here, and never started again by a reply
     * (the T3 wake sends it in).
     */
    live(session: string): LaunchLive | null {
      return ctx.bridge.runStateOf(session) ?? { busy: null, busySince: null, polls: 0 };
    },
    resume: async (): Promise<LaunchHostResult & { failure: null }> => ({ ...nothing("T3 Code keeps its threads: a reply goes in through the T3 wake"), failure: null }),
    stop: async (): Promise<LaunchHostResult> => nothing("T3 Code has no command to stop a thread from outside: it runs in T3 Code"),
    remove: async (): Promise<LaunchHostResult> => nothing("T3 Code keeps its threads and their worktrees"),
    purge: async (): Promise<LaunchHostResult & { skipped?: string }> => ({ exitCode: 0, text: "", skipped: "T3 Code keeps its threads in its own state" }),
    attach: (): string | null => null,
    terminal: (launch: InboxLaunchRecord): string => `cd ${shellQuote(launch.folder)}`,
    // Its prompts wait in T3's own app.
    permissions: () => ({ sweep() {}, withdrawAll() {} }),
  } satisfies LaunchHost;
}
