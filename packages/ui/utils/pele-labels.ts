/**
 * Math (`$$…$$`) and styled text in labels that Pele draws, with no change to
 * Pele. Three steps around one Pele render (`diagram-render.ts`, `renderPele`):
 *
 * 1. `preparePeleLabels(source)` rewrites the source. Each `$$tex$$` is
 *    typeset with the app's math renderer (KaTeX to MathML, the call Mermaid
 *    makes for its own math labels), measured in the page, and replaced by
 *    private-use placeholder characters: one token for short math beside
 *    words, or one token per line of height for taller math, on lines of its
 *    own (`<br>`). Each styled HTML run (`<span style="color:…">`,
 *    `<font color>`, `<u>`, `<ins>`, `<s>`, `<del>`, `<strike>`, `<code>`,
 *    `<kbd>`) becomes a start and an end marker with its tags removed;
 *    pictures (`<img>`) and Font Awesome icons (`fa:fa-…`) are dropped.
 * 2. `peleLabelMeasurer(base, prepared)` wraps the text measurer Pele is
 *    given: a math token measures as its typeset width, a marker as nothing,
 *    and text inside a `<code>` run in the mono font. Pele therefore reserves
 *    the right space and wraps the label as it will be drawn.
 * 3. `finishPeleLabels(svg, prepared, measurer)` rewrites Pele's svg markup
 *    (an inert template, never the page): marker runs become `<tspan>`s with
 *    `fill`, `text-decoration` and the mono font; the tokens of each formula
 *    become one `<foreignObject class="pele-math">` holding the MathML,
 *    centred in the box its tokens reserved, in the label's colour. The
 *    result goes through the diagram sanitizer like any svg (its MathML
 *    profile keeps the formula).
 *
 * A formula keeps its TeX where the comment finder reads it: the line or gap
 * it replaced carries `data-pele-tex` (`peleLabelText` in
 * `diagram-anchor-pele.ts`), so a part whose label is only math has the TeX
 * as its label, not nothing.
 *
 * With no layout (happy-dom) the page measures 0: the size is estimated from
 * the TeX instead, so tests still see the same structure.
 */
import DOMPurify from 'dompurify';
import type { TextMeasurer } from 'pele';
import { getMathRenderer, loadMathRenderer, type MathRenderer } from './math';
import { hasMermaidMath } from './mermaid-math-slot';

/** Pele's line height, in em of the label font. */
const LINE_HEIGHT = 1.5;
/** Where Pele puts a line's baseline below its centre, in em. */
const BASELINE = 0.35;
/** Mermaid's own math label pattern (`katexRegex`). */
const MATH_PATTERN = /\$\$(.*?)\$\$/gu;
/** Tags whose run is styled; `span` and `font` count only with a colour or decoration. */
const STYLED_TAG = /<(\/?)(span|font|u|ins|s|del|strike|code|kbd)(\s[^<>]*)?>/giu;
const IMG_TAG = /<img\b[^<>]*>/giu;
/** Mermaid's icon syntax in a label (`fa:fa-car`, `fab:fa-github`). */
const FA_ICON = /\bfa[bklrs]?:fa-[\w-]+/gu;

/**
 * A colour an author may give a run: a name, a hex value, or `rgb()`/`rgba()`
 * and `hsl()`/`hsla()` with numbers only. Nothing that can carry `url(`,
 * `var(`, `expression(` or a `;`. Each separator has one way to match
 * (a comma with optional spaces, or spaces), so a long run of spaces cannot
 * make it backtrack.
 */
export const SAFE_LABEL_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\(\s*[\d.]+%?(?:(?:\s*,\s*|\s+)[\d.]+%?){2}(?:\s*[,/]\s*[\d.]+%?)?\s*\)|hsla?\(\s*[\d.]+(?:deg)?(?:(?:\s*,\s*|\s+)[\d.]+%){2}(?:\s*[,/]\s*[\d.]+%?)?\s*\))$/iu;

/** No colour this pattern accepts needs more; longer values are refused before the pattern runs. */
const SAFE_LABEL_COLOR_MAX = 64;

export function safeLabelColor(value: string | null | undefined): string | null {
  const color = (value ?? '').trim();
  if (color === '' || color.length > SAFE_LABEL_COLOR_MAX) return null;
  return SAFE_LABEL_COLOR.test(color) && !/^(?:inherit|initial|unset|revert|currentcolor)$/iu.test(color) ? color : null;
}

/**
 * Every `%%{…}%%` directive of a source, in order: what `/%%\{([\s\S]*?)\}%%/g`
 * finds, by `indexOf`, so an unclosed `%%{` costs one scan, not one per `%%{`.
 */
