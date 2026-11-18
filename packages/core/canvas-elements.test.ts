/**
 * What a canvas scene may hold, wherever it crosses a boundary (the server's writes and reads, the window before
 * Excalidraw restores a scene). What regresses if these fail:
 * - an `iframe` (which renders a `srcdoc` from `customData.generationData`), an `embeddable` or an unknown element type
 *   reaches the Inbox's page from a POST or a file on disk;
 * - a link survives on an element, or `customData` carries anything but the canvas's own `part` and `role`;
 * - a write with a malformed element, or more than the cap, is taken in part instead of refused;
 * - a read throws away a whole scene for one bad element, instead of keeping the rest.
 */
import { describe, expect, test } from "bun:test";
import { CANVAS_MAX_ELEMENTS, cleanCanvasElement, cleanCanvasElements } from "./canvas-elements";

const rect = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, ...extra });

describe("one element", () => {
  test("embeds, iframes, unknown types and the selection box are never kept", () => {
    for (const type of ["iframe", "embeddable", "magicframe", "script", "selection", ""]) {
      expect([type, cleanCanvasElement(rect("e", { type }))]).toEqual([type, null]);
    }
    const generated = rect("g", { type: "iframe", customData: { generationData: { status: "done", html: "<script>alert(1)</script>" } } });
    expect(cleanCanvasElement(generated)).toBeNull();
  });

  test("a link is always null and customData keeps only the canvas's own part and role", () => {
    const out = cleanCanvasElement(rect("r", { link: "javascript:alert(1)", customData: { part: "row-1", role: "box", generationData: { html: "<b>" }, onload: "x" } }));
    expect(out).toMatchObject({ id: "r", type: "rectangle", link: null, customData: { part: "row-1", role: "box" } });
    expect(Object.keys(out!.customData!)).toEqual(["part", "role"]);
    expect(cleanCanvasElement(rect("n", { customData: { part: 7, role: { x: 1 } } }))!.customData).toBeNull();
    expect(cleanCanvasElement(rect("l", { customData: { part: "p".repeat(201) } }))!.customData).toBeNull();
  });

  test("an element with no id, a non-number place or size, or one that is not an object is not one", () => {
    for (const bad of [null, "rect", [rect("a")], rect(""), rect("x".repeat(201)), rect("a", { x: "0" }), rect("a", { width: Number.NaN }), rect("a", { height: Infinity }), { type: "rectangle", x: 0, y: 0, width: 1, height: 1 }]) {
      expect(cleanCanvasElement(bad)).toBeNull();
    }
  });
});

describe("a scene's elements", () => {
  test("a write refuses a malformed element or more than the cap, and drops a well-formed embed without refusing", () => {
    expect(cleanCanvasElements([rect("a"), rect("b", { x: "1" })], true)).toBeNull();
    expect(cleanCanvasElements("nope", true)).toBeNull();
    expect(cleanCanvasElements(Array.from({ length: CANVAS_MAX_ELEMENTS + 1 }, (_, i) => rect(`e${i}`)), true)).toBeNull();
    const kept = cleanCanvasElements([rect("a"), rect("frame", { type: "iframe" }), rect("embed", { type: "embeddable", link: "https://example.com" })], true);
    expect(kept?.map((e) => e.id)).toEqual(["a"]);
  });

  test("a read keeps what it can hold and drops the rest", () => {
    const kept = cleanCanvasElements([rect("a"), rect("b", { x: "1" }), null, rect("frame", { type: "iframe" }), rect("c", { link: "https://example.com" })], false);
    expect(kept?.map((e) => [e.id, e.link])).toEqual([
      ["a", null],
      ["c", null],
    ]);
    expect(cleanCanvasElements({ elements: [] }, false)).toEqual([]);
    expect(cleanCanvasElements(Array.from({ length: CANVAS_MAX_ELEMENTS + 1 }, (_, i) => rect(`e${i}`)), false)).toEqual([]);
  });
});
