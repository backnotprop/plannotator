/**
 * The thread canvas's store on a scratch data dir (no Inbox, no window). What regresses if these fail:
 * - an agent write does not become the next version waiting for a layout, so no window lays it out;
 * - a person's save from a stale page overwrites a newer canvas, or a fresh one is refused;
 * - an agent's write built before the person moved or deleted a part lands and undoes it, or one built after a
 *   change that touched no pin is refused;
 * - a late or doubled layout (two windows racing, or an old version, or one read before the person's pins changed)
 *   replaces the current one;
 * - `pending` forgets a version whose picture was never kept (its message card stays blank), keeps asking after, asks
 *   for a picture of nothing, or keeps asking a window to lay out a board windows cannot lay out;
 * - read-back is not empty right after a layout, or misses what the person did;
 * - the person's moves and deletions do not stick: the next agent write does not see the pins, a deleted part stays
 *   in the stored board;
 * - a scene on disk brings an iframe, an embed, a link or foreign customData into a read;
 * - reading the state, `pending` or the version list parses scenes; an older single-file canvas is lost;
 * - versions and pictures pile up forever, or a picture still used is removed; a deleted thread's canvas stays;
 * - the CLI waits for a window when the server that said one is open is gone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardPin } from "@plannotator/core/canvas-board";
import type { CanvasElement, CanvasParts } from "@plannotator/core/canvas-scene";
import { CANVAS_KEEP_VERSIONS, canvasBase, canvasWindowOpen, createCanvasStore, removeGoneCanvases, writeCanvasWindows, type CanvasStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ID = "msg_01M7NQW4XEMG1FHP7SNPFAAE0Y";
const OTHER = "msg_01M7NQW4XEMG1FHP7SNPFAAE0Z";
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

const BOARD = '<div id="app" data-frame="phone">\n <div id="row-1"><p id="row-1-label">Push alerts</p></div>\n <div id="row-2"><p id="row-2-label">Email</p></div>\n</div>\n';
const PARTS: CanvasParts = {
  app: { parent: null, kind: "frame" },
  "row-1": { parent: "app", kind: "box", words: "Push alerts" },
  "row-1-label": { parent: "row-1", kind: "text", words: "Push alerts" },
  "row-2": { parent: "app", kind: "box", words: "Email" },
  "row-2-label": { parent: "row-2", kind: "text", words: "Email" },
};
const el = (id: string, part: string, x: number, y: number, w: number, h: number, extra: Partial<CanvasElement> = {}): CanvasElement => ({ id, type: "rectangle", x, y, width: w, height: h, customData: { part }, ...extra });
const LAID_OUT: CanvasElement[] = [
  el("app", "app", 0, 0, 390, 800),
  el("row-1", "row-1", 10, 100, 370, 50),
  el("row-1-label", "row-1-label", 20, 115, 100, 20, { type: "text", text: "Push alerts" }),
  el("row-2", "row-2", 10, 160, 370, 50),
  el("row-2-label", "row-2-label", 20, 175, 60, 20, { type: "text", text: "Email" }),
];
const moved = (els: CanvasElement[], part: string, dx: number, dy: number) => els.map((e) => (e.id === part || e.id.startsWith(`${part}-`) ? { ...e, x: e.x + dx, y: e.y + dy } : e));

/** An agent write built on what the store holds now (as the CLI builds it). */
function write(store: CanvasStore, id = ID, input: { board?: string; pins?: Record<string, BoardPin>; applied?: string[] } = {}) {
  const s = store.meta(id);
  const w = store.agentWrite(id, { base: canvasBase(s), board: input.board ?? BOARD, pins: input.pins ?? s.standing.pins, applied: input.applied });
  if (!w.ok) throw new Error(w.message);
  return w.state;
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "canvas-store-"));
  roots.push(root);
  let t = Date.UTC(2026, 10, 17, 9);
  const store = createCanvasStore({ dataDir: root, now: () => t });
  const tick = (ms: number) => {
    t += ms;
  };
  /** An agent version, laid out as LAID_OUT. */
  const drawn = (id = ID) => {
    const s = write(store, id);
    const done = store.layoutDone(id, { version: s.agentVersion, rev: s.rev, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 });
    if (!done.ok) throw new Error(done.message);
    return done.rev;
  };
  const folder = (id = ID) => join(root, "canvases", id);
  return { root, store, tick, drawn, folder };
}