export function mermaidDirectives(source: string): { start: number; end: number; body: string }[] {
  const out: { start: number; end: number; body: string }[] = [];
  for (let from = 0; ; ) {
    const open = source.indexOf('%%{', from);
    if (open === -1) break;
    const close = source.indexOf('}%%', open + 3);
    if (close === -1) break;
    out.push({ start: open, end: close + 3, body: source.slice(open + 3, close) });
    from = close + 3;
  }
  return out;
}

/** The diagram type word, after front matter, `%%{…}%%` directives (one line or several) and `%%` comments. */
export function mermaidDiagramType(source: string): string {
  const skipSpace = (i: number): number => {
    while (i < source.length && /\s/u.test(source[i] ?? '')) i += 1;
    return i;
  };
  let i = skipSpace(0);
  if (source.startsWith('---', i)) {
    const close = source.indexOf('---', i + 3);
    if (close !== -1) i = close + 3;
  }
  for (;;) {
    i = skipSpace(i);
    if (source.startsWith('%%{', i)) {
      const close = source.indexOf('}%%', i + 3);
      if (close === -1) return '';
      i = close + 3;
    } else if (source.startsWith('%%', i)) {
      const newline = source.indexOf('\n', i);
      if (newline === -1) return '';
      i = newline + 1;
    } else break;
  }
  return /^\w+/u.exec(source.slice(i, i + 64))?.[0] ?? '';
}

// ---------------------------------------------------------------- the codes

/**
 * The placeholder characters, in one private-use block `[base, base+0x600)`
 * that the source does not use: formula `i` is `base + i`, led by `base+0x100`
 * on its first line and `base+0x101` on the others; style `k` starts at
 * `base+0x200+k` and ends at `base+0x400+k`.
 */
const BLOCK_BASES = [0xe000, 0xe800, 0xf000] as const;
const BLOCK_SIZE = 0x600;
const MAX_ITEMS = 0x100;

export class PeleLabelCodes {
  constructor(readonly base: number) {}
  get lead(): string {
    return String.fromCharCode(this.base + 0x100);
  }
  get leadMore(): string {
    return String.fromCharCode(this.base + 0x101);
  }
  math(i: number): string {
    return String.fromCharCode(this.base + i);
  }
  start(k: number): string {
    return String.fromCharCode(this.base + 0x200 + k);
  }
  end(k: number): string {
    return String.fromCharCode(this.base + 0x400 + k);
  }
  isLead(c: number): boolean {
    return c === this.base + 0x100 || c === this.base + 0x101;
  }
  mathIndex(c: number): number {
    const i = c - this.base;
    return i >= 0 && i < MAX_ITEMS ? i : -1;
  }
  startIndex(c: number): number {
    const k = c - this.base - 0x200;
    return k >= 0 && k < MAX_ITEMS ? k : -1;
  }
  endIndex(c: number): number {
    const k = c - this.base - 0x400;
    return k >= 0 && k < MAX_ITEMS ? k : -1;
  }
  has(text: string): boolean {
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c >= this.base && c < this.base + BLOCK_SIZE) return true;
    }
    return false;
  }
}

/**
 * The characters an entity in the source stands for: Pele decodes Mermaid's
 * `#57600;` (and an HTML `&#xE100;`) into a label, so an entity can write a
 * placeholder the source never typed. Read as decimal or hex, with or
 * without `&`, whichever way Pele reads it.
 */
