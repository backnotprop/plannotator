/**
 * Snooze (approval "inbox-snooze") through the Inbox's real doors on a running
 * Inbox (temp data dir, loopback). What can regress: a snoozed thread left in
 * its section (or the counts), the phone's list losing it, an agent reading
 * any of it or its question closing, an agent's question ending the snooze,
 * the person's reply not ending it, the return not coming at its time (the
 * timer's `event: snoozes`, the list's clock), a Status in search finding a
 * snoozed thread, a project batch ending one, and a past time accepted.
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

async function setup() {
  // No "snooze" in the path: the agent's read names the project's folder, and must name nothing else of it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-zz-")));
  roots.push(root);
  const project = join(root, "docs");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, setAsideDelayMs: 60_000 });
  servers.push(server);
  const client = new Client({ name: "inbox-snooze-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (body: string, session: string) =>
    (
      (await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: session, agent_name: "Claude Code", body } })) as {
        structuredContent: { thread_id: string; message_id: string };
      }
    ).structuredContent;
  return { server, client, send };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: Record<string, unknown>) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
const snooze = (server: InboxServer, threadId: string, until: string | null) => post(server, `/api/inbox/threads/${threadId}/snooze`, { until });

interface ListModel {
  sections: InboxListSection[];
  snoozed?: InboxListRow[];
  projects: { id: string; unread: number; listed?: number }[];
}
const list = async (server: InboxServer, query = "?archived=exclude&snoozed=exclude"): Promise<ListModel> => (await (await fetch(url(server, `/api/inbox/threads${query}`))).json()) as ListModel;
const sectionOf = (model: ListModel, threadId: string) => model.sections.find((s) => s.threads.some((r) => r.thread_id === threadId))?.id ?? null;
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const ASK = "Which index?\n\n:::question\nWhich index?\n\n- [ ] Pagefind\n- [ ] Orama\n:::";

describe("snooze", () => {
  test("the window's list takes a snoozed thread out of every section into `snoozed`; the phone's keeps it, marked", async () => {
    const { server, send } = await setup();
    const a = await send(ASK, "ses_a");
    const b = await send("News", "ses_b");
    const cursor = server.store.cursor();
    const answer = (await (await snooze(server, a.thread_id, later(3_600_000))).json()) as { snoozed: { until: string } };
    expect(answer.snoozed.until).toEqual(expect.any(String));
    expect(server.store.cursor()).toBe(cursor);
    const window = await list(server);
    expect(sectionOf(window, a.thread_id)).toBeNull();
    expect(window.snoozed!.map((r) => r.thread_id)).toEqual([a.thread_id]);
    expect(sectionOf(window, b.thread_id)).toBe("new");
    // Nothing is unread in the project while its only question waits in the band (the sidebar's count).
    expect(window.projects[0]!.unread).toBe(1);
    expect(window.projects[0]!.listed).toBe(2);
    const phone = await list(server, "");
    expect(sectionOf(phone, a.thread_id)).toBe("waiting");
    expect(phone.snoozed).toBeUndefined();
    expect(phone.sections.flatMap((s) => s.threads).find((r) => r.thread_id === a.thread_id)!.snoozed).toEqual(answer.snoozed);
  });

  test("an agent sees nothing, its question stays open, and a new question does not end it; the person's reply does", async () => {
    const { server, client, send } = await setup();
    const a = await send("Plain news", "ses_a");
    await snooze(server, a.thread_id, later(3_600_000));
    const asked = await send(ASK, "ses_a");
    expect(asked.thread_id).toBe(a.thread_id);
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id: a.thread_id, agent_session: "ses_a" } });
    expect(JSON.stringify(read)).not.toMatch(/snooz/i);
    expect(server.store.listRow(a.thread_id)!.questions.open).toBe(1);
    expect((await list(server)).snoozed!.map((r) => r.thread_id)).toEqual([a.thread_id]);
    const replied = await post(server, `/api/inbox/messages/${asked.message_id}/reply`, { idempotency_key: "r1", words: "Pagefind." });
    expect(replied.status).toBe(200);
    const after = await list(server);
    expect(after.snoozed).toEqual([]);
    expect(sectionOf(after, a.thread_id)).not.toBeNull();
  });

  test("at its time the thread comes back to its own section, bold, with the clock; the windows hear `event: snoozes`", async () => {
    const { server, send } = await setup();
    const a = await send("Plain news", "ses_a");
    await post(server, `/api/inbox/threads/${a.thread_id}/seen`, {});
    expect(sectionOf(await list(server), a.thread_id)).toBe("quiet");
    const until = later(1200);
    const controller = new AbortController();
    const stream = await fetch(url(server, `/api/inbox/events?cursor=${server.store.cursor()}&window=window-snooze-1&permission=granted`), { signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);
    await snooze(server, a.thread_id, until);
    const heard = () => text.split("event: snoozes").length - 1;
    const deadline = Date.now() + 4000;
    // One frame for the snooze, one more when the server's timer reaches its time.
    // One read at a time: a read that loses the race still holds the next chunk.
    let pending = reader.read();
    while (heard() < 2 && Date.now() < deadline) {
      const chunk = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
      if (!chunk) continue;
      if (chunk.value) text += decoder.decode(chunk.value);
      pending = reader.read();
    }
    pending.catch(() => {});
    controller.abort();
    expect(heard()).toBe(2);
    const back = await list(server);
    const row = back.sections.find((s) => s.id === "new")!.threads.find((r) => r.thread_id === a.thread_id)!;
    expect(row).toMatchObject({ unread: true, snooze_back: until, last_at: until });
    expect(back.snoozed).toEqual([]);
    // Read, the clock goes.
    await post(server, `/api/inbox/threads/${a.thread_id}/seen`, {});
    expect(server.store.snoozes()).toEqual([]);
  });

  test("a time gone by is refused; Unsnooze ends it", async () => {
    const { server, send } = await setup();
    const a = await send("News", "ses_a");
    const past = await snooze(server, a.thread_id, new Date(Date.now() - 1000).toISOString());
    expect(past.status).toBe(409);
    expect(((await past.json()) as { code: string }).code).toBe("snooze_past");
    await snooze(server, a.thread_id, later(3_600_000));
    await snooze(server, a.thread_id, null);
    expect(server.store.snoozes()).toEqual([]);
  });

  test("search finds a snoozed thread, but no Status does", async () => {
    const { server, send } = await setup();
    const a = await send(`Rollback plan for the indexer\n\n${ASK}`, "ses_a");
    await snooze(server, a.thread_id, later(3_600_000));
    const found = async (query: string) => JSON.stringify(await (await fetch(url(server, `/api/inbox/search?${query}`))).json());
    let plain = await found("q=rollback");
    for (let i = 0; i < 20 && !plain.includes(a.thread_id); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      plain = await found("q=rollback");
    }
    expect(plain).toContain(a.thread_id);
    expect(await found("q=rollback&status=waiting")).not.toContain(a.thread_id);
  });

  test("Mark all as read and Archive all leave a snoozed thread snoozed", async () => {
    const { server, send } = await setup();
    const a = await send(ASK, "ses_a");
    const b = await send(ASK, "ses_b");
    await snooze(server, a.thread_id, later(3_600_000));
    const project = server.store.listRow(a.thread_id)!.project.id;
    expect((await post(server, `/api/inbox/projects/${project}/read`, {})).status).toBe(200);
    expect((await post(server, `/api/inbox/projects/${project}/resolve`, {})).status).toBe(200);
    expect(server.store.snoozedThreads()).toEqual(new Set([a.thread_id]));
    expect(server.store.listRow(a.thread_id)!.questions.open).toBe(1);
    expect(server.store.listRow(b.thread_id)!.resolved_at).not.toBeNull();
  });
});
