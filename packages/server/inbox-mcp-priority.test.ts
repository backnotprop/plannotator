/**
 * Thread priority, the agent's side, through send_message's own handler (no
 * server): the result's line and structured `priority` for a kept ask and for one the person took out, the
 * ask's lifecycle over several messages, and read_thread carrying nothing of it.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { INBOX_PRIORITY_REMOVED_TEXT, INBOX_PRIORITY_SET_TEXT } from "./inbox-mcp-priority";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result>; inputSchema?: unknown };

const REASON = "PR #88 green, 2 approvals: approve the merge";

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-mcp-ask-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "api", root: join(root, "api") });
  const context = { store, baseUrl: () => "http://localhost:1/", resolveProject: async () => project } as unknown as InboxMcpContext;
  const server = createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, Tool> };
  const tools = server._registeredTools;
  const send = async (input: Record<string, unknown>) => {
    const result = await tools.send_message!.handler({ project_path: project.root, agent_session: "ses_review", agent_host: "claude-code", agent_name: "Reviewer", ...input }, {});
    expect(result.isError).toBeUndefined();
    return { text: result.content.map((c) => c.text).join("\n"), structured: result.structuredContent! };
  };
  return { store, project, tools, send };
}

test("a kept ask says so in the result's first line and its structured `priority`", async () => {
  const w = world();
  const first = await w.send({ body: "Re-review done: checks green, 2 approvals.", subject: "PR #88: retry policy", priority: REASON });
  expect(first.text.split("\n")[0]).toContain(`).${INBOX_PRIORITY_SET_TEXT}`);
  expect(first.structured.priority).toBe("set");
  const thread = String(first.structured.thread_id);
  expect(w.store.priorityAsk(thread)).toMatchObject({ reason: REASON, agent: "Reviewer" });

  // No `priority`: no line, no structured field, and the earlier ask ends.
  const update = await w.send({ body: "New push; checks running.", reply_to: thread });
  expect(update.text).not.toContain("Priority");
  expect("priority" in update.structured).toBe(false);
  expect(w.store.priorityAsk(thread)).toBeNull();
});

test("after the person takes the thread out, a new ask is not kept and the result says so; once they write there, it is kept again", async () => {
  const w = world();
  const thread = String((await w.send({ body: "Plan v3 is final.", subject: "Plan v3", priority: "Plan v3 final: sign it off" })).structured.thread_id);
  w.store.setPriority(thread, false);

  const refused = await w.send({ body: "Plan v3, still final.", reply_to: thread, priority: "Plan v3 final: sign it off" });
  expect(refused.text.split("\n")[0]).toContain(`).${INBOX_PRIORITY_REMOVED_TEXT}`);
  expect(refused.structured.priority).toBe("removed_by_person");
  expect(w.store.priorityAsk(thread)).toBeNull();

  w.store.sendReply(String(refused.structured.message_id), { idempotency_key: "k1", words: "One more pass on the rollout." });
  const kept = await w.send({ body: "Rollout added. Final.", reply_to: thread, priority: "Plan v3 final with rollout: sign it off" });
  expect(kept.structured.priority).toBe("set");
  expect(w.store.priorityAsk(thread)!.reason).toBe("Plan v3 final with rollout: sign it off");
});

test("a reason with line breaks or over 120 characters is one line cut with …; a blank one is no ask", async () => {
  const w = world();
  const long = await w.send({ body: "Ready.", priority: `Release 2.4 staged\n\n${"and checked ".repeat(20)}` });
  const reason = w.store.priorityAsk(String(long.structured.thread_id))!.reason;
  expect(reason).not.toContain("\n");
  expect([...reason].length).toBeLessThanOrEqual(120);
  expect([...reason].length).toBeGreaterThan(110);
  expect(reason.endsWith("…")).toBe(true);
  const blank = await w.send({ body: "FYI.", priority: "  \n " });
  expect("priority" in blank.structured).toBe(false);
  expect(w.store.priorityAsk(String(blank.structured.thread_id))).toBeNull();
});

test("read_thread, one thread or the list, carries nothing of an ask: no field, no line, no reason", async () => {
  const w = world();
  const thread = String((await w.send({ body: "Release 2.4 is staged.", subject: "Release 2.4", priority: "Release 2.4 staged: ship it" })).structured.thread_id);
  const read = await w.tools.read_thread!.handler({ thread_id: thread, agent_session: "ses_review", agent_host: "claude-code" }, {});
  const list = await w.tools.read_thread!.handler({ project_path: w.project.root, agent_session: "ses_review", agent_host: "claude-code" }, {});
  for (const result of [read, list]) {
    const all = JSON.stringify(result);
    expect(all).toContain("Release 2.4");
    expect(all).not.toContain("ship it");
    expect(all).not.toContain("priority");
    expect(all).not.toContain("Priority");
  }
});

