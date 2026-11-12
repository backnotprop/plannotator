import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShapeStore } from "./store";
import { createShapeWatch, handleShapeRoute, type ShapeRouteResult } from "./routes";
import type { ShapeBoard } from "./format";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "shape-routes-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const project = { name: "kettle", root: "/work/kettle" };
const board = (words = "whistles once"): ShapeBoard => ({
  title: "The kettle whistles once",
  claim: "Built. Nothing waits on you.",
  views: { picture: { html: `<p data-mark="p-whistle">${words}</p>` } },
});

function world() {
  const dataDir = scratch();
  const store = createShapeStore({ dataDir });
  const first = store.update({ board: board(), project, session: { host: "claude-code", id: "s1" } });
  if (!first.ok) throw new Error("setup");
  const changed: string[] = [];
  const call = (method: string, path: string, body?: unknown) => {
    const url = new URL(path, "http://x");
    return handleShapeRoute(
      { method, pathname: url.pathname, params: url.searchParams, json: async () => (typeof body === "string" ? JSON.parse(body) : body) },
      { store, changed: (id) => changed.push(id) },
    ) as Promise<ShapeRouteResult & { body: any }>;
  };
  return { dataDir, store, id: first.id, call, changed };
}

describe("shape routes", () => {
  test("a page opens a board, its history and an older version", async () => {
    const w = world();
    w.store.update({ id: w.id, base: 1, board: board("whistles twice"), project });
    const list = await w.call("GET", "/api/shapes");
    expect(list.body.shapes.map((s: { id: string }) => s.id)).toEqual([w.id]);
    const open = await w.call("GET", `/api/shapes/${w.id}`);
    expect(open.body.version.n).toBe(2);
    expect(open.body.session).toEqual({ state: "gone", agent: "Claude Code" });
    expect((await w.call("GET", `/api/shapes/${w.id}?n=1`)).body.version.n).toBe(1);
    expect((await w.call("GET", `/api/shapes/${w.id}/versions`)).body.versions.map((v: { n: number }) => v.n)).toEqual([1, 2]);
    expect((await w.call("GET", `/api/shapes/${w.id}?n=9`)).status).toBe(404);
    expect((await w.call("GET", "/api/shapes/shp_nope")).status).toBe(404);
    expect(await w.call("GET", "/api/other")).toBeNull();
  });

  test("a Change it is stored and waits; a bad one is refused and nothing is stored", async () => {
    const w = world();
    const ok = await w.call("POST", `/api/shapes/${w.id}/notes`, { kind: "change", v: 1, view: "picture", part: "p-whistle", text: "Twice" });
    expect(ok.status).toBe(200);
    expect(w.store.waiting(w.id).map((n) => n.text)).toEqual(["Twice"]);
    expect(w.changed).toEqual([w.id]);
    const badKind = await w.call("POST", `/api/shapes/${w.id}/notes`, { kind: "shout", v: 1, text: "x" });
    expect(badKind.status).toBe(400);
    const badJson = await w.call("POST", `/api/shapes/${w.id}/notes`, "{nope");
    expect(badJson.status).toBe(400);
    expect(w.store.notes(w.id)).toHaveLength(1);
  });

  test("an answer to an Ask is stored against its question", async () => {
    const w = world();
    const q = await w.call("POST", `/api/shapes/${w.id}/notes`, { kind: "ask", v: 1, text: "Why once?" });
    const a = await w.call("POST", `/api/shapes/${w.id}/answer`, { re: q.body.note.id, text: "So it never nags.", from: { host: "ai", id: "claude" } });
    expect(a.status).toBe(200);
    expect(w.store.notes(w.id).map((n) => [n.kind, n.re])).toEqual([["ask", null], ["answer", q.body.note.id]]);
  });

  test("seen and finished stick", async () => {
    const w = world();
    expect((await w.call("POST", `/api/shapes/${w.id}/seen`, { n: 1 })).body.seen).toBe(1);
    expect((await w.call("POST", `/api/shapes/${w.id}/state`, { state: "finished" })).body.shape.state).toBe("finished");
    expect((await w.call("GET", "/api/shapes")).body.shapes).toEqual([]);
    expect((await w.call("GET", "/api/shapes?state=all")).body.shapes).toHaveLength(1);
    expect((await w.call("POST", `/api/shapes/${w.id}/state`, { state: "deleted" })).status).toBe(400);
  });

  test("only an image in the shape's files/ is served", async () => {
    const w = world();
    const source = scratch();
    writeFileSync(join(source, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    writeFileSync(join(source, "notes.txt"), "x");
    const r = w.store.update({ id: w.id, base: 1, board: { ...board(), refs: [{ n: 1, kind: "image", title: "Shot", target: "shot.png" }] }, project, sourceDir: source });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const name = w.store.read(w.id)!.refs![0]!.target.replace(/^files\//, "");
    const ok = await w.call("GET", `/api/shapes/${w.id}/files/${name}`);
    expect(ok).toMatchObject({ status: 200, file: { contentType: "image/png" } });
    for (const outside of ["..%2Fshape.json", "%2E%2E%2F%2E%2E%2Fseen.json", "shape.json", ".lock"]) {
      expect((await w.call("GET", `/api/shapes/${w.id}/files/${outside}`)).status).toBe(404);
    }
  });

  test("an SVG or AVIF picture the board keeps is served as its type", async () => {
    const w = world();
    const source = scratch();
    writeFileSync(join(source, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2"/></svg>');
    const r = w.store.update({ id: w.id, base: 1, board: { ...board(), views: { picture: { html: '<img src="logo.svg">' } } }, project, sourceDir: source });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const name = /files\/([^"]+)/.exec(w.store.read(w.id)!.views.picture!.html)![1]!;
    expect(await w.call("GET", `/api/shapes/${w.id}/files/${name}`)).toMatchObject({ status: 200, file: { contentType: "image/svg+xml" } });
  });
});

describe("the event feed's watch", () => {
  test("names a shape when its agent writes a version, and when the agent picks up a waiting change", async () => {
    const w = world();
    const watch = createShapeWatch(w.store, { intervalMs: 20 });
    const seen: string[][] = [];
    const stop = watch.subscribe((ids) => seen.push(ids));
    const agent = createShapeStore({ dataDir: w.dataDir });
    agent.update({ id: w.id, base: 1, board: board("twice"), project });
    await Bun.sleep(80);
    expect(seen.flat()).toContain(w.id);

    w.store.addNote(w.id, { kind: "change", v: 2, text: "Thrice" });
    await Bun.sleep(80);
    seen.length = 0;
    const waiting = agent.waiting(w.id);
    agent.markDelivered(w.id, waiting.map((n) => n.id));
    await Bun.sleep(80);
    expect(seen.flat()).toContain(w.id);
    expect(w.store.list()[0]!.waiting).toBe(0);
    stop();
  });
});

describe("the routes never block the server", () => {
  test("a write waits (asynchronously) while an agent's CLI holds the lock, then goes through", async () => {
    const w = world();
    const lock = join(w.store.dir, ".lock");
    writeFileSync(lock, "agent");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const pending = w.call("POST", `/api/shapes/${w.id}/seen`, { n: 1 });
    await Bun.sleep(60);
    expect(ticks).toBeGreaterThan(3);
    rmSync(lock);
    const done = await pending;
    clearInterval(timer);
    expect(done.body.seen).toBe(1);
  });

  test("a link planted in files/ is never served", async () => {
    const w = world();
    const { symlinkSync, mkdirSync } = await import("node:fs");
    const folder = join(w.store.dir, ...(await import("node:fs")).readdirSync(w.store.dir).filter((d) => !d.includes(".")).slice(0, 1));
    const shapeFolder = join(folder, w.id);
    expect((await import("node:fs")).existsSync(join(shapeFolder, "shape.json"))).toBe(true);
    mkdirSync(join(shapeFolder, "files"), { recursive: true });
    symlinkSync(join(shapeFolder, "shape.json"), join(shapeFolder, "files", "leak.png"));
    expect((await w.call("GET", `/api/shapes/${w.id}/files/leak.png`)).status).toBe(404);
  });
});
