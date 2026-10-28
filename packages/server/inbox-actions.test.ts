/**
 * Action items (approval "inbox-next-actions") through the Inbox's real doors: an
 * agent sends a `:::action` block over the official MCP client, the person's
 * Done / Can't do it / Undo go through `POST /api/inbox/messages/:id/actions/:key`
 * on a running Inbox (temp data dir, loopback, the Undo window shortened), and
 * the answer comes back as the person's reply: over the bridge with the exact
 * wake text, and through wait_for_reply. The window stages its marks
 * (`staged: true`, approval "inbox-action-items-in-reply"): they go only with
 * the person's Send (`actions` on the reply route). Failures to catch:
 * anything sent inside the Undo window, or a staged mark sent on a timer; a wake text that drifts; `done` accepted for another
 * thread or a question; the route open to another site or a stale tab.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { inboxActionTime } from "@plannotator/core/inbox-actions";
import type { InboxListRow, InboxListSection, InboxQuestion } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, INBOX_WAKE_INSTRUCTION, inboxWakeText, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
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
const SESSION = "ses_todo";

const BODY = [
  "Release 4.2 is built and every check passed.",
  "",
  ":::action",
  "Approve the production deploy on Vercel",
  'The build waits under "Promote to Production".',
  "Where: https://vercel.com/acme/web/deployments",
  "Stopped: release 4.2 cannot go out until it is approved",
  "Watching: the deployment; I go on by myself once it is Ready",
  ":::",
].join("\n");

type Structured = { thread_id: string; message_id: string; actions?: { key: string; prompt: string }[]; done?: string[] };

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-todo-")));
  roots.push(root);
  const project = join(root, "web");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), setAsideDelayMs: DELAY });
  servers.push(server);
  const client = new Client({ name: "inbox-todo-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (args: Record<string, unknown>) =>
    (await client.callTool({
      name: "send_message",
      arguments: { project_path: project, agent_session: SESSION, agent_name: "Claude Code", agent_host: "claude-code", ...args },
    })) as { isError?: boolean; content: { text: string }[]; structuredContent: Structured };
  const sent = await send({ body: BODY });
  return { server, client, send, sent: sent.structuredContent, text: sent.content[0]!.text };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const mark = (server: InboxServer, messageId: string, key: string, body: Record<string, unknown>) =>
  post(server, `/api/inbox/messages/${messageId}/actions/${key}`, { serverSession: server.serverSession, ...body });

async function rowOf(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const model = (await (await fetch(url(server, "/api/inbox/threads"))).json()) as { sections: InboxListSection[] };
  return model.sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
}

async function actionOf(server: InboxServer, threadId: string, messageId: string): Promise<InboxQuestion> {
  const model = (await (await fetch(url(server, `/api/inbox/threads/${threadId}`))).json()) as { thread: { messages: { id: string; questions?: InboxQuestion[] }[] } };
  return model.thread.messages.find((m) => m.id === messageId)!.questions!.find((q) => q.kind === "action")!;
}

async function setupClientFor(server: InboxServer) {
  const client = new Client({ name: "inbox-todo-reader", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { client };
}

async function poll(server: InboxServer) {
  const response = await fetch(url(server, INBOX_BRIDGE_POLL_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session: SESSION, waitMs: 0 }),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("an agent sends an action item", () => {
  test("send_message says it carries an action item and gives its key; the thread is Stopped on you; the wire marks it kind action", async () => {
    const { server, sent, text } = await setup();
    expect(text).toContain("Sent to the Plannotator Inbox with 1 action item");
    expect(sent.actions).toEqual([{ key: expect.stringMatching(/^a-[0-9a-f]{8}$/), prompt: "Approve the production deploy on Vercel" }]);
    const row = await rowOf(server, sent.thread_id);
    expect(row).toMatchObject({ section: "stopped", unread: true, questions: { open: 1, actions: 1, stopped: true } });
    // read_thread's text numbers it A1 and says "action item", never Q1.
    const { client } = (await setupClientFor(server));
    const read = (await client.callTool({ name: "read_thread", arguments: { thread_id: sent.thread_id } })) as { content: { text: string }[] };
    expect(read.content[0]!.text).toContain(`${sent.message_id}/${sent.actions![0]!.key} (A1) action item, open: Approve the production deploy on Vercel`);
    expect(read.content[0]!.text).not.toContain("(Q1)");
    const action = await actionOf(server, sent.thread_id, sent.message_id);
    expect(action).toMatchObject({
      kind: "action",
      state: "open",
      action: { where: "vercel.com", where_url: "https://vercel.com/acme/web/deployments", watching: "the deployment; I go on by myself once it is Ready" },
      action_result: null,
    });
  });
});

describe("the person's Done", () => {
  test("nothing goes inside the Undo window; then one reply, delivered over the bridge with the exact wake text and returned by wait_for_reply", async () => {
    const { server, client, sent } = await setup();
    const key = sent.actions![0]!.key;
    const answer = await mark(server, sent.message_id, key, { outcome: "done", note: "Approved. I also fixed the preview env var while I was there." });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { questions: InboxQuestion[] }).questions.find((q) => q.key === key)).toMatchObject({ state: "picked", action_result: { outcome: "done", by: "person" } });
    expect(await poll(server)).toEqual([]);
    // No reply written yet: the person's last word is still the agent's.
    expect((await rowOf(server, sent.thread_id)).last_author).toBe("agent");

    await sleep(DELAY + 250);
    const commands = await poll(server);
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    const at = (await actionOf(server, sent.thread_id, sent.message_id)).action_result!.at;
    const body = [
      "Did 1 action item.",
      "",
      "## Action items you asked for",
      "",
      "1 of 1 done.",
      "",
      "### A1. Approve the production deploy on Vercel",
      `Done, ${inboxActionTime(at)}.`,
      "Note: Approved. I also fixed the preview env var while I was there.",
    ].join("\n");
    expect(command).toMatchObject({ type: "reply", reply_to: sent.message_id, body });
    expect(inboxWakeText(command)).toBe(`Plannotator Inbox: Approve the production deploy on Vercel (${command.id})\n${INBOX_WAKE_INSTRUCTION}\n\n${body}\n\n[thread ${command.thread_id} · more: plannotator_inbox read_thread · how it works: plannotator inbox --help]`);

    const replied = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.thread_id, agent_session: SESSION, timeout_seconds: 1 } })) as {
      content: { text: string }[];
      structuredContent: { status: string; reply: { body: string } };
    };
    expect(replied.structuredContent).toMatchObject({ status: "replied", reply: { body } });
    // The action item reads A1 in the facts line, not Q1, under a label that names action items, with its result.
    expect(replied.content[0]!.text).toContain(`questions and action items of ${sent.message_id}: A1 ${key} done ·`);
    expect((await actionOf(server, sent.thread_id, sent.message_id)).state).toBe("sent");
    expect((await rowOf(server, sent.thread_id)).section).not.toBe("stopped");
    // Sent: no Undo.
    expect((await mark(server, sent.message_id, key, { outcome: null })).status).toBe(409);
  });

  test("Undo inside the window: nothing is ever sent; Can't do it needs a reason", async () => {
    const { server, sent } = await setup();
    const key = sent.actions![0]!.key;
    expect((await mark(server, sent.message_id, key, { outcome: "done" })).status).toBe(200);
    expect((await mark(server, sent.message_id, key, { outcome: null })).status).toBe(200);
    await sleep(DELAY + 250);
    expect(await poll(server)).toEqual([]);
    expect((await actionOf(server, sent.thread_id, sent.message_id)).state).toBe("open");
    const refused = await mark(server, sent.message_id, key, { outcome: "cant" });
    expect(refused.status).toBe(422);
    expect(await mark(server, sent.message_id, key, { outcome: "cant", note: "I'm not in the acme team; ask Dana." }).then((r) => r.status)).toBe(200);
    await sleep(DELAY + 250);
    const [command] = await poll(server);
    expect(command!.body).toBe("Couldn't do 1 action item.\n\n## Action items you asked for\n\n0 of 1 done.\n\n### A1. Approve the production deploy on Vercel\nCan't do it: I'm not in the acme team; ask Dana.");
  });

  test("the trailer names a Can't do it as such; a report with an item still open names it on its last line", async () => {
    const { server, client, send } = await setup();
    const two = (await send({ body: ":::action\nSign in to npm in your terminal\n:::\n\n:::action\nApprove the 2FA prompt for the npm org\n:::" })).structuredContent;
    const [a1, a2] = two.actions!;
    expect((await mark(server, two.message_id, a1!.key, { outcome: "cant", note: "No security key here." })).status).toBe(200);
    await sleep(DELAY + 250);
    const replied = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: two.thread_id, agent_session: SESSION, timeout_seconds: 1 } })) as {
      content: { text: string }[];
      structuredContent: { reply: { body: string } };
    };
    expect(replied.structuredContent.reply.body).toBe(
      [
        "Couldn't do 1 action item.",
        "",
        "## Action items you asked for",
        "",
        "0 of 2 done.",
        "",
        "### A1. Sign in to npm in your terminal",
        "Can't do it: No security key here.",
        "",
        "Still open: A2. Approve the 2FA prompt for the npm org — the person will do it in the Inbox; don't ask again.",
      ].join("\n"),
    );
    expect(replied.content[0]!.text).toContain(`questions and action items of ${two.message_id}: A1 ${a1!.key} can't do it; A2 ${a2!.key} open ·`);
  });

  test("the route's guards: a stale tab, another site, a question's key, an unknown message", async () => {
    const { server, sent, send } = await setup();
    const key = sent.actions![0]!.key;
    expect((await post(server, `/api/inbox/messages/${sent.message_id}/actions/${key}`, { serverSession: "srv_other", outcome: "done" })).status).toBe(409);
    expect((await post(server, `/api/inbox/messages/${sent.message_id}/actions/${key}`, { outcome: "done" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await mark(server, "msg_01ZZZZZZZZZZZZZZZZZZZZZZZZ", key, { outcome: "done" })).status).toBe(404);
    const asked = (await send({ body: ":::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::", reply_to: sent.message_id })).structuredContent;
    void asked;
    expect((await mark(server, sent.message_id, "a-00000000", { outcome: "done" })).status).toBe(404);
    expect((await mark(server, sent.message_id, key, { outcome: "maybe" })).status).toBe(422);
    expect((await actionOf(server, sent.thread_id, sent.message_id)).state).toBe("open");
  });
});

describe("the window's Done goes with the person's reply (approval \"inbox-action-items-in-reply\")", () => {
  test("a staged Done never goes on a timer; read_thread says it waits in the draft; the Send carries it with the words, once", async () => {
    const { server, client, sent } = await setup();
    const key = sent.actions![0]!.key;
    expect((await mark(server, sent.message_id, key, { outcome: "done", note: "Approved.", staged: true })).status).toBe(200);
    await sleep(DELAY + 250);
    expect(await poll(server)).toEqual([]);
    expect(await rowOf(server, sent.thread_id)).toMatchObject({ section: "stopped", last_author: "agent", unsent: { done: 1 } });
    const read = (await client.callTool({ name: "read_thread", arguments: { thread_id: sent.thread_id } })) as { content: { text: string }[] };
    expect(read.content[0]!.text).toContain(`(A1) done, note: "Approved." (in the person's reply draft, not sent yet)`);

    const reply = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, {
      serverSession: server.serverSession,
      idempotency_key: "send-1",
      words: "Go ahead with the release.",
      questions: [],
      actions: [{ key }],
    });
    expect(reply.status).toBe(200);
    const commands = await poll(server);
    expect(commands).toHaveLength(1);
    const at = (await actionOf(server, sent.thread_id, sent.message_id)).action_result!.at;
    expect(commands[0]!).toMatchObject({
      type: "reply",
      reply_to: sent.message_id,
      body: ["Did 1 action item.", "Go ahead with the release.", "## Action items you asked for", "1 of 1 done.", `### A1. Approve the production deploy on Vercel\nDone, ${inboxActionTime(at)}.\nNote: Approved.`].join("\n\n"),
    });
    expect((await actionOf(server, sent.thread_id, sent.message_id)).state).toBe("sent");
    // No second reply on a timer: only that one (the bridge hands it again until it is taken).
    await sleep(DELAY + 250);
    expect((await poll(server)).map((c) => c.id)).toEqual([commands[0]!.id]);
  });

  test("the route passes note_only: a note save landing after the take-back does not stage the item again", async () => {
    const { server, sent } = await setup();
    const key = sent.actions![0]!.key;
    expect((await mark(server, sent.message_id, key, { outcome: "done", staged: true })).status).toBe(200);
    expect((await mark(server, sent.message_id, key, { outcome: null, staged: true })).status).toBe(200);
    expect((await mark(server, sent.message_id, key, { outcome: "done", note: "Late.", staged: true, note_only: true })).status).toBe(200);
    expect(await actionOf(server, sent.thread_id, sent.message_id)).toMatchObject({ state: "open", action_result: null });
  });
});

describe("archive holds a pending Done back; Unarchive sends it", () => {
  test("the thread's Archive then Unarchive", async () => {
    const { server, sent } = await setup();
    const key = sent.actions![0]!.key;
    expect((await mark(server, sent.message_id, key, { outcome: "done" })).status).toBe(200);
    expect((await post(server, `/api/inbox/messages/${sent.message_id}/resolve`, { serverSession: server.serverSession, resolved: true })).status).toBe(200);
    await sleep(DELAY + 250);
    expect(await poll(server)).toEqual([]);
    expect((await post(server, `/api/inbox/messages/${sent.message_id}/resolve`, { serverSession: server.serverSession, resolved: false })).status).toBe(200);
    await sleep(100);
    const commands = await poll(server);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.body.startsWith("Did 1 action item.")).toBe(true);
    expect((await actionOf(server, sent.thread_id, sent.message_id)).state).toBe("sent");
  });

  test("the project's Archive all then its Undo", async () => {
    const { server, sent } = await setup();
    const key = sent.actions![0]!.key;
    expect((await mark(server, sent.message_id, key, { outcome: "done" })).status).toBe(200);
    const row = await rowOf(server, sent.thread_id);
    const archived = await post(server, `/api/inbox/projects/${row.project.id}/resolve`, { serverSession: server.serverSession, resolved: true, batch_id: "b1" });
    expect(archived.status).toBe(200);
    const batch = ((await archived.json()) as { batch: { resolved: string[]; read: string[] } }).batch;
    await sleep(DELAY + 250);
    expect(await poll(server)).toEqual([]);
    const undo = await post(server, `/api/inbox/projects/${row.project.id}/resolve`, { serverSession: server.serverSession, resolved: false, threads: batch });
    expect(undo.status).toBe(200);
    await sleep(100);
    expect(await poll(server)).toHaveLength(1);
  });
});

describe("supersedes on an action item", () => {
  test("the result names a superseded action item as an action item, not a question", async () => {
    const { send, sent } = await setup();
    const replaced = await send({ body: "The deploy was promoted by CI; no need.", reply_to: sent.message_id, supersedes: [`${sent.message_id}/${sent.actions![0]!.key}`] });
    expect(replaced.content[0]!.text).toContain(", superseding 1 earlier action item (");
    expect(replaced.content[0]!.text).not.toContain("earlier question");
  });
});

describe("the agent marks its own action item done", () => {
  test("done is recorded, the card reads it, nothing is sent; invalid ids refuse the whole send with invalid_done", async () => {
    const { server, send, sent } = await setup();
    const id = `${sent.message_id}/${sent.actions![0]!.key}`;
    const bad = await send({ body: "Ready.", reply_to: sent.message_id, done: [`${sent.message_id}/a-00000000`] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/^invalid_done: done: .*has no action item a-00000000.*Open action items in this thread: /);
    const ok = await send({ body: "The deployment is Ready, so I marked the action item done.", reply_to: sent.message_id, done: [id] });
    expect(ok.content[0]!.text).toContain("marking 1 action item done");
    expect(ok.structuredContent.done).toEqual([id]);
    expect(await actionOf(server, sent.thread_id, sent.message_id)).toMatchObject({ state: "closed", action_result: { outcome: "done", by: "agent", message_id: ok.structuredContent.message_id } });
    await sleep(DELAY + 250);
    expect(await poll(server)).toEqual([]);
    expect((await rowOf(server, sent.thread_id)).questions).toMatchObject({ open: 0, actions: 0 });
  });
});
