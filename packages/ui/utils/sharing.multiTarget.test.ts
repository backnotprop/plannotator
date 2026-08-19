/**
 * Share-URL contract for multi-target HTML annotations: element anchors are
 * deliberately dropped from share payloads (they are meaningless in another
 * viewer's DOM), and htmlAdditionalTargets follow the exact same rule — the
 * compact tuple format never carries them. The COMMENT itself (text, quoted
 * primary text, author, images) still shares.
 */
import { describe, expect, test } from "bun:test";
import { AnnotationType, type Annotation } from "../types";
import { fromShareable, toShareable } from "./sharing";

const MULTI: Annotation = {
  id: "ann-1",
  blockId: "",
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text: "Unify these",
  originalText: "Primary chip",
  createdA: 1,
  author: "reviewer",
  htmlAnchor: { selector: "p.primary", tagName: "p", text: "Primary chip" },
  htmlAdditionalTargets: [
    { label: "Button", text: "Create", anchor: { selector: "span.btn", tagName: "span", text: "Create" } },
  ],
};

describe("sharing — multi-target annotations", () => {
  test("toShareable serializes the comment without anchors or additional targets", () => {
    const shareable = toShareable([MULTI]);
    expect(shareable).toEqual([["C", "Primary chip", "Unify these", "reviewer", undefined]]);
    expect(JSON.stringify(shareable)).not.toContain("htmlAdditionalTargets");
    expect(JSON.stringify(shareable)).not.toContain("selector");
  });

  test("round trip keeps the comment but has no target array", () => {
    const restored = fromShareable(toShareable([MULTI]));
    expect(restored.length).toBe(1);
    expect(restored[0]!.text).toBe("Unify these");
    expect(restored[0]!.originalText).toBe("Primary chip");
    expect(restored[0]!.htmlAnchor).toBeUndefined();
    expect(restored[0]!.htmlAdditionalTargets).toBeUndefined();
  });
});
