import { describe, it, expect } from "bun:test";
import { renderInlineMarkdown } from "./renderInlineMarkdown";

const isElement = (node: unknown): node is { type: string; props: { children?: unknown } } =>
  typeof node === "object" && node !== null && "type" in node && "props" in node;

const types = (nodes: unknown[]) => nodes.map((node) => (isElement(node) ? node.type : typeof node));

describe("renderInlineMarkdown", () => {
  it("renders underscore emphasis", () => {
    const nodes = renderInlineMarkdown("_text_");
    expect(nodes).toHaveLength(1);
    expect(isElement(nodes[0])).toBe(true);
    expect((nodes[0] as { type: string; props: { children?: unknown } }).type).toBe("em");
    expect((nodes[0] as { type: string; props: { children?: unknown } }).props.children).toBe("text");
  });

  it("renders underscore emphasis in context", () => {
    const nodes = renderInlineMarkdown("foo _bar_ baz");
    expect(nodes.filter(isElement)).toHaveLength(1);
    expect(types(nodes)).toContain("em");
    expect((nodes.find(isElement) as { type: string; props: { children?: unknown } }).props.children).toBe("bar");
    expect(nodes.filter((node) => typeof node === "string").join("")).toBe("foo  baz");
  });

  it("keeps intraword underscores literal", () => {
    expect(renderInlineMarkdown("snake_case")).toEqual(["snake_case"]);
    expect(renderInlineMarkdown("foo_bar_baz")).toEqual(["foo_bar_baz"]);
    expect(renderInlineMarkdown("__init__")).toEqual(["__init__"]);
  });

  it("renders underscore emphasis after other inline tokens", () => {
    const boldNodes = renderInlineMarkdown("**bold**_italic_");
    expect(types(boldNodes)).toEqual(["strong", "em"]);
    expect((boldNodes[1] as { type: string; props: { children?: unknown } }).props.children).toBe("italic");

    const codeNodes = renderInlineMarkdown("`code`_italic_");
    expect(types(codeNodes)).toEqual(["code", "em"]);
    expect((codeNodes[1] as { type: string; props: { children?: unknown } }).props.children).toBe("italic");

    const linkNodes = renderInlineMarkdown("[link](https://example.com)_italic_");
    expect(types(linkNodes)).toEqual(["a", "em"]);
    expect((linkNodes[1] as { type: string; props: { children?: unknown } }).props.children).toBe("italic");
  });
});
