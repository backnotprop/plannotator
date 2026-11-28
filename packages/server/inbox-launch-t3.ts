/**
 * Start an agent in T3 Code (issue #3590): Settings → Agents' "Start new agents in" T3 Code, as Rex is. The person
 * picks Claude Code (or Codex, OpenCode, Pi) in New message as always; the Inbox starts it as a new thread of T3 Code
 * on that agent, with the person's message as its first turn. The thread is T3's from then on: its permission prompts
 * wait in T3's own app, it has no Stop from here, and the person's replies go in through the T3 wake that exists
 * already (`t3 thread send`, inbox-t3-local.ts). This is not a host To offers: the engine runs it for a launch that
 * asked for T3 Code (`InboxLaunchRecord.t3`), and when T3 Code isn't open or says no, the agent's own host starts it in
 * the background instead and the run line says why.
 *
 * The one start command, T3's documented host command for outside scripts (T3's docs/user/outside-agents.md, "Scripts
 * on the host"; the flags as T3's own `apps/server/src/cli/thread.ts` declares them):
 *
 *   t3 thread start . - --title=<thread name> --provider=<instance> --model=<slug> --json
 *
 * run in the project's folder (`.` is the T3 project that holds it), the message on stdin (`-`), so no shell and no
 * process list ever sees it. No `--worktree`: T3 starts the thread where its own New thread would (its project's
 * setting). Each value goes after "=", so a thread name that starts with "-" is never read as a flag. Its env is the
 * T3 wake's (`t3ChildEnv`), with the person's login PATH. `--json` prints `{ threadId, projectId, runId }`.
 *
 * The model. T3 needs one for a project with no default (a folder it has just added: "Pass modelSelection: the project
 * has no default model."), and `--provider` goes only with `--model`. In this order, asking nothing of the person:
 *
 *  1. T3 already ran this agent in the project: the model of its newest thread on that agent (`t3 thread list --json`,
 *     which T3's own CLI answers with a short-lived session of its own).
 *  2. Otherwise T3's own first model for that agent, from `orchestrator_capabilities`, which T3 lists only to a client
 *     holding a token. The Inbox asks the person's own T3 for one (`t3AskModels`): a read-only MCP client session that
 *     lives a minute (`t3 auth session issue --scope=orchestration:read --subject=mcp-client --ttl=1m --json`), held
 *     in memory for that one call to the T3 on this computer's loopback address, then revoked (`t3 auth session
 *     revoke`). It is never written to disk, logged, or sent anywhere else.
 *  3. Neither: T3 can't run it, so it starts in the background.
 *
 * A folder T3 doesn't know is added as a T3 project first (`t3 project add`, inbox-launch-t3-ready.ts).
 *
 * `t3 thread start` takes no request id, so a start cut short (no answer in 30 s, an Inbox closed mid-start) may have
 * made the thread: the line says so with Try again, which takes that thread rather than make a second. Each start
 * notes the threads of that title the project has, and then how it ended (`t3-start.json` in the launch's folder);
 * only after an uncertain end does a later start take a thread of that title made since, and never one that is another
 * launch's or another Inbox thread's (`t3AdoptableOf`). Once that start's agent wrote in the thread, nothing new ever
 * starts for it: the engine settles it on its thread (`adopt`, `wrote`).
 *
 * The run line's "not connected" (`connectWaitMs`) shows only once `t3 thread show` says the thread's run is over
 * (`turnEnded`), so a long first turn is never called not connected. Not on Windows, where the T3 wake does not run
 * `t3` either.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_T3_DRIVERS, inboxLaunchTokenOk, t3AgentName, t3ListedModelOf, t3NewestModelOf, type T3ModelPick } from "@plannotator/core/inbox-launch-choice";
import { INBOX_T3_HOST, INBOX_T3_NAME, isT3ThreadId, type InboxLaunchInner, type InboxLaunchRecord, type InboxMessage } from "@plannotator/core/inbox-types";
import { agentHomeAllowed, type AgentEnvironment } from "./inbox-agents";
import { shellQuote } from "./inbox-launch-claude";
import type { LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchHost, LaunchHostContext, LaunchHostResult, LaunchLive, LaunchStartAway } from "./inbox-launch-host";
import { INBOX_T3_SEND_TIMEOUT_MS, t3ChildEnv, t3CommandOf, t3HomeOf, t3ServerOf } from "./inbox-t3-local";
import { connectT3 } from "./inbox-t3-wake";
import { T3_NOT_RUNNING, t3LastLine, t3ProjectAdded } from "./inbox-launch-t3-ready";

/** The run line's cause for a start the Inbox closed during: its Try again takes a thread that start made. */
export const T3_LAUNCH_INTERRUPTED = "The Inbox closed while T3 Code was starting. Try again: if T3 Code made the thread, the Inbox picks it up.";
/** How long after the start the run line waits for the thread's agent to reach the Inbox before it says it isn't connected. */
export const T3_CONNECT_WAIT_MS = 10 * 60_000;
/** A `t3 thread list`, `show`, `project add` or `auth session` call may take this long. */
const T3_READ_TIMEOUT_MS = 10_000;
/** T3's MCP connect and its `orchestrator_capabilities` answer share this limit. */
const CAPABILITIES_TIMEOUT_MS = 5_000;
/** How long the read-only token T3 issues for the model list lives (it is revoked as soon as the list is read). */
export const T3_TOKEN_TTL = "1m";
/** The client name the person's T3 shows for that token's session while it lives (Settings → Connections in T3). */
export const T3_TOKEN_LABEL = "Plannotator Inbox";

