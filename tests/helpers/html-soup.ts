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

const VALUE_TAILS = ["&amp;", "&AMP;", "&nbsp;", "&lt;", "&QUOT;", "&#38;#x2F;", "&#x41;", "&#65;", "&#0;", "\u0000", "&amp;lt;"];

export function htmlSoup(next: () => number, code: () => string): string {
  let html = "";
  const count = 4 + Math.floor(next() * 14);
  for (let k = 0; k < count; k++) {
    const roll = next();
    if (roll < 0.22) {
      const c = next() < 0.3 ? `${code()}${VALUE_TAILS[Math.floor(next() * VALUE_TAILS.length)]}` : code();
      const form = Math.floor(next() * 3);
      html += form === 0 ? ` data-code="${c}"` : form === 1 ? ` data-code='${c}'` : ` data-code=${c}`;
    } else if (roll < 0.3) html += `<div data-code="${code()}">`;
    else if (roll < 0.32) html += "\u0000";
    else html += PIECES[Math.floor(next() * PIECES.length)]!;
  }
  return html;
}

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
