import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { DecisionDataSummary } from "@plannotator/core/inbox-types";
import { DECISION_LINES_FILE } from "@plannotator/shared/inbox/decision-data";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-decision-data-")));
  roots.push(root);
  const project = join(root, "harbor");
  mkdirSync(project, { recursive: true });
  return { root, project, data: join(root, "data") };
}

function seed(data: string, projectRoot: string, count: number) {
  mkdirSync(data, { recursive: true });
  let clock = Date.now() - 86_400_000;
  const store = InboxStore.open(join(data), { now: () => new Date((clock += 1000)) });
  const project = store.ensureProject({ name: "harbor", root: projectRoot });
  const author = { kind: "agent" as const, host: "claude-code", session: "ses-a", name: null };
  let thread = "";
  for (let i = 0; i < count; i++) {
    const sent = store.sendMessage({ project_id: project.id, author, body: `:::question\nPick ${i}?\n\n- [ ] A\n- [ ] B\n\nRecommended: A\n:::`, thread: `t${i}`, idempotency_key: `k${i}` }).message;
    thread = sent.thread_id;
    const q = store.questionsOf(sent.id)[0]!;
    store.savePicks(sent.id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: ["A"] } }]);
    const after = store.questionsOf(sent.id)[0]!;
    store.sendReply(sent.id, { questions: [{ key: after.key, revision: after.revision }], idempotency_key: `r${i}` });
  }
  return { thread };
}

