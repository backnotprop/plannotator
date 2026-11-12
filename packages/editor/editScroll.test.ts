import { describe, expect, test } from "bun:test";
import { scrollableEditSurface } from "./editScroll";

const scrollElement = (scrollHeight: number, clientHeight: number): HTMLElement =>
  ({ scrollHeight, clientHeight }) as unknown as HTMLElement;

describe("scrollableEditSurface", () => {
  test("falls back to the document viewport when the editor cannot scroll", () => {
    const viewport = scrollElement(8_204, 1_055);
    const scroller = scrollElement(8_106, 8_106);

    expect(scrollableEditSurface(scroller, viewport, true)).toBe(viewport);
  });

  test("uses the editor scroller when the shell bounds the editor", () => {
    const viewport = scrollElement(700, 700);
    const scroller = scrollElement(2_000, 600);

    expect(scrollableEditSurface(scroller, viewport, true)).toBe(scroller);
  });

  test("always reads the document viewport while not editing", () => {
    const viewport = scrollElement(8_204, 1_055);
    const scroller = scrollElement(2_000, 600);

    expect(scrollableEditSurface(scroller, viewport, false)).toBe(viewport);
  });

  test("stays null when the viewport is unavailable", () => {
    expect(scrollableEditSurface(null, null, true)).toBeNull();
  });
});
