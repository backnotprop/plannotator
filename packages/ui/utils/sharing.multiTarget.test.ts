/**
 * Share-URL contract for multi-target HTML annotations: element anchors are
 * deliberately dropped from share payloads (they are meaningless in another
 * viewer's DOM), and htmlAdditionalTargets follow the exact same rule — the
 * compact tuple format never carries them. The COMMENT itself (text, quoted
 * primary text, author, images) still shares. Every later host-side field
 * (elementContext, diagramAnchor, mentions) follows the same rule and is
 * pinned here.
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
  // Element context describes a DOM the link's recipient does not have: it
  // follows the anchor rule and never enters a share payload.
  elementContext: { tag: "p", path: "body > p.primary", outline: "<p>Primary chip</p>" },
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
    expect(JSON.stringify(shareable)).not.toContain("elementContext");
    expect(JSON.stringify(shareable)).not.toContain("outline");
  });

  test("a diagram anchor follows the same rule: the comment shares, the anchor does not", () => {
    // A diagram anchor names a part of a render the link's recipient
    // re-creates from the fence; the quoted label still restores by text
    // search on the shared document, and the anchor itself never travels.
    const DIAGRAM: Annotation = {
      id: "ann-2",
      blockId: "block-3",
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.COMMENT,
      text: "Rename this step",
      originalText: "Approve?",
      createdA: 2,
      author: "reviewer",
      diagramAnchor: { v: 1, family: "flowchart", kind: "node", id: "D", label: "Approve?", sourceLine: [4, 4] },
    };
    const shareable = toShareable([DIAGRAM]);
    expect(shareable).toEqual([["C", "Approve?", "Rename this step", "reviewer", undefined]]);
    expect(JSON.stringify(shareable)).not.toContain("diagramAnchor");
    expect(JSON.stringify(shareable)).not.toContain("sourceLine");
    const restored = fromShareable(shareable);
    expect(restored[0]!.diagramAnchor).toBeUndefined();
    expect(restored[0]!.originalText).toBe("Approve?");
  });

  test("host mention ids follow the same rule: the comment shares, the ids do not", () => {
    // `mentions` names people in the HOST's directory. A share link is read
    // outside that host, so the ids are meaningless there and are dropped
    // exactly like an anchor; the comment body keeps the readable @token.
    const TAGGED: Annotation = {
      id: "ann-3",
      blockId: "block-1",
      startOffset: 0,
      endOffset: 12,
      type: AnnotationType.COMMENT,
      text: "@Dana Ruiz can you confirm?",
      originalText: "Primary chip",
      createdA: 3,
      author: "reviewer",
      mentions: ["user_2", "user_7"],
    };
    const shareable = toShareable([TAGGED]);
    expect(shareable).toEqual([["C", "Primary chip", "@Dana Ruiz can you confirm?", "reviewer", undefined]]);
    expect(JSON.stringify(shareable)).not.toContain("mentions");
    expect(JSON.stringify(shareable)).not.toContain("user_2");
    const restored = fromShareable(shareable);
    expect(restored[0]!.mentions).toBeUndefined();
    expect(restored[0]!.text).toBe("@Dana Ruiz can you confirm?");
  });

  test("round trip keeps the comment but has no target array", () => {
    const restored = fromShareable(toShareable([MULTI]));
    expect(restored.length).toBe(1);
    expect(restored[0]!.text).toBe("Unify these");
    expect(restored[0]!.originalText).toBe("Primary chip");
    expect(restored[0]!.htmlAnchor).toBeUndefined();
    expect(restored[0]!.htmlAdditionalTargets).toBeUndefined();
    expect(restored[0]!.elementContext).toBeUndefined();
  });
});
