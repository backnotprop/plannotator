/**
 * A message's live html blocks as artifacts (inbox-html-blocks.ts). What can regress: a fence the message draws as a
 * page left out (or one it does not draw counted: in a quote, a directive, a raw HTML block), the key changing
 * between reads or when ANOTHER block of the message changes (a pin then lands on the wrong block), two blocks
 * with the same source counted twice, the place not matching the comment anchor's (`HtmlBlockAnchor.index`), and
 * the tile's name read from a script or a comment instead of the page's heading.
 */
import { describe, expect, test } from "bun:test";
import { inboxHtmlArtifactKey, inboxHtmlBlockDrawsStill, inboxHtmlBlockHash, inboxHtmlBlockTitle, inboxMessageHtmlBlocks, readInboxHtmlArtifactKey } from "./inbox-html-blocks";

const fence = (lang: string, ...lines: string[]) => [`\`\`\`${lang}`, ...lines, "```"].join("\n");

describe("a message's html blocks", () => {
  test("every top-level html fence, in text order, with its place, lines, size and heading", () => {
    const body = [
      "Berths for Thursday:",
      "",
      fence("html", "<h2>Harbor · berth plan</h2>", "<p>B1 MV Fernwood</p>"),
      "",
      fence("ts", "const x = 1;"),
      "",
      fence("HTML title=tides", "<table><tr><td>06:12</td></tr></table>"),
    ].join("\n");
    const blocks = inboxMessageHtmlBlocks(body);
    expect(blocks.map((b) => [b.index, b.startLine, b.title])).toEqual([
      [1, 3, "Harbor · berth plan"],
      [2, 12, null],
    ]);
    expect(blocks[0]!.content).toBe("<h2>Harbor · berth plan</h2>\n<p>B1 MV Fernwood</p>");
    expect(blocks[0]!.size).toBe(new TextEncoder().encode(blocks[0]!.content).length);
  });

  test("a fence the text does not draw as a page is not one: in a quote, a directive, a raw HTML block, a longer fence", () => {
    const body = [
      "> " + "```html",
      "> <p>quoted</p>",
      "> ```",
      "",
      ":::note",
      fence("html", "<p>in a note</p>"),
      ":::",
      "",
      "<div>",
      fence("html", "<p>in raw html</p>"),
      "</div>",
      "",
      "````md",
      fence("html", "<p>shown as code</p>"),
      "````",
      "",
      fence("html", "<p>the one</p>"),
    ].join("\n");
    expect(inboxMessageHtmlBlocks(body).map((b) => b.content)).toEqual(["<p>the one</p>"]);
  });

  test("the same source twice is one block, at its first place; the place still counts both fences", () => {
    const body = [fence("html", "<p>same</p>"), "", fence("html", "<p>same</p>"), "", fence("html", "<p>other</p>")].join("\n");
    const blocks = inboxMessageHtmlBlocks(body);
    expect(blocks.map((b) => [b.index, b.content])).toEqual([
      [1, "<p>same</p>"],
      [3, "<p>other</p>"],
    ]);
  });

  test("a block's key is its source's: the same on every read, and untouched when another block changes or moves", () => {
    const a = fence("html", "<h1>Tides</h1>");
    const b = fence("html", "<h1>Berths</h1>");
    const first = inboxMessageHtmlBlocks([a, "", b].join("\n"));
    const again = inboxMessageHtmlBlocks([a, "", b].join("\n"));
    expect(again.map((x) => x.hash)).toEqual(first.map((x) => x.hash));
    // The other block edited, then a new block put before it: the berths block keeps its hash.
    const edited = inboxMessageHtmlBlocks([fence("html", "<h1>Tides, revised</h1>"), "", b].join("\n"));
    const moved = inboxMessageHtmlBlocks([fence("html", "<p>new</p>"), "", a, "", b].join("\n"));
    expect(edited[1]!.hash).toBe(first[1]!.hash);
    expect(edited[0]!.hash).not.toBe(first[0]!.hash);
    expect(moved.find((x) => x.title === "Berths")!.hash).toBe(first[1]!.hash);
    expect(first[0]!.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(inboxHtmlBlockHash("<p>x</p>")).not.toBe(inboxHtmlBlockHash("<p>y</p>"));
  });

  test("the key names its message and hash, and nothing else reads as one", () => {
    const message = "msg_01M6XV5A40WH334FPF7KQQH5S5";
    const key = inboxHtmlArtifactKey(message, "0123456789abcdef");
    expect(readInboxHtmlArtifactKey(key)).toEqual({ messageId: message, hash: "0123456789abcdef" });
    for (const bad of [`html:${message}`, `html:${message}:XYZ`, `html:att_1:0123456789abcdef`, `guide:${message}`, "att_123"]) {
      expect(readInboxHtmlArtifactKey(bad)).toBeNull();
    }
  });

  test("the name is the page's first heading as words, else its title; scripts, styles and comments are not read", () => {
    expect(inboxHtmlBlockTitle("<style>h1{color:red}</style><!-- <h1>old</h1> --><script>'<h1>x</h1>'</script><h3 class=a>Ledger &amp; <b>fern-api</b></h3>")).toBe("Ledger & fern-api");
    expect(inboxHtmlBlockTitle("<title>Quill docs</title><p>body</p>")).toBe("Quill docs");
    expect(inboxHtmlBlockTitle("<div id=chart></div><script src=x></script>")).toBeNull();
    expect(inboxHtmlBlockTitle(`<h1>${"a".repeat(300)}</h1>`)!.length).toBe(120);
  });

  test("a body without a fence is no block", () => {
    expect(inboxMessageHtmlBlocks("Just words, <b>and html</b> inline.")).toEqual([]);
    expect(inboxMessageHtmlBlocks("```ts\nconst page = '<h1>harbor</h1>';\n```\n\n```\n<h2>plain</h2>\n```")).toEqual([]);
  });

  test("a hostile 1 MB block of unclosed tags is read in well under a second, in the window and the store alike", () => {
    // Every tag the name reads, opened and never closed: a lazy regex over this goes quadratic.
    const hostile = "<h1>a<script>b<h2 c<title>d<style>e<template>f<!-".repeat(21_000);
    expect(hostile.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    expect(inboxHtmlBlockTitle(hostile)).toBeNull();
    const blocks = inboxMessageHtmlBlocks(["Ledger's page:", "", "```html", hostile, "```"].join("\n"));
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.title).toBeNull();
    // Closed somewhere far past what the name reads: still quick, still no name.
    expect(inboxHtmlBlockTitle(`${hostile}</h1></script></h2></title>`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(300);
    // A real heading after the hostile part's first 64 KB is not read; one before it is.
    expect(inboxHtmlBlockTitle(`<h2>Fern API · tides</h2>${hostile}`)).toBe("Fern API · tides");
  });
});

// A tile's still picture is the page drawn with no script: a page only a script draws would be a blank box, so its
// tile shows the quiet HTML mark instead (the owner, 2026-11-25: "what's with the empty titles?").
describe("whether a block's page draws anything with no script", () => {
  const SCRIPT = "<script>draw()</script>";
  // [why, the page, whether it draws a picture (true) or keeps the mark (false)]
  const cases: Array<[string, string, boolean]> = [
    ["a heading and a table", "<h2>Harbor · tide table</h2><table><tr><td>06:12</td></tr></table>", true],
    ["a chart its script draws into an empty svg (its style only lays it out)", `<svg id="tides" viewBox="0 0 360 120" style="display:block;width:360px"></svg><script>const r = '<rect>Tide</rect>';</script>`, false],
    ["a chart into a sized box and a canvas", '<div id="chart" style="height:300px"></div><canvas id="c"></canvas><script src="https://cdn.example/chart.js"></script>', false],
    ["words only in a title, a style, a comment and a template", "<title>Ledger</title><style>body{color:red}</style><!-- Bob Tully's draft --><template><p>later</p></template><div>&nbsp;</div>", false],
    ["nothing but spaces", "   ", false],
    ["a script never closed hides the rest, as the browser does", "<script>draw(); <p>never shown</p>", false],
    ["an image", '<img src="data:image/png;base64,AAAA" alt="">', true],
    ["an svg's own shape", '<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>', true],
    ["an svg with only a gradient", '<svg><linearGradient id="g"></linearGradient></svg>', false],
    ["a form's box", "<input type=range>", true],
    ["words a script page shows with no script", `<noscript>Charts need scripts.</noscript>${SCRIPT}`, true],
    ["plain words with a < in them", "<script>x()</script>1 < 2", true],
    // A hidden input draws nothing.
    ["a hidden input, unquoted", `<input type=hidden name=csrf value=Ada>${SCRIPT}`, false],
    ["a hidden input, quoted and in capitals", `<INPUT TYPE="HIDDEN" name="x"><input type='hidden'>${SCRIPT}`, false],
    ["a hidden input and a shown one", '<input type="hidden"><input type="text">', true],
    // Spaces of every width, written as entities, are no words.
    ["named spaces", `<p>&nbsp;&ensp;&emsp;&thinsp;&hairsp;&numsp;&ZeroWidthSpace;</p>${SCRIPT}`, false],
    ["numeric spaces", `<p>&#160;&#xA0;&#8194;&#x2009;&#8203;&#12288;&#xfeff;&#160</p>${SCRIPT}`, false],
    ["written spaces of every width", `<p>    ​　</p>${SCRIPT}`, false],
    ["an entity that draws", "<p>&amp;</p>", true],
    ["a numeric entity that draws", "<p>&#65;</p>", true],
    // A quoted attribute may hold a `>`: it ends no tag.
    ["a > inside a double-quoted attribute", `<div data-range="a>b"></div>${SCRIPT}`, false],
    ["a > inside a single-quoted attribute", `<div title='1 > 0' class=x></div>${SCRIPT}`, false],
    ["a > inside an attribute, then words", '<a title="x>y">Ledger</a>', true],
    // The words are read from the page itself, never from a lowercased copy that grew ("İ" lowercases to two units).
    ["a dotted capital I in an attribute, then a script's words", `<div title="${"İ".repeat(10)}"></div> <script>Hidden words</script>`, false],
    // A CSS drawing is a picture.
    ["an element whose style paints", '<div style="width:120px;height:8px;background:var(--chart-1)"></div>', true],
    ["an element whose style draws a border", `<span style="display:block;border:2px solid var(--border)"></span>${SCRIPT}`, true],
    ["an element whose style paints nothing", `<div style="background:transparent;border:none;height:40px"></div>${SCRIPT}`, false],
    ["a stylesheet that paints a box of the page", "<style>.sun{width:80px;height:80px;border-radius:50%;background:gold}</style><div class=\"sun\"></div>", true],
    ["a stylesheet inside a media rule", "<style>/* sun */@media (min-width:1px){.sun{box-shadow:0 0 0 4px red}}</style><div class=sun></div>", true],
    ["a stylesheet that colours only the whole frame", `<style>html, body{background:#fff;margin:0}</style><div id=chart></div>${SCRIPT}`, false],
    ["a stylesheet that paints, with no box to paint", "<style>.sun{background:gold}</style><script>draw()</script>", false],
  ];
  test.each(cases)("%s", (_why, page, draws) => {
    expect(inboxHtmlBlockDrawsStill(page)).toBe(draws);
  });

  test("a huge page is judged in one pass", () => {
    const hostile = "<script>".repeat(50_000) + "<p".repeat(50_000);
    expect(inboxHtmlBlockDrawsStill(hostile)).toBe(false);
    expect(inboxHtmlBlockDrawsStill(`<p>Fern</p>${hostile}`)).toBe(true);
    // Quoted values never closed, and attributes without end.
    expect(inboxHtmlBlockDrawsStill('<div a="'.repeat(50_000))).toBe(false);
    expect(inboxHtmlBlockDrawsStill("<div a=b ".repeat(50_000))).toBe(false);
  });
});

test("a page's name is read from the page itself after a dotted capital I", () => {
  expect(inboxHtmlBlockTitle(`<div title="${"İ".repeat(6)}"></div><h2>Harbor</h2>`)).toBe("Harbor");
});
