/**
 * Settings → Activity's ink: the theme's accent, pulled toward the theme's text
 * colour only as far as it takes for the faintest mark to stay visible on the
 * chart's surface. Most palettes keep the accent as it is; one whose accent
 * sits close to its card (a pale accent on a light card, a dim one on a dark
 * card) gets just enough of its text colour mixed in. Every colour is still a
 * theme token: this only picks the mix shares (`--ib-act-ink`, `--ib-act-strand`).
 */

/** The dimmest mark against its surface, at least (the dataviz floor for the step nearest the surface). */
export const ACTIVITY_MIN_CONTRAST = 2;
/** The strand is a faint guide, not data: just visible. */
export const ACTIVITY_STRAND_CONTRAST = 1.3;

export type Rgb = readonly [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 2's contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` at `alpha` over `bg`. */
export function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as unknown as Rgb;
}

/** The accent shares tried, most accent first. */
const INK_SHARES = [100, 85, 70, 55, 40, 25, 0];
const STRAND_SHARES = [34, 45, 60, 80, 100];

export interface ActivityInk {
  /** The accent's share in the ink (the rest is the text colour). */
  ink: number;
  /** The ink's share in the strand (the rest is the surface). */
  strand: number;
}

/**
 * The first shares that pass, given a reader of what a share draws: `measure(ink, strand)` answers the faintest
 * mark of each look, the strand, and the surface, as RGB. Falls back to the last share (all text colour).
 */
export function pickActivityInk(measure: (ink: number, strand: number) => { faintest: Rgb[]; strand: Rgb; ground: Rgb } | null): ActivityInk | null {
  let ink = INK_SHARES[INK_SHARES.length - 1]!;
  for (const share of INK_SHARES) {
    const read = measure(share, STRAND_SHARES[0]!);
    if (!read) return null;
    if (read.faintest.every((mark) => contrast(mark, read.ground) >= ACTIVITY_MIN_CONTRAST)) {
      ink = share;
      break;
    }
  }
  let strand = STRAND_SHARES[STRAND_SHARES.length - 1]!;
  for (const share of STRAND_SHARES) {
    const read = measure(ink, share);
    if (!read) return null;
    if (contrast(read.strand, read.ground) >= ACTIVITY_STRAND_CONTRAST) {
      strand = share;
      break;
    }
  }
  return { ink, strand };
}

/** The CSS for a pick, set on the chart's section. */
export function activityInkStyle(ink: ActivityInk): Record<string, string> {
  return { '--ib-act-ink': ink.ink === 100 ? 'var(--primary)' : `color-mix(in oklab, var(--primary) ${ink.ink}%, var(--foreground))`, '--ib-act-strand': `${ink.strand}%` };
}

/**
 * Read what the chart draws in `section` for each share, through probe marks with the chart's own classes (so
 * the CSS stays the one source of the ramp) and a 1 px canvas that turns any CSS colour into RGB. Null where
 * the page cannot say (no canvas, a test DOM): the CSS defaults stand.
 */
export function fitActivityInk(section: HTMLElement, look: 'blend' | 'dots'): ActivityInk | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext?.('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null | undefined;
  if (!ctx) return null;
  const rgb = (css: string): Rgb | null => {
    if (!css) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#010203';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!];
  };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  const probe = (cls: string) => {
    const el = document.createElementNS(NS, 'circle');
    el.setAttribute('class', cls);
    // Read the colour as it is now, never midway through the theme's colour fade.
    el.style.transition = 'none';
    svg.appendChild(el);
    return el;
  };
  const t0 = probe('ib-activity-t0');
  const s0 = probe('ib-activity-s0');
  const strand = probe('ib-activity-strand');
  const ground = document.createElement('span');
  ground.style.cssText = 'position:absolute;width:0;height:0;background:var(--ib-act-ground);transition:none';
  section.append(svg, ground);
  const before = { ink: section.style.getPropertyValue('--ib-act-ink'), strand: section.style.getPropertyValue('--ib-act-strand') };
  try {
    return pickActivityInk((ink, share) => {
      for (const [name, value] of Object.entries(activityInkStyle({ ink, strand: share }))) section.style.setProperty(name, value);
      const bg = rgb(getComputedStyle(ground).backgroundColor);
      const blob = rgb(getComputedStyle(t0).fill);
      const dot = rgb(getComputedStyle(s0).fill);
      const line = rgb(getComputedStyle(strand).stroke);
      if (!bg || !blob || !dot || !line) return null;
      const alpha = Number.parseFloat(getComputedStyle(t0).fillOpacity);
      // Only the look on screen counts: blend's faintest is its lightest tier over the surface, dots' its first step.
      return { faintest: [look === 'blend' ? over(blob, bg, Number.isFinite(alpha) ? alpha : 1) : dot], strand: line, ground: bg };
    });
  } finally {
    section.style.setProperty('--ib-act-ink', before.ink);
    section.style.setProperty('--ib-act-strand', before.strand);
    svg.remove();
    ground.remove();
  }
}
