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
  test("words or a picture draw; a chart a script draws, styles, comments and a title do not", () => {
    // A heading and a table: a picture.
    expect(inboxHtmlBlockDrawsStill("<h2>Harbor · tide table</h2><table><tr><td>06:12</td></tr></table>")).toBe(true);
    // Drawn by its own script into an empty svg or a canvas: the mark.
    const chart = ['<svg id="tides" viewBox="0 0 360 120" style="display:block;width:360px"></svg>', "<script>", "const r = '<rect>Tide</rect>';", "</script>"].join("\n");
    expect(inboxHtmlBlockDrawsStill(chart)).toBe(false);
    expect(inboxHtmlBlockDrawsStill('<div id="chart" style="height:300px;background:#fff"></div><canvas id="c"></canvas><script src="https://cdn.example/chart.js"></script>')).toBe(false);
    // Words only in what is never drawn, or no words at all.
    expect(inboxHtmlBlockDrawsStill("<title>Ledger</title><style>body{color:red}</style><!-- Bob Tully's draft --><template><p>later</p></template><div>&nbsp;</div>")).toBe(false);
    expect(inboxHtmlBlockDrawsStill("   ")).toBe(false);
    // A script never closed hides the rest of the page, as the browser does.
    expect(inboxHtmlBlockDrawsStill("<script>draw(); <p>never shown</p>")).toBe(false);
    // Drawn with no words: an image, an svg's own shape, a form's box.
    expect(inboxHtmlBlockDrawsStill('<img src="data:image/png;base64,AAAA" alt="">')).toBe(true);
    expect(inboxHtmlBlockDrawsStill('<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>')).toBe(true);
    expect(inboxHtmlBlockDrawsStill('<svg><linearGradient id="g"></linearGradient></svg>')).toBe(false);
    expect(inboxHtmlBlockDrawsStill("<input type=range>")).toBe(true);
    // Words a script page shows with no script (<noscript>), and plain words with a `<` in them.
    expect(inboxHtmlBlockDrawsStill("<noscript>Charts need scripts.</noscript><script>draw()</script>")).toBe(true);
    expect(inboxHtmlBlockDrawsStill("<script>x()</script>1 < 2")).toBe(true);
  });

  test("a huge page is judged in one pass", () => {
    const hostile = "<script>".repeat(50_000) + "<p".repeat(50_000);
    const started = performance.now();
    expect(inboxHtmlBlockDrawsStill(hostile)).toBe(false);
    expect(inboxHtmlBlockDrawsStill(`<p>Fern</p>${hostile}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(300);
  });
});
