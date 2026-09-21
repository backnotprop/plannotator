/**
 * The unanchored union is what a host renders its "Unanchored" chip from,
 * so the failures to catch are: a textless page row going unreported, a
 * document-level comment being flagged, a swapped-out local id leaking into
 * the host's set, and (the byte-identity guard for existing consumers) the
 * union NOT equalling the bridge list when nothing needs completing.
 */
import { describe, expect, test } from "bun:test";
import { AnnotationType, type Annotation } from "../../types";
import { isTextlessPageAnnotation, mergeUnanchoredIds } from "./unanchored";

function row(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    blockId: "",
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    originalText: "quoted",
    createdA: 1,
    ...overrides,
  };
}

describe("isTextlessPageAnnotation", () => {
  test("a page row with nothing to restore by is textless; anchored, quoted, and global rows are not", () => {
    expect(isTextlessPageAnnotation(row("a", { originalText: "" }))).toBe(true);
    expect(isTextlessPageAnnotation(row("b"))).toBe(false);
    expect(isTextlessPageAnnotation(row("c", { originalText: "", htmlAnchor: { selector: "img", tagName: "img" } }))).toBe(false);
    expect(isTextlessPageAnnotation(row("d", {
      originalText: "",
      htmlAdditionalTargets: [{ text: "Go", anchor: { selector: "#go", tagName: "button" } }],
    }))).toBe(false);
    expect(isTextlessPageAnnotation(row("e", { originalText: "", type: AnnotationType.GLOBAL_COMMENT }))).toBe(false);
  });
});

describe("mergeUnanchoredIds", () => {
  const none = new Set<string>();

  test("with nothing to complete, the union is exactly the bridge list", () => {
    const bridgeIds = ["a-1", "b-2"];
    const result = mergeUnanchoredIds({ bridgeIds, annotations: [row("a-1"), row("b-2"), row("c-3")], createdIds: none });
    expect(result).toEqual(bridgeIds);
    // Ids the host never listed still pass through: hosts painting through
    // the imperative handle keep today's raw delivery.
    expect(mergeUnanchoredIds({ bridgeIds: ["lost-1"], annotations: [], createdIds: none })).toEqual(["lost-1"]);
  });

  test("textless page rows join the report; global comments do not", () => {
    const result = mergeUnanchoredIds({
      bridgeIds: ["dead-1"],
      annotations: [
        row("dead-1"),
        row("textless-1", { originalText: "" }),
        row("global-1", { originalText: "", type: AnnotationType.GLOBAL_COMMENT }),
      ],
      createdIds: none,
    });
    expect(result).toEqual(["dead-1", "textless-1"]);
  });

  test("a locally minted id the host swapped out of its list is dropped; one the host kept stays", () => {
    const createdIds = new Set(["html-ann-local", "html-ann-kept"]);
    const result = mergeUnanchoredIds({
      bridgeIds: ["html-ann-kept", "html-ann-local", "srv-1"],
      annotations: [row("srv-1"), row("html-ann-kept")],
      createdIds,
    });
    expect(result).toEqual(["html-ann-kept", "srv-1"]);
  });

  test("the result is sorted and deduplicated like the bridge emission", () => {
    const result = mergeUnanchoredIds({
      bridgeIds: ["z", "a", "a"],
      annotations: [row("m", { originalText: "" }), row("m", { originalText: "" })],
      createdIds: none,
    });
    expect(result).toEqual(["a", "m", "z"]);
  });
});
