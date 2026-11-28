/**
 * "Recent activity" (approval "inbox-recent-activity-filter") through the Inbox's real doors on a running Inbox (temp
 * data dir, loopback): each list row's `acted_at`, when the person last did something in the thread (shared's
 * inbox/acted.ts). Counts: a reply, an open the person chose (`POST /seen { opened: true }`), a reply draft saved, a
 * film played (`POST /threads/:id/acted`). Never: an agent's message, a look the person did not choose, tidying (star,
 * Priority, snooze, tag, mark read and unread, archive). Also counts: a 👍 Looks good from the window or the phone's
 * door, and a question asked in the thread's Ask AI. Kept across a restart, in `inbox/acted.json`, never in the event
 * log, and never in anything an agent reads: read_thread (a thread and the list) and search, through `/mcp` and
 * through a paired cloud agent's door, a wake's words, or a send_message answer: the time acted.json keeps for a
 * thread the person only opened appears in none of them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_ASK_POLL_FIELD, INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { doorCleanups, doorWorld, until, type DoorResult } from "../../tests/helpers/inbox-agent-door-world";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(dataDir: string) {
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000, phones: true, askTimes: { connectWaitMs: 0 } });
  servers.push(server);
  const client = new Client({ name: "inbox-recent-activity-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (body: string, session: string) =>
    (
      (await client.callTool({ name: "send_message", arguments: { project_path: project(dataDir), agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", body } })) as {
        structuredContent: { thread_id: string; message_id: string };
      }
    ).structuredContent;
  return { server, send };
}

const project = (dataDir: string) => join(dataDir, "..", "billing-svc");

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-recent-activity-")));
  roots.push(root);
  mkdirSync(join(root, "billing-svc"), { recursive: true });
  const dataDir = join(root, "data");
  return { dataDir, ...(await start(dataDir)) };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: Record<string, unknown>) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
const rows = async (server: InboxServer): Promise<InboxListRow[]> =>
  ((await (await fetch(url(server, "/api/inbox/threads?archived=include"))).json()) as { sections: InboxListSection[] }).sections.flatMap((s) => s.threads);
const actedOf = async (server: InboxServer, threadId: string) => (await rows(server)).find((row) => row.thread_id === threadId)?.acted_at ?? null;
const ok = async (response: Promise<Response>) => expect((await response).status).toBe(200);

describe("the row's acted_at", () => {
  test("a reply, a chosen open, a draft and a film each set it; an agent's message and a look not chosen do not", async () => {
    const { server, send } = await setup();
    const quiet = await send("Nightly e2e: all green.", "ses_q");
    const replied = await send("Retry refunds after 24 hours?", "ses_r");
    const opened = await send("Export invoices as CSV too?", "ses_o");
    const looked = await send("Landing copy is up.", "ses_l");
    const drafted = await send("The ledger export is ready.", "ses_d");
    const film = await send("Here is the walkthrough recording.", "ses_f");

    const before = Date.now();
    await ok(post(server, `/api/inbox/messages/${replied.message_id}/reply`, { idempotency_key: "r1", words: "Yes, 24 hours." }));
    await ok(post(server, `/api/inbox/threads/${opened.thread_id}/seen`, { opened: true }));
    await ok(post(server, `/api/inbox/threads/${looked.thread_id}/seen`, {}));
    // The box saving nothing there (an empty box, no draft): no act either (inbox-reply-drafts.ts `onEdited`).
    await ok(post(server, `/api/inbox/threads/${looked.thread_id}/draft`, { body: "", base: null }));
    await ok(post(server, `/api/inbox/threads/${drafted.thread_id}/draft`, { body: "Looks right, one quest", base: null }));
    await ok(post(server, `/api/inbox/threads/${film.thread_id}/acted`, {}));

    for (const id of [replied.thread_id, opened.thread_id, drafted.thread_id, film.thread_id]) {
      const at = await actedOf(server, id);
      expect(at, id).not.toBeNull();
      expect(Date.parse(at!)).toBeGreaterThanOrEqual(before - 1000);
    }
    expect(await actedOf(server, quiet.thread_id)).toBeNull();
    expect(await actedOf(server, looked.thread_id)).toBeNull();
    // An agent writing again moves nothing.
    const at = await actedOf(server, replied.thread_id);
    await send("Done: retries now wait 24 hours.", "ses_r");
    expect(await actedOf(server, replied.thread_id)).toBe(at);
    // The store's own row (what the agents' reads are built from) has no such field.
    expect(server.store.listRow(replied.thread_id)).not.toHaveProperty("acted_at");
  });

  test("a 👍 from the window and from the phone's door, and an Ask AI question, each set it; the agent's next message does not", async () => {
    const { server, send, dataDir } = await setup();
    const fromWindow = await send("Merged. CI is green.", "ses_w");
    const fromPhone = await send("Deployed to staging.", "ses_p");
    const asked = await send("The retry change is in.", "ses_a");
    const left = await send("Nightly e2e: all green.", "ses_n");
    const before = Date.now();
    await ok(post(server, `/api/inbox/messages/${fromWindow.message_id}/ack`, {}));
    // The phone: paired through the window's offer, then its bearer token at the device door.
    const offer = (await (await fetch(url(server, "/api/inbox/pairing"), { method: "POST", body: "{}" })).json()) as { offer: { code: string } };
    const paired = await fetch(url(server, "/api/inbox/device/pair"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: offer.offer.code, name: "iPhone", platform: "ios" }) });
    expect(paired.status).toBe(201);
    const { token } = (await paired.json()) as { token: string };
    await ok(fetch(url(server, `/api/inbox/device/messages/${fromPhone.message_id}/ack`), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "ack-phone" }) }));
    // Ask AI: the thread's agent's connection says it answers live, then the window's page asks (`Sec-Fetch-Site`).
    await ok(
      fetch(url(server, INBOX_BRIDGE_POLL_PATH), {
        method: "POST",
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session: "ses_a", host: "claude-code", project_path: project(dataDir), waitMs: 0, [INBOX_ASK_POLL_FIELD]: true }),
      }),
    );
    await ok(
      fetch(url(server, `/api/inbox/threads/${asked.thread_id}/ask`), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", Origin: url(server, "") },
        body: JSON.stringify({ serverSession: server.serverSession, turn_id: "turn-0001", question: "Why 24 hours?" }),
      }),
    );
    for (const id of [fromWindow.thread_id, fromPhone.thread_id, asked.thread_id]) {
      const at = await actedOf(server, id);
      expect(at, id).not.toBeNull();
      expect(Date.parse(at!)).toBeGreaterThanOrEqual(before - 1000);
    }
    expect(await actedOf(server, left.thread_id)).toBeNull();
    const at = await actedOf(server, fromWindow.thread_id);
    await send("Thanks, closing this out.", "ses_w");
    expect(await actedOf(server, fromWindow.thread_id)).toBe(at);
  });

  test("tidying never sets it: star, Priority, snooze, tag, mark read and unread, archive", async () => {
    const { server, send } = await setup();
    const t = await send("Ship the new hero line?\n\n:::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::", "ses_t");
    const id = t.thread_id;
    await ok(post(server, `/api/inbox/threads/${id}/pin`, { pinned: true }));
    await ok(post(server, `/api/inbox/threads/${id}/priority`, { priority: true }));
    await ok(post(server, `/api/inbox/threads/${id}/snooze`, { until: new Date(Date.now() + 86_400_000).toISOString() }));
    await ok(post(server, `/api/inbox/threads/${id}/snooze`, { until: null }));
    await ok(post(server, `/api/inbox/threads/${id}/tags`, { name: "launch", on: true }));
    await ok(post(server, `/api/inbox/threads/${id}/read`, {}));
    await ok(post(server, `/api/inbox/threads/${id}/mark-unread`, {}));
    await ok(post(server, `/api/inbox/messages/${id}/resolve`, { resolved: true }));
    expect(await actedOf(server, id)).toBeNull();
  });

  test("kept across a restart in inbox/acted.json, never in the event log", async () => {
    const { server, send, dataDir } = await setup();
    const inbox = server.store.dir;
    const t = await send("Export invoices as CSV too?", "ses_o");
    await ok(post(server, `/api/inbox/threads/${t.thread_id}/seen`, { opened: true }));
    const at = await actedOf(server, t.thread_id);
    expect(at).not.toBeNull();
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    expect(JSON.parse(readFileSync(join(inbox, "acted.json"), "utf8")).threads[t.thread_id]).toBe(at);
    const logs = readdirSync(inbox, { recursive: true }).map(String).filter((name) => name.endsWith(".jsonl"));
    expect(logs.length).toBeGreaterThan(0);
    for (const name of logs) expect(readFileSync(join(inbox, name), "utf8")).not.toContain("acted_at");
    const again = await start(dataDir);
    expect(await actedOf(again.server, t.thread_id)).toBe(at);
  });

  test("the film route: POST only, a thread id only, the page's session", async () => {
    const { server } = await setup();
    expect((await fetch(url(server, "/api/inbox/threads/msg_01ARZ3NDEKTSV4RRFFQ69G5FAV/acted"))).status).toBe(405);
    expect((await post(server, "/api/inbox/threads/prj_01ARZ3NDEKTSV4RRFFQ69G5FAV/acted", {})).status).toBe(422);
    expect((await fetch(url(server, "/api/inbox/threads/msg_01ARZ3NDEKTSV4RRFFQ69G5FAV/acted"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "another" }) })).status).toBe(409);
    expect(existsSync(join(server.store.dir, "acted.json"))).toBe(false);
  });
});

describe("agents never read it", () => {
  const cleanups = doorCleanups();
  afterEach(() => cleanups.run());

  test("read_thread (a thread and the list) and search carry no acted_at, through /mcp and a paired agent's door", async () => {
    const w = await doorWorld(cleanups);
    const id = w.local.thread_id;
    // The person opens the thread and replies: the window's list carries the time...
    expect((await w.call(`/api/inbox/threads/${id}/seen`, { opened: true })).status).toBe(200);
    expect((await w.call(`/api/inbox/messages/${w.local.message_id}/reply`, { idempotency_key: "r1", words: "The zebra launch goes Friday." })).status).toBe(200);
    const listed = (await w.call("/api/inbox/threads?archived=include")).json as { sections: InboxListSection[] };
    expect(listed.sections.flatMap((s) => s.threads).find((row) => row.thread_id === id)?.acted_at).toBeTruthy();
    // ...and nothing an agent reads does.
    const local = (name: string, args: Record<string, unknown>) => w.mcp.callTool({ name, arguments: name === "read_thread" ? { agent_session: "ses_reader", ...args } : args }) as Promise<DoorResult>;
    const { pairing } = await w.pair();
    const door = async (tool: string, args: Record<string, unknown>) => (await w.door(pairing.token, tool, args)).result!;
    const reads: [string, DoorResult][] = [
      ["mcp read_thread", await local("read_thread", { thread_id: id })],
      // The list: every agent's threads there, not only this session's own (`asked_by`).
      ["mcp list", await local("read_thread", { project_path: w.project, asked_by: "anyone" })],
      ["mcp search", await local("search", { query: "zebra", project_path: w.project })],
      ["door read_thread", await door("read_thread", { thread_id: id })],
      ["door list", await door("read_thread", { asked_by: "anyone" })],
      ["door search", await door("search", { query: "zebra" })],
    ];
    for (const [what, result] of reads) {
      expect(result.isError ? result.content[0]?.text : null, what).toBeNull();
      const text = JSON.stringify(result);
      expect(text, what).toContain(id);
      expect(text, what).not.toContain("acted_at");
    }
  });

  test("a thread the person only opened: the time acted.json keeps for it is in no agent read, no wake and no send_message answer", async () => {
    const w = await doorWorld(cleanups);
    const id = w.local.thread_id;
    // A look not chosen first (it writes the look's line), then the person's chosen open: no reply, no other record,
    // so the open's time is acted.json's alone.
    expect((await w.call(`/api/inbox/threads/${id}/seen`, {})).status).toBe(200);
    await Bun.sleep(15);
    expect((await w.call(`/api/inbox/threads/${id}/seen`, { opened: true })).status).toBe(200);
    const file = join(w.dataDir, "inbox", "acted.json");
    await until(() => existsSync(file) && !!JSON.parse(readFileSync(file, "utf8")).threads?.[id]);
    const opened = JSON.parse(readFileSync(file, "utf8")).threads[id] as string;
    const listed = (await w.call("/api/inbox/threads?archived=include")).json as { sections: InboxListSection[] };
    expect(listed.sections.flatMap((s) => s.threads).find((row) => row.thread_id === id)?.acted_at).toBe(opened);

    const local = (name: string, args: Record<string, unknown>) => w.mcp.callTool({ name, arguments: name === "read_thread" ? { agent_session: "ses_reader", ...args } : args }) as Promise<DoorResult>;
    const { pairing, hook } = await w.pair();
    const door = async (tool: string, args: Record<string, unknown>) => (await w.door(pairing.token, tool, args)).result!;
    // A wake: the door agent's own thread, which the person answers.
    const asked = await door("send_message", { body: "Found the flaky test. Fix it now?", idempotency_key: "s1" });
    const askedId = asked.structuredContent!.thread_id as string;
    const posted = (await w.thread(askedId)).messages[0]!;
    expect((await w.call(`/api/inbox/messages/${posted.id}/reply`, { words: "Yes, fix it.", idempotency_key: "r1" })).status).toBe(200);
    await until(() => hook.seen.length === 1);
    const reads: [string, unknown][] = [
      ["mcp read_thread", await local("read_thread", { thread_id: id })],
      ["mcp list as another session", await local("read_thread", { project_path: w.project, asked_by: "anyone" })],
      ["mcp search", await local("search", { query: "zebra", project_path: w.project })],
      ["door read_thread", await door("read_thread", { thread_id: id })],
      ["door list", await door("read_thread", { asked_by: "anyone" })],
      ["door search", await door("search", { query: "zebra" })],
      ["mcp send_message into the opened thread", await w.mcp.callTool({ name: "send_message", arguments: { agent_session: "ses-pi", agent_host: "pi", reply_to: w.local.message_id, body: "One more note on the zebra launch.", project_path: w.project, idempotency_key: "k2" } })],
      ["door send_message", asked],
      ["the wake", hook.seen],
    ];
    for (const [what, result] of reads) {
      const failed = (result as DoorResult).isError ? (result as DoorResult).content[0]?.text : null;
      expect(failed ?? null, what).toBeNull();
      const text = JSON.stringify(result);
      expect(text, what).not.toContain(opened);
      expect(text, what).not.toContain("acted_at");
    }
  });
});
