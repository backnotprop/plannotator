import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxProjectKey } from "../inbox/project-key";
import { createShapeStore } from "./store";
import type { ShapeBoard } from "./format";

// Every test gets its own data dir under the OS temp folder: nothing here
// touches the person's Plannotator data.
const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "shape-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const project = { name: "kettle", root: "/work/kettle" };
const session = { host: "claude-code", id: "11111111-2222-3333-4444-555555555555" };

// Invented content: a kettle that whistles once.
function board(words = "whistles once"): ShapeBoard {
  return {
    title: "The kettle whistles once",
    claim: "Built. Nothing waits on you.",
    views: {
      picture: { html: `<p data-step="1"><span data-mark="p-whistle">${words}</span></p>` },
      reqs: { groups: [{ id: "when", label: "When", items: [{ id: "r-once", text: "Once per boil." }] }] },
    },
  };
}

function storeAt(dataDir: string, start = Date.parse("2026-11-03T10:00:00Z")) {
  let clock = start;
  const store = createShapeStore({ dataDir, now: () => clock });
  return { store, tick: (ms: number) => (clock += ms) };
}

describe("shape versions", () => {
  test("the first update creates the shape under the Inbox's project key", () => {
    const dataDir = scratch();
    const { store } = storeAt(dataDir);
    const result = store.update({ board: board(), project, session });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.v).toBe(1);
    expect(result.created).toBe(true);
    expect(existsSync(join(dataDir, "shapes", inboxProjectKey(project.name, project.root), result.id, "shape.json"))).toBe(true);
    expect(store.read(result.id)?.parts.map((p) => `${p.view}/${p.id}`)).toEqual(["header/title", "header/claim", "picture/p-whistle", "reqs/r-once"]);
  });

  test("an update needs the base it drew from, and a stale base is refused with the latest attached", () => {
    const { store } = storeAt(scratch());
    const first = store.update({ board: board(), project, session });
    if (!first.ok) throw new Error("setup");
    const missing = store.update({ id: first.id, board: board("twice"), project, session });
    expect(missing).toMatchObject({ ok: false, code: "base_required", latest: 1 });

    const second = store.update({ id: first.id, base: 1, board: board("twice"), project, session });
    expect(second).toMatchObject({ ok: true, v: 2, created: false });

    // Another session still drawing from v1 loses the race instead of overwriting v2.
    const stale = store.update({ id: first.id, base: 1, board: board("thrice"), project, session });
    expect(stale.ok).toBe(false);
    if (stale.ok || stale.code !== "stale_base") throw new Error("expected stale_base");
    expect(stale.latest.n).toBe(2);
    expect(store.read(first.id)?.parts.find((p) => p.id === "p-whistle")?.text).toBe("twice");
    expect(store.versions(first.id).map((v) => v.n)).toEqual([1, 2]);
  });

  test("an invalid board stores nothing", () => {
    const dataDir = scratch();
    const { store } = storeAt(dataDir);
    const result = store.update({ board: { title: "x", claim: "y", views: { picture: { html: "<script>1</script>" } } }, project });
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(store.list()).toEqual([]);
  });

  test("a torn last line is skipped and the next version still lands whole", () => {
    const { store } = storeAt(scratch());
    const first = store.update({ board: board(), project });
    if (!first.ok) throw new Error("setup");
    const folder = join(store.dir, inboxProjectKey(project.name, project.root), first.id);
    appendFileSync(join(folder, "versions.jsonl"), '{"n":2,"tit');
    expect(store.read(first.id)?.n).toBe(1);
    const next = store.update({ id: first.id, base: 1, board: board("again"), project });
    expect(next).toMatchObject({ ok: true, v: 2 });
    expect(store.versions(first.id).map((v) => v.n)).toEqual([1, 2]);
  });
});

