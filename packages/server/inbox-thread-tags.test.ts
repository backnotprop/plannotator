/**
 * Thread tags (approval "inbox-thread-tags", step 1) through the Inbox's real doors on a running Inbox (temp data dir,
 * loopback): Add tag and untick through `POST /api/inbox/threads/:id/tags`, the list's `tags` and each row's
 * `row.tags`, kept in `inbox/tags.json` (0600) outside the event log across a restart, the window's guards,
 * `event: tags` to windows only, a tag made and renamed with the Board off, and agents never seeing any of it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxInitiative, InboxListRow, InboxListSection } from "@plannotator/core/inbox-types";
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

async function start(dataDir: string) {
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000 });
  servers.push(server);
  const client = new Client({ name: "inbox-thread-tags-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client };
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-thread-tags-")));
  roots.push(root);
  const project = join(root, "docs");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const { server, client } = await start(dataDir);
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

interface ListModel {
  sections: InboxListSection[];
  snoozed?: InboxListRow[];
  tags?: InboxInitiative[];
}
const list = async (server: InboxServer): Promise<ListModel> => (await (await fetch(url(server, "/api/inbox/threads?archived=exclude"))).json()) as ListModel;
// A row in no tag carries no `tags`; a thread the list does not hold reads as null.
const rowTags = async (server: InboxServer, threadId: string) => {
  const row = (await list(server)).sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId);
  return row ? (row.tags ?? []) : null;
};
const tagThread = (server: InboxServer, threadId: string, tag: string, on: boolean) => post(server, `/api/inbox/threads/${threadId}/tags`, { tag, on });
const makeTag = async (server: InboxServer, name: string) => ((await (await post(server, "/api/inbox/initiatives", { name })).json()) as { initiative: InboxInitiative }).initiative;

describe("thread tags", () => {
  test("Add tag and untick; the list's live `tags` and each row's `tags`; kept outside the event log, 0600, across a restart", async () => {
    const { dataDir, server, send } = await setup();
    const a = await send("Release notes are ready", "ses_a");
    // The Board is off (its default): a tag is still made, renamed and used.
    expect(((await (await fetch(url(server, "/api/inbox/settings"))).json()) as Json).board).toEqual({ on: false });
    const release = await makeTag(server, "Release");
    const windows = await makeTag(server, "Windows");
    expect((await list(server)).tags?.map((t) => t.name).sort()).toEqual(["Release", "Windows"]);
    expect(await rowTags(server, a.thread_id)).toEqual([]);
    const cursor = server.store.cursor();
    const added = await tagThread(server, a.thread_id, release.id, true);
    expect(added.status).toBe(200);
    expect(((await added.json()) as Json).tags).toEqual([release.id]);
    await tagThread(server, a.thread_id, windows.id, true);
    // Two tags made in the same millisecond list in id order (the Board's rule), so the order is not checked here.
    expect((await rowTags(server, a.thread_id))?.sort()).toEqual([release.id, windows.id].sort());
    // A mark writes no store line: no cursor moves, no agent hears of it.
    expect(server.store.cursor()).toBe(cursor);
    expect(server.store.changesSince(cursor)).toEqual([]);
    expect(((await (await tagThread(server, a.thread_id, windows.id, false)).json()) as Json).tags).toEqual([release.id]);
    const file = join(dataDir, "inbox", "tags.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Renamed, the tag keeps its threads.
    expect((await post(server, `/api/inbox/initiatives/${release.id}`, { op: "rename", name: "Ship 0.29" })).status).toBe(200);
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const again = (await start(dataDir)).server;
    expect(await rowTags(again, a.thread_id)).toEqual([release.id]);
    expect((await list(again)).tags?.map((t) => t.name).sort()).toEqual(["Ship 0.29", "Windows"]);
    // Deleted, the tag leaves the list's `tags` and every row.
    await post(again, `/api/inbox/initiatives/${release.id}`, { op: "delete" });
    expect(await rowTags(again, a.thread_id)).toEqual([]);
    expect((await list(again)).tags?.map((t) => t.name).sort()).toEqual(["Windows"]);
  });

  test("the person's #Name in a reply tags the thread; an agent's does not; agents never read a tag", async () => {
    const { server, client, send } = await setup();
    const a = await send("Shipping with #Release", "ses_a");
    const release = await makeTag(server, "Release");
    expect(await rowTags(server, a.thread_id)).toEqual([]);
    server.store.sendReply(a.message_id, { words: "This is #Release work.", idempotency_key: "k-1" });
    expect(await rowTags(server, a.thread_id)).toEqual([release.id]);
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id: a.thread_id, agent_session: "ses_a" } });
    const listed = await client.callTool({ name: "read_thread", arguments: { agent_session: "ses_a", asked_by: "anyone" } });
    const searched = await client.callTool({ name: "search", arguments: { query: "Release", agent_session: "ses_a" } });
    for (const answer of [read, listed, searched]) {
      expect(JSON.stringify(answer)).not.toContain(release.id);
      expect(JSON.stringify(answer)).not.toMatch(/\\"tags\\"/);
    }
  });

  test("guards: another site is refused, a stale tab is refused, an unknown thread or tag is 404, a bad body is 422", async () => {
    const { server, send } = await setup();
    const a = await send("Tag me", "ses_a");
    const release = await makeTag(server, "Release");
    const path = `/api/inbox/threads/${a.thread_id}/tags`;
    expect(((await (await post(server, path, { tag: release.id, on: true }, { Origin: "https://evil.example" })).json()) as Json).code).toBe("cross_origin");
    expect((await post(server, path, { tag: release.id, on: true }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const stale = await fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "not-this-one", tag: release.id, on: true }) });
    expect(stale.status).toBe(409);
    expect((await tagThread(server, "msg_01K70000000000000000000099", release.id, true)).status).toBe(404);
    const reply = await send("A second message", "ses_a", a.message_id);
    expect((await tagThread(server, reply.message_id, release.id, true)).status).toBe(404);
    expect((await tagThread(server, a.thread_id, "ini_01K70000000000000000000099", true)).status).toBe(404);
    expect((await post(server, path, { tag: release.id, on: "yes" })).status).toBe(422);
    expect((await fetch(url(server, path))).status).toBe(405);
    expect(await rowTags(server, a.thread_id)).toEqual([]);
  });

  test("every open window hears `event: tags`; the phone's stream (no window id) does not", async () => {
    const { server, send } = await setup();
    const a = await send("Tag me", "ses_a");
    const release = await makeTag(server, "Release");
    const read = async (query: string, act: () => Promise<unknown>) => {
      const controller = new AbortController();
      const stream = await fetch(url(server, `/api/inbox/events?cursor=${server.store.cursor()}${query}`), { signal: controller.signal });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);
      await act();
      const deadline = Date.now() + 1500;
      while (!text.includes("event: tags") && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
        if (chunk && chunk.value) text += decoder.decode(chunk.value);
      }
      controller.abort();
      return text;
    };
    expect(await read("&window=window-tags-1&permission=granted", () => tagThread(server, a.thread_id, release.id, true))).toContain("event: tags\ndata: {}");
    expect(await read("", () => tagThread(server, a.thread_id, release.id, false))).not.toContain("event: tags");
  });
});
