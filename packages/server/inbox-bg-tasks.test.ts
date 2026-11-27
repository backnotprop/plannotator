/**
 * A thread's background tasks: a `tasks` bridge event sets the session's list,
 * [] clears it, a stale report changes nothing, and the list expires with the
 * TTL. A thread reads the tasks of its agent sessions through
 * `GET /api/inbox/threads/:id/tasks`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_BRIDGE_EVENT_PATH } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxBgTasks, INBOX_BG_TASKS_TTL_MS } from "./inbox-bg-tasks";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const savedBrowser = process.env.PLANNOTATOR_BROWSER;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedBrowser === undefined) delete process.env.PLANNOTATOR_BROWSER;
  else process.env.PLANNOTATOR_BROWSER = savedBrowser;
});

describe("Background tasks of a thread's agent", () => {
  test("a list sets the session's tasks, [] clears; stale reports lose; they expire with the TTL", async () => {
    let now = Date.UTC(2026, 10, 2, 12);
    const bg = createInboxBgTasks({} as InboxStore, { now: () => now });
    const event = (body: Record<string, unknown>) => bg.bridgeEvent("ses-a", { type: "tasks", ...body });
    const shell = { id: "b1", kind: "shell", description: "Wait for test run", command: "bun test", started_at: now - 70 * 3_600_000, last_output_at: now - 70 * 3_600_000 };
    const agent = { id: "a1", kind: "agent", description: "Build pin fix", agent_type: "general-purpose", started_at: now - 4 * 60_000, last_output_at: now - 30_000 };
    expect(bg.bridgeEvent("ses-a", { type: "state", busy: true })).toBeNull();
    expect(event({ at: now, tasks: [shell, agent, { kind: "shell" }] })!.status).toBe(200);
    expect(bg.of("ses-a")).toEqual([
      { id: "b1", kind: "shell", description: "Wait for test run", command: "bun test", started_at: new Date(shell.started_at).toISOString(), last_output_at: new Date(shell.last_output_at).toISOString() },
      { id: "a1", kind: "agent", description: "Build pin fix", agent_type: "general-purpose", started_at: new Date(agent.started_at).toISOString(), last_output_at: new Date(agent.last_output_at).toISOString() },
    ]);
    // Past the TTL with no fresh list: gone.
    now += INBOX_BG_TASKS_TTL_MS + 1;
    expect(bg.of("ses-a")).toEqual([]);
    event({ at: now, tasks: [shell] });
    expect(bg.of("ses-a").map((t) => t.id)).toEqual(["b1"]);
    // A stale report never overrides a newer list.
    event({ at: now - 5, tasks: [] });
    expect(bg.of("ses-a").map((t) => t.id)).toEqual(["b1"]);
    event({ at: now, tasks: [] });
    expect(bg.of("ses-a")).toEqual([]);
    // A host that cannot tell when a task last wrote leaves the field out, and it stays out.
    event({ at: now + 1, tasks: [{ id: "c1", kind: "agent", description: "Review", started_at: now }] });
    expect(bg.of("ses-a")).toEqual([{ id: "c1", kind: "agent", description: "Review", started_at: new Date(now).toISOString() }]);
    expect(() => event({ at: now + 2, tasks: "b1" })).toThrow();
    expect(() => event({ at: now + 2 })).toThrow();
  });

  test("a thread reads its session's tasks through the bridge route; another session's thread has none", async () => {
    process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-bg-tasks-")));
    roots.push(root);
    const project = join(root, "api");
    mkdirSync(project, { recursive: true });
    const server = await startInboxServer({ dataDir: join(root, "data"), feedbackUrl: "http://127.0.0.1:9/feedback" });
    servers.push(server);
    const client = new Client({ name: "inbox-bg-tasks-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    clients.push(client);
    const send = async (session: string, body: string) =>
      (
        await client.callTool({
          name: "send_message",
          arguments: { body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code" },
        })
      ).structuredContent as { thread_id: string };
    const report = (session: string, tasks: unknown) =>
      fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_EVENT_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ session, host: "claude-code", type: "tasks", at: Date.now(), tasks }),
      });
    const tasksOf = async (threadId: string) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}/tasks`);
      expect(response.status).toBe(200);
      return ((await response.json()) as { tasks: { id: string }[] }).tasks;
    };

    const mine = await send("ses-tasks", "Running the build in the background.");
    const other = await send("ses-none", "Nothing in the background.");
    expect(await tasksOf(mine.thread_id)).toEqual([]);
    const started = Date.now() - 4 * 60_000;
    expect((await report("ses-tasks", [{ id: "a9", kind: "agent", description: "Build pin fix", agent_type: "general-purpose", started_at: started, last_output_at: Date.now() }])).status).toBe(200);
    expect(await tasksOf(mine.thread_id)).toMatchObject([{ id: "a9", kind: "agent", description: "Build pin fix", agent_type: "general-purpose", started_at: new Date(started).toISOString() }]);
    expect(await tasksOf(other.thread_id)).toEqual([]);
    // A state event leaves the list; [] ends it.
    const state = await fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_EVENT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: "ses-tasks", host: "claude-code", type: "state", busy: true }),
    });
    expect(state.status).toBe(200);
    expect(await tasksOf(mine.thread_id)).toHaveLength(1);
    expect((await report("ses-tasks", [])).status).toBe(200);
    expect(await tasksOf(mine.thread_id)).toEqual([]);
    expect((await report("ses-tasks", { id: "x" })).status).toBe(422);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/msg_nope/tasks`)).status).toBe(404);
  });
});
