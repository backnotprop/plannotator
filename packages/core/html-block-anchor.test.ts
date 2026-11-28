/**
 * Where a comment on an element of a live html block sits (the block's
 * place, its source, its lines). What regresses if these fail:
 * - a comment is drawn on a block it was not made on (another place, or the
 *   same place holding another source): a wrong element gets the person's words;
 * - a malformed anchor from the store or a draft is taken as one (a crash, or
 *   a location line that names no block);
 * - the lines an agent is told do not read as the other exports' do.
 */
import { describe, expect, test } from "bun:test";
import { buildHtmlBlockAnchor, htmlBlockAnchorLines, matchHtmlBlockAnchor, parseHtmlBlockAnchor } from "./html-block-anchor";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

describe("the anchor", () => {
  test("a block's place, embed id and fence lines build an anchor that reads back the same", () => {
    const anchor = buildHtmlBlockAnchor(2, ID, [14, 31]);
    expect(anchor).toEqual({ v: 1, index: 2, id: ID, sourceLine: [14, 31] });
    expect(parseHtmlBlockAnchor(JSON.parse(JSON.stringify(anchor)))).toEqual(anchor);
  });

  test("a block with no line still anchors, and unknown keys are dropped", () => {
    expect(buildHtmlBlockAnchor(1, ID, null)).toEqual({ v: 1, index: 1, id: ID, sourceLine: null });
    expect(parseHtmlBlockAnchor({ v: 1, index: 1, id: ID, sourceLine: null, text: "words from a page" })).toEqual({ v: 1, index: 1, id: ID, sourceLine: null });
  });

  test("anything else is no anchor", () => {
    for (const bad of [
      null,
      "x",
      [],
      {},
      { v: 2, index: 1, id: ID, sourceLine: null },
      { v: 1, index: 0, id: ID, sourceLine: null },
      { v: 1, index: 1.5, id: ID, sourceLine: null },
      { v: 1, index: 1e9, id: ID, sourceLine: null },
      { v: 1, index: 1, id: "ABC", sourceLine: null },
      { v: 1, index: 1, id: `${ID}0`, sourceLine: null },
      { v: 1, index: 1, id: ID, sourceLine: [5, 4] },
      { v: 1, index: 1, id: ID, sourceLine: [0, 4] },
      { v: 1, index: 1, id: ID, sourceLine: [1] },
      { v: 1, index: 1, id: ID, sourceLine: "1-4" },
    ]) {
      expect(parseHtmlBlockAnchor(bad)).toBeNull();
    }
    expect(buildHtmlBlockAnchor(1, "not-an-id", [1, 2])).toBeNull();
  });
});

describe("which block a comment is on", () => {
  const anchor = buildHtmlBlockAnchor(2, ID, [14, 31])!;

  test("its own place and source: drawn there", () => {
    expect(matchHtmlBlockAnchor(anchor, { index: 2, id: ID })).toBe("own");
  });

  test("another place is another block's, whatever its source (the same page twice in a message)", () => {
    expect(matchHtmlBlockAnchor(anchor, { index: 1, id: ID })).toBe("other");
    expect(matchHtmlBlockAnchor(anchor, { index: 3, id: ID })).toBe("other");
  });

  test("its place holding another source is never drawn: the comment is unanchored", () => {
    expect(matchHtmlBlockAnchor(anchor, { index: 2, id: OTHER })).toBe("changed");
  });

  test("its place before the block's page is known waits, and claims nothing", () => {
    expect(matchHtmlBlockAnchor(anchor, { index: 2, id: null })).toBe("pending");
  });
});

describe("the lines an export prints", () => {
  test("a range, one line, or none", () => {
    expect(htmlBlockAnchorLines(buildHtmlBlockAnchor(1, ID, [14, 31])!)).toBe("lines 14–31");
    expect(htmlBlockAnchorLines(buildHtmlBlockAnchor(1, ID, [14, 14])!)).toBe("line 14");
    expect(htmlBlockAnchorLines(buildHtmlBlockAnchor(1, ID, null)!)).toBe("");
  });
});
