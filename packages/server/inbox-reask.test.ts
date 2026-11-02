/**
 * Re-ask (approval "inbox-reask") through the server's real doors: the
 * window's route and its guards, the connection's poll (the wake's own
 * line), an MCP agent that reads the note with read_thread and
 * supersedes its old questions through send_message, and the phone's door.
 * Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_REASK_INSTRUCTION,
  INBOX_WAKE_INSTRUCTION,
  inboxReaskInstruction,
  inboxReaskRedirectedLine,
  inboxRedirectedLine,
  inboxWakeClosingLine,
  inboxWakeText,
  parseInboxBridgeCommands,
} from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(options: { phones?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reask-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, ...(options.phones ? { phones: true } : {}) });
  servers.push(server);
  const client = new Client({ name: "inbox-reask-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const block = (prompt: string, extra: string[] = []) => [":::question", prompt, "", ...extra, "- [ ] Yes", "- [ ] No", ":::"].join("\n");

async function send(client: Client, project: string, session: string, args: Record<string, unknown>) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", ...args },
  });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as { message_id: string; thread_id: string };
}

/** Three open questions over two messages of one session. */
async function seed(client: Client, project: string, session = "ses-a") {
  const first = await send(client, project, session, { body: `Two calls.\n\n${block("Backfill ledger first?")}\n\n${block("Keep the old webhook?")}` });
  const second = await send(client, project, session, { reply_to: first.message_id, body: `One more.\n\n${block("Move refunds now?")}` });
  return { thread: first.thread_id, first: first.message_id, second: second.message_id };
}

function post(server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const reask = (server: InboxServer, id: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  post(server, `/api/inbox/messages/${id}/reask`, { serverSession: server.serverSession, ...body }, headers);

async function thread(server: InboxServer, id: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
}
async function row(server: InboxServer, id: string): Promise<InboxListRow> {
  const list = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: InboxListRow[] }[] };
  return list.sections.flatMap((s) => s.threads).find((t) => t.thread_id === id)!;
}
const bridge = (server: InboxServer, path: string, body: unknown) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });

describe("Re-ask over the window's route", () => {
  test("writes the note, puts the row in Sent, and answers a replay with the same note", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    expect((await row(server, t.thread)).section).toBe("waiting");
    const response = await reask(server, t.second, { idempotency_key: "k1" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { reply: { id: string; reask: string[] }; replayed: boolean };
    expect(body.reply.reask).toHaveLength(3);
    expect(body.replayed).toBe(false);
    const after = await row(server, t.thread);
    expect(after.section).toBe("sent");
    expect(after.reask_pending).toBe(true);
    const replay = (await (await reask(server, t.second, { idempotency_key: "k1" })).json()) as { reply: { id: string }; replayed: boolean };
    expect(replay).toMatchObject({ reply: { id: body.reply.id }, replayed: true });
    expect((await thread(server, t.thread)).messages).toHaveLength(3);
  });

  test("guards: another site, a stale tab, an unknown message, no key, a session that is not live, nothing left to ask; nothing written", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    expect((await reask(server, t.second, { idempotency_key: "x1" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await reask(server, t.second, { idempotency_key: "x2" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post(server, `/api/inbox/messages/${t.second}/reask`, { serverSession: "stale", idempotency_key: "x3" })).status).toBe(409);
    expect((await reask(server, "msg_01K7000000000000000000NONE", { idempotency_key: "x4" })).status).toBe(404);
    expect((await reask(server, t.second, {})).status).toBe(422);
    const notLive = await reask(server, t.second, { idempotency_key: "x5", to: { session: "ses-gone" } });
    expect(notLive.status).toBe(409);
    expect(((await notLive.json()) as { code: string }).code).toBe("session_not_live");
    expect((await thread(server, t.thread)).messages).toHaveLength(2);
    // A person's message takes no Re-ask.
    const note = (await (await reask(server, t.second, { idempotency_key: "k1" })).json()) as { reply: { id: string } };
    expect((await reask(server, note.reply.id, { idempotency_key: "x6" })).status).toBe(422);
    // A thread with nothing open: 409 nothing_to_reask.
    const lone = await send(client, project, "ses-z", { body: "Just an update, nothing to ask." });
    const nothing = await reask(server, lone.message_id, { idempotency_key: "x7" });
    expect(nothing.status).toBe(409);
    expect(((await nothing.json()) as { code: string }).code).toBe("nothing_to_reask");
  });
});

describe("Re-ask reaches the agent", () => {
  test("a waking connection gets the note with the Re-ask wake line, not the reply's", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    const note = (await (await reask(server, t.second, { idempotency_key: "k1" })).json()) as { reply: { id: string; body: string } };
    const polled = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-a", host: "claude-code", project_path: project, waitMs: 0 });
    const [command] = parseInboxBridgeCommands(await polled.text());
    expect(command).toMatchObject({ type: "reply", id: note.reply.id, reask: true });
    const wake = inboxWakeText(command!);
    expect(wake.split("\n")[1]).toBe(INBOX_REASK_INSTRUCTION);
    expect(wake).not.toContain(INBOX_WAKE_INSTRUCTION);
    expect(wake.endsWith(`${note.reply.body}\n\n${inboxWakeClosingLine(command!.thread_id)}`)).toBe(true);
    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "delivered", id: note.reply.id })).status).toBe(200);
    // Delivered, and still Sent: the agent has not asked again yet.
    expect((await row(server, t.thread)).section).toBe("sent");
  });

  test("an MCP agent reads the note with read_thread, re-asks with Replaces: lines and drops one with supersedes", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    const note = (await (await reask(server, t.second, { idempotency_key: "k1" })).json()) as { reply: { id: string; reask: string[] } };
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id: t.thread, agent_session: "ses-a" } });
    const text = JSON.stringify(read.content);
    expect(text).toContain("Please ask your 3 open questions in this thread again");
    expect(text).toContain(`reply_to ${note.reply.id}`);
    // The agent re-asks the first two and drops the third, as the note says.
    const [q1, q2, q3] = note.reply.reask as [string, string, string];
    const answer = await send(client, project, "ses-a", {
      reply_to: note.reply.id,
      supersedes: [q3],
      body: `Here they are; refunds already moved.\n\n${block("Backfill ledger first?", [`Replaces: ${q1}`, ""])}\n\n${block("Keep the old webhook?", [`Replaces: ${q2}`, ""])}`,
    });
    const after = await thread(server, t.thread);
    const old = after.messages.filter((m) => m.id === t.first || m.id === t.second).flatMap((m) => m.questions ?? []);
    expect(old.map((q) => q.state)).toEqual(["superseded", "superseded", "superseded"]);
    expect(old[2]!.superseded_by).toEqual({ message_id: answer.message_id, key: null });
    expect(old[0]!.superseded_by?.key).not.toBeNull();
    const r = await row(server, t.thread);
    expect(r.reask_pending).toBe(false);
    expect(r.section).toBe("waiting");
  });
});