function entityChars(source: string): string {
  let out = '';
  for (const match of source.matchAll(/#(?:x([0-9a-f]{1,6})|(\d{1,7}));/giu)) {
    const code = match[1] !== undefined ? Number.parseInt(match[1], 16) : Number(match[2]);
    if (code <= 0xffff) out += String.fromCharCode(code);
  }
  return out;
}

/** The first block neither the source nor an entity in it touches; null when they touch all three. */
function codesFor(source: string): PeleLabelCodes | null {
  const decoded = entityChars(source);
  for (const base of BLOCK_BASES) {
    const codes = new PeleLabelCodes(base);
    if (!codes.has(source) && !codes.has(decoded)) return codes;
  }
  return null;
}

// ---------------------------------------------------------------- the model

export interface PeleMath {
  readonly tex: string;
  /** KaTeX's MathML, annotation removed (as Mermaid removes it). */
  readonly html: string;
  /** Typeset size, in em of the label font. */
  readonly w: number;
  readonly h: number;
  /** In a place Pele draws on one line only (a class member, a gantt task): shrunk to the line. */
  readonly fit: boolean;
}

export interface PeleStyle {
  readonly fill?: string;
  readonly decoration?: 'underline' | 'line-through';
  readonly mono?: boolean;
}

export interface PreparedPeleLabels {
  /** The source Pele draws. */
  readonly text: string;
  readonly maths: readonly PeleMath[];
  readonly styles: readonly PeleStyle[];
  readonly codes: PeleLabelCodes;
}

/** The width a formula's token reserves, in em. */
function tokenWidth(m: PeleMath): number {
  return m.w * fitScale(m, LINE_HEIGHT);
}

/** How much a formula is shrunk to fit a line `pitch` em high (1: not at all). */
function fitScale(m: PeleMath, pitch: number): number {
  return m.fit && m.h > pitch ? pitch / m.h : 1;
}

// ------------------------------------------------------------- typesetting

export interface MathTypesetter {
  /** KaTeX MathML for a formula. */
  typeset(tex: string): string;
  /** The typeset formula's size in em of the label font; zeros when the page has no layout. */
  measure(htmls: readonly string[]): readonly { w: number; h: number }[];
}

/**
 * Macro expansions one formula may use (KaTeX's own default is 1000). Real
 * label formulas use a few dozen; a nested `\def` reaches hundreds of
 * kilobytes of MathML well under 1000.
 */
export const PELE_MATH_MAX_EXPAND = 200;
/** MathML one diagram's formulas may add in all; a formula past it stays its TeX text. */
export const PELE_MATH_TOTAL_LIMIT = 250_000;

/** The options Mermaid typesets its labels with, under the math slot's security pin (`trust: false`, no throw). */
export function typesetPeleMath(renderer: MathRenderer, tex: string): string {
  const html = renderer.renderToString(tex, { displayMode: true, output: 'mathml', throwOnError: false, trust: false, strict: 'ignore', maxExpand: PELE_MATH_MAX_EXPAND });
  // Mermaid's own clean-up, then the display wrapper (its margins are the page's, not the label's).
  // KaTeX's stylesheet makes `.katex` `position: relative`, which WebKit paints at the svg's origin
  // inside a transformed foreignObject: the wrapper keeps its font, not its position.
  return html
    .replace(/\n/gu, ' ')
    .replace(/<annotation.*<\/annotation>/gu, '')
    .replace(/^<span class="katex-display">([\s\S]*)<\/span>$/u, '$1')
    .replace(/^<span class="katex">/u, '<span class="katex" style="position:static">');
}

const sizeCache = new Map<string, { w: number; h: number }>();

/**
 * Measure formulas in the page: one hidden probe, every formula at once (one
 * layout), the markup sanitized under the html and MathML profiles first.
 * Sizes are cached per font and formula.
 */
export function measurePeleMath(htmls: readonly string[], fontFamily: string): readonly { w: number; h: number }[] {
  const sizes: ({ w: number; h: number } | undefined)[] = htmls.map((html) => sizeCache.get(`${fontFamily}\n${html}`));
  const missing = htmls.flatMap((_html, i) => (sizes[i] === undefined ? [i] : []));
  if (missing.length > 0 && typeof document !== 'undefined' && document.body) {
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;font-size:100px;line-height:1;white-space:nowrap;font-family:${fontFamily}`;
    const boxes = missing.map((i) => {
      const box = document.createElement('span');
      box.style.display = 'inline-block';
      try {
        box.append(DOMPurify.sanitize(htmls[i] ?? '', { USE_PROFILES: { html: true, mathMl: true }, FORBID_TAGS: ['mglyph', 'maction'], RETURN_DOM_FRAGMENT: true }));
      } catch {
        // No sanitizer here (happy-dom): measured as nothing, estimated below.
      }
      probe.append(box);
      return box;
    });
    document.body.append(probe);
    try {
      boxes.forEach((box, j) => {
        const r = box.getBoundingClientRect();
        const i = missing[j] as number;
        if (r.width > 0 && r.height > 0) {
          const size = { w: r.width / 100, h: r.height / 100 };
          sizes[i] = size;
          if (sizeCache.size > 500) sizeCache.clear();
          sizeCache.set(`${fontFamily}\n${htmls[i]}`, size);
        }
      });
    } finally {
      probe.remove();
    }
  }
  return sizes.map((size, i) => size ?? estimateMathSize(htmls[i] ?? ''));
}

/** With no layout: about 0.6 em per symbol, and a taller box for fractions, sums, roots and scripts. */
export function estimateMathSize(html: string): { w: number; h: number } {
  const symbols = html
    .replace(/<annotation[\s\S]*?<\/annotation>/gu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/&[a-z#0-9]+;/giu, 'x')
    .replace(/\s+/gu, '').length;
  const tall = /<(?:mfrac|munderover|munder|mover|msqrt|mroot|mtable)\b/u.test(html);
  const scripted = /<(?:msup|msub|msubsup)\b/u.test(html);
  return { w: Math.max(0.6, symbols * 0.6), h: tall ? 2.4 : scripted ? 1.4 : 1.2 };
}

// ------------------------------------------------------------------ prepare

/** The diagram types where Pele draws some labels on one line only, and which lines those are. */
function oneLineContexts(source: string): (line: string, state: { depth: number }) => boolean {
  const type = mermaidDiagramType(source);
  if (/^classDiagram/u.test(type)) {
    // A member: inside a class's braces, or `Name : member` (a relation has an arrow).
    return (line, state) => {
      const opens = /\{\s*$/u.test(line);
      const closes = /^\s*\}/u.test(line);
      const inside = state.depth > 0 && !closes;
      if (opens) state.depth += 1;
      if (closes) state.depth = Math.max(0, state.depth - 1);
      return inside || (/^\s*[\w$.~`-]+\s*:/u.test(line) && !/--|\.\.|<\||\|>/u.test(line));
    };
  }
  if (type === 'gantt') {
    return (line) => !/^\s*(?:title|section|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|weekend|displayMode|accTitle|accDescr|inclusiveEndDates|topAxis)\b/u.test(line);
  }
  return () => false;
}

