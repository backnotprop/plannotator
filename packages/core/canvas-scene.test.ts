/**
 * The thread canvas's scene read without Excalidraw (canvas-scene.ts): what the person moved, resized, deleted and
 * drew, by the agent's ids. What regresses: a part that moved with its container listed as moved on its own, a
 * button dragged off its label not pinned (so the agent's next patch snaps it back), a deleted container's
 * insides kept as pins, or read-back lines naming the wrong part or numbers.
 */
import { describe, expect, test } from "bun:test";
import { emptyStanding } from "./canvas-board";
import { changedParts, deletedParts, partAndInside, partOf, readBackLines, standingAfter, type CanvasElement, type CanvasParts } from "./canvas-scene";

const el = (id: string, x: number, y: number, w: number, h: number, more: Partial<CanvasElement> = {}): CanvasElement => {
  const part = id.split("~")[0];
  return { id, type: "rectangle", x, y, width: w, height: h, customData: { part }, ...more };
};
const mine = (id: string, type: string, x: number, y: number, w: number, h: number, more: Partial<CanvasElement> = {}): CanvasElement => ({ id, type, x, y, width: w, height: h, ...more });

const parts: CanvasParts = {
  app: { parent: null, kind: "frame" },
  title: { parent: "app", kind: "text", words: "Settings" },
  "row-1": { parent: "app", kind: "box" },
  "row-1-label": { parent: "row-1", kind: "text", words: "Push alerts" },
  "row-2": { parent: "app", kind: "box" },
  "row-2-label": { parent: "row-2", kind: "text", words: "Email updates" },
  note: { parent: null, kind: "note", words: "Starts off" },
  "arrow-note-row-2": { parent: null, kind: "arrow" },
};

const laidOut: CanvasElement[] = [
  el("app", 0, 0, 400, 800),
  el("title", 20, 20, 200, 30, { type: "text", text: "Settings" }),
  el("row-1", 20, 100, 360, 50),
  el("row-1-label~t", 30, 110, 120, 20, { type: "text", text: "Push alerts" }),
  el("row-2", 20, 160, 360, 50),
  el("row-2-label~t", 30, 170, 120, 20, { type: "text", text: "Email updates" }),
  el("note", 500, 160, 200, 60),
  el("arrow-note-row-2", 380, 185, 120, 0, { type: "arrow", points: [[0, 0], [120, 0]] }),
];

const shift = (els: CanvasElement[], ids: string[], dx: number, dy: number) => els.map((e) => (ids.some((i) => e.id === i || e.id.startsWith(`${i}~`)) ? { ...e, x: e.x + dx, y: e.y + dy } : e));
const without = (els: CanvasElement[], ids: string[]) => els.map((e) => (ids.some((i) => e.id === i || e.id.startsWith(`${i}~`)) ? { ...e, isDeleted: true } : e));

describe("whose element is it", () => {
  test("an agent part is its own id or starts with it; a pasted copy (new id) is the person's", () => {
    expect(partOf(el("row-2", 0, 0, 1, 1))).toBe("row-2");
    expect(partOf(el("row-2-label~t", 0, 0, 1, 1))).toBe("row-2-label");
    expect(partOf({ ...el("row-2", 0, 0, 1, 1), id: "Xy3_copy" })).toBeNull();
    expect(partOf(mine("ink1", "freedraw", 0, 0, 1, 1))).toBeNull();
  });
});

describe("changedParts", () => {
  test("a whole container moved: only the container is listed, by how far", () => {
    const now = shift(laidOut, ["app", "title", "row-1", "row-1-label", "row-2", "row-2-label"], 40, -10);
    expect(changedParts(laidOut, now, parts).map((c) => [c.id, c.moved])).toEqual([["app", { dx: 40, dy: -10 }]]);
  });

  test("a part moved inside an unmoved container is listed alone; its label went with it", () => {
    const now = shift(laidOut, ["row-2", "row-2-label"], 22, 23);
    const out = changedParts(laidOut, now, parts);
    expect(out.map((c) => c.id)).toEqual(["row-2"]);
    expect(out[0].moved).toEqual({ dx: 22, dy: 23 });
    expect(out[0].resized).toBeNull();
  });

  test("resized: the new size of its own shape", () => {
    const now = laidOut.map((e) => (e.id === "row-2" ? { ...e, width: 360, height: 85 } : e));
    const out = changedParts(laidOut, now, parts);
    expect(out.map((c) => [c.id, c.resized])).toEqual([["row-2", { w: 360, h: 85 }]]);
    expect(out[0].box).toEqual({ x: 20, y: 160, w: 360, h: 85 });
  });

  test("its own shape dragged off its label: moved, and pinned where its shape is now", () => {
    const now = shift(laidOut, ["row-2"], 0, 300);
    const out = changedParts(laidOut, now, parts);
    const row = out.find((c) => c.id === "row-2");
    expect(row?.moved).toEqual({ dx: 0, dy: 300 });
    expect(row?.box).toEqual({ x: 20, y: 460, w: 360, h: 50 });
  });

  test("nothing changed, or only an arrow moved: nothing listed", () => {
    expect(changedParts(laidOut, laidOut, parts)).toEqual([]);
    expect(changedParts(laidOut, shift(laidOut, ["arrow-note-row-2"], 5, 5), parts)).toEqual([]);
  });
});

