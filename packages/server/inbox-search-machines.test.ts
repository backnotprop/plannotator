/**
 * Cmd+K across linked machines (docs/agent-guides/inbox-machines.md, "Search across machines"): with `machines=1`
 * the search route also asks every linked machine online through the forward (the door's `GET search`) and merges:
 * a first answer's rows ranked together by `score`, totals summed, Recent by latest activity, each other machine's
 * row tagged with `project.machine`. Another machine's project as the filter asks that machine alone (it was
 * `project_not_found`). Without `machines=1`, and with the other machine away, search stays this machine's own.
 *
 * Two real Inboxes in this process, temp data dirs, Phones off; A links one way to B's door on loopback, as
 * `plannotator inbox link --one-way` does. A `tailscale` that refuses: nothing here may run the real one.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";

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

  // A links one way to B's door.
  const offered = (await (await fetch(`${b.base}/api/inbox/machines/offer`, { method: "POST", body: "{}" })).json()) as { link: string; machine: { id: string } };
  const linked = await fetch(`${a.base}/api/inbox/machines/link`, { method: "POST", body: JSON.stringify({ link: offered.link, address: b.base, one_way: true }) });
  expect(linked.status).toBe(201);
  const bId = offered.machine.id;
  await until("B online on A, its threads in A's merged list", async () => rowsOf(await get(a.base, "/api/inbox/threads?machines=1")).some((row) => row.thread_id === titledB));
  // Both indexes build on their first search.
  await until("both indexes", async () => !(await get(a.base, "/api/inbox/search?q=zebracorn")).indexing && !(await get(b.base, "/api/inbox/search?q=zebracorn")).indexing);

  // Without machines=1: this Inbox's own.
  expect((await get(a.base, "/api/inbox/search?q=zebracorn")).totals.threads).toBe(1);

  const merged = await get(a.base, "/api/inbox/search?q=zebracorn&machines=1");
  expect(merged.totals.threads).toBe(3);
  const rows = merged.groups.threads as Json[];
  expect(new Set(rows.map((row) => row.id))).toEqual(new Set([mine, titledB, olderB]));
  for (const row of rows) expect(row.project.machine).toBe(row.id === mine ? undefined : bId);
  // One ranking by score (here the same match, so newest first): A's thread between B's two.
  expect(rows.map((row) => row.id)).toEqual([titledB, mine, olderB]);
  const scores = rows.map((row) => row.score as number);
  expect(scores).toEqual([...scores].sort((x, y) => y - x));

  // "Show all" pages across machines: this Inbox's rows, then B's, the offset running across them.
  const page = await get(a.base, "/api/inbox/search?q=zebracorn&machines=1&group=threads&offset=1&limit=1");
  expect(page.totals.threads).toBe(3);
  expect((page.groups.threads as Json[]).map((row) => row.project.machine)).toEqual([bId]);

  // Recent: both machines' looked-at threads, newest activity first.
  const recent = (await get(a.base, "/api/inbox/search?q=&machines=1")).recent as Json[];
  expect(recent.map((row) => row.id)).toEqual([titledB, mine, olderB]);
  expect(recent.map((row) => row.project.machine)).toEqual([bId, undefined, bId]);
  expect(((await get(a.base, "/api/inbox/search?q=")).recent as Json[]).map((row) => row.id)).toEqual([mine]);

  // B's project as the filter (the palette's Project chip): B alone answers, where it was project_not_found.
  const onB = await get(a.base, `/api/inbox/search?q=zebracorn&machines=1&project=${projectB.id}`);
  expect(onB.totals.threads).toBe(2);
  expect((onB.groups.threads as Json[]).every((row) => row.project.machine === bId)).toBe(true);

  // B away: A's own, and nothing waits for it.
  b.server.stop();
  expect((await get(a.base, "/api/inbox/search?q=zebracorn&machines=1")).totals.threads).toBe(1);
  expect(((await get(a.base, "/api/inbox/search?q=&machines=1")).recent as Json[]).map((row) => row.id)).toEqual([mine]);
}, 60_000);
