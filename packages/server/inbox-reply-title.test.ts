/**
 * The title on what reaches an agent (#2464, approval "inbox-reply-title"): a
 * plain reply shows the thread's short name, or `a reply` with none, and
 * everything that is not a plain reply keeps the thread's subject. Proved
 * through the server's real doors: the connections' poll (which Codex and Qwen
 * share through `replyCommand`), wait_for_reply for a client nothing wakes, and
 * the window's routes. Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_SEND_NOW_POLL_FIELD,
  INBOX_WAKE_INSTRUCTION,
  INBOX_WAKES_META_KEY,
  inboxSentNowFollowUpText,
  inboxWakeClosingLine,
  inboxWakeText,
  parseInboxBridgeCommands,
  type InboxReplyCommand,
} from "@plannotator/shared/inbox/connection";
import * as modContract from "../../apps/hook/hooks/mod/inbox-contract";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A status that goes stale, the kind of text the issue saw repeated. */
const SUBJECT = "Service A quota is 93% used; investigate routing";
const NAME = "Latest triage";
const OWNER = "ses-owner";
const OTHER = "ses-other";
const OTHER_TAG = { host: "claude-code", session: OTHER, label: "Claude Code (other)" };
const QUESTION = [":::question", "Route through the second region?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

/** `undoMs`: the Undo window (the set-aside delay) of a 👍, a Mark read and a hand-off. */
async function setup(undoMs = 60_000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reply-title-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), setAsideDelayMs: undoMs });
  servers.push(server);
  const client = new Client({ name: "inbox-reply-title-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function agentSends(client: Client, project: string, session: string, body: string, extra: Record<string, unknown> = {}) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", ...extra },
    _meta: { [INBOX_WAKES_META_KEY]: true },
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

async function poll(server: InboxServer, session: string, project: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", project_path: project, waitMs: 0, tags: true, ...extra }),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

async function delivered(server: InboxServer, session: string, id: string) {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_EVENT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", type: "delivered", id }),
  });
  expect(response.status).toBe(200);
}

async function post(server: InboxServer, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

let keys = 0;
const key = () => `k-${++keys}`;

async function personReplies(server: InboxServer, messageId: string, words: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await post(server, `/api/inbox/messages/${messageId}/reply`, { idempotency_key: key(), words, ...extra })).reply.id;
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

async function until<T>(read: () => Promise<T[]>, what: string): Promise<T[]> {
  for (let i = 0; i < 100; i++) {
    const found = await read();
    if (found.length > 0) return found;
    await Bun.sleep(30);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const firstLine = (command: InboxReplyCommand) => inboxWakeText(command).split("\n")[0];
const asked = (client: Client, project: string, body = "Quota is climbing.") => agentSends(client, project, OWNER, body, { subject: SUBJECT, thread: NAME });
const askedUnnamed = (client: Client, project: string, body = "Quota is climbing.") => agentSends(client, project, OWNER, body, { subject: SUBJECT });

async function waitForReply(client: Client, threadId: string, session: string) {
  const result = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: threadId, agent_session: session, timeout_seconds: 1 } })) as { content: { text: string }[] };
  return result.content[0]!.text;
}

