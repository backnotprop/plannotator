/**
 * Pinned threads (approval "inbox-pinned-threads", .product/approved/
 * inbox-pinned-threads/) through the Inbox's real doors on a running Inbox
 * (temp data dir, loopback): pin, unpin, the order (Move up and down, Unpin's
 * Undo), kept in `inbox/pins.json` outside the event log, across a restart,
 * gone with a deleted thread or project, `event: pins` to windows only, an
 * archived thread stays pinned, no limit, the window's guards, the owner over
 * the tailnet, a phone reading `pins` with the list, and agents never seeing
 * any of it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection } from "@plannotator/core/inbox-types";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";

type Json = Record<string, any>;

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function start(dataDir: string, extra: Partial<Parameters<typeof startInboxServer>[0]> = {}) {
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000, ...extra });
  servers.push(server);
  const client = new Client({ name: "inbox-pins-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client };
}

async function setup(extra: Partial<Parameters<typeof startInboxServer>[0]> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-pins-")));
  roots.push(root);
  const project = join(root, "docs");
  const other = join(root, "relay");
  mkdirSync(project, { recursive: true });
  mkdirSync(other, { recursive: true });
  const dataDir = join(root, "data");
  const { server, client } = await start(dataDir, extra);
  const send = async (body: string, session: string, path = project) =>
    (
      (await client.callTool({ name: "send_message", arguments: { project_path: path, agent_session: session, agent_name: "Claude Code", body } })) as {
        structuredContent: { thread_id: string; message_id: string };
      }
    ).structuredContent;
  const projectOf = (threadId: string) => server.store.listRow(threadId)!.project.id;
  return { root, project, other, dataDir, server, client, send, projectOf };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });

interface ListModel {
  sections: InboxListSection[];
  pins?: InboxListRow[];
}
const list = async (server: InboxServer, query = "?archived=exclude"): Promise<ListModel> => (await (await fetch(url(server, `/api/inbox/threads${query}`))).json()) as ListModel;
const pinIds = async (server: InboxServer, query?: string) => ((await list(server, query)).pins ?? []).map((row) => row.thread_id);
const pin = (server: InboxServer, threadId: string, pinned: boolean) => post(server, `/api/inbox/threads/${threadId}/pin`, { pinned });

describe("pinned threads", () => {
  test("pin at the bottom, unpin, order; the list's `pins` and each row's `pinned_at`", async () => {
    const { server, send } = await setup();
    const a = await send("Board step 2: names for the review columns", "ses_a");
    const b = await send("Which APNs environment?", "ses_b");
    const c = await send("Nightly e2e: two flaky specs", "ses_c");
    expect((await list(server)).pins).toEqual([]);

    for (const t of [a, b, c]) expect((await pin(server, t.thread_id, true)).status).toBe(200);
    expect(await pinIds(server)).toEqual([a.thread_id, b.thread_id, c.thread_id]);
    // Pinning again changes nothing (no move to the bottom).
    const again = (await (await pin(server, a.thread_id, true)).json()) as { pins: { thread_id: string }[] };
    expect(again.pins.map((p) => p.thread_id)).toEqual([a.thread_id, b.thread_id, c.thread_id]);

    const model = await list(server);
    const row = model.sections.flatMap((s) => s.threads).find((r) => r.thread_id === b.thread_id)!;
    expect(typeof row.pinned_at).toBe("string");
    expect(model.pins![1]!.subject).toBe(row.subject);

    // Move down (b below c), then the Undo of an Unpin puts a back where it was, pinned when it first was.
    expect((await post(server, "/api/inbox/pins", { order: [a.thread_id, c.thread_id, b.thread_id] })).status).toBe(200);
    expect(await pinIds(server)).toEqual([a.thread_id, c.thread_id, b.thread_id]);
    const firstPinnedAt = (await list(server)).pins![0]!.pinned_at!;
    expect((await pin(server, a.thread_id, false)).status).toBe(200);
    expect(await pinIds(server)).toEqual([c.thread_id, b.thread_id]);
    const unpinnedRow = (await list(server)).sections.flatMap((s) => s.threads).find((r) => r.thread_id === a.thread_id)!;
    expect(unpinnedRow.pinned_at ?? null).toBeNull();
    // An order alone never pins it again.
    expect((await post(server, "/api/inbox/pins", { order: [a.thread_id, c.thread_id, b.thread_id] })).status).toBe(200);
    expect(await pinIds(server)).toEqual([c.thread_id, b.thread_id]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await post(server, "/api/inbox/pins", { restore: { thread_id: a.thread_id, index: 0, pinned_at: firstPinnedAt } })).status).toBe(200);
    expect(await pinIds(server)).toEqual([a.thread_id, c.thread_id, b.thread_id]);
    expect((await list(server)).pins![0]!.pinned_at).toBe(firstPinnedAt);

    // An order from a window that has not seen a newer pin keeps it (after the ones it names); an order never unpins.
    const d = await send("Release notes draft", "ses_d");
    await pin(server, d.thread_id, true);
    expect((await post(server, "/api/inbox/pins", { order: [c.thread_id, a.thread_id] })).status).toBe(200);
    expect(await pinIds(server)).toEqual([c.thread_id, a.thread_id, b.thread_id, d.thread_id]);
  });

  test("pins change no row, section, count, cursor or routing; agents never see them", async () => {
    const { server, client, send } = await setup();
    const a = await send(["Which index?", "", ":::question", "Which search index?", "", "- [ ] Pagefind", "- [ ] Orama", ":::"].join("\n"), "ses_a");
    const before = await list(server);
    const cursor = server.store.cursor();
    await pin(server, a.thread_id, true);
    expect(server.store.cursor()).toBe(cursor);
    expect(server.store.changesSince(cursor)).toEqual([]);
    const after = await list(server);
    const strip = (sections: InboxListSection[]) => sections.map((s) => ({ ...s, threads: s.threads.map(({ pinned_at: _p, ...rest }) => rest) }));
    expect(strip(after.sections)).toEqual(strip(before.sections));
    // The agent's next message still lands in its own thread.
    const next = await send("And the totals?", "ses_a");
    expect(next.thread_id).toBe(a.thread_id);
    // Nothing an agent reads names a pin.
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id: a.thread_id, agent_session: "ses_a" } });
    const listed = await client.callTool({ name: "read_thread", arguments: { agent_session: "ses_a", asked_by: "anyone" } });
    const waited = await client.callTool({ name: "wait_for_reply", arguments: { thread_id: a.thread_id, agent_session: "ses_a", timeout_seconds: 1 } });
    const searched = await client.callTool({ name: "search", arguments: { query: "search index", agent_session: "ses_a" } });
    for (const answer of [read, listed, waited, searched]) expect(JSON.stringify(answer)).not.toMatch(/pinned_at|\\"pins\\"|Pinned/);
    expect(server.store.listRow(a.thread_id)!.pinned_at).toBeUndefined();
  });

  test("kept in inbox/pins.json (0600) across a restart; a deleted thread or project leaves it", async () => {
    const { dataDir, server, send, other, projectOf } = await setup();
    const a = await send("Keep me", "ses_a");
    const b = await send("Delete me", "ses_b");
    const c = await send("In another project", "ses_c", other);
    const cProject = projectOf(c.thread_id);
    for (const t of [a, b, c]) await pin(server, t.thread_id, true);
    const file = join(server.store.dir, "pins.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, pins: [a, b, c].map((t) => ({ thread_id: t.thread_id, pinned_at: expect.any(String) })) });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const again = (await start(dataDir)).server;
    expect(await pinIds(again)).toEqual([a.thread_id, b.thread_id, c.thread_id]);

    expect((await post(again, `/api/inbox/threads/${b.thread_id}/delete`, {})).status).toBe(200);
    expect(await pinIds(again)).toEqual([a.thread_id, c.thread_id]);
    expect((await post(again, `/api/inbox/projects/${cProject}/delete`, {})).status).toBe(200);
    expect(await pinIds(again)).toEqual([a.thread_id]);
    expect(JSON.parse(readFileSync(file, "utf8")).pins.map((p: { thread_id: string }) => p.thread_id)).toEqual([a.thread_id]);
    await pin(again, a.thread_id, false);
    expect(existsSync(file)).toBe(false);
  });

  test("a pin of a thread an older Inbox deleted is dropped at start", async () => {
    const { dataDir, server, send } = await setup();
    const a = await send("Keep me", "ses_a");
    await pin(server, a.thread_id, true);
    const file = join(server.store.dir, "pins.json");
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const gone = "msg_01K70000000000000000000099";
    writeFileSync(file, JSON.stringify({ v: 1, pins: [{ thread_id: gone, pinned_at: "2026-10-24T00:00:00.000Z" }, ...JSON.parse(readFileSync(file, "utf8")).pins] }), { mode: 0o600 });
    const again = (await start(dataDir)).server;
    expect(await pinIds(again)).toEqual([a.thread_id]);
    expect(JSON.parse(readFileSync(file, "utf8")).pins.map((p: { thread_id: string }) => p.thread_id)).toEqual([a.thread_id]);
  });

  test("an archived thread stays pinned, in `pins` whatever the filter; no limit on pins", async () => {
    const { server, send, other, projectOf } = await setup();
    const a = await send("Archived but pinned", "ses_a");
    const c = await send("Another project", "ses_c", other);
    await pin(server, a.thread_id, true);
    await pin(server, c.thread_id, true);
    expect((await post(server, `/api/inbox/messages/${a.thread_id}/resolve`, { resolved: true })).status).toBe(200);
    const model = await list(server);
    expect(model.sections.flatMap((s) => s.threads).some((r) => r.thread_id === a.thread_id)).toBe(false);
    expect(model.pins!.map((r) => r.thread_id)).toEqual([a.thread_id, c.thread_id]);
    expect(model.pins![0]!.resolved_at).not.toBeNull();
    // The project filter leaves Pinned alone.
    const filtered = (await (await fetch(url(server, `/api/inbox/threads?archived=exclude&project=${projectOf(c.thread_id)}`))).json()) as ListModel;
    expect(filtered.pins!.map((r) => r.thread_id)).toEqual([a.thread_id, c.thread_id]);

    // Thirty more: every one pinned.
    const more: string[] = [];
    for (let i = 0; i < 30; i++) more.push((await send(`Thread ${i}`, `ses_m${i}`)).thread_id);
    for (const id of more) expect((await pin(server, id, true)).status).toBe(200);
    expect(await pinIds(server)).toEqual([a.thread_id, c.thread_id, ...more]);
  });

  test("guards: another site is refused, a stale tab is refused, an unknown thread is 404, a bad body is 422", async () => {
    const { server, send } = await setup();
    const a = await send("Pin me", "ses_a");
    const path = `/api/inbox/threads/${a.thread_id}/pin`;
    expect(((await (await post(server, path, { pinned: true }, { Origin: "https://evil.example" })).json()) as Json).code).toBe("cross_origin");
    expect((await post(server, path, { pinned: true }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post(server, "/api/inbox/pins", { order: [a.thread_id] }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const stale = await fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "not-this-one", pinned: true }) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as Json).code).toBe("session_mismatch");
    expect((await pin(server, "msg_01K70000000000000000000099", true)).status).toBe(404);
    // A message that is not a thread's root is not a thread.
    const reply = await send("A second message", "ses_a");
    expect(reply.thread_id).toBe(a.thread_id);
    expect((await pin(server, reply.message_id, true)).status).toBe(404);
    expect((await post(server, path, { pinned: "yes" })).status).toBe(422);
    expect((await post(server, "/api/inbox/pins", { order: "nope" })).status).toBe(422);
    expect((await post(server, "/api/inbox/pins", { order: [a.thread_id, a.thread_id] })).status).toBe(422);
    expect((await post(server, "/api/inbox/pins", { order: ["not-an-id"] })).status).toBe(422);
    expect((await fetch(url(server, path))).status).toBe(405);
    expect(await pinIds(server)).toEqual([]);
    // An order naming a thread that no longer exists, or one not pinned, skips it.
    expect((await post(server, "/api/inbox/pins", { order: ["msg_01K70000000000000000000099", a.thread_id] })).status).toBe(200);
    expect(await pinIds(server)).toEqual([]);
    // A restore: both or neither of order and restore, or a bad restore, is 422; a gone thread is 404.
    const restore = { thread_id: a.thread_id, index: 0, pinned_at: "2026-10-24T00:00:00.000Z" };
    expect((await post(server, "/api/inbox/pins", {})).status).toBe(422);
    expect((await post(server, "/api/inbox/pins", { order: [a.thread_id], restore })).status).toBe(422);
    expect((await post(server, "/api/inbox/pins", { restore: { ...restore, index: -1 } })).status).toBe(422);
    expect((await post(server, "/api/inbox/pins", { restore: { ...restore, pinned_at: "later" } })).status).toBe(422);
    expect((await post(server, "/api/inbox/pins", { restore: { ...restore, thread_id: "msg_01K70000000000000000000099" } })).status).toBe(404);
    expect((await post(server, "/api/inbox/pins", { restore }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect(await pinIds(server)).toEqual([]);
  });

  test("two windows: a move from a window that has not seen another's Unpin never brings the pin back", async () => {
    const { server, send } = await setup();
    const [a, b, c] = [await send("One", "ses_a"), await send("Two", "ses_b"), await send("Three", "ses_c")];
    for (const t of [a, b, c]) await pin(server, t.thread_id, true);
    // Both windows read [a, b, c].
    const tab1 = (await list(server)).pins!.map((r) => r.thread_id);
    const tab2 = (await list(server)).pins!.map((r) => r.thread_id);
    expect(tab1).toEqual(tab2);
    // Window 2 unpins b; window 1, still on its stale read, moves c up (its order still names b).
    expect((await pin(server, b.thread_id, false)).status).toBe(200);
    const stale = [tab1[2]!, tab1[0]!, tab1[1]!];
    expect(stale).toEqual([c.thread_id, a.thread_id, b.thread_id]);
    expect((await post(server, "/api/inbox/pins", { order: stale })).status).toBe(200);
    expect(await pinIds(server)).toEqual([c.thread_id, a.thread_id]);
    // Window 1's Undo of an earlier Unpin of its own restores only its thread, never window 2's.
    const cPinnedAt = (await list(server)).pins![0]!.pinned_at!;
    await pin(server, c.thread_id, false);
    expect((await post(server, "/api/inbox/pins", { restore: { thread_id: c.thread_id, index: 0, pinned_at: cPinnedAt } })).status).toBe(200);
    expect(await pinIds(server)).toEqual([c.thread_id, a.thread_id]);
    expect((await list(server)).pins![0]!.pinned_at).toBe(cPinnedAt);
  });

  test("every open window hears `event: pins`; the phone's stream (no window id) does not", async () => {
    const { server, send } = await setup();
    const a = await send("Pin me", "ses_a");
    const read = async (query: string, act: () => Promise<unknown>) => {
      const controller = new AbortController();
      const stream = await fetch(url(server, `/api/inbox/events?cursor=${server.store.cursor()}${query}`), { signal: controller.signal });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);
      await act();
      const deadline = Date.now() + 1500;
      while (!text.includes("event: pins") && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
        if (chunk && chunk.value) text += decoder.decode(chunk.value);
      }
      controller.abort();
      return text;
    };
    expect(await read("&window=window-pins-1&permission=granted", () => pin(server, a.thread_id, true))).toContain("event: pins\ndata: {}");
    expect(await read("", () => pin(server, a.thread_id, false))).not.toContain("event: pins");
    // A deletion that drops a pin tells the windows too.
    await pin(server, a.thread_id, true);
    expect(await read("&window=window-pins-2&permission=granted", () => post(server, `/api/inbox/threads/${a.thread_id}/delete`, {}))).toContain("event: pins");
  });

  test("a phone reads `pins` with the list through its door; the door has no pin write", async () => {
    const { server, send } = await setup({ phones: true });
    const a = await send("Pin me", "ses_a");
    await pin(server, a.thread_id, true);
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
    const model = (await (await door("threads")).json()) as ListModel;
    expect(model.pins!.map((r) => r.thread_id)).toEqual([a.thread_id]);
    const refused = await door(`threads/${a.thread_id}/pin`, { method: "POST", body: { pinned: false, idempotency_key: "k1" } });
    expect(((await refused.json()) as Json).code).toBe("device_route_not_found");
    const order = await door("pins", { method: "POST", body: { order: [], idempotency_key: "k2" } });
    expect(((await order.json()) as Json).code).toBe("device_route_not_found");
    expect(await pinIds(server)).toEqual([a.thread_id]);
  });

  test("the owner over the tailnet pins like the window; another site through the tailnet is refused", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-pins-tailnet-")));
    roots.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    setEnv("PLANNOTATOR_DATA_DIR", dataDir);
    setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true }));
    const serve = new Map<number, string>();
    const run: TailscaleRunner = (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
      if (args[1] === "status") {
        if (serve.size === 0) return ok("{}");
        return ok(
          JSON.stringify({
            TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
            Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
          }),
        );
      }
      const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) serve.delete(httpsPort);
      else serve.set(httpsPort, args.at(-1)!);
      return ok(`https://${MAGIC}:${httpsPort}/\n`);
    };
    const project = join(root, "docs");
    mkdirSync(project, { recursive: true });
    const { server, client } = await start(dataDir, { phones: false, tailscale: run });
    const sent = (
      (await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: "ses_t", agent_name: "Claude Code", body: "Over the tailnet" } })) as {
        structuredContent: { thread_id: string };
      }
    ).structuredContent;
    const listener = server.tailscale.listenerPort()!;
    const own = { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, Origin: `https://${MAGIC}:${server.port}`, "Content-Type": "application/json" };
    const through = (path: string, headers: Record<string, string>, body: unknown) =>
      fetch(`http://127.0.0.1:${listener}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    expect((await through(`/api/inbox/threads/${sent.thread_id}/pin`, own, { serverSession: server.serverSession, pinned: true })).status).toBe(200);
    expect(await pinIds(server)).toEqual([sent.thread_id]);
    const cross = await through(`/api/inbox/threads/${sent.thread_id}/pin`, { ...own, Origin: "https://evil.example" }, { serverSession: server.serverSession, pinned: false });
    expect(((await cross.json()) as Json).code).toBe("cross_origin");
    expect(await pinIds(server)).toEqual([sent.thread_id]);
  });
});
