import { describe, expect, test } from 'bun:test';
import { HTML_ITEM_CSP, HTML_ITEM_FACE_LIMITS, checkHtmlItemFaces, htmlItemFaceCss, htmlItemSrcdoc } from './html-item';

const font = (length = 64, type = 'font/woff2') => `data:${type};base64,${'A'.repeat(length)}`;
const geist = { family: 'Geist', src: font(), weight: [100, 900] as [number, number] };
const mono = { family: 'Paper Mono', src: font(80), weight: 400, style: 'normal' as const };

describe('type a host lends to HTML items', () => {
  test('a lent face is written ahead of the item, only for an item that names it, and the policy stays first', () => {
    const doc = htmlItemSrcdoc('<p style="font-family: Geist, sans-serif">212 mm</p>', 'dark', [geist, mono]);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('@font-face'));
    expect(doc.indexOf('@font-face')).toBeLessThan(doc.indexOf('<body>'));
    expect(doc).toContain(`<style>@font-face{font-family:"Geist";src:url(${geist.src}) format("woff2");font-weight:100 900;font-display:block}</style>`);
    expect(doc).not.toContain('Paper Mono');
    // The policy is the one every item has: fonts from data: only, nothing fetched.
    expect(doc).toContain(HTML_ITEM_CSP.replace(/"/g, '&quot;'));
    expect(HTML_ITEM_CSP).toContain('font-src data:');
    // With nothing lent, or nothing named, the document is the one it always was.
    expect(htmlItemSrcdoc('<p>plain</p>', 'dark', [geist])).toBe(htmlItemSrcdoc('<p>plain</p>', 'dark'));
    expect(htmlItemSrcdoc('<p>Geist</p>', 'dark', [])).toBe(htmlItemSrcdoc('<p>Geist</p>', 'dark'));
  });

  test('nothing an item writes can close, change or add to the lent rules', () => {
    const hostile = '</style><style>@font-face{font-family:"Geist";src:url(https://evil.example/f.woff2)}</style><b style="font-family:Geist">x</b></body></html><style>@import url(https://evil.example/a.css)</style>';
    const doc = htmlItemSrcdoc(hostile, null, [geist]);
    const head = doc.slice(0, doc.indexOf('<body>'));
    // Everything the item wrote comes after the head; the head holds the policy, the lent face and the package's own style, each closed.
    expect(head).not.toContain('evil.example');
    expect(head.match(/<style>/g)?.length).toBe(2);
    expect(head.match(/<\/style>/g)?.length).toBe(2);
    expect(head.match(/@font-face/g)?.length).toBe(1);
    expect(doc.slice(doc.indexOf('<body>') + 6)).toBe(`${hostile}</body></html>`);
    // An item over its own size limit is not drawn, and gets no faces either.
    expect(htmlItemSrcdoc(`Geist${'x'.repeat(64_001)}`, null, [geist])).not.toContain('@font-face');
  });

  test('a family is a plain name and an address is a font\'s bytes as base64: anything else is left out', () => {
    const bad = [
      { family: 'Geist"; } body { display: none } @font-face { font-family: "x', src: font() },
      { family: 'Geist</style><script>', src: font() },
      { family: 'var(--x)', src: font() },
      { family: '', src: font() },
      { family: '9lives', src: font() },
      { family: 'G'.repeat(49), src: font() },
      { family: 'Remote', src: 'https://evil.example/f.woff2' },
      { family: 'Scheme', src: 'javascript:alert(1)' },
      { family: 'Picture', src: 'data:image/svg+xml;base64,AAAA' },
      { family: 'Page', src: 'data:text/html;base64,AAAA' },
      { family: 'NotBase', src: 'data:font/woff2,AAAA' },
      { family: 'Breaks', src: 'data:font/woff2;base64,AAAA) format("woff2")}body{display:none}@font-face{src:url(https://evil.example/x' },
      { family: 'Quote', src: 'data:font/woff2;base64,AA"AA' },
      { family: 'Space', src: 'data:font/woff2;base64,AA AA' },
      { family: 'Charset', src: 'data:font/woff2;charset=utf-8;base64,AAAA' },
      { family: 'Empty', src: 'data:font/woff2;base64,' },
      { family: 'Weight', src: font(), weight: '400; src: url(x)' },
      { family: 'Weight', src: font(), weight: 0 },
      { family: 'Weight', src: font(), weight: [900, 100] },
      { family: 'Slant', src: font(), style: 'oblique 10deg' },
      { family: 123, src: font() },
      { family: 'NoSrc' },
      null,
      'Geist',
      [geist],
    ];
    expect(checkHtmlItemFaces(bad)).toEqual([]);
    for (const input of [null, undefined, 'faces', { length: 1, 0: geist }, 7]) expect(checkHtmlItemFaces(input)).toEqual([]);
    // What passes is rebuilt from its checked fields: nothing else a host object carries comes along.
    const [kept] = checkHtmlItemFaces([{ ...geist, unicodeRange: 'U+0-10FFFF', src: geist.src, extra: '}' }]);
    expect(Object.keys(kept).sort()).toEqual(['family', 'src', 'weight']);
    // Every font type the policy would load is known by its format.
    for (const [type, format] of [['font/woff', 'woff'], ['font/ttf', 'truetype'], ['font/otf', 'opentype'], ['application/font-woff2', 'woff2'], ['application/x-font-ttf', 'truetype']]) {
      expect(htmlItemFaceCss('Geist', [{ family: 'Geist', src: font(8, type) }])).toContain(`format("${format}")`);
    }
    // A list that was never checked is checked where it is written.
    expect(htmlItemFaceCss('Geist x', [{ family: 'Geist', src: 'https://evil.example/f.woff2' }, { family: 'x"}', src: font() }] as never)).toBe('');
  });

  test('a face over its size, a face past the total, a seventh face and a repeat are dropped; the rest are kept', () => {
    const big = { family: 'Big', src: font(HTML_ITEM_FACE_LIMITS.faceLength) };
    expect(checkHtmlItemFaces([big, geist])).toEqual([geist]);
    const fits = (name: string) => ({ family: name, src: font(HTML_ITEM_FACE_LIMITS.faceLength - 200) });
    // Two fill the total (their addresses are counted whole); a third that size does not fit; a small one after it still does.
    expect(checkHtmlItemFaces([fits('One'), fits('Two'), fits('Three'), geist]).map((face) => face.family)).toEqual(['One', 'Two', 'Geist']);
    const many = Array.from({ length: 20 }, (_, i) => ({ family: `Face ${String.fromCharCode(65 + i)}`, src: font() }));
    expect(checkHtmlItemFaces(many).length).toBe(HTML_ITEM_FACE_LIMITS.faces);
    expect(checkHtmlItemFaces([geist, { ...geist, family: 'GEIST' }, { ...geist, weight: 700 }]).map((face) => face.weight)).toEqual([[100, 900], 700]);
    // A list of any length is not walked to its end.
    expect(checkHtmlItemFaces(new Array(1_000_000).fill(null))).toEqual([]);
  });
});