describe("deletions and standing", () => {
  test("a deleted container is listed once; what only went with it (its label, its note's arrow) is not", () => {
    const now = without(laidOut, ["row-2", "row-2-label"]);
    expect(deletedParts(laidOut, now, parts)).toEqual(["row-2"]);
    expect(partAndInside("row-2", parts).sort()).toEqual(["row-2", "row-2-label"]);
  });

  test("standingAfter pins what moved, keeps earlier pins at their box now, and drops pins inside a newly deleted part", () => {
    const earlier = { ...emptyStanding(), pins: { "row-2-label": { x: 30, y: 170, w: 120, h: 20 }, title: { x: 0, y: 0, w: 1, h: 1 } } };
    const now = without(shift(laidOut, ["row-1", "row-1-label"], 10, 0), ["row-2", "row-2-label"]);
    const { pins, newlyDeleted } = standingAfter(laidOut, now, parts, earlier);
    expect(newlyDeleted).toEqual(["row-2"]);
    expect(Object.keys(pins).sort()).toEqual(["row-1", "title"]);
    expect(pins["row-1"]).toEqual({ x: 30, y: 100, w: 360, h: 50 });
    expect(pins.title).toEqual({ x: 20, y: 20, w: 200, h: 30 });
  });

  test("a part already deleted is not deleted again", () => {
    const now = without(laidOut, ["row-2", "row-2-label"]);
    expect(standingAfter(laidOut, now, parts, { ...emptyStanding(), deleted: ["row-2"] }).newlyDeleted).toEqual([]);
  });
});

describe("readBackLines", () => {
  test("moved and resized parts, by id with their words and the numbers", () => {
    const now = shift(laidOut, ["row-1", "row-1-label"], 22, 23).map((e) => (e.id === "row-2" ? { ...e, width: 360, height: 85 } : e));
    const lines = readBackLines({ laidOut, now, parts });
    expect(lines).toContain('moved #row-1 by +22,+23');
    expect(lines).toContain("resized #row-2 to 360x85");
  });

  test("deleted parts and changed words", () => {
    const now = without(laidOut, ["note"]).map((e) => (e.id === "title" ? { ...e, text: "Preferences" } : e));
    const lines = readBackLines({ laidOut, now, parts });
    expect(lines).toContain('deleted #note ("Starts off")');
    expect(lines).toContain('changed the words of #title to "Preferences"');
  });

  test("ink: a loop around a row names the row; an open stroke names what it crosses", () => {
    const loop = mine("ink1", "freedraw", 10, 150, 0, 0, { points: [[0, 0], [380, 0], [380, 70], [0, 70], [2, 3]] });
    const lines = readBackLines({ laidOut, now: [...laidOut, loop], parts });
    expect(lines).toEqual(['drew a loop around #row-2']);
    const stroke = mine("ink2", "freedraw", 200, 105, 0, 0, { points: [[0, 0], [0, 40]] });
    expect(readBackLines({ laidOut, now: [...laidOut, stroke], parts })[0]).toContain("drew a stroke over #row-1");
  });

  test("words the person wrote are told level with the row they sit beside", () => {
    const words = mine("w1", "text", 420, 175, 160, 20, { text: "make this the first row" });
    expect(readBackLines({ laidOut, now: [...laidOut, words], parts })).toEqual(['wrote "make this the first row" level with #row-2']);
  });

  test("a pasted picture is told beside the nearest top-level part, with its file", () => {
    const pic = mine("p1", "image", 760, 100, 200, 120, { fileId: "f1" });
    const lines = readBackLines({ laidOut, now: [...laidOut, pic], parts, fileName: (id) => (id === "f1" ? "files/trip.png" : null) });
    expect(lines).toEqual(["pasted a picture right of #note: files/trip.png"]);
  });

  test("nothing done: no lines", () => {
    expect(readBackLines({ laidOut, now: laidOut, parts })).toEqual([]);
  });
});
