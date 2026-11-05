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
 *  - on → off: the routes answer 404 again and the boards are kept;
 *  - a window hears board changes on the Inbox's one event stream, only while on;
 *  - a tailnet guest is refused, the owner over the tailnet is not; a write from a
 *    page of a restarted Inbox is refused (409).
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
import type { TailscaleRunner } from "@plannotator/shared/tailscale";

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
    // Held until the next big release (inbox.ts heldSwitch): off, the settings read leaves Shape out, so Settings draws no row.
    expect(((await (await w.get("/api/inbox/settings")).json()) as { shape?: { on: boolean } }).shape).toBeUndefined();

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

/** Read a stream until `want` shows or `ms` pass; the text read. */
async function readUntil(response: Response, want: string, ms: number): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (!text.includes(want) && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
    if (!chunk || chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  await reader.cancel().catch(() => {});
  return text;
}

test("a window hears its boards on the Inbox's one event stream (no second connection), and only while Shape is on", async () => {
  // On: a change to a board is `event: shapes` on /api/inbox/events, naming it.
  const on = await world({ inboxShape: true });
  const stream = await fetch(`${on.base}/api/inbox/events?window=shape-frames-on`);
  const reading = readUntil(stream, "event: shapes", 8_000);
  await new Promise((r) => setTimeout(r, 300));
  expect((await on.post(`/api/shapes/${on.id}/notes`, { kind: "change", v: 1, view: "picture", text: "Two whistles" })).status).toBe(200);
  const heard = await reading;
  expect(heard).toContain("event: shapes");
  expect(heard).toContain(on.id);

  // Off: the same change in the store says nothing on the stream.
  const off = await world(null);
  const quiet = await fetch(`${off.base}/api/inbox/events?window=shape-frames-off`);
  const listening = readUntil(quiet, "event: shapes", 2_500);
  await new Promise((r) => setTimeout(r, 300));
  createShapeStore({ dataDir: off.dataDir }).addNote(off.id, { kind: "change", v: 1, view: "picture", text: "Two whistles" });
  expect(await listening).not.toContain("event: shapes");
});

test("a tailnet guest is refused every Shape route and hears no board on the event stream (no store reading for it); the owner over the tailnet is not", async () => {
  const MAGIC = "macbook-pro.tail0000.ts.net";
  const OWNER = "ramos@example.com";
  const GUEST = "guest@example.com";
  const savedTailscale = process.env.PLANNOTATOR_INBOX_TAILSCALE;
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  try {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-shape-guest-")));
    roots.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxShape: true, inboxTailscale: true, inboxTailscaleAllow: [GUEST] }));
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    const made = createShapeStore({ dataDir }).update({ board, project: { root, name: "app" }, session: { id: "ses_a", host: "claude-code" } });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale(MAGIC, OWNER) });
    servers.push(server);
    const listener = server.tailscale.listenerPort();
    expect(listener).not.toBeNull();
    const through = (login: string, path: string) =>
      fetch(`http://127.0.0.1:${listener}${path}`, { headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login, Origin: `https://${MAGIC}:${server.port}` } });
    for (const path of ["/api/shapes", `/api/shapes/${made.id}`]) {
      const guest = await through(GUEST, path);
      expect(guest.status).toBe(403);
      expect((await through(OWNER, path)).status).toBe(200);
    }

    // The event stream: a guest's window hears no board ids and starts no reading of the store; the owner's does.
    const note = () =>
      fetch(`http://127.0.0.1:${server.port}/api/shapes/${made.id}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "change", v: 1, view: "picture", text: "Two whistles" }) });
    const guestStream = await through(GUEST, "/api/inbox/events?window=shape-guest");
    expect(guestStream.status).toBe(200);
    const guestHeard = readUntil(guestStream, "event: shapes", 2_500);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.shapeWatchers()).toBe(0);
    expect((await note()).status).toBe(200);
    expect(await guestHeard).not.toContain("event: shapes");

    const ownerStream = await through(OWNER, "/api/inbox/events?window=shape-owner");
    expect(ownerStream.status).toBe(200);
    const ownerHeard = readUntil(ownerStream, "event: shapes", 8_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.shapeWatchers()).toBe(1);
    expect((await note()).status).toBe(200);
    expect(await ownerHeard).toContain(made.id);
  } finally {
    if (savedTailscale === undefined) delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    else process.env.PLANNOTATOR_INBOX_TAILSCALE = savedTailscale;
  }
});

test("a Shape write from a page of an Inbox that restarted is refused (409), and writes nothing", async () => {
  const w = await world({ inboxShape: true });
  const before = ((await (await w.get(`/api/shapes/${w.id}`)).json()) as { notes: unknown[] }).notes.length;
  for (const [path, body] of [
    [`/api/shapes/${w.id}/notes`, { kind: "change", v: 1, view: "picture", text: "Two whistles" }],
    [`/api/shapes/${w.id}/seen`, { n: 1 }],
    [`/api/shapes/${w.id}/state`, { state: "finished" }],
  ] as const) {
    expect((await w.post(path, { ...body, serverSession: "another" })).status).toBe(409);
  }
  const after = (await (await w.get(`/api/shapes/${w.id}`)).json()) as { notes: unknown[]; shape: { state: string } };
  expect(after.notes.length).toBe(before);
  expect(after.shape.state).toBe("active");
});

test("with Code review on and Shape off, the / list has the review skills and no /shape", async () => {
  const none = () => [];
  const names = async (response: Response) => ((await response.json()) as { skills: { name: string }[] }).skills.map((s) => s.name);
  const reviewOnly = await names(inboxSkillCatalog(true, none, false));
  expect(reviewOnly.length).toBeGreaterThan(0);
  expect(reviewOnly).not.toContain("shape");
  expect(await names(inboxSkillCatalog(true, none, true))).toContain("shape");
});

/** A scripted `tailscale` serving this Inbox over a tailnet `magic` name, `owner` its login (as inbox-board-routes.test.ts). */
function scriptedTailscale(magic: string, owner: string): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${magic}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: owner } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${magic}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`https://${magic}:${httpsPort}/\n`);
  };
}
