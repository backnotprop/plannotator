/**
 * Shape's shapeKeepSvgWhole held to parse5, the HTML spec's parser (the
 * board's sanitizer parses the drawing this way). What regresses if these
 * fail: an HTML tag inside an `<svg>` (an empty `<span data-ref="1"></span>`
 * among the shapes, as agents write it) ends the SVG there, and every part
 * drawn after it is lost from the board; or HTML the page reads as HTML (in a
 * foreignObject, outside any SVG) gets renamed.
 */
import { describe, expect, test } from "bun:test";
import * as parse5 from "parse5";
import { shapeKeepSvgWhole } from "@plannotator/core/shape";

type Node = { nodeName: string; namespaceURI?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[]; parentNode?: Node | null };

const SVG = "http://www.w3.org/2000/svg";
const HTML = "http://www.w3.org/1999/xhtml";

/** The board draws the picture inside a div; DOMPurify parses it as a document. Both must agree. */
function parsed(html: string): Node[] {
  const context = parse5.parseFragment("<div></div>").childNodes[0] as unknown as parse5.DefaultTreeAdapterMap["element"];
  return [parse5.parseFragment(context, html) as unknown as Node, parse5.parse(html) as unknown as Node];
}

function find(root: Node, attr: string, value: string): Node | undefined {
  if (root.attrs?.some((a) => a.name === attr && a.value === value)) return root;
  for (const child of root.childNodes ?? []) {
    const hit = find(child, attr, value);
    if (hit) return hit;
  }
  return undefined;
}

const inside = (node: Node | undefined, name: string): boolean => {
  for (let at = node?.parentNode; at; at = at.parentNode) if (at.nodeName === name) return true;
  return false;
};

/** An agent's board: a number after a part's words, one inside words, an empty HTML block, then more shapes. */
const BOARD =
  '<svg viewBox="0 0 400 200"><g data-mark="queue"><rect x="10" y="10" width="100" height="40"/><text x="20" y="35">Queue</text><span data-ref="1"></span></g>' +
  '<g data-mark="diff"><rect id="k1" x="200" y="10" width="100" height="40"/><text x="210" y="35">Diff <span data-ref="2"></span></text></g>' +
  '<div></div><circle id="k2" cx="50" cy="150" r="9"/></svg><p id="k3">after</p>';