describe("versions and the layout", () => {
  test("an agent write is the next version, waiting for a layout; the layout makes it current", () => {
    const { store } = world();
    expect(store.exists(ID)).toBe(false);
    const s = write(store, ID, { pins: {}, applied: ["added #app"] });
    expect(s.version).toBe(1);
    expect(s.agentVersion).toBe(1);
    expect(s.layout).toMatchObject({ version: 1, state: "pending" });
    expect(store.exists(ID)).toBe(true);
    expect(store.pending()).toEqual([{ id: ID, version: 1 }]);

    const done = store.layoutDone(ID, { version: 1, rev: s.rev, elements: LAID_OUT, files: {}, warnings: ["#row-2 overflows"], parts: PARTS, changed: 0 });
    expect(done).toEqual({ ok: true, rev: s.rev + 1 });
    const after = store.get(ID);
    expect(after.layout).toMatchObject({ version: 1, state: "done", warnings: ["#row-2 overflows"] });
    expect(after.scene?.elements.map((e) => e.id)).toEqual(LAID_OUT.map((e) => e.id));
    expect(store.version(ID, 1)?.scene?.elements).toHaveLength(LAID_OUT.length);
    expect(store.version(ID, 1)?.applied).toEqual(["added #app"]);
  });

  test("a layout for an old version, or a second one for the same version, is refused and changes nothing", () => {
    const { store } = world();
    write(store);
    const s = write(store);
    const old = store.layoutDone(ID, { version: 1, rev: s.rev, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 });
    expect(old).toMatchObject({ ok: false, code: "stale_layout" });
    expect(store.get(ID).layout).toMatchObject({ version: 2, state: "pending" });

    expect(store.layoutDone(ID, { version: 2, rev: s.rev, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 }).ok).toBe(true);
    const rev = store.get(ID).rev;
    const twice = store.layoutDone(ID, { version: 2, rev, elements: [], files: {}, warnings: [], parts: {}, changed: 0 });
    expect(twice).toMatchObject({ ok: false, code: "stale_layout" });
    expect(store.get(ID).rev).toBe(rev);
    expect(store.get(ID).scene?.elements).toHaveLength(LAID_OUT.length);
  });

  test("a layout read before the person's pins or deletions changed is refused; one read after is taken", () => {
    const { store, drawn } = world();
    const rev = drawn();
    const s = write(store);
    // The window read the canvas at s.rev and lays out; meanwhile the person deletes row 2.
    const saved = store.personSave(ID, { base: s.rev, elements: LAID_OUT.filter((e) => !e.id.startsWith("row-2")), files: {} });
    expect(saved).toMatchObject({ ok: true, deleted: ["row-2"] });
    expect(store.meta(ID).standingRev).toBe(store.meta(ID).rev);
    const stale = store.layoutDone(ID, { version: s.agentVersion, rev: s.rev, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 });
    expect(stale).toMatchObject({ ok: false, code: "stale_layout" });
    expect(store.meta(ID).layout).toMatchObject({ state: "pending" });
    const fresh = store.layoutDone(ID, { version: s.agentVersion, rev: store.meta(ID).rev, elements: LAID_OUT.slice(0, 3), files: {}, warnings: [], parts: PARTS, changed: 1 });
    expect(fresh.ok).toBe(true);
    expect(rev).toBeLessThan(store.meta(ID).rev);
  });

  test("a new layout keeps the person's own elements and replaces the agent's", () => {
    const { store, drawn } = world();
    const rev = drawn();
    const ink: CanvasElement = { id: "ink-1", type: "freedraw", x: 500, y: 500, width: 30, height: 30, points: [[0, 0], [30, 30]] };
    expect(store.personSave(ID, { base: rev, elements: [...LAID_OUT, ink], files: {} }).ok).toBe(true);
    const s = write(store, ID, { pins: {} });
    const relaid = LAID_OUT.map((e) => ({ ...e, y: e.y + 5 }));
    expect(store.layoutDone(ID, { version: s.agentVersion, rev: s.rev, elements: relaid, files: {}, warnings: [], parts: PARTS, changed: 5 }).ok).toBe(true);
    const ids = store.get(ID).scene!.elements.map((e) => e.id);
    expect(ids).toContain("ink-1");
    expect(ids.filter((id) => id === "row-1")).toHaveLength(1);
    expect(store.get(ID).scene!.elements.find((e) => e.id === "row-1")!.y).toBe(105);
    expect(store.versions(ID).find((v) => v.n === s.agentVersion)?.changed).toBe(5);
  });

  test("a version windows cannot lay out fails on the third report, is no longer pending, and says why", () => {
    const { store } = world();
    const s = write(store);
    expect(store.layoutFailed(ID, { version: s.agentVersion, error: "the lift timed out" })).toEqual({ ok: true, state: "pending", attempts: 1 });
    expect(store.layoutFailed(ID, { version: s.agentVersion, error: "the lift timed out" })).toEqual({ ok: true, state: "pending", attempts: 2 });
    expect(store.pending()).toEqual([{ id: ID, version: 1 }]);
    expect(store.layoutFailed(ID, { version: s.agentVersion, error: "the lift timed out" })).toEqual({ ok: true, state: "failed", attempts: 3 });
    expect(store.meta(ID).layout).toMatchObject({ version: 1, state: "failed", warnings: ["the lift timed out"] });
    expect(store.pending()).toEqual([]);
    // Failed is final for that version; the agent's next write is pending again.
    expect(store.layoutFailed(ID, { version: 1, error: "x" })).toMatchObject({ ok: false, code: "stale_layout" });
    write(store);
    expect(store.pending()).toEqual([{ id: ID, version: 2 }]);
  });

  test("a laid-out scene with nothing live in it is never pending for a picture", () => {
    const { store } = world();
    const s = write(store);
    expect(store.layoutDone(ID, { version: 1, rev: s.rev, elements: LAID_OUT.map((e) => ({ ...e, isDeleted: true })), files: {}, warnings: [], parts: PARTS, changed: 0 }).ok).toBe(true);
    expect(store.pending()).toEqual([]);
  });
});

