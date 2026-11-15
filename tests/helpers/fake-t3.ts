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
 *
 * A send is idempotent by `clientRequestId`, as T3's is: a retry under the
 * same id returns the first receipt and records no second turn.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeT3 {
  endpoint: URL;
  /** Every t3_thread_send T3 took as a new turn. */
  turns: { threadId: string; message: string; clientRequestId: string; mode: string }[];
  /** Every t3_thread_send call, a retry or a denied one included. */
  sendCalls: number;
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
 *
 * `threads` maps a Codex thread to the T3 thread that runs it; `t3Threads`
 * are T3's other threads (a Claude one's id is T3's own). No T3 is ever run.
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
  setState(state: FakeT3HomeState): void;
}

export function makeFakeT3Home(home: string, threads: Record<string, string>, options: { t3Threads?: string[]; schema?: "0.1.9" | "unknown" } = {}): FakeT3Home {
  const dir = join(home, ".t3");
  mkdirSync(join(dir, "userdata"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  const db = new Database(join(dir, "userdata", "statev2.sqlite"));
  if (options.schema === "unknown") {
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
  const log = join(dir, "calls.log");
  const envLog = join(dir, "envs.log");
  const turnsLog = join(dir, "turns.log");
  const stateFile = join(dir, "fake-state");
  const runtimeFile = join(dir, "userdata", "server-runtime.json");
  writeFileSync(log, "");
  const setState = (state: FakeT3HomeState) => {
    writeFileSync(stateFile, state);
    if (state === "down") rmSync(runtimeFile, { force: true });
    else {
      const startedAt = state === "starting" ? new Date().toISOString() : "2026-11-14T00:00:00.000Z";
      writeFileSync(runtimeFile, `${JSON.stringify({ version: 1, pid: process.pid, port: 9, origin: "http://127.0.0.1:9", startedAt, serverVersion: "0.1.9" })}\n`);
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
const known = ${JSON.stringify([...Object.values(threads), ...(options.t3Threads ?? [])])};
const turnsFile = ${JSON.stringify(turnsLog)};
const turns = () => fs.existsSync(turnsFile) ? fs.readFileSync(turnsFile, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const say = (line, code) => { process.stderr.write(line + "\\n"); process.exit(code); };
const thread = args.filter((a) => !a.startsWith("--"))[2];
const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const take = (text) => fs.appendFileSync(turnsFile, JSON.stringify([thread, text]) + "\\n");
if (state === "hang") setTimeout(() => {}, 60000);
else if (state === "down") say("No running T3 Code server uses ${dir}. Start T3 Code, then retry.", 1);
else if (state === "stale") say("Could not reach the T3 Code server at http://127.0.0.1:9. connect ECONNREFUSED", 1);
else if (state === "fail") say("Something went wrong.", 1);
else if (args[0] === "thread" && args[1] === "send") {
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
  process.stdout.write(JSON.stringify({ thread: { threadId: thread, status: "completed" }, messages: limit > 0 ? messages.slice(-limit) : [] }) + "\\n");
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
    setState,
  };
}

export function startFakeT3(options: { threads: string[]; token?: string; access?: T3Access; modes?: Record<string, T3RuntimeMode> }): FakeT3 {
  const turns: FakeT3["turns"] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const state: FakeT3["state"] = { token: options.token ?? "t3-test-access", access: options.access ?? "full-access", modes: options.modes ?? {}, deny: null, readFailure: null, stallMs: 0 };
  const fake = { turns, sendCalls: 0, threads: options.threads, state } as Omit<FakeT3, "endpoint" | "stop">;
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
      else if (rpc.method === "tools/list") result = { tools: ["t3_thread_read", "t3_thread_send"].map((name) => ({ name, inputSchema: { type: "object" } })) };
      else {
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
