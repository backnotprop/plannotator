/**
 * Archived threads out of the window's list (owner ruling 2026-10-12), through
 * the Inbox's real doors on a running Inbox (temp data dir, loopback), the
 * agent side over the official MCP client:
 *
 * - `GET /api/inbox/threads` without `archived` keeps them in Quiet, so an
 *   older window and the phone read what they read before;
 * - `?archived=exclude` (the window) leaves them out of every section and
 *   counts them in `archived_count`;
 * - `GET /api/inbox/threads/archived` lists them newest archived first, a
 *   page at a time, with a project filter and per-project counts;
 * - Unarchive brings a thread back to the list and out of the archived set;
 * - a thread's own read carries its row, an archived thread's too.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ListModel {
  sections: InboxListSection[];
  archived_count: number;
  projects: { id: string; threads: number; unread: number }[];
}
interface ArchivedModel {
  project: string | null;
  projects: { id: string; name: string; archived: number }[];
  total: number;
  offset: number;
  limit: number;
  threads: InboxListRow[];
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-archived-")));
  roots.push(root);
  const billing = join(root, "billing");
  const docs = join(root, "docs");
  mkdirSync(billing, { recursive: true });
  mkdirSync(docs, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-archived-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  let n = 0;
  /** A new thread (each send names its own thread). */
  const send = async (projectPath: string, subject: string, body = "A note.") => {
    n += 1;
    const sent = (await client.callTool({
      name: "send_message",
      arguments: { project_path: projectPath, agent_session: "ses_arch", agent_name: "Claude Code", thread: `t${n}`, subject, body },
    })) as { structuredContent: { thread_id: string } };
    const threadId = sent.structuredContent.thread_id;
    return { thread_id: threadId, project_id: server.store.thread(threadId)!.project.id };
  };
  /** An agent's reply_to reply into a thread (archived or not). */
  const reply = async (projectPath: string, messageId: string, body: string) => {
    const sent = (await client.callTool({
      name: "send_message",
      arguments: { project_path: projectPath, agent_session: "ses_arch", agent_name: "Claude Code", reply_to: messageId, body },
    })) as { structuredContent: { thread_id: string }; isError?: boolean };
    expect(sent.isError ?? false).toBe(false);
    return sent.structuredContent;
  };
  return { server, billing, docs, send, reply };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const getJson = async <T>(server: InboxServer, path: string): Promise<T> => (await (await fetch(url(server, path))).json()) as T;
const resolve = async (server: InboxServer, threadId: string, resolved: boolean) => {
  const res = await fetch(url(server, `/api/inbox/messages/${threadId}/resolve`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, resolved }),
  });
  expect(res.status).toBe(200);
  // resolved_at has millisecond resolution: keep archive times apart so the order is the order archived.
  await Bun.sleep(5);
};
const ids = (rows: readonly InboxListRow[]) => rows.map((r) => r.thread_id);
const allRows = (model: ListModel) => model.sections.flatMap((s) => s.threads);

