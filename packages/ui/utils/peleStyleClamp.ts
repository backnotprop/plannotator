/**
 * An author's sizes in a Pele drawing, held to sane ranges. Pele writes an
 * author's `style`, `classDef` and `linkStyle` into inline `style`
 * attributes as given, so `stroke-dasharray:0.0001` or
 * `stroke-width:9999px` reaches the svg and costs the page seconds to paint
 * a few hundred nodes. Each such declaration is clamped (a length outside its
 * range becomes the nearest end of it, in px) or, when it is not a plain
 * length, dropped. Pele's own values (`var(--_r)`, `var(--pele-…)`) pass.
 * Run on the svg after the sanitizer (`renderPele` in `diagram-render.ts`).
 */

/** Lengths in px; em and rem count as 16 px, a percentage only for `font-size`. */
const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  'stroke-width': [0, 16],
  'font-size': [6, 64],
  rx: [0, 64],
  ry: [0, 64],
  r: [0, 64],
  'letter-spacing': [-4, 16],
  'word-spacing': [-4, 32],
};

/** A dash or gap shorter than this draws thousands of segments per edge. */
const DASH_MIN = 1;
const DASH_MAX = 1000;
const DASH_COUNT_MAX = 16;

const PELE_OWN_VALUE = /^var\(--(?:_[a-z]+|pele-[a-z0-9-]+)(?:,[^()]*)?\)$/iu;
const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|em|rem|%)?$/iu;
/** Keywords that need no clamp: the font-size scale (at most 48 px) and `normal`. */
const SIZE_WORD = /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|normal|inherit|initial|unset)$/iu;

const round = (n: number): string => String(Math.round(n * 100) / 100);

function toPx(value: string, property: string): number | null {
  const m = LENGTH.exec(value);
  if (m === null) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? 'px').toLowerCase();
  if (unit === 'px') return n;
  if (unit === 'em' || unit === 'rem') return n * 16;
  return property === 'font-size' ? (n / 100) * 16 : null;
}

function clampDashes(value: string): string | null {
  if (/^none$/iu.test(value)) return value;
  const parts = value.split(/[\s,]+/u).filter((p) => p !== '');
  if (parts.length === 0 || parts.length > DASH_COUNT_MAX) return null;
  const px = parts.map((p) => toPx(p, 'stroke-dasharray'));
  if (px.some((n) => n === null || n < 0)) return null;
  const lengths = px as number[];
  // All zero draws a solid line, which costs nothing.
  if (lengths.every((n) => n === 0)) return '0';
  return lengths.map((n) => (n === 0 ? '0' : round(Math.min(DASH_MAX, Math.max(DASH_MIN, n))))).join(' ');
}

/** One declaration's value, held to its range; null drops the declaration; the value itself when it needs nothing. */
function clampValue(property: string, value: string): string | null {
  if (PELE_OWN_VALUE.test(value)) return value;
  if (property === 'stroke-dasharray') return clampDashes(value);
  const range = RANGES[property];
  if (range === undefined) return value;
  if (SIZE_WORD.test(value)) return value;
  const px = toPx(value, property);
  if (px === null) return null;
  return `${round(Math.min(range[1], Math.max(range[0], px)))}px`;
}

/** A `style` attribute's text with every size held to its range; the text itself when nothing changes. */
export function clampPeleStyle(style: string): string {
  let changed = false;
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) {
      if (declaration.trim() !== '') kept.push(declaration);
      continue;
    }
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const raw = declaration.slice(colon + 1).trim();
    const value = raw.replace(/\s*!important$/iu, '');
    if (property !== 'stroke-dasharray' && RANGES[property] === undefined) {
      kept.push(declaration);
      continue;
    }
    const next = clampValue(property, value);
    if (next === value) kept.push(declaration);
    else {
      changed = true;
      if (next !== null) kept.push(`${property}:${next}`);
    }
  }
  return changed ? kept.join(';') : style;
}

/** Every inline `style` under (and on) the svg, clamped. */
export function clampPeleStyles(root: Element): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('[style]'))]) {
    const style = el.getAttribute('style');
    if (style === null) continue;
    const next = clampPeleStyle(style);
    if (next !== style) el.setAttribute('style', next);
  }
}
