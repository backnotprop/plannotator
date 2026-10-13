import { describe, expect, test } from "bun:test";
import { AnnotationType, type Annotation } from "@plannotator/ui/types";
import { applyRestoredAnchors } from "./restoredAnchors";

const ann = (overrides: Partial<Annotation> = {}): Annotation => ({
  id: "a1",
  blockId: "block-1",
  startOffset: 4,
  endOffset: 18,
  type: AnnotationType.COMMENT,
  text: "slow",
  originalText: "The retry loop",
  createdA: 1,
  startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 4 },
  endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 18 },
  ...overrides,
});

describe("applyRestoredAnchors", () => {
  test("no moved entries keeps the same array (no state update, no draft save)", () => {
    const list = [ann()];
    expect(applyRestoredAnchors(list, undefined)).toBe(list);
    expect(applyRestoredAnchors(list, [])).toBe(list);
  });

  test("a comment found in another block takes that block and drops positions that missed", () => {
    const [next] = applyRestoredAnchors([ann()], [
      { id: "a1", blockId: "block-4", startOffset: 0, positionsStale: true },
    ]);
    expect(next.blockId).toBe("block-4");
    expect(next.startOffset).toBe(0);
    expect(next.endOffset).toBe("The retry loop".length);
    expect(next.startMeta).toBeUndefined();
    expect(next.endMeta).toBeUndefined();
  });

  test("verified positions are kept when only the block id shifted", () => {
    const [next] = applyRestoredAnchors([ann()], [
      { id: "a1", blockId: "block-2", startOffset: 4, positionsStale: false },
    ]);
    expect(next.blockId).toBe("block-2");
    expect(next.startMeta).toEqual({ parentTagName: "P", parentIndex: 0, textOffset: 4 });
  });

  test("a comment whose text is gone loses its block (no line label) but keeps its text", () => {
    const [next] = applyRestoredAnchors([ann()], [{ id: "a1", blockId: "", positionsStale: true }]);
    expect(next.blockId).toBe("");
    expect(next.text).toBe("slow");
    expect(next.originalText).toBe("The retry loop");
    expect(next.startOffset).toBe(4);
    expect(next.startMeta).toBeUndefined();
  });

  test("checkbox overrides are keyed by block and never moved", () => {
    const checkbox = ann({ id: "ann-checkbox-block-1-1" });
    const list = [checkbox];
    expect(applyRestoredAnchors(list, [
      { id: checkbox.id, blockId: "", positionsStale: true },
    ])).toBe(list);
  });

  test("a diff-view comment keeps its diff-block id whatever a restore reported", () => {
    const diffComment = ann({ blockId: "diff-block-3", diffContext: "removed", startMeta: undefined, endMeta: undefined });
    const list = [diffComment];
    expect(applyRestoredAnchors(list, [{ id: "a1", blockId: "", positionsStale: true }])).toBe(list);
    expect(applyRestoredAnchors(list, [
      { id: "a1", blockId: "block-0", startOffset: 0, positionsStale: true },
    ])).toBe(list);
  });

  test("an already-unanchored comment without positions is left as it is", () => {
    const list = [ann({ blockId: "", startMeta: undefined, endMeta: undefined })];
    expect(applyRestoredAnchors(list, [{ id: "a1", blockId: "", positionsStale: true }])).toBe(list);
  });
});
