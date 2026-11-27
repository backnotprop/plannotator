import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxSearchRoutes, INBOX_SEARCH_PATH } from "./inbox-search";

type Json = Record<string, any>;

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_search_machines", name: null };
const refusingTailscale: TailscaleRunner = () => ({ status: 1, stdout: "", stderr: "tailscale must not run in a test" });

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

async function inbox(root: string, name: string): Promise<{ server: InboxServer; base: string; root: string }> {
  const dataDir = join(root, name);
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: refusingTailscale });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}`, root };
}

const get = async (base: string, path: string): Promise<Json> => (await (await fetch(`${base}${path}`)).json()) as Json;
const rowsOf = (list: Json) => ((list.sections ?? []) as Json[]).flatMap((section) => section.threads as Json[]);

async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("Cmd+K across linked machines: typed search and Recent merge, the other machine's project asks it, and an away machine adds nothing", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-search-machines-")));
  roots.push(root);
  const a = await inbox(root, "a");
  const b = await inbox(root, "b");
  const projectA = a.server.store.ensureProject({ name: "api", root: join(root, "api") });
  const projectB = b.server.store.ensureProject({ name: "web", root: join(root, "web") });
  const olderB = b.server.store.sendMessage({ project_id: projectB.id, author: AGENT, subject: "Zebracorn notes", body: "Kept for later.", thread: "b-old" }).message.thread_id;
  await Bun.sleep(10);
  const mine = a.server.store.sendMessage({ project_id: projectA.id, author: AGENT, subject: "Zebracorn API", body: "Steps below.", thread: "a1" }).message.thread_id;
  await Bun.sleep(10);
  const titledB = b.server.store.sendMessage({ project_id: projectB.id, author: AGENT, subject: "Zebracorn rollout plan", body: "Steps below.", thread: "b-new" }).message.thread_id;
  a.server.store.markSeen(mine);
  b.server.store.markSeen(titledB);
  b.server.store.markSeen(olderB);

  const offered = (await (await fetch(`${b.base}/api/inbox/machines/offer`, { method: "POST", body: "{}" })).json()) as { link: string; machine: { id: string } };
  const linked = await fetch(`${a.base}/api/inbox/machines/link`, { method: "POST", body: JSON.stringify({ link: offered.link, address: b.base, one_way: true }) });
  expect(linked.status).toBe(201);
  const bId = offered.machine.id;
  await until("B online on A, its threads in A's merged list", async () => rowsOf(await get(a.base, "/api/inbox/threads?machines=1")).some((row) => row.thread_id === titledB));
  await until("both indexes", async () => !(await get(a.base, "/api/inbox/search?q=zebracorn")).indexing && !(await get(b.base, "/api/inbox/search?q=zebracorn")).indexing);

  expect((await get(a.base, "/api/inbox/search?q=zebracorn")).totals.threads).toBe(1);

  const merged = await get(a.base, "/api/inbox/search?q=zebracorn&machines=1");
  expect(merged.totals.threads).toBe(3);
  const rows = merged.groups.threads as Json[];
  expect(new Set(rows.map((row) => row.id))).toEqual(new Set([mine, titledB, olderB]));
  for (const row of rows) expect(row.project.machine).toBe(row.id === mine ? undefined : bId);
  expect(rows.map((row) => row.id)).toEqual([titledB, mine, olderB]);
  const scores = rows.map((row) => row.score as number);
  expect(scores).toEqual([...scores].sort((x, y) => y - x));

  const page = await get(a.base, "/api/inbox/search?q=zebracorn&machines=1&group=threads&offset=1&limit=1");
  expect(page.totals.threads).toBe(3);
  expect((page.groups.threads as Json[]).map((row) => row.id)).toEqual([mine]);

  const recent = (await get(a.base, "/api/inbox/search?q=&machines=1")).recent as Json[];
  expect(recent.map((row) => row.id)).toEqual([titledB, mine, olderB]);
  expect(recent.map((row) => row.project.machine)).toEqual([bId, undefined, bId]);
  expect(((await get(a.base, "/api/inbox/search?q=")).recent as Json[]).map((row) => row.id)).toEqual([mine]);

  const onB = await get(a.base, `/api/inbox/search?q=zebracorn&machines=1&project=${projectB.id}`);
  expect(onB.totals.threads).toBe(2);
  expect((onB.groups.threads as Json[]).every((row) => row.project.machine === bId)).toBe(true);

  b.server.stop();
  expect((await get(a.base, "/api/inbox/search?q=zebracorn&machines=1")).totals.threads).toBe(1);
  expect(((await get(a.base, "/api/inbox/search?q=&machines=1")).recent as Json[]).map((row) => row.id)).toEqual([mine]);
}, 60_000);

test("a machine that never answers costs one wait, Show all pages in the first view's order, and the missing machines are named", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-search-machines-")));
  roots.push(root);
  const id = (kind: string, last: string) => `${kind}_01K${"0".repeat(22)}${last}`;
  const [B, C, D] = [id("ibx", "B"), id("ibx", "C"), id("ibx", "D")];
  const seeded = (name: string, start: number, count: number) => {
    let clock = Date.parse("2026-11-01T10:00:00Z") + start;
    const store = InboxStore.open(join(root, name), { now: () => new Date((clock += 60_000)) });
    const project = store.ensureProject({ name, root: join(root, name, "src") });
    for (let i = 0; i < count; i++) store.sendMessage({ project_id: project.id, author: AGENT, subject: `Zebracorn ${name} ${i}`, body: "Steps.", thread: `${name}-${i}` });
    const routes = createInboxSearchRoutes({ store, serverSession: name, machineWaitMs: 300 });
    return { store, routes };
  };
  const a = seeded("a", 0, 30);
  const b = seeded("b", -570_000, 40);
  await Promise.all([a.routes.index.ensureBuilt(), b.routes.index.ensureBuilt()]);
  const machines = {
    linked: () => [
      { id: B, name: "MacBook", online: true },
      { id: C, name: "Mini", online: true },
      { id: D, name: "Laptop", online: false },
    ],
    projectOwner: (project: string) => (project === id("prj", "D") ? D : null),
    forward: (req: Request, url: URL): Promise<Response | null> => {
      if (!url.pathname.startsWith(`/api/inbox/m/${B}/`)) return new Promise(() => {});
      const door = new URL(`${INBOX_SEARCH_PATH}${url.search}`, url);
      return b.routes.handle(new Request(door), door);
    },
  };
  const ask = async (query: string) => {
    const url = new URL(`http://127.0.0.1:1${INBOX_SEARCH_PATH}?machines=1&${query}`);
    const started = Date.now();
    const answer = (await (await a.routes.handle(new Request(url), url, machines))!.json()) as Json;
    return { answer, took: Date.now() - started };
  };
  const ids = (answer: Json) => (answer.groups.threads as Json[]).map((row) => row.id as string);

  const first = await ask("q=zebracorn");
  const page = await ask("q=zebracorn&group=threads&limit=50");
  const next = await ask("q=zebracorn&group=threads&offset=50&limit=50");
  for (const { answer, took } of [first, page, next]) {
    expect(answer.unanswered).toEqual([{ id: C, name: "Mini" }, { id: D, name: "Laptop" }]);
    expect(took).toBeLessThan(550);
  }
  expect(page.answer.totals.threads).toBe(70);
  expect(ids(page.answer).slice(0, ids(first.answer).length)).toEqual(ids(first.answer));
  const all = [...(page.answer.groups.threads as Json[]), ...(next.answer.groups.threads as Json[])];
  expect(new Set(all.map((row) => row.id)).size).toBe(70);
  const scores = all.map((row) => row.score as number);
  expect(scores).toEqual([...scores].sort((x, y) => y - x));
  expect(new Set(all.slice(0, 10).map((row) => row.project.machine ?? "here"))).toEqual(new Set([B, "here"]));

  const away = await ask(`q=&project=${id("prj", "D")}`);
  expect(away.answer.unanswered).toEqual([{ id: D, name: "Laptop" }]);
  expect(away.answer.totals.threads).toBe(0);
  a.routes.dispose();
  b.routes.dispose();
});
