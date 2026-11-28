/**
 * Removing an agent from a thread, on the server's side that needs no running Inbox (approval
 * "inbox-remove-agent-from-thread"): the device door takes the two routes for a phone and a linked machine, the
 * outbox holds them as states, the list advertises the mark that lets a linked machine offer Remove, and a removed
 * agent's own post carries the one approved line in its send_message result (and only then).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_LINKED_MARKS } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { doorRouteOf } from "./inbox-devices";
import { DOOR_WRITES } from "./inbox-outbox";
import { createInboxMcpServer, INBOX_REMOVED_FROM_THREAD_TEXT, type InboxMcpContext } from "./inbox-mcp";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the door, the outbox and the mark", () => {
  test("a phone and a linked machine reach both routes on the thread's machine", () => {
    for (const machine of [false, true]) {
      expect(doorRouteOf("POST", "threads/msg_01ABC/remove-agent", machine)?.windowPath).toBe("/api/inbox/threads/msg_01ABC/remove-agent");
      expect(doorRouteOf("POST", "threads/msg_01ABC/remove-agent/undo", machine)?.windowPath).toBe("/api/inbox/threads/msg_01ABC/remove-agent/undo");
    }
    expect(doorRouteOf("GET", "threads/msg_01ABC/remove-agent", false)).toBeNull();
  });

  test("held for a machine that is away, each is a state (a second copy writes nothing), and the list says it takes them", () => {
    expect(DOOR_WRITES["POST threads/:id/remove-agent"]).toBe("set");
    expect(DOOR_WRITES["POST threads/:id/remove-agent/undo"]).toBe("set");
    expect(INBOX_LINKED_MARKS).toContain("remove-agent");
  });
});

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> };

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-remove-agent-mcp-")));
  roots.push(root);
  const folder = join(root, "billing-svc");
  mkdirSync(folder, { recursive: true });
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "billing-svc", root: folder });
  const context = {
    store,
    baseUrl: () => "http://localhost:1/",
    resolveProject: async () => project,
    projectRootOf: async () => ({ root: folder }),
  } as unknown as InboxMcpContext;
  const tools = (createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  const send = async (session: string, host: string, input: Record<string, unknown>) => {
    const result = await tools.send_message!.handler({ project_path: folder, agent_session: session, agent_host: host, agent_name: null, ...input }, {});
    expect(result.isError ?? false).toBe(false);
    return { text: result.content.map((c) => c.text).join("\n"), structured: result.structuredContent ?? {} };
  };
  return { store, send };
}

describe("a removed agent's post", () => {
  test("lands, and its result carries the one line; another agent's post and a new thread do not", async () => {
    const { store, send } = world();
    const started = await send("ses_billing_api", "claude-code", { subject: "Stripe 409s", body: "Stripe answers 409 on refunds with a reused key." });
    const threadId = String(started.structured.thread_id);
    expect(started.text).not.toContain(INBOX_REMOVED_FROM_THREAD_TEXT);
    const root = store.message(threadId)!;
    store.sendReply(root.id, { idempotency_key: "add", words: "@Codex the webhook side too.", tags: [{ host: "codex", session: "ses_webhooks", label: "Codex", wakes: true, joined: true }] });
    const before = await send("ses_webhooks", "codex", { reply_to: root.id, body: "The webhook retries reuse the old key." });
    expect(before.text).not.toContain(INBOX_REMOVED_FROM_THREAD_TEXT);

    store.removeFromThread(threadId, "ses_webhooks");
    const after = await send("ses_webhooks", "codex", { reply_to: root.id, body: "Replays are done." });
    expect(after.structured.thread_id).toBe(threadId);
    expect(after.text.split("\n").filter((line) => line === INBOX_REMOVED_FROM_THREAD_TEXT)).toHaveLength(1);
    expect(store.removedFrom(threadId).has("ses_webhooks")).toBe(true);
    // Once per removal: its next post there carries nothing, and it is still out.
    const second = await send("ses_webhooks", "codex", { reply_to: root.id, body: "Dedupe table checked too." });
    expect(second.text).not.toContain(INBOX_REMOVED_FROM_THREAD_TEXT);
    expect(store.removedFrom(threadId).has("ses_webhooks")).toBe(true);

    const owner = await send("ses_billing_api", "claude-code", { reply_to: root.id, body: "Fixed on my side." });
    expect(owner.text).not.toContain(INBOX_REMOVED_FROM_THREAD_TEXT);
    const fresh = await send("ses_webhooks", "codex", { subject: "Dedupe table", body: "A new thread of its own." });
    expect(fresh.text).not.toContain(INBOX_REMOVED_FROM_THREAD_TEXT);

    // Once the person writes to it again, its next post carries nothing.
    store.sendReply(root.id, { idempotency_key: "back", words: "@Codex hold the replays.", tags: [{ host: "codex", session: "ses_webhooks", label: "Codex", wakes: true }] });
    const back = await send("ses_webhooks", "codex", { reply_to: root.id, body: "Holding them." });
    expect(back.text).not.toContain(INBOX_REMOVED_FROM_THREAD_TEXT);

    // Removed again: a new removal, so its first post after it carries the line once more.
    store.removeFromThread(threadId, "ses_webhooks");
    const again = await send("ses_webhooks", "codex", { reply_to: root.id, body: "Replays held." });
    expect(again.text.split("\n").filter((line) => line === INBOX_REMOVED_FROM_THREAD_TEXT)).toHaveLength(1);
  });
});
