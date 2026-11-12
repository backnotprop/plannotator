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
 * One thread id of each form T3 Code gives a thread, as T3 forms them: an app thread (a UUID), an agent's
 * t3_thread_launch (`mcp:launch:` and a SHA-256), a scheduled task's run, a delegated task (its command id
 * URI-encoded, a task name's parentheses left as `encodeURIComponent` leaves them) and a provider-native thread.
 */
export const T3_THREAD_ID_FORMS = {
  app: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
  launched: `mcp:launch:${"516a2801f994e37f7b141931e19a9c846af2dbc38866a7a8b1ddc2fd079ce967"}`,
  scheduled: "thread:project:9b2e4c1a-0d3f-4e5a-8b6c-7d8e9f0a1b2c:3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  delegated: "thread:delegated-task:command%3Amcp%3Aafafed4f-6fe6-436b-a561-273f0b6a0791%3Adelegate-task%3Afix-(part-2)",
  provider: `thread:provider:claudeAgent:native-thread:${encodeURIComponent(`pending:${"a".repeat(280)}`)}`,
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
        if (!fake.threads.includes(threadId)) result = failure("thread_not_found", "The thread was not found.");
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