describe("finished, drawing and seen", () => {
  test("a finished shape refuses versions and notes until it is reopened", () => {
    const { store } = storeAt(scratch());
    const first = store.update({ board: board(), project });
    if (!first.ok) throw new Error("setup");
    store.setState(first.id, "finished");
    expect(store.update({ id: first.id, base: 1, board: board("x"), project })).toMatchObject({ ok: false, code: "finished" });
    expect(store.addNote(first.id, { kind: "change", v: 1, text: "x" })).toMatchObject({ ok: false, code: "finished" });
    store.setState(first.id, "active");
    expect(store.update({ id: first.id, base: 1, board: board("x"), project })).toMatchObject({ ok: true, v: 2 });
  });

  test("drawing lasts until the next version, or ten minutes at most", () => {
    const { store, tick } = storeAt(scratch());
    const first = store.update({ board: board(), project });
    if (!first.ok) throw new Error("setup");
    store.drawing(first.id, { untilMs: 60 * 60 * 1000 });
    expect(store.list()[0]!.drawing).toBe(true);
    tick(10 * 60 * 1000 + 1);
    expect(store.list()[0]!.drawing).toBe(false);
    expect(store.get(first.id)?.drawing).toBeNull();

    store.drawing(first.id);
    store.update({ id: first.id, base: 1, board: board("x"), project });
    expect(store.get(first.id)?.drawing).toBeNull();
  });

  test("seen moves forward only, never past the latest, and drives 'changed since you looked'", () => {
    const { store } = storeAt(scratch());
    const first = store.update({ board: board(), project });
    if (!first.ok) throw new Error("setup");
    store.update({ id: first.id, base: 1, board: board("x"), project });
    expect(store.list()[0]).toMatchObject({ changed: true, seen: null });
    store.markSeen(first.id, 2);
    store.markSeen(first.id, 1);
    store.markSeen(first.id, 9);
    expect(store.seen()[first.id]).toBe(2);
    expect(store.list()[0]).toMatchObject({ changed: false, seen: 2 });
  });

  test("the newest change lists first", () => {
    const { store, tick } = storeAt(scratch());
    const a = store.update({ board: board(), project });
    tick(1000);
    const b = store.update({ board: board(), project });
    tick(1000);
    if (!a.ok || !b.ok) throw new Error("setup");
    store.update({ id: a.id, base: 1, board: board("x"), project });
    expect(store.list().map((s) => s.id)).toEqual([a.id, b.id]);
  });
});

describe("notes", () => {
  test("a change waits for the agent until one reads it, once", () => {
    const { store } = storeAt(scratch());
    const first = store.update({ board: board(), project });
    if (!first.ok) throw new Error("setup");
    const change = store.addNote(first.id, { kind: "change", v: 1, view: "picture", part: "p-whistle", quote: "whistles once", text: "Make it twice" });
    const general = store.addNote(first.id, { kind: "ask", v: 1, text: "Is this for the office kettle too?" });
    expect(change.ok && general.ok).toBe(true);
    expect(store.list()[0]!.waiting).toBe(1);

    // Reading them marks nothing: a hand-over that fails leaves them waiting.
    const waiting = store.waiting(first.id);
    expect(waiting.map((n) => n.text)).toEqual(["Make it twice", "Is this for the office kettle too?"]);
    expect(store.waiting(first.id)).toHaveLength(2);
    const marked = store.markDelivered(first.id, waiting.map((n) => n.id));
    expect(marked.every((n) => n.delivered)).toBe(true);
    expect(store.waiting(first.id)).toEqual([]);
    expect(store.markDelivered(first.id, waiting.map((n) => n.id))).toEqual([]);
    expect(store.list()[0]!.waiting).toBe(0);
    // Delivery appends; the note keeps its place and its words.
    expect(store.notes(first.id).map((n) => n.text)).toEqual(["Make it twice", "Is this for the office kettle too?"]);
  });

  test("a note on a version that does not exist is refused", () => {
    const { store } = storeAt(scratch());
    const first = store.update({ board: board(), project });
    if (!first.ok) throw new Error("setup");
    expect(store.addNote(first.id, { kind: "change", v: 3, text: "x" })).toMatchObject({ ok: false, code: "no_version" });
  });
});

