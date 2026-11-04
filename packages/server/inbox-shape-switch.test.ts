/**
 * Shape's switch (Settings → Capabilities → Shape, config.json `inboxShape`),
 * on a real Inbox with config.json deciding (no override):
 *
 *  - unset (the default) and off: every `/api/shapes` path answers 404, as if
 *    absent (reads, writes, files, the event feed), and the "/" list names no
 *    `/shape` skill;
 *  - Settings turns it on: the same paths answer, the windows' capabilities
 *    stream says so, and the "/" list names `/shape`;
 *  - on: another site is refused, reads included (a board names files and
 *    folders);
 *  - on → off: the routes answer 404 again and the boards are kept.
 *
 * What regresses: an Inbox that serves boards (or offers agents the skill)
 * while the person never turned Shape on, or a switch that deletes boards.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkShapeBoard } from "@plannotator/core/shape";
import { SHAPE_SKILL } from "@plannotator/core/shape-skill";
import { createShapeStore } from "@plannotator/shared/shape/store";
import { startInboxServer, type InboxServer } from "./inbox";
import { inboxSkillCatalog } from "./inbox-skills";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const board = { title: "Kettle", claim: "Built.", views: { picture: { html: '<p data-mark="k">One whistle</p>' } } };

async function world(config: Record<string, unknown> | null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-shape-switch-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  // A board in the store, made as `plannotator shape update` makes it.
  const project = join(root, "app");
  mkdirSync(project, { recursive: true });
  const made = createShapeStore({ dataDir }).update({ board, project: { root: project, name: "app" }, session: { id: "ses_a", host: "claude-code" } });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const setShape = (on: boolean) => post("/api/inbox/settings", { shape: { on } });
  const skills = async () => ((await (await get("/api/inbox/skills")).json()) as { skills: { name: string }[] }).skills.map((s) => s.name);
  return { root, dataDir, base, get, post, setShape, skills, id: made.id };
}

async function statuses(w: Awaited<ReturnType<typeof world>>) {
  const id = w.id;
  return {
    list: (await w.get("/api/shapes")).status,
    one: (await w.get(`/api/shapes/${id}`)).status,
    note: (await w.post(`/api/shapes/${id}/notes`, { kind: "change", v: 1, view: "picture", text: "Two whistles" })).status,
    seen: (await w.post(`/api/shapes/${id}/seen`, { n: 1 })).status,
    file: (await w.get(`/api/shapes/${id}/files/x.png`)).status,
    events: await (async () => {
      const controller = new AbortController();
      const response = await fetch(`${w.base}/api/shapes/events`, { signal: controller.signal });
      controller.abort();
      return response.status;
    })(),
  };
}

test("unset and off: every Shape path is a 404 and the / list has no /shape; Settings turns it on", async () => {
  for (const config of [null, { inboxShape: false }]) {
    const w = await world(config);
    expect(await statuses(w)).toEqual({ list: 404, one: 404, note: 404, seen: 404, file: 404, events: 404 });
    expect(await w.skills()).not.toContain("shape");
    expect(((await (await w.get("/api/inbox/settings")).json()) as { shape: { on: boolean } }).shape).toEqual({ on: false });

    // The windows' stream says when it changes (Settings in another window turns it on).
    const controller = new AbortController();
    const stream = await fetch(`${w.base}/api/inbox/events?window=shape-switch-test`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    expect((await w.setShape(true)).status).toBe(200);
    let seen = "";
    const decoder = new TextDecoder();
    while (!seen.includes("event: capabilities")) seen += decoder.decode((await reader.read()).value);
    controller.abort();
    expect(seen).toContain('"shape":{"on":true}');
    expect(JSON.parse(readFileSync(join(w.dataDir, "config.json"), "utf8")).inboxShape).toBe(true);

    const on = await statuses(w);
    expect(on).toEqual({ list: 200, one: 200, note: 200, seen: 200, file: 404, events: 200 });
    expect(await w.skills()).toContain("shape");
    const listed = ((await (await w.get("/api/shapes")).json()) as { shapes: { id: string }[] }).shapes.map((s) => s.id);
    expect(listed).toEqual([w.id]);
  }
});

test("on: another site is refused, reads included; turning it off again keeps the boards", async () => {
  const w = await world({ inboxShape: true });
  const cross = { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" };
  expect((await w.get("/api/shapes", cross)).status).toBe(403);
  expect((await w.get(`/api/shapes/${w.id}`, cross)).status).toBe(403);
  expect((await w.post(`/api/shapes/${w.id}/notes`, { kind: "change", v: 1, view: "picture", text: "x" }, cross)).status).toBe(403);
  expect((await w.get(`/api/shapes/${w.id}`)).status).toBe(200);

  expect((await w.setShape(false)).status).toBe(200);
  expect((await w.get(`/api/shapes/${w.id}`)).status).toBe(404);
  expect(await w.skills()).not.toContain("shape");
  // Kept: turning it back on shows the same board.
  expect((await w.setShape(true)).status).toBe(200);
  expect(((await (await w.get(`/api/shapes/${w.id}`)).json()) as { shape: { id: string } }).shape.id).toBe(w.id);
});

test("the / list offers /shape only while Shape is on, and never over a skill of the same name the person has", () => {
  const none = () => [];
  const names = async (response: Response) => ((await response.json()) as { skills: { name: string; humanOnly?: boolean }[] }).skills;
  return (async () => {
    expect((await names(inboxSkillCatalog(false, none, false))).map((s) => s.name)).not.toContain("shape");
    const on = await names(inboxSkillCatalog(false, none, true));
    expect(on.find((s) => s.name === "shape")).toMatchObject({ name: "shape", humanOnly: true });
    const mine = await names(inboxSkillCatalog(false, () => [{ name: "shape", root: "/x", description: "mine" }] as never, true));
    expect(mine.filter((s) => s.name === "shape")).toHaveLength(1);
    expect(mine.find((s) => s.name === "shape")?.humanOnly).toBeUndefined();
  })();
});

test("the skill's JSON example is a board the store accepts", () => {
  const json = SHAPE_SKILL.body.match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(json).toBeDefined();
  // The example elides its markup with "…"; the fields and their kinds are what an agent copies.
  const parsed = JSON.parse(json!);
  const checked = checkShapeBoard(parsed);
  expect(checked.ok ? [] : checked.errors).toEqual([]);
});
