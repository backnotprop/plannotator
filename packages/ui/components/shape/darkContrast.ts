/**
 * `darkContrast` (an opt-in prop on ShapeSurface and ShapeDrawn): on a dark board only, the board's structure holds
 * WCAG 1.4.11 contrast, and its words stay as readable as they were.
 *
 * - a box's border (`--rule`) at 3:1 against the paper, a box (`--surface`) and every zone fill (`--*-soft`);
 * - a zone's edge (`--shp-edge-<zone>`, drawn by the frame's CSS around a shape filled with that zone) at 3:1
 *   against the paper and its own fill, in the zone's own hue;
 * - a box (`--surface`) at 1.25:1 against the paper and every zone fill, so it reads as a box on any zone (lighter, or
 *   darker where the palette's box is already darker than its paper);
 * - words: the ink and `--grey` keep at least the contrast they had on a box (up to 7:1), so lifting a box never
 *   costs a word.
 *
 * Each colour starts from the one the board resolved (the palette's, or the one #2721's palette fixes left) and moves
 * toward the ink (a box: or toward black), in OKLab, only as far as it must. A colour that already holds is left as it is. Pure, so the rule is
 * tested without a browser; ShapeDrawn reads the colours and sets the answer on `.board`.
 */

export type Rgb = readonly [number, number, number];

export const SHAPE_DARK_ZONES = ['blue', 'amber', 'green', 'plum', 'alert'] as const;
export type ShapeDarkZone = (typeof SHAPE_DARK_ZONES)[number];

export interface ShapeDarkColors {
  paper: Rgb;
  surface: Rgb;
  rule: Rgb;
  ink: Rgb;
  grey: Rgb;
  /** Each zone's fill (`--blue-soft`…) and its colour (`--blue`…). */
  fills: Record<ShapeDarkZone, Rgb>;
  zones: Record<ShapeDarkZone, Rgb>;
}

export interface ShapeDarkFixes {
  surface?: Rgb;
  rule?: Rgb;
  grey?: Rgb;
  /** Every zone's edge. */
  edges: Record<ShapeDarkZone, Rgb>;
}

export const SHAPE_DARK_EDGE_MIN = 3;
export const SHAPE_DARK_BOX_MIN = 1.25;
export const SHAPE_DARK_TEXT_KEEP = 7;

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const unlin = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
}