/**
 * T3's words for a start whose `--option`s it doesn't take: its model doesn't (OrchestratorMcpService: "Model …
 * rejected options: …"), or its CLI has no `--option` flag at all (Effect's CLI parser: "Unrecognized flag: --option
 * in command …", as T3's vendored `effect/cli` CliError words it). Either way only the effort went unused.
 */
export const T3_OPTIONS_REFUSED = /rejected options|Unrecognized flag: --option\b/i;

export const T3_LAUNCH_MISSING = "T3 Code's t3 command is not on this computer";

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
 * waits on the person's answer in T3 (`pendingRequestCount`); "failed" when its run failed; true when it is idle or
 * its run is otherwise over; null when the answer doesn't say.
 */
export function t3TurnEndedOf(stdout: string): boolean | "failed" | null {
  for (const text of [stdout.trim(), stdout.trim().split("\n").pop() ?? ""]) {
    try {
      const thread = (JSON.parse(text) as { thread?: { status?: unknown; activeRunId?: unknown; pendingRequestCount?: unknown } } | null)?.thread;
      if (!thread || typeof thread.status !== "string") continue;
      if (typeof thread.activeRunId === "string" && thread.activeRunId) return false;
      if (typeof thread.pendingRequestCount === "number" && thread.pendingRequestCount > 0) return false;
      return thread.status === "failed" ? "failed" : T3_ENDED_STATUSES.has(thread.status);
    } catch {
      // The next.
    }
  }
  return null;
}

/** What a start of a launch noted first (`t3-start.json`), and how it ended. */
export interface T3StartAttempt {
  title: string;
  /** The threads of that title the project had before it (none known when `listed` is false). */
  before: string[];
  /** Whether T3 listed the project's threads before it: false, `before` says nothing and only T3's times tell. */
  listed: boolean;
  /** When it began (ms). */
  at: number;
  /**
   * "running": written before the start, and still so when the Inbox closed during it; "uncertain": it timed out
   * (`timedOut`), or T3 answered with no thread; "refused": T3 said no; "started": it named its thread. Only "running"
   * and "uncertain" may have made a thread the Inbox doesn't know of, and only those are ever taken.
   */
  outcome: "running" | "uncertain" | "refused" | "started";
  timedOut?: boolean;
}

/** Whether a start of a launch may have made a thread no one has taken yet: the Inbox closed during it, or it ended uncertain. */
export const t3MayHaveMade = (attempt: T3StartAttempt | null): boolean => attempt?.outcome === "running" || attempt?.outcome === "uncertain";