/** Whether the source has anything the label step changes. */
export function needsPeleLabels(source: string): boolean {
  return hasMermaidMath(source) || /<(?:span|font|u|ins|s|del|strike|code|kbd|img)\b|\bfa[bklrs]?:fa-/iu.test(source);
}

/**
 * The math renderer: the one the page already has (Plannotator's apps fill
 * the slot eagerly for Markdown math), else the lazy loader. Called only when
 * a fence has `$$`.
 */
async function mathRenderer(): Promise<MathRenderer | null> {
  const ready = getMathRenderer();
  if (ready !== null) return ready;
  try {
    return await loadMathRenderer();
  } catch {
    return null;
  }
}

/** The default typesetter: the app's math renderer and the page's layout. */
export async function pageMathTypesetter(fontFamily: string): Promise<MathTypesetter | null> {
  const renderer = await mathRenderer();
  if (renderer === null) return null;
  return {
    typeset: (tex) => typesetPeleMath(renderer, tex),
    measure: (htmls) => measurePeleMath(htmls, fontFamily),
  };
}

/**
 * Rewrite the source for Pele, or null when there is nothing to rewrite (or
 * the source already uses every private-use block the codes could take).
 * `typesetter` is null when no math renderer could be loaded: formulas are
 * then left as their text, as Pele prints them.
 */