async function start(data: string, options: { phones?: boolean } = {}) {
  const server = await startInboxServer({ dataDir: data, ...options });
  servers.push(server);
  return server;
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const read = async (server: InboxServer, query = "days=90&tz=0") => (await (await fetch(`${base(server)}/api/inbox/decision-data?${query}`)).json()) as DecisionDataSummary;

test("an empty store answers an empty model, and a store with decisions counts them, with no timing or reading detail in the reply", async () => {
  const empty = scratch();
  expect(await read(await start(empty.data))).toMatchObject({ history: { asked: 0, answered: 0, earliest: null }, waiting: 0, trends: [], projects: [], agents: [] });

  const full = scratch();
  seed(full.data, full.project, 3);
  const model = await read(await start(full.data));
  expect(model.counts.answered).toBe(3);
  expect(model.agents[0]).toMatchObject({ label: "Claude Code", answered: 3, taken: 3 });
  expect(model.projects[0]).toMatchObject({ label: "harbor" });
  expect(JSON.stringify(model)).not.toContain("longest_slice");
  expect(JSON.stringify(model)).not.toContain("Pick 1");
});

test("a query that makes no sense still answers: an odd tz or days never breaks the section", async () => {
  const world = scratch();
  seed(world.data, world.project, 1);
  const server = await start(world.data);
  for (const query of ["days=abc&tz=abc", "days=-5&tz=99999999999999", "days=&tz=", ""]) {
    const response = await fetch(`${base(server)}/api/inbox/decision-data?${query}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as DecisionDataSummary).counts.answered).toBe(1);
  }
});

test("the CSV downloads as a file, by range; only GET; another site's page cannot read either answer", async () => {
  const world = scratch();
  seed(world.data, world.project, 2);
  const server = await start(world.data);
  const csv = await fetch(`${base(server)}/api/inbox/decision-data?format=csv&days=90`);
  expect(csv.status).toBe(200);
  expect(csv.headers.get("content-type")).toContain("text/csv");
  expect(csv.headers.get("content-disposition")).toContain("attachment");
  const text = await csv.text();
  expect(text.trim().split("\n").length).toBe(3);
  expect(text).not.toContain("Pick 1");

  const posted = await fetch(`${base(server)}/api/inbox/decision-data`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession }) });
  expect(posted.status).toBe(405);

  for (const query of ["days=90", "format=csv"]) {
    const crossSite = await fetch(`${base(server)}/api/inbox/decision-data?${query}`, { headers: { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).not.toContain("harbor");
  }
});

async function withFastClock<T>(run: () => Promise<T>): Promise<T> {
  const saved = performance.now;
  let at = saved.call(performance);
  performance.now = () => (at += 5);
  try {
    return await run();
  } finally {
    performance.now = saved;
  }
}

test("counting hands the server back: another request is answered before a big count finishes", async () => {
  const world = scratch();
  seed(world.data, world.project, 1500);
  const server = await start(world.data);
  await withFastClock(async () => {
    const order: string[] = [];
    const counting = fetch(`${base(server)}/api/inbox/decision-data?days=0&tz=0`).then(async (response) => {
      await response.text();
      order.push("count");
    });
    await new Promise((resolve) => setImmediate(resolve));
    await fetch(`${base(server)}/api/inbox/health`).then(async (response) => {
      await response.text();
      order.push("health");
    });
    await counting;
    expect(order).toEqual(["health", "count"]);
  });
});

for (const [what, query] of [
  ["count", "days=0&tz=0"],
  ["CSV", "days=0&format=csv"],
] as const) {
test(`a reader who leaves stops the ${what}, and the server keeps answering`, async () => {
  const world = scratch();
  seed(world.data, world.project, 1);
  const at = Date.now() - 86_400_000;
  const line = (id: number) => JSON.stringify({ v: 1, id: `q${id}`, thread_id: "t", project_id: "p", agent: "Claude Code", kind: "single", asked_at: at, answered_at: at, sent_at: at, fate: "answered", took: null, offered: false, stopped: false, holds_up: false, files: false, revisions: 1 });
  writeFileSync(join(world.data, "inbox", DECISION_LINES_FILE), `${Array.from({ length: 100_000 }, (_, id) => line(id)).join("\n")}\n`);
  const server = await start(world.data);
  const savedImmediate = globalThis.setImmediate;
  let slices = 0;
  globalThis.setImmediate = ((...args: Parameters<typeof setImmediate>) => {
    slices++;
    return savedImmediate(...args);
  }) as typeof setImmediate;
  try {
    await withFastClock(async () => {
      await (await fetch(`${base(server)}/api/inbox/decision-data?${query}`)).text();
      const whole = slices;
      expect(whole).toBeGreaterThan(100);
      slices = 0;
      const controller = new AbortController();
      const left = fetch(`${base(server)}/api/inbox/decision-data?${query}`, { signal: controller.signal }).catch(() => null);
      while (slices === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      controller.abort();
      await left;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(slices).toBeLessThan(whole / 2);
    });
  } finally {
    globalThis.setImmediate = savedImmediate;
  }
  expect((await fetch(`${base(server)}/api/inbox/health`)).status).toBe(200);
});
}

test("the phone door does not carry the numbers or the CSV", async () => {
  const world = scratch();
  seed(world.data, world.project, 1);
  const server = await start(world.data, { phones: true });
  expect((await read(server)).counts.answered).toBe(1);
  const made = (await (await fetch(`${base(server)}/api/inbox/pairing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession }) })).json()) as { offer: { code: string } };
  const paired = await fetch(`${base(server)}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) });
  const { token } = (await paired.json()) as { token: string };
  for (const query of ["days=90&tz=0", "format=csv&days=90"]) {
    const refused = await fetch(`${base(server)}/api/inbox/device/decision-data?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { code: string }).code).toBe("device_route_not_found");
  }
});

test("a delete through the window's own route keeps the numbers", async () => {
  const world = scratch();
  const { thread } = seed(world.data, world.project, 2);
  const server = await start(world.data);
  const before = await read(server);
  const deleted = await fetch(`${base(server)}/api/inbox/threads/${thread}/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession }) });
  expect(deleted.status).toBe(200);
  const after = await read(server);
  expect(after.counts).toEqual(before.counts);
  expect((await fetch(`${base(server)}/api/inbox/threads/${thread}`)).status).toBe(404);
});
