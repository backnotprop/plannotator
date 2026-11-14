/**
 * An author's own text colour in Markdown: `<span style="color: X">…</span>`
 * and `<font color="X">…</font>` (#3345). This file is the whole policy: the
 * block sanitizer (`sanitizeHtml.ts`) and the inline renderer
 * (`InlineMarkdown`) both ask it, and nothing else in a style attribute is
 * ever kept.
 *
 * X is a hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb()/rgba()/hsl()/
 * hsla() of plain numbers, or a CSS named colour. A style holding anything
 * but one `color` declaration is refused whole, and the value written to the
 * page is rebuilt from the parsed numbers, never the author's string.
 */

export type Rgb = [number, number, number];
/** sRGB channels 0–255 and alpha 0–1. */
export type Rgba = [number, number, number, number];

export interface AuthorColor {
  /** The colour as written to the page: lowercase hex or name, or a function rebuilt from its numbers. */
  css: string;
  rgba: Rgba;
}

// CSS Color 4 named colours (no `transparent`, `currentcolor` or system colours).
const NAMED_HEX =
  'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 ' +
  'black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 ' +
  'chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff ' +
  'darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 ' +
  'darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 ' +
  'darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f ' +
  'darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 ' +
  'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ' +
  'ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 ' +
  'honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa ' +
  'lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff ' +
  'lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 ' +
  'lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 ' +
  'lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 ' +
  'mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 ' +
  'mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 ' +
  'midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 ' +
  'oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa ' +
  'palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f ' +
  'pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f ' +
  'royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee ' +
  'sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
  'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 ' +
  'violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32';

const NAMED = new Map<string, string>(
  NAMED_HEX.split(' ').map((pair) => pair.split(':') as [string, string]),
);

/** Longest colour value or style attribute read at all; anything longer is refused unread. */
const MAX_VALUE = 64;
const MAX_STYLE = 128;

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const FN_RE = /^(rgba?|hsla?)\(([^()]*)\)$/;
const NUM_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/;
const STYLE_RE = /^color\s*:\s*([^;:]*?)\s*;?$/;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number, places = 3) => Number(n.toFixed(places));

function hexToRgba(hex: string): Rgba {
  let h = hex.slice(1);
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? round(n(6) / 255) : 1];
}

function alphaOf(token: string | undefined): number | null {
  if (token === undefined) return 1;
  const v = parseFloat(token);
  return clamp(token.endsWith('%') ? v / 100 : v, 0, 1);
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function parseFunction(name: string, body: string): AuthorColor | null {
  const commas = body.includes(',');
  let tokens: string[];
  let alpha: string | undefined;
  if (commas) {
    tokens = body.split(',').map((t) => t.trim());
    if (tokens.length === 4) alpha = tokens.pop();
  } else {
    const [main, rest, ...extra] = body.split('/');
    if (extra.length) return null;
    tokens = main.trim().split(/\s+/);
    if (rest !== undefined) alpha = rest.trim();
  }
  if (tokens.length !== 3 || ![...tokens, ...(alpha === undefined ? [] : [alpha])].every((t) => NUM_RE.test(t))) return null;
  const a = alphaOf(alpha)!;
  const num = (t: string) => parseFloat(t);
  if (name.startsWith('rgb')) {
    const ch = tokens.map((t) => Math.round(clamp(t.endsWith('%') ? (num(t) / 100) * 255 : num(t), 0, 255))) as Rgb;
    const css = a < 1 ? `rgba(${ch.join(', ')}, ${round(a)})` : `rgb(${ch.join(', ')})`;
    return { css, rgba: [...ch, a] };
  }
  if (tokens[0].endsWith('%')) return null;
  const h = round(((num(tokens[0]) % 360) + 360) % 360);
  const s = round(clamp(num(tokens[1]), 0, 100));
  const l = round(clamp(num(tokens[2]), 0, 100));
  const css = a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${round(a)})` : `hsl(${h}, ${s}%, ${l}%)`;
  return { css, rgba: [...hslToRgb(h, s / 100, l / 100), a] };
}

/**
 * Below this alpha a colour is refused, so no caller (one that never runs the
 * contrast pass included) can make words see-through.
 */
export const AUTHOR_COLOR_MIN_ALPHA = 0.5;

function readValue(value: string): AuthorColor | null {
  if (HEX_RE.test(value)) return { css: value, rgba: hexToRgba(value) };
  const named = NAMED.get(value);
  if (named) return { css: value, rgba: hexToRgba(`#${named}`) };
  const fn = FN_RE.exec(value);
  return fn ? parseFunction(fn[1], fn[2]) : null;
}

/** One colour value (a `color:` value or a `<font color>`), or null when it is not one this accepts. */
export function parseAuthorColor(raw: string): AuthorColor | null {
  if (raw.length > MAX_VALUE) return null;
  const color = readValue(raw.trim().toLowerCase());
  return color && color.rgba[3] >= AUTHOR_COLOR_MIN_ALPHA ? color : null;
}

/** A style attribute that is exactly one `color` declaration, else null (the whole style is dropped). */
export function parseColorStyle(style: string): AuthorColor | null {
  if (style.length > MAX_STYLE || style.includes('\\') || style.includes('/*')) return null;
  const match = STYLE_RE.exec(style.trim().toLowerCase());
  return match ? parseAuthorColor(match[1]) : null;
}