describe("the agent's write names what it was built on", () => {
  test("refused when the person moved or deleted a part, or another version was written, since the read", () => {
    const { store, drawn } = world();
    const rev = drawn();
    const before = store.meta(ID);
    expect(store.personSave(ID, { base: rev, elements: moved(LAID_OUT, "row-1", 30, 0), files: {} }).ok).toBe(true);
    const refused = store.agentWrite(ID, { base: canvasBase(before), board: BOARD, pins: before.standing.pins });
    expect(refused).toMatchObject({ ok: false, code: "stale_standing" });
    expect(store.meta(ID).agentVersion).toBe(1);
    expect(store.meta(ID).standing.pins["row-1"]).toBeDefined();

    const now = store.meta(ID);
    write(store);
    expect(store.agentWrite(ID, { base: canvasBase(now), board: BOARD, pins: now.standing.pins })).toMatchObject({ ok: false, code: "stale_standing" });
  });

  test("taken when the person only drew beside the board (no pin or deletion changed)", () => {
    const { store, drawn } = world();
    const rev = drawn();
    const before = store.meta(ID);
    const ink: CanvasElement = { id: "ink-1", type: "freedraw", x: 500, y: 500, width: 30, height: 30, points: [[0, 0], [30, 30]] };
    expect(store.personSave(ID, { base: rev, elements: [...LAID_OUT, ink], files: {} }).ok).toBe(true);
    expect(store.meta(ID).standingRev).toBe(before.standingRev);
    expect(store.agentWrite(ID, { base: canvasBase(before), board: BOARD, pins: before.standing.pins }).ok).toBe(true);
  });
});

