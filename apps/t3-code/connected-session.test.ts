import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { T3Credentials } from "./auth";
import { daemonDirectory, daemonStatus, type AdapterOptions } from "./daemon";
import { pause, type T3TimelineItem } from "./t3-client";
import { simpleShellCommandWords } from "@plannotator/shared/plannotator-tool";
import { claudeToolItemId } from "./hook-routing";

async function eventually(check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error("The connected-session check did not settle.");
}

test("unchanged agent command through the hook, no provider MCP or Inbox, detached Ask and recoverable decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "plannotator-t3-connected-"));
  const project = join(root, "project"); mkdirSync(project);
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  writeFileSync(join(project, "notes.md"), "# Connected session\n\nReview this sentence.\n");
  const dataDir = join(root, "data");
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const messages = new Map<string, T3TimelineItem[]>();
  const receipts = new Map<string, Record<string, unknown>>();
  const t3 = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return new Response("Method not allowed", { status: 405 });
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    if (request.headers.get("authorization") !== "Bearer test-access") return new Response("Unauthorized", { status: 401 });
    const rpc = await request.json() as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "scripted-t3", version: "test" } };
    else if (rpc.method === "tools/list") result = { tools: ["t3_thread_read", "t3_project_read", "t3_thread_send", "t3_thread_wait"].map((name) => ({ name, inputSchema: { type: "object" } })) };
    else {
      const name = rpc.params!.name!;
      const args = rpc.params!.arguments!;
      calls.push({ name, args });
      const thread = String(args.threadId);
      const items = messages.get(thread) ?? [];
      let output: Record<string, unknown>;
      if (name === "t3_project_read") output = { workspaceRoot: project };
      else if (name === "t3_project_list") output = { projects: [{ id: "project", workspaceRoot: project }], nextCursor: null };
      else if (name === "t3_thread_list") output = { threads: [{ threadId: "thread-b" }, { threadId: "thread-a" }], nextCursor: null };
      else if (name === "t3_thread_send") {
        expect(args.mode).toBe("queue");
        const key = `${thread}:${String(args.clientRequestId)}`;
        if (!receipts.has(key)) {
          const run = `run-${items.length}`;
          const message = `message-${items.length}`;
          const position = items.length;
          const base = { sourceThreadId: thread, visibility: "local" as const, runId: run, status: "completed", textTruncated: false };
          items.push({ ...base, position, itemId: `item-${position}`, messageId: message, type: "user_message", text: String(args.message) });
          items.push({ ...base, position: position + 1, itemId: `item-${position + 1}`, messageId: null, type: "assistant_message", text: "Scripted T3 answer" });
          messages.set(thread, items);
          receipts.set(key, { threadId: thread, runId: run, messageId: message, status: "queued", delivery: "queued" });
        }
        output = receipts.get(key)!;
      } else if (name === "t3_thread_wait") output = { threadId: thread, runId: args.runId, status: "completed", timedOut: false };
      else {
        const nativeCall: T3TimelineItem = { itemId: claudeToolItemId("toolu_OpeningReview"), sourceThreadId: thread, visibility: "local", type: "command_execution", status: "running", position: 0, messageId: null, runId: "native-run", text: "$ plannotator annotate notes.md --gate", textTruncated: false };
        const routingItems = args.view === "activity" && args.itemId === nativeCall.itemId && thread === "thread-a" ? [nativeCall] : items;
        const filtered = args.itemId ? routingItems.filter((item) => item.itemId === args.itemId) : items.filter((item) => args.afterPosition === undefined || item.position > Number(args.afterPosition));
        output = { thread: { threadId: thread, projectId: "project", status: "idle", activeRunId: null, latestRunId: items.at(-1)?.runId ?? null, worktreePath: null, itemCount: items.length, archived: false, pendingRequestCount: 0 },
          recentRuns: [...new Set(items.map((item) => item.runId))].map((runId) => ({ runId, status: "completed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() })), items: filtered.slice(0, Number(args.limit ?? 100)), nextPosition: null, hasMore: false };
      }
      result = { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
    }
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  } });
  const cliCommand = process.env.T3_TEST_EXECUTABLE ? [resolve(process.env.T3_TEST_EXECUTABLE)] : [process.execPath, resolve("apps/hook/server/index.ts")];
  const options: AdapterOptions = { endpoint: new URL(`http://127.0.0.1:${t3.port}/mcp`), dataDir, command: cliCommand, workerCommand: [...cliCommand, "t3"] };
  const store = new T3Credentials(dataDir, options.endpoint);
  store.save({ endpoint: options.endpoint.href, epoch: "test-grant", tokens: { access_token: "test-access", token_type: "Bearer" } });
  const cli = async (input: Record<string, unknown>) => {
    const args = [String(input.action)];
    if (typeof input.target === "string") args.push(input.target);
    if (input.action === "close") args.push(String(input.session));
    args.push("--url", options.endpoint.href, "--data-dir", dataDir);
    if (input.t3_thread_id) args.push("--thread", String(input.t3_thread_id));
    if (input.gate) args.push("--gate");
    const child = Bun.spawn([...options.command, "t3", ...args], { cwd: project,
      env: { ...process.env, PLANNOTATOR_BROWSER: "/usr/bin/true", PLANNOTATOR_GLIMPSE: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
    return stdout;
  };
  try {
    await expect(cli({ action: "list" })).rejects.toThrow("--thread is required");
    expect(existsSync(join(dataDir, "inbox"))).toBe(false);
    const hook = Bun.spawn([...cliCommand, "t3-hook"], { cwd: project, env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir },
      stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    hook.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_OpeningReview", session_id: "native-session", cwd: project,
      tool_input: { command: "plannotator annotate notes.md --gate", description: "Open the review", timeout: 120_000 } }));
    hook.stdin.end();
    const hookText = await new Response(hook.stdout).text();
    const hookErrors = await new Response(hook.stderr).text();
    expect(await hook.exited).toBe(0);
    expect(hookErrors).toBe("");
    const updated = JSON.parse(hookText).hookSpecificOutput;
    expect(updated.permissionDecision).toBeUndefined();
    expect(updated.updatedInput.description).toBe("Open the review");
    expect(updated.updatedInput.command).not.toContain("--url");
    expect(updated.updatedInput.command).not.toContain("--thread");
    const launch = Bun.spawn(simpleShellCommandWords(updated.updatedInput.command)!, { cwd: project,
      env: { ...process.env, PLANNOTATOR_BROWSER: "/usr/bin/true", PLANNOTATOR_GLIMPSE: "0" }, stdout: "pipe", stderr: "pipe" });
    const opened = await new Response(launch.stdout).text();
    expect(await new Response(launch.stderr).text()).toBe("");
    expect(await launch.exited).toBe(0);
    const id = opened.match(/Session: (pn-[0-9a-f]{6})/)![1]!;
    const url = opened.match(/in Plannotator: (http:\/\/\S+)/)![1]!;
    expect(opened).toContain(join(project, "notes.md"));
    expect(await cli({ t3_thread_id: "thread-b", action: "list" })).not.toContain(id);
    expect(await cli({ t3_thread_id: "thread-a", action: "list" })).toContain(id);
    await eventually(async () => {
      const capability = await (await fetch(`${url}/api/ai/capabilities`)).json();
      return capability.providers?.some((provider: { sessionBridge?: { host: string; status: string } }) => provider.sessionBridge?.host === "t3" && provider.sessionBridge.status === "ready");
    });
    const created = await (await fetch(`${url}/api/ai/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ context: { mode: "annotate", annotate: { filePath: join(project, "notes.md"), markdown: "# Notes" } }, providerId: "session-bridge" }) })).json();
    const answer = await fetch(`${url}/api/ai/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: created.sessionId, prompt: "Explain this note." }) });
    expect(await answer.text()).toContain("Scripted T3 answer");
    // The command has exited. A stopped worker leaves the review alive; the next CLI adopts it.
    await daemonStatus(options, "thread-a", true);
    await eventually(async () => !(await daemonStatus(options, "thread-a") as { running: boolean }).running);
    expect(await cli({ t3_thread_id: "thread-a", action: "list" })).toContain(id);
    expect((await fetch(`${url}/api/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feedback: "", annotations: [] }) })).status).toBe(200);
    await eventually(() => (messages.get("thread-a") ?? []).some((item) => item.text?.includes(`(${id}) — Approved.`)));
    const decision = (messages.get("thread-a") ?? []).find((item) => item.text?.includes(`(${id}) — Approved.`));
    expect(decision?.text).toContain(`Target: ${join(project, "notes.md")}`);
    const closeOpened = await cli({ t3_thread_id: "thread-a", action: "annotate", target: "notes.md" });
    const closeId = closeOpened.match(/Session: (pn-[0-9a-f]{6})/)![1]!;
    const closeUrl = closeOpened.match(/in Plannotator: (http:\/\/\S+)/)![1]!;
    expect((await fetch(`${closeUrl}/api/draft`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ annotations: [{ id: "draft-comment", type: "comment", text: "Keep this draft", originalText: "sentence", createdAt: Date.now() }], globalAttachments: [], draftGeneration: 1, ts: Date.now() }) })).status).toBe(200);
    expect(await cli({ t3_thread_id: "thread-a", action: "close", session: closeId })).toContain("1 unsent comment saved as a draft");
    await pause(1500);
    expect((messages.get("thread-a") ?? []).some((item) => item.text?.includes(`(${closeId})`))).toBe(false);
    const reviewOpened = await cli({ t3_thread_id: "thread-a", action: "review" });
    const reviewId = reviewOpened.match(/Session: (pn-[0-9a-f]{6})/)![1]!;
    const reviewUrl = reviewOpened.match(/in Plannotator: (http:\/\/\S+)/)![1]!;
    expect((await fetch(`${reviewUrl}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: false, feedback: "T3 code feedback", annotations: [] }) })).status).toBe(200);
    await eventually(() => (messages.get("thread-a") ?? []).some((item) => item.text?.includes(`(${reviewId})`) && item.text.includes("T3 code feedback")));
    const lastOpened = await cli({ t3_thread_id: "thread-a", action: "last" });
    const lastId = lastOpened.match(/Session: (pn-[0-9a-f]{6})/)![1]!;
    const lastUrl = lastOpened.match(/in Plannotator: (http:\/\/\S+)/)![1]!;
    expect((await (await fetch(`${lastUrl}/api/plan`)).json()).plan).toBe("Scripted T3 answer");
    expect((await fetch(`${lastUrl}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feedback: "Shorten the last reply", annotations: [] }) })).status).toBe(200);
    await eventually(() => (messages.get("thread-a") ?? []).some((item) => item.text?.includes(`(${lastId})`) && item.text.includes("Shorten the last reply")));
    expect(existsSync(join(dataDir, "inbox"))).toBe(false);
    expect(messages.get("thread-b") ?? []).toHaveLength(0);
    expect(calls.filter((call) => call.name === "t3_thread_send" && String(call.args.message).includes("Explain this note."))).toHaveLength(1);
    const registry = JSON.parse(readFileSync(join(daemonDirectory(options, "thread-a"), "daemon.json"), "utf8")) as { port: number; token: string };
    expect((await fetch(`http://127.0.0.1:${registry.port}/review`, { method: "POST", headers: { authorization: `Bearer ${registry.token}`, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
  } finally {
    for (const thread of ["thread-a", "thread-b"]) {
      await daemonStatus(options, thread, true).catch(() => {});
    }
    await pause(300);
    t3.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