/**
 * The thread a cut-short start of this launch made, from T3's threads of the title now: only after an uncertain end
 * (never after T3 refused, nor one that named its thread); one that was not there before that start (when T3 listed
 * them then) and not made before it began (when T3 says when; with no list before it, only a thread T3 gives a time
 * for); never one that is another launch's or another Inbox thread's (`elsewhere`), while one whose agent already
 * wrote in this launch's own thread is still this launch's. Exactly one such thread, or none: two can't be told apart.
 * Null: none, so a new start runs.
 */
export function t3AdoptableOf(attempt: T3StartAttempt | null, title: string, listed: { threadId: string; title: string; createdAt: number | null }[] | null, elsewhere: (thread: string) => boolean): string | null {
  if (!attempt || attempt.title !== title || !t3MayHaveMade(attempt) || !listed) return null;
  // A second of slack for two clocks on the same computer.
  const since = (t: { createdAt: number | null }) => (t.createdAt === null ? attempt.listed : t.createdAt >= attempt.at - 1_000);
  const made = listed.filter((t) => t.title === title && !(attempt.listed && attempt.before.includes(t.threadId)) && since(t) && !elsewhere(t.threadId));
  return made.length === 1 ? made[0]!.threadId : null;
}

/** An agent's words in the Inbox, as `t3LaunchWriterOf` reads them. */
type Written = Pick<InboxMessage, "author" | "created_at" | "to" | "tags">;

/**
 * The agent a T3 start of this launch put in its thread, known by what it wrote in this Inbox thread. T3 gives its
 * thread's id (`T3CODE_THREAD_ID`) only to the Claude it runs, which writes as that thread (host "t3"); Codex,
 * OpenCode and Pi write under their own session ids, and nothing T3 says (`thread show`/`list`) names those. The thread
 * id is told only to the agent of that thread, in the first turn the start put in. So: the first agent message here
 * since the start, from a session of the launch's own agent (`agent`) or a T3 thread (`own`, the thread the launch
 * is on, once known), whose first words in this Inbox are in this thread (`firstThreadOf`), that no person's message
 * here is addressed to or tags (an agent the person brought in), and that is no other launch's (`elsewhere`). Another
 * session of the same agent in the same folder never counts unless it wrote here first. Null: none has.
 */
