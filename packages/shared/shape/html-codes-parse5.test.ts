/**
 * Shape's `data-code` reader (core's shapeHtmlDataCodes, a small tokenizer
 * kept in core so it stays browser-safe) held to parse5's reading, the HTML
 * spec's parser: random markup made of the pieces that move a tokenizer
 * (comments and their odd ends, raw-text and RCDATA elements, script escapes,
 * quotes, end tags with attributes, svg and math), and every code parse5 puts
 * in the tree must be one the reader finds. The checks that use it (a Shape
 * picture's codes, a Show me drawing's files) must never miss a part the board
 * would draw.
 */
import { describe, expect, test } from "bun:test";
import * as parse5 from "parse5";
import { shapeHtmlDataCodes } from "@plannotator/core/shape";

type Node = { nodeName: string; attrs?: { name: string; value: string }[]; childNodes?: Node[]; content?: Node };

/** The board draws the picture inside a div, with scripting on (parse5's default). */
const context = parse5.parseFragment("<div></div>").childNodes[0] as unknown as parse5.DefaultTreeAdapterMap["element"];

function parse5Codes(html: string): string[] {
  const out: string[] = [];
  const walk = (node: Node) => {
    for (const a of node.attrs ?? []) if (a.name === "data-code") out.push(a.value);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(parse5.parseFragment(context, html) as unknown as Node);
  return out;
}

/** A small seeded generator, so a failure names a case that comes back. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "<!--", "-->", "--!>", "<!-->", "<!--->", "--", "-", "!", "<!", "<!x>", "<?x>", "</>", "</ x>", "<![CDATA[", "]]>",
  "<textarea>", "</textarea>", "<title>", "</title>", "<xmp>", "</xmp>", "<noembed>", "</noembed>", "<noframes>", "</noframes>",
  "<noscript>", "</noscript>", "<iframe>", "</iframe>", "<style>", "</style>", "</style x='>'>", "<script>", "</script>", "<script", "</script ",
  "<svg>", "</svg>", "<svg/>", "<math>", "</math>", "<foreignObject>", "</foreignObject>", "<desc>", "</desc>", "<mi>", "</mi>", "<g>", "</g>",
  "<p>", "</p>", "<br>", "<span>", "</span>", "<b>", "<font color=red>", "<div", "<div>", "</div>", "</div x=\">\">", "<a", "<A ",
  '"', "'", "=", " ", "/", ">", "<", "x", "text", "&quot;", "\n",
];

function soup(next: () => number, code: () => string): string {
  let html = "";
  const count = 4 + Math.floor(next() * 14);
  for (let k = 0; k < count; k++) {
    const roll = next();
    if (roll < 0.22) {
      const c = code();
      const form = Math.floor(next() * 3);
      html += form === 0 ? ` data-code="${c}"` : form === 1 ? ` data-code='${c}'` : ` data-code=${c}`;
    } else if (roll < 0.3) html += `<div data-code="${code()}">`;
    else html += PIECES[Math.floor(next() * PIECES.length)]!;
  }
  return html;
}

describe("shapeHtmlDataCodes against parse5", () => {
  test("the reported bypasses: odd comment ends and `<!--` inside text elements", () => {
    for (const html of [
      '<!--><div data-mark="a" data-code="src/zzz.ts#L1">',
      '<!---><div data-code="src/zzz.ts#L1">',
      '<!-- a --!><div data-code="src/zzz.ts#L1">',
      "<textarea><!--</textarea><div data-code=src/zzz.ts#L1>",
      "<title><!--</title><div data-code=src/zzz.ts#L1>",
      "<xmp><!--</xmp><div data-code=src/zzz.ts#L1>",
      "<noembed><!--</noembed><div data-code=src/zzz.ts#L1>",
      "<noframes><!--</noframes><div data-code=src/zzz.ts#L1>",
      "<noscript><!--</noscript><div data-code=src/zzz.ts#L1>",
      '<textarea><a title="</textarea><div data-code=src/zzz.ts#L1>">',
      '<script><!--<script></script><!--</script><div data-code="src/zzz.ts#L1">',
      '</a x=">" y="<!--"><div data-code="src/zzz.ts#L1">',
    ]) {
      expect([html, parse5Codes(html)]).toEqual([html, ["src/zzz.ts#L1"]]);
      expect([html, shapeHtmlDataCodes(html)]).toEqual([html, ["src/zzz.ts#L1"]]);
    }
  });

  test("random markup: every code parse5 reads, the reader reads", () => {
    const next = random(0x5eed);
    let id = 0;
    const code = () => `c${id++}`;
    const missed: string[] = [];
    let extra = 0;
    let read = 0;
    for (let k = 0; k < 40_000; k++) {
      const html = soup(next, code);
      const want = parse5Codes(html);
      const got = new Set(shapeHtmlDataCodes(html));
      if (want.some((c) => !got.has(c))) missed.push(html);
      read += want.length;
      extra += got.size - new Set(want).size;
    }
    expect(missed.slice(0, 5)).toEqual([]);
    // Reading more only makes a check stricter (a repeated attribute, a tag the tree builder drops); it stays rare.
    expect(read).toBeGreaterThan(20_000);
    expect(extra / read).toBeLessThan(0.06);
  });
});