function toOklab([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([L, a, b]: [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    unlin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    unlin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    unlin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** `from` moved toward `to` by `t` (0 to 1), in OKLab. */
export function mixOklab(from: Rgb, to: Rgb, t: number): Rgb {
  const a = toOklab(from), b = toOklab(to);
  return fromOklab([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/** The least step from `from` toward `to` (in 2% steps) at which `ok` holds; null when even `to` does not. */
function leastToward(from: Rgb, to: Rgb, ok: (c: Rgb) => boolean, max = 1): Rgb | null {
  for (let i = 0; i <= 50; i++) {
    const t = Math.min(max, i / 50);
    const c = i === 0 ? from : mixOklab(from, to, t);
    if (ok(c)) return c;
    if (t >= max) break;
  }
  return null;
}

/** Is this a dark board: light words on darker paper. */
export const isDarkBoard = (c: Pick<ShapeDarkColors, 'paper' | 'ink'>) => luminance(c.ink) > 0.3 && luminance(c.paper) < luminance(c.ink);

/** What `darkContrast` sets on a dark board. On a light one: nothing (`null`). */
export function shapeDarkFixes(c: ShapeDarkColors): ShapeDarkFixes | null {
  if (!isDarkBoard(c)) return null;
  const fills = SHAPE_DARK_ZONES.map((z) => c.fills[z]);
  const out: ShapeDarkFixes = { edges: {} as Record<ShapeDarkZone, Rgb> };

  // A box: distinct from the paper and every zone, never at a word's cost.
  const inkKeep = Math.min(SHAPE_DARK_TEXT_KEEP, contrast(c.ink, c.surface));
  const boxOk = (s: Rgb) => [c.paper, ...fills].every((f) => contrast(s, f) >= SHAPE_DARK_BOX_MIN);
  let surface = c.surface;
  if (!boxOk(surface)) {
    // The least move that holds: lighter (toward the ink) or darker (toward black, for a box already darker than
    // its paper), never past the contrast the ink had on it.
    const reach = (to: Rgb) => {
      let best: { at: number; c: Rgb } | null = null;
      for (let i = 1; i <= 50; i++) {
        const s = mixOklab(c.surface, to, i / 50);
        if (contrast(c.ink, s) < inkKeep) break;
        best = { at: i, c: s };
        if (boxOk(s)) return { ...best, ok: true };
      }
      return best && { ...best, ok: false };
    };
    const ways = [reach(c.ink), reach([0, 0, 0])].filter((w): w is NonNullable<typeof w> => !!w);
    const pick = ways.filter((w) => w.ok).sort((a, b) => a.at - b.at)[0] ?? ways[0];
    if (pick) {
      surface = pick.c;
      out.surface = surface;
    }
  }

  // Grey words keep what they had on a box (up to 7:1), on the new box too.
  const greyKeep = Math.min(SHAPE_DARK_TEXT_KEEP, contrast(c.grey, c.surface));
  if (contrast(c.grey, surface) < greyKeep) out.grey = leastToward(c.grey, c.ink, (g) => contrast(g, surface) >= greyKeep) ?? c.ink;

  // A box's border: 3:1 on the paper, a box and every zone.
  const grounds = [c.paper, surface, ...fills];
  const ruleOk = (r: Rgb) => grounds.every((g) => contrast(r, g) >= SHAPE_DARK_EDGE_MIN);
  if (!ruleOk(c.rule)) out.rule = leastToward(c.rule, c.ink, ruleOk) ?? c.ink;

  // A zone's edge, in its own hue: from the paper toward the zone's colour, then toward the ink if that is not enough.
  for (const z of SHAPE_DARK_ZONES) {
    const ok = (e: Rgb) => contrast(e, c.paper) >= SHAPE_DARK_EDGE_MIN && contrast(e, c.fills[z]) >= SHAPE_DARK_EDGE_MIN;
    out.edges[z] = leastToward(c.paper, c.zones[z], ok) ?? leastToward(c.zones[z], c.ink, ok) ?? c.ink;
  }
  return out;
}

export const rgbCss = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

// ── On the page ────────────────────────────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Parts of an SVG that are never drawn where they stand: a picture inside one gets no tile. */
const UNDRAWN = 'defs, symbol, clipPath, mask, marker, pattern';
/** What the pass set on a board, to take back before it runs again (a theme change) or when the opt-in goes. */
const held = new WeakMap<HTMLElement, { vars: [name: string, was: string, mine: string][]; edged: Element[]; tiles: Element[] }>();

/** A CSS colour as the screen shows it over `under` (alpha laid on), or null where it cannot be painted. */
export type ShapeDarkPaint = (color: string, under?: Rgb) => Rgb | null;

let paintCtx: CanvasRenderingContext2D | null | undefined;
/** On a 1×1 canvas, so every colour syntax the browser knows (color-mix, oklab…) comes out as sRGB. */
const painted: ShapeDarkPaint = (color, under = [0, 0, 0]) => {
  if (paintCtx === undefined) {
    try {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      paintCtx = cv.getContext('2d', { willReadFrequently: true });
    } catch {
      paintCtx = null;
    }
  }
  const c = paintCtx;
  if (!c || !color) return null;
  c.globalCompositeOperation = 'copy';
  c.fillStyle = rgbCss(under);
  c.fillRect(0, 0, 1, 1);
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = color;
  c.fillRect(0, 0, 1, 1);
  const d = c.getImageData(0, 0, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
};

const near = (a: Rgb, b: Rgb) => a.every((v, i) => Math.abs(v - b[i]!) <= 2);

/** What shows behind the board: the first ancestor (across the shadow root) with a solid background; black if none. */
function backdrop(board: HTMLElement, paint: ShapeDarkPaint): Rgb {
  let el: Element | null = board;
  while (el) {
    const bg = getComputedStyle(el).backgroundColor;
    const onBlack = paint(bg, [0, 0, 0]), onWhite = paint(bg, [255, 255, 255]);
    if (onBlack && onWhite && near(onBlack, onWhite)) return onBlack;
    el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host || null);
  }
  return [0, 0, 0];
}

/** The board's colours as they resolve on it now (the palette's, plus any fix already on `.board`). */
function readColors(board: HTMLElement, paint: ShapeDarkPaint): ShapeDarkColors | null {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  board.append(probe);
  const raw = (name: string) => {
    probe.style.color = `var(${name})`;
    return getComputedStyle(probe).color;
  };
  try {
    // A see-through paper (a host's `--shp-paper: transparent`) shows what is behind the board.
    const paper = paint(raw('--paper'), backdrop(board, paint));
    if (!paper) return null;
    const on = (name: string) => paint(raw(name), paper);
    const [surface, rule, ink, grey] = ['--surface', '--rule', '--ink', '--grey'].map(on);
    const fills = {} as Record<ShapeDarkZone, Rgb>, zones = {} as Record<ShapeDarkZone, Rgb>;
    for (const z of SHAPE_DARK_ZONES) {
      const f = on(`--${z}-soft`), k = on(`--${z}`);
      if (!f || !k) return null;
      fills[z] = f;
      zones[z] = k;
    }
    if (!surface || !rule || !ink || !grey) return null;
    return { paper, surface, rule, ink, grey, fills, zones };
  } finally {
    probe.remove();
  }
}

/** A shape that draws a line around itself (an unset width is SVG's 1). */
const drawsLine = (cs: CSSStyleDeclaration) =>
  !!cs.stroke && cs.stroke !== 'none' && !/^(rgba\(.*,\s*0\)|transparent)$/.test(cs.stroke) && (cs.strokeWidth ? parseFloat(cs.strokeWidth) > 0 : true);
/** An HTML box with a border or a shadow of its own. */
const hasEdge = (cs: CSSStyleDeclaration) =>
  ['top', 'right', 'bottom', 'left'].some((s) => parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0 && cs.getPropertyValue(`border-${s}-style`) !== 'none') || (!!cs.boxShadow && cs.boxShadow !== 'none');

/** Takes back what `holdDarkBoard` set. */
export function releaseDarkBoard(board: HTMLElement): void {
  const was = held.get(board);
  board.classList.remove('dark-hold');
  if (!was) return;
  held.delete(board);
  // Only a value still ours goes back: another pass (#2721's palette fixes) may have set its own since.
  for (const [name, value, mine] of was.vars) {
    if (board.style.getPropertyValue(name) !== mine) continue;
    if (value) board.style.setProperty(name, value);
    else board.style.removeProperty(name);
  }
  for (const el of was.edged) el.removeAttribute('data-shp-edge');
  for (const el of was.tiles) el.remove();
}

/**
 * `darkContrast` on one board: takes back its last pass, reads the colours, and on a dark board sets the fixes
 * (`shapeDarkFixes`) on `.board`, gives each shape filled with a zone and drawn without a line an edge in the
 * zone's hue (`data-shp-edge`), and puts a tile behind each kept SVG picture. On a light board it sets nothing.
 * `paint`: the canvas, unless a test brings its own.
 */
export function holdDarkBoard(board: HTMLElement, paint: ShapeDarkPaint = painted): boolean {
  releaseDarkBoard(board);
  const colors = readColors(board, paint);
  const fixes = colors && shapeDarkFixes(colors);
  if (!colors || !fixes) return false;
  const vars: [string, string, string][] = [];
  const set = (name: string, c: Rgb) => {
    const was = board.style.getPropertyValue(name);
    board.style.setProperty(name, rgbCss(c));
    vars.push([name, was, board.style.getPropertyValue(name)]);
  };
  if (fixes.surface) set('--surface', fixes.surface);
  if (fixes.rule) set('--rule', fixes.rule);
  if (fixes.grey) set('--grey', fixes.grey);
  for (const z of SHAPE_DARK_ZONES) set(`--shp-edge-${z}`, fixes.edges[z]);
  board.classList.add('dark-hold');

  // A zone: a shape the drawing filled with one of the zone colours and drew no line around.
  const edged: Element[] = [];
  const seen = new Map<string, ShapeDarkZone | null>();
  const zoneOf = (color: string) => {
    if (!seen.has(color)) {
      const c = /^(rgb|oklab|oklch|lab|lch|color|hsl|hwb|#)/.test(color) ? paint(color, colors.paper) : null;
      seen.set(color, c ? SHAPE_DARK_ZONES.find((z) => near(c, colors.fills[z])) ?? null : null);
    }
    return seen.get(color)!;
  };
  for (const el of board.querySelectorAll<HTMLElement | SVGElement>('*')) {
    const svg = el.namespaceURI === SVG_NS;
    if (svg ? !/^(rect|circle|ellipse|path|polygon)$/.test(el.localName) || el.closest(UNDRAWN) : el.closest('svg')) continue;
    // A run or step player draws itself from the board's variables; its parts are not the drawing's zones.
    if (el.closest('[data-run], [data-steps]')) continue;
    const cs = getComputedStyle(el);
    const zone = zoneOf(svg ? cs.fill : cs.backgroundColor);
    if (!zone || (svg ? drawsLine(cs) : hasEdge(cs))) continue;
    el.setAttribute('data-shp-edge', zone);
    edged.push(el);
  }

  // A kept picture: on a light tile, so a dark logo or a screenshot's edge shows on the dark board.
  const tiles: Element[] = [];
  for (const image of board.querySelectorAll<SVGImageElement>('image[data-shp-pic]')) {
    if (image.closest(UNDRAWN) || image.closest('[clip-path], [mask]') || /clip-path|mask/.test(image.getAttribute('style') ?? '')) continue;
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(image.getAttribute(k) ?? (k === 'x' || k === 'y' ? 0 : NaN)));
    if (![x, y, w, h].every(Number.isFinite) || w! <= 0 || h! <= 0) continue;
    const pad = Math.max(3, Math.min(10, Math.min(w!, h!) * 0.12));
    const tile = document.createElementNS(SVG_NS, 'rect');
    tile.setAttribute('class', 'shp-pic-tile');
    tile.setAttribute('aria-hidden', 'true');
    for (const [k, v] of [['x', x! - pad], ['y', y! - pad], ['width', w! + pad * 2], ['height', h! + pad * 2], ['rx', Math.min(12, pad + 5)]] as const) tile.setAttribute(k, String(Math.round(v * 10) / 10));
    // It moves and draws in with its picture.
    const transform = image.getAttribute('transform');
    if (transform) tile.setAttribute('transform', transform);
    const step = image.getAttribute('data-step');
    if (step !== null) {
      tile.setAttribute('data-step', step);
      const i = image.style.getPropertyValue('--i');
      if (i) tile.style.setProperty('--i', i);
    }
    image.before(tile);
    tiles.push(tile);
  }
  held.set(board, { vars, edged, tiles });
  return true;
}
