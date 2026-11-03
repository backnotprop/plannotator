/**
 * A scripted T3 Code environment on loopback: the slice of T3's external MCP
 * API (`<env>/mcp`, streamable HTTP, a Bearer grant) the Inbox's T3 wake uses,
 * `t3_thread_read` and `t3_thread_send`. No T3 is ever run.
 *
 * - `threads`: the threads this environment has (any other is "not found").
 * - `token`: the access token it accepts; anything else is a 401, as a lapsed
 *   or revoked grant is.
 * - `deny`: answer every send with T3's typed failure, as T3 does for a grant
 *   whose mode does not cover the thread.
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
  state: { token: string; deny: { code: string; message: string } | null };
  stop(): void;
}

export function startFakeT3(options: { threads: string[]; token?: string }): FakeT3 {
  const turns: FakeT3["turns"] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const state: FakeT3["state"] = { token: options.token ?? "t3-test-access", deny: null };
  const fake = { turns, sendCalls: 0, threads: options.threads, state } as Omit<FakeT3, "endpoint" | "stop">;
  const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : { structuredContent: value }) });
  const failure = (code: string, message: string) => text({ _tag: "OrchestratorMcpFailure", code, message }, true);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
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
        else if (name === "t3_thread_read") {
          result = text({
            thread: { threadId, projectId: "project", status: "idle", activeRunId: null, latestRunId: null, itemCount: 0, worktreePath: null, archived: false, pendingRequestCount: 0 },
            recentRuns: [],
            items: [],
            nextPosition: null,
            hasMore: false,
          });
        } else if (name === "t3_thread_send") {
          fake.sendCalls++;
          if (state.deny) result = failure(state.deny.code, state.deny.message);
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
