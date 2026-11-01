/**
 * Ask AI's conversation file and routes through a running Inbox on a temp data
 * dir: the agent writes through the official MCP client, the person through
 * requests shaped as the window's. Guards the setting that hides it all, that
 * words are neither lost nor saved twice, that a conversation goes with its
 * thread, and that only the owner's own window can ask or read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { resolveInboxAskAi } from "@plannotator/shared/config";
import { INBOX_ASK_FILE_MAX, INBOX_ASK_TEXT_MAX, writeInboxAsk, type InboxAskConversation } from "@plannotator/shared/inbox/ask";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-ask-")));
  roots.push(root);
  return root;
}

async function connect(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-ask-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

async function setup(askAi = true) {
  const root = scratch();
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir, askAi, binaryPath: null });
  servers.push(server);
  return { server, client: await connect(server), project, dataDir, root };
}

async function agentSends(client: Client, project: string, session: string | null, body: string, reply_to?: string): Promise<{ message_id: string; thread_id: string }> {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, ...(session ? { agent_session: session } : {}), agent_host: "claude-code", agent_name: "Claude Code", ...(reply_to ? { reply_to } : {}) },
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

const WINDOW_HEADERS = { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };

/** A request shaped as the window's page makes it. */
function fromWindow(server: InboxServer, path: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...WINDOW_HEADERS, ...(body ? { Origin: `http://127.0.0.1:${server.port}` } : {}) },
    ...(body ? { body: JSON.stringify({ serverSession: server.serverSession, ...body }) } : {}),
  });
}

const askPath = (threadId: string, action = "") => `/api/inbox/threads/${threadId}/ask${action}`;

async function ask(server: InboxServer, threadId: string, turnId: string, question: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return fromWindow(server, askPath(threadId), { turn_id: turnId, question, ...extra });
}

async function conversation(server: InboxServer, threadId: string): Promise<InboxAskConversation | null> {
  const response = await fromWindow(server, askPath(threadId));
  expect(response.status).toBe(200);
  return ((await response.json()) as { conversation: InboxAskConversation | null }).conversation;
}

function askFile(dataDir: string, threadId: string): string {
  return join(inboxDir(dataDir), "ask", `${threadId}.json`);
}

/** Everything in the ask folder that belongs to one thread. */
function filesOf(dataDir: string, threadId: string): string[] {
  return readdirSync(join(inboxDir(dataDir), "ask")).filter((name) => name.startsWith(`${threadId}.`));
}

/** A saved question, answered at `answered_at`: what step 2's agent will leave in the file. */
function answeredTurn(id: string, answered_at: string, answer = "Because.") {
  return { id, at: "2026-10-31T09:00:00.000Z", session: "session-a", host: "claude-code", question: "Why?", answer, answered_at };
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

/** Collects a stream's named frames as they arrive. */
function listen(response: Response) {
  const frames: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    let text = "";
    try {
      while (true) {
        const { value, done: ended } = await reader.read();
        if (ended) return;
        text += decoder.decode(value, { stream: true });
        for (const match of text.matchAll(/^event: (\S+)$/gm)) frames.push(match[1]!);
        text = text.slice(text.lastIndexOf("\n") + 1);
      }
    } catch {
      // Cancelled by the test.
    }
  })();
  return { frames, stop: () => reader.cancel().then(() => done) };
}

