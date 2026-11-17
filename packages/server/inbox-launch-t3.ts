/**
 * T3 Code's launch host (issue #3590): New message → To → T3 Code and a project, and the Inbox starts a new T3
 * thread there, always in a new git worktree, with the person's message as its first turn. The thread is T3's from
 * then on: its permission prompts wait in T3's own app, and the person's replies go in through the T3 wake that
 * exists already (`t3 thread send`, inbox-t3-local.ts).
 *
 * T3 runs other agents (Claude Code, Codex, …): each thread runs one provider instance's model. To's model button
 * offers them (`choices`), Default first: Default passes no flag, so T3 uses the project's own default model. The
 * lists, in this order:
 *
 *  1. a signed-in T3 (`plannotator t3 login`, the grant the T3 wake uses) whose endpoint is the T3 running here:
 *     T3's `orchestrator_capabilities` (its short list of models per provider, each model's `effort` option);
 *  2. otherwise the agent and model pairs T3 threads in the projects To offers already used (`t3 thread list
 *     --json`), with no effort (T3's list doesn't say which options a model takes);
 *  3. neither: no button.
 *
 * After the start, `t3 thread show <thread> --messages 0 --json` says which agent and model the thread runs, Default
 * included (`innerOf`): the thread's meta line and the agent row name it ("T3 Code (Claude Code · opus)").
 *
 * The one start command, T3's documented host command for outside scripts (T3's docs/user/outside-agents.md, "Scripts
 * on the host"; the flags as T3's own `apps/server/src/cli/thread.ts` declares them):
 *
 *   t3 thread start . - --worktree=<base branch> --title=<thread name> [--provider=<instance> --model=<slug>
 *     [--option=effort=<level>]] --json
 *
 * run in the project's folder (`.` is the T3 project that holds it, or a git worktree of its repository), the
 * message on stdin (`-`), so no shell and no process list ever sees it. Each value goes after "=", so a thread name
 * that starts with "-" is never read as a flag (T3's CLI is Effect's: its lexer takes a `--name=value` token's value as
 * it is, and a lone `-` as a value). Its env is the T3 wake's (`t3ChildEnv`), with the person's login PATH. `--json`
 * prints `{ threadId, projectId, runId }` (T3's `ThreadLaunchResult`).
 *
 * - The base branch is the branch the project's folder has checked out now (read from its `.git`, no git run), or
 *   `HEAD` when it is detached. A repository whose top is the home folder or above it (a dotfiles repository) is not
 *   a project's: such a folder is refused.
 * - T3 picks the new worktree's branch and folder: a temporary `t3/<8 hex>` branch, renamed in the background by
 *   T3's own branch naming settings, in T3's worktrees folder.
 * - T3 must be running, and the folder must be in a project T3 knows. When T3 refuses, the run line says why in
 *   plain words, with Try again.
 * - `t3 thread start` takes no request id, so a start cut short (no answer in 30 s, an Inbox closed mid-start) may
 *   have made the thread. Each start first notes the threads of that title the project has, and then how it ended
 *   (`t3-start.json` in the launch's folder). Only after an uncertain end does a later start of the same launch take a
 *   thread of that title made since, and never one another launch or agent of this Inbox has (`t3AdoptableOf`).
 * - The run line's "not connected" (`connectWaitMs`) shows only once `t3 thread show` says the thread's run is over
 *   (`turnEnded`), so a long first turn is never called not connected; the Inbox can't start the thread again, so it
 *   offers no Try again there.
 * - No Stop, attach or terminal: T3 has no host command for them. Delete forgets the launch here; the thread stays in T3.
 *
 * The first turn is what the T3 wake would send the thread (the engine's `firstTurn`, inbox.ts), and the engine
 * records the root as delivered in the same write that moves it to the new thread (`startsWithTurn`). Not on Windows,
 * where the T3 wake does not run `t3` either.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseT3Capabilities, t3AgentName, t3LaunchChoiceArgs, t3ModelOf, t3ThreadRunsOf, t3UsedModels, type InboxLaunchChoices } from "@plannotator/core/inbox-launch-choice";
import { INBOX_T3_HOST, INBOX_T3_NAME, isT3ThreadId, type InboxLaunchInner, type InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { agentHomeAllowed, type AgentEnvironment } from "./inbox-agents";
import { shellQuote } from "./inbox-launch-claude";
import type { LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchHost, LaunchHostContext, LaunchHostResult, LaunchLive } from "./inbox-launch-host";
import { INBOX_T3_SEND_TIMEOUT_MS, t3ChildEnv, t3CommandOf, t3HomeOf, t3ServerOf } from "./inbox-t3-local";
import { connectT3, savedT3Grants } from "./inbox-t3-wake";

/** T3's words for a folder in no project it knows (cli/thread.ts `ThreadProjectNotFoundError`). */
const T3_NO_PROJECT = /^No T3 Code project matches /;
/** T3's words when its app is not running: no server for this home, or a runtime file whose server does not answer. */
const T3_NOT_RUNNING = /^(No running T3 Code server uses |Could not reach the T3 Code server)/;
/** What the person reads when T3 Code is not open on this computer (never T3's path or "server"). */
export const T3_LAUNCH_NOT_OPEN = "T3 Code isn't open on this computer. Open it, then try again.";
/** The same, named for a computer linked machines know by name: every window shows it, so each reads which one. */
export const t3NotOpenWords = (machine: string | null | undefined): string => (machine ? `T3 Code isn't open on ${machine}. Open it there, then try again.` : T3_LAUNCH_NOT_OPEN);
/** The run line's cause for a start the Inbox closed during: its Try again takes a thread that start made. */
export const T3_LAUNCH_INTERRUPTED = "The Inbox closed while T3 Code was starting. Try again: if T3 Code made the thread, the Inbox picks it up.";
/** How long after the start the run line waits for the thread's agent to reach the Inbox before it says it isn't connected. */
export const T3_CONNECT_WAIT_MS = 10 * 60_000;
/** The most of T3's own words a failed start's line quotes. */
const CAUSE_MAX = 300;
/** A `t3 thread list` or `show` call may take this long. */
const T3_READ_TIMEOUT_MS = 10_000;
/** How long a read of the model lists is believed (a new sign-in, a new model, a thread on a new agent show after it). */
const LISTS_TTL_MS = 60_000;
/** T3's MCP call for the lists may take this long. */
const CAPABILITIES_TIMEOUT_MS = 5_000;

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

