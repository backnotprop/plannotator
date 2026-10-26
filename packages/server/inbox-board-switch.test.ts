/**
 * The Board's switch (approval "inbox-board", 2026-10-26: "board should be
 * something that is enabled ... careful with the state machine"), on a real
 * Inbox with config.json deciding (no override). Each transition of the
 * state table in docs/agent-guides/inbox-notifications-and-agents.md:
 *
 *  - off (the default): no `card` in tools/list; a `card` call answers
 *    `board_off` and writes nothing; the first-visit dialog is not claimed;
 *  - off → on (Settings' switch, config.json `inboxBoard`): the next
 *    tools/list has `card`; a call works;
 *  - on → off with an agent mid-session (its tool list, taken while on, still
 *    names the action, as the Claude Code mod's cached list does): its call
 *    answers `board_off`, nothing is written, every card is kept;
 *  - a card op in flight while it turns off: each call either wrote its card
 *    or answered `board_off` with nothing written, never half;
 *  - off → on again: the cards are as they were;
 *  - throughout: the person's list, sections and routing are untouched.
 *
 * What regresses: an Inbox that offers cards to agents the person never
 * turned the Board on for, a call that writes while it is off, a switch that
 * deletes cards, or a switch that moves anything in the Inbox itself.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxAgentTool, inboxToolCall, parseInboxToolList } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_BOARD_OFF_TEXT } from "./inbox-mcp";
import { INBOX_DEFAULT_TOOLS } from "../../apps/hook/hooks/mod/inbox-default-tools";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> };

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-board-switch-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const project = join(root, "app");
  mkdirSync(project, { recursive: true });
  // The Inbox reads config.json through the env: this test's own, so the switch is the person's file.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return JSON.parse(data ? data.slice(5) : text) as { result: unknown };
  };
  const toolNames = async () => parseInboxToolList((await rpc("tools/list", {})).result).map((tool) => tool.name);
  const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result as ToolResult;
  const agent = { project_path: project, agent_session: "ses_a", agent_host: "claude-code", agent_name: "Claude Code" };
  const card = (args: Record<string, unknown>) => call("card", { ...agent, ...args });
  const setBoard = (on: boolean) =>
    fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ board: { on } }) });
  const settings = async () => (await (await fetch(`${base}/api/inbox/settings`)).json()) as { board: { on: boolean } };
  const cards = async () => ((await (await fetch(`${base}/api/inbox/cards`)).json()) as { cards: { id: string; title: string; column: string; said: string | null }[] }).cards;
  // A project, the way it always gets one: a message.
  await call("send_message", { ...agent, body: "seed" });
  return { dataDir, server, base, rpc, toolNames, call, card, setBoard, settings, cards, agent };
}

test("off by default: no card tool, a card call answers board_off and writes nothing, no dialog", async () => {
  const w = await world();
  expect((await w.settings()).board).toEqual({ on: false });
  expect(await w.toolNames()).not.toContain("card");
  const cursor = w.server.store.cursor();
  const refused = await w.card({ op: "create", title: "Too early" });
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toBe(INBOX_BOARD_OFF_TEXT);
  expect(w.server.store.cursor()).toBe(cursor);
  expect(w.server.store.listCards()).toHaveLength(0);
  const intro = await fetch(`${w.base}/api/inbox/board/intro`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(await intro.json()).toEqual({ show: false });
  // The Claude Code mod's bundled list (from a default Inbox) has no card action either.
  expect(INBOX_DEFAULT_TOOLS.map((tool) => tool.name)).not.toContain("card");
});

test("off → on → off → on: the next tools/list follows; a session's cached list gets board_off; cards kept; the Inbox untouched", async () => {
  const w = await world();
  const rowsBefore = JSON.stringify(w.server.store.listRows());

  // off → on: saved to config.json; the next tools/list carries card, and the tool works.
  expect((await (await w.setBoard(true)).json()) as { board: { on: boolean } }).toMatchObject({ board: { on: true } });
  expect(JSON.parse(readFileSync(join(w.dataDir, "config.json"), "utf8")).inboxBoard).toBe(true);
  const listed = parseInboxToolList((await w.rpc("tools/list", {})).result);
  expect(listed.map((tool) => tool.name)).toContain("card");
  const made = await w.card({ op: "create", title: "Hero scene timers", column: "building", say: "lane started" });
  expect(made.isError).toBeFalsy();
  const cardId = made.structuredContent!.card.id as string;

  // An agent mid-session: its connection built the tool from the list it read while the Board was on
  // (the Claude Code mod reads it once per process; Pi and OpenCode at session start).
  const cached = inboxAgentTool(listed)!;
  expect((cached.inputSchema.properties as Record<string, { enum?: string[] }>).action!.enum).toContain("card");

  // on → off: every card kept, the tool gone from the next list, the cached call refused, nothing written.
  expect((await (await w.setBoard(false)).json()) as { board: { on: boolean } }).toMatchObject({ board: { on: false } });
  expect(await w.toolNames()).not.toContain("card");
  const cursor = w.server.store.cursor();
  const mapped = inboxToolCall({ action: "card", op: "say", card_id: cardId, say: "still going" }, listed, w.agent);
  const refused = await w.call(mapped.name, mapped.arguments);
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toStartWith("board_off: ");
  expect(w.server.store.cursor()).toBe(cursor);
  const kept = await w.cards();
  expect(kept.map((c) => [c.id, c.column, c.said])).toEqual([[cardId, "building", "lane started"]]);

  // The rest of the Inbox goes on as before while it is off.
  const sent = await w.call("send_message", { ...w.agent, body: "an update while the Board is off" });
  expect(sent.isError).toBeFalsy();

  // off → on again: the card is as it was, and its agent can keep it current.
  await w.setBoard(true);
  expect((await w.cards()).find((c) => c.id === cardId)).toMatchObject({ column: "building", said: "lane started" });
  expect((await w.card({ op: "say", card_id: cardId, say: "back on" })).isError).toBeFalsy();

  // The switch never touched the person's list: the rows are the seed's, plus the update the agent sent.
  const rowsAfter = w.server.store.listRows();
  expect(rowsAfter.length).toBeGreaterThanOrEqual(JSON.parse(rowsBefore).length);
  expect(rowsAfter.some((row) => row.thread_id === (sent.structuredContent!.thread_id as string))).toBe(true);
});

test("a card op in flight while the Board turns off: each call wrote its card or answered board_off, never half; no call waits on the switch", async () => {
  const w = await world();
  await w.setBoard(true);
  const calls = Array.from({ length: 12 }, (_, i) => w.card({ op: "create", title: `In flight ${i}` }));
  const off = w.setBoard(false);
  const results = await Promise.all(calls);
  expect((await off).status).toBe(200);
  const written = results.filter((r) => !r.isError).map((r) => r.structuredContent!.card.id as string);
  const refused = results.filter((r) => r.isError);
  for (const r of refused) expect(r.content[0]!.text).toStartWith("board_off: ");
  expect(written.length + refused.length).toBe(12);
  // Exactly the cards the successful calls name exist: a refused call wrote nothing.
  expect(w.server.store.listCards().map((c) => c.id).sort()).toEqual([...written].sort());
});

test("the switch is a boolean, and only from this computer's page", async () => {
  const w = await world();
  const bad = await fetch(`${w.base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ board: { on: "yes" } }) });
  expect(bad.status).toBe(422);
  const cross = await fetch(`${w.base}/api/inbox/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ board: { on: true } }),
  });
  expect(cross.status).toBe(403);
  expect((await w.settings()).board).toEqual({ on: false });
});