describe("off, the default", () => {
  test("every ask route is the unknown route, whoever asks, and nothing is written", async () => {
    const { server, client, project, dataDir } = await setup(false);
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const unknown = await fromWindow(server, `/api/inbox/threads/${thread_id}/no-such-route`);
    const answer = await unknown.json();
    expect(unknown.status).toBe(404);

    for (const response of [
      await fromWindow(server, askPath(thread_id)),
      await fromWindow(server, askPath(thread_id), { turn_id: "turn-0001", question: "Why?" }),
      await fromWindow(server, askPath(thread_id, "/seen"), { seen_at: new Date().toISOString() }),
      await fromWindow(server, askPath(thread_id, "/end"), {}),
      // Without the window's headers too: a client cannot tell off from "refused".
      await fetch(`http://127.0.0.1:${server.port}${askPath(thread_id)}`),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(answer);
    }
    expect(existsSync(join(inboxDir(dataDir), "ask"))).toBe(false);
  });

  test("the setting is read when the Inbox starts: unset is off, and only 1, true or on turn it on", async () => {
    const previous = process.env.PLANNOTATOR_INBOX_ASK_AI;
    try {
      delete process.env.PLANNOTATOR_INBOX_ASK_AI;
      const root = scratch();
      const off = await startInboxServer({ dataDir: join(root, "off"), binaryPath: null });
      servers.push(off);
      process.env.PLANNOTATOR_INBOX_ASK_AI = "1";
      const on = await startInboxServer({ dataDir: join(root, "on"), binaryPath: null });
      servers.push(on);
      const client = await connect(on);
      const { thread_id } = await agentSends(client, join(root, "on"), "session-a", "Ship it?");
      expect((await fromWindow(on, askPath(thread_id))).status).toBe(200);
      // Set after the start: it changes nothing until the next start.
      expect((await fromWindow(off, askPath("msg_anything"))).status).toBe(404);
      expect(((await (await fromWindow(off, askPath("msg_anything"))).json()) as { code: string }).code).toBe("not_found");
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_INBOX_ASK_AI;
      else process.env.PLANNOTATOR_INBOX_ASK_AI = previous;
    }
    for (const value of ["1", "true", "on", " ON "]) expect(resolveInboxAskAi({ PLANNOTATOR_INBOX_ASK_AI: value })).toBe(true);
    for (const value of [undefined, "", "0", "false", "off", "yes"]) expect(resolveInboxAskAi({ PLANNOTATOR_INBOX_ASK_AI: value })).toBe(false);
  });
});

describe("the conversation file", () => {
  test("a question is kept, owner-only, for the session that owns the thread, and survives a restart", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    expect(await conversation(server, thread_id)).toBeNull();

    const response = await ask(server, thread_id, "turn-0001", "Why this region?", { passage: "us-east-1" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { turn: unknown }).turn).toMatchObject({ id: "turn-0001", session: "session-a", host: "claude-code", question: "Why this region?", passage: "us-east-1" });

    const file = askFile(dataDir, thread_id);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);

    server.stop();
    servers.length = 0;
    const again = await startInboxServer({ dataDir, askAi: true, binaryPath: null });
    servers.push(again);
    expect((await conversation(again, thread_id))?.turns.map((turn) => turn.question)).toEqual(["Why this region?"]);
  });

  test("a question never enters the event log: agents, the list and search do not see it", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const before = server.store.cursor();
    expect((await ask(server, thread_id, "turn-0001", "zebrafishquestion")).status).toBe(200);
    expect(server.store.cursor()).toBe(before);
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id, agent_session: "session-a" } });
    expect(JSON.stringify(read)).not.toContain("zebrafishquestion");
    const found = await fromWindow(server, "/api/inbox/search?q=zebrafishquestion");
    expect(JSON.stringify(await found.json())).not.toContain(thread_id);
  });

  test("a retried POST writes one turn, however the two land", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const twice = await Promise.all([ask(server, thread_id, "turn-0001", "Why?"), ask(server, thread_id, "turn-0001", "Why?")]);
    expect(twice.map((response) => response.status)).toEqual([200, 200]);
    expect((await ask(server, thread_id, "turn-0001", "Why?")).status).toBe(200);
    expect((await conversation(server, thread_id))?.turns.map((turn) => turn.id)).toEqual(["turn-0001"]);
    expect((await ask(server, thread_id, "turn-0002", "And then?")).status).toBe(200);
    expect((await conversation(server, thread_id))?.turns.map((turn) => turn.id)).toEqual(["turn-0001", "turn-0002"]);
  });

  test("the owner is read again at each ask: a new writer takes the next question", async () => {
    const { server, client, project } = await setup();
    const first = await agentSends(client, project, "session-a", "Ship it?");
    expect((await ask(server, first.thread_id, "turn-0001", "One?")).status).toBe(200);
    await agentSends(client, project, "session-b", "I took this over.", first.message_id);
    expect((await ask(server, first.thread_id, "turn-0002", "Two?")).status).toBe(200);
    expect((await conversation(server, first.thread_id))?.turns.map((turn) => turn.session)).toEqual(["session-a", "session-b"]);
  });

  test("with no agent to answer, nothing is saved and the window hears why", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, null, "A note from no session.");
    const refused = await ask(server, thread_id, "turn-0001", "Anyone?");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("ask_no_owner");
    expect(await conversation(server, thread_id)).toBeNull();
  });

  test("an archived thread refuses a question until an agent brings it back", async () => {
    const { server, client, project } = await setup();
    const { thread_id, message_id } = await agentSends(client, project, "session-a", "Ship it?");
    expect((await fromWindow(server, `/api/inbox/messages/${message_id}/resolve`, { resolved: true })).status).toBe(200);
    const refused = await ask(server, thread_id, "turn-0001", "Still there?");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("thread_resolved");
    await agentSends(client, project, "session-a", "One more thing.", message_id);
    expect((await ask(server, thread_id, "turn-0001", "Still there?")).status).toBe(200);
  });

  test("a retry of a saved turn gets that turn even after the thread is archived, so it is never asked twice", async () => {
    const { server, client, project } = await setup();
    const { thread_id, message_id } = await agentSends(client, project, "session-a", "Ship it?");
    expect((await ask(server, thread_id, "turn-0001", "Why?")).status).toBe(200);
    expect((await fromWindow(server, `/api/inbox/messages/${message_id}/resolve`, { resolved: true })).status).toBe(200);

    const retry = await ask(server, thread_id, "turn-0001", "Why?");
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { turn: { id: string } }).turn.id).toBe("turn-0001");
    // A new question still waits for the thread to come back.
    const fresh = await ask(server, thread_id, "turn-0002", "And now?");
    expect(fresh.status).toBe(409);
    expect(await code(fresh)).toBe("thread_resolved");
    expect((await conversation(server, thread_id))?.turns.map((turn) => turn.id)).toEqual(["turn-0001"]);
  });

  test("bad input is refused before anything is written, and no path escapes the folder", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    for (const body of [
      { turn_id: "../../../../etc/x", question: "Why?" },
      { turn_id: "short", question: "Why?" },
      { turn_id: "turn-0001", question: "   " },
      { turn_id: "turn-0001", question: "x".repeat(INBOX_ASK_TEXT_MAX + 1) },
      { turn_id: "turn-0001", question: "Why?", passage: 7 },
    ]) {
      expect((await fromWindow(server, askPath(thread_id), body)).status).toBe(422);
    }
    expect(existsSync(askFile(dataDir, thread_id))).toBe(false);
    expect((await ask(server, "msg_nothing_here", "turn-0001", "Why?")).status).toBe(404);
  });

  // Skipped where mode 000 does not stop a read: Windows, and root.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file that cannot be read is refused and kept: two saved turns survive a third question", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    expect((await ask(server, thread_id, "turn-0001", "One?")).status).toBe(200);
    expect((await ask(server, thread_id, "turn-0002", "Two?")).status).toBe(200);
    const file = askFile(dataDir, thread_id);
    const saved = readFileSync(file);

    chmodSync(file, 0o000);
    for (const response of [
      await fromWindow(server, askPath(thread_id)),
      await ask(server, thread_id, "turn-0003", "Three?"),
      await fromWindow(server, askPath(thread_id, "/seen"), { seen_at: "2026-11-01T10:00:00.000Z" }),
    ]) {
      expect(response.status).toBe(503);
      expect(await code(response)).toBe("ask_unreadable");
    }
    chmodSync(file, 0o600);

    expect(readFileSync(file).equals(saved)).toBe(true);
    expect(filesOf(dataDir, thread_id)).toEqual([`${thread_id}.json`]);
    expect((await ask(server, thread_id, "turn-0003", "Three?")).status).toBe(200);
    expect((await conversation(server, thread_id))?.turns.map((turn) => turn.id)).toEqual(["turn-0001", "turn-0002", "turn-0003"]);
  });

  test("a damaged file is shown as damaged, then kept whole by the next question, which is refused so the person hears", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    expect((await ask(server, thread_id, "turn-0001", "One?")).status).toBe(200);
    expect((await ask(server, thread_id, "turn-0002", "Two?")).status).toBe(200);
    const file = askFile(dataDir, thread_id);
    const whole = readFileSync(file, "utf8");
    const truncated = whole.slice(0, whole.length - 20);
    writeFileSync(file, truncated);

    // Reading and marking seen report it and move nothing.
    for (const response of [await fromWindow(server, askPath(thread_id)), await fromWindow(server, askPath(thread_id, "/seen"), { seen_at: "2026-11-01T10:00:00.000Z" })]) {
      expect(response.status).toBe(409);
      expect(await code(response)).toBe("ask_damaged");
    }
    expect(readFileSync(file, "utf8")).toBe(truncated);

    const refused = await ask(server, thread_id, "turn-0003", "Three?");
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe("ask_damaged");
    const aside = filesOf(dataDir, thread_id);
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(/\.json\.\d+\.bad$/);
    expect(readFileSync(join(file, "..", aside[0]!), "utf8")).toBe(truncated);

    // The window kept the words and asks again: a new conversation, beside the old bytes.
    expect((await ask(server, thread_id, "turn-0003", "Three?")).status).toBe(200);
    expect((await conversation(server, thread_id))?.turns.map((turn) => turn.id)).toEqual(["turn-0003"]);
    expect(readFileSync(join(file, "..", aside[0]!), "utf8")).toBe(truncated);
  });

  test("a full file refuses a new question and keeps every word, a retry still gets its turn, and End frees it", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const planted: InboxAskConversation = { v: 1, thread_id, seen_at: null, turns: [answeredTurn("turn-0001", "2026-11-01T10:00:00.000Z", "")] };
    const skeleton = JSON.stringify(planted).length + 1;
    planted.turns[0]!.answer = "x".repeat(INBOX_ASK_FILE_MAX - skeleton - 500);
    writeInboxAsk(inboxDir(dataDir), planted);

    // A short question still fits under the limit, right to the edge.
    expect((await ask(server, thread_id, "turn-0002", "Why?")).status).toBe(200);
    const file = askFile(dataDir, thread_id);
    const saved = readFileSync(file);

    const refused = await ask(server, thread_id, "turn-0003", "y".repeat(500));
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe("ask_full");
    expect(readFileSync(file).equals(saved)).toBe(true);

    expect((await ask(server, thread_id, "turn-0002", "Why?")).status).toBe(200);
    expect((await fromWindow(server, askPath(thread_id, "/end"), {})).status).toBe(200);
    expect((await ask(server, thread_id, "turn-0003", "y".repeat(500))).status).toBe(200);
  });
});