// ── The inline form, as InlineMarkdown reads it ────────────────────────────

/**
 * `<span style="…">` or `<font color="…">` with that one attribute (quoted
 * either way; a font's colour may be bare, as in old HTML). Any other
 * attribute, or none, and the tag is not this form.
 */
const OPEN_RE = /<(span)\s+style\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')\s*>|<(font)\s+color\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'<>=`]+))\s*>/iy;
const TAG_RE = { span: /<(\/?)span(?=[\s>])[^<>]*>/gi, font: /<(\/?)font(?=[\s>])[^<>]*>/gi };

/**
 * How far the closing tag is looked for: past this many tags of the same name,
 * or this many open at once, the run is not this form and renders as written.
 * The bound keeps a page of unclosed tags linear to read.
 */
const MAX_TAGS = 64;
const MAX_DEPTH = 16;

export interface AuthorColorMatch {
  /** The colour, or null when the attribute was refused: the words still render, uncoloured. */
  color: AuthorColor | null;
  /** The markdown between the tags. */
  inner: string;
  /** Characters consumed, both tags included. */
  length: number;
}

/**
 * The coloured run at the start of `text`, or null. The closing tag is the
 * one that balances the opening tag's name; without one the whole run is
 * not this form (it renders as written).
 */
export function matchAuthorColor(text: string): AuthorColorMatch | null {
  return matchAt(text, 0);
}

function matchAt(text: string, at: number): AuthorColorMatch | null {
  if (text[at] !== '<') return null;
  OPEN_RE.lastIndex = at;
  const open = OPEN_RE.exec(text);
  if (!open) return null;
  const isSpan = !!open[1];
  const attr = isSpan ? (open[2] ?? open[3]) : (open[5] ?? open[6] ?? open[7]);
  const color = isSpan ? parseColorStyle(attr) : parseAuthorColor(attr);
  const tags = isSpan ? TAG_RE.span : TAG_RE.font;
  const start = at + open[0].length;
  tags.lastIndex = start;
  let depth = 1;
  for (let seen = 0, m = tags.exec(text); m && seen < MAX_TAGS; seen++, m = tags.exec(text)) {
    depth += m[1] ? -1 : 1;
    if (depth > MAX_DEPTH) return null;
    if (depth === 0) return { color, inner: text.slice(start, m.index), length: m.index + m[0].length - at };
  }
  return null;
}

/**
 * Where each code span closes, CommonMark's way (as InlineMarkdown reads them):
 * a run of N backticks is closed by the next run of exactly N.
 */
function codeSpanEnds(text: string): (at: number) => number {
  const width = new Map<number, number>();
  const starts = new Map<number, { at: number[]; next: number }>();
  for (const run of text.matchAll(/`+/g)) {
    const n = run[0].length;
    width.set(run.index, n);
    const list = starts.get(n) ?? { at: [], next: 0 };
    list.at.push(run.index);
    starts.set(n, list);
  }
  // Called with rising `at`, so each width's cursor only moves forward.
  return (at) => {
    const n = width.get(at)!;
    const list = starts.get(n)!;
    while (list.next < list.at.length && list.at[list.next] <= at) list.next++;
    return list.next < list.at.length ? list.at[list.next] + n : at + n;
  };
}

/**
 * `text` with every coloured run reduced to its words: what a table copy and
 * CSV carry. A code span is copied as written, tags and all.
 */
export function stripAuthorColor(text: string): string {
  if (!text.includes('<')) return text;
  const codeEnd = text.includes('`') ? codeSpanEnds(text) : null;
  const next = /[<`]/g;
  let out = '';
  let copied = 0; // text before this is in `out`
  for (let hit = next.exec(text); hit; hit = next.exec(text)) {
    const at = hit.index;
    if (text[at] === '`') {
      next.lastIndex = codeEnd!(at);
      continue;
    }
    const run = matchAt(text, at);
    if (run) {
      out += text.slice(copied, at) + stripAuthorColor(run.inner);
      copied = next.lastIndex = at + run.length;
    }
  }
  return out + text.slice(copied);
}

// ── Readability against the background ─────────────────────────────────────

const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` painted over an opaque `bg`. */
export function composite([r, g, b, a]: Rgba, bg: Rgb): Rgb {
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)].map(Math.round) as Rgb;
}

/** WCAG's ratio for large text and UI parts: the floor an author's colour is held to. */
export const AUTHOR_COLOR_MIN_CONTRAST = 3;

/**
 * The colour to paint so `fg` stays readable on `bg`: null when it already
 * reaches `min`; otherwise the same hue and saturation with the smallest
 * lightness shift (lighter on a dark page, darker on a light one) that
 * reaches it, opaque.
 */
export function readableAuthorColor(fg: Rgba, bg: Rgb, min = AUTHOR_COLOR_MIN_CONTRAST): Rgb | null {
  if (contrastRatio(composite(fg, bg), bg) >= min) return null;
  const [h, s, l] = rgbToHsl([fg[0], fg[1], fg[2]]);
  const lighter = contrastRatio([255, 255, 255], bg) >= contrastRatio([0, 0, 0], bg);
  let near = l;
  let far = lighter ? 1 : 0;
  for (let i = 0; i < 24; i++) {
    const mid = (near + far) / 2;
    if (contrastRatio(hslToRgb(h, s, mid), bg) >= min) far = mid;
    else near = mid;
  }
  return hslToRgb(h, s, far);
}