describe("a plain reply", () => {
  test("in a thread with a short name shows that name, and only the title changes", async () => {
    const { server, client, project } = await setup();
    const sent = await asked(client, project);
    const id = await personReplies(server, sent.message_id, "Check the cache settings now.");
    const [command] = await poll(server, OWNER, project);
    expect(command).toMatchObject({ type: "reply", id, thread_id: sent.thread_id, reply_to: sent.message_id, subject: NAME });
    const wake = inboxWakeText(command!).split("\n");
    expect(wake[0]).toBe(`Plannotator Inbox: ${NAME} (${id})`);
    // Body, ids and routing, as the wake carried them with the subject.
    expect(wake.slice(1)).toEqual(inboxWakeText({ ...command!, subject: SUBJECT }).split("\n").slice(1));
    expect(wake.slice(1)).toEqual([INBOX_WAKE_INSTRUCTION, "", command!.body, "", inboxWakeClosingLine(sent.thread_id)]);
  });

  test("in a thread with no name says `a reply`, and the subject enters nowhere", async () => {
    const { server, client, project } = await setup();
    const sent = await askedUnnamed(client, project);
    const id = await personReplies(server, sent.message_id, "Check the cache settings now.");
    const [command] = await poll(server, OWNER, project);
    expect(command!.subject).toBeNull();
    expect(firstLine(command!)).toBe(`Plannotator Inbox: a reply (${id})`);
    expect(inboxWakeText(command!)).not.toContain(SUBJECT);
    expect(inboxWakeText(command!).endsWith(inboxWakeClosingLine(sent.thread_id))).toBe(true);
    // The window still shows the thread's subject.
    expect((await thread(server, sent.thread_id)).subject).toBe(SUBJECT);
  });

  test("follows the name the thread has now: none, a suggestion, then the name an agent gave it", async () => {
    const { server, client, project } = await setup();
    await poll(server, OWNER, project);
    const bare = await post(server, "/api/inbox/messages", { to: { session: OWNER }, body: "Explore a board for the Inbox.", idempotency_key: key() });
    await delivered(server, OWNER, bare.message.id);
    const first = await agentSends(client, project, OWNER, "On it.", { reply_to: bare.message.id });
    const unnamed = await personReplies(server, first.message_id, "Keep it small.");
    expect(firstLine((await poll(server, OWNER, project))[0]!)).toBe(`Plannotator Inbox: a reply (${unnamed})`);
    await delivered(server, OWNER, unnamed);

    const named = await agentSends(client, project, OWNER, "Sketch attached.", { reply_to: unnamed, thread: "Board sketch" });
    const next = await personReplies(server, named.message_id, "Looks right.");
    expect(firstLine((await poll(server, OWNER, project))[0]!)).toBe(`Plannotator Inbox: Board sketch (${next})`);
    await delivered(server, OWNER, next);

    const suggested = await post(server, "/api/inbox/messages", { to: { session: OWNER }, body: "Rework the retries.", idempotency_key: key(), thread_name: "Retries", thread_name_auto: true });
    await delivered(server, OWNER, suggested.message.id);
    const answer = await agentSends(client, project, OWNER, "Reading.", { reply_to: suggested.message.id });
    const early = await personReplies(server, answer.message_id, "Start with the worker.");
    expect((await poll(server, OWNER, project))[0]).toMatchObject({ id: early, subject: "Retries" });
    await delivered(server, OWNER, early);
    const renamed = await agentSends(client, project, OWNER, "Started.", { reply_to: early, thread: "Worker retry budget" });
    const late = await personReplies(server, renamed.message_id, "Good.");
    expect((await poll(server, OWNER, project))[0]).toMatchObject({ id: late, subject: "Worker retry budget" });
  });

  test("Send now, and its follow-up, carry the same title", async () => {
    const { server, client, project } = await setup();
    const named = await asked(client, project);
    const unnamed = await askedUnnamed(client, project);
    const busy = { busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true };
    for (const sent of [named, unnamed]) {
      const id = await personReplies(server, sent.message_id, "Stop and check the cache.");
      await poll(server, OWNER, project, busy);
      await post(server, `/api/inbox/messages/${id}/send-now`, {});
      const command = (await poll(server, OWNER, project, busy)).find((c) => c.id === id)!;
      expect(command.now).toBe(true);
      const title = sent === named ? NAME : "a reply";
      expect(firstLine(command)).toBe(`Plannotator Inbox: ${title} (${id})`);
      expect(inboxSentNowFollowUpText(command).split("\n")[0]).toBe(`Plannotator Inbox: ${title} (${id})`);
      expect(inboxSentNowFollowUpText(command)).not.toContain(SUBJECT);
      await delivered(server, OWNER, id);
    }
  });

  test("an action report reaches the agent as a reply, so it takes a reply's title", async () => {
    const { server, client, project } = await setup(50);
    const sent = (await client.callTool({
      name: "send_message",
      arguments: { body: [":::action", "Approve the deploy", ":::"].join("\n"), project_path: project, agent_session: OWNER, agent_host: "claude-code", subject: SUBJECT },
      _meta: { [INBOX_WAKES_META_KEY]: true },
    })).structuredContent as { message_id: string; actions: { key: string }[] };
    await post(server, `/api/inbox/messages/${sent.message_id}/actions/${sent.actions[0]!.key}`, { outcome: "done" });
    const [command] = await until(() => poll(server, OWNER, project), "the action report");
    expect(firstLine(command!)).toBe(`Plannotator Inbox: a reply (${command!.id})`);
  });

  test("the owner of a reply that tags others gets a reply's title", async () => {
    const { server, client, project } = await setup();
    const sent = await asked(client, project);
    await poll(server, OTHER, project);
    const id = await personReplies(server, sent.message_id, "@Claude Code (other) you too.", { tags: [OTHER_TAG] });
    const [command] = await poll(server, OWNER, project);
    expect(command).toMatchObject({ id, also_tagged: ["Claude Code"], subject: NAME });
  });

  test("reaches a session added to the thread as a reply, once the reply that added it is past", async () => {
    const { server, client, project } = await setup();
    const sent = await askedUnnamed(client, project);
    await poll(server, OTHER, project);
    const added = await personReplies(server, sent.message_id, "@Claude Code (other) work on this too.", { tags: [{ ...OTHER_TAG, mode: "add" }] });
    expect((await poll(server, OTHER, project))[0]).toMatchObject({ id: added, added: true, subject: SUBJECT });
    await delivered(server, OTHER, added);
    await delivered(server, OWNER, added);

    const answer = await agentSends(client, project, OWNER, "Working.", { reply_to: added });
    const later = await personReplies(server, answer.message_id, "Keep going.");
    const command = (await poll(server, OTHER, project)).find((c) => c.id === later)!;
    expect(command).toMatchObject({ added: true, subject: null });
    expect(inboxWakeText(command)).not.toContain(SUBJECT);
  });

  test("wait_for_reply, for a client nothing wakes, leads with the name, or with no title at all", async () => {
    const { server, client, project } = await setup();
    const named = await asked(client, project);
    await personReplies(server, named.message_id, "Named thread.");
    expect((await waitForReply(client, named.thread_id, OWNER)).split("\n")[0]).toBe(`The person replied in thread ${named.thread_id} (${NAME}):`);

    const unnamed = await askedUnnamed(client, project, "Another one.");
    await personReplies(server, unnamed.message_id, "Unnamed thread.");
    const text = await waitForReply(client, unnamed.thread_id, OWNER);
    expect(text.split("\n")[0]).toBe(`The person replied in thread ${unnamed.thread_id}:`);
    expect(text).not.toContain(SUBJECT);
  });

  test("read_thread still names the subject: an agent matches it before writing into a thread", async () => {
    const { client, project } = await setup();
    const sent = await asked(client, project);
    const read = (await client.callTool({ name: "read_thread", arguments: { thread_id: sent.thread_id, agent_session: OWNER } })) as { content: { text: string }[] };
    expect(read.content[0]!.text).toContain(SUBJECT);
  });
});

