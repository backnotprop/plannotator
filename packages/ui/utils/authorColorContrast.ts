/**
 * Keeps an author's text colour readable on the theme it lands on. The
 * colour is painted as written unless it falls below 3:1 against the
 * background actually behind it; then `readableAuthorColor` shifts its
 * lightness, hue kept. Measured on the page (any palette, any host) and again
 * after every change to `<html>`'s classes or style, which is how a theme
 * switch arrives.
 */
import { composite, parseColorStyle, readableAuthorColor, type AuthorColor, type Rgb, type Rgba } from './authorColor';

let ctx: CanvasRenderingContext2D | null | undefined;

function canvas(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    ctx = c.getContext('2d', { willReadFrequently: true }) ?? null;
  } catch {
    ctx = null;
  }
  return ctx;
}

const RGB_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/;
const resolved = new Map<string, Rgba | null>();

/**
 * A computed colour as sRGB. `rgb()` is read directly; anything else a
 * browser may answer (`oklch()`, `color(srgb …)`) is drawn on a 1px canvas
 * and read back. Null where there is no canvas (a test DOM).
 */
function resolveColor(css: string): Rgba | null {
  if (css === '' || css === 'transparent') return [0, 0, 0, 0];
  const rgb = RGB_RE.exec(css);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), a];
  }
  if (resolved.has(css)) return resolved.get(css)!;
  const c = canvas();
  let out: Rgba | null = null;
  if (c) {
    c.clearRect(0, 0, 1, 1);
    c.fillStyle = 'rgba(0, 0, 0, 0)';
    c.fillStyle = css;
    c.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
    out = [r, g, b, a / 255];
  }
  if (resolved.size > 256) resolved.clear();
  resolved.set(css, out);
  return out;
}

/** What is painted behind `el`: its ancestors' backgrounds, translucent ones laid over the first opaque one. */
function backgroundBehind(el: Element): Rgb | null {
  const view = el.ownerDocument.defaultView;
  if (!view) return null;
  const layers: Rgba[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const color = resolveColor(view.getComputedStyle(node).backgroundColor);
    if (color === null) return null;
    if (color[3] <= 0) continue;
    layers.push(color);
    if (color[3] >= 1) break;
  }
  let base: Rgb = [255, 255, 255];
  for (let i = layers.length - 1; i >= 0; i--) base = composite(layers[i], base);
  return base;
}

const painted = new WeakMap<HTMLElement, string>();

/**
 * Paints `color` on `el` (which already carries `color.css`): as written, or
 * shifted where it would be unreadable on the background behind it. The
 * change lands at once, not through the page's 150ms colour transition.
 */
export function paintAuthorColor(el: HTMLElement, color: AuthorColor): void {
  const bg = backgroundBehind(el);
  const shift = bg ? readableAuthorColor(color.rgba, bg) : null;
  const value = shift ? `rgb(${shift.join(', ')})` : color.css;
  if ((painted.get(el) ?? color.css) === value) return;
  painted.set(el, value);
  el.style.transition = 'none';
  el.style.color = value;
  void el.ownerDocument.defaultView?.getComputedStyle(el).color;
  el.style.removeProperty('transition');
}

/**
 * `paintAuthorColor` for every coloured span of sanitized HTML under `root`
 * (the sanitizer leaves a style on nothing else), now and on each theme
 * change; returns the unsubscribe.
 */
export function paintAuthorColors(root: HTMLElement): () => void {
  const spans: Array<[HTMLElement, AuthorColor]> = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('span[style]'))) {
    const color = parseColorStyle(el.getAttribute('style') ?? '');
    if (color) spans.push([el, color]);
  }
  if (spans.length === 0) return () => {};
  const paint = () => {
    for (const [el, color] of spans) paintAuthorColor(el, color);
  };
  paint();
  return onThemeChange(paint);
}

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let frame = 0;
let settle: ReturnType<typeof setTimeout> | undefined;

/** Past the page's 150ms colour transition, for a host that swaps theme classes without ThemeProvider's instant switch. */
const SETTLED_MS = 200;

const notify = () => {
  for (const fn of Array.from(listeners)) fn();
};

/**
 * Calls `cb` a frame after `<html>`'s class or style changes (a theme switch),
 * and again once a background still fading in would have landed; returns the
 * unsubscribe.
 */
export function onThemeChange(cb: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  listeners.add(cb);
  if (!observer) {
    observer = new MutationObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(notify, SETTLED_MS);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        notify();
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settle);
      frame = 0;
    }
  };
}