describe("shapeKeepSvgWhole against parse5", () => {
  test("as written, the span ends the SVG and the parts after it leave it", () => {
    for (const root of parsed(BOARD)) {
      expect(find(root, "data-ref", "1")?.namespaceURI).toBe(HTML);
      expect(inside(find(root, "id", "k2"), "svg")).toBe(false);
    }
  });

  test("kept whole: every part after the span stays in the SVG, and each number stays in place", () => {
    for (const root of parsed(shapeKeepSvgWhole(BOARD))) {
      for (const id of ["k1", "k2"]) {
        const part = find(root, "id", id);
        expect([id, part?.namespaceURI, inside(part, "svg")]).toEqual([id, SVG, true]);
      }
      const one = find(root, "data-ref", "1");
      expect([one?.namespaceURI, inside(one, "g")]).toEqual([SVG, true]);
      // Inside the words, the number is a run of those words.
      const two = find(root, "data-ref", "2");
      expect([two?.namespaceURI, two?.nodeName, inside(two, "text")]).toEqual([SVG, "tspan", true]);
      // What follows the SVG stays HTML, outside it.
      const after = find(root, "id", "k3");
      expect([after?.namespaceURI, inside(after, "svg")]).toEqual([HTML, false]);
    }
  });

  test("the other tags that end an SVG, when they hold nothing, and any inside words, keep the drawing", () => {
    const html =
      '<svg><text x="1" y="1"><b>bold</b> and<br>more <font color="red">red</font></text><br><hr><span data-ref="1"/><p></p></p></br>' +
      '<font color="red"></font><div> </div><rect id="k1"/><g><span data-ref="2"></span><rect id="k2"/></g></svg>';
    for (const root of parsed(html)) expect(inside(find(root, "id", "k1"), "svg")).toBe(false);
    for (const root of parsed(shapeKeepSvgWhole(html))) {
      for (const id of ["k1", "k2"]) expect([id, find(root, "id", id)?.namespaceURI, inside(find(root, "id", id), "svg")]).toEqual([id, SVG, true]);
      // A tag with no end tag (`<br>`, `<hr>`) holds nothing: the parts after it keep their place.
      expect(find(root, "id", "k1")?.parentNode?.nodeName).toBe("svg");
      for (const n of ["1", "2"]) expect(find(root, "data-ref", n)?.namespaceURI).toBe(SVG);
    }
  });

  test("a tag with words or a picture outside <text> is left as written, so the page still shows it as HTML", () => {
    // SVG draws no words in a <g> and no <img>: renamed, a legend or a picture would vanish.
    for (const html of [
      '<svg width="300" height="60"><rect width="50" height="20"/><div id="w">Legend: dashed means planned</div></svg>',
      '<svg><g><b id="w">bold label</b></g></svg>',
      '<svg><rect/><span id="w" data-ref="1">1</span></svg>',
      '<svg><rect/><img id="w" src="files/a.png"></svg>',
      '<svg><text>a <img id="w" src="files/a.png"></text></svg>',
      '<svg><rect/><ul id="w"><li>one</li></ul><span data-ref="1"></span></svg>',
      '<svg><foreignObject><svg><p id="w">words</p></svg><span data-ref="1"></span></foreignObject></svg>',
    ]) {
      expect(shapeKeepSvgWhole(html)).toBe(html);
      for (const root of parsed(html)) expect([html, find(root, "id", "w")?.namespaceURI]).toEqual([html, HTML]);
    }
  });

  test("a > inside a quoted attribute, CDATA and end tags written either way are read as the page reads them", () => {
    const quoted = '<svg><rect title="a>b <span>"/><span data-ref="1"></span><rect id="k1"/></svg>';
    const cdata = '<svg><text id="t"><![CDATA[a > <span> b]]></text><span data-ref="1"></span><rect id="k1"/></svg>';
    // `<b>` became a tspan, and `</tspan>` closes it; a later `</b>` then closes nothing (not the next tspan).
    const ends = '<svg><text>a <b>b</tspan> c <tspan id="k1">d</b> e</tspan></text></svg>';
    for (const root of parsed(shapeKeepSvgWhole(quoted))) {
      expect(find(root, "id", "k1")?.parentNode?.nodeName).toBe("svg");
      expect(find(root, "title", "a>b <span>")?.nodeName).toBe("rect");
    }
    for (const root of parsed(shapeKeepSvgWhole(cdata))) {
      expect(find(root, "id", "k1")?.parentNode?.nodeName).toBe("svg");
      const t = find(root, "id", "t")!;
      expect(t.childNodes?.map((c) => (c as { value?: string }).value ?? "").join("")).toBe("a > <span> b");
    }
    for (const root of parsed(shapeKeepSvgWhole(ends))) expect(find(root, "id", "k1")?.childNodes?.map((c) => (c as { value?: string }).value ?? "").join("")).toBe("d e");
  });

  test("it stays linear on markup made to make it start over (300 KB, the html limit)", () => {
    for (const unit of ["<!--", "<!--x--", "<!--x-->", "<svg><a>", "<svg><span>", "<svg></zz>", "<svg><text><b>", '<svg><a x="']) {
      const html = unit.repeat(Math.floor(300_000 / unit.length));
      const started = performance.now();
      shapeKeepSvgWhole(html);
      expect([unit, performance.now() - started < 1_000]).toEqual([unit, true]);
    }
  });

  test("HTML the page reads as HTML is left as written", () => {
    for (const html of [
      '<div><span data-ref="1"></span><b>x</b></div>',
      '<svg><foreignObject width="90" height="30"><div>Label <span data-ref="1"></span></div></foreignObject><rect/></svg>',
      '<svg><foreignObject width="90" height="30"><span data-ref="1"></span></foreignObject><rect/></svg>',
      '<svg><title>A <b>title</b></title><desc><p>words</p></desc></svg><span data-ref="1"></span>',
      '<textarea><svg><span></span></textarea><span data-ref="1"></span>',
      '<!-- a > <svg> --><span data-ref="1"></span>',
      '<svg><rect/></svg><div><span data-ref="1"></span></div>',
    ]) {
      expect(shapeKeepSvgWhole(html)).toBe(html);
    }
  });
});