describe("ending and deleting", () => {
  test("End deletes this thread's conversation only, and a second End finds nothing", async () => {
    const { server, client, project, dataDir } = await setup();
    const one = await agentSends(client, project, "session-a", "One?");
    const two = await agentSends(client, project, "session-b", "Two?");
    expect((await ask(server, one.thread_id, "turn-0001", "Why one?")).status).toBe(200);
    expect((await ask(server, two.thread_id, "turn-0002", "Why two?")).status).toBe(200);

    const ended = await fromWindow(server, askPath(one.thread_id, "/end"), {});
    expect(await ended.json()).toEqual({ ok: true, ended: true });
    expect(existsSync(askFile(dataDir, one.thread_id))).toBe(false);
    expect(await conversation(server, one.thread_id)).toBeNull();
    expect((await conversation(server, two.thread_id))?.turns).toHaveLength(1);
    expect(await (await fromWindow(server, askPath(one.thread_id, "/end"), {})).json()).toEqual({ ok: true, ended: false });
  });

  test("End and thread delete leave nothing behind: not a crash's temp file, not a damaged file set aside", async () => {
    const { server, client, project, dataDir } = await setup();
    const ended = await agentSends(client, project, "session-a", "One?");
    const deleted = await agentSends(client, project, "session-b", "Two?");
    const kept = await agentSends(client, project, "session-c", "Three?");
    for (const [thread, turn] of [[ended, "turn-0001"], [deleted, "turn-0002"], [kept, "turn-0003"]] as const) {
      expect((await ask(server, thread.thread_id, turn, "Private words")).status).toBe(200);
      for (const leftover of [".json.99999.tmp", ".json.1762000000000.bad"]) writeFileSync(join(askFile(dataDir, thread.thread_id), "..", `${thread.thread_id}${leftover}`), "Private words");
    }

    expect(await (await fromWindow(server, askPath(ended.thread_id, "/end"), {})).json()).toEqual({ ok: true, ended: true });
    expect(filesOf(dataDir, ended.thread_id)).toEqual([]);
    expect((await fromWindow(server, `/api/inbox/threads/${deleted.thread_id}/delete`, {})).status).toBe(200);
    expect(filesOf(dataDir, deleted.thread_id)).toEqual([]);
    expect(filesOf(dataDir, kept.thread_id)).toHaveLength(3);
  });

  test("a tab left open on an older Inbox ends nothing and asks nothing", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    expect((await ask(server, thread_id, "turn-0001", "Why?")).status).toBe(200);
    expect((await fromWindow(server, askPath(thread_id, "/end"), { serverSession: "older-inbox" })).status).toBe(409);
    expect((await fromWindow(server, askPath(thread_id), { serverSession: "older-inbox", turn_id: "turn-0002", question: "And?" })).status).toBe(409);
    expect((await conversation(server, thread_id))?.turns.map((turn) => turn.id)).toEqual(["turn-0001"]);
  });

  test("deleting a thread or a project takes its conversation, and no other", async () => {
    const { server, client, project, dataDir, root } = await setup();
    const elsewhere = join(root, "other");
    mkdirSync(elsewhere, { recursive: true });
    const deleted = await agentSends(client, project, "session-a", "Going?");
    const kept = await agentSends(client, project, "session-c", "Staying?");
    const other = await agentSends(client, elsewhere, "session-b", "Elsewhere?");
    for (const [thread, turn] of [[deleted, "turn-0001"], [kept, "turn-0002"], [other, "turn-0003"]] as const) {
      expect((await ask(server, thread.thread_id, turn, "Why?")).status).toBe(200);
    }

    expect((await fromWindow(server, `/api/inbox/threads/${deleted.thread_id}/delete`, {})).status).toBe(200);
    expect(existsSync(askFile(dataDir, deleted.thread_id))).toBe(false);
    expect(existsSync(askFile(dataDir, kept.thread_id))).toBe(true);
    expect(existsSync(askFile(dataDir, other.thread_id))).toBe(true);

    const projectId = server.store.thread(other.thread_id)!.project.id;
    expect((await fromWindow(server, `/api/inbox/projects/${projectId}/delete`, {})).status).toBe(200);
    expect(existsSync(askFile(dataDir, other.thread_id))).toBe(false);
    expect(existsSync(askFile(dataDir, kept.thread_id))).toBe(true);
  });
});

