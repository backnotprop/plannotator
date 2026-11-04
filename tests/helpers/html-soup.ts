/**
 * Random markup for the `data-code` reader's tests (shapeHtmlDataCodes): the
 * pieces that move an HTML parser (comments and their odd ends, raw-text and
 * RCDATA elements, noscript, script escapes, quotes, end tags with
 * attributes, svg, math, CDATA), with a fresh `data-code` value each time, so
 * a code missed names its case. Seeded, so a failure comes back.
 */

/** A small seeded generator (mulberry32). */
export function seededRandom(seed: number): () => number {
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
  "<annotation-xml>", "<annotation-xml encoding=text/html>", "</annotation-xml>", "<section>", "<select>", "<template>", "</template>", "<table>", "<td>",
  "<p>", "</p>", "<br>", "<span>", "</span>", "<b>", "<font color=red>", "<div", "<div>", "</div>", "</div x=\">\">", "<a", "<A ",
  '"', "'", "=", " ", "/", ">", "<", "x", "text", "&quot;", "\n",
];

/** Markup of 4 to 17 pieces; `code()` names each `data-code` value. */
export function htmlSoup(next: () => number, code: () => string): string {
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

/** The delta-3 and delta-4 reviews' payloads: each hid `src/zzz.ts#L1` from an earlier reader. */
export const DATA_CODE_BYPASSES: readonly string[] = [
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
  '<noscript><div data-mark="a" data-code="src/zzz.ts#L1">part</div></noscript>',
  '<svg><foreignObject><div></svg></div></foreignObject><textarea><b data-code="src/zzz.ts#L1">x</b></textarea></svg>',
  '<svg><foreignObject><div></svg></div></foreignObject><xmp><b data-code="src/zzz.ts#L1">x</b></xmp></svg>',
  '<svg><foreignObject><span></svg></span></foreignObject><noframes><b data-code="src/zzz.ts#L1">x</b></noframes></svg>',
  '<svg><foreignObject><div></foreignObject><![CDATA[x><b data-code="src/zzz.ts#L1">x</b>]]></div></foreignObject></svg>',
  '<math><annotation-xml><svg><foreignObject><section><![CDATA[x><b data-code="src/zzz.ts#L1">x</b>]]></section></foreignObject></svg></annotation-xml></math>',
];
