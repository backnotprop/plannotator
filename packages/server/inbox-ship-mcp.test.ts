/**
 * Ship with a real Inbox store (no server): who a note goes to, and the `thread_pulls` `ship` field through the tool's
 * own handler. What regresses here:
 *  - a note or the stop line going to the thread's latest agent instead of the one shipping (a reviewer told to push);
 *  - a Ship note read as the person's reply (the thread's "You", the list's Sent);
 *  - a session that is not shipping writing the ship log, marking it stuck, or hiding a real push behind `told`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { shipStopLine, type InboxShipRead } from "@plannotator/core/inbox-pull-handoff";
import { isInboxNote, type InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { registerInboxThreadPullsTool, type InboxPullsMcpContext } from "./inbox-mcp-pulls";
import { shipSessionEnded, shipShipper, type InboxShipAgentDeps } from "./inbox-ship-agent";
import { createInboxShipStore } from "./inbox-ship-store";
import { createInboxShipWatch } from "./inbox-ship-watch";
import { inboxAgentTool } from "@plannotator/shared/inbox/connection";
import { inboxAgentTool as modAgentTool } from "../../apps/hook/hooks/mod/inbox-contract";
import { INBOX_DEFAULT_TOOLS } from "../../apps/hook/hooks/mod/inbox-default-tools";

const KEY = "github.com/harbor/fern-api#614";
const SHIPPER: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_ship", name: "Claude Code" };
const REVIEWER: InboxAuthor = { kind: "agent", host: "codex", session: "ses_review", name: "Codex" };
const green = (over: Partial<InboxShipRead> = {}): InboxShipRead => ({ state: "open", head_sha: "a".repeat(40), base: "main", checks: "pending", failing: [], review: null, reviewer: null, conflicts: false, behind: false, comments: [], viewer: "ada-novak", merged_at: null, ...over });

type Result = { content: { text: string }[]; isError?: boolean };
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function world(bound = true) {
  const dir = mkdtempSync(join(tmpdir(), "ship-mcp-"));
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "fern-api", root: "/work/fern-api" });
  // The shipping agent wrote first; a reviewer agent wrote last.
  const thread = store.sendMessage({ project_id: project.id, author: SHIPPER, body: "Opened #614.", subject: "Receipts", wakes: true }).message.id;
  store.sendMessage({ project_id: project.id, author: REVIEWER, body: "Reviewed it.", reply_to: thread, wakes: true } as never);
  const ships = createInboxShipStore(dir);
  let read: InboxShipRead = green();
  const live = new Set(["ses_ship", "ses_review"]);
  const deps: InboxShipAgentDeps = { message: (id) => store.message(id), threadMessageIds: (id) => store.threadMessageIds(id), sessionLive: (s) => live.has(s) };
  const watch = createInboxShipWatch({
    ships,
    read: async () => read,
    shipper: (ship) => shipShipper(deps, ship),
    note: (ship, body, kind) => {
      const to = shipShipper(deps, ship);
      if (to) store.tellShip(ship.thread_id, { body, to, ship_note: { ship: ship.id, kind } });
    },
    everyMs: 60 * 60_000,
  });
  closers.push(() => watch.close());
  const ship = watch.start({ key: KEY, platform: "github", url: "https://github.com/harbor/fern-api/pull/614", title: "Receipts", number: 614, repo: "harbor/fern-api", host: "github.com", thread_id: thread, project_id: project.id, agent: { host: "claude-code", session: "ses_ship", name: "Claude Code" }, bound });
  const context: InboxPullsMcpContext = { store, shipStep: (threadId, step, session) => watch.step(threadId, step, session) };
  let handler: ((input: Record<string, unknown>) => Promise<Result>) | null = null;
  let inputSchema: z.ZodType | null = null;
  const fake = {
    registerTool: (_name: string, config: { inputSchema: z.ZodType }, run: typeof handler) => {
      inputSchema = config.inputSchema;
      handler = run;
    },
  } as unknown as McpServer;
  registerInboxThreadPullsTool(fake, context);
  const call = (input: Record<string, unknown>) => handler!(input);
  const notes = () => store.threadMessageIds(thread).map((id) => store.message(id)!).filter((m) => !!m.ship_note);
  return { store, thread, ships, watch, ship, call, schema: () => inputSchema!, notes, deps, live, set: (next: InboxShipRead) => (read = next) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const textOf = (result: Result) => result.content.map((c) => c.text).join("\n");

describe("Ship's notes", () => {
  test("a watch note and the stop line go to the shipping session only, never the thread's latest agent", async () => {
    const w = world();
    await settle();
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    w.watch.stop(w.ship.id);
    const notes = w.notes();
    expect(notes.map((n) => n.ship_note!.kind)).toEqual(["watch", "stop"]);
    for (const note of notes) expect(note.to?.session).toBe("ses_ship");
    expect(w.store.pendingReplies("ses_review").filter((m) => m.ship_note)).toEqual([]);
    expect(w.store.pendingReplies("ses_ship").filter((m) => m.ship_note)).toHaveLength(2);
  });

  test("a Ship note is the Inbox's own notice, never the person's reply", async () => {
    const w = world();
    await settle();
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    const [note] = w.notes();
    expect(note!.author.kind).toBe("person");
    expect(isInboxNote(note!)).toBe(true);
  });

  test("ended reads the shipping session, not the thread's latest agent", () => {
    const w = world();
    // The reviewer (the thread's latest agent) gone: the shipping session is still there.
    w.live.delete("ses_review");
    expect(shipSessionEnded(w.deps, w.ship)).toBe(false);
    // The shipping session gone, the reviewer back: ended.
    w.live.add("ses_review");
    w.live.delete("ses_ship");
    expect(shipSessionEnded(w.deps, w.ship)).toBe(true);
  });
});

describe("thread_pulls ship", () => {
  test("the shipping session's call logs a step; another session's changes nothing and is told another session ships it", async () => {
    const w = world();
    await settle();
    const other = await w.call({ thread_id: w.thread, ship: { kind: "stuck", text: "not mine", sha: "b".repeat(40) }, agent_session: "ses_review", agent_host: "codex", agent_name: "Codex" });
    expect(textOf(other)).toContain("Another session is shipping this pull request; nothing was logged.");
    expect(w.ships.get(KEY)!.state).toBe("shipping");
    expect(w.ships.get(KEY)!.told).toEqual([]);
    expect(w.ships.get(KEY)!.log.map((e) => e.text)).toEqual(["Started"]);
    const own = await w.call({ thread_id: w.thread, ship: { kind: "step", text: "Pushed a fix", sha: "b".repeat(40) }, agent_session: "ses_ship", agent_host: "claude-code", agent_name: "Claude Code" });
    expect(textOf(own)).toContain("Logged in the ship log of https://github.com/harbor/fern-api/pull/614.");
    expect(w.ships.get(KEY)!.log.at(-1)!.text).toBe("Pushed a fix");
    expect(w.ships.get(KEY)!.told).toEqual(["b".repeat(40)]);
  });

  test("a thread that ships nothing says so", async () => {
    const w = world();
    const project = w.store.message(w.thread)!.project_id;
    const elsewhere = w.store.sendMessage({ project_id: project, author: SHIPPER, body: "Another thing.", subject: "Docs", wakes: true }).message.id;
    const result = await w.call({ thread_id: elsewhere, ship: { kind: "step", text: "Pushed" }, agent_session: "ses_ship", agent_host: "claude-code", agent_name: "Claude Code" });
    expect(textOf(result)).toContain("Nothing is shipping in this thread; nothing was logged.");
  });

  test("shipped again to a new session: the first shipper's late call is told to stop and never takes the new ship", async () => {
    const w = world();
    await settle();
    // The person ships it again in the same thread to a new session that has not started yet.
    const again = w.watch.start({ key: KEY, platform: "github", url: w.ship.url, title: "Receipts", number: 614, repo: "harbor/fern-api", host: "github.com", thread_id: w.thread, project_id: w.ship.project_id, agent: { host: "claude-code", session: "launch:lch_new", name: "Claude Code" } });
    const late = await w.call({ thread_id: w.thread, ship: { kind: "step", text: "Pushed a fix", sha: "b".repeat(40) }, agent_session: "ses_ship", agent_host: "claude-code", agent_name: "Claude Code" });
    expect(textOf(late)).toContain(shipStopLine("#614"));
    expect(textOf(late)).not.toContain("Logged in the ship log");
    const now = w.ships.get(KEY)!;
    expect(now.id).toBe(again.id);
    expect(now.agent.session).toBe("launch:lch_new");
    expect(now.told).toEqual([]);
    // The thread's other agent is not told to stop: it was never shipping it.
    const other = await w.call({ thread_id: w.thread, ship: { kind: "step", text: "me?" }, agent_session: "ses_review", agent_host: "codex", agent_name: "Codex" });
    expect(textOf(other)).toContain("Another session is shipping this pull request; nothing was logged.");
  });
});

/** Every `description` anywhere in a JSON Schema value. */
function descriptionsIn(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const own = typeof (value as { description?: unknown }).description === "string" ? [(value as { description: string }).description] : [];
  return [...own, ...Object.values(value).flatMap(descriptionsIn)];
}