describe("Re-ask with action items (owner, #2059)", () => {
  test("the note lists the open action item with the questions; the agent asks it again with a Replaces: line in a :::action block and marks another done", async () => {
    const { server, client, project } = await setup();
    const first = await send(client, project, "ses-a", {
      body: `Two things.\n\n${block("Backfill ledger first?")}\n\n:::action\nApprove the ledger migration in Stripe\nWhere: https://dashboard.stripe.com/migrations\n:::\n\n:::action\nRotate the webhook secret\n:::`,
    });
    const before = await thread(server, first.thread_id);
    const items = before.messages[0]!.questions!;
    const [todo1, todo2] = items.filter((q) => q.kind === "action");
    // The person marks one Done: inside its Undo window it is not open, so not asked again.
    expect((await post(server, `/api/inbox/messages/${first.message_id}/actions/${todo2!.key}`, { serverSession: server.serverSession, outcome: "done" })).status).toBe(200);
    const response = await reask(server, first.message_id, { idempotency_key: "k1" });
    expect(response.status).toBe(200);
    const note = ((await response.json()) as { reply: { id: string; reask: string[]; body: string } }).reply;
    const question = items.find((q) => q.kind !== "action")!;
    expect([...note.reask].sort()).toEqual([`${first.message_id}/${question.key}`, `${first.message_id}/${todo1!.key}`].sort());
    expect(note.body.split("\n")[0]).toBe("Please ask your 1 open question and 1 open action item in this thread again, together in one new message, so the person can answer them in one place.");
    expect((await row(server, first.thread_id)).reask_pending).toBe(true);
    // The agent asks the question and the action item again.
    const answer = await send(client, project, "ses-a", {
      reply_to: note.id,
      body: `Asked again.\n\n${block("Backfill ledger first?", [`Replaces: ${first.message_id}/${question.key}`, ""])}\n\n:::action\nApprove the ledger migration in Stripe\nIt is still pending in the dashboard.\nReplaces: ${first.message_id}/${todo1!.key}\n:::`,
    });
    const after = await thread(server, first.thread_id);
    const old = after.messages.find((m) => m.id === first.message_id)!.questions!;
    expect(old.find((q) => q.key === todo1!.key)).toMatchObject({ state: "superseded", superseded_by: { message_id: answer.message_id, key: expect.stringMatching(/^a-/) } });
    expect(old.find((q) => q.key === question.key)!.state).toBe("superseded");
    expect(old.find((q) => q.key === todo2!.key)!.state).toBe("picked");
    expect((await row(server, first.thread_id)).reask_pending).toBe(false);
  });
});

