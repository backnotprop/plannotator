/**
 * Grid off adds nothing to the list (approval "inbox-agent-grid"; its switch is off by default): on a running Inbox,
 * a list read has no `now`, no row carries `grid_seen`, `steps_progress` or `pulls.items`, whether or not it asks
 * `grid=1`, and the answer is the one a read that never heard of Grid gets. With Grid on, only a read that asks gets
 * Grid's fields. What regresses if this fails: everyone's list (window, phone, linked machines) grows and redraws
 * for a page they never turned on. Every test runs under its own temp data dir.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const envBefore = { data: process.env.PLANNOTATOR_DATA_DIR, experimental: process.env.PLANNOTATOR_EXPERIMENTAL };

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (envBefore.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = envBefore.data;
  if (envBefore.experimental === undefined) delete process.env.PLANNOTATOR_EXPERIMENTAL;
  else process.env.PLANNOTATOR_EXPERIMENTAL = envBefore.experimental;
});

type Answer = Record<string, unknown> & { sections: { threads: Record<string, unknown>[] }[] };
const rowsOf = (answer: Answer) => answer.sections.flatMap((section) => section.threads);

test("Grid off: no list read carries anything of Grid, asked or not; on, only a read that asks does", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-grid-off-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_EXPERIMENTAL;
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir, binaryPath: null });
  servers.push(server);
  const client = new Client({ name: "inbox-grid-off-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const sent = (await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: "ses_a", agent_host: "claude-code", agent_name: "Claude Code", body: "Started the export." } })).structuredContent as { thread_id: string };
  // A look kept for the thread (a window with Grid on elsewhere sent it).
  const look = await fetch(`${base}/api/inbox/grid/seen`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seen: [{ thread: sent.thread_id, through: 1, at: 1 }] }) });
  expect(look.status).toBe(200);

  const list = async (query: string) => (await (await fetch(`${base}/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1${query}`)).json()) as Answer;
  const nothingOfGrid = (answer: Answer) => {
    expect("now" in answer).toBe(false);
    expect(rowsOf(answer).length).toBe(1);
    for (const row of rowsOf(answer)) {
      expect("grid_seen" in row).toBe(false);
      expect("steps_progress" in row).toBe(false);
      expect((row.pulls as { items?: unknown } | undefined)?.items).toBeUndefined();
    }
    for (const machine of (answer.machines as Record<string, unknown>[] | undefined) ?? []) expect("clock_ms" in machine).toBe(false);
  };
  const plain = await list("");
  const asked = await list("&grid=1");
  nothingOfGrid(plain);
  nothingOfGrid(asked);
  // The same answer as a read that never asked: the same keys, the same rows.
  expect(Object.keys(asked).sort()).toEqual(Object.keys(plain).sort());
  expect(JSON.stringify(rowsOf(asked))).toBe(JSON.stringify(rowsOf(plain)));

  process.env.PLANNOTATOR_EXPERIMENTAL = "grid";
  nothingOfGrid(await list(""));
  const grid = await list("&grid=1");
  expect(typeof grid.now).toBe("string");
  expect(rowsOf(grid)[0]!.grid_seen).toEqual({ through: 1, at: 1 });
});