export function t3LaunchWriterOf(messages: readonly Written[], at: { threadId: string; agent: string; since: number; own: string | null }, firstThreadOf: (session: string) => string | null, elsewhere: (session: string) => boolean): { host: string; session: string } | null {
  // Oldest first: an agent the person brought in before it wrote (a reply to the agent afterwards changes nothing).
  const brought = new Set<string>();
  for (const m of messages) {
    if (m.author.kind === "person") {
      if (m.to) brought.add(m.to.session);
      for (const tag of m.tags ?? []) brought.add(tag.session);
    }
    if (m.author.kind !== "agent" || !m.author.session || m.author.session.startsWith("launch:")) continue;
    const { host, session } = { host: m.author.host ?? "", session: m.author.session };
    const ours = host === at.agent || (host === INBOX_T3_HOST && isT3ThreadId(session) && (at.own === null || at.own === session));
    if (!ours || !(Date.parse(m.created_at) >= at.since - 1_000) || (brought.has(session) && session !== at.own)) continue;
    if (firstThreadOf(session) !== at.threadId || elsewhere(session)) continue;
    return { host, session };
  }
  return null;
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

/** The run line's cause for a `t3 thread start` that may have made its thread without saying so: Try again takes it. */
export function t3StartUncertain(result: { timedOut?: boolean }, timeoutMs = INBOX_T3_SEND_TIMEOUT_MS): string {
  if (result.timedOut) return `T3 Code didn't answer within ${Math.round(timeoutMs / 1000)} seconds. Try again: if it made the thread, the Inbox picks it up.`;
  return "T3 Code started a thread but didn't say which. Try again: the Inbox picks it up.";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * T3's server on this computer, from the runtime file it writes while it runs (`server-runtime.json`'s `origin`), and
 * only on a loopback address: the token for the model list is never sent anywhere else.
 */
export function t3LocalOrigin(t3Home: string): URL | null {
  if (!t3ServerOf(t3Home)) return null;
  try {
    const state = JSON.parse(readFileSync(join(t3Home, "userdata", "server-runtime.json"), "utf8")) as { origin?: unknown };
    if (typeof state.origin !== "string") return null;
    const origin = new URL(state.origin);
    return origin.protocol === "http:" && LOOPBACK.has(origin.hostname) ? new URL(origin.origin) : null;
  } catch {
    return null;
  }
}

/** `issue --json`'s answer (T3's `formatIssuedSession`, pretty-printed): the session and its bearer token; null otherwise. */
export function t3IssuedSessionOf(stdout: string): { sessionId: string; token: string } | null {
  try {
    const said = JSON.parse(stdout.trim()) as { sessionId?: unknown; token?: unknown } | null;
    if (typeof said?.sessionId !== "string" || !/^[\w.:-]{1,200}$/.test(said.sessionId) || typeof said.token !== "string" || !said.token) return null;
    return { sessionId: said.sessionId, token: said.token };
  } catch {
    return null;
  }
}

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

/** A command and its arguments as start.log shows it: quoted where a shell would need it. Never given a token. */
const shown = (argv: readonly string[]) => ["t3", ...argv].map((arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : shellQuote(arg))).join(" ");

/** A model to start on: T3's provider instance and model slug, and `--option`s (`effort=<v>`, only with the person's own pick). */
export interface T3StartPick extends T3ModelPick {
  options: string[];
}

/**
 * The person's pick in New message, as T3 takes it: the agent's own T3 instance (its driver's built-in, `--provider`),
 * the model as picked (`--model`), and the effort picked with it (`--option=effort=<v>`; T3's options belong to a
 * model, so none without one). Null when nothing was picked, or a value isn't plain.
 */
export function t3PickedOf(launch: Pick<InboxLaunchRecord, "model" | "effort">, driver: string): T3StartPick | null {
  if (!launch.model || !inboxLaunchTokenOk(launch.model)) return null;
  return { provider: driver, model: launch.model, options: launch.effort && inboxLaunchTokenOk(launch.effort) ? [`effort=${launch.effort}`] : [] };
}

/** `startTimeoutMs`: how long `t3 thread start` may take (30 s; a test makes it short). */
export function createT3LaunchHost(ctx: LaunchHostContext, options: { startTimeoutMs?: number } = {}) {
  const startTimeoutMs = options.startTimeoutMs ?? INBOX_T3_SEND_TIMEOUT_MS;
  const nothing = (text: string): LaunchHostResult => ({ exitCode: 0, text });

  type Found = { e: AgentEnvironment; t3: string };
  const command = async (): Promise<Found | null> => {
    if (ctx.platform === "win32") return null;
    const e = await ctx.environment();
    const t3 = t3For(e);
    return t3 ? { e, t3 } : null;
  };

  /** A `t3` call in `cwd`, with the T3 wake's env (no stdin). */
  const runT3 = (found: Found, args: string[], cwd?: string) => found.e.run([found.t3, ...args], { timeoutMs: T3_READ_TIMEOUT_MS, ...(cwd ? { cwd } : {}), env: t3ChildEnv(found.e), cleanEnv: true });

  /**
   * T3's first model for this agent, from `orchestrator_capabilities`, under a token the person's own T3 issues for
   * this one read: read-only (`orchestration:read`, as T3's own `mcpClientScopes("read-only")`), an MCP client's
   * (`mcp-client`, the only subject T3's `/mcp` takes), living a minute. The token is held in this function's memory
   * only: never on a command line, in start.log or the debug log, on disk, or sent anywhere but T3's own loopback
   * `/mcp`. Revoked once the list is read, whatever it said. Null when T3 issued none or listed nothing for the agent.
   */
  const t3AskModels = async (found: Found, launchId: string, driver: string): Promise<T3ModelPick | null> => {
    const origin = t3LocalOrigin(t3HomeOf(found.e));
    if (!origin) return null;
    const issueArgs = ["auth", "session", "issue", "--scope=orchestration:read", "--subject=mcp-client", `--ttl=${T3_TOKEN_TTL}`, `--label=${T3_TOKEN_LABEL}`, "--json"];
    const issued = await runT3(found, issueArgs);
    // Only the command and how it ended: what it printed holds the token.
    ctx.startLog(launchId, `${shown(issueArgs)} (a read-only token for one read of T3 Code's models; never kept)\nexit ${issued.timedOut ? "timed out" : issued.exitCode}${issued.exitCode === 0 ? "" : `\n${t3LastLine(issued.stderr).slice(0, 300)}`}`);
    const session = !issued.timedOut && issued.exitCode === 0 ? t3IssuedSessionOf(issued.stdout) : null;
    if (!session) return null;
    let token: string | undefined = session.token;
    let rpc: Awaited<ReturnType<typeof connectT3>> | null = null;
    try {
      const deadline = Date.now() + CAPABILITIES_TIMEOUT_MS;
      rpc = await withinMs(
        connectT3(new URL("/mcp", origin), () => token),
        CAPABILITIES_TIMEOUT_MS,
        (late) => void late.close?.().catch(() => {}),
      );
      const answer = await rpc.call("orchestrator_capabilities", {}, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      const pick = t3ListedModelOf(answer, driver);
      ctx.startLog(launchId, pick ? `T3 Code lists ${pick.provider} · ${pick.model} first for this agent` : "T3 Code lists no model for this agent");
      return pick;
    } catch (error) {
      ctx.startLog(launchId, `T3 Code's model list wasn't read: ${error instanceof Error ? error.message.slice(0, 200) : "no answer"}`);
      return null;
    } finally {
      token = undefined;
      await rpc?.close?.().catch(() => {});
      // Revoked at once, not left to its minute. Not waited on: the start goes on meanwhile.
      const revokeArgs = ["auth", "session", "revoke", session.sessionId];
      void runT3(found, revokeArgs)
        .then((result) => ctx.startLog(launchId, `${shown(revokeArgs)}\nexit ${result.timedOut ? "timed out" : result.exitCode}`))
        .catch(() => {});
    }
  };

  /** What each start of a launch noted first (its title, the threads of that title the project had then, when) and how it ended. */
  const attemptFile = (id: string) => join(ctx.launchDir(id), "t3-start.json");
  const readAttempt = (id: string): T3StartAttempt | null => {
    try {
      const said = JSON.parse(readFileSync(attemptFile(id), "utf8")) as { title?: unknown; before?: unknown; listed?: unknown; at?: unknown; outcome?: unknown; timedOut?: unknown };
      if (typeof said.title !== "string" || !Array.isArray(said.before)) return null;
      // "unlisted" (this branch's first form): no list before it, and how it ended not kept, so it may have made one.
      const listed = said.listed !== false && said.outcome !== "unlisted";
      const outcome = said.outcome === "uncertain" || said.outcome === "refused" || said.outcome === "started" ? said.outcome : said.outcome === "unlisted" ? "uncertain" : "running";
      return { title: said.title, before: said.before.filter((id): id is string => typeof id === "string"), listed, at: typeof said.at === "number" ? said.at : 0, outcome, ...(said.timedOut === true ? { timedOut: true } : {}) };
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

  const away = (why: LaunchStartAway, text: string) => ({ ok: false as const, code: "failed" as const, text, away: why });

  /** The folder's T3 threads of `title` (null when T3 didn't list them), and T3's list result. */
  const listTitled = async (found: Found, folder: string, title: string) => {
    const list = await runT3(found, ["thread", "list", "--json"], folder);
    const listed = list.exitCode === 0 && !list.timedOut ? t3ListedThreadsOf(list.stdout) : null;
    return { list, titled: listed ? listed.filter((t) => t.title === title) : null };
  };

  /**
   * A thread an earlier start of this launch made and no one took (`t3AdoptableOf`), from `titled`: noted as this
   * launch's ("started") and returned; null when none. Never one another launch or Inbox thread has.
   */
  const adoptFrom = (launch: InboxLaunchRecord, title: string, titled: ReturnType<typeof t3ListedThreadsOf>): string | null => {
    const before = readAttempt(launch.id);
    const made = t3AdoptableOf(before, title, titled, (thread) => ctx.sessionElsewhere?.(thread, launch.id) === true);
    if (!made) return null;
    writeAttempt(launch.id, { ...before!, outcome: "started" });
    ctx.startLog(launch.id, `T3 thread ${made}, made by an earlier start of this launch: taken, no second thread`);
    return made;
  };

  /**
   * The line an uncertain earlier start showed, again, for a start that won't run beside the thread it may have made
   * (its agent wrote in the thread, or T3 can't list the threads to find it now): the same Try again.
   */
  const stillUnsure = (launch: InboxLaunchRecord) => {
    const before = readAttempt(launch.id);
    return { ok: false as const, code: "failed" as const, text: before?.outcome === "uncertain" ? t3StartUncertain({ timedOut: before.timedOut === true }, startTimeoutMs) : T3_LAUNCH_INTERRUPTED };
  };

  return {
    agent: INBOX_T3_HOST,
    name: INBOX_T3_NAME,
    // What its agents reach the Inbox through: the run line's "Is Plannotator's … on in that folder?".
    connector: "Inbox MCP server",
    shellNames: [],
    startsWithTurn: true,
    interruptedStart: T3_LAUNCH_INTERRUPTED,
    connectWaitMs: T3_CONNECT_WAIT_MS,

    async available(): Promise<LaunchAvailability> {
      // Not on Windows: `t3.cmd` goes through cmd.exe, which the T3 wake does not trust with a message either.
      // A test run uses T3 only in a scratch home, never the person's own ~/.t3 or a `t3` on their PATH.
      if (!(await command())) return { ok: false, missing: true, reason: T3_LAUNCH_MISSING, code: "missing" };
      return { ok: true, version: "" };
    },

    /** Settings → Agents: T3 Code is on this computer (`installed`, its `t3`), and open now (its server's runtime file). */
    async here(): Promise<{ installed: boolean; open: boolean }> {
      const found = await command();
      return { installed: !!found, open: !!found && t3ServerOf(t3HomeOf(found.e)) !== null };
    },

    /** `t3 thread show`: whether the thread's run is over (T3's `status`, `activeRunId`, `pendingRequestCount`); null when T3 can't be asked. */
    async turnEnded(ref: string): Promise<boolean | "failed" | null> {
      const found = await command();
      if (!found || !isT3ThreadId(ref)) return null;
      const result = await runT3(found, ["thread", "show", ref, "--messages=0", "--json"]);
      if (result.exitCode !== 0 || result.timedOut) return null;
      return t3TurnEndedOf(result.stdout);
    },

    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    trusts: () => true,

    /**
     * Start `launch.agent` (Claude Code, Codex, OpenCode, Pi) as a T3 thread in exactly `launch.folder`. `away`: it
     * didn't start there and nothing was made, so the engine starts it in the background (`absent`: T3 Code isn't open
     * here; `refused`: T3 said no, `why` and `declined` saying what). A failure with no `away` may have made the thread
     * (it timed out): its Try again takes that thread. `declined` on a start: the person's model T3 refused, so it
     * runs on T3's own instead.
     */
    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv; firstTurn?: string; wrote?: boolean }) {
      const found = await command();
      // Its agent already wrote in the thread (`wrote`): an earlier start made the thread, so this one only takes it,
      // and never starts a second agent on the message, here or in the background.
      if (input.wrote && (!found || !t3ServerOf(t3HomeOf(found.e)))) return stillUnsure(launch);
      if (!found) return away("absent", `${T3_LAUNCH_MISSING}.`);
      if (!t3ServerOf(t3HomeOf(found.e))) return away("absent", "T3 Code isn't open on this computer.");
      const driver = INBOX_T3_DRIVERS[launch.agent];
      if (!driver) return away("refused", `T3 Code doesn't run ${launch.agent}.`);
      const message = input.firstTurn ?? "";
      if (!message.trim()) return { ok: false as const, code: "failed" as const, text: "The message is empty." };
      const title = input.name.replace(/\s+/g, " ").trim();
      const said = (result: { stdout: string; stderr: string }) => `${result.stdout}\n${result.stderr}`;

      // The folder as a T3 project of its own, every time: T3 runs `.` in the deepest project holding it, or in another
      // checkout of the same repository (its `resolveProject`), so without this a folder inside another project, or a
      // git worktree of a repository T3 has, would run in that other folder. "Already exists" is the folder's own.
      const added = await runT3(found, ["project", "add", launch.folder], launch.folder);
      ctx.startLog(launch.id, `${shown(["project", "add", launch.folder])}\nexit ${added.timedOut ? "timed out" : added.exitCode}\n${said(added).trim().slice(-2000)}`);
      if (!t3ProjectAdded(added)) {
        if (input.wrote) return stillUnsure(launch);
        if (T3_NOT_RUNNING.test(t3LastLine(said(added)))) return away("absent", "T3 Code isn't open on this computer.");
        return { ...away("refused", "T3 Code didn't add the folder as a project."), why: "project" as const };
      }

      // The project's threads (T3's own CLI reads them under a session of its own).
      const { list, titled } = await listTitled(found, launch.folder, title);
      if (list.exitCode !== 0 && T3_NOT_RUNNING.test(t3LastLine(said(list)))) return input.wrote ? stillUnsure(launch) : away("absent", "T3 Code isn't open on this computer.");

      // A start before this one that ended uncertain (cut by the timeout, an answer with no thread, an Inbox that
      // closed) may have made the thread: a new thread of its title made since then, that no other launch or Inbox
      // thread has, is that one, never a second. After a plain refusal nothing was made: a new start runs.
      const made = adoptFrom(launch, title, titled);
      if (made) return { ok: true as const, session: made, ref: made };
      // Its agent wrote, or T3 lists nothing now to find an earlier start's thread by: no second start beside it.
      if (input.wrote || (titled === null && t3MayHaveMade(readAttempt(launch.id)))) return stillUnsure(launch);

      // The model, as Rex starts it: the person's pick in New message (and its effort). None picked: the one T3 last
      // ran this agent on in this project, else T3's own first for it (asked under a token, only then).
      const picked = t3PickedOf(launch, driver);
      const newest = list.exitCode === 0 ? t3NewestModelOf(list.stdout, driver) : null;
      let asked = false;
      const ask = async () => (asked ? null : ((asked = true), await t3AskModels(found, launch.id, driver)));
      let pick: T3StartPick | null = picked ?? (newest ? { ...newest, options: [] } : null) ?? (await ask().then((m) => (m ? { ...m, options: [] } : null)));
      if (!pick) return { ...away("refused", "T3 Code has no model for this agent."), why: "no_model" as const };

      const env = { ...t3ChildEnv(found.e), ...(input.login.PATH ? { PATH: input.login.PATH } : {}) };
      /** One `t3 thread start` on `on`, noted before and after (`t3-start.json`), with the command and T3's words in start.log. */
      const attempt = async (on: T3StartPick) => {
        const argv = [found.t3, "thread", "start", ".", "-", ...(title ? [`--title=${title}`] : []), `--provider=${on.provider}`, `--model=${on.model}`, ...on.options.map((o) => `--option=${o}`), "--json"];
        const startedAt = Date.now();
        // T3 didn't list the title's threads first (`listed` false): only T3's own times then tell a thread this start
        // made from an older one.
        const noted = { title, before: (titled ?? []).map((t) => t.threadId), listed: titled !== null, at: startedAt };
        writeAttempt(launch.id, { ...noted, outcome: "running" });
        const result = await found.e.run(argv, { timeoutMs: startTimeoutMs, cwd: launch.folder, env, cleanEnv: true, stdin: message });
        // The message is never written down here: only the command and what T3 said.
        ctx.startLog(launch.id, `${shown(argv.slice(1))} (in ${launch.folder}, the message on stdin)\nexit ${result.timedOut ? "timed out" : result.exitCode}\n${said(result).trim().slice(-2000)}`);
        const thread = !result.timedOut && result.exitCode === 0 ? t3StartedThreadOf(result.stdout) : null;
        // How it ended decides whether a later Try again may take a thread it made: only when T3 didn't say.
        writeAttempt(launch.id, { ...noted, outcome: thread ? "started" : result.timedOut || result.exitCode === 0 ? "uncertain" : "refused", ...(result.timedOut ? { timedOut: true } : {}) });
        return { result, thread };
      };
      // What T3 didn't take of the person's pick: their model, or only their effort.
      let declined: string | undefined;
      let declinedEffort: string | undefined;
      const refusedOf = () => ({ ...(declined ? { declined } : {}), ...(declinedEffort ? { declined_effort: declinedEffort } : {}) });
      for (let tries = 0; ; tries++) {
        const { result, thread } = await attempt(pick);
        if (thread) {
          const inner: InboxLaunchInner = { provider: pick.provider, model: pick.model, agent: t3AgentName(pick.provider, driver) };
          ctx.startLog(launch.id, `T3 thread ${thread}, on ${inner.agent} · ${inner.model}`);
          // Started on T3's own model after the project's newest one was refused: nothing of the person's was refused.
          return { ok: true as const, session: thread, ref: thread, inner, ...(picked ? refusedOf() : {}) };
        }
        // It may have made the thread: the line says so, and its Try again takes it. Never a second start beside it.
        if (result.timedOut || result.exitCode === 0) return { ok: false as const, code: "failed" as const, text: t3StartUncertain(result, startTimeoutMs) };
        if (T3_NOT_RUNNING.test(t3LastLine(said(result)))) return away("absent", "T3 Code isn't open on this computer.");
        // T3 refused it and made nothing. Only the effort (T3: "… rejected options: …"): once more on the same model
        // without it. Else once more on T3's own model for the agent (the newest thread's, else its list; the token
        // only when the project's own threads give no other model). The first refusal is the one the line names.
        const refusedModel: string = pick.model;
        let next: T3StartPick | null = null;
        if (tries === 0 && pick.options.length > 0 && T3_OPTIONS_REFUSED.test(said(result))) {
          declinedEffort = launch.effort;
          next = { ...pick, options: [] };
        } else if (tries === 0) {
          declined = refusedModel;
          const own = newest && newest.model !== refusedModel ? newest : await ask();
          next = own && own.model !== refusedModel ? { ...own, options: [] } : null;
        }
        if (!next) return { ...away("refused", "T3 Code didn't start the thread."), ...refusedOf() };
        ctx.startLog(launch.id, `T3 Code didn't take ${declinedEffort && !declined ? `the effort ${declinedEffort}` : `${pick.provider} · ${refusedModel}`}: once more on ${next.provider} · ${next.model}${declinedEffort && !declined ? ", T3's own effort" : ""}`);
        pick = next;
      }
    },

    /**
     * The thread an earlier start of `launch` made, found among T3's threads now (`t3AdoptableOf`), for a start the
     * Inbox closed during whose agent then wrote: it settles as started with no Try again. Null when T3 can't say.
     */
    async adopt(launch: InboxLaunchRecord, name: string): Promise<string | null> {
      const found = await command();
      if (!found || !t3ServerOf(t3HomeOf(found.e))) return null;
      const title = name.replace(/\s+/g, " ").trim();
      return adoptFrom(launch, title, (await listTitled(found, launch.folder, title)).titled);
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
    remove: async (): Promise<LaunchHostResult> => nothing("T3 Code keeps its threads"),
    purge: async (): Promise<LaunchHostResult & { skipped?: string }> => ({ exitCode: 0, text: "", skipped: "T3 Code keeps its threads in its own state" }),
    attach: (): string | null => null,
    terminal: (launch: InboxLaunchRecord): string => `cd ${shellQuote(launch.folder)}`,
    // Its prompts wait in T3's own app.
    permissions: () => ({ sweep() {}, withdrawAll() {} }),
  } satisfies LaunchHost & { here(): Promise<{ installed: boolean; open: boolean }>; adopt(launch: InboxLaunchRecord, name: string): Promise<string | null> };
}
