import { describe, it, expect } from "bun:test";
import { renderMarkdownProse } from "./renderMarkdownProse";

type El = { type: unknown; props: { children?: unknown } };

const isElement = (node: unknown): node is El =>
  typeof node === "object" && node !== null && "type" in node && "props" in node;

/** Flattens a React node tree (as returned by renderMarkdownProse, never
 *  actually mounted) down to its plain text content. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isElement(node)) return textOf(node.props.children);
  return "";
}

describe("renderMarkdownProse", () => {
  it("keeps the single-line callout opener's own text (regression: used to render empty)", () => {
    const nodes = renderMarkdownProse("> [!IMPORTANT] message here");
    expect(nodes).toHaveLength(1);
    const callout = nodes[0];
    expect(isElement(callout) && callout.type).toBe("div");
    expect(textOf(callout)).toContain("message here");

    // The label span and the content span are the two children — the content
    // span specifically (not just the label) must carry the opener's text.
    const children = isElement(callout) ? callout.props.children : null;
    expect(Array.isArray(children)).toBe(true);
    const contentSpan = (children as unknown[])[1];
    expect(textOf(contentSpan)).toBe("message here");
  });

  it("still renders the multi-line callout form (opener alone, then > body lines) unchanged", () => {
    const nodes = renderMarkdownProse("> [!NOTE]\n> multi-line body\n> more body");
    expect(nodes).toHaveLength(1);
    const callout = nodes[0];
    expect(isElement(callout) && callout.type).toBe("div");
    expect(textOf(callout)).toContain("multi-line body more body");
  });

  it("combines a single-line opener's text with any following > lines", () => {
    const nodes = renderMarkdownProse("> [!WARNING] heads up\n> more detail");
    expect(nodes).toHaveLength(1);
    expect(textOf(nodes[0])).toContain("heads up more detail");
  });

  it("leaves a plain paragraph unchanged", () => {
    const nodes = renderMarkdownProse("Just a paragraph.");
    expect(nodes).toHaveLength(1);
    expect(isElement(nodes[0]) && nodes[0].type).toBe("p");
    expect(textOf(nodes[0])).toBe("Just a paragraph.");
  });

  it("applies inline markdown inside ### headings (regression: rendered raw tokens)", () => {
    const nodes = renderMarkdownProse("### The `useGuideData` hook");
    expect(nodes).toHaveLength(1);
    const heading = nodes[0];
    expect(isElement(heading) && heading.type).toBe("h3");
    // Inline rendering strips the backticks into a <code> element, so the
    // flattened text must NOT contain the raw markdown tokens.
    expect(textOf(heading)).toBe("The useGuideData hook");
    expect(textOf(heading)).not.toContain("`");
  });
});
