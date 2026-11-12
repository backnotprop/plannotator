import { describe, expect, test } from "bun:test";
import * as parse5 from "parse5";
import { shapeHtmlDataCodes } from "@plannotator/core/shape";
import { DATA_CODE_BYPASSES, htmlSoup, seededRandom } from "../../../tests/helpers/html-soup";

type Node = { nodeName: string; attrs?: { name: string; value: string }[]; childNodes?: Node[]; content?: Node };

const context = parse5.parseFragment("<div></div>").childNodes[0] as unknown as parse5.DefaultTreeAdapterMap["element"];

function parse5Codes(html: string, scriptingEnabled: boolean): string[] {
  const out: string[] = [];
  const walk = (node: Node) => {
    for (const a of node.attrs ?? []) if (a.name === "data-code") out.push(a.value);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(parse5.parseFragment(context, html, { scriptingEnabled }) as unknown as Node);
  walk(parse5.parse(html, { scriptingEnabled }) as unknown as Node);
  return out;
}

describe("shapeHtmlDataCodes against parse5", () => {
  test("the reported bypasses: odd comment ends, `<!--` inside text elements, noscript, svg and math", () => {
    for (const html of DATA_CODE_BYPASSES) {
      expect([html, [true, false].some((on) => parse5Codes(html, on).includes("src/zzz.ts#L1"))]).toEqual([html, true]);
      expect([html, shapeHtmlDataCodes(html)]).toEqual([html, ["src/zzz.ts#L1"]]);
    }
  });

  test("it stays linear on markup made to make a reader start over (300 KB, the html limit)", () => {
    for (const unit of ["<a/data-code=", '<a x="<b y=\'', "<a <a <a ", '<a data-code="'] as const) {
      const html = unit.repeat(Math.floor(300_000 / unit.length));
      const started = performance.now();
      const codes = shapeHtmlDataCodes(html);
      expect([unit, performance.now() - started < 1_000]).toEqual([unit, true]);
      for (const code of codes) expect(code.length).toBeLessThanOrEqual(513);
    }
  });

  test("random markup: every code parse5 reads, scripting on or off, the reader reads", () => {
    const next = seededRandom(0x5eed);
    let id = 0;
    const code = () => `c${id++}`;
    const missed: string[] = [];
    let read = 0;
    for (let k = 0; k < 20_000; k++) {
      const html = htmlSoup(next, code);
      const want = [...parse5Codes(html, true), ...parse5Codes(html, false)];
      const got = new Set(shapeHtmlDataCodes(html));
      if (want.some((c) => !got.has(c))) missed.push(html);
      read += want.length;
    }
    expect(missed.slice(0, 5)).toEqual([]);
    expect(read).toBeGreaterThan(20_000);
  });
});