describe("archived threads", () => {
  test("the default list keeps them in Quiet; ?archived=exclude leaves them out of every section", async () => {
    const { server, billing, send } = await setup();
    const kept = await send(billing, "Kept");
    const gone = await send(billing, "Archived one");
    await resolve(server, gone.thread_id, true);

    const before = await getJson<ListModel>(server, "/api/inbox/threads");
    expect(before.sections.find((s) => s.id === "quiet")!.threads.map((r) => r.thread_id)).toContain(gone.thread_id);
    expect(before.archived_count).toBe(1);

    const model = await getJson<ListModel>(server, "/api/inbox/threads?archived=exclude");
    expect(model.sections.map((s) => s.id)).toEqual(before.sections.map((s) => s.id));
    expect(ids(allRows(model))).toEqual([kept.thread_id]);
    expect(model.archived_count).toBe(1);
    // The sidebar's folder counts are the same either way.
    expect(model.projects).toEqual(before.projects);

    const bad = await fetch(url(server, "/api/inbox/threads?archived=hide"));
    expect(bad.status).toBe(422);
  });

  test("the archived set: newest archived first, per-project counts, a project filter", async () => {
    const { server, billing, docs, send } = await setup();
    const a = await send(billing, "First archived");
    const b = await send(docs, "Second archived");
    const c = await send(billing, "Third archived");
    await send(docs, "Still open");
    await resolve(server, a.thread_id, true);
    await resolve(server, b.thread_id, true);
    await resolve(server, c.thread_id, true);

    const all = await getJson<ArchivedModel>(server, "/api/inbox/threads/archived");
    expect(ids(all.threads)).toEqual([c.thread_id, b.thread_id, a.thread_id]);
    expect(all.total).toBe(3);
    expect(all.threads.every((r) => r.resolved_at !== null)).toBe(true);
    expect(all.projects).toEqual([
      { id: a.project_id, name: "billing", archived: 2 },
      { id: b.project_id, name: "docs", archived: 1 },
    ]);

    const onlyBilling = await getJson<ArchivedModel>(server, `/api/inbox/threads/archived?project=${a.project_id}`);
    expect(onlyBilling.project).toBe(a.project_id);
    expect(ids(onlyBilling.threads)).toEqual([c.thread_id, a.thread_id]);
    expect(onlyBilling.total).toBe(2);
    // The filter's choices stay every project with archived threads.
    expect(onlyBilling.projects).toHaveLength(2);
  });

  test("a page at a time: offset and limit, with the total beyond the page", async () => {
    const { server, billing, send } = await setup();
    const sent = [];
    for (let i = 0; i < 5; i += 1) sent.push(await send(billing, `Archived ${i}`));
    for (const s of sent) await resolve(server, s.thread_id, true);
    const newestFirst = [...sent].reverse().map((s) => s.thread_id);

    const first = await getJson<ArchivedModel>(server, "/api/inbox/threads/archived?limit=2");
    expect(first).toMatchObject({ total: 5, offset: 0, limit: 2 });
    expect(ids(first.threads)).toEqual(newestFirst.slice(0, 2));
    const last = await getJson<ArchivedModel>(server, "/api/inbox/threads/archived?offset=4&limit=2");
    expect(ids(last.threads)).toEqual(newestFirst.slice(4));

    for (const bad of ["limit=0", "limit=201", "limit=two", "offset=-1", "project=nope"]) {
      expect((await fetch(url(server, `/api/inbox/threads/archived?${bad}`))).status).toBe(422);
    }
  });

  test("Unarchive takes it out of the archived set and puts it back in the window's list", async () => {
    const { server, billing, send } = await setup();
    const t = await send(billing, "Comes back");
    await resolve(server, t.thread_id, true);
    expect((await getJson<ArchivedModel>(server, "/api/inbox/threads/archived")).total).toBe(1);

    await resolve(server, t.thread_id, false);
    const archived = await getJson<ArchivedModel>(server, "/api/inbox/threads/archived");
    expect(archived).toMatchObject({ total: 0, threads: [], projects: [] });
    const model = await getJson<ListModel>(server, "/api/inbox/threads?archived=exclude");
    const row = allRows(model).find((r) => r.thread_id === t.thread_id)!;
    expect(row.resolved_at).toBeNull();
    expect(row.section).not.toBe("quiet");
    expect(model.archived_count).toBe(0);
  });

  test("an agent's reply into an archived thread brings it back to the list and out of the archived set; it stays resolved", async () => {
    const { server, billing, send, reply } = await setup();
    const t = await send(billing, "Release notes");
    await resolve(server, t.thread_id, true);
    expect(ids(allRows(await getJson<ListModel>(server, "/api/inbox/threads?archived=exclude")))).not.toContain(t.thread_id);

    const back = await reply(billing, t.thread_id, "One more call.\n\n:::question\nShip it today?\n\n- [ ] Yes\n- [ ] No\n:::");
    expect(back.thread_id).toBe(t.thread_id);
    const model = await getJson<ListModel>(server, "/api/inbox/threads?archived=exclude");
    const row = allRows(model).find((r) => r.thread_id === t.thread_id)!;
    // News again, placed by its question; still resolved until the person acts.
    expect(row).toMatchObject({ section: "waiting", unread: true, agent_after_archive: true });
    expect(row.resolved_at).not.toBeNull();
    expect(model.archived_count).toBe(0);
    expect((await getJson<ArchivedModel>(server, "/api/inbox/threads/archived")).total).toBe(0);
    // The default list (the phone) places it the same way.
    const phone = await getJson<ListModel>(server, "/api/inbox/threads");
    expect(phone.sections.find((s) => s.id === "waiting")!.threads.map((r) => r.thread_id)).toContain(t.thread_id);
    // Its read still says archived.
    const read = await getJson<{ thread: { resolved_at: string | null } }>(server, `/api/inbox/threads/${t.thread_id}`);
    expect(read.thread.resolved_at).not.toBeNull();
  });

  test("a thread's read carries its row, an archived thread's too", async () => {
    const { server, billing, send } = await setup();
    const t = await send(billing, "Read me");
    await resolve(server, t.thread_id, true);
    const read = await getJson<{ row: InboxListRow | null }>(server, `/api/inbox/threads/${t.thread_id}`);
    expect(read.row).toMatchObject({ thread_id: t.thread_id, section: "quiet" });
    expect(read.row!.resolved_at).not.toBeNull();
  });
});