export function preparePeleLabels(source: string, typesetter: MathTypesetter | null): PreparedPeleLabels | null {
  if (!needsPeleLabels(source)) return null;
  const codes = codesFor(source);
  if (codes === null) return null;

  // Formulas, line by line so a line's context (one line only, or not) is known. `slots[j]` is
  // the formula the source's `j`-th `$$…$$` became, or -1 where it stays its TeX text (KaTeX
  // threw, for one, or the diagram's MathML budget is spent).
  const found: { tex: string; html: string; fit: boolean }[] = [];
  const slots: number[] = [];
  let budget = PELE_MATH_TOTAL_LIMIT;
  const lines = source.split('\n');
  const oneLine = oneLineContexts(source);
  const state = { depth: 0 };
  let inFrontMatter = lines[0]?.trim() === '---';
  const lineFits = lines.map((line, index) => {
    if (index > 0 && inFrontMatter && line.trim() === '---') {
      inFrontMatter = false;
      return null;
    }
    if (inFrontMatter || /^\s*%%/u.test(line)) return null;
    return oneLine(line, state);
  });
  if (typesetter !== null && hasMermaidMath(source)) {
    lines.forEach((line, index) => {
      const fit = lineFits[index];
      if (fit === null || fit === undefined) return;
      for (const match of line.matchAll(MATH_PATTERN)) {
        if (slots.length >= MAX_ITEMS) break;
        const tex = match[1] ?? '';
        let html: string | null = null;
        try {
          html = typesetter.typeset(tex);
        } catch {
          // `throwOnError: false` covers parse errors only: a formula too deep for KaTeX throws a RangeError.
        }
        if (html === null || html.length > budget) {
          slots.push(-1);
          continue;
        }
        budget -= html.length;
        slots.push(found.length);
        found.push({ tex, html, fit });
      }
    });
  }
  const sizes = found.length === 0 ? [] : (typesetter as MathTypesetter).measure(found.map((m) => m.html));
  const maths: PeleMath[] = found.map((m, i) => ({ ...m, w: sizes[i]?.w ?? 1, h: sizes[i]?.h ?? 1.2 }));

  let next = 0;
  const rewritten = lines.map((line, index) => {
    if (lineFits[index] === null) return line;
    let text = line;
    if (maths.length > 0) {
      text = text.replace(MATH_PATTERN, (whole: string, _tex: string, offset: number, all: string) => {
        const i = slots[next] ?? -1;
        next += 1;
        const m = maths[i];
        if (m === undefined) return whole;
        const id = codes.math(i);
        const before = all.slice(0, offset).split(/<br\s*\/?>|["`[(|:{]/iu).pop() ?? '';
        const after = all.slice(offset + whole.length).split(/<br\s*\/?>|["`\])|}]/iu)[0] ?? '';
        const textBefore = before.trim() !== '' && !/(?:--|==|-\.|~~)\s*$/u.test(before);
        const textAfter = after.trim() !== '';
        const k = m.fit ? 1 : Math.max(1, Math.ceil(m.h / LINE_HEIGHT - 0.005));
        // Short math beside words stays on their line, as Mermaid draws it.
        if (k === 1 && (textBefore || textAfter || m.fit)) return codes.lead + id;
        const block = [codes.lead + id, ...Array.from({ length: k - 1 }, () => codes.leadMore + id)].join('<br>');
        return (textBefore ? '<br>' : '') + block + (textAfter ? '<br>' : '');
      });
    }
    return text;
  });

  // Styled runs, across the whole source (a run may not cross a line, but tags may be unbalanced).
  const styles: PeleStyle[] = [];
  const styleId = (style: PeleStyle): number => {
    const key = JSON.stringify(style);
    const at = styles.findIndex((s) => JSON.stringify(s) === key);
    if (at !== -1) return at;
    styles.push(style);
    return styles.length - 1;
  };
  const styled = rewritten.map((line, index) => {
    if (lineFits[index] === null) return line;
    const open: number[] = [];
    let text = line.replace(IMG_TAG, '').replace(FA_ICON, '');
    text = text.replace(STYLED_TAG, (_tag: string, close: string, rawName: string, attrs = '') => {
      if (close) {
        const k = open.pop();
        return k === undefined || k === -1 ? '' : codes.end(k);
      }
      const style = styleOf(rawName.toLowerCase(), attrs);
      if (style === null || styles.length >= MAX_ITEMS) {
        open.push(-1);
        return '';
      }
      const k = styleId(style);
      open.push(k);
      return codes.start(k);
    });
    // A run its line never closes ends with the line.
    for (let k = open.pop(); k !== undefined; k = open.pop()) if (k !== -1) text += codes.end(k);
    return text;
  });

  if (maths.length === 0 && styles.length === 0 && styled.join('\n') === source) return null;
  return { text: styled.join('\n'), maths, styles, codes };
}

function styleOf(name: string, attrs: string): PeleStyle | null {
  const css = /\bstyle\s*=\s*(['"])(.*?)\1/iu.exec(attrs)?.[2] ?? '';
  const style: { fill?: string; decoration?: 'underline' | 'line-through'; mono?: boolean } = {};
  if (name === 'u' || name === 'ins') style.decoration = 'underline';
  if (name === 's' || name === 'del' || name === 'strike') style.decoration = 'line-through';
  if (name === 'code' || name === 'kbd') style.mono = true;
  const cssColor = /(?:^|;)\s*color\s*:\s*([^;]+)/iu.exec(css)?.[1];
  const attrColor = name === 'font' ? /\bcolor\s*=\s*(['"]?)([^'"\s>]+)\1/iu.exec(attrs)?.[2] : undefined;
  const fill = safeLabelColor(cssColor ?? attrColor);
  if (fill !== null) style.fill = fill;
  const decoration = /(?:^|;)\s*text-decoration(?:-line)?\s*:\s*([^;]+)/iu.exec(css)?.[1] ?? '';
  if (/underline/iu.test(decoration)) style.decoration = 'underline';
  else if (/line-through/iu.test(decoration)) style.decoration = 'line-through';
  return Object.keys(style).length === 0 ? null : style;
}

// ----------------------------------------------------------------- measure

/** Pele's own measurer stands in when the page has no canvas: about half an em per character. */
const ROUGH_MEASURER: TextMeasurer = {
  width: (text, size, style) => text.length * size * ((style & 4) !== 0 ? 0.6 : (style & 1) !== 0 ? 0.58 : 0.52),
};

/** The measurer Pele is given: math tokens at their typeset width, markers at none, `<code>` text in mono. */
export function peleLabelMeasurer(base: TextMeasurer | undefined, prepared: PreparedPeleLabels): TextMeasurer {
  const measure = base ?? ROUGH_MEASURER;
  const { codes, maths, styles } = prepared;
  return {
    width(text, size, style) {
      if (!codes.has(text)) return measure.width(text, size, style);
      let total = 0;
      const active = activeAtStart(text, codes);
      let run = '';
      const flush = (): void => {
        if (run === '') return;
        const mono = [...active].some((k) => styles[k]?.mono === true);
        total += measure.width(run, size, mono ? style | 4 : style);
        run = '';
      };
      for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (codes.isLead(c)) {
          flush();
          const m = maths[codes.mathIndex(text.charCodeAt(i + 1))];
          if (m !== undefined) total += tokenWidth(m) * size;
          i += 1;
        } else if (codes.startIndex(c) !== -1) {
          flush();
          active.add(codes.startIndex(c));
        } else if (codes.endIndex(c) !== -1) {
          flush();
          active.delete(codes.endIndex(c));
        } else if (codes.mathIndex(c) === -1) run += text[i];
      }
      flush();
      return total;
    },
  };
}

/** The styles open at the start of a piece of text: those whose first marker in it is an end. */
function activeAtStart(text: string, codes: PeleLabelCodes): Set<number> {
  const seen = new Set<number>();
  const active = new Set<number>();
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const start = codes.startIndex(c);
    const end = codes.endIndex(c);
    if (start !== -1) seen.add(start);
    else if (end !== -1) {
      if (!seen.has(end)) active.add(end);
      seen.add(end);
    }
  }
  return active;
}

// ------------------------------------------------------------------ finish

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** The attribute that keeps a formula's TeX where its tokens were (the comment finder reads it). */
export const PELE_TEX_ATTR = 'data-pele-tex';
export const PELE_MATH_CLASS = 'pele-math';

/** An attribute on the element or the nearest ancestor that has it, up to the svg. */
function inherited(el: Element | null, name: string): string | null {
  for (let node = el; node !== null; node = node.parentElement) {
    const value = node.getAttribute(name);
    if (value !== null && value !== '') return value;
    if (node.localName === 'svg') break;
  }
  return null;
}

function fontSizeOf(el: Element, rootSize: number): number {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    const value = node.getAttribute('font-size');
    if (value !== null && /^[\d.]+$/u.test(value)) return Number.parseFloat(value);
    if (node.localName === 'svg') break;
  }
  return rootSize;
}

/** The colour a label is drawn in, for its math: Pele's own colour variables or an author's safe colour. */
function inkOf(node: Node): string {
  const fill = inherited(node.nodeType === 1 ? (node as Element) : node.parentElement, 'fill');
  if (fill === null || fill === 'none') return 'currentColor';
  if (/^var\(--_[a-z]+\)$/u.test(fill) || /^var\(--pele-[a-z0-9-]+(?:,#[0-9a-f]{3,8})?\)$/iu.test(fill)) return fill;
  return safeLabelColor(fill) ?? 'currentColor';
}

interface Line {
  /** The element that positions the line (a `tspan` with `x`/`y`, or the `text`). */
  readonly holder: Element;
  /** The nodes the line is drawn from, in order. */
  readonly nodes: Node[];
  readonly x: number;
  readonly y: number;
}

/** A Pele `<text>`'s lines: each positioned `tspan` starts one; a text with none is one line. */
export function peleTextLines(text: Element): Line[] {
  const kids = Array.from(text.childNodes);
  const positioned = (n: Node): n is Element => n.nodeType === 1 && (n as Element).localName === 'tspan' && (n as Element).hasAttribute('y');
  const num = (el: Element, name: string): number => Number.parseFloat(el.getAttribute(name) ?? '0') || 0;
  if (!kids.some(positioned)) return [{ holder: text, nodes: kids, x: num(text, 'x'), y: num(text, 'y') }];
  const lines: Line[] = [];
  for (const node of kids) {
    if (positioned(node)) lines.push({ holder: node, nodes: [node], x: num(node, 'x'), y: num(node, 'y') });
    else if (lines.length > 0) lines[lines.length - 1]?.nodes.push(node);
  }
  return lines;
}

/** Every text node a line draws, in order. */
function textNodesOf(nodes: readonly Node[]): Text[] {
  const out: Text[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) out.push(node as Text);
    else if (node.nodeType === 1) for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

/** The measurer flags (bold 1, italic 2, mono 4) a text node is drawn with. */
function flagsOf(node: Text, text: Element): number {
  let flags = 0;
  for (let el = node.parentElement; el !== null; el = el.parentElement) {
    const weight = el.getAttribute('font-weight');
    if (weight !== null && weight !== 'normal' && weight !== '400') flags |= 1;
    if (el.getAttribute('font-style') === 'italic') flags |= 2;
    if (/mono|--_fm/u.test(el.getAttribute('font-family') ?? '')) flags |= 4;
    if (el === text) break;
  }
  return flags;
}

function anchorOf(text: Element): 'start' | 'middle' | 'end' {
  const value = inherited(text, 'text-anchor');
  return value === 'middle' || value === 'end' ? value : 'start';
}

function mathObject(doc: Document, m: PeleMath, box: { x: number; y: number; w: number; h: number }, fontSize: number, ink: string): Element {
  const fo = doc.createElementNS(SVG_NS, 'foreignObject');
  fo.setAttribute('class', PELE_MATH_CLASS);
  fo.setAttribute(PELE_TEX_ATTR, m.tex);
  fo.setAttribute('x', round(box.x - 1));
  fo.setAttribute('y', round(box.y));
  fo.setAttribute('width', round(box.w + 2));
  fo.setAttribute('height', round(box.h));
  const div = doc.createElementNS(XHTML_NS, 'div');
  div.setAttribute(
    'style',
    `display:flex;align-items:center;justify-content:center;width:100%;height:100%;overflow:visible;white-space:nowrap;font-size:${round(fontSize)}px;line-height:1;color:${ink}`,
  );
  (div as HTMLElement).innerHTML = m.html;
  fo.append(div);
  return fo;
}

const round = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Pele's svg markup with the styled runs and formulas put in. Runs in an
 * inert `<template>` (nothing loads, nothing runs) and returns markup for the
 * sanitizer. `measure` is the measurer Pele was given (for where inline math
 * sits on its line).
 */
export function finishPeleLabels(svg: string, prepared: PreparedPeleLabels, measure: TextMeasurer): string {
  if (typeof document === 'undefined') return svg;
  const template = document.createElement('template');
  template.innerHTML = svg;
  const root = template.content.querySelector('svg');
  if (root === null) return svg;
  const doc = root.ownerDocument;
  const { codes } = prepared;
  const rootSize = Number.parseFloat(/(?:^|;)\s*font\s*:\s*([\d.]+)px/u.exec(root.getAttribute('style') ?? '')?.[1] ?? '16') || 16;
  const texts = Array.from(root.querySelectorAll('text')).filter((text) => codes.has(text.textContent ?? ''));
  for (const text of texts) applyStyles(text, prepared);
  for (const text of texts) if (codes.has(text.textContent ?? '')) placeMath(text, prepared, measure, rootSize, doc);
  cleanRest(root, prepared);
  return template.innerHTML;
}

/** Marker runs become `tspan`s carrying their style. */
function applyStyles(text: Element, prepared: PreparedPeleLabels): void {
  const { codes, styles } = prepared;
  if (styles.length === 0) return;
  const doc = text.ownerDocument;
  const active = new Set<number>();
  for (const node of textNodesOf([text])) {
    const value = node.nodeValue ?? '';
    let hasMarker = false;
    for (let i = 0; i < value.length && !hasMarker; i += 1) {
      const c = value.charCodeAt(i);
      hasMarker = codes.startIndex(c) !== -1 || codes.endIndex(c) !== -1;
    }
    if (!hasMarker && active.size === 0) continue;
    const fragment = doc.createDocumentFragment();
    let run = '';
    const flush = (): void => {
      if (run === '') return;
      if (active.size === 0) fragment.append(doc.createTextNode(run));
      else {
        const span = doc.createElementNS(SVG_NS, 'tspan');
        const decorations = new Set<string>();
        for (const k of active) {
          const style = styles[k];
          if (style?.fill !== undefined) span.setAttribute('fill', style.fill);
          if (style?.decoration !== undefined) decorations.add(style.decoration);
          if (style?.mono === true) span.setAttribute('font-family', 'var(--_fm)');
        }
        if (decorations.size > 0) span.setAttribute('text-decoration', [...decorations].join(' '));
        span.textContent = run;
        fragment.append(span);
      }
      run = '';
    };
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      const start = codes.startIndex(c);
      const end = codes.endIndex(c);
      if (start !== -1) {
        flush();
        active.add(start);
      } else if (end !== -1) {
        flush();
        active.delete(end);
      } else run += value[i];
    }
    flush();
    node.replaceWith(fragment);
  }
}

/** The formulas of one `<text>`: lines of their own become one box; math beside words sits in a gap on its line. */
function placeMath(text: Element, prepared: PreparedPeleLabels, measure: TextMeasurer, rootSize: number, doc: Document): void {
  const { codes, maths } = prepared;
  const size = fontSizeOf(text, rootSize);
  const lines = peleTextLines(text);
  const pitch = lines.length > 1 ? Math.abs((lines[1]?.y ?? 0) - (lines[0]?.y ?? 0)) || size * LINE_HEIGHT : Math.round(size * LINE_HEIGHT);
  const anchor = anchorOf(text);
  // The outline copy Pele draws under a cluster title: its gaps match the fill copy, but it gets no formula.
  const outline = text.getAttribute('fill') === 'none' && text.hasAttribute('stroke');
  const objects: Element[] = [];
  const blocks = new Map<number, { first: Line; count: number; ink: string }>();

  for (const line of lines) {
    const nodes = textNodesOf(line.nodes);
    const content = nodes.map((n) => n.nodeValue ?? '').join('');
    if (!codes.has(content)) continue;
    const bare = content.replace(/[\s\u200b]/gu, '');
    // A line of its own: one token, nothing else.
    if (bare.length === 2 && codes.isLead(bare.charCodeAt(0)) && codes.mathIndex(bare.charCodeAt(1)) !== -1) {
      const i = codes.mathIndex(bare.charCodeAt(1));
      const block = blocks.get(i);
      const firstNode = nodes.find((n) => codes.has(n.nodeValue ?? ''));
      if (block === undefined) blocks.set(i, { first: line, count: 1, ink: firstNode === undefined ? inkOf(text) : inkOf(firstNode) });
      else block.count += 1;
      // The first line keeps an empty marker with the TeX; the others go.
      if (block === undefined) {
        for (const node of nodes) node.nodeValue = '';
        const marker = doc.createElementNS(SVG_NS, 'tspan');
        marker.setAttribute(PELE_TEX_ATTR, maths[i]?.tex ?? '');
        (line.holder === text ? text : line.holder).append(marker);
      } else {
        for (const node of line.nodes) node.parentNode?.removeChild(node);
      }
      continue;
    }
    // Math beside words: each token becomes a gap the formula sits in.
    const flags = nodes.map((n) => flagsOf(n, text));
    const widths = nodes.map((n, j) => measure.width(n.nodeValue ?? '', size, flags[j] ?? 0));
    const total = widths.reduce((a, b) => a + b, 0);
    let advance = anchor === 'middle' ? line.x - total / 2 : anchor === 'end' ? line.x - total : line.x;
    nodes.forEach((node, j) => {
      const value = node.nodeValue ?? '';
      if (!codes.has(value)) {
        advance += widths[j] ?? 0;
        return;
      }
      const fragment = doc.createDocumentFragment();
      let run = '';
      const flush = (): void => {
        if (run === '') return;
        fragment.append(doc.createTextNode(run));
        advance += measure.width(run, size, flags[j] ?? 0);
        run = '';
      };
      for (let k = 0; k < value.length; k += 1) {
        const c = value.charCodeAt(k);
        if (codes.isLead(c)) {
          const i = codes.mathIndex(value.charCodeAt(k + 1));
          k += 1;
          const m = maths[i];
          // A continuation token on a line with words (a place that drew no line break): nothing.
          if (m === undefined || c !== codes.lead.charCodeAt(0)) continue;
          flush();
          const scale = fitScale(m, pitch / size);
          const w = m.w * scale * size;
          const gap = doc.createElementNS(SVG_NS, 'tspan');
          gap.setAttribute('dx', round(w));
          gap.setAttribute(PELE_TEX_ATTR, m.tex);
          // An empty tspan applies no dx: a zero-width space carries it.
          gap.textContent = '\u200b';
          // Another one before it, so the gap is never the first glyph of its line: a dx there
          // moves the whole line instead of widening it.
          fragment.append(doc.createTextNode('\u200b'), gap);
          if (!outline) objects.push(mathObject(doc, m, { x: advance, y: line.y - BASELINE * size - pitch / 2, w, h: pitch }, size * scale, inkOf(node)));
          advance += w;
        } else if (codes.mathIndex(c) === -1) run += value[k];
      }
      flush();
      node.replaceWith(fragment);
    });
  }

  for (const [i, block] of blocks) {
    const m = maths[i];
    if (m === undefined || outline) continue;
    const scale = fitScale(m, (pitch * block.count) / size);
    const w = m.w * scale * size;
    const x = anchor === 'middle' ? block.first.x - w / 2 : anchor === 'end' ? block.first.x - w : block.first.x;
    objects.push(mathObject(doc, m, { x, y: block.first.y - BASELINE * size - pitch / 2, w, h: pitch * block.count }, size * scale, block.ink));
  }
  // After the text, so the formula paints over the label's ground like the words do.
  text.after(...objects);
}

/** A value with every placeholder put back as the source's words: a formula as `$$tex$$`, a marker as nothing. */
function restoreCodes(value: string, prepared: PreparedPeleLabels): string {
  const { codes, maths } = prepared;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (codes.isLead(c)) {
      const m = maths[codes.mathIndex(value.charCodeAt(i + 1))];
      if (m !== undefined && c === codes.lead.charCodeAt(0)) out += `$$${m.tex}$$`;
      i += 1;
    } else if (c < codes.base || c >= codes.base + BLOCK_SIZE) out += value[i];
  }
  return out;
}

/** Anything a placeholder is still in (an attribute Pele copies a label into, an accessible title): the source's words. */
function cleanRest(root: Element, prepared: PreparedPeleLabels): void {
  const { codes } = prepared;
  const walker = root.ownerDocument.createTreeWalker(root, 0x1 | 0x4);
  for (let node: Node | null = root; node !== null; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? '';
      if (codes.has(value)) node.nodeValue = restoreCodes(value, prepared);
    } else if (node.nodeType === 1) {
      for (const attribute of Array.from((node as Element).attributes)) {
        if (codes.has(attribute.value)) (node as Element).setAttribute(attribute.name, restoreCodes(attribute.value, prepared));
      }
    }
  }
}

/** A Pele error message names a placeholder as the formula it stands for. */
export function restorePeleLabelMessage(message: string, prepared: PreparedPeleLabels | null): string {
  return prepared === null || !prepared.codes.has(message) ? message : restoreCodes(message, prepared);
}
