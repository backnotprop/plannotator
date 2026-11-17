/**
 * The thread canvas's store on a scratch data dir (no Inbox, no window). What regresses if these fail:
 * - an agent write does not become the next version waiting for a layout, so no window lays it out;
 * - a person's save from a stale page overwrites a newer canvas, or a fresh one is refused;
 * - a late or doubled layout (two windows racing, or an old version) replaces the current one;
 * - `pending` forgets a version whose picture was never kept (its message card stays blank), or keeps asking after;
 * - read-back is not empty right after a layout, or misses what the person did;
 * - the person's moves and deletions do not stick: the next agent write does not see the pins, a deleted part stays
 *   in the stored board;
 * - the CLI waits for a window when the server that said one is open is gone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasElement, CanvasParts } from "@plannotator/core/canvas-scene";
import { canvasWindowOpen, createCanvasStore, writeCanvasWindows } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ID = "msg_01M7NQW4XEMG1FHP7SNPFAAE0Y";
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

function world() {
  const root = mkdtempSync(join(tmpdir(), "canvas-store-"));
  roots.push(root);
  let t = Date.UTC(2026, 10, 17, 9);
  const store = createCanvasStore({ dataDir: root, now: () => t });
  const tick = (ms: number) => {
    t += ms;
  };
  /** An agent version, laid out as LAID_OUT. */
  const drawn = () => {
    const s = store.agentWrite(ID, { board: BOARD, pins: store.get(ID).standing.pins });
    const done = store.layoutDone(ID, { version: s.agentVersion, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 });
    if (!done.ok) throw new Error(done.message);
    return done.rev;
  };
  return { root, store, tick, drawn };
}

describe("versions and the layout", () => {
  test("an agent write is the next version, waiting for a layout; the layout makes it current", () => {
    const { store } = world();
    expect(store.exists(ID)).toBe(false);
    const s = store.agentWrite(ID, { board: BOARD, pins: {}, applied: ["added #app"] });
    expect(s.version).toBe(1);
    expect(s.agentVersion).toBe(1);
    expect(s.layout).toMatchObject({ version: 1, state: "pending" });
    expect(store.exists(ID)).toBe(true);
    expect(store.pending()).toEqual([{ id: ID, version: 1 }]);

    const done = store.layoutDone(ID, { version: 1, elements: LAID_OUT, files: {}, warnings: ["#row-2 overflows"], parts: PARTS, changed: 0 });
    expect(done).toEqual({ ok: true, rev: s.rev + 1 });
    const after = store.get(ID);
    expect(after.layout).toMatchObject({ version: 1, state: "done", warnings: ["#row-2 overflows"] });
    expect(after.scene?.elements.map((e) => e.id)).toEqual(LAID_OUT.map((e) => e.id));
    expect(store.version(ID, 1)?.scene?.elements).toHaveLength(LAID_OUT.length);
    expect(store.version(ID, 1)?.applied).toEqual(["added #app"]);
  });

  test("a layout for an old version, or a second one for the same version, is refused and changes nothing", () => {
    const { store } = world();
    store.agentWrite(ID, { board: BOARD, pins: {} });
    store.agentWrite(ID, { board: BOARD, pins: {} });
    const old = store.layoutDone(ID, { version: 1, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 });
    expect(old).toMatchObject({ ok: false, code: "stale_layout" });
    expect(store.get(ID).layout).toMatchObject({ version: 2, state: "pending" });

    expect(store.layoutDone(ID, { version: 2, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 }).ok).toBe(true);
    const rev = store.get(ID).rev;
    const twice = store.layoutDone(ID, { version: 2, elements: [], files: {}, warnings: [], parts: {}, changed: 0 });
    expect(twice).toMatchObject({ ok: false, code: "stale_layout" });
    expect(store.get(ID).rev).toBe(rev);
    expect(store.get(ID).scene?.elements).toHaveLength(LAID_OUT.length);
  });

  test("a new layout keeps the person's own elements and replaces the agent's", () => {
    const { store, drawn } = world();
    const rev = drawn();
    const ink: CanvasElement = { id: "ink-1", type: "freedraw", x: 500, y: 500, width: 30, height: 30, points: [[0, 0], [30, 30]] };
    expect(store.personSave(ID, { base: rev, elements: [...LAID_OUT, ink], files: {} }).ok).toBe(true);
    const s = store.agentWrite(ID, { board: BOARD, pins: {} });
    const relaid = LAID_OUT.map((e) => ({ ...e, y: e.y + 5 }));
    expect(store.layoutDone(ID, { version: s.agentVersion, elements: relaid, files: {}, warnings: [], parts: PARTS, changed: 5 }).ok).toBe(true);
    const ids = store.get(ID).scene!.elements.map((e) => e.id);
    expect(ids).toContain("ink-1");
    expect(ids.filter((id) => id === "row-1")).toHaveLength(1);
    expect(store.get(ID).scene!.elements.find((e) => e.id === "row-1")!.y).toBe(105);
    expect(store.versions(ID).find((v) => v.n === s.agentVersion)?.changed).toBe(5);
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
    const next = store.agentWrite(ID, { board: s.board, pins: s.standing.pins });
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

describe("pictures and pending", () => {
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

  test("a picture that is not one, or older than the kept one, is refused", () => {
    const { store, drawn } = world();
    const rev = drawn();
    expect(store.savePicture(ID, { rev, bytes: new TextEncoder().encode("not a png") })).toBe(false);
    expect(store.picturePath(ID)).toBeNull();
    expect(store.savePicture(ID, { rev, bytes: PNG })).toBe(true);
    expect(store.savePicture(ID, { rev: rev - 1, bytes: PNG })).toBe(false);
    expect(store.get(ID).png).toEqual({ rev });
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
    expect(() => store.agentWrite("../escape", { board: BOARD, pins: {} })).toThrow();
    expect(store.exists("../escape")).toBe(false);
    expect(store.filePath("../escape", "x.png")).toBeNull();
  });
});