// The owner (on #3994's follow-up): "Why would it go here when ship is only activated from the interface?" Every agent
// carries the tool schema on every request, so the `ship` field carries no words there; the ship instruction and
// `--help` teach it. What regresses: words put back on the field (or its members), or the field losing its shape.
describe("thread_pulls ship in the schema every agent carries", () => {
  test("the field and its members carry no description: the Inbox's own schema, and the agent tool on every host", () => {
    const w = world();
    const served = (z.toJSONSchema(w.schema()) as { properties: Record<string, unknown> }).properties.ship;
    expect(served).toBeDefined();
    expect(descriptionsIn(served)).toEqual([]);
    const pulls = INBOX_DEFAULT_TOOLS.find((tool) => tool.name === "thread_pulls")!;
    const bundled = (pulls.inputSchema as { properties: Record<string, unknown> }).properties.ship;
    expect(descriptionsIn(bundled)).toEqual([]);
    for (const tool of [inboxAgentTool(INBOX_DEFAULT_TOOLS)!, modAgentTool(INBOX_DEFAULT_TOOLS)!]) {
      const ship = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties.ship!;
      // Only the tag every field of the flattened tool gets, naming the action that takes it.
      expect(ship.description).toBe("(thread_pulls)");
      expect(descriptionsIn(ship.properties)).toEqual([]);
      expect(ship.required).toEqual(["kind", "text"]);
      expect((ship.properties as Record<string, { enum?: string[] }>).kind!.enum).toEqual(["step", "stuck", "merged"]);
    }
  });

  test("a ship call still validates against the served schema and logs; a wrong kind or an extra key is refused", async () => {
    const w = world();
    await settle();
    const schema = w.schema();
    const base = { thread_id: w.thread, agent_session: "ses_ship", agent_host: "claude-code", agent_name: "Claude Code" };
    expect(schema.safeParse({ ...base, ship: { kind: "shipped", text: "x" } }).success).toBe(false);
    expect(schema.safeParse({ ...base, ship: { kind: "step" } }).success).toBe(false);
    expect(schema.safeParse({ ...base, ship: { kind: "step", text: "x", note: "y" } }).success).toBe(false);
    const parsed = schema.safeParse({ ...base, ship: { kind: "step", text: "Pushed a fix", sha: "c".repeat(40) } });
    expect(parsed.success).toBe(true);
    const result = await w.call(parsed.data as Record<string, unknown>);
    expect(textOf(result)).toContain("Logged in the ship log of https://github.com/harbor/fern-api/pull/614.");
    expect(w.ships.get(KEY)!.log.at(-1)!.text).toBe("Pushed a fix");
  });
});
