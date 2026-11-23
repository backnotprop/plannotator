/**
 * The canvas on a running Inbox (Settings → Capabilities → Canvas, config.json `inboxCanvas`, off by default):
 * off, every canvas route refuses as Code review's do, the agent's tools/list has no `canvas` and a call to it is
 * refused in words; turned on, a new session lists it and the routes answer. Pure parts: inbox-canvas-switch.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-canvas-cap-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The Inbox reads config.json through the env: this test's own, so the switch is the person's file.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const session = async () => {
    const client = new Client({ name: "inbox-canvas-capability-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    clients.push(client);
    return client;
  };
  const settings = (body: unknown) => fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const read = async () => ((await (await fetch(`${base}/api/inbox/settings`)).json()) as { canvas?: { on: boolean } }).canvas;
  return { dataDir, base, session, settings, read };
}

describe("the canvas switch on a running Inbox", () => {
  test("off by default: the canvas routes refuse, the tool is not listed, and a call to it is refused in words", async () => {
    const w = await world();
    expect(await w.read()).toEqual({ on: false });
    for (const path of ["/api/inbox/canvases", "/api/inbox/threads/msg_A1/canvas"]) {
      const answer = await fetch(`${w.base}${path}`);
      expect([path, answer.status]).toEqual([path, 409]);
      expect(((await answer.json()) as { code: string }).code).toBe("canvas_off");
    }
    const client = await w.session();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("canvas");
    expect(names).toContain("thread_pulls");
    const called = (await client.callTool({ name: "canvas", arguments: { thread_id: "msg_A1" } })) as { isError?: boolean; content: { text: string }[] };
    expect(called.isError).toBe(true);
    expect(called.content[0]!.text.startsWith("canvas_off: ")).toBe(true);
  });

  test("turned on: saved in config.json, a new session lists the tool after thread_pulls, and the routes answer; a malformed switch is refused", async () => {
    const w = await world();
    const on = await w.settings({ canvas: { on: true } });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { canvas: unknown }).canvas).toEqual({ on: true });
    expect(JSON.parse(readFileSync(join(w.dataDir, "config.json"), "utf8")).inboxCanvas).toBe(true);
    expect(await w.read()).toEqual({ on: true });
    const names = (await (await w.session()).listTools()).tools.map((tool) => tool.name);
    expect(names[names.indexOf("thread_pulls") + 1]).toBe("canvas");
    expect((await fetch(`${w.base}/api/inbox/canvases`)).status).toBe(200);

    const bad = await w.settings({ canvas: { on: "yes" } });
    expect(bad.status).toBe(422);
    expect(await w.read()).toEqual({ on: true });

    const off = await w.settings({ canvas: { on: false } });
    expect(((await off.json()) as { canvas: unknown }).canvas).toEqual({ on: false });
    expect((await fetch(`${w.base}/api/inbox/canvases`)).status).toBe(409);
  });
});