describe("what is not a plain reply keeps the subject, in a named thread too", () => {
  test("the first message of a thread the person started, then the reply after it changes", async () => {
    const { server, client, project } = await setup();
    await poll(server, OWNER, project);
    const started = await post(server, "/api/inbox/messages", { to: { session: OWNER }, body: "Idea: retry the webhook on a 409.", idempotency_key: key(), thread_name: "Webhook retries" });
    const [root] = await poll(server, OWNER, project);
    expect(root).toMatchObject({ type: "message", new_thread: true, subject: "Idea: retry the webhook on a 409" });
    await delivered(server, OWNER, started.message.id);

    const answer = await agentSends(client, project, OWNER, "Doing it.", { reply_to: started.message.id });
    const id = await personReplies(server, answer.message_id, "Thanks.");
    expect((await poll(server, OWNER, project))[0]).toMatchObject({ id, subject: "Webhook retries" });
  });

  test("a New message, which answers nothing and may reach a session new to the thread", async () => {
    const { server, client, project } = await setup();
    const sent = await asked(client, project);
    await poll(server, OTHER, project);
    const written = await post(server, `/api/inbox/threads/${sent.thread_id}/message`, { session: OTHER, body: "Pick this up.", idempotency_key: key() });
    const [command] = await poll(server, OTHER, project);
    expect(command).toMatchObject({ type: "message", id: written.message.id, subject: SUBJECT });
  });

  test("a 👍, which is a note from the Inbox, not an answer", async () => {
    const { server, client, project } = await setup(50);
    const sent = await asked(client, project, "Done, nothing needs you.");
    await post(server, `/api/inbox/messages/${sent.message_id}/ack`, {});
    const [command] = await until(() => poll(server, OWNER, project), "the 👍");
    expect(command).toMatchObject({ ack_of: sent.message_id, subject: SUBJECT });
  });

  test("a Mark read note", async () => {
    const { server, client, project } = await setup(50);
    const sent = await asked(client, project, QUESTION);
    await post(server, `/api/inbox/threads/${sent.thread_id}/read`, {});
    const [command] = await until(() => poll(server, OWNER, project), "the set-aside note");
    expect(command!.subject).toBe(SUBJECT);
    expect(command!.ack_of).toBeUndefined();
  });

  test("a Re-ask", async () => {
    const { server, client, project } = await setup();
    const sent = await asked(client, project, QUESTION);
    await post(server, `/api/inbox/messages/${sent.message_id}/reask`, { idempotency_key: key() });
    const [command] = await poll(server, OWNER, project);
    expect(command).toMatchObject({ reask: true, subject: SUBJECT });
  });

  test("a tag: the session has never seen the thread", async () => {
    const { server, client, project } = await setup();
    const sent = await asked(client, project);
    await poll(server, OTHER, project);
    await personReplies(server, sent.message_id, "@Claude Code (other) a look?", { tags: [OTHER_TAG] });
    expect((await poll(server, OTHER, project))[0]).toMatchObject({ tagged: { owner: "Claude Code" }, subject: SUBJECT });
  });

  test("a hand-off, and the former owner's notice", async () => {
    const { server, client, project } = await setup(50);
    const sent = await asked(client, project);
    await poll(server, OWNER, project);
    await poll(server, OTHER, project);
    await personReplies(server, sent.message_id, "@Claude Code (other) this is yours.", { tags: [{ ...OTHER_TAG, mode: "handoff" }] });
    const [handed] = await until(() => poll(server, OTHER, project), "the hand-off");
    expect(handed).toMatchObject({ handoff: { from: "Claude Code" }, subject: SUBJECT });
    const [notice] = await until(() => poll(server, OWNER, project), "the notice");
    expect(notice).toMatchObject({ handed_away: { to: "Claude Code" }, subject: SUBJECT });
  });

  test("a reply sent on because the session that asked has ended", async () => {
    const { server, client, project } = await setup();
    const sent = await asked(client, project);
    await poll(server, OTHER, project);
    const id = await personReplies(server, sent.message_id, "Take this over.", { to: { host: "claude-code", session: OTHER } });
    expect((await poll(server, OTHER, project))[0]).toMatchObject({ id, redirected_from: "Claude Code", subject: SUBJECT });
  });

  test("words moved to a session that has seen nothing of the thread", async () => {
    const { server, project } = await setup();
    await poll(server, OWNER, project);
    const started = await post(server, "/api/inbox/messages", { to: { session: OWNER }, body: "Add a retry budget.", idempotency_key: key() });
    await delivered(server, OWNER, started.message.id);
    const id = await personReplies(server, started.message.id, "And log each retry.");
    await poll(server, OTHER, project);
    await post(server, `/api/inbox/messages/${id}/to`, { to: { host: "claude-code", session: OTHER } });
    expect((await poll(server, OTHER, project))[0]).toMatchObject({ id, continues_thread: true, subject: "Add a retry budget" });
  });
});

describe("the mod's copy of the contract", () => {
  test("words every title as the shared one does", () => {
    const commands = [
      { type: "reply", subject: NAME },
      { type: "reply", subject: null },
      { type: "message", subject: null },
    ] as const;
    for (const { type, subject } of commands) {
      const command = { type, subject, id: "msg_1", thread_id: "msg_2", body: "b" };
      expect(modContract.inboxWakeText(command)).toBe(inboxWakeText(command));
      expect(modContract.inboxSentNowFollowUpText(command)).toBe(inboxSentNowFollowUpText(command));
    }
    expect(modContract.inboxWakeText({ type: "reply", subject: null, id: "msg_1", body: "b" }).split("\n")[0]).toBe("Plannotator Inbox: a reply (msg_1)");
  });
});
