import { describe, expect, test } from "bun:test";
import { htmlDiff } from "./html-diff";

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

const INS = '<ins class="plannotator-diff">';
const DEL = '<del class="plannotator-diff">';

describe("htmlDiff", () => {
  test("pure text addition inside a <p> wraps the added word in <ins>", () => {
    const out = htmlDiff("<p>hello world</p>", "<p>hello brave world</p>");
    expect(out).toContain(INS);
    expect(out).toContain("brave");
    expect(out.indexOf("brave")).toBeGreaterThan(out.indexOf(INS));
    expect(count(out, "<p")).toBe(1);
    expect(count(out, "</p>")).toBe(1);
    expect(out).not.toContain("<del");
    expect(count(out, INS)).toBe(count(out, "</ins>"));
  });

  test("replaced word produces <del>Manual</del> and <ins>Scheduled</ins> inside <li>", () => {
    const out = htmlDiff(
      "<li>Manual transmission</li>",
      "<li>Scheduled transmission</li>",
    );
    expect(out).toContain("Manual");
    expect(out).toContain(DEL);
    expect(out).toContain("</del>");
    expect(out).toContain("Scheduled");
    expect(out).toContain(INS);
    expect(out).toContain("</ins>");
    const liOpen = out.indexOf("<li>");
    const liClose = out.indexOf("</li>");
    expect(liOpen).toBeGreaterThanOrEqual(0);
    expect(liClose).toBeGreaterThan(liOpen);
    expect(out.indexOf(DEL)).toBeGreaterThan(liOpen);
    expect(out.indexOf("</del>")).toBeLessThan(liClose);
    expect(out.indexOf(INS)).toBeGreaterThan(liOpen);
    expect(out.indexOf("</ins>")).toBeLessThan(liClose);
    expect(out).toContain(`${DEL}Manual</del>`);
    expect(out).toContain(`${INS}Scheduled</ins>`);
  });

  test("added element shows its text in <ins> with tags intact", () => {
    const oldHtml = "<ul><li>One</li></ul>";
    const newHtml = "<ul><li>One</li><li>Audit log</li></ul>";
    const out = htmlDiff(oldHtml, newHtml);
    expect(count(out, "<li>")).toBe(2);
    expect(count(out, "</li>")).toBe(2);
    expect(out).toContain(INS);
    expect(out).toContain("Audit log");
    expect(out).not.toContain(`${INS}<li>`);
    expect(out).not.toContain("</li></ins>");
    expect(count(out, INS)).toBe(count(out, "</ins>"));
  });

  test("<script> contents are NOT wrapped with ins/del even if changed", () => {
    const oldHtml = "<div><script>var a = 1;</script><p>hi</p></div>";
    const newHtml = "<div><script>var a = 2;</script><p>hi</p></div>";
    const out = htmlDiff(oldHtml, newHtml);
    expect(out).toContain("<script>var a = 2;</script>");
    expect(out).not.toContain("<ins");
    expect(out).not.toContain("<del");
  });

  test("<style> contents are NOT wrapped with ins/del even if changed", () => {
    const oldHtml = "<head><style>.a{color:red}</style></head>";
    const newHtml = "<head><style>.a{color:blue}</style></head>";
    const out = htmlDiff(oldHtml, newHtml);
    expect(out).toContain("<style>.a{color:blue}</style>");
    expect(out).not.toContain("<ins");
    expect(out).not.toContain("<del");
  });

  test("identical input yields the new HTML verbatim with no ins/del", () => {
    const html =
      "<!doctype html><html><head><title>T</title></head><body><p>Same text here</p></body></html>";
    const out = htmlDiff(html, html);
    expect(out).toBe(html);
    expect(out).not.toContain("<ins");
    expect(out).not.toContain("<del");
  });

  test("author-written <ins>/<del> pass through untagged (no plannotator-diff class)", () => {
    const html = "<p>legal text with <ins>inserted</ins> and <del>struck</del> words</p>";
    const out = htmlDiff(html, html);
    expect(out).toBe(html);
    expect(out).not.toContain("plannotator-diff");
  });

  test("whitespace-only changes do not produce noisy ins/del", () => {
    const out = htmlDiff("<p>a b</p>", "<p>a  b</p>");
    expect(out).not.toContain("<ins");
    expect(out).not.toContain("<del");
    expect(out).toContain("<p>");
    expect(out).toContain("</p>");
  });

  test("output preserves the new doc's structural tag counts", () => {
    const oldHtml =
      "<body><p>First paragraph</p><p>Second paragraph</p></body>";
    const newHtml =
      "<body><p>First updated paragraph</p><p>Second paragraph</p><p>Third paragraph</p></body>";
    const out = htmlDiff(oldHtml, newHtml);
    expect(count(out, "<p")).toBe(count(newHtml, "<p"));
    expect(count(out, "</p>")).toBe(count(newHtml, "</p>"));
    expect(count(out, "<body>")).toBe(1);
    expect(count(out, "</body>")).toBe(1);
    expect(count(out, INS)).toBe(count(out, "</ins>"));
    expect(count(out, DEL)).toBe(count(out, "</del>"));
  });

  test("tags with > inside quoted attributes are tokenized whole (attr-only change)", () => {
    // Regression: the tokenizer must not stop at a `>` inside a quoted attribute.
    const out = htmlDiff(
      '<td title="x > y">cell</td>',
      '<td title="x > z">cell</td>',
    );
    expect(out).toBe('<td title="x > z">cell</td>');
  });

  test("text edit inside a tag carrying > in an attribute stays clean", () => {
    const out = htmlDiff(
      '<td title="a > b">cat</td>',
      '<td title="a > b">dog</td>',
    );
    expect(out).toBe(`<td title="a > b">${DEL}cat</del>${INS}dog</ins></td>`);
  });

  test("script opener with > in an attribute keeps contents opaque", () => {
    const oldHtml = '<script data-x="a>b">var a = 1;</script><p>hi</p>';
    const newHtml = '<script data-x="a>b">var a = 2;</script><p>hi</p>';
    const out = htmlDiff(oldHtml, newHtml);
    expect(out).toContain('<script data-x="a>b">var a = 2;</script>');
    expect(out).not.toContain("<ins");
    expect(out).not.toContain("<del");
  });

  test("removed element drops its tags (no unbalanced tags) and dels its text", () => {
    const oldHtml = "<ul><li>One</li><li>Two</li></ul>";
    const newHtml = "<ul><li>One</li></ul>";
    const out = htmlDiff(oldHtml, newHtml);
    expect(count(out, "<li>")).toBe(1);
    expect(count(out, "</li>")).toBe(1);
    expect(out).toContain(DEL);
    expect(out).toContain("Two");
    expect(out).not.toContain(`${DEL}<li>`);
    expect(out).not.toContain("</li></del>");
    expect(count(out, DEL)).toBe(count(out, "</del>"));
  });
});
