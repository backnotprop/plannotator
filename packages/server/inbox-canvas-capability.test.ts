/**
 * The canvas on a running Inbox (config.json `inboxCanvas`, on unless false; no row in Settings): on from the start,
 * the routes answer; config.json `false` (or a settings write of `{ canvas: { on: false } }`, which
 * `plannotator inbox capability canvas off` sends) turns it off, and every canvas route refuses as Code review's do,
 * `plannotator inbox canvas`'s route included. Either way the agent's tools/list has no `canvas` (it is a command).
 * Pure parts: inbox-canvas-switch.test.ts, inbox-canvas-agent.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

async function world(config?: Record<string, unknown>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-canvas-cap-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
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
  /** `plannotator inbox canvas`'s request, as the command sends it. */
  const agentAsk = (body: unknown) => fetch(`${base}/api/inbox/canvas/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { dataDir, base, session, settings, read, agentAsk };
}

describe("the canvas switch on a running Inbox", () => {
  test("on from the start: the routes answer, and the agent tool has no canvas", async () => {
    const w = await world();
    expect(await w.read()).toEqual({ on: true });
    expect((await fetch(`${w.base}/api/inbox/canvases`)).status).toBe(200);
    const names = (await (await w.session()).listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("canvas");
  });

  test("off in config.json: the canvas routes refuse, the command's too, and the agent tool has no canvas", async () => {
    const w = await world({ inboxCanvas: false });
    expect(await w.read()).toEqual({ on: false });
    for (const path of ["/api/inbox/canvases", "/api/inbox/threads/msg_A1/canvas"]) {
      const answer = await fetch(`${w.base}${path}`);
      expect([path, answer.status]).toEqual([path, 409]);
      expect(((await answer.json()) as { code: string }).code).toBe("canvas_off");
    }
    const asked = await w.agentAsk({ thread_id: "msg_A1" });
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { code: string }).code).toBe("canvas_off");
    const names = (await (await w.session()).listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("canvas");
    expect(names).toContain("thread_pulls");
  });

  test("turned on again: saved in config.json, the routes and the command's route answer, the tool still has no canvas; a malformed switch is refused", async () => {
    const w = await world({ inboxCanvas: false });
    const on = await w.settings({ canvas: { on: true } });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { canvas: unknown }).canvas).toEqual({ on: true });
    expect(JSON.parse(readFileSync(join(w.dataDir, "config.json"), "utf8")).inboxCanvas).toBe(true);
    expect(await w.read()).toEqual({ on: true });
    const names = (await (await w.session()).listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("canvas");
    expect((await fetch(`${w.base}/api/inbox/canvases`)).status).toBe(200);
    // The command reaches the canvas: a thread it does not know is said so, not refused as off.
    const asked = await w.agentAsk({ thread_id: "msg_NONE" });
    expect(asked.status).toBe(404);
    expect(((await asked.json()) as { code: string }).code).toBe("thread_not_found");

    const bad = await w.settings({ canvas: { on: "yes" } });
    expect(bad.status).toBe(422);
    expect(await w.read()).toEqual({ on: true });

    const off = await w.settings({ canvas: { on: false } });
    expect(((await off.json()) as { canvas: unknown }).canvas).toEqual({ on: false });
    expect((await fetch(`${w.base}/api/inbox/canvases`)).status).toBe(409);
  });
});
