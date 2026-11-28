/**
 * A scripted T3 Code environment on loopback: the slice of T3's external MCP
 * API (`<env>/mcp`, streamable HTTP, a Bearer grant) the Inbox's T3 wake uses,
 * `t3_thread_read` and `t3_thread_send`. No T3 is ever run.
 *
 * - `threads`: the threads this environment has (any other is "not found").
 * - `token`: the access token it accepts; anything else is a 401, as a lapsed
 *   or revoked grant is.
 * - `access`: the mode the grant was approved with (default full-access). A
 *   send is denied as T3 denies it: `capability_denied` for Read only,
 *   `runtime_mode_escalation_denied` into a thread whose mode (`modes`, default
 *   auto; `t3_thread_read` returns it) is broader. `t3ScopeOf` is the scope T3
 *   grants for an access, as `plannotator t3 login` saves it.
 * - `deny`: answer every send with this typed failure instead.
 * - `readFailure`: answer every `t3_thread_read` with this typed failure
 *   (`orchestration_error` is T3's "could not be completed").
 * - `stallMs`: hold every request this long first, as a T3 that black-holes.
 * - `capabilities`: `orchestrator_capabilities`' answer (the providers and
 *   models the Inbox's T3 launch lists for a signed-in T3).
 *
 * A send is idempotent by `clientRequestId`, as T3's is: a retry under the
 * same id returns the first receipt and records no second turn.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeT3 {
  endpoint: URL;
  /** Every t3_thread_send T3 took as a new turn. */
  turns: { threadId: string; message: string; clientRequestId: string; mode: string }[];
  /** Every t3_thread_send call, a retry or a denied one included. */
  sendCalls: number;
  /** Every orchestrator_capabilities call (`capabilities`: its answer, T3's `OrchestratorMcpCapabilitiesResult`). */
  capabilityCalls: number;
  threads: string[];
  state: {
    token: string;
    access: T3Access;
    modes: Record<string, T3RuntimeMode>;
    deny: { code: string; message: string } | null;
    readFailure: { code: string; message: string } | null;
    stallMs: number;
  };
  stop(): void;
}

/**
 * One thread id of each form T3 Code gives a thread, as T3 forms them: an app thread (a UUID), a thread made
 * over T3's MCP (`mcp:` and a UUID, the form in issue #3311), an agent's t3_thread_launch (`mcp:launch:` and a
 * SHA-256), a fork, an imported session, a create_threads child (a 256-character request id URI-encoded, over
 * 2,000 characters), a scheduled task's run, a delegated task (its command id URI-encoded, a task name's
 * parentheses left as `encodeURIComponent` leaves them), a provider-native thread and a subagent's thread (16 hex).
 */
export const T3_THREAD_ID_FORMS = {
  app: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
  mcp: "mcp:2b7e9c41-5d3a-4f68-9a0b-1c2d3e4f5a6b",
  launched: `mcp:launch:${"516a2801f994e37f7b141931e19a9c846af2dbc38866a7a8b1ddc2fd079ce967"}`,
  forked: "mcp:2b7e9c41-5d3a-4f68-9a0b-1c2d3e4f5a6b:fork",
  imported: "import:claudeAgent:7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f",
  created: `thread:mcp:${encodeURIComponent("client:8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d")}:${encodeURIComponent("日".repeat(256))}:0`,
  scheduled: "thread:project:9b2e4c1a-0d3f-4e5a-8b6c-7d8e9f0a1b2c:3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  delegated: "thread:delegated-task:command%3Amcp%3Aafafed4f-6fe6-436b-a561-273f0b6a0791%3Adelegate-task%3Afix-(part-2)",
  provider: `thread:provider:claudeAgent:native-thread:${encodeURIComponent(`pending:${"a".repeat(280)}`)}`,
  subagent: "thread:subagent:9f3c2a7b1e4d6c08",
} as const;

export type T3RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type T3Access = "read-only" | T3RuntimeMode;
const RANK: Record<T3RuntimeMode, number> = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };

/** The OAuth scope T3 grants for an access (T3's `mcpClientScopes`). */
export function t3ScopeOf(access: T3Access): string {
  if (access === "read-only") return "orchestration:read";
  if (access === "full-access") return "orchestration:read orchestration:operate settings:write source-control:write";
  return "orchestration:read orchestration:operate";
}

