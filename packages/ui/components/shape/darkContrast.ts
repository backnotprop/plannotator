export type Rgb = readonly [number, number, number];

export const SHAPE_DARK_ZONES = ['blue', 'amber', 'green', 'plum', 'alert'] as const;
export type ShapeDarkZone = (typeof SHAPE_DARK_ZONES)[number];

export interface ShapeDarkColors {
  paper: Rgb;
  surface: Rgb;
  rule: Rgb;
  ink: Rgb;
  grey: Rgb;
  fills: Record<ShapeDarkZone, Rgb>;
  zones: Record<ShapeDarkZone, Rgb>;
}

export interface ShapeDarkFixes {
  surface?: Rgb;
  rule?: Rgb;
  grey?: Rgb;
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

export function mixOklab(from: Rgb, to: Rgb, t: number): Rgb {
  const a = toOklab(from), b = toOklab(to);
  return fromOklab([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

function leastToward(from: Rgb, to: Rgb, ok: (c: Rgb) => boolean, max = 1): Rgb | null {
  for (let i = 0; i <= 50; i++) {
    const t = Math.min(max, i / 50);
    const c = i === 0 ? from : mixOklab(from, to, t);
    if (ok(c)) return c;
    if (t >= max) break;
  }
  return null;
}

export const isDarkBoard = (c: Pick<ShapeDarkColors, 'paper' | 'ink'>) => luminance(c.ink) > 0.3 && luminance(c.paper) < luminance(c.ink);

export function shapeDarkFixes(c: ShapeDarkColors): ShapeDarkFixes | null {
  if (!isDarkBoard(c)) return null;
  const fills = SHAPE_DARK_ZONES.map((z) => c.fills[z]);
  const out: ShapeDarkFixes = { edges: {} as Record<ShapeDarkZone, Rgb> };

  const inkKeep = Math.min(SHAPE_DARK_TEXT_KEEP, contrast(c.ink, c.surface));
  const boxOk = (s: Rgb) => [c.paper, ...fills].every((f) => contrast(s, f) >= SHAPE_DARK_BOX_MIN);
  let surface = c.surface;
  if (!boxOk(surface)) {
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

  const greyKeep = Math.min(SHAPE_DARK_TEXT_KEEP, contrast(c.grey, c.surface));
  if (contrast(c.grey, surface) < greyKeep) out.grey = leastToward(c.grey, c.ink, (g) => contrast(g, surface) >= greyKeep) ?? c.ink;

  const grounds = [c.paper, surface, ...fills];
  const ruleOk = (r: Rgb) => grounds.every((g) => contrast(r, g) >= SHAPE_DARK_EDGE_MIN);
  if (!ruleOk(c.rule)) out.rule = leastToward(c.rule, c.ink, ruleOk) ?? c.ink;

  for (const z of SHAPE_DARK_ZONES) {
    const ok = (e: Rgb) => contrast(e, c.paper) >= SHAPE_DARK_EDGE_MIN && contrast(e, c.fills[z]) >= SHAPE_DARK_EDGE_MIN;
    out.edges[z] = leastToward(c.paper, c.zones[z], ok) ?? leastToward(c.zones[z], c.ink, ok) ?? c.ink;
  }
  return out;
}

export const rgbCss = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

const SVG_NS = 'http://www.w3.org/2000/svg';
const UNDRAWN = 'defs, symbol, clipPath, mask, marker, pattern';
const held = new WeakMap<HTMLElement, { vars: [name: string, was: string, mine: string][]; edged: Element[]; tiles: Element[] }>();

export type ShapeDarkPaint = (color: string, under?: Rgb) => Rgb | null;

let paintCtx: CanvasRenderingContext2D | null | undefined;
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

function readColors(board: HTMLElement, paint: ShapeDarkPaint): ShapeDarkColors | null {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  board.append(probe);
  const raw = (name: string) => {
    probe.style.color = `var(${name})`;
    return getComputedStyle(probe).color;
  };
  try {
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

const drawsLine = (cs: CSSStyleDeclaration) =>
  !!cs.stroke && cs.stroke !== 'none' && !/^(rgba\(.*,\s*0\)|transparent)$/.test(cs.stroke) && (cs.strokeWidth ? parseFloat(cs.strokeWidth) > 0 : true);
const hasEdge = (cs: CSSStyleDeclaration) =>
  ['top', 'right', 'bottom', 'left'].some((s) => parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0 && cs.getPropertyValue(`border-${s}-style`) !== 'none') || (!!cs.boxShadow && cs.boxShadow !== 'none');

export function releaseDarkBoard(board: HTMLElement): void {
  const was = held.get(board);
  board.classList.remove('dark-hold');
  if (!was) return;
  held.delete(board);
  for (const [name, value, mine] of was.vars) {
    if (board.style.getPropertyValue(name) !== mine) continue;
    if (value) board.style.setProperty(name, value);
    else board.style.removeProperty(name);
  }
  for (const el of was.edged) el.removeAttribute('data-shp-edge');
  for (const el of was.tiles) el.remove();
}

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
    const cs = getComputedStyle(el);
    const zone = zoneOf(svg ? cs.fill : cs.backgroundColor);
    if (!zone || (svg ? drawsLine(cs) : hasEdge(cs))) continue;
    el.setAttribute('data-shp-edge', zone);
    edged.push(el);
  }

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
