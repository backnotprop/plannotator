/**
 * Ask, Add and Hand off from the reply box's line (approval "inbox-tag-handoff",
 * option A2), proved through the server's real doors: the reply route's
 * `tags[].mode`, the connections' polls (the wake each session gets), the
 * hand-off's Undo window and its Undo route, the taggable route's owner, and
 * the later replies the store routes to the new owner or the added session.
 * Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxMessageWire, InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_ADDED_INSTRUCTION,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_HANDOFF_INSTRUCTION,
  INBOX_TAGGED_INSTRUCTION,
  INBOX_WAKE_INSTRUCTION,
  INBOX_WAKES_META_KEY,
  inboxAddedLine,
  inboxHandedAwayLine,
  inboxHandoffLine,
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

/** `undoMs`: the Undo window (the set-aside delay). */
async function setup(undoMs: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-handoff-")));
  roots.push(root);
  const project = join(root, "plannotator");
  const herdr = join(root, "herdr");
  mkdirSync(project, { recursive: true });
  mkdirSync(herdr, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), setAsideDelayMs: undoMs });
  servers.push(server);
  const client = new Client({ name: "inbox-handoff-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, herdr };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const OWNER = "cc-plannotator";
const HERDR = "cc-herdr";
const HERDR_TAG = { host: "claude-code", session: HERDR, label: "Claude Code (herdr)" };

async function agentSends(client: Client, project: string, session: string, body: string, extra: Record<string, unknown> = {}) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", ...extra },
    _meta: { [INBOX_WAKES_META_KEY]: true },
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

async function poll(server: InboxServer, session: string, project: string) {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", project_path: project, waitMs: 0, tags: true }),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

async function post(server: InboxServer, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

const reply = (server: InboxServer, messageId: string, body: Record<string, unknown>) => post(server, `/api/inbox/messages/${messageId}/reply`, body);

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

/** The thread's owner as the taggable route says (the session the person's plain reply goes to). */
async function owner(server: InboxServer, threadId: string): Promise<string | null> {
  const model = (await (await fetch(`${base(server)}/api/inbox/threads/${threadId}/taggable`)).json()) as { owner: { session: string } | null };
  return model.owner?.session ?? null;
}

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The owner asked in plannotator; both sessions are live with the tag capability. */
async function world(undoMs: number) {
  const env = await setup(undoMs);
  const asked = await agentSends(env.client, env.project, OWNER, "The pane title is herdr's. Should I add `plannotator inbox whoami --json`?");
  await poll(env.server, OWNER, env.project);
  await poll(env.server, HERDR, env.herdr);
  return { ...env, asked };
}

describe("Ask, the default", () => {
  test("a tag with no mode is today's tag: the owner keeps the thread and the tagged session gets this one reply", async () => {
    const { server, project, herdr, asked } = await world(60_000);
    const sent = await reply(server, asked.message_id, { idempotency_key: "k1", words: "@Claude Code (herdr) this is yours.", tags: [HERDR_TAG] });
    expect(sent.status).toBe(200);
    const stored = sent.json.reply as InboxMessageWire;
    expect(stored.to).toBeUndefined();
    expect(stored.handoff).toBeUndefined();
    expect(stored.tags).toEqual([{ ...HERDR_TAG, wakes: true }]);
    expect(inboxWakeText((await poll(server, HERDR, herdr))[0]!).split("\n")[1]).toBe(INBOX_TAGGED_INSTRUCTION);
    expect(inboxWakeText((await poll(server, OWNER, project))[0]!).split("\n")[1]).toBe(INBOX_WAKE_INSTRUCTION);
    expect(await owner(server, asked.thread_id)).toBe(OWNER);
  });
});

describe("Hand off", () => {
  test("held for the Undo window, then the new owner gets it as its thread and the former owner a notice without the words; the former owner writing again never takes it back", async () => {
    const { server, client, project, herdr, asked } = await world(300);
    const sent = await reply(server, asked.message_id, {
      idempotency_key: "k1",
      words: "@Claude Code (herdr) this one is really yours.",
      tags: [{ ...HERDR_TAG, mode: "handoff" }],
    });
    expect(sent.status).toBe(200);
    const stored = sent.json.reply as InboxMessageWire;
    expect(stored.to).toEqual({ host: "claude-code", session: HERDR });
    expect(stored.handoff).toMatchObject({ from: { host: "claude-code", session: OWNER }, label: "Claude Code (herdr)" });
    expect(stored.handoff!.settled_at ?? null).toBeNull();
    // The former owner's notice rides as its own recipient entry.
    expect(stored.tags).toEqual([expect.objectContaining({ session: OWNER, handed_away: true, wakes: true })]);
    // Inside the Undo window nobody is handed anything.
    expect(await poll(server, HERDR, herdr)).toEqual([]);
    expect(await poll(server, OWNER, project)).toEqual([]);
    // The thread is the new owner's from the Send on.
    expect(await owner(server, asked.thread_id)).toBe(HERDR);

    await until(async () => (await poll(server, HERDR, herdr)).length > 0, "the hand-off to settle");
    const handed = (await poll(server, HERDR, herdr))[0]!;
    expect(handed).toMatchObject({ id: stored.id, handoff: { from: "Claude Code" } });
    const wake = inboxWakeText(handed).split("\n");
    expect(wake[1]).toBe(INBOX_HANDOFF_INSTRUCTION);
    expect(wake[2]).toBe(inboxHandoffLine("Claude Code", stored.id));
    expect(wake.join("\n")).toContain("this one is really yours");

    const told = await poll(server, OWNER, project);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ id: stored.id, handed_away: { to: "Claude Code" } });
    expect(told[0]!.body).toBe(inboxHandedAwayLine("Claude Code"));
    // The former owner is told to stop; it never gets the words meant for the new owner.
    const notice = inboxWakeText(told[0]!);
    expect(notice.split("\n")[1]).toBe(inboxHandedAwayLine("Claude Code"));
    expect(notice).not.toContain("really yours");

    // The former owner writes again: the thread stays with the new owner.
    await agentSends(client, project, OWNER, "Noted, stopping here.", { reply_to: stored.id });
    expect(await owner(server, asked.thread_id)).toBe(HERDR);
    // The person's next plain reply, to the hand-off reply (the window's choice), goes to the new owner alone.
    const next = await reply(server, stored.id, { idempotency_key: "k2", words: "Ask on focus." });
    expect(next.status).toBe(200);
    const nextId = (next.json.reply as InboxMessageWire).id;
    expect((next.json.reply as InboxMessageWire).to).toEqual({ host: "claude-code", session: HERDR });
    expect((await poll(server, HERDR, herdr)).map((c) => c.id)).toContain(nextId);
    expect((await poll(server, OWNER, project)).map((c) => c.id)).not.toContain(nextId);
  });

  test("Undo inside the window turns it into an Ask: the owner keeps the thread and the tagged session is asked", async () => {
    const { server, project, herdr, asked } = await world(60_000);
    const sent = await reply(server, asked.message_id, { idempotency_key: "k1", words: "@Claude Code (herdr) take it.", tags: [{ ...HERDR_TAG, mode: "handoff" }] });
    const id = (sent.json.reply as InboxMessageWire).id;
    const undone = await post(server, `/api/inbox/messages/${id}/handoff/undo`, {});
    expect(undone.status).toBe(200);
    const message = (await thread(server, asked.thread_id)).messages.find((m) => m.id === id)!;
    expect(message.to).toBeUndefined();
    expect(message.handoff?.undone_at).toBeString();
    expect(message.tags).toEqual([{ ...HERDR_TAG, wakes: true }]);
    expect(await owner(server, asked.thread_id)).toBe(OWNER);
    // Delivered at once, as an Ask: no notice, no hand-off wake.
    expect((await poll(server, HERDR, herdr))[0]).toMatchObject({ id, tagged: { owner: "Claude Code" } });
    const ownerCommand = (await poll(server, OWNER, project))[0]!;
    expect(ownerCommand.handed_away).toBeUndefined();
    expect(ownerCommand.handoff).toBeUndefined();
    expect(inboxWakeText(ownerCommand).split("\n")[1]).toBe(INBOX_WAKE_INSTRUCTION);
  });

  test("wait_for_reply as the former owner after the window: the stop notice alone, never the person's words", async () => {
    const { server, client, project, asked } = await world(100);
    const sent = await reply(server, asked.message_id, { idempotency_key: "k1", words: "SECRET-WORDS for herdr only.", tags: [{ ...HERDR_TAG, mode: "handoff" }] });
    const id = (sent.json.reply as InboxMessageWire).id;
    await until(async () => !!(await thread(server, asked.thread_id)).messages.find((m) => m.id === id)?.handoff?.settled_at, "the hand-off to settle");
    // The normal agent loop: no cursor, the thread it asked in.
    const result = await client.callTool({
      name: "wait_for_reply",
      arguments: { thread_id: asked.thread_id, project_path: project, agent_session: OWNER, timeout_seconds: 1 },
    });
    const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    const structured = result.structuredContent as { reply?: { message_id: string; body: string }; handed_away?: { to: string } };
    expect(structured.reply?.message_id).toBe(id);
    expect(structured.reply?.body).toBe(inboxHandedAwayLine("Claude Code"));
    expect(structured.handed_away).toEqual({ to: "Claude Code" });
    expect(text).toContain(inboxHandedAwayLine("Claude Code"));
    expect(text).not.toContain("SECRET-WORDS");
    expect(JSON.stringify(result)).not.toContain("SECRET-WORDS");
  });

  test("read_thread as the former owner: the hand-off reply is not one that tagged it, and its list does not say it was tagged", async () => {
    const { server, client, project, asked } = await world(100);
    const sent = await reply(server, asked.message_id, { idempotency_key: "k1", words: "@Claude Code (herdr) yours now.", tags: [{ ...HERDR_TAG, mode: "handoff" }] });
    const id = (sent.json.reply as InboxMessageWire).id;
    await until(async () => !!(await thread(server, asked.thread_id)).messages.find((m) => m.id === id)?.handoff?.settled_at, "the hand-off to settle");
    // The stop notice is not delivered yet (the former owner did not poll): read mid-turn.
    const text = async (args: Record<string, unknown>) =>
      JSON.stringify(await client.callTool({ name: "read_thread", arguments: { project_path: project, agent_session: OWNER, ...args } }));
    const read = await text({ thread_id: asked.thread_id, format: "full" });
    expect(read).toContain("yours now.");
    expect(read).not.toContain("tagged you");
    expect(read).not.toContain("tagged_you");
    const list = await text({});
    expect(list).toContain(asked.thread_id);
    expect(list).not.toContain("the person tagged you here");
  });

  test("a reply sent inside the window settles the hand-off first: the new owner gets the hand-off, then the reply; Undo is gone", async () => {
    const { server, project, herdr, asked } = await world(60_000);
    const sent = await reply(server, asked.message_id, { idempotency_key: "k1", words: "@Claude Code (herdr) yours.", tags: [{ ...HERDR_TAG, mode: "handoff" }] });
    const id = (sent.json.reply as InboxMessageWire).id;
    // The reply box answers the held hand-off reply, so the follow-up is addressed to the new owner.
    const follow = await reply(server, id, { idempotency_key: "k2", words: "Creds are in the vault." });
    expect(follow.status).toBe(200);
    const followId = (follow.json.reply as InboxMessageWire).id;
    expect((follow.json.reply as InboxMessageWire).to).toEqual({ host: "claude-code", session: HERDR });
    const handedOff = (await thread(server, asked.thread_id)).messages.find((m) => m.id === id)!;
    expect(handedOff.handoff?.settled_at).toBeString();
    // In order: the hand-off (with its wake), then the follow-up.
    const commands = await poll(server, HERDR, herdr);
    expect(commands.map((c) => c.id)).toEqual([id, followId]);
    expect(commands[0]!.handoff).toEqual({ from: "Claude Code" });
    // The former owner is told to stop, and never handed the follow-up.
    const told = await poll(server, OWNER, project);
    expect(told.map((c) => c.id)).toEqual([id]);
    expect(told[0]!.handed_away).toEqual({ to: "Claude Code" });
    // Undo can no longer send the thread back past a reply the new owner has.
    expect((await post(server, `/api/inbox/messages/${id}/handoff/undo`, {})).status).toBe(409);
    expect(await owner(server, asked.thread_id)).toBe(HERDR);
  });

  test("Undo after the window is refused, and the thread stays handed off", async () => {
    const { server, herdr, asked } = await world(100);
    const sent = await reply(server, asked.message_id, { idempotency_key: "k1", words: "Yours.", tags: [{ ...HERDR_TAG, mode: "handoff" }] });
    const id = (sent.json.reply as InboxMessageWire).id;
    await until(async () => (await poll(server, HERDR, herdr)).length > 0, "the hand-off to settle");
    const late = await post(server, `/api/inbox/messages/${id}/handoff/undo`, {});
    expect(late.status).toBe(409);
    expect(await owner(server, asked.thread_id)).toBe(HERDR);
  });

  test("refused before anything is written: to an agent that is not woken, to two sessions at once, and to the owner", async () => {
    const { server, client, project, asked } = await world(60_000);
    // An MCP-only agent the Inbox knows (it wrote, not through a waking connection).
    await client.callTool({
      name: "send_message",
      arguments: { body: "Docs moved.", project_path: project, agent_session: "ses-codex", agent_host: "codex", agent_name: "Codex" },
    });
    const mcp = await reply(server, asked.message_id, { idempotency_key: "a", words: "x", tags: [{ session: "ses-codex", mode: "handoff" }] });
    expect(mcp.status).toBe(409);
    const two = await reply(server, asked.message_id, {
      idempotency_key: "b",
      words: "x",
      tags: [
        { session: HERDR, mode: "handoff" },
        { session: OWNER, mode: "handoff" },
      ],
    });
    expect(two.status).toBe(422);
    const self = await reply(server, asked.message_id, { idempotency_key: "c", words: "x", tags: [{ session: OWNER, mode: "handoff" }] });
    expect(self.status).toBe(409);
    expect((await thread(server, asked.thread_id)).messages).toHaveLength(1);
  });
});

describe("Add", () => {
  test("the added session gets the added wake, then every later reply with the person's words, while the owner keeps the thread", async () => {
    const { server, client, project, herdr, asked } = await world(60_000);
    const sent = await reply(server, asked.message_id, { idempotency_key: "k1", words: "@Claude Code (herdr) work on this with it.", tags: [{ ...HERDR_TAG, mode: "add" }] });
    expect(sent.status).toBe(200);
    const first = sent.json.reply as InboxMessageWire;
    expect(first.tags).toEqual([{ ...HERDR_TAG, wakes: true, joined: true }]);
    expect(first.to).toBeUndefined();
    const added = (await poll(server, HERDR, herdr))[0]!;
    expect(added).toMatchObject({ id: first.id, tagged: { owner: "Claude Code" }, added: true });
    const wake = inboxWakeText(added).split("\n");
    expect(wake[1]).toBe(INBOX_ADDED_INSTRUCTION);
    expect(wake[2]).toBe(inboxAddedLine("Claude Code", first.id));
    expect(await owner(server, asked.thread_id)).toBe(OWNER);

    // The owner answers; the person's plain reply (no tag) reaches the added session too.
    const answer = await agentSends(client, project, OWNER, "Adding whoami now.", { reply_to: first.id });
    const later = await reply(server, answer.message_id, { idempotency_key: "k2", words: "Good, and keep the title short." });
    const second = later.json.reply as InboxMessageWire;
    expect(second.tags).toEqual([{ ...HERDR_TAG, wakes: true, joined: true }]);
    expect((await poll(server, HERDR, herdr)).map((c) => c.id)).toContain(second.id);
    expect((await poll(server, OWNER, project)).map((c) => c.id)).toContain(second.id);
  });
});