describe("the person's saves", () => {
  test("a save from a stale rev is refused with the current rev; the current rev saves and bumps it", () => {
    const { store, drawn } = world();
    const rev = drawn();
    const stale = store.personSave(ID, { base: rev - 1, elements: [], files: {} });
    expect(stale).toEqual({ ok: false, code: "stale_base", message: expect.any(String), rev });
    expect(store.get(ID).scene?.elements).toHaveLength(LAID_OUT.length);

    const ok = store.personSave(ID, { base: rev, elements: moved(LAID_OUT, "row-1", 0, 40), files: {} });
    expect(ok).toMatchObject({ ok: true, rev: rev + 1 });
    expect(store.get(ID).rev).toBe(rev + 1);
    // The page that saved before is now stale.
    expect(store.personSave(ID, { base: rev, elements: LAID_OUT, files: {} }).ok).toBe(false);
  });

  test("a person's saves in a row are one version; an agent version between starts a new one", () => {
    const { store, drawn, tick } = world();
    const rev = drawn();
    const a = store.personSave(ID, { base: rev, elements: moved(LAID_OUT, "row-1", 0, 10), files: {} });
    tick(60_000);
    const b = store.personSave(ID, { base: a.ok ? a.rev : -1, elements: moved(LAID_OUT, "row-1", 0, 20), files: {} });
    expect(a.ok && b.ok && a.version === b.version).toBe(true);
    expect(store.versions(ID).map((v) => v.by)).toEqual(["agent", "person"]);
    drawn();
    const c = store.personSave(ID, { base: store.get(ID).rev, elements: LAID_OUT, files: {} });
    expect(c.ok && c.version).toBe(4);
    expect(store.versions(ID).map((v) => v.by)).toEqual(["agent", "person", "agent", "person"]);
  });

  test("read-back is empty right after a layout and tells the person's change after a save", () => {
    const { store, drawn } = world();
    const rev = drawn();
    expect(store.readBack(ID)).toEqual([]);
    store.personSave(ID, { base: rev, elements: moved(LAID_OUT, "row-1", 30, 0), files: {} });
    expect(store.readBack(ID)).toEqual(['moved #row-1 ("Push alerts") by +30,+0']);
  });

  test("a moved part is pinned and a deleted one is gone from the board; the next agent write sees both", () => {
    const { store, drawn } = world();
    const rev = drawn();
    const now = moved(LAID_OUT, "row-1", 30, 0).filter((e) => !e.id.startsWith("row-2"));
    const saved = store.personSave(ID, { base: rev, elements: now, files: {} });
    expect(saved).toMatchObject({ ok: true, deleted: ["row-2"] });
    const s = store.get(ID);
    expect(s.standing.pins).toEqual({ "row-1": { x: 40, y: 100, w: 370, h: 50 } });
    expect(s.standing.deleted).toEqual(["row-2"]);
    expect(s.board).not.toContain('id="row-2"');
    expect(s.board).toContain('id="row-1"');
    expect(s.standing.deletedHtml["row-2"]).toContain("Email");

    // The CLI passes the standing pins on; the store keeps the deletions across the agent's write.
    const next = write(store, ID, { board: s.board });
    expect(next.standing.pins).toEqual({ "row-1": { x: 40, y: 100, w: 370, h: 50 } });
    expect(next.standing.deleted).toEqual(["row-2"]);
  });

  test("a pasted picture is kept under files/ only when its bytes are a picture", () => {
    const { store, drawn } = world();
    const rev = drawn();
    const files = { f1: { name: "paste-1.png", mimeType: "image/png" }, f2: { name: "paste-2.png", mimeType: "image/png" } };
    const img = (id: string, fileId: string): CanvasElement => ({ id, type: "image", x: 500, y: 0, width: 50, height: 50, fileId });
    const uploads = { f1: { mimeType: "image/png", bytes: PNG }, f2: { mimeType: "image/png", bytes: new TextEncoder().encode("<script>") } };
    expect(store.personSave(ID, { base: rev, elements: [...LAID_OUT, img("i1", "f1"), img("i2", "f2")], files, uploads }).ok).toBe(true);
    expect(store.filePath(ID, "paste-1.png")).not.toBeNull();
    expect(store.filePath(ID, "paste-2.png")).toBeNull();
    expect(store.filePath(ID, "../canvas.json")).toBeNull();
    expect(store.readBack(ID).some((l) => l.startsWith("pasted a picture") && l.endsWith("paste-1.png"))).toBe(true);
  });

  test("an SVG is never kept as a picture, whatever its name says: pasted, copied in by the agent, or as the canvas's picture", () => {
    const { root, store, drawn } = world();
    const rev = drawn();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const files = { s: { name: "shot.png", mimeType: "image/png" } };
    store.personSave(ID, { base: rev, elements: [...LAID_OUT, { id: "i", type: "image", x: 0, y: 0, width: 9, height: 9, fileId: "s" }], files, uploads: { s: { mimeType: "image/png", bytes: svg } } });
    expect(store.filePath(ID, "shot.png")).toBeNull();
    const disguised = join(root, "shot.png");
    writeFileSync(disguised, svg);
    expect(store.copyPicture(ID, disguised)).toMatchObject({ ok: false });
    expect(store.savePicture(ID, { rev: store.get(ID).rev, bytes: svg })).toBe(false);
    const real = join(root, "real.png");
    writeFileSync(real, PNG);
    expect(store.copyPicture(ID, real)).toMatchObject({ ok: true });
  });
});

