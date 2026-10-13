/**
 * Mark read through the Inbox's real doors: `POST /api/inbox/threads/:id/read`
 * and `/unread` on a running Inbox (temp data dir, loopback), the agent side
 * over the official MCP client. Guards as for `/seen`: same origin and the
 * page's serverSession. The set-aside note waits out the Undo window
 * (shortened here) and reaches the agent like a reply; a Send that skips
 * never records a decision.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection, InboxQuestion } from "@plannotator/core/inbox-types";
import { INBOX_REOPENED_HEADING, INBOX_SET_ASIDE_HEADING } from "@plannotator/core/inbox-questions";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DELAY = 150;

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-markread-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), setAsideDelayMs: DELAY });
  servers.push(server);
  const client = new Client({ name: "inbox-mark-read-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const sent = (await client.callTool({
    name: "send_message",
    arguments: {
      project_path: project,
      agent_session: "ses_mr",
      agent_name: "Claude Code",
      body: [
        "Before I build the list:",
        "",
        ":::question",
        "Which layout should the invoice list use?",
        "",
        "Stopped: the list cannot be built without this.",
        "",
        "Decision: when answered",
        "",
        "- [ ] Cards",
        "- [ ] A dense table",
        ":::",
      ].join("\n"),
    },
  })) as { structuredContent: { thread_id: string; message_id: string } };
  return { server, client, threadId: sent.structuredContent.thread_id, messageId: sent.structuredContent.message_id };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

async function rowOf(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const model = (await (await fetch(url(server, "/api/inbox/threads"))).json()) as { sections: InboxListSection[] };
  return model.sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
}

async function questionsOf(server: InboxServer, threadId: string): Promise<InboxQuestion[]> {
  const model = (await (await fetch(url(server, `/api/inbox/threads/${threadId}`))).json()) as { thread: { messages: { questions?: InboxQuestion[] }[] } };
  return model.thread.messages.flatMap((m) => m.questions ?? []);
}

describe("POST /api/inbox/threads/:id/read and /unread", () => {
  test("read moves the row to Quiet with its question closed; unread moves it back", async () => {
    const { server, threadId } = await setup();
    expect((await rowOf(server, threadId)).section).toBe("stopped");
    const res = await post(server, `/api/inbox/threads/${threadId}/read`, { serverSession: server.serverSession });
    expect(res.status).toBe(200);
    const { thread } = (await res.json()) as { thread: InboxListRow };
    expect(thread.section).toBe("quiet");
    expect(thread.read_at).not.toBeNull();
    expect((await questionsOf(server, threadId))[0]).toMatchObject({ state: "closed", answer: { skipped: true } });

    const back = await post(server, `/api/inbox/threads/${threadId}/unread`, {});
    expect(back.status).toBe(200);
    expect(((await back.json()) as { thread: InboxListRow }).thread.section).toBe("stopped");
    expect((await questionsOf(server, threadId))[0]).toMatchObject({ state: "open", answer: null });
  });

  test("the same guards as /seen: a cross-site page, another session's tab, a GET, an unknown thread", async () => {
    const { server, threadId } = await setup();
    const cross = await post(server, `/api/inbox/threads/${threadId}/read`, {}, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    const stale = await post(server, `/api/inbox/threads/${threadId}/read`, { serverSession: "an-older-inbox" });
    expect(stale.status).toBe(409);
    expect((await fetch(url(server, `/api/inbox/threads/${threadId}/read`))).status).toBe(405);
    expect((await post(server, "/api/inbox/threads/msg_00000000000000000000000000/read", {})).status).toBe(404);
    // Nothing above changed the thread.
    expect((await rowOf(server, threadId)).section).toBe("stopped");
  });

  test("an archived thread refuses with 409", async () => {
    const { server, threadId, messageId } = await setup();
    await post(server, `/api/inbox/messages/${messageId}/resolve`, { resolved: true });
    const res = await post(server, `/api/inbox/threads/${threadId}/read`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("thread_resolved");
  });

  test("after the Undo window the asking agent gets one set-aside note, which wait_for_reply returns", async () => {
    const { server, client, threadId } = await setup();
    await post(server, `/api/inbox/threads/${threadId}/read`, {});
    // Inside the window nothing was written.
    expect(server.store.thread(threadId)!.messages).toHaveLength(1);
    await Bun.sleep(DELAY + 400);
    const messages = server.store.thread(threadId)!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]!.body.split("\n")[0]).toBe(INBOX_SET_ASIDE_HEADING);
    const waited = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: threadId, agent_session: "ses_mr", timeout_seconds: 1 } })) as {
      structuredContent: { status: string; reply?: { body: string } };
    };
    expect(waited.structuredContent.status).not.toBe("waiting");
    expect(JSON.stringify(waited.structuredContent)).toContain("Which layout should the invoice list use?");
    expect((await rowOf(server, threadId)).section).toBe("quiet");
  });

  test("Undo after the note went: the agent gets one reopened note", async () => {
    const { server, threadId } = await setup();
    await post(server, `/api/inbox/threads/${threadId}/read`, {});
    await Bun.sleep(DELAY + 400);
    await post(server, `/api/inbox/threads/${threadId}/unread`, {});
    const messages = server.store.thread(threadId)!.messages;
    expect(messages.map((m) => m.body.split("\n")[0])).toEqual([messages[0]!.body.split("\n")[0], INBOX_SET_ASIDE_HEADING, INBOX_REOPENED_HEADING]);
  });

  test("archived inside the window, then unarchived: the note still goes", async () => {
    const { server, threadId, messageId } = await setup();
    await post(server, `/api/inbox/threads/${threadId}/read`, {});
    await post(server, `/api/inbox/messages/${messageId}/resolve`, { resolved: true });
    await Bun.sleep(DELAY + 400);
    // Archived: nothing goes while the thread is archived.
    expect(server.store.thread(threadId)!.messages).toHaveLength(1);
    await post(server, `/api/inbox/messages/${messageId}/resolve`, { resolved: false });
    await Bun.sleep(DELAY + 400);
    const messages = server.store.thread(threadId)!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]!.body.split("\n")[0]).toBe(INBOX_SET_ASIDE_HEADING);
  });

  test("Undo inside the window: the agent is never told", async () => {
    const { server, threadId } = await setup();
    await post(server, `/api/inbox/threads/${threadId}/read`, {});
    await post(server, `/api/inbox/threads/${threadId}/unread`, {});
    await Bun.sleep(DELAY + 400);
    expect(server.store.thread(threadId)!.messages).toHaveLength(1);
  });
});

describe("POST /api/inbox/messages/:id/reply with skip_unanswered", () => {
  test("a words-only Send skips the question, records no decision, and the row leaves the top", async () => {
    const { server, threadId, messageId } = await setup();
    const res = await post(server, `/api/inbox/messages/${messageId}/reply`, {
      idempotency_key: "k-1",
      words: "Redo the design.",
      questions: [],
      skip_unanswered: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: { body: string }; decisions: unknown[]; decisions_refused: unknown[]; questions: InboxQuestion[] };
    expect(body.reply.body.split("\n")[0]).toBe("Skipped 1 question.");
    expect(body.questions[0]).toMatchObject({ state: "sent", answer: { skipped: true, by_reply: true }, decision_id: null });
    // The question said "Decision: when answered", but a skip decides nothing.
    expect(body.decisions).toEqual([]);
    expect(body.decisions_refused).toEqual([]);
    expect((await rowOf(server, threadId)).section).toBe("sent");
  });

  test("a skip-only target whose questions closed meanwhile is a 200 no-op, not a refusal", async () => {
    const { server, threadId, messageId } = await setup();
    await post(server, `/api/inbox/threads/${threadId}/read`, {});
    const res = await post(server, `/api/inbox/messages/${messageId}/reply`, { idempotency_key: "k-2", questions: [], skip_unanswered: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reply: null, nothing_to_send: true, decisions_refused: [] });
    expect(server.store.thread(threadId)!.messages).toHaveLength(1);
    // Without skip_unanswered an empty Send is still refused, as before.
    expect((await post(server, `/api/inbox/messages/${messageId}/reply`, { idempotency_key: "k-3", questions: [] })).status).toBe(422);
  });
});

describe("POST /api/inbox/messages/:id/reply with words only (approval inbox-words-only-reply)", () => {
  const STILL_OPEN = "No question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.";

  test("Keep open: the question stays open and wait_for_reply hands the agent the words and the still-open line", async () => {
    const { server, client, threadId, messageId } = await setup();
    const res = await post(server, `/api/inbox/messages/${messageId}/reply`, {
      idempotency_key: "k-1",
      words: "Received, I'll answer later.",
      questions: [],
      skip_unanswered: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: { body: string }; questions: InboxQuestion[] };
    expect(body.reply.body).toBe(`Received, I'll answer later.\n\n${STILL_OPEN}`);
    expect(body.questions[0]).toMatchObject({ state: "open", answer: null });
    expect((await rowOf(server, threadId)).section).toBe("stopped");
    const waited = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: threadId, agent_session: "ses_mr", timeout_seconds: 1 } })) as {
      structuredContent: { status: string; reply?: { body: string } };
    };
    expect(waited.structuredContent.reply?.body).toBe(`Received, I'll answer later.\n\n${STILL_OPEN}`);
  });

  test("no skip_unanswered at all (the phone door, an older window): the same reply", async () => {
    const { server, messageId } = await setup();
    const res = await post(server, `/api/inbox/messages/${messageId}/reply`, { idempotency_key: "k-1", words: "Still thinking." });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: { body: string } }).reply.body).toBe(`Still thinking.\n\n${STILL_OPEN}`);
  });
});
