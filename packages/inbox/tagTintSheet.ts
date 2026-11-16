/**
 * Tag rows' fills for the theme on screen (review of #3553, M2). A tinted element carries only its colour
 * (`data-tint="#0b9488"`, or an earlier Inbox's stored name); this sheet holds, for every colour drawn, the row's four
 * fills (`--ib-tint-0` at rest, `-1` under the pointer or with its menu open, `-2` selected, `-3` both) worked out by
 * tagTintTheme.ts against the live theme's card, text and plain row. A theme or mode change rewrites the sheet, so
 * memoized rows need no new render. Where the window cannot read its theme (no `.pn-inbox` yet, no canvas), the
 * default theme's values stand in until it can.
 */
import { DEFAULT_TINT_THEMES, tintRows, type Rgb, type TintTheme } from './tagTintTheme';

const drawn = new Map<string, string>();
let sheet: HTMLStyleElement | null = null;
let theme: TintTheme | null = null;
let read = false;
let watching = false;
let queued = false;

/** A colour (any CSS colour the browser takes, alpha included) as it shows over `under`, by painting both. */
function painter(): ((colour: string, under: Rgb | null) => Rgb | null) | null {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    return null;
  }
  if (!ctx || typeof ctx.getImageData !== 'function') return null;
  const c = ctx;
  return (colour, under) => {
    c.clearRect(0, 0, 1, 1);
    if (under) {
      c.fillStyle = `rgb(${under.join(' ')})`;
      c.fillRect(0, 0, 1, 1);
    }
    c.fillStyle = '#000000';
    c.fillStyle = colour;
    // A colour the canvas did not take leaves the black: a theme it cannot read.
    if (c.fillStyle === '#000000' && !/^(#000(000)?|black|rgba?\(0,\s*0,\s*0(,\s*1)?\))$/i.test(colour.trim())) return null;
    c.fillRect(0, 0, 1, 1);
    const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!];
  };
}

/** The live theme from the window's own tokens: the card, the two text colours, the plain row's four fills. */
function liveTheme(): TintTheme | null {
  if (typeof document === 'undefined') return null;
  const root = document.querySelector('.pn-inbox');
  const paint = root ? painter() : null;
  if (!root || !paint) return null;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;transition:none';
  root.appendChild(probe);
  const of = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  try {
    const card = paint(of('--card'), [255, 255, 255]);
    if (!card) return null;
    const on = (token: string) => paint(of(token), card);
    const [fg, muted, hover, sel, selHover] = ['--foreground', '--muted-foreground', '--ib-hover', '--ib-sel', '--ib-sel-hover'].map(on);
    if (!fg || !muted || !hover || !sel || !selHover) return null;
    return { card, fg, muted, plain: [card, hover, sel, selHover] };
  } finally {
    probe.remove();
  }
}

const fallback = (): TintTheme => (typeof document !== 'undefined' && document.documentElement.classList.contains('light') ? DEFAULT_TINT_THEMES.light : DEFAULT_TINT_THEMES.dark);

const rule = (key: string, hex: string, t: TintTheme) => {
  const { fills } = tintRows(hex, t);
  return `.pn-inbox [data-tint="${key}"]{${fills.map((f, i) => `--ib-tint-${i}:${f}`).join(';')}}`;
};

function write(): void {
  if (!sheet) return;
  const t = theme ?? fallback();
  sheet.textContent = [...drawn].map(([key, hex]) => rule(key, hex, t)).join('\n');
}

/** Read the theme again (after the first paint, a theme or mode change) and rewrite the sheet if it moved. */
function refresh(): void {
  queued = false;
  const live = liveTheme();
  read = live !== null;
  const next = live ?? fallback();
  if (theme && JSON.stringify(next) === JSON.stringify(theme)) return;
  theme = next;
  write();
}

function later(): void {
  if (queued) return;
  queued = true;
  (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => setTimeout(f, 0))(refresh);
}

function watch(): void {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
}

/**
 * Make sure the sheet has `colour`'s row (`#rrggbb`, the hex it shows as) under the key `key` (the stored value the
 * element carries). Called while a tinted element renders, so the rule is there by its first paint.
 */
export function drawTint(key: string, hex: string): void {
  if (typeof document === 'undefined') return;
  if (!sheet || !sheet.isConnected) {
    sheet = document.createElement('style');
    sheet.setAttribute('data-tag-tints', '');
    document.head.appendChild(sheet);
    watch();
  }
  if (!read) later();
  if (drawn.get(key) === hex) return;
  drawn.set(key, hex);
  sheet.appendChild(document.createTextNode(`\n${rule(key, hex, theme ?? fallback())}`));
}

/** The sheet's text (for tests). */
export function tintSheetText(): string {
  return sheet?.textContent ?? '';
}
