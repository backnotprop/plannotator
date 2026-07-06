import { describe, expect, test } from "bun:test";
import { htmlDiff } from "./html-diff";

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

describe("htmlDiff", () => {
  test("pure text addition inside a <p> wraps the added word in <ins>", () => {
    const out = htmlDiff("<p>hello world</p>", "<p>hello brave world</p>");
    // The added word is wrapped in <ins>.
    expect(out).toContain("<ins>");
    expect(out).toContain("brave");
    expect(out.indexOf("brave")).toBeGreaterThan(out.indexOf("<ins>"));
    // Structure intact: exactly one opening <p and one closing </p>.
    expect(count(out, "<p")).toBe(1);
    expect(count(out, "</p>")).toBe(1);
    // No <del> for a pure addition.
    expect(out).not.toContain("<del>");
    // <ins>/</ins> are balanced.
    expect(count(out, "<ins>")).toBe(count(out, "</ins>"));
  });

  test("replaced word produces <del>Manual</del> and <ins>Scheduled</ins> inside <li>", () => {
    const out = htmlDiff(
      "<li>Manual transmission</li>",
      "<li>Scheduled transmission</li>",
    );
    expect(out).toContain("Manual");
    expect(out).toContain("<del>");
    expect(out).toContain("</del>");
    expect(out).toContain("Scheduled");
    expect(out).toContain("<ins>");
    expect(out).toContain("</ins>");
    // Both ins and del sit inside the <li>...</li>.
    const liOpen = out.indexOf("<li>");
    const liClose = out.indexOf("</li>");
    expect(liOpen).toBeGreaterThanOrEqual(0);
    expect(liClose).toBeGreaterThan(liOpen);
    expect(out.indexOf("<del>")).toBeGreaterThan(liOpen);
    expect(out.indexOf("</del>")).toBeLessThan(liClose);
    expect(out.indexOf("<ins>")).toBeGreaterThan(liOpen);
    expect(out.indexOf("</ins>")).toBeLessThan(liClose);
    // "Manual" appears only inside the del; "Scheduled" only inside the ins.
    expect(out).toContain("<del>Manual</del>");
    expect(out).toContain("<ins>Scheduled</ins>");
  });

  test("added element shows its text in <ins> with tags intact", () => {
    const oldHtml = "<ul><li>One</li></ul>";
    const newHtml = "<ul><li>One</li><li>Audit log</li></ul>";
    const out = htmlDiff(oldHtml, newHtml);
    // New <li> structure present.
    expect(count(out, "<li>")).toBe(2);
    expect(count(out, "</li>")).toBe(2);
    // The added text is wrapped in <ins> but the <li> tags are NOT inside it.
    expect(out).toContain("<ins>");
    expect(out).toContain("Audit log");
    expect(out).not.toContain("<ins><li>");
    expect(out).not.toContain("</li></ins>");
    expect(count(out, "<ins>")).toBe(count(out, "</ins>"));
  });

  test("<script> contents are NOT wrapped with ins/del even if changed", () => {
    const oldHtml = "<div><script>var a = 1;</script><p>hi</p></div>";
    const newHtml = "<div><script>var a = 2;</script><p>hi</p></div>";
    const out = htmlDiff(oldHtml, newHtml);
    // The new script content is present verbatim, opaque (no ins/del inside it).
    expect(out).toContain("<script>var a = 2;</script>");
    expect(out).not.toContain("<ins>");
    expect(out).not.toContain("<del>");
  });

  test("<style> contents are NOT wrapped with ins/del even if changed", () => {
    const oldHtml = "<head><style>.a{color:red}</style></head>";
    const newHtml = "<head><style>.a{color:blue}</style></head>";
    const out = htmlDiff(oldHtml, newHtml);
    expect(out).toContain("<style>.a{color:blue}</style>");
    expect(out).not.toContain("<ins>");
    expect(out).not.toContain("<del>");
  });

  test("identical input yields the new HTML verbatim with no ins/del", () => {
    const html =
      "<!doctype html><html><head><title>T</title></head><body><p>Same text here</p></body></html>";
    const out = htmlDiff(html, html);
    expect(out).toBe(html);
    expect(out).not.toContain("<ins>");
    expect(out).not.toContain("<del>");
  });

  test("whitespace-only changes do not produce noisy ins/del", () => {
    const out = htmlDiff("<p>a b</p>", "<p>a  b</p>");
    expect(out).not.toContain("<ins>");
    expect(out).not.toContain("<del>");
    expect(out).toContain("<p>");
    expect(out).toContain("</p>");
  });

  test("output preserves the new doc's structural tag counts", () => {
    const oldHtml =
      "<body><p>First paragraph</p><p>Second paragraph</p></body>";
    const newHtml =
      "<body><p>First updated paragraph</p><p>Second paragraph</p><p>Third paragraph</p></body>";
    const out = htmlDiff(oldHtml, newHtml);
    // Count of <p in output matches the new doc (3).
    expect(count(out, "<p")).toBe(count(newHtml, "<p"));
    expect(count(out, "</p>")).toBe(count(newHtml, "</p>"));
    expect(count(out, "<body>")).toBe(1);
    expect(count(out, "</body>")).toBe(1);
    // ins/del balanced.
    expect(count(out, "<ins>")).toBe(count(out, "</ins>"));
    expect(count(out, "<del>")).toBe(count(out, "</del>"));
  });

  test("tags with > inside quoted attributes are tokenized whole (attr-only change)", () => {
    // Regression: the old tokenizer stopped at the first > even inside a quoted
    // attribute, splitting the tag and corrupting the output.
    const out = htmlDiff(
      '<td title="x > y">cell</td>',
      '<td title="x > z">cell</td>',
    );
    // Attribute-only change: new tag emitted intact, unchanged text untouched.
    expect(out).toBe('<td title="x > z">cell</td>');
  });

  test("text edit inside a tag carrying > in an attribute stays clean", () => {
    const out = htmlDiff(
      '<td title="a > b">cat</td>',
      '<td title="a > b">dog</td>',
    );
    expect(out).toBe('<td title="a > b"><del>cat</del><ins>dog</ins></td>');
  });

  test("script opener with > in an attribute keeps contents opaque", () => {
    const oldHtml = '<script data-x="a>b">var a = 1;</script><p>hi</p>';
    const newHtml = '<script data-x="a>b">var a = 2;</script><p>hi</p>';
    const out = htmlDiff(oldHtml, newHtml);
    expect(out).toContain('<script data-x="a>b">var a = 2;</script>');
    expect(out).not.toContain("<ins>");
    expect(out).not.toContain("<del>");
  });

  test("removed element drops its tags (no unbalanced tags) and dels its text", () => {
    const oldHtml = "<ul><li>One</li><li>Two</li></ul>";
    const newHtml = "<ul><li>One</li></ul>";
    const out = htmlDiff(oldHtml, newHtml);
    // New structure: exactly one <li>.
    expect(count(out, "<li>")).toBe(1);
    expect(count(out, "</li>")).toBe(1);
    // Removed text "Two" appears inside a <del>.
    expect(out).toContain("<del>");
    expect(out).toContain("Two");
    // Never wrap a tag in del.
    expect(out).not.toContain("<del><li>");
    expect(out).not.toContain("</li></del>");
    expect(count(out, "<del>")).toBe(count(out, "</del>"));
  });
});
