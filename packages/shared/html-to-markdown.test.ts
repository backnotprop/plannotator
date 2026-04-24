import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "./html-to-markdown";

describe("htmlToMarkdown", () => {
  test("converts basic HTML to markdown", () => {
    const md = htmlToMarkdown("<h1>Hello</h1><p>World</p>");
    expect(md).toContain("# Hello");
    expect(md).toContain("World");
  });

  test("converts tables with explicit thead", () => {
    const html = "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("| A");
    expect(md).toContain("| ---");
    expect(md).toContain("| 1");
  });

  test("converts tables WITHOUT thead (common HTML pattern)", () => {
    const html = "<table><tr><th>Name</th><th>Value</th></tr><tr><td>foo</td><td>bar</td></tr></table>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("| Name");
    expect(md).toContain("| ---");
    expect(md).toContain("| foo");
  });

  test("strips script, style, and noscript tags", () => {
    const html = '<p>Visible</p><script>alert("xss")</script><style>.x{}</style><noscript>Hidden</noscript>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("Visible");
    expect(md).not.toContain("alert");
    expect(md).not.toContain(".x{}");
    expect(md).not.toContain("Hidden");
  });

  test("converts strikethrough (GFM)", () => {
    const md = htmlToMarkdown("<p>This is <del>deleted</del> text</p>");
    expect(md).toContain("~deleted~");
  });

  test("preserves code blocks as fenced markdown", () => {
    const md = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
    expect(md).toContain("```");
    expect(md).toContain("const x = 1;");
  });

  test("converts links", () => {
    const md = htmlToMarkdown('<a href="https://example.com">Click</a>');
    expect(md).toContain("[Click](https://example.com)");
  });

  test("preserves dangerous link hrefs (sanitization is in the renderer, not here)", () => {
    const md = htmlToMarkdown('<a href="javascript:alert(1)">XSS</a>');
    // Turndown preserves the link — the UI renderer blocks it
    expect(md).toContain("javascript:");
  });

  test("handles empty HTML gracefully", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("<html><body></body></html>")).toBe("");
  });
});
