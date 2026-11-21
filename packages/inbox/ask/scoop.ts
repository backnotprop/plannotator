/**
 * The side chat's corner (the owner's pick of 2026-11-20, the 28 px circle): the pane at the window's bottom-right
 * corner has that corner cut inward around the minimized chat's circle. Plain functions: the cut's shape as CSS mask
 * layers, and the pane's shadow list read into the layers that redraw it along the cut (SideChatCorner.tsx).
 *
 * Geometry, in the pane's own corner frame (its bottom-right corner is (0,0), x and y grow inward): the pocket is a
 * circle of radius R whose centre sits `sx` in from the pane's right edge and `sy` up from its bottom edge; where it
 * meets each straight edge a convex fillet of radius `f` rounds the spike off.
 */

/** The circle, the ground round it, and the cut's fillets (px). The pocket is tangent to the window's edges. */
export const SIDE_CORNER = { d: 28, ring: 5, f: 5 } as const;
/** The pocket's radius: the circle's and one ring of ground. */
export const SIDE_CORNER_R = SIDE_CORNER.d / 2 + SIDE_CORNER.ring;
/** The button's box: 44 px along both window edges from the corner (the hit area is shaped inside it, see sideCornerHitPath). */
export const SIDE_CORNER_HIT = 44;

export interface ScoopGeometry {
  sx: number;
  sy: number;
  R: number;
  f: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The corner piece's path in a P x P box whose bottom-right is the pane's corner (`inset`: that corner inside a border). */
export function scoopCornerPath({ P, sx, sy, R, f, inset = 0 }: ScoopGeometry & { P: number; inset?: number }): string {
  f = Math.max(f, 0.01);
  const E = P - inset;
  const cx = E - sx;
  const cy = E - sy;
  // The fillet on the right edge: centre (E - f, yF), tangent to the edge and to the pocket from outside.
  const yF = cy - Math.sqrt((R + f) ** 2 - (sx - f) ** 2);
  const k = R / (R + f);
  const t1x = cx + (E - f - cx) * k;
  const t1y = cy + (yF - cy) * k;
  // The fillet on the bottom edge: centre (xF, E - f).
  const xF = cx - Math.sqrt((R + f) ** 2 - (sy - f) ** 2);
  const t2x = cx + (xF - cx) * k;
  const t2y = cy + (E - f - cy) * k;
  if (!(yF >= 0 && xF >= 0)) throw new Error('scoop: corner piece too small');
  return `M0 0H${E}V${r3(yF)}A${r3(f)} ${r3(f)} 0 0 1 ${r3(t1x)} ${r3(t1y)}A${r3(R)} ${r3(R)} 0 0 0 ${r3(t2x)} ${r3(t2y)}A${r3(f)} ${r3(f)} 0 0 1 ${r3(xF)} ${E}H0Z`;
}

/**
 * Is the cut a notch: the pocket's centre inside the pane's corner (the pane within R of both window edges) and the
 * pocket crossing both of its edges? Otherwise it would be a hole, or would miss the pane.
 */
export function scoopFits({ sx, sy, R }: ScoopGeometry): boolean {
  return sx > 0 && sy > 0 && sx < R && sy < R;
}

export interface ScoopMask {
  image: string;
  position: string;
  size: string;
}

/**
 * The mask for a pane (or one of its edge layers): the corner piece at the bottom right, and two opaque layers for
 * the rest that run 2 px into the piece's box, so no seam opens between layers at a fractional zoom. `grow` > 0: the
 * shape grown by that much (the hairline's rim); < 0: eroded (a shadow's source with a negative spread).
 */
export function scoopMask(geo: ScoopGeometry, grow = 0, inset = 0): ScoopMask {
  const g = { sx: geo.sx + grow, sy: geo.sy + grow, R: geo.R - grow, f: Math.max(geo.f + grow, 0.01) };
  const reach = Math.max(g.sy + Math.sqrt((g.R + g.f) ** 2 - (g.sx - g.f) ** 2), g.sx + Math.sqrt((g.R + g.f) ** 2 - (g.sy - g.f) ** 2));
  const P = Math.ceil(reach) + 4 + inset;
  const d = scoopCornerPath({ P, ...g, inset });
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${P}' height='${P}' viewBox='0 0 ${P} ${P}'><path d='${d}'/></svg>`;
  const o = P - 2;
  return {
    image: `linear-gradient(#000 0 0), linear-gradient(#000 0 0), url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
    position: 'left top, left top, right bottom',
    size: `100% calc(100% - ${o}px), calc(100% - ${o}px) 100%, ${P}px ${P}px`,
  };
}

/** The mask as style properties (standard and -webkit-), for an element's inline style. */
export function scoopMaskStyle(mask: ScoopMask): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prefix of ['', '-webkit-']) {
    out[`${prefix}mask-image`] = mask.image;
    out[`${prefix}mask-position`] = mask.position;
    out[`${prefix}mask-size`] = mask.size;
    out[`${prefix}mask-repeat`] = 'no-repeat';
  }
  return out;
}

/** The same, as a React style object. */
export function scoopMaskReact(mask: ScoopMask): Record<string, string> {
  return {
    maskImage: mask.image,
    maskPosition: mask.position,
    maskSize: mask.size,
    maskRepeat: 'no-repeat',
    WebkitMaskImage: mask.image,
    WebkitMaskPosition: mask.position,
    WebkitMaskSize: mask.size,
    WebkitMaskRepeat: 'no-repeat',
  };
}

export interface PaneShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  inset: boolean;
}

/** Split at commas outside parentheses. */
function topLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && separator.test(ch)) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * A box-shadow list (a computed value, or the pane's `--ib-pane-shadow` token with its variables resolved) read into
 * shadows. Lengths are px (a bare 0 too); the colour is whatever is left, any CSS colour. `none` or nothing: [].
 */
export function parseBoxShadows(value: string): PaneShadow[] {
  const text = value.trim();
  if (!text || text === 'none') return [];
  const out: PaneShadow[] = [];
  for (const one of topLevel(text, /,/)) {
    const tokens = topLevel(one, /\s/);
    const lengths: number[] = [];
    const color: string[] = [];
    let inset = false;
    for (const token of tokens) {
      if (token === 'inset') inset = true;
      else if (/^-?\d*\.?\d+(px)?$/.test(token)) lengths.push(parseFloat(token));
      else color.push(token);
    }
    if (lengths.length < 2) continue;
    out.push({ x: lengths[0]!, y: lengths[1]!, blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, color: color.join(' ') || 'currentColor', inset });
  }
  return out;
}

/** The hairline drawn as a shadow: no offset, no blur, a positive spread. */
export const isRingShadow = (s: PaneShadow) => !s.inset && s.x === 0 && s.y === 0 && s.blur === 0 && s.spread > 0;

export function shadowText(s: PaneShadow): string {
  return `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`;
}

/**
 * The button's hit area in its own 44 x 44 box (the window's corner at its bottom right): the pocket's disc and the
 * two strips of ground between the pane and the window's edges (`gx`, `gy` wide). Never a pixel of the pane outside
 * the pocket, so Send and the bin beside it keep every click. Nonzero fill: every piece runs clockwise.
 */
export function sideCornerHitPath(gx: number, gy: number, R = SIDE_CORNER_R, box = SIDE_CORNER_HIT): string {
  const c = box - R;
  const parts = [`M${c - R} ${c}A${R} ${R} 0 0 1 ${c + R} ${c}A${R} ${R} 0 0 1 ${c - R} ${c}Z`];
  if (gy > 0) parts.push(`M0 ${box - gy}H${box}V${box}H0Z`);
  if (gx > 0) parts.push(`M${box - gx} 0H${box}V${box}H${box - gx}Z`);
  return parts.join('');
}
