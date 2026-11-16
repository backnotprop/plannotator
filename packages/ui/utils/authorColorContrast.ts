/**
 * Keeps an author's text colour readable on the theme it lands on. The
 * colour is painted as written unless it falls below 3:1 against the
 * background actually behind it; then `readableAuthorColor` shifts its
 * lightness, hue kept. Measured on the page (any palette, any host) and again
 * after each theme switch on `<html>`.
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

type Span = readonly [HTMLElement, AuthorColor];

const painted = new WeakMap<HTMLElement, string>();

/**
 * Paints each span's colour (which it already carries as `color.css`): as
 * written, or shifted where it would be unreadable on the background behind
 * it. Every background is read before anything is written, so a page of
 * coloured spans costs one style pass, and the change lands at once, not
 * through the page's 150ms colour transition.
 */
function paintAll(spans: Iterable<Span>): void {
  const changed: Array<[HTMLElement, string]> = [];
  for (const [el, color] of spans) {
    const bg = backgroundBehind(el);
    const shift = bg ? readableAuthorColor(color.rgba, bg) : null;
    const value = shift ? `rgb(${shift.join(', ')})` : color.css;
    if ((painted.get(el) ?? color.css) !== value) changed.push([el, value]);
  }
  for (const [el, value] of changed) {
    painted.set(el, value);
    el.style.transition = 'none';
    el.style.color = value;
  }
  for (const [el] of changed) void el.ownerDocument.defaultView?.getComputedStyle(el).color;
  for (const [el] of changed) el.style.removeProperty('transition');
}

/** Paints `color` on `el` once (see `watchAuthorColor` to keep it painted). */
export function paintAuthorColor(el: HTMLElement, color: AuthorColor): void {
  paintAll([[el, color]]);
}

const watched = new Set<readonly Span[]>();

function watch(spans: readonly Span[]): () => void {
  if (spans.length === 0) return () => {};
  paintAll(spans);
  watched.add(spans);
  // Its own listener, so the observer lives while any watch does (`notify` paints `watched`).
  const stop = onThemeChange(() => {});
  return () => {
    watched.delete(spans);
    stop();
  };
}

/** Paints `color` on `el` now and on each theme change; returns the unsubscribe. */
export function watchAuthorColor(el: HTMLElement, color: AuthorColor): () => void {
  return watch([[el, color]]);
}

/**
 * `watchAuthorColor` for every coloured span of sanitized HTML under `root`
 * (the sanitizer leaves a style on nothing else); returns the unsubscribe.
 */
export function paintAuthorColors(root: HTMLElement): () => void {
  const spans: Span[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('span[style]'))) {
    const color = parseColorStyle(el.getAttribute('style') ?? '');
    if (color) spans.push([el, color]);
  }
  return watch(spans);
}

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let frame = 0;
let settle: ReturnType<typeof setTimeout> | undefined;
let lastTheme = '';

/** Past the page's 150ms colour transition, for a host that swaps theme classes without ThemeProvider's instant switch. */
const SETTLED_MS = 200;

/**
 * What a theme switch changes on `<html>`: its classes, `data-theme`, and the
 * palette a host may set inline (the VS Code webview does). A panel drag
 * writes widths to the same inline style and changes none of these.
 */
function themeKey(): string {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return [
    root.className,
    root.getAttribute('data-theme'),
    style.colorScheme,
    style.backgroundColor,
    ...['--background', '--foreground', '--card', '--muted', '--popover'].map((v) => style.getPropertyValue(v)),
    document.body ? getComputedStyle(document.body).backgroundColor : '',
  ].join('|');
}

const notify = () => {
  const spans: Span[] = [];
  for (const list of watched) spans.push(...list);
  paintAll(spans);
  for (const fn of Array.from(listeners)) fn();
};

/**
 * Calls `cb` a frame after a theme switch on `<html>` (any number of changes
 * in that frame count once), and again once a background still fading in
 * would have landed; returns the unsubscribe.
 */
export function onThemeChange(cb: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  listeners.add(cb);
  if (!observer) {
    lastTheme = themeKey();
    observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const theme = themeKey();
        if (theme === lastTheme) return;
        lastTheme = theme;
        notify();
        clearTimeout(settle);
        settle = setTimeout(notify, SETTLED_MS);
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