describe("what a read takes from disk", () => {
  test("a scene on disk with an iframe, an embed, a link or foreign customData is cleaned on every read", () => {
    const { store, drawn, folder } = world();
    drawn();
    const planted = [
      ...LAID_OUT,
      { id: "frame-1", type: "iframe", x: 0, y: 0, width: 10, height: 10, customData: { generationData: { html: "<script>alert(1)</script>" } } },
      { id: "embed-1", type: "embeddable", x: 0, y: 0, width: 10, height: 10, link: "https://example.com" },
      { id: "linked", type: "rectangle", x: 0, y: 0, width: 10, height: 10, link: "javascript:alert(1)", customData: { part: "row-1", role: "box", onload: "x" } },
    ];
    writeFileSync(join(folder(), "scene.json"), JSON.stringify({ elements: planted, files: { f: { name: "../canvas.json", mimeType: "image/png" } } }));
    writeFileSync(join(folder(), "versions", "1.json"), JSON.stringify({ n: 1, by: "agent", at: "2026-11-17T09:00:00.000Z", scene: { elements: planted, files: {} } }));
    for (const scene of [store.get(ID).scene!, store.version(ID, 1)!.scene!]) {
      const ids = scene.elements.map((e) => e.id);
      expect(ids).not.toContain("frame-1");
      expect(ids).not.toContain("embed-1");
      const linked = scene.elements.find((e) => e.id === "linked")!;
      expect(linked.link).toBeNull();
      expect(linked.customData).toEqual({ part: "row-1", role: "box" });
    }
    expect(store.get(ID).scene!.files).toEqual({});
  });

  test("the state, pending and the version list never read a scene: broken scene and version files do not stop them", () => {
    const { store, drawn, folder } = world();
    drawn();
    const state = JSON.parse(readFileSync(join(folder(), "canvas.json"), "utf8")) as Record<string, unknown>;
    expect("scene" in state || "laidOut" in state).toBe(false);
    writeFileSync(join(folder(), "scene.json"), "{ not json");
    writeFileSync(join(folder(), "versions", "1.json"), "{ not json");
    expect(store.meta(ID)).toMatchObject({ agentVersion: 1, layout: { state: "done" } });
    expect(store.pending()).toEqual([{ id: ID, version: 1, picture: true }]);
    expect(store.versions(ID)).toEqual([{ n: 1, by: "agent", at: expect.any(String), changed: 0, picture: false }]);
  });

  test("an older canvas (everything in canvas.json, no version index) reads as before and is split by its next write", () => {
    const { store, folder } = world();
    mkdirSync(join(folder(), "versions"), { recursive: true });
    const scene = { elements: LAID_OUT, files: {} };
    writeFileSync(
      join(folder(), "canvas.json"),
      JSON.stringify({ id: ID, rev: 2, version: 1, agentVersion: 1, board: BOARD, standing: { pins: {}, deleted: [], deletedHtml: {} }, parts: PARTS, scene, laidOut: LAID_OUT, layout: { version: 1, state: "done", warnings: [], at: "2026-11-17T09:00:00.000Z" }, png: null, updated: "2026-11-17T09:00:00.000Z" }),
    );
    writeFileSync(join(folder(), "versions", "1.json"), JSON.stringify({ n: 1, by: "agent", at: "2026-11-17T09:00:00.000Z", changed: 3, scene }));
    expect(store.get(ID).scene!.elements).toHaveLength(LAID_OUT.length);
    expect(store.versions(ID)).toEqual([{ n: 1, by: "agent", at: "2026-11-17T09:00:00.000Z", changed: 3, picture: false }]);
    expect(store.readBack(ID)).toEqual([]);

    expect(store.personSave(ID, { base: 2, elements: moved(LAID_OUT, "row-1", 30, 0), files: {} }).ok).toBe(true);
    const state = JSON.parse(readFileSync(join(folder(), "canvas.json"), "utf8")) as Record<string, unknown>;
    expect("scene" in state || "laidOut" in state).toBe(false);
    expect(existsSync(join(folder(), "versions", "index.json"))).toBe(true);
    expect(store.readBack(ID)).toEqual(['moved #row-1 ("Push alerts") by +30,+0']);
    expect(store.versions(ID).map((v) => [v.n, v.by])).toEqual([[1, "agent"], [2, "person"]]);
  });
});

