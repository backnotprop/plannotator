/**
 * The list's Priority group, the person's side, through the Inbox's real doors
 * on a running Inbox (temp data dir, loopback): Add, Remove and their Undo,
 * kept in `inbox/priority.json` outside the event log, the row's `priority`,
 * an archive dropping the add and its Undo putting it back, a reply keeping
 * it, an add dropping an earlier `off`, `event: priority` to windows only, the
 * window's guards, a phone through its door, and agents never seeing any of it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

type Json = Record<string, any>;

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(extra: Partial<Parameters<typeof startInboxServer>[0]> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-priority-")));
  roots.push(root);
  const project = join(root, "docs");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000, ...extra });
  servers.push(server);
  const client = new Client({ name: "inbox-priority-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (body: string, session: string, replyTo?: string) =>
    (
      (await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: session, agent_name: "Claude Code", body, ...(replyTo ? { reply_to: replyTo } : {}) } })) as {
        structuredContent: { thread_id: string; message_id: string };
      }
    ).structuredContent;
  return { root, dataDir, server, client, send };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
const priority = (server: InboxServer, threadId: string, body: Record<string, unknown>) => post(server, `/api/inbox/threads/${threadId}/priority`, body);
const rows = async (server: InboxServer, query = "?archived=include") =>
  ((await (await fetch(url(server, `/api/inbox/threads${query}`))).json()) as { sections: InboxListSection[] }).sections.flatMap((s) => s.threads);
const rowOf = async (server: InboxServer, threadId: string, query?: string): Promise<InboxListRow | undefined> => (await rows(server, query)).find((r) => r.thread_id === threadId);
const ASK = ":::question\nWhich index?\n\n- [ ] Pagefind\n- [ ] Orama\n:::";

describe("the person's Priority", () => {
  test("Add, Remove and the Undo: the row's `priority`, its section unchanged, the first time kept", async () => {
    const { server, send } = await setup();
    const a = await send(ASK, "ses_a");
    const b = await send("Bundle size report", "ses_b");
    // Every row of an Inbox that keeps priority carries the key: it is how the window knows to offer the item.
    for (const row of await rows(server)) expect(row.priority).toBeNull();
    const section = (await rowOf(server, a.thread_id))!.section;

    const added = await priority(server, a.thread_id, { priority: true });
    expect(added.status).toBe(200);
    expect(((await added.json()) as Json).before).toEqual({ at: null, off_at: null });
    const row = (await rowOf(server, a.thread_id))!;
    expect(row.priority).toEqual({ person: true, at: expect.any(String), ask: null });
    expect(row.section).toBe(section);
    expect((await rowOf(server, b.thread_id))!.priority).toBeNull();
    const first = row.priority!.at;

    const removed = (await (await priority(server, a.thread_id, { priority: false })).json()) as Json;
    expect(removed.before).toEqual({ at: first, off_at: null });
    expect((await rowOf(server, a.thread_id))!.priority).toBeNull();

    // Undo writes back exactly the `before` it was handed.
    expect((await priority(server, a.thread_id, { restore: removed.before })).status).toBe(200);
    expect((await rowOf(server, a.thread_id))!.priority).toEqual({ person: true, at: first, ask: null });
    // The person writes in the thread: the add stays.
    expect((await post(server, `/api/inbox/messages/${a.message_id}/reply`, { idempotency_key: "r1", words: "Pagefind." })).status).toBe(200);
    expect((await rowOf(server, a.thread_id))!.priority).toEqual({ person: true, at: first, ask: null });
  });

  test("an archive drops the add (an archived row carries none); Archive's Undo puts it back with its first time", async () => {
    const { server, send } = await setup();
    const a = await send(ASK, "ses_a");
    await priority(server, a.thread_id, { priority: true });
    const first = (await rowOf(server, a.thread_id))!.priority!.at;
    expect((await post(server, `/api/inbox/messages/${a.thread_id}/resolve`, { resolved: true })).status).toBe(200);
    expect((await rowOf(server, a.thread_id))!.priority).toBeNull();
    expect(server.store.priorities().threads).toEqual([]);
    // An archived thread takes no new add.
    expect(((await (await priority(server, a.thread_id, { priority: true })).json()) as Json).code).toBe("thread_resolved");
    // The window's Undo: unarchive, then the restore.
    expect((await post(server, `/api/inbox/messages/${a.thread_id}/resolve`, { resolved: false })).status).toBe(200);
    expect((await priority(server, a.thread_id, { restore: { at: first, off_at: null } })).status).toBe(200);
    expect((await rowOf(server, a.thread_id))!.priority).toEqual({ person: true, at: first, ask: null });
  });

  test("an add drops an `off` the file holds; a remove keeps it; read again at a restart", async () => {
    const { dataDir, server, send } = await setup();
    const threadId = (await send("Release notes draft", "ses_a")).thread_id;
    const file = join(dataDir, "inbox", "priority.json");
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    writeFileSync(file, JSON.stringify({ v: 1, threads: [], off: [{ thread_id: threadId, at: "2026-11-12T09:00:00.000Z" }] }));
    const again = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000 });
    servers.push(again);
    expect((await rowOf(again, threadId))!.priority).toBeNull();
    const before = (await (await priority(again, threadId, { priority: true })).json()) as Json;
    expect(before.before).toEqual({ at: null, off_at: "2026-11-12T09:00:00.000Z" });
    expect(JSON.parse(readFileSync(file, "utf8")).off).toEqual([]);
    // Undo of that add writes the `off` back.
    await priority(again, threadId, { restore: before.before });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, threads: [], off: [{ thread_id: threadId, at: "2026-11-12T09:00:00.000Z" }] });
  });

  test("guards: another site, a stale tab, an unknown thread, a reply's id and a bad body are refused", async () => {
    const { server, send } = await setup();
    const a = await send("Add me", "ses_a");
    const path = `/api/inbox/threads/${a.thread_id}/priority`;
    expect(((await (await post(server, path, { priority: true }, { Origin: "https://evil.example" })).json()) as Json).code).toBe("cross_origin");
    expect((await post(server, path, { priority: true }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const stale = await fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "not-this-one", priority: true }) });
    expect(stale.status).toBe(409);
    expect((await priority(server, "msg_01K70000000000000000000099", { priority: true })).status).toBe(404);
    const reply = await send("A second message", "ses_a", a.message_id);
    expect((await priority(server, reply.message_id, { priority: true })).status).toBe(404);
    expect((await post(server, path, { priority: "yes" })).status).toBe(422);
    expect((await post(server, path, {})).status).toBe(422);
    expect((await post(server, path, { priority: true, restore: { at: null, off_at: null } })).status).toBe(422);
    expect((await post(server, path, { restore: { at: "later", off_at: null } })).status).toBe(422);
    expect((await fetch(url(server, path))).status).toBe(405);
    expect(server.store.priorities()).toEqual({ threads: [], off: [] });
  });

  test("every open window hears `event: priority`; the phone's stream (no window id) does not", async () => {
    const { server, send } = await setup();
    const a = await send("Add me", "ses_a");
    const read = async (query: string, act: () => Promise<unknown>) => {
      const controller = new AbortController();
      const stream = await fetch(url(server, `/api/inbox/events?cursor=${server.store.cursor()}${query}`), { signal: controller.signal });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);
      await act();
      const deadline = Date.now() + 1500;
      while (!text.includes("event: priority") && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
        if (chunk && chunk.value) text += decoder.decode(chunk.value);
      }
      controller.abort();
      return text;
    };
    expect(await read("&window=window-priority-1&permission=granted", () => priority(server, a.thread_id, { priority: true }))).toContain("event: priority\ndata: {}");
    expect(await read("", () => priority(server, a.thread_id, { priority: false }))).not.toContain("event: priority");
  });

  test("agents never see it, and an add writes no store line", async () => {
    const { server, client, send } = await setup();
    const a = await send("Which search index should the docs use?", "ses_a");
    const cursor = server.store.cursor();
    await priority(server, a.thread_id, { priority: true });
    expect(server.store.cursor()).toBe(cursor);
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id: a.thread_id, agent_session: "ses_a" } });
    const listed = await client.callTool({ name: "read_thread", arguments: { agent_session: "ses_a", asked_by: "anyone" } });
    const searched = await client.callTool({ name: "search", arguments: { query: "search index", agent_session: "ses_a" } });
    for (const answer of [read, listed, searched]) expect(JSON.stringify(answer)).not.toMatch(/\\?"priority\\?"/);
    expect(server.store.listRow(a.thread_id)!.priority).toBeUndefined();
  });

  test("a phone adds through its door; a repeated key is answered from the door's log", async () => {
    const { server, send } = await setup({ phones: true });
    const a = await send("Add me", "ses_a");
    const made = (await (await fetch(url(server, "/api/inbox/pairing"), { method: "POST", body: "{}" })).json()) as Json;
    const paired = await fetch(url(server, "/api/inbox/device/pair"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }),
    });
    expect(paired.status).toBe(201);
    const token = ((await paired.json()) as Json).token as string;
    const door = (path: string, init: { method?: string; body?: unknown } = {}) =>
      fetch(url(server, `/api/inbox/device/${path}`), {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    const doorRow = async () => ((await (await door("threads")).json()) as { sections: InboxListSection[] }).sections.flatMap((s) => s.threads).find((r) => r.thread_id === a.thread_id)!;
    expect((await doorRow()).priority).toBeNull();

    const added = await door(`threads/${a.thread_id}/priority`, { method: "POST", body: { priority: true, idempotency_key: "k1" } });
    expect(added.status).toBe(200);
    const first = (await doorRow()).priority!.at;
    expect(server.store.priorities().threads).toEqual([{ thread_id: a.thread_id, at: first }]);

    const removed = (await (await door(`threads/${a.thread_id}/priority`, { method: "POST", body: { priority: false, idempotency_key: "k2" } })).json()) as Json;
    expect(removed.before.at).toBe(first);
    expect((await door(`threads/${a.thread_id}/priority`, { method: "POST", body: { restore: removed.before, idempotency_key: "k3" } })).status).toBe(200);
    expect((await doorRow()).priority!.at).toBe(first);

    // A command sent twice (a retry) is answered from the door's log and writes nothing again.
    const replay = await door(`threads/${a.thread_id}/priority`, { method: "POST", body: { priority: false, idempotency_key: "k2" } });
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await doorRow()).priority!.at).toBe(first);
    const noKey = await door(`threads/${a.thread_id}/priority`, { method: "POST", body: { priority: false } });
    expect(noKey.status).toBe(422);
  });
});