describe("cited images", () => {
  test("an image the board cites by relative path is copied into files/ and the ref points at the copy", () => {
    const dataDir = scratch();
    const source = scratch();
    writeFileSync(join(source, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { store } = storeAt(dataDir);
    const withImage: ShapeBoard = { ...board(), refs: [{ n: 1, kind: "image", title: "Shot", target: "shot.png" }] };
    const result = store.update({ board: withImage, project, sourceDir: source });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const target = store.read(result.id)!.refs![0]!.target;
    expect(target).toMatch(/^files\/[0-9a-f]{10}-shot\.png$/);
    const path = store.filePath(result.id, target);
    expect(path && readFileSync(path).length).toBe(4);
    for (const outside of ["../shape.json", "files/../shape.json", "files/a/b.png", "files\\..\\shape.json", "/etc/passwd", ".lock"]) {
      expect([outside, store.filePath(result.id, outside)]).toEqual([outside, null]);
    }
  });

  test("an image is a file on this computer: a URL or a path out of files/ is refused by field", () => {
    const { store } = storeAt(scratch());
    const refs: ShapeBoard["refs"] = [
      { n: 1, kind: "image", title: "Remote", target: "https://evil.invalid/a.png" },
      { n: 2, kind: "image", title: "Steps", target: "files/ok.png", images: [{ src: "//evil.invalid/b.png", alt: "b" }, { src: "files/../shape.json", alt: "c" }] },
    ];
    const result = store.update({ board: { ...board(), refs }, project, sourceDir: scratch() });
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== "invalid") return;
    expect(result.errors.map((e) => e.slice(0, e.indexOf(":")))).toEqual(["refs[0].target", "refs[1].images[0].src", "refs[1].images[1].src"]);
  });

  test("a missing image refuses the update and leaves no half-made shape", () => {
    const dataDir = scratch();
    const { store } = storeAt(dataDir);
    const withImage: ShapeBoard = { ...board(), refs: [{ n: 1, kind: "image", title: "Shot", target: "nope.png" }] };
    const result = store.update({ board: withImage, project, sourceDir: scratch() });
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(readdirSync(join(dataDir, "shapes", inboxProjectKey(project.name, project.root)))).toEqual([]);
  });
});

describe("the lock", () => {
  // Processes, not calls: the lock is for several CLI processes at once.
  function lockedShape() {
    const dataDir = scratch();
    const { store } = storeAt(dataDir);
    const first = store.update({ board: board(), project });
    if (!first.ok) throw new Error("setup");
    const folder = join(dataDir, "shapes", inboxProjectKey(project.name, project.root), first.id);
    // A lock left by a process that died a minute ago.
    writeFileSync(join(folder, ".lock"), "dead");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(folder, ".lock"), old, old);
    return { dataDir, store, id: first.id, folder };
  }

  function updaters(dataDir: string, id: string, count: number) {
    const worker = join(scratch(), "worker.ts");
    writeFileSync(
      worker,
      `import { createShapeStore } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
const [dataDir, id, n] = process.argv.slice(2);
const board = { title: "t", claim: "c", views: { picture: { html: \`<p data-mark="a">w\${n}</p>\` } } };
const r = createShapeStore({ dataDir }).update({ board, id, base: 1, project: ${JSON.stringify(project)} });
console.log(r.ok ? "OK" : r.code);`,
    );
    const runs = Array.from({ length: count }, (_, i) =>
      Bun.spawn([process.execPath, worker, dataDir, id, String(i)], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } }),
    );
    return Promise.all(runs.map(async (p) => (await new Response(p.stdout).text()).trim()));
  }

  test("a stale lock is broken once: of many updates from the same base, exactly one lands", async () => {
    const { dataDir, store, id, folder } = lockedShape();
    const outs = await updaters(dataDir, id, 8);
    expect(outs.filter((o) => o === "OK")).toHaveLength(1);
    expect(outs.filter((o) => o === "stale_base")).toHaveLength(7);
    expect(store.versions(id)).toHaveLength(2);
    expect(readdirSync(folder).filter((f) => f.startsWith(".lock"))).toEqual([]);
  });

  test("while another process is breaking a stale lock, a waiter leaves it alone and waits", async () => {
    const { dataDir, store, id, folder } = lockedShape();
    // Someone is breaking it right now.
    writeFileSync(join(folder, ".lock.break"), "");
    const done = updaters(dataDir, id, 1);
    await Bun.sleep(400);
    expect(readFileSync(join(folder, ".lock"), "utf8")).toBe("dead");
    expect(store.versions(id)).toHaveLength(1);
    // The breaker finishes; the waiter takes the lock and lands.
    rmSync(join(folder, ".lock.break"));
    rmSync(join(folder, ".lock"));
    expect(await done).toEqual(["OK"]);
  });
});
