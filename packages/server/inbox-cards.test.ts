/**
 * The Board's `card` call and the window's card routes (approval
 * "inbox-board", step 1), through the real doors: a running Inbox, the MCP
 * SDK client, the event stream and the window's routes. The failures these
 * guard: an agent able to pause the person's work (Icebox), a card that lands
 * in another project than the caller's, a call that silently drops a field,
 * card lines missing from the event stream (the one seq counter), and the
 * person's moves not reaching the store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_TEXT_COMPLETE_META_KEY, inboxAgentTool, inboxToolCall, inboxToolResultText, parseInboxToolList } from "@plannotator/shared/inbox/connection";
import { INBOX_CARD_ACTION_ON } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_MCP_TOOLS, INBOX_SERVED_TOOLS } from "./inbox-mcp";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any>; _meta?: Record<string, unknown> };

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-cards-")));
  roots.push(root);
  const project = join(root, "app");
  const other = join(root, "web");
  mkdirSync(project, { recursive: true });
  mkdirSync(other, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-cards-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const agent = { project_path: project, agent_session: "ses_a", agent_host: "claude-code", agent_name: "Claude Code" };
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
  const card = (args: Record<string, unknown>) => call("card", { ...agent, ...args });
  // A card call never makes a project: each folder gets one the way it always does, by a message.
  for (const folder of [project, other]) await call("send_message", { project_path: folder, agent_session: "ses_seed", body: "seed" });
  return { root, project, other, server, base, call, card };
}

// Held back with INBOX_CARD_ACTION_ON: skipped while the Inbox does not serve the card tool.
describe.if(INBOX_CARD_ACTION_ON)("the card tool", () => {
  test("is served, and the agent tool carries it as an action with its fields", async () => {
    const { server } = await world();
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    const tools = parseInboxToolList(JSON.parse(data ? data.slice(5) : text).result);
    expect(tools.map((tool) => tool.name)).toContain("card");
    expect(INBOX_MCP_TOOLS).toContain("card");
    const tool = inboxAgentTool(tools)!;
    const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.action!.enum).toContain("card");
    expect(props.op!.enum).toEqual(["create", "move", "say", "link", "ship", "drop", "list"]);
    expect(props.column!.enum).toContain("icebox");
    // Claude Code passes a tool description up to 2,048 characters.
    expect(tool.description.length).toBeLessThan(2048);
    // The connection fills the session and project, as for every Inbox tool.
    const mapped = inboxToolCall({ action: "card", op: "say", card_id: "crd_x", say: "on it" }, tools, { project_path: "/p", agent_session: "s", agent_host: "pi", agent_name: "Pi" });
    expect(mapped).toEqual({ name: "card", arguments: { op: "say", card_id: "crd_x", say: "on it", project_path: "/p", agent_session: "s", agent_host: "pi", agent_name: "Pi" } });
  });

  test("create, move, say, link, ship and list keep one card current, each in one call, text-complete", async () => {
    const { card, call, project } = await world();
    const sent = await call("send_message", { project_path: project, agent_session: "ses_a", body: "Five options on the real hero.", subject: "Hero scene timers" });
    const threadId = sent.structuredContent.thread_id as string;

    const made = await card({ op: "create", thread_id: threadId, say: "lane started", idempotency_key: "hero-1" });
    expect(made.isError).toBeUndefined();
    expect(made._meta?.[INBOX_TEXT_COMPLETE_META_KEY]).toBe(true);
    const id = made.structuredContent.card.id as string;
    expect(made.structuredContent.card).toMatchObject({ title: "Hero scene timers", column: "asked", said: "lane started", threads: [threadId] });
    expect(made.structuredContent.card.agent).toEqual({ kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" });
    // The connection hands the model the text alone, and it names the card.
    expect(inboxToolResultText(made).text).toContain(id);
    expect(inboxToolResultText(made).text).not.toContain("{");
    expect((await card({ op: "create", thread_id: threadId, idempotency_key: "hero-1" })).structuredContent).toMatchObject({ replayed: true, card: { id } });

    expect((await card({ op: "move", card_id: id, column: "designing", say: "lane running, sheet in ~1 h" })).structuredContent.card).toMatchObject({
      column: "designing",
      said: "lane running, sheet in ~1 h",
    });
    const look = await card({ op: "move", card_id: id, column: "your_look", you: "pick one of five hero options" });
    expect(look.content[0]!.text).toContain('You: "pick one of five hero options"');
    expect((await card({ op: "say", card_id: id, title: "Hero timers, easy to see" })).structuredContent.card.title).toBe("Hero timers, easy to see");
    expect((await card({ op: "move", card_id: id, column: "building", say: "PR open" })).structuredContent.card.you).toBeNull();
    expect((await card({ op: "link", card_id: id, pr: "https://github.com/plannotator/workspaces/pull/1125" })).structuredContent.card.prs).toEqual([
      { ref: "plannotator/workspaces#1125", url: "https://github.com/plannotator/workspaces/pull/1125" },
    ]);
    expect((await card({ op: "ship", card_id: id, say: "live on staging" })).structuredContent.card.column).toBe("shipped");

    const other = await card({ op: "create", title: "Auto-update for users" });
    const mine = await card({ op: "list" });
    // Shipped is left out unless asked for.
    expect(mine.structuredContent.cards.map((c: { id: string }) => c.id)).toEqual([other.structuredContent.card.id]);
    const all = await card({ op: "list", include_resolved: true });
    expect(all.structuredContent.cards.map((c: { id: string }) => c.id)).toEqual([other.structuredContent.card.id, id]);
    expect(inboxToolResultText(all).text).toContain("Shipped");
    // Another session's list: its own cards only, unless it asks for anyone's.
    expect((await card({ op: "list", agent_session: "ses_b" })).structuredContent.cards).toEqual([]);
    expect((await card({ op: "list", agent_session: "ses_b", asked_by: "anyone" })).structuredContent.total).toBe(1);
  });

  test("refusals: the Icebox by an agent, a bad column, a field the op does not take, a card or thread in another project", async () => {
    const { card, call, other } = await world();
    const id = (await card({ op: "create", title: "Triage #1786", column: "designing" })).structuredContent.card.id as string;

    const iced = await card({ op: "move", card_id: id, column: "icebox" });
    expect(iced.isError).toBe(true);
    expect(iced.content[0]!.text).toStartWith("card_icebox_person_only: Only the person puts a card in the Icebox");
    expect((await card({ op: "create", title: "x", column: "icebox" })).content[0]!.text).toStartWith("card_icebox_person_only:");

    const bad = await card({ op: "move", card_id: id, column: "later" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("column");

    expect((await card({ op: "say", card_id: id, say: "x", column: "building" })).content[0]!.text).toStartWith("validation_error: column: op say does not take it");
    expect((await card({ op: "move", card_id: id })).content[0]!.text).toStartWith("validation_error: column:");
    expect((await card({ op: "drop", card_id: id })).content[0]!.text).toStartWith("validation_error: reason:");
    expect((await card({ op: "move", card_id: id, column: "your_review" })).content[0]!.text).toStartWith("validation_error: you:");

    // A card of another project: refused, naming where it is; that project's path reaches it.
    const elsewhere = await card({ op: "say", card_id: id, say: "x", project_path: other });
    expect(elsewhere.content[0]!.text).toStartWith("card_other_project: Card");
    const root = elsewhere.content[0]!.text.match(/project_path (\S+) to change it/)![1];
    expect((await card({ op: "say", card_id: id, say: "here", project_path: root })).isError).toBeUndefined();
    const there = await call("send_message", { project_path: other, agent_session: "ses_a", body: "web work" });
    expect((await card({ op: "link", card_id: id, thread_id: there.structuredContent.thread_id })).content[0]!.text).toStartWith("card_other_project: Thread");
    expect((await card({ op: "create", thread_id: there.structuredContent.thread_id })).content[0]!.text).toStartWith("card_other_project: Thread");
    expect((await card({ op: "say", card_id: "crd_00000000000000000000000000", say: "x" })).content[0]!.text).toStartWith("card_not_found:");

    // The drop an agent makes carries its reason; the card is kept.
    const dropped = await card({ op: "drop", card_id: id, reason: "folded into #1787" });
    expect(dropped.structuredContent.card).toMatchObject({ column: "dropped", dropped: { reason: "folded into #1787" } });
  });
});

// Held back with INBOX_CARD_ACTION_ON: skipped while the Inbox does not serve the card tool.
describe.if(INBOX_CARD_ACTION_ON)("a card call writes no project, and tolerates a false default", () => {
  test("list from a folder the Inbox has never seen answers no cards; create refuses; neither makes a project", async () => {
    const { root, base, card } = await world();
    const unseen = join(root, "unseen");
    mkdirSync(unseen);
    const projects = async () => ((await (await fetch(`${base}/api/inbox/projects`)).json()) as { projects: unknown[] }).projects.length;
    const before = await projects();
    const listed = await card({ op: "list", project_path: unseen });
    expect(listed.isError).toBeUndefined();
    expect(listed.structuredContent).toEqual({ project: null, cards: [], total: 0 });
    const made = await card({ op: "create", title: "Somewhere new", project_path: unseen });
    expect(made.content[0]!.text).toStartWith("card_no_project:");
    expect(await projects()).toBe(before);
    expect(readdirSync(join(root, "data", "inbox", "projects"))).toHaveLength(before);
  });

  test("a field an op does not take is refused, but its `false` default is not", async () => {
    const { card } = await world();
    const id = (await card({ op: "create", title: "Defaults" })).structuredContent.card.id as string;
    expect((await card({ op: "move", card_id: id, column: "designing", include_resolved: false })).isError).toBeUndefined();
    expect((await card({ op: "move", card_id: id, column: "building", include_resolved: true })).content[0]!.text).toStartWith("validation_error: include_resolved: op move does not take it");
  });
});

// Served whether or not the agents' card action is on: the person's routes and the stream.
describe("the window's card routes and the event stream", () => {
  test("GET filters by project and column; POST is the person's move, icebox, drop and restore; an agent's drop waits until the person sees Dropped; card lines reach the stream", async () => {
    const { base, server, project, other } = await world();
    const { store } = server;
    const here = store.projectByRoot(project)!;
    const there = store.projectByRoot(other)!;
    const agent = { kind: "agent" as const, host: "claude-code", session: "ses_a", name: "Claude Code" };
    const a = store.createCard({ project_id: here.id, by: agent, title: "Pricing page", column: "building" }).card;
    const b = store.createCard({ project_id: here.id, by: agent, title: "Solutions page" }).card;
    const c = store.createCard({ project_id: there.id, by: agent, title: "Web thing" }).card;

    const cursor = ((await (await fetch(`${base}/api/inbox/threads`)).json()) as { cursor: number }).cursor;
    const all = (await (await fetch(`${base}/api/inbox/cards`)).json()) as { cards: Record<string, unknown>[]; dropped_unseen: number };
    expect(all.cards).toHaveLength(3);
    expect(all.dropped_unseen).toBe(0);
    // No derived stall flag on the wire: the card's age is its heard_at.
    for (const card of all.cards) expect(Object.keys(card)).not.toContain("amber");
    const building = (await (await fetch(`${base}/api/inbox/cards?project=${here.id}&column=building,your_review`)).json()) as { cards: { id: string }[] };
    expect(building.cards.map((card) => card.id)).toEqual([a.id]);
    expect((await fetch(`${base}/api/inbox/cards?column=later`)).status).toBe(422);
    expect((await fetch(`${base}/api/inbox/cards?project=prj_00000000000000000000000000`)).status).toBe(404);

    const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const iced = await post(`/api/inbox/cards/${b.id}`, { op: "icebox" });
    expect(iced.status).toBe(200);
    expect(((await iced.json()) as { card: object }).card).toMatchObject({ column: "icebox", aside_from: "asked" });
    // The agent cannot bring it back; the person can.
    expect(() => store.updateCard(b.id, { by: agent, column: "designing" })).toThrow();
    expect(((await (await post(`/api/inbox/cards/${b.id}`, { op: "restore" })).json()) as { card: { column: string } }).card.column).toBe("asked");
    expect(((await (await post(`/api/inbox/cards/${a.id}`, { op: "drop", reason: "not now" })).json()) as { card: { dropped: object } }).card.dropped).toMatchObject({ reason: "not now" });
    expect(((await (await post(`/api/inbox/cards/${a.id}`, { op: "move", column: "your_review" })).json()) as { card: { column: string } }).card.column).toBe("your_review");

    // An agent's drop waits for the person: counted, by project, until they look at Dropped.
    store.updateCard(b.id, { by: agent, column: "dropped", reason: "folded into the pricing work" });
    store.updateCard(c.id, { by: agent, column: "dropped", reason: "moot" });
    const unseen = (await (await fetch(`${base}/api/inbox/cards`)).json()) as { dropped_unseen: number };
    expect(unseen.dropped_unseen).toBe(2);
    expect(((await (await fetch(`${base}/api/inbox/cards?project=${here.id}`)).json()) as { dropped_unseen: number }).dropped_unseen).toBe(1);
    const looked = (await (await post("/api/inbox/cards/dropped/seen", { project: here.id, cards: [b.id, c.id] })).json()) as { cards: { id: string; dropped: { seen_at: string | null } }[] };
    expect(looked.cards.map((card) => card.id)).toEqual([b.id]);
    expect(looked.cards[0]!.dropped.seen_at).not.toBeNull();
    expect(((await (await fetch(`${base}/api/inbox/cards`)).json()) as { dropped_unseen: number }).dropped_unseen).toBe(1);
    // `cards` is required: a call that names no cards marks nothing.
    expect((await post("/api/inbox/cards/dropped/seen", {})).status).toBe(422);
    expect(((await (await fetch(`${base}/api/inbox/cards`)).json()) as { dropped_unseen: number }).dropped_unseen).toBe(1);
    expect(((await (await post("/api/inbox/cards/dropped/seen", { cards: [c.id] })).json()) as { cards: { id: string }[] }).cards.map((card) => card.id)).toEqual([c.id]);
    expect((await post("/api/inbox/cards/dropped/seen", { project: "nope", cards: [] })).status).toBe(422);
    expect((await fetch(`${base}/api/inbox/cards/dropped/seen`)).status).toBe(405);

    // Guards: a bad op, an unknown card, another site, a stale tab.
    expect((await post(`/api/inbox/cards/${a.id}`, { op: "fly" })).status).toBe(422);
    expect((await post("/api/inbox/cards/crd_00000000000000000000000000", { op: "icebox" })).status).toBe(404);
    expect((await post("/api/inbox/cards/nope", { op: "icebox" })).status).toBe(422);
    expect((await post(`/api/inbox/cards/${a.id}`, { op: "icebox" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post(`/api/inbox/cards/${a.id}`, { op: "icebox", serverSession: "another-session" })).status).toBe(409);
    expect((await post("/api/inbox/cards/dropped/seen", { serverSession: "another-session", cards: [] })).status).toBe(409);
    expect((await fetch(`${base}/api/inbox/cards`, { method: "POST" })).status).toBe(405);

    // The event stream carries the card lines after the cursor, on the one counter.
    // A replay gives each record's current line once: a, b and c all changed after the cursor.
    const controller = new AbortController();
    const response = await fetch(`${base}/api/inbox/events?cursor=${cursor}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while ((text.match(/"kind":"card"/g) ?? []).length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    const events = [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!)).filter((event) => event.kind === "card");
    expect(events.map((event) => event.id).sort()).toEqual([a.id, b.id, c.id].sort());
    for (const event of events) {
      expect(event.seq).toBeGreaterThan(cursor);
      expect(event.card.id).toBe(event.id);
    }
  });
});

// The action held back: the Inbox does not serve the card tool, and a card call says so.
describe.if(!INBOX_CARD_ACTION_ON)("the card action held back", () => {
  test("the tool is not served, so a call is refused as an unknown tool", async () => {
    const { server, card } = await world();
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await response.text()).not.toContain('"name":"card"');
    expect(INBOX_SERVED_TOOLS).not.toContain("card");
    expect((await card({ op: "list" }).catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }))).isError).toBe(true);
  });
});
