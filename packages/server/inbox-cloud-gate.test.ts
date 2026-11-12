import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer } from "./inbox";
import { INBOX_RELAY_ANSWERED_FILE } from "./inbox-cloud-gate";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function relayAt(url: string) {
  const before = process.env.PLANNOTATOR_RELAY_URL;
  process.env.PLANNOTATOR_RELAY_URL = url;
  cleanups.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_RELAY_URL;
    else process.env.PLANNOTATOR_RELAY_URL = before;
  });
}

function stubRelay() {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (hits++, Response.json({ error: "Not found", code: "not_found" }, { status: 404 })) });
  return { url: `http://127.0.0.1:${server.port}`, hits: () => hits, stop: () => server.stop(true) };
}

function dataDir() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-cloud-gate-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "data");
}

async function inbox(dir: string) {
  const server = await startInboxServer({ dataDir: dir });
  const base = `http://127.0.0.1:${server.port}`;
  const get = async () => (await (await fetch(`${base}/api/inbox/cloud-agents`)).json()) as { available: boolean; agents: unknown[] };
  const pair = (name: string) =>
    fetch(`${base}/api/inbox/cloud-agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, name, preset: "other" }) });
  return { server, get, pair };
}

test("Cloud agents stay hidden until the relay answers once; then they show, and stay after the relay goes away", async () => {
  const dir = dataDir();
  relayAt("http://127.0.0.1:9");
  const first = await inbox(dir);
  expect((await first.get()).available).toBe(false);
  expect(existsSync(join(dir, "inbox", INBOX_RELAY_ANSWERED_FILE))).toBe(false);
  first.server.stop();

  const relay = stubRelay();
  relayAt(relay.url);
  const second = await inbox(dir);
  expect((await second.get()).available).toBe(true);
  expect(relay.hits()).toBe(1);
  expect((await second.get()).available).toBe(true);
  expect(relay.hits()).toBe(1);
  second.server.stop();
  relay.stop();

  const third = await inbox(dir);
  expect((await third.get()).available).toBe(true);
  third.server.stop();
});

test("an agent already paired always shows, relay or not", async () => {
  const dir = dataDir();
  relayAt("http://127.0.0.1:9");
  const world = await inbox(dir);
  expect((await world.get()).available).toBe(false);
  expect((await world.pair("Poller")).status).toBe(200);
  const answer = await world.get();
  expect(answer.available).toBe(true);
  expect(answer.agents).toHaveLength(1);
  world.server.stop();
});
