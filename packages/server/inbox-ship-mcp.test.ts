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
import type { InboxShipRead } from "@plannotator/core/inbox-ship";
import { isInboxNote, type InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { registerInboxThreadPullsTool, type InboxPullsMcpContext } from "./inbox-mcp-pulls";
import { shipSessionEnded, shipShipper, type InboxShipAgentDeps } from "./inbox-ship-agent";
import { createInboxShipStore } from "./inbox-ship-store";
import { createInboxShipWatch } from "./inbox-ship-watch";

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
  const fake = { registerTool: (_name: string, _config: unknown, run: typeof handler) => (handler = run) } as unknown as McpServer;
  registerInboxThreadPullsTool(fake, context);
  const call = (input: Record<string, unknown>) => handler!(input);
  const notes = () => store.threadMessageIds(thread).map((id) => store.message(id)!).filter((m) => !!m.ship_note);
  return { store, thread, ships, watch, ship, call, notes, deps, live, set: (next: InboxShipRead) => (read = next) };
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

  test("a new session's ship is bound by the first ship call from its thread, whatever session id its agent reports", async () => {
    const w = world(false);
    await settle();
    const first = await w.call({ thread_id: w.thread, ship: { kind: "step", text: "Reviewed the diff" }, agent_session: "ses_reported", agent_host: "claude-code", agent_name: "Claude Code" });
    expect(textOf(first)).toContain("Logged in the ship log of https://github.com/harbor/fern-api/pull/614.");
    expect(w.ships.get(KEY)!.agent.session).toBe("ses_reported");
    // Its notes go to it now.
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    expect(w.notes().map((n) => n.to?.session)).toEqual(["ses_reported"]);
    const late = await w.call({ thread_id: w.thread, ship: { kind: "step", text: "me too" }, agent_session: "ses_ship", agent_host: "claude-code", agent_name: "Claude Code" });
    expect(textOf(late)).toContain("Another session is shipping this pull request; nothing was logged.");
  });
});