/**
 * A T3 Code home on disk (`<home>/.t3`) as the Inbox's `t3` route reads it (inbox-t3-local.ts):
 *
 * - T3's state database with one provider thread row per Codex thread T3 runs
 *   (`orchestration_v2_projection_provider_threads`), in the shape T3 v0.1.9
 *   writes (`schema` "0.1.9", seen on a real 0.1.9 server), or in one the
 *   route does not know (`schema` "unknown": no `payload_json`);
 * - `userdata/server-runtime.json`, the file T3 writes while its server runs,
 *   naming this test's own process (alive) unless `state` is "down";
 * - the `bin/t3` launcher T3's desktop app writes, faked: it logs its argv and
 *   answers `thread send` and `thread show` with T3 0.1.9's own words
 *   (REAL-T3-PROOF). `state` "down" answers as T3's command does with no
 *   server running, "stale" as with a runtime file whose server does not
 *   answer, "gone" as for a thread T3 deleted, "fail" with another failure,
 *   "hang" never answers.
 * - `thread start . - [--title=<t>] [--provider=<p> --model=<m>
 *   [--option=effort=<v>]] --json` (the Inbox's start in T3 Code,
 *   inbox-launch-t3.ts; each flag also as `--name value`), as T3's
 *   cli/thread.ts answers it: run in a folder inside one of `projects` (T3's
 *   projects, by folder; the deepest, or through `checkouts`, as T3's resolveProject), it makes a new thread (`thread:project:<uuid>:<uuid>`,
 *   the form a real `t3 thread start` gave) on the provider and model given,
 *   else the project's default (`defaultModel`, Claude Code's opus), takes the
 *   message from stdin as its first turn and prints `{ threadId, projectId,
 *   runId }`; in any other folder it says "No T3 Code project matches '.'. …",
 *   exit 1. A base named "no-such-branch" is refused in T3's words. `starts()`
 *   lists what it made. A thread it made is one `send` and `show` know; in
 *   state "taken-then-hang" it makes the thread, then never answers.
 * - `thread show <id> --json` names the thread's `providerInstanceId` and
 *   `model`, its run's `status`, `activeRunId` and `pendingRequestCount`, as
 *   T3's thread read does (`setRunStatus`; "completed" until set).
 * - `thread list --json` in a project's folder lists that project's threads,
 *   newest first, with their title, provider, model and `createdAt`: those
 *   `thread start` made there and `used` (threads T3 had already, by project
 *   folder). A start on the model "retired", or with `--option=effort=max`, is refused in T3's words.
 * - `auth session issue --scope=… --subject=… --ttl=… --label=… --json`, as
 *   T3's cli/auth.ts answers it (pretty JSON with the bearer `token`, which is
 *   `authToken`: the token a `startFakeT3` on `port` takes), and `auth session
 *   revoke <sessionId>`. `issued()` and `revoked()` list them; the token is
 *   never written to any file here. `refuseAuth()` answers `issue` as a T3
 *   with no such command does.
 *
 * `threads` maps a Codex thread to the T3 thread that runs it; `t3Threads`
 * are T3's other threads (a Claude one's id is T3's own). `db: false` makes no
 * state database (an e2e spec, which runs under Node: no `bun:sqlite`). No T3
 * is ever run.
 */
/**
 * - "up": sends start a turn; "down": no runtime file, as T3 closed; "starting": a runtime file written now, and every
 *   thread "not available" (a server that has not loaded its threads);
 * - "stale", "fail": every call fails ("Could not reach …", another failure), nothing taken;
 * - "taken-then-fail": a send is taken (the thread shows it), then the call fails as a connection cut mid-request does;
 * - "hang": a call never answers, nothing taken; "taken-then-hang": a send is taken, then the call never answers;
 * - "gone": T3 has no such thread.
 */
export type FakeT3HomeState = "up" | "down" | "starting" | "stale" | "hang" | "taken-then-hang" | "taken-then-fail" | "gone" | "fail";

