/**
 * Thread priority, the agent's side, through send_message's own handler (no server): `priority: true` marks the
 * thread with the person's own mark and `false` takes it out, each with its line and structured value; leaving it
 * out changes nothing; and read_thread carries nothing of it.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { INBOX_PRIORITY_IN_TEXT, INBOX_PRIORITY_OUT_TEXT } from "./inbox-mcp-priority";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> };

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-mcp-mark-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "api", root: join(root, "api") });
  const context = { store, baseUrl: () => "http://localhost:1/", resolveProject: async () => project } as unknown as InboxMcpContext;
  const tools = (createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  const send = async (input: Record<string, unknown>) => {
    const result = await tools.send_message!.handler({ project_path: project.root, agent_session: "ses_review", agent_host: "claude-code", agent_name: "Reviewer", ...input }, {});
    expect(result.isError).toBeUndefined();
    return { text: result.content.map((c) => c.text).join("\n"), structured: result.structuredContent! };
  };
  const marked = (thread: string) => store.priorities().threads.some((entry) => entry.thread_id === thread);
  return { store, project, tools, send, marked };
}

test("true marks the thread and says so; leaving it out changes nothing; false takes it out and says so", async () => {
  const w = world();
  const first = await w.send({ body: "Re-review done: checks green, 2 approvals.", subject: "PR #88: retry policy", priority: true });
  const thread = String(first.structured.thread_id);
  expect(first.text.split("\n")[0]).toContain(`).${INBOX_PRIORITY_IN_TEXT}`);
  expect(first.structured.priority).toBe(true);
  expect(w.marked(thread)).toBe(true);

  const update = await w.send({ body: "New push; checks running.", reply_to: thread });
  expect(update.text).not.toContain("Priority");
  expect("priority" in update.structured).toBe(false);
  expect(w.marked(thread)).toBe(true);

  const done = await w.send({ body: "Merged.", reply_to: thread, priority: false });
  expect(done.text.split("\n")[0]).toContain(`).${INBOX_PRIORITY_OUT_TEXT}`);
  expect(done.structured.priority).toBe(false);
  expect(w.marked(thread)).toBe(false);
});

test("the agent's mark is the person's own: the person's Remove takes it out, a later true puts it back, and a mark keeps its first time", async () => {
  const w = world();
  const thread = String((await w.send({ body: "Plan v3 is final.", subject: "Plan v3", priority: true })).structured.thread_id);
  const at = w.store.priorities().threads[0]!.at;
  await w.send({ body: "Still final.", reply_to: thread, priority: true });
  expect(w.store.priorities().threads).toEqual([{ thread_id: thread, at }]);

  w.store.setPriority(thread, false);
  expect(w.marked(thread)).toBe(false);
  await w.send({ body: "Rollout added.", reply_to: thread });
  expect(w.marked(thread)).toBe(false);
  await w.send({ body: "Final with rollout.", reply_to: thread, priority: true });
  expect(w.marked(thread)).toBe(true);
});

test("read_thread, one thread or the list, carries nothing of the mark", async () => {
  const w = world();
  const thread = String((await w.send({ body: "Release 2.4 is staged.", subject: "Release 2.4", priority: true })).structured.thread_id);
  const read = await w.tools.read_thread!.handler({ thread_id: thread, agent_session: "ses_review", agent_host: "claude-code" }, {});
  const list = await w.tools.read_thread!.handler({ project_path: w.project.root, agent_session: "ses_review", agent_host: "claude-code" }, {});
  for (const result of [read, list]) {
    const all = JSON.stringify(result);
    expect(all).toContain("Release 2.4");
    expect(all).not.toMatch(/priority/i);
  }
});