describe("seen", () => {
  test("the mark only moves forward, so a late device cannot bring a dot back", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    writeInboxAsk(inboxDir(dataDir), { v: 1, thread_id, seen_at: null, turns: [answeredTurn("turn-0001", "2026-11-01T10:00:00.000Z"), answeredTurn("turn-0002", "2026-11-01T11:00:00.000Z")] });
    const seen = (at: string) => fromWindow(server, askPath(thread_id, "/seen"), { seen_at: at });

    expect((await seen("2026-11-01T10:00:00.000Z")).status).toBe(200);
    expect((await seen("2026-11-01T09:00:00.000Z")).status).toBe(200);
    expect((await conversation(server, thread_id))?.seen_at).toBe("2026-11-01T10:00:00.000Z");
    expect((await seen("2026-11-01T11:00:00.000Z")).status).toBe(200);
    expect((await conversation(server, thread_id))?.seen_at).toBe("2026-11-01T11:00:00.000Z");
    expect((await seen("not a time")).status).toBe(422);
  });

  test("a time past the newest answer cannot hide the dot of the next answer", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const turns = [answeredTurn("turn-0001", "2026-11-01T10:00:00.000Z")];
    writeInboxAsk(inboxDir(dataDir), { v: 1, thread_id, seen_at: null, turns });

    // Parses, is far in the future, and is not ISO: stored as the newest answer's time.
    expect((await fromWindow(server, askPath(thread_id, "/seen"), { seen_at: "Nov 1 3000" })).status).toBe(200);
    const stored = await conversation(server, thread_id);
    expect(stored?.seen_at).toBe("2026-11-01T10:00:00.000Z");

    const next = answeredTurn("turn-0002", "2026-11-01T10:00:01.000Z");
    writeInboxAsk(inboxDir(dataDir), { ...stored!, turns: [...turns, next] });
    const read = await conversation(server, thread_id);
    expect(Date.parse(read!.turns[1]!.answered_at!)).toBeGreaterThan(Date.parse(read!.seen_at!));
  });

  test("with no answer yet there is nothing to mark", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    expect((await ask(server, thread_id, "turn-0001", "Why?")).status).toBe(200);
    expect((await fromWindow(server, askPath(thread_id, "/seen"), { seen_at: "2026-11-01T10:00:00.000Z" })).status).toBe(200);
    expect((await conversation(server, thread_id))?.seen_at).toBeNull();
  });
});