describe("pictures, pending and what is kept", () => {
  test("a laid-out version with no picture kept is pending for its picture only, until the picture is kept", () => {
    const { store, drawn } = world();
    const rev = drawn();
    expect(store.pending()).toEqual([{ id: ID, version: 1, picture: true }]);
    expect(store.versions(ID)[0]!.picture).toBe(false);
    expect(store.savePicture(ID, { rev, version: 1, bytes: PNG })).toBe(true);
    expect(store.pending()).toEqual([]);
    expect(store.versions(ID)[0]!.picture).toBe(true);
    expect(store.picturePath(ID, 1)).not.toBeNull();
    expect(store.picturePath(ID)).not.toBeNull();
  });

  test("a picture that is not one, older than the kept one, or for a version that does not exist, is refused", () => {
    const { store, drawn } = world();
    const rev = drawn();
    expect(store.savePicture(ID, { rev, bytes: new TextEncoder().encode("not a png") })).toBe(false);
    expect(store.picturePath(ID)).toBeNull();
    expect(store.savePicture(ID, { rev, version: 7, bytes: PNG })).toBe(false);
    expect(store.picturePath(ID)).toBeNull();
    expect(store.picturePath(ID, 7)).toBeNull();
    expect(store.savePicture(ID, { rev, bytes: PNG })).toBe(true);
    expect(store.savePicture(ID, { rev: rev - 1, bytes: PNG })).toBe(false);
    expect(store.get(ID).png).toEqual({ rev });
  });

  test(`only the newest ${CANVAS_KEEP_VERSIONS} versions are kept, and the agent's latest however old`, () => {
    const { store, drawn, tick } = world();
    let rev = drawn();
    expect(store.savePicture(ID, { rev, version: 1, bytes: PNG })).toBe(true);
    write(store); // v2, pruned later
    rev = store.layoutDone(ID, { version: 2, rev: store.meta(ID).rev, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 }).ok ? store.meta(ID).rev : -1;
    expect(store.savePicture(ID, { rev, version: 2, bytes: PNG })).toBe(true);
    // The agent's v3, then 55 of the person's versions (each more than the join time after the last).
    rev = drawn();
    for (let i = 0; i < 55; i++) {
      tick(11 * 60 * 1000);
      const saved = store.personSave(ID, { base: rev, elements: moved(LAID_OUT, "row-1", 0, i), files: {} });
      if (!saved.ok) throw new Error(saved.message);
      rev = saved.rev;
    }
    const kept = store.versions(ID).map((v) => v.n);
    expect(kept).toHaveLength(CANVAS_KEEP_VERSIONS + 1);
    expect(kept[0]).toBe(3);
    expect(kept.at(-1)).toBe(58);
    expect(store.version(ID, 1)).toBeNull();
    expect(store.picturePath(ID, 2)).toBeNull();
    expect(store.version(ID, 3)?.by).toBe("agent");
    expect(readdirSync(join(store.folder(ID), "versions")).filter((f) => f.endsWith(".json") && f !== "index.json")).toHaveLength(CANVAS_KEEP_VERSIONS + 1);
  });

  test("a new version removes pictures nothing names, but not one in use or one copied in moments ago", () => {
    const { root, store, drawn, tick } = world();
    const rev = drawn();
    const pic = (name: string) => {
      const p = join(root, name);
      writeFileSync(p, Buffer.concat([Buffer.from(PNG), Buffer.from(name)]));
      const c = store.copyPicture(ID, p);
      if (!c.ok) throw new Error(c.error);
      return c.name;
    };
    const used = pic("used.png");
    const orphan = pic("orphan.png");
    const onBoard = pic("board.png");
    const image = { id: "i1", type: "image", x: 0, y: 0, width: 9, height: 9, fileId: "f1" };
    const files = { f1: { name: used, mimeType: "image/png" } };
    // The person pastes one (v2); the agent's next board names another by its files/ path (v3).
    tick(11 * 60 * 1000);
    expect(store.personSave(ID, { base: rev, elements: [...LAID_OUT, image], files }).ok).toBe(true);
    write(store, ID, { board: BOARD.replace("Email</p>", `Email</p><img id="pic" src="files/${onBoard}">`) });
    // An hour on, one more is copied in, then the person's next version starts.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const n of [used, orphan, onBoard]) utimesSync(join(store.folder(ID), "files", n), old, old);
    const fresh = pic("fresh.png");
    expect(store.personSave(ID, { base: store.meta(ID).rev, elements: [...LAID_OUT, image], files }).ok).toBe(true);
    const left = readdirSync(join(store.folder(ID), "files")).sort();
    expect(left).toEqual([onBoard, fresh, used].sort());
    expect(left).not.toContain(orphan);
  });

  test("a deleted thread's canvas folder goes; another thread's stays", () => {
    const { root, store, drawn } = world();
    drawn();
    drawn(OTHER);
    expect(removeGoneCanvases(root, (id) => id === OTHER)).toEqual([ID]);
    expect(existsSync(store.folder(ID))).toBe(false);
    expect(store.exists(OTHER)).toBe(true);
    expect(removeGoneCanvases(root, () => true)).toEqual([]);
  });
});

describe("whether a window is open", () => {
  test("open only while the server that wrote it says one is and is still running", () => {
    const { root } = world();
    expect(canvasWindowOpen(root, () => true)).toBe(false);
    writeCanvasWindows(root, 1, 4242);
    expect(canvasWindowOpen(root, (pid) => pid === 4242)).toBe(true);
    expect(canvasWindowOpen(root, () => false)).toBe(false);
    writeCanvasWindows(root, 0, 4242);
    expect(canvasWindowOpen(root, () => true)).toBe(false);
  });

  test("a store refuses an id that is not a thread's", () => {
    const { store } = world();
    expect(() => store.agentWrite("../escape", { base: { standingRev: 0, agentVersion: 0 }, board: BOARD, pins: {} })).toThrow();
    expect(store.exists("../escape")).toBe(false);
    expect(store.filePath("../escape", "x.png")).toBeNull();
  });
});
