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
  const server = await startInboxServer({ dataDir: join(root, "data"), phones: false, board: true });
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
    expect(made.structuredContent.card).toMatchObject({ title: "Hero scene timers", column: "backlog", said: "lane started", threads: [threadId] });
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
    // `ref` links an issue (or a PR) from any supported source; the card's refs carry both, prs only the PR.
    const linked = (await card({ op: "link", card_id: id, ref: "plannotator/workspaces#1130" })).structuredContent.card;
    expect(linked.refs).toEqual([
      { kind: "pr", source: "github", ref: "plannotator/workspaces#1125", url: "https://github.com/plannotator/workspaces/pull/1125" },
      { kind: "issue", source: "github", ref: "plannotator/workspaces#1130", url: "https://github.com/plannotator/workspaces/issues/1130" },
    ]);
    expect(linked.prs).toHaveLength(1);
    expect((await card({ op: "link", card_id: id, ref: "https://gitlab.com/g/p/-/issues/4" })).structuredContent.card.refs.at(-1)).toMatchObject({ kind: "issue", source: "gitlab", ref: "g/p#4" });
    expect((await card({ op: "link", card_id: id, ref: "https://github.com-evil.example/o/r/issues/1" })).content[0]!.text).toStartWith("validation_error: ref:");
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

  test("`asked`, the old name of Backlog, is still taken (the schema lists it) and lands in Backlog", async () => {
    const { card } = await world();
    const made = await card({ op: "create", title: "Old words", column: "building", say: "begun" });
    expect(made.isError).toBeFalsy();
    const id = made.structuredContent.card.id as string;
    const moved = await card({ op: "move", card_id: id, column: "asked" });
    expect(moved.isError).toBeFalsy();
    expect(moved.structuredContent.card.column).toBe("backlog");
    const created = await card({ op: "create", title: "Asked first", column: "asked" });
    expect(created.structuredContent.card.column).toBe("backlog");
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
    expect(((await iced.json()) as { card: object }).card).toMatchObject({ column: "icebox", aside_from: "backlog" });
    // The agent cannot bring it back; the person can.
    expect(() => store.updateCard(b.id, { by: agent, column: "designing" })).toThrow();
    expect(((await (await post(`/api/inbox/cards/${b.id}`, { op: "restore" })).json()) as { card: { column: string } }).card.column).toBe("backlog");
    expect(((await (await post(`/api/inbox/cards/${a.id}`, { op: "drop", reason: "not now" })).json()) as { card: { dropped: object } }).card.dropped).toMatchObject({ reason: "not now" });
    expect(((await (await post(`/api/inbox/cards/${a.id}`, { op: "move", column: "your_review" })).json()) as { card: { column: string } }).card.column).toBe("your_review");

    // An agent's drop waits for the person: counted, by project, until they look at Dropped.
    store.updateCard(b.id, { by: agent, column: "dropped", reason: "folded into the pricing work" });
    store.updateCard(c.id, { by: agent, column: "dropped", reason: "moot" });
    const unseen = (await (await fetch(`${base}/api/inbox/cards`)).json()) as { dropped_unseen: number };
    expect(unseen.dropped_unseen).toBe(2);
    expect(((await (await fetch(`${base}/api/inbox/cards?project=${here.id}`)).json()) as { dropped_unseen: number }).dropped_unseen).toBe(1);
    // Only the drops the window names are marked: one it did not show (c) stays unseen even in scope.
    const looked = (await (await post("/api/inbox/cards/dropped/seen", { project: here.id, cards: [b.id, c.id] })).json()) as { cards: { id: string; dropped: { seen_at: string | null } }[] };
    expect(looked.cards.map((card) => card.id)).toEqual([b.id]);
    expect(looked.cards[0]!.dropped.seen_at).not.toBeNull();
    expect(((await (await fetch(`${base}/api/inbox/cards`)).json()) as { dropped_unseen: number }).dropped_unseen).toBe(1);
    expect(((await (await post("/api/inbox/cards/dropped/seen", { cards: [] })).json()) as { cards: { id: string }[] }).cards).toEqual([]);
    expect(((await (await fetch(`${base}/api/inbox/cards`)).json()) as { dropped_unseen: number }).dropped_unseen).toBe(1);
    expect(((await (await post("/api/inbox/cards/dropped/seen", { cards: [c.id] })).json()) as { cards: { id: string }[] }).cards.map((card) => card.id)).toEqual([c.id]);
    expect((await post("/api/inbox/cards/dropped/seen", { project: "nope", cards: [] })).status).toBe(422);
    expect((await post("/api/inbox/cards/dropped/seen", {})).status).toBe(422);
    expect((await post("/api/inbox/cards/dropped/seen", { cards: ["nope"] })).status).toBe(422);
    expect((await fetch(`${base}/api/inbox/cards/dropped/seen`)).status).toBe(405);

    // Guards: a bad op, an unknown card, another site, a stale tab.
    expect((await post(`/api/inbox/cards/${a.id}`, { op: "fly" })).status).toBe(422);
    expect((await post("/api/inbox/cards/crd_00000000000000000000000000", { op: "icebox" })).status).toBe(404);
    expect((await post("/api/inbox/cards/nope", { op: "icebox" })).status).toBe(422);
    expect((await post(`/api/inbox/cards/${a.id}`, { op: "icebox" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post(`/api/inbox/cards/${a.id}`, { op: "icebox", serverSession: "another-session" })).status).toBe(409);
    expect((await post("/api/inbox/cards/dropped/seen", { serverSession: "another-session", cards: [] })).status).toBe(409);
    expect((await fetch(`${base}/api/inbox/cards`, { method: "PUT" })).status).toBe(405);

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

// Step 2's routes: the person's New card and their look at the Board.
describe("the Board page's routes: New card and the look", () => {
  test("New card lands in Backlog as the person's (no agent); the look never goes back; an agent's later write is past it and the person's is not", async () => {
    const { base, server, project } = await world();
    const { store } = server;
    const here = store.projectByRoot(project)!;
    const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

    const made = await post("/api/inbox/cards", { project: here.id, title: "  Try   a dark sidebar " });
    expect(made.status).toBe(200);
    const card = ((await made.json()) as { card: { id: string; column: string; agent: unknown; created_by: { kind: string }; title: string } }).card;
    expect(card).toMatchObject({ column: "backlog", agent: null, created_by: { kind: "person" }, title: "Try a dark sidebar" });
    expect((await post("/api/inbox/cards", { project: here.id, title: "" })).status).toBe(422);
    expect((await post("/api/inbox/cards", { project: "prj_00000000000000000000000000", title: "x" })).status).toBe(404);
    expect((await post("/api/inbox/cards", { title: "x" })).status).toBe(422);
    expect((await post("/api/inbox/cards", { project: here.id, title: "x" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post("/api/inbox/cards", { project: here.id, title: "x", serverSession: "another-session" })).status).toBe(409);

    type Read = { cursor: number; seen_seq: number | null; cards: { id: string; heard_seq: number }[] };
    const read = async () => (await (await fetch(`${base}/api/inbox/cards`)).json()) as Read;
    const first = await read();
    expect(first.seen_seq).toBeNull();
    expect(first.cards[0]!.heard_seq).toBeLessThanOrEqual(first.cursor);
    const seen = async (through_seq: unknown) => ((await (await post("/api/inbox/cards/seen", { through_seq })).json()) as { seen_seq: number }).seen_seq;
    // A look from the future (or a page that lies) never runs ahead of the store: it stops at the cursor.
    expect(await seen(999_999)).toBe(first.cursor);
    // An older look (another tab that read earlier) never moves it back.
    expect(await seen(0)).toBe(first.cursor);
    expect((await read()).seen_seq).toBe(first.cursor);
    expect((await post("/api/inbox/cards/seen", { through_seq: "2099-01-01T00:00:00.000Z" })).status).toBe(422);
    expect((await post("/api/inbox/cards/seen", { through_seq: -1 })).status).toBe(422);
    expect((await post("/api/inbox/cards/seen", { through_seq: 1, serverSession: "another-session" })).status).toBe(409);
    expect((await fetch(`${base}/api/inbox/cards/seen`)).status).toBe(405);
    // The look outlives a restart (inbox/board.json), outside the event log.
    expect(readdirSync(join(server.store.dir))).toContain("board.json");

    // Two agent writes in one millisecond after the look: both are later lines, so both are news.
    const agent = { kind: "agent", host: "codex", session: "s", name: "Codex" } as const;
    const a = store.createCard({ project_id: here.id, by: agent, title: "Same ms A" }).card;
    const b = store.createCard({ project_id: here.id, by: agent, title: "Same ms B" }).card;
    const after = await read();
    const look = after.seen_seq!;
    for (const id of [a.id, b.id]) expect(after.cards.find((c) => c.id === id)!.heard_seq).toBeGreaterThan(look);
    // The person seeing a drop is not a write: the card's heard_seq stays.
    store.updateCard(a.id, { by: agent, column: "dropped", reason: "superseded" });
    const dropped = (await read()).cards.find((c) => c.id === a.id)!.heard_seq;
    expect((await post("/api/inbox/cards/dropped/seen", { cards: [a.id] })).status).toBe(200);
    expect((await read()).cards.find((c) => c.id === a.id)!.heard_seq).toBe(dropped);
  });

  test("another site cannot read the Board, a card or its links (cards carry the person's notes)", async () => {
    const { base, server, project } = await world();
    const here = server.store.projectByRoot(project)!;
    const { card } = server.store.createCard({ project_id: here.id, by: { kind: "person" }, title: "Private", notes: "secret" });
    for (const path of ["/api/inbox/cards", `/api/inbox/cards/${card.id}`, `/api/inbox/cards/${card.id}/refs`]) {
      expect((await fetch(`${base}${path}`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
      expect((await fetch(`${base}${path}`, { headers: { "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
      expect((await fetch(`${base}${path}`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(`${base}${path}`)).status).toBe(200);
    }
  });

  test("New card sent with a thread that is not the person's leaves no card; a retry with the same key replays", async () => {
    const { base, server, project, call } = await world();
    const here = server.store.projectByRoot(project)!;
    const post = (body: Record<string, unknown>) => fetch(`${base}/api/inbox/cards`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const agents = await call("send_message", { project_path: project, agent_session: "ses_x", body: "an agent's thread" });
    const before = server.store.listCards().length;
    const refused = await post({ title: "Sent wrongly", thread_id: agents.structuredContent.message_id ?? agents.structuredContent.thread_id, idempotency_key: "k-wrong" });
    expect(refused.status).toBe(422);
    expect(server.store.listCards().length).toBe(before);
    // The same key again is refused the same way: nothing was made under it.
    expect((await post({ title: "Sent wrongly", thread_id: agents.structuredContent.message_id ?? agents.structuredContent.thread_id, idempotency_key: "k-wrong" })).status).toBe(422);
    expect(server.store.listCards().length).toBe(before);
    // A person's thread to a session: one card, sent; the same key replays it, sent, never a second.
    const started = server.store.startPersonThread({ project_id: here.id, body: "Retry budget", to: { host: "codex", session: "ses_c" }, idempotency_key: "m1" });
    const ok = (await (await post({ title: "Retry budget", thread_id: started.message.id, idempotency_key: "k-ok" })).json()) as { card: { id: string; sent: unknown }; replayed: boolean };
    expect(ok.card.sent).not.toBeNull();
    const again = (await (await post({ title: "Retry budget", thread_id: started.message.id, idempotency_key: "k-ok" })).json()) as { card: { id: string }; replayed: boolean };
    expect(again).toMatchObject({ card: { id: ok.card.id }, replayed: true });
    expect(server.store.listCards().filter((c) => c.title === "Retry budget")).toHaveLength(1);
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