describe("the event stream", () => {
  test("a change tells the owner's window, and never a stream with no window or a curl naming one", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const open = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
    const windowStream = listen(await open("/api/inbox/events?window=window-one", { "Sec-Fetch-Site": "same-origin" }));
    const agentStream = listen(await open("/api/inbox/events", { "Sec-Fetch-Site": "same-origin" }));
    const curlStream = listen(await open("/api/inbox/events?window=window-two"));
    await Bun.sleep(100);

    expect((await ask(server, thread_id, "turn-0001", "Why?")).status).toBe(200);
    await Bun.sleep(100);
    expect(windowStream.frames.filter((frame) => frame === "ask")).toHaveLength(1);
    // A retry changes nothing, so it says nothing.
    expect((await ask(server, thread_id, "turn-0001", "Why?")).status).toBe(200);
    expect((await fromWindow(server, askPath(thread_id, "/end"), {})).status).toBe(200);
    await Bun.sleep(100);
    expect(windowStream.frames.filter((frame) => frame === "ask")).toHaveLength(2);
    expect(agentStream.frames).not.toContain("ask");
    expect(curlStream.frames).not.toContain("ask");
    await Promise.all([windowStream.stop(), agentStream.stop(), curlStream.stop()]);
  });
});

describe("the gate", () => {
  test("anything but the window's own page can neither ask nor read", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    expect((await ask(server, thread_id, "turn-0001", "Private words")).status).toBe(200);
    const base = `http://127.0.0.1:${server.port}`;
    const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });

    // An agent's curl: no browser headers, the page's serverSession in hand.
    for (const response of [
      await fetch(`${base}${askPath(thread_id)}`),
      await post(askPath(thread_id), { turn_id: "turn-0002", question: "From curl" }),
      await post(askPath(thread_id, "/seen"), { seen_at: new Date().toISOString() }),
      await post(askPath(thread_id, "/end"), {}),
    ]) {
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(JSON.parse(body).code).toBe("window_only");
      expect(body).not.toContain("Private words");
    }
    // Another site, and another localhost port (same-site).
    for (const site of ["cross-site", "same-site", "none"]) {
      const read = await fetch(`${base}${askPath(thread_id)}`, { headers: { "Sec-Fetch-Site": site } });
      expect(read.status).toBe(403);
    }
    expect((await post(askPath(thread_id), { turn_id: "turn-0003", question: "Cross" }, { Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await conversation(server, thread_id))?.turns.map((turn) => turn.id)).toEqual(["turn-0001"]);
  });

  test("over the tailnet the owner asks and reads; a guest does neither, and hears nothing on the stream", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "owner@example.com";
    const GUEST = "guest@example.com";
    const serve = new Map<number, string>();
    const fakeTailscale: TailscaleRunner = (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER, DisplayName: "Owner" } } }));
      if (args[1] === "status") {
        const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
        const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
        return ok(serve.size === 0 ? "{}" : JSON.stringify({ TCP, Web }));
      }
      const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) {
        serve.delete(httpsPort);
        return ok();
      }
      serve.set(httpsPort, args.at(-1)!);
      return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
    };
    const root = scratch();
    const dataDir = join(root, "data");
    const project = join(root, "api");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    // The tailnet's allowed logins come from config.json in the data dir (loadConfig reads the env's).
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscaleAllow: [GUEST] }));
    const previous = { data: process.env.PLANNOTATOR_DATA_DIR, ts: process.env.PLANNOTATOR_INBOX_TAILSCALE };
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    try {
      const server = await startInboxServer({ dataDir, askAi: true, binaryPath: null, tailscale: fakeTailscale, publishTailnet: true, phones: false });
      servers.push(server);
      const client = await connect(server);
      const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
      const listener = server.tailscale.listenerPort();
      expect(listener).not.toBeNull();
      const origin = `https://${MAGIC}:${server.port}`;
      const through = (login: string, path: string, body?: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${listener}${path}`, {
          method: body ? "POST" : "GET",
          headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login, "Sec-Fetch-Site": "same-origin", ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify({ serverSession: server.serverSession, ...body }) } : {}),
        });

      const owner = await through(OWNER, askPath(thread_id), { turn_id: "turn-0001", question: "Private words" });
      expect(owner.status).toBe(200);
      const guestStream = listen(await through(GUEST, "/api/inbox/events?window=window-guest"));
      const ownerStream = listen(await through(OWNER, "/api/inbox/events?window=window-owner"));
      await Bun.sleep(100);

      for (const response of [
        await through(GUEST, askPath(thread_id)),
        await through(GUEST, askPath(thread_id), { turn_id: "turn-0002", question: "A guest's question" }),
        await through(GUEST, askPath(thread_id, "/seen"), { seen_at: new Date().toISOString() }),
        await through(GUEST, askPath(thread_id, "/end"), {}),
      ]) {
        expect(response.status).toBe(403);
        const body = await response.text();
        expect(JSON.parse(body).code).toBe("owner_only");
        expect(body).not.toContain("Private words");
      }
      expect((await through(OWNER, askPath(thread_id), { turn_id: "turn-0003", question: "Mine" })).status).toBe(200);
      await Bun.sleep(100);
      expect(ownerStream.frames).toContain("ask");
      expect(guestStream.frames).toContain("hello");
      expect(guestStream.frames).not.toContain("ask");
      const read = await through(OWNER, askPath(thread_id));
      expect(((await read.json()) as { conversation: InboxAskConversation }).conversation.turns.map((turn) => turn.id)).toEqual(["turn-0001", "turn-0003"]);
      await Promise.all([guestStream.stop(), ownerStream.stop()]);
    } finally {
      if (previous.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous.data;
      if (previous.ts !== undefined) process.env.PLANNOTATOR_INBOX_TAILSCALE = previous.ts;
    }
  });
});