/** A repository whose top is `home` or a folder above it (a dotfiles repository): never a project's own. */
export function coversHome(top: string, home: string): boolean {
  const rel = relative(resolve(top), resolve(home));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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

/**
 * The threads `t3 thread list --json` printed (`[{ threadId, title, createdAt, … }]`, newest first; T3's
 * `OrchestratorMcpThreadListItem`); null when it printed none. `createdAt` (ms) when T3 gave a time it reads.
 */
export function t3ListedThreadsOf(stdout: string): { threadId: string; title: string; createdAt: number | null }[] | null {
  for (const text of [stdout.trim(), stdout.trim().split("\n").pop() ?? ""]) {
    try {
      const said = JSON.parse(text) as unknown;
      if (!Array.isArray(said)) continue;
      return (said as { threadId?: unknown; title?: unknown; createdAt?: unknown }[]).flatMap((t) => {
        if (!isT3ThreadId(t?.threadId) || typeof t.title !== "string") return [];
        const at = typeof t.createdAt === "string" ? Date.parse(t.createdAt) : Number.NaN;
        return [{ threadId: t.threadId, title: t.title, createdAt: Number.isFinite(at) ? at : null }];
      });
    } catch {
      // The next.
    }
  }
  return null;
}

/** A run of T3's that is over (cli/thread.ts `TERMINAL_RUN_STATUSES`), and "idle": a thread with nothing running. */
const T3_ENDED_STATUSES = new Set(["idle", "completed", "failed", "cancelled", "interrupted", "rolled_back"]);

/**
 * Whether a T3 thread's turn has ended, from `t3 thread show --json` (`{ thread, messages }`, `thread` T3's
 * `OrchestratorMcpThreadDetail`): false while a run is active (`activeRunId`, or a status that is not over) or it
 * waits on the person's answer in T3 (`pendingRequestCount`); true when it is idle or its run is over; null when the
 * answer doesn't say.
 */
export function t3TurnEndedOf(stdout: string): boolean | null {
  for (const text of [stdout.trim(), stdout.trim().split("\n").pop() ?? ""]) {
    try {
      const thread = (JSON.parse(text) as { thread?: { status?: unknown; activeRunId?: unknown; pendingRequestCount?: unknown } } | null)?.thread;
      if (!thread || typeof thread.status !== "string") continue;
      if (typeof thread.activeRunId === "string" && thread.activeRunId) return false;
      if (typeof thread.pendingRequestCount === "number" && thread.pendingRequestCount > 0) return false;
      return T3_ENDED_STATUSES.has(thread.status);
    } catch {
      // The next.
    }
  }
  return null;
}

/** What a start of a launch noted first (`t3-start.json`), and how it ended. */
export interface T3StartAttempt {
  title: string;
  /** The threads of that title the project had before it. */
  before: string[];
  /** When it began (ms). */
  at: number;
  /**
   * "running": written before the start, and still so when the Inbox closed during it; "uncertain": it timed out, or
   * T3 answered with no thread; "refused": T3 said no; "started": it named its thread; "unlisted": T3 didn't list
   * the title's threads before it, so none can be told apart. Only "running" and "uncertain" may have made a thread
   * the Inbox doesn't know of, and only those are ever taken.
   */
  outcome: "running" | "uncertain" | "refused" | "started" | "unlisted";
}

/**
 * The thread a cut-short start of this launch made, from T3's threads of the title now: only after an uncertain end
 * (never after T3 refused, nor one that named its thread), only one that was not there before that start, not made
 * before it began (when T3 says when), and never a thread this Inbox already knows (another launch's, or one an
 * agent wrote from). Null: none, so a new start runs.
 */
export function t3AdoptableOf(attempt: T3StartAttempt | null, title: string, listed: { threadId: string; title: string; createdAt: number | null }[] | null, known: (thread: string) => boolean): string | null {
  if (!attempt || attempt.title !== title || (attempt.outcome !== "running" && attempt.outcome !== "uncertain") || !listed) return null;
  // A second of slack for two clocks on the same computer.
  const made = listed.find((t) => t.title === title && !attempt.before.includes(t.threadId) && (t.createdAt === null || t.createdAt >= attempt.at - 1_000) && !known(t.threadId));
  return made?.threadId ?? null;
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
 * no path in it. `machine`: this computer's name for linked machines, when it has one.
 */
export function t3StartCause(text: string, project: string, machine?: string | null): string {
  const last = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).pop() ?? "";
  if (T3_NO_PROJECT.test(last)) return `${project} isn't a project in T3 Code yet. Add its folder in T3 Code, then try again.`;
  if (T3_NOT_RUNNING.test(last)) return t3NotOpenWords(machine);
  const plain = t3WithoutPaths(last);
  const said = plain.length > CAUSE_MAX ? `${plain.slice(0, CAUSE_MAX - 1).trimEnd()}…` : plain;
  if (!said) return "T3 Code did not say why.";
  return /[.!?…]$/.test(said) ? said : `${said}.`;
}

/**
 * The `t3` to run, or null. A test run (PLANNOTATOR_TEST_SANDBOX) takes only one in its scratch home's temp folder,
 * never a `t3` on the person's PATH, so no test can start a thread in their real T3 Code.
 */
export function t3For(e: AgentEnvironment): string | null {
  const command = t3CommandOf(e);
  if (!command || !agentHomeAllowed(e)) return null;
  return agentHomeAllowed({ homeDir: command, env: e.env }) ? command : null;
}

/** The run line's cause for a `t3 thread start` that gave no thread: it timed out, said nothing usable, or refused. */
export function t3StartFailure(result: { timedOut?: boolean; exitCode: number | null; stdout: string; stderr: string }, project: string, machine?: string | null, timeoutMs = INBOX_T3_SEND_TIMEOUT_MS): string {
  if (result.timedOut) return `T3 Code didn't answer within ${Math.round(timeoutMs / 1000)} seconds. Try again: if it made the thread, the Inbox picks it up.`;
  if (result.exitCode === 0) return "T3 Code started a thread but didn't say which. Try again: the Inbox picks it up.";
  return t3StartCause(`${result.stdout}\n${result.stderr}`, project, machine);
}

/** The address T3's runtime file names for its server here (`server-runtime.json`'s `origin`, `port`), while it runs. */
function t3ServerAddressOf(t3Home: string): { origin: string; port: number } | null {
  if (!t3ServerOf(t3Home)) return null;
  try {
    const state = JSON.parse(readFileSync(join(t3Home, "userdata", "server-runtime.json"), "utf8")) as { origin?: unknown; port?: unknown };
    if (typeof state.port !== "number" || typeof state.origin !== "string") return null;
    return { origin: new URL(state.origin).origin, port: state.port };
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Lists = Omit<InboxLaunchChoices, "last">;

/** `work` within `ms`, else a rejection; what it gives after that goes to `late` (a connection to close). */
function withinMs<T>(work: Promise<T>, ms: number, late: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Error(`no answer within ${ms} ms`));
    }, ms);
    work.then(
      (value) => {
        if (done) return late(value);
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A read kept for `ttl`: while a new read runs, the older answer is given at once, so To never waits on T3 twice. */
function keptRead<T>(ttl: number, now: () => number) {
  const kept = new Map<string, { at: number; value: T | null; reading: Promise<T | null> | null }>();
  return (key: string, load: () => Promise<T | null>): Promise<T | null> => {
    let entry = kept.get(key);
    if (entry && now() - entry.at < ttl) return Promise.resolve(entry.value);
    if (!entry) {
      entry = { at: Number.NEGATIVE_INFINITY, value: null, reading: null };
      kept.set(key, entry);
    }
    const held = entry;
    held.reading ??= load()
      .catch(() => null)
      .then((value) => {
        held.value = value;
        held.at = now();
        held.reading = null;
        return value;
      });
    return held.value !== null ? Promise.resolve(held.value) : held.reading;
  };
}

/** `startTimeoutMs`: how long `t3 thread start` may take (30 s; a test makes it short). */
export function createT3LaunchHost(ctx: LaunchHostContext, options: { now?: () => number; startTimeoutMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const startTimeoutMs = options.startTimeoutMs ?? INBOX_T3_SEND_TIMEOUT_MS;
  const nothing = (text: string): LaunchHostResult => ({ exitCode: 0, text });
  /** Each provider instance's agent in words, as a signed-in T3 last named it. */
  const agentNames = new Map<string, string>();
  const agentOf = (instance: string) => agentNames.get(instance) ?? t3AgentName(instance);
  const capabilities = keptRead<Lists>(LISTS_TTL_MS, now);
  const used = keptRead<string>(LISTS_TTL_MS, now);

  const command = async (): Promise<{ e: AgentEnvironment; t3: string } | null> => {
    if (ctx.platform === "win32") return null;
    const e = await ctx.environment();
    const t3 = t3For(e);
    return t3 ? { e, t3 } : null;
  };

  /** A `t3` call in `cwd`, with the T3 wake's env (no stdin). */
  const runT3 = (found: { e: AgentEnvironment; t3: string }, args: string[], cwd?: string) =>
    found.e.run([found.t3, ...args], { timeoutMs: T3_READ_TIMEOUT_MS, ...(cwd ? { cwd } : {}), env: t3ChildEnv(found.e), cleanEnv: true });

  /** 1. A signed-in T3: the grant whose endpoint is the T3 server running here. */
  const signedInLists = async (e: AgentEnvironment): Promise<Lists | null> => {
    const address = t3ServerAddressOf(t3HomeOf(e));
    if (!address) return null;
    const grant = (await savedT3Grants(ctx.dataDir)).find((g) => g.endpoint.origin === address.origin || (LOOPBACK.has(g.endpoint.hostname) && Number(g.endpoint.port) === address.port));
    if (!grant) return null;
    return capabilities(`${grant.endpoint.href} ${grant.token() ?? ""}`, async () => {
      // The connect and the call share one limit: a T3 that never answers can't hold the lists (and the button) forever.
      const deadline = Date.now() + CAPABILITIES_TIMEOUT_MS;
      const rpc = await withinMs(connectT3(grant.endpoint, grant.token), CAPABILITIES_TIMEOUT_MS, (late) => void late.close?.().catch(() => {}));
      try {
        const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        const answer = await rpc.call("orchestrator_capabilities", {}, signal);
        for (const provider of ((answer as { providers?: unknown })?.providers ?? []) as { providerInstanceId?: unknown; driverKind?: unknown; displayName?: unknown }[]) {
          if (typeof provider?.providerInstanceId !== "string") continue;
          agentNames.set(provider.providerInstanceId, t3AgentName(provider.providerInstanceId, typeof provider.driverKind === "string" ? provider.driverKind : null, typeof provider.displayName === "string" ? provider.displayName : null));
        }
        return parseT3Capabilities(answer);
      } finally {
        await rpc.close?.().catch(() => {});
      }
    });
  };

  /** 2. No sign-in: what the projects' T3 threads used (`t3 thread list --json` in each folder). */
  const usedLists = async (found: { e: AgentEnvironment; t3: string }, folders: readonly string[]): Promise<Lists | null> => {
    const lists = await Promise.all(
      folders.slice(0, 12).map((folder) =>
        used(folder, async () => {
          const result = await runT3(found, ["thread", "list", "--json"], folder);
          return result.exitCode === 0 && !result.timedOut ? result.stdout : null;
        }),
      ),
    );
    return t3UsedModels(lists.filter((list): list is string => list !== null), agentOf);
  };

  /** The threads of `title` T3 has in the project of `folder` now; null when T3 didn't say. */
  const threadsTitled = async (found: { e: AgentEnvironment; t3: string }, folder: string, title: string) => {
    const result = await runT3(found, ["thread", "list", "--json"], folder);
    if (result.exitCode !== 0 || result.timedOut) return null;
    const listed = t3ListedThreadsOf(result.stdout);
    return listed ? listed.filter((t) => t.title === title) : null;
  };

  /** What each start of a launch noted first (its title, the threads of that title the project had then, when) and how it ended. */
  const attemptFile = (id: string) => join(ctx.launchDir(id), "t3-start.json");
  const readAttempt = (id: string): T3StartAttempt | null => {
    try {
      const said = JSON.parse(readFileSync(attemptFile(id), "utf8")) as { title?: unknown; before?: unknown; at?: unknown; outcome?: unknown };
      if (typeof said.title !== "string" || !Array.isArray(said.before)) return null;
      const outcome = said.outcome === "uncertain" || said.outcome === "refused" || said.outcome === "started" || said.outcome === "unlisted" ? said.outcome : "running";
      return { title: said.title, before: said.before.filter((id): id is string => typeof id === "string"), at: typeof said.at === "number" ? said.at : 0, outcome };
    } catch {
      return null;
    }
  };
  const writeAttempt = (id: string, attempt: T3StartAttempt) => {
    try {
      mkdirSync(ctx.launchDir(id), { recursive: true, mode: 0o700 });
      writeFileSync(attemptFile(id), `${JSON.stringify(attempt)}\n`, { mode: 0o600 });
    } catch {
      // Then a cut start can't be picked up: Try again starts a new thread, as without the note.
    }
  };

  return {
    agent: INBOX_T3_HOST,
    name: INBOX_T3_NAME,
    // What its agents reach the Inbox through: the run line's "Is Plannotator's … on in that folder?".
    connector: "Inbox MCP server",
    shellNames: [],
    startsWithTurn: true,
    worktree: true,
    interruptedStart: T3_LAUNCH_INTERRUPTED,
    connectWaitMs: T3_CONNECT_WAIT_MS,
    // A model T3 no longer lists is refused there: never picked again by itself.
    lastMustBeListed: true,

    async available(): Promise<LaunchAvailability> {
      // Not on Windows: `t3.cmd` goes through cmd.exe, which the T3 wake does not trust with a message either.
      // A test run uses T3 only in a scratch home, never the person's own ~/.t3 or a `t3` on their PATH.
      if (!(await command())) return { ok: false, missing: true, reason: T3_LAUNCH_MISSING, code: "missing" };
      return { ok: true, version: "" };
    },

    async choices(folders: readonly string[] = []): Promise<Lists | null> {
      const found = await command();
      // T3 not open: no lists (a start would be refused anyway).
      if (!found || !t3ServerOf(t3HomeOf(found.e))) return null;
      const signed = await signedInLists(found.e).catch(() => null);
      if (signed) return signed;
      return folders.length > 0 ? usedLists(found, folders) : null;
    },

    async innerOf(ref: string): Promise<InboxLaunchInner | null> {
      const found = await command();
      if (!found || !isT3ThreadId(ref)) return null;
      const result = await runT3(found, ["thread", "show", ref, "--messages=0", "--json"]);
      if (result.exitCode !== 0 || result.timedOut) return null;
      const runs = t3ThreadRunsOf(result.stdout);
      return runs ? { ...runs, agent: agentOf(runs.provider) } : null;
    },

    /** `t3 thread show`: whether the thread's run is over (T3's `status`, `activeRunId`, `pendingRequestCount`); null when T3 can't be asked. */
    async turnEnded(ref: string): Promise<boolean | null> {
      const found = await command();
      if (!found || !isT3ThreadId(ref)) return null;
      const result = await runT3(found, ["thread", "show", ref, "--messages=0", "--json"]);
      if (result.exitCode !== 0 || result.timedOut) return null;
      return t3TurnEndedOf(result.stdout);
    },

    startsIn(folder: string | null): string | null {
      if (folder === null) return T3_LAUNCH_NEW_FOLDER;
      const repo = gitRepoOf(folder);
      // A repository at home or above it (dotfiles) holds every folder under it: never a project's own.
      if (repo && !coversHome(repo.top, ctx.homeDir)) return null;
      return `${ctx.displayFolder(folder)} isn't a git repository. T3 Code starts its work in a new worktree of one.`;
    },

    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    trusts: () => true,

    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv; firstTurn?: string }) {
      const found = await command();
      if (!found) return { ok: false as const, code: "missing" as const, text: `${T3_LAUNCH_MISSING}.` };
      const project = basename(launch.folder);
      const base = t3BaseOf(launch.folder);
      if (!base) return { ok: false as const, code: "failed" as const, text: `${ctx.displayFolder(launch.folder)} isn't a git repository any more.` };
      const message = input.firstTurn ?? "";
      if (!message.trim()) return { ok: false as const, code: "failed" as const, text: "The message is empty." };
      const title = input.name.replace(/\s+/g, " ").trim();
      // A start before this one that ended uncertain (cut by the timeout, an answer with no thread, an Inbox that
      // closed) may have made the thread: a new thread of its title made since then, that no launch or agent here
      // has, is that one, never a second. After a plain refusal nothing was made: a new start runs.
      const before = readAttempt(launch.id);
      const listed = await threadsTitled(found, launch.folder, title);
      const made = t3AdoptableOf(before, title, listed, (thread) => ctx.sessionKnown?.(thread) === true);
      if (made) {
        writeAttempt(launch.id, { ...before!, outcome: "started" });
        ctx.startLog(launch.id, `T3 thread ${made}, made by an earlier start of this launch: taken, no second thread`);
        return { ok: true as const, session: made, ref: made };
      }
      // A model T3 no longer lists (a signed-in T3 says which it has) is refused before T3 is asked: its words, plainly.
      const listedModels = launch.model ? await signedInLists(found.e).catch(() => null) : null;
      if (launch.model && listedModels && !listedModels.models.includes(launch.model)) {
        const words = t3ModelOf(launch.model) ? `${agentOf(t3ModelOf(launch.model)!.provider)} · ${t3ModelOf(launch.model)!.model}` : launch.model;
        return { ok: false as const, code: "failed" as const, text: `T3 Code no longer lists ${words}. Send it again with another model.` };
      }
      const startedAt = Date.now();
      // T3 didn't list the title's threads first: nothing would tell a thread this start made from an older one, so
      // none is ever taken for it ("unlisted").
      writeAttempt(launch.id, { title, before: (listed ?? []).map((t) => t.threadId), at: startedAt, outcome: listed ? "running" : "unlisted" });
      const argv = [found.t3, "thread", "start", ".", "-", `--worktree=${base}`, ...(title ? [`--title=${title}`] : []), ...t3LaunchChoiceArgs({ model: launch.model, effort: launch.effort }), "--json"];
      const env = { ...t3ChildEnv(found.e), ...(input.login.PATH ? { PATH: input.login.PATH } : {}) };
      const result = await found.e.run(argv, { timeoutMs: startTimeoutMs, cwd: launch.folder, env, cleanEnv: true, stdin: message });
      // The message is never written down here: only the command and what T3 said.
      ctx.startLog(launch.id, `${["t3", ...argv.slice(1)].map((arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : shellQuote(arg))).join(" ")} (in ${launch.folder}, the message on stdin)\nexit ${result.timedOut ? "timed out" : result.exitCode}\n${`${result.stdout}\n${result.stderr}`.trim().slice(-2000)}`);
      const thread = !result.timedOut && result.exitCode === 0 ? t3StartedThreadOf(result.stdout) : null;
      // How it ended decides whether a later Try again may take a thread it made: only when T3 didn't say.
      writeAttempt(launch.id, { title, before: (listed ?? []).map((t) => t.threadId), at: startedAt, outcome: !listed ? "unlisted" : thread ? "started" : result.timedOut || result.exitCode === 0 ? "uncertain" : "refused" });
      if (!thread) return { ok: false as const, code: "failed" as const, text: t3StartFailure(result, project, ctx.machineName?.() ?? null, startTimeoutMs) };
      ctx.startLog(launch.id, `T3 thread ${thread}, in a new worktree from ${base}`);
      return { ok: true as const, session: thread, ref: thread };
    },

    // T3 keeps the thread: there is nothing to list, stop or start again from here.
    sessions: async () => null,
    /**
     * Its Claude's Plannotator mod, where it polls as the thread, says when a turn runs. Otherwise the thread is
     * T3's, alive as long as T3 keeps it, and never started again by a reply (the T3 wake sends it in). Whether its
     * agent ever reached the Inbox is the engine's (`connectWaitMs`).
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