export interface FakeT3Home {
  dir: string;
  launcher: string;
  /** Every `t3` call's argv after the command. */
  calls(): string[][];
  /** The `t3 thread send` calls' argv. */
  sends(): string[][];
  /** What each taken send put in, in order: `[thread, text]` (what `thread show` lists as user messages). */
  turns(): [string, string][];
  /** The environment each call ran with. */
  envs(): Record<string, string>[];
  /** Every thread `thread start` made: its id, the folder it ran in, the base, the title, the provider, model and options asked for, and the message. */
  starts(): { id: string; cwd: string; project: string; base: string | null; title: string | null; provider: string | null; model: string | null; options: string[]; text: string }[];
  setState(state: FakeT3HomeState): void;
  /** The status `thread show` gives every thread's run ("completed" until set; "running" has an active run). */
  setRunStatus(status: string): void;
  /** The folders `t3 project add` added, as T3 keeps them (real paths). */
  added(): string[];
  /** Make every later `t3 project add` fail. */
  refuseProjectAdd(): void;
  /** Every `auth session issue`: the session it made and the flags asked for (never the token). */
  issued(): { sessionId: string; scope: string | null; subject: string | null; ttl: string | null; label: string | null; json: boolean }[];
  /** Every `auth session revoke`'s session id. */
  revoked(): string[];
  /** Answer every later `auth session issue` as a T3 without it does. */
  refuseAuth(): void;
  /** A T3 whose `thread start` has no `--option` flag (as the CLI parser refuses an unknown flag). */
  withoutOptionFlag(): void;
  /** Make every later `thread list` fail (false: answer again). */
  refuseList(refused?: boolean): void;
}

/** T3's state database (`userdata/statev2.sqlite`), one provider thread row per Codex thread. Bun only (`bun:sqlite`). */
function writeStateDb(dir: string, threads: Record<string, string>, schema: "0.1.9" | "unknown" | undefined): void {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(join(dir, "userdata", "statev2.sqlite"));
  if (schema === "unknown") {
    db.run(`CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, native_id TEXT)`);
    for (const [codexThread, t3Thread] of Object.entries(threads)) db.query(`INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, 'codex', ?)`).run(`provider-thread:${t3Thread}`, t3Thread, codexThread);
  } else {
    db.run(`CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT, provider TEXT NOT NULL, driver TEXT, provider_instance_id TEXT, provider_session_id TEXT, status TEXT NOT NULL, first_run_ordinal INTEGER, last_run_ordinal INTEGER, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)`);
    for (const [codexThread, t3Thread] of Object.entries(threads)) {
      const id = `provider-thread:${t3Thread}`;
      const payload = { id, driver: "codex", providerInstanceId: "codex", providerSessionId: null, appThreadId: t3Thread, ownerNodeId: null, nativeThreadRef: { driver: "codex", nativeId: codexThread, strength: "strong" }, status: "idle", updatedAt: "2026-11-14T00:00:00.000Z" };
      db.query(`INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, NULL, 'codex', 'codex', 'codex', NULL, 'idle', 1, 1, ?, ?)`).run(id, t3Thread, payload.updatedAt, JSON.stringify(payload));
    }
  }
  db.close();
}

export interface FakeT3UsedThread {
  threadId: string;
  title: string;
  providerInstanceId: string;
  model: string;
}

