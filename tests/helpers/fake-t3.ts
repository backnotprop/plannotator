export interface FakeT3 {
  endpoint: URL;
  turns: { threadId: string; message: string; clientRequestId: string; mode: string }[];
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

export type T3RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type T3Access = "read-only" | T3RuntimeMode;
const RANK: Record<T3RuntimeMode, number> = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };

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
