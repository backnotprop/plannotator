import { describe, expect, test } from "bun:test";
import { shareableDocumentMarkdown } from "./sharing";
import { parseMarkdownToBlocks } from "./parser";
import { isGraphvizLanguage, isMermaidLanguage } from "../components/diagramLanguages";

const MERMAID = "flowchart TD\n  A --> B\n";
const DOT = "digraph G {\n  a -> b;\n}\n";

describe("shareableDocumentMarkdown", () => {
  test("markdown and HTML sessions ship their body unchanged", () => {
    expect(shareableDocumentMarkdown("# Plan", "markdown")).toBe("# Plan");
    expect(shareableDocumentMarkdown("# Plan", "html")).toBe("# Plan");
    expect(shareableDocumentMarkdown("# Plan", undefined)).toBe("# Plan");
  });

  test("a diagram source ships fenced, so the portal's markdown parse renders the diagram", () => {
    // The portal has no server to tell it `renderAs`, so the shared body has
    // to carry the fence itself or the diagram arrives as a wall of text.
    const shared = shareableDocumentMarkdown(MERMAID, "mermaid");
    const blocks = parseMarkdownToBlocks(shared);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(isMermaidLanguage(blocks[0].language)).toBe(true);
    expect(blocks[0].content).toBe(MERMAID.trimEnd());

    const dotBlocks = parseMarkdownToBlocks(shareableDocumentMarkdown(DOT, "graphviz"));
    expect(isGraphvizLanguage(dotBlocks[0].language)).toBe(true);
    expect(dotBlocks[0].content).toBe(DOT.trimEnd());
  });

  test("a diagram body containing a ``` run survives the fence", () => {
    const withTicks = 'flowchart TD\n  A["```code```"] --> B\n';
    const blocks = parseMarkdownToBlocks(shareableDocumentMarkdown(withTicks, "mermaid"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe(withTicks.trimEnd());
  });

  test("an empty body is left empty rather than becoming an empty fence", () => {
    expect(shareableDocumentMarkdown("", "mermaid")).toBe("");
  });
});