export function makeFakeT3Home(
  home: string,
  threads: Record<string, string>,
  options: {
    t3Threads?: string[];
    schema?: "0.1.9" | "unknown";
    projects?: string[];
    db?: false;
    /** The threads each project (by folder) already has, newest first (`thread list`). */
    used?: Record<string, FakeT3UsedThread[]>;
    /** The project default a start without `--provider`/`--model` runs. */
    defaultModel?: { provider: string; model: string };
    /** The port its runtime file names (a signed-in test's scripted MCP server's). */
    port?: number;
    /** The bearer token `auth session issue` prints (default "t3-test-access", `startFakeT3`'s). */
    authToken?: string;
    /** The origin its runtime file names (default `http://127.0.0.1:<port>`). */
    origin?: string;
    /**
     * Git checkouts of one repository, as `git worktree list` gives them: a folder of a linked worktree → the main
     * checkout. A folder in no project resolves, as in T3, as the same path in the other checkout's project.
     */
    checkouts?: Record<string, string>;
  } = {},
): FakeT3Home {
  const dir = join(home, ".t3");
  mkdirSync(join(dir, "userdata"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  if (options.db !== false) writeStateDb(dir, threads, options.schema);
  const log = join(dir, "calls.log");
  const envLog = join(dir, "envs.log");
  const turnsLog = join(dir, "turns.log");
  const stateFile = join(dir, "fake-state");
  const startsLog = join(dir, "starts.log");
  const runtimeFile = join(dir, "userdata", "server-runtime.json");
  writeFileSync(log, "");
  const setState = (state: FakeT3HomeState) => {
    writeFileSync(stateFile, state);
    if (state === "down") rmSync(runtimeFile, { force: true });
    else {
      const startedAt = state === "starting" ? new Date().toISOString() : "2026-11-14T00:00:00.000Z";
      const port = options.port ?? 9;
      writeFileSync(runtimeFile, `${JSON.stringify({ version: 1, pid: process.pid, port, origin: options.origin ?? `http://127.0.0.1:${port}`, startedAt, serverVersion: "0.1.9" })}\n`);
      // The file's own time is a start too: an old one stands for a server up for long.
      if (state !== "starting") utimesSync(runtimeFile, new Date("2026-11-14T00:00:00.000Z"), new Date("2026-11-14T00:00:00.000Z"));
    }
  };
  setState("up");
  const script = join(dir, "fake-t3.js");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify(process.env) + "\\n");
const state = fs.readFileSync(${JSON.stringify(stateFile)}, "utf8").trim();
const startsFile = ${JSON.stringify(startsLog)};
const started = () => fs.existsSync(startsFile) ? fs.readFileSync(startsFile, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const known = [...${JSON.stringify([...Object.values(threads), ...(options.t3Threads ?? [])])}, ...started().map((s) => s.id)];
const addedFile = ${JSON.stringify(join(dir, "projects-added"))};
const projects = [...${JSON.stringify(options.projects ?? [])}, ...(fs.existsSync(addedFile) ? fs.readFileSync(addedFile, "utf8").split("\\n").filter(Boolean) : [])];
// T3's resolveProject (cli/thread.ts): the deepest project holding the folder; none, the same path in another checkout
// of its git repository.
const deepest = (at) => projects.filter((root) => at === root || at.startsWith(root + "/")).sort((a, b) => b.length - a.length)[0];
const checkouts = ${JSON.stringify(options.checkouts ?? {})};
const projectOf = (at) => {
  const own = deepest(at);
  if (own) return own;
  const linked = Object.keys(checkouts).find((wt) => at === wt || at.startsWith(wt + "/"));
  return linked ? deepest(checkouts[linked] + at.slice(linked.length)) : undefined;
};
const turnsFile = ${JSON.stringify(turnsLog)};
const runFile = ${JSON.stringify(join(dir, "run-status"))};
const turns = () => fs.existsSync(turnsFile) ? fs.readFileSync(turnsFile, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const say = (line, code) => { process.stderr.write(line + "\\n"); process.exit(code); };
const thread = args.filter((a) => !a.startsWith("--"))[2];
const flags = (name) => args.flatMap((a, i) => a === name ? [args[i + 1]] : a.startsWith(name + "=") ? [a.slice(name.length + 1)] : []);
const flag = (name) => flags(name)[0];
const used = ${JSON.stringify(options.used ?? {})};
const fallback = ${JSON.stringify(options.defaultModel ?? { provider: "claudeAgent", model: "opus" })};
const runsOf = (id) => { const made = started().find((s) => s.id === id); return made ? { providerInstanceId: made.provider ?? fallback.provider, model: made.model ?? fallback.model } : { providerInstanceId: fallback.provider, model: fallback.model }; };
const take = (text) => fs.appendFileSync(turnsFile, JSON.stringify([thread, text]) + "\\n");
if (state === "hang") setTimeout(() => {}, 60000);
else if (state === "down") say("No running T3 Code server uses ${dir}. Start T3 Code, then retry.", 1);
else if (state === "stale") say("Could not reach the T3 Code server at http://127.0.0.1:9. connect ECONNREFUSED", 1);
else if (state === "fail") say("Something went wrong.", 1);
else if (args[0] === "auth" && args[1] === "session" && args[2] === "issue") {
  // T3's cli/auth.ts: a bearer session for the subject, printed as pretty JSON (formatIssuedSession). Only the
  // session id and the flags are written down here, never the token.
  if (fs.existsSync(${JSON.stringify(join(dir, "auth-refused"))})) say("Unknown option --subject.", 1);
  const sessionId = "session-" + require("node:crypto").randomUUID();
  fs.appendFileSync(${JSON.stringify(join(dir, "issued.log"))}, JSON.stringify({ sessionId, scope: flag("--scope") ?? null, subject: flag("--subject") ?? null, ttl: flag("--ttl") ?? null, label: flag("--label") ?? null, json: args.includes("--json") }) + "\\n");
  process.stdout.write(JSON.stringify({ sessionId, token: ${JSON.stringify(options.authToken ?? "t3-test-access")}, method: "bearer-session-token", scopes: (flag("--scope") ?? "").split(" "), subject: flag("--subject") ?? "cli", client: { label: flag("--label") ?? null }, expiresAt: new Date(Date.now() + 60000).toISOString() }, null, 2) + "\\n");
} else if (args[0] === "auth" && args[1] === "session" && args[2] === "revoke") {
  fs.appendFileSync(${JSON.stringify(join(dir, "revoked.log"))}, args[3] + "\\n");
  process.stdout.write("Revoked session " + args[3] + ".\\n");
} else if (args[0] === "project" && args[1] === "add") {
  // T3's cli/project.ts: adds the folder as a project, or says it has one there already.
  if (fs.existsSync(${JSON.stringify(join(dir, "project-add-refused"))})) say("Something went wrong.", 1);
  const root = fs.realpathSync(args[2]);
  if (projects.includes(root)) say("An active project already exists for '" + root + "'.", 1);
  fs.appendFileSync(addedFile, root + "\\n");
  process.stdout.write("Added project project:" + require("node:path").basename(root) + " (" + require("node:path").basename(root) + ") at " + root + ".\\n");
} else if (args[0] === "thread" && args[1] === "start") {
  // A T3 whose CLI has no --option: Effect's CLI parser refuses the flag (CliError.UnrecognizedOption).
  if (fs.existsSync(${JSON.stringify(join(dir, "no-option-flag"))}) && args.some((a) => a === "--option" || a.startsWith("--option="))) say("Unrecognized flag: --option in command t3 thread start", 1);
  const cwd = fs.realpathSync(process.cwd());
  const project = projectOf(cwd);
  if (args[2] !== "." || !project) say("No T3 Code project matches '" + args[2] + "'. Pass a project id or a path inside a project.", 1);
  const text = args[3] === "-" ? fs.readFileSync(0, "utf8") : args[3];
  if (!text.trim()) say("The message is empty.", 1);
  const base = flag("--worktree") ?? null;
  if (base === "no-such-branch") say('Base ref "no-such-branch" does not resolve to a commit in project "' + require("node:path").basename(project) + '" (' + project + ').', 1);
  const provider = flag("--provider") ?? null;
  const model = flag("--model") ?? null;
  // A project \`project add\` just made has no default model: T3 0.1.9's words for a start that names none.
  if (model === null && !${JSON.stringify(options.projects ?? [])}.includes(project)) say("Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.", 1);
  if ((provider === null) !== (model === null)) say("--provider and --model go together.", 1);
  if (model === "retired") say("Model 'retired' is not available for provider instance '" + provider + "'.", 1);
  const options = flags("--option");
  if (options.length > 0 && provider === null) say("--option needs --provider and --model.", 1);
  // An effort the model doesn't have ("max"): T3's words (OrchestratorMcpService, invalidOptionSelections).
  if (options.includes("effort=max")) say("Model " + model + " on provider " + provider + " rejected options: Option effort must be one of: low, medium, high.", 1);
  const { randomUUID } = require("node:crypto");
  const id = "thread:project:" + randomUUID() + ":" + randomUUID();
  fs.appendFileSync(startsFile, JSON.stringify({ id, cwd, project, base, title: flag("--title") ?? null, provider, model, options, text, createdAt: new Date().toISOString() }) + "\\n");
  fs.appendFileSync(turnsFile, JSON.stringify([id, text]) + "\\n");
  if (state === "taken-then-hang") setTimeout(() => {}, 60000);
  else process.stdout.write(JSON.stringify({ threadId: id, projectId: "project:" + require("node:path").basename(project), runId: "run:" + randomUUID() }) + "\\n");
} else if (args[0] === "thread" && args[1] === "list") {
  if (fs.existsSync(${JSON.stringify(join(dir, "list-refused"))})) say("Something went wrong.", 1);
  const cwd = fs.realpathSync(process.cwd());
  const project = projectOf(cwd);
  if (!project) say("No T3 Code project matches '.'. Pass a project id or a path inside a project.", 1);
  const mine = started().filter((s) => s.project === project).reverse().map((s) => ({ threadId: s.id, title: s.title ?? "", status: "running", createdAt: s.createdAt, ...runsOf(s.id) }));
  process.stdout.write(JSON.stringify([...mine, ...(used[project] ?? []).map((t) => ({ status: "idle", createdAt: "2026-11-01T00:00:00.000Z", ...t }))]) + "\\n");
} else if (args[0] === "thread" && args[1] === "send") {
  if (state === "gone" || !known.includes(thread)) say("Thread " + thread + " was not found.", 1);
  if (state === "starting") say("Thread " + thread + " was not found.", 1);
  const text = args[3] === "-" ? fs.readFileSync(0, "utf8") : args[3];
  take(text);
  if (state === "taken-then-hang") setTimeout(() => {}, 60000);
  else if (state === "taken-then-fail") say("Could not reach the T3 Code server at http://127.0.0.1:9. fetch failed", 1);
  else process.stdout.write(JSON.stringify({ threadId: thread, messageId: "message-1", runId: "run-1", status: "starting", delivery: "started" }) + "\\n");
} else if (args[0] === "thread" && args[1] === "show") {
  if (state === "gone" || state === "starting" || !known.includes(thread)) say("Thread " + thread + " is no longer available.", 1);
  const limit = Number(flag("--messages") ?? 20);
  const messages = turns().filter((turn) => turn[0] === thread).map((turn, n) => ({ role: "user", runId: "run:" + n, text: turn[1] }));
  // T3's OrchestratorMcpThreadDetail, in part: the run's status ("running" holds an active run; "completed" is over).
  const status = fs.existsSync(runFile) ? fs.readFileSync(runFile, "utf8").trim() : "completed";
  const ended = ["idle", "completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
  process.stdout.write(JSON.stringify({ thread: { threadId: thread, status, activeRunId: ended ? null : "run:active", pendingRequestCount: 0, ...runsOf(thread) }, messages: limit > 0 ? messages.slice(-limit) : [] }) + "\\n");
} else say("unknown command", 2);
`,
  );
  const launcher = join(dir, "bin", "t3");
  writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(launcher, 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : []);
  return {
    dir,
    launcher,
    calls,
    sends: () => calls().filter((args) => args[0] === "thread" && args[1] === "send"),
    turns: () => (existsSync(turnsLog) ? readFileSync(turnsLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as [string, string]) : []),
    envs: () => (existsSync(envLog) ? readFileSync(envLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>) : []),
    starts: () => (existsSync(startsLog) ? readFileSync(startsLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReturnType<FakeT3Home["starts"]>[number]) : []),
    setState,
    setRunStatus: (status: string) => writeFileSync(join(dir, "run-status"), status),
    /** The folders `t3 project add` added. */
    added: () => (existsSync(join(dir, "projects-added")) ? readFileSync(join(dir, "projects-added"), "utf8").split("\n").filter(Boolean) : []),
    /** `t3 project add` fails from now on. */
    refuseProjectAdd: () => writeFileSync(join(dir, "project-add-refused"), "1"),
    issued: () => (existsSync(join(dir, "issued.log")) ? readFileSync(join(dir, "issued.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReturnType<FakeT3Home["issued"]>[number]) : []),
    revoked: () => (existsSync(join(dir, "revoked.log")) ? readFileSync(join(dir, "revoked.log"), "utf8").split("\n").filter(Boolean) : []),
    refuseAuth: () => writeFileSync(join(dir, "auth-refused"), "1"),
    withoutOptionFlag: () => writeFileSync(join(dir, "no-option-flag"), "1"),
    refuseList: (refused = true) => (refused ? writeFileSync(join(dir, "list-refused"), "1") : renameSync(join(dir, "list-refused"), join(dir, `list-answered-${Date.now()}`))),
  };
}

export function startFakeT3(options: { threads: string[]; token?: string; access?: T3Access; modes?: Record<string, T3RuntimeMode>; capabilities?: unknown }): FakeT3 {
  const turns: FakeT3["turns"] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const state: FakeT3["state"] = { token: options.token ?? "t3-test-access", access: options.access ?? "full-access", modes: options.modes ?? {}, deny: null, readFailure: null, stallMs: 0 };
  const fake = { turns, sendCalls: 0, capabilityCalls: 0, threads: options.threads, state } as Omit<FakeT3, "endpoint" | "stop">;
  const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : { structuredContent: value }) });
  const failure = (code: string, message: string) => text({ _tag: "OrchestratorMcpFailure", code, message }, true);
  const modeOf = (threadId: string): T3RuntimeMode => state.modes[threadId] ?? "auto";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (state.stallMs > 0) await Bun.sleep(state.stallMs);
      if (request.method === "GET") return new Response("Method not allowed", { status: 405 });
      if (request.method === "DELETE") return new Response(null, { status: 200 });
      if (request.headers.get("authorization") !== `Bearer ${state.token}`) return new Response("Unauthorized", { status: 401 });
      const rpc = (await request.json()) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "scripted-t3", version: "test" } };
      else if (rpc.method === "tools/list") result = { tools: ["t3_thread_read", "t3_thread_send", "orchestrator_capabilities"].map((name) => ({ name, inputSchema: { type: "object" } })) };
      else if (rpc.params?.name === "orchestrator_capabilities") {
        fake.capabilityCalls++;
        result = options.capabilities === undefined ? failure("invalid_request", "No tool orchestrator_capabilities.") : text(options.capabilities);
      } else {
        const name = rpc.params?.name;
        const args = rpc.params?.arguments ?? {};
        const threadId = String(args.threadId);
        if (!fake.threads.includes(threadId)) result = failure("thread_not_found", `Thread ${threadId} was not found.`);
        else if (name === "t3_thread_read" && state.readFailure) result = failure(state.readFailure.code, state.readFailure.message);
        else if (name === "t3_thread_read") {
          result = text({
            thread: { threadId, projectId: "project", status: "idle", activeRunId: null, latestRunId: null, itemCount: 0, worktreePath: null, archived: false, pendingRequestCount: 0, runtimeMode: modeOf(threadId), interactionMode: "default" },
            recentRuns: [],
            items: [],
            nextPosition: null,
            hasMore: false,
          });
        } else if (name === "t3_thread_send") {
          fake.sendCalls++;
          const mode = modeOf(threadId);
          if (state.deny) result = failure(state.deny.code, state.deny.message);
          else if (state.access === "read-only") result = failure("capability_denied", "This tool changes the environment, and this MCP client was approved for read-only access.");
          else if (RANK[mode] > RANK[state.access]) result = failure("runtime_mode_escalation_denied", `Child runtime mode ${mode} is broader than parent mode ${state.access}.`);
          else {
            const key = `${threadId}:${String(args.clientRequestId)}`;
            if (!receipts.has(key)) {
              turns.push({ threadId, message: String(args.message), clientRequestId: String(args.clientRequestId), mode: String(args.mode) });
              receipts.set(key, { threadId, messageId: `message-${turns.length}`, runId: `run-${turns.length}`, status: "queued", delivery: "queued" });
            }
            result = text(receipts.get(key));
          }
        } else result = failure("invalid_request", `No tool ${name}.`);
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  });
  return Object.assign(fake, { endpoint: new URL(`http://127.0.0.1:${server.port}/mcp`), stop: () => server.stop(true) }) as FakeT3;
}