describe("Re-ask to another session (the asker ended)", () => {
  test("the note names whose questions they are, and the wake says the questions are another session's", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    // Another session of the project is live (it polled).
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-c", host: "claude-code", project_path: project, waitMs: 0 });
    const sent = await reask(server, t.second, { idempotency_key: "k1", to: { host: "claude-code", session: "ses-c" } });
    expect(sent.status).toBe(200);
    const note = ((await sent.json()) as { reply: { id: string; body: string } }).reply;
    expect(note.body.startsWith("Please ask the 3 open questions Claude Code asked in this thread again")).toBe(true);
    const polled = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-c", host: "claude-code", project_path: project, waitMs: 0 });
    const [command] = parseInboxBridgeCommands(await polled.text());
    expect(command).toMatchObject({ id: note.id, reask: true, redirected_from: "Claude Code" });
    const lines = inboxWakeText(command!).split("\n");
    expect(lines[1]).toBe(INBOX_REASK_INSTRUCTION);
    expect(lines[2]).toBe(inboxReaskRedirectedLine("Claude Code", note.id));
    expect(lines[2]).not.toBe(inboxRedirectedLine("Claude Code", note.id));
  });
});

describe("Re-ask with action items to another session (#2059 review 3)", () => {
  test("the wake names what the note lists, and the session it went to may mark the listed action items done", async () => {
    const { server, client, project } = await setup();
    const first = await send(client, project, "ses-a", {
      body: `Two things.\n\n${block("Backfill ledger first?")}\n\n:::action\nApprove the ledger migration in Stripe\n:::`,
    });
    const items = (await thread(server, first.thread_id)).messages[0]!.questions!;
    const action = items.find((q) => q.kind === "action")!;
    const ref = `${first.message_id}/${action.key}`;
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-c", host: "claude-code", project_path: project, waitMs: 0 });
    const sent = await reask(server, first.message_id, { idempotency_key: "k1", to: { host: "claude-code", session: "ses-c" } });
    expect(sent.status).toBe(200);
    const note = ((await sent.json()) as { reply: { id: string } }).reply;
    const polled = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-c", host: "claude-code", project_path: project, waitMs: 0 });
    const [command] = parseInboxBridgeCommands(await polled.text());
    expect(command).toMatchObject({ id: note.id, reask: true, reask_items: "both", redirected_from: "Claude Code" });
    const lines = inboxWakeText(command!).split("\n");
    expect(lines[1]).toBe(inboxReaskInstruction("both"));
    expect(lines[1]).toContain("for the open questions and action items in this thread");
    expect(lines[2]).toBe(inboxReaskRedirectedLine("Claude Code", note.id, "both"));
    expect(lines[2]!.startsWith("These questions and action items were asked by another Claude Code session")).toBe(true);
    // A third session is not the note's: its `done` is refused, and nothing is written.
    const refused = await client.callTool({
      name: "send_message",
      arguments: { project_path: project, agent_session: "ses-x", agent_host: "claude-code", reply_to: note.id, body: "Ready.", done: [ref] },
    });
    expect(refused.isError).toBe(true);
    // The session the note went to marks it done, and drops the question with supersedes, in one message.
    await send(client, project, "ses-c", {
      reply_to: note.id,
      body: "The migration is approved (I saw it in the dashboard); the backfill question no longer applies.",
      done: [ref],
      supersedes: [`${first.message_id}/${items.find((q) => q.kind !== "action")!.key}`],
    });
    const after = (await thread(server, first.thread_id)).messages[0]!.questions!;
    expect(after.find((q) => q.key === action.key)).toMatchObject({ state: "closed", action_result: { outcome: "done", by: "agent" } });
  });

  test("a note listing only action items: the wake says action items, never questions", async () => {
    const { server, client, project } = await setup();
    const first = await send(client, project, "ses-a", { body: ":::action\nTouch your YubiKey\n:::\n\n:::action\nApprove the npm 2FA prompt\n:::" });
    const sent = await reask(server, first.message_id, { idempotency_key: "k1" });
    const note = ((await sent.json()) as { reply: { id: string } }).reply;
    const polled = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-a", host: "claude-code", project_path: project, waitMs: 0 });
    const command = parseInboxBridgeCommands(await polled.text()).find((c) => c.id === note.id)!;
    expect(command).toMatchObject({ reask: true, reask_items: "actions" });
    expect((command as { reask_one?: boolean }).reask_one).toBeUndefined();
    expect(inboxWakeText(command).split("\n")[1]).toBe(
      "The person asked, from the Plannotator Inbox, for the open action items in this thread to be asked again, together in one new message. The action items and what to do with each follow. Answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above.",
    );
  });

  test("one open action item: the wake says it in the singular", async () => {
    const { server, client, project } = await setup();
    const first = await send(client, project, "ses-a", { body: ":::action\nTouch your YubiKey\n:::" });
    const note = ((await (await reask(server, first.message_id, { idempotency_key: "k1" })).json()) as { reply: { id: string; body: string } }).reply;
    expect(note.body.split("\n")[0]).toBe("Please ask your open action item in this thread again, in one new message, so the person can answer it in one place.");
    const polled = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-a", host: "claude-code", project_path: project, waitMs: 0 });
    const command = parseInboxBridgeCommands(await polled.text()).find((c) => c.id === note.id)!;
    expect(command).toMatchObject({ reask: true, reask_items: "actions", reask_one: true });
    expect(inboxWakeText(command).split("\n")[1]).toBe(
      "The person asked, from the Plannotator Inbox, for the open action item in this thread to be asked again, in one new message. The action item and what to do with it follow. Answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above.",
    );
  });

  test("one open question (owner, 2026-10-23): the note and the wake say it in the singular", async () => {
    const { server, client, project } = await setup();
    const first = await send(client, project, "ses-a", { body: `One call.\n\n${block("Backfill ledger first?")}` });
    const response = await reask(server, first.message_id, { idempotency_key: "k1" });
    expect(response.status).toBe(200);
    const note = ((await response.json()) as { reply: { id: string; body: string; reask: string[] } }).reply;
    expect(note.reask).toHaveLength(1);
    const lines = note.body.split("\n");
    expect(lines[0]).toBe("Please ask your open question in this thread again, in one new message, so the person can answer it in one place.");
    expect(note.body).toContain("Check it against where the work is now:");
    expect(note.body).toContain("the old question stays open for the person.");
    expect((await row(server, first.thread_id)).section).toBe("sent");
    const polled = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-a", host: "claude-code", project_path: project, waitMs: 0 });
    const command = parseInboxBridgeCommands(await polled.text()).find((c) => c.id === note.id)!;
    expect(command).toMatchObject({ reask: true, reask_one: true });
    const wake = inboxWakeText(command).split("\n");
    expect(wake[1]).toBe(
      "The person asked, from the Plannotator Inbox, for the open question in this thread to be asked again, in one new message. The question and what to do with it follow. Answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above.",
    );
    // An older connection ignores reask_one and keeps the plural line; a redirected one-question wake is singular too.
    const { reask_one: _one, ...older } = command as typeof command & { reask_one?: boolean };
    expect(inboxWakeText(older).split("\n")[1]).toBe(INBOX_REASK_INSTRUCTION);
    expect(inboxWakeText({ ...command, redirected_from: "Claude Code" }).split("\n")[2]).toBe(
      `This question was asked by another Claude Code session, which has ended; the person picked you to take it over. Read the thread first with read_thread (message_id ${note.id}), then ask it again as below if it is still needed.`,
    );
  });

  test("nothing left: the refusal names action items too", async () => {
    const { server, client, project } = await setup();
    const first = await send(client, project, "ses-a", { body: "Just an update." });
    const refused = await reask(server, first.message_id, { idempotency_key: "k1" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("No open question or action item is left to ask again.");
  });
});

describe("Re-ask on the phone's door", () => {
  test("POST device/messages/:id/reask goes to the window's route", async () => {
    const { server, client, project } = await setup({ phones: true });
    const t = await seed(client, project);
    const made = (await (await post(server, "/api/inbox/pairing", {})).json()) as { offer: { code: string } };
    const paired = (await (await post(server, "/api/inbox/device/pair", { code: made.offer.code, name: "iPhone", platform: "ios" })).json()) as { token: string };
    const door = (key: string) =>
      fetch(`${base(server)}/api/inbox/device/messages/${t.second}/reask`, {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotency_key: key }),
      });
    const first = await door("00000000-0000-4000-8000-000000000061");
    expect(first.status).toBe(200);
    const again = await door("00000000-0000-4000-8000-000000000061");
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await row(server, t.thread)).section).toBe("sent");
  });
});
