/**
 * Mermaid draws a diagram into the live page to measure it, before
 * `diagram-render`'s sanitizer sees the svg. Two things in a source load from
 * the network at that moment and no Mermaid config can stop them:
 *
 * - CSS the source writes into Mermaid's own stylesheet or a `style`
 *   attribute (a `%%{init}%%` directive's or front matter's `themeCSS` or
 *   `fontFamily`, a `style` or `classDef` line, a label's `style`), when it
 *   names another host: `url(https://…)`, `url(//…)`, `image-set("https://…")`,
 *   `@import "https://…"`. A relative or `data:` address, or a `#fragment`,
 *   is not another host and draws as before.
 * - A picture node (shape data with an `img` key, `A@{ img: "…" }`): Mermaid
 *   loads the picture with `new Image()` before drawing anything.
 *
 * `mermaidSourceLoads` says when a source holds either; `renderDiagram` then
 * shows it as its source instead of drawing it. Label HTML that loads
 * (`<img src>`, `<video poster>`, …) is not refused here: Mermaid's own label
 * pass removes it (`MERMAID_LABEL_FORBIDDEN_TAGS` in `./mermaid`).
 *
 * The source is read the way the page will read it: Mermaid's `#…;` entity
 * codes and its placeholders, then HTML character references, then CSS
 * escapes are decoded first, and tabs and line breaks (which a URL parser
 * drops) are removed.
 */

/** Mermaid's `#40;` / `#lpar;` codes and the placeholders it turns them into (`ﬂ°°`, `ﬂ°`, `¶ß`). */
function decodeMermaidEntities(text: string): string {
  return text
    .replace(/ﬂ°°/g, '&#')
    .replace(/ﬂ°/g, '&')
    .replace(/¶ß/g, ';')
    .replace(/#(\+?\d+);/g, '&#$1;')
    .replace(/#([a-z]\w*);/gi, '&$1;');
}

let decoder: HTMLTextAreaElement | null = null;

/** HTML character references, as an HTML parser reads an attribute (numeric and named). */
function decodeHtmlReferences(text: string): string {
  if (!text.includes('&')) return text;
  if (typeof document !== 'undefined') {
    // A textarea's content is text only: parsing it creates no element and loads nothing.
    decoder ??= document.createElement('textarea');
    decoder.innerHTML = text.replace(/</g, '&lt;');
    return decoder.value;
  }
  return text.replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (_m, hex: string | undefined, dec: string | undefined) =>
    String.fromCodePoint(Math.min(hex !== undefined ? Number.parseInt(hex, 16) : Number(dec), 0x10ffff) || 0xfffd),
  );
}

function decodeCssEscapes(text: string): string {
  return text.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/giu, (_m, hex: string | undefined, ch: string | undefined) =>
    hex !== undefined ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16) || 0xfffd, 0x10ffff)) : (ch ?? ''),
  );
}

/** YAML double-quoted escapes (`\x69`, `i`, `\U00000069`), so a key spelled with them is read as itself. */
function decodeYamlEscapes(text: string): string {
  return text.replace(/\\(?:x([0-9a-f]{2})|u([0-9a-f]{4})|U([0-9a-f]{8}))/g, (_m, a?: string, b?: string, c?: string) =>
    String.fromCodePoint(Math.min(Number.parseInt((a ?? b ?? c) as string, 16), 0x10ffff)),
  );
}

/** An address that resolves to another host: a scheme (other than `data:`), `//`, or a backslash pair a URL parser reads as `//`. */
function namesAnotherHost(address: string): boolean {
  const target = address.replace(/^[\s"'([{]+/, '').toLowerCase();
  if (target.startsWith('data:') || target.startsWith('#')) return false;
  return /^[a-z][a-z\d+.-]*:/.test(target) || /^[\\/]{2}/.test(target);
}

/** CSS that fetches: `url(`, `image-set(` (and `-webkit-image-set(`), `image(`, `src(`, `@import`. */
const CSS_LOADER = /(?<![a-z0-9_])(?:url|image-set|image|src)\(|@import/gi;

/** A loader's arguments, split at top-level commas, up to its closing paren (or `;` for `@import`). */
function loaderArguments(text: string, from: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = from; i < text.length && i < from + 4096; i += 1) {
    const ch = text[i] as string;
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ';' && depth === 0) break;
    else if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current);
  return args;
}

function cssReachesAnotherHost(text: string): boolean {
  for (const match of text.matchAll(CSS_LOADER)) {
    // A nested `url(` is matched on its own; a string argument (`image-set("…")`, `@import "…"`) is read here.
    for (const arg of loaderArguments(text, (match.index ?? 0) + match[0].length)) if (namesAnotherHost(arg)) return true;
  }
  return false;
}

/** A shape-data `img` key (`A@{ img: … }`, quoted or not, `? img`), anywhere after the first `@{`. */
const SHAPE_IMG_KEY = /(?:^|[\s{,?"'])img["']?\s*:/;

export function mermaidSourceLoads(source: string): boolean {
  // Every order the layers can be read in: a plain `&#40;` is an HTML reference to the page even where Mermaid's own
  // `#40;` reading would split it.
  const readings = new Set<string>();
  for (const start of [source, decodeMermaidEntities(source)]) {
    const html = decodeHtmlReferences(start);
    for (const text of [start, html, decodeCssEscapes(start), decodeCssEscapes(html)]) readings.add(text);
  }
  for (const text of readings) {
    const flat = text.replace(/[\t\n\r]/g, '');
    if (cssReachesAnotherHost(flat)) return true;
  }
  const shapeData = source.indexOf('@{');
  if (shapeData !== -1) {
    const data = source.slice(shapeData);
    if (SHAPE_IMG_KEY.test(data) || SHAPE_IMG_KEY.test(decodeYamlEscapes(data))) return true;
  }
  return false;
}
