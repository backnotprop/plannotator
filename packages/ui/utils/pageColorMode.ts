/**
 * Whether the page is light or dark, read off the page itself, for a part that
 * must match it when no ThemeProvider says (the code fences' colours:
 * `useFenceTheme`). Before this, a fence outside a provider always drew the
 * dark palette, so a light host page showed `#fafafa` code on a light block.
 *
 * What it reads, first answer wins:
 * 1. `<html class="light">` (what ThemeProvider and theme.css use), or a
 *    `dark` class; then `data-theme` or `data-color-mode` on `<html>` when it
 *    is `light` or `dark`; then a `theme-*` class without `light`, which is
 *    theme.css's dark half.
 * 2. `color-scheme` on `<html>` when it names one scheme (`light`, `dark`).
 * 3. The page's own background (`<body>`, then `<html>`), when it paints one:
 *    light when its relative luminance is over 0.4.
 * 4. `color-scheme: light dark` follows the system (`prefers-color-scheme`).
 * 5. Light: a page that says nothing is a white page.
 *
 * The answer is kept and read again when `<html>` or `<body>` change their
 * class, style, `data-theme` or `data-color-mode`, or the system scheme
 * changes.
 */

export type PageColorMode = 'light' | 'dark';

/** `rgb()` / `rgba()` / `#hex` -> [r, g, b, a] in 0..1, or null. */
function parseColor(value: string): [number, number, number, number] | null {
  const v = value.trim().toLowerCase();
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? Number.parseFloat(fn[4]) / 100 : Number(fn[4]);
    return [Number(fn[1]) / 255, Number(fn[2]) / 255, Number(fn[3]) / 255, alpha];
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  return null;
}

function luminance([r, g, b]: readonly number[]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function schemeOf(value: string | undefined | null): PageColorMode | 'both' | null {
  const words = (value ?? '').trim().toLowerCase().split(/\s+/).filter((w) => w === 'light' || w === 'dark');
  if (words.length === 0) return null;
  if (words.includes('light') && words.includes('dark')) return 'both';
  return words[0] as PageColorMode;
}

/** Attributes a host may switch its theme with (`<html data-theme="dark">`, GitHub's `data-color-mode`). */
const MODE_ATTRIBUTES = ['data-theme', 'data-color-mode'] as const;
const WATCHED = ['class', 'style', ...MODE_ATTRIBUTES];

/** The page's mode right now (see the module doc for the order). */
export function readPageColorMode(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): PageColorMode {
  if (!doc) return 'light';
  const html = doc.documentElement;
  if (html.classList.contains('light')) return 'light';
  if (html.classList.contains('dark')) return 'dark';
  for (const attribute of MODE_ATTRIBUTES) {
    const value = html.getAttribute(attribute)?.trim().toLowerCase();
    if (value === 'light' || value === 'dark') return value;
  }
  if (Array.from(html.classList).some((cls) => cls.startsWith('theme-'))) return 'dark';
  const view = doc.defaultView;
  const computed = (el: Element) => (view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null);
  const scheme = schemeOf(html.style.colorScheme) ?? schemeOf(computed(html)?.colorScheme) ?? schemeOf(computed(html)?.getPropertyValue('color-scheme'));
  if (scheme === 'light' || scheme === 'dark') return scheme;
  for (const el of [doc.body, html]) {
    if (!el) continue;
    const bg = parseColor(computed(el)?.backgroundColor ?? '');
    if (bg && bg[3] > 0.5) return luminance(bg) > 0.4 ? 'light' : 'dark';
  }
  if (scheme === 'both' && view && typeof view.matchMedia === 'function') {
    return view.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

let cached: PageColorMode | null = null;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function refresh(): void {
  const next = readPageColorMode();
  if (next === cached) return;
  cached = next;
  for (const listener of listeners) listener();
}

function start(): void {
  if (typeof document === 'undefined') return;
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(refresh) : null;
  const watch = () => {
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: WATCHED });
    if (document.body) observer?.observe(document.body, { attributes: true, attributeFilter: WATCHED });
  };
  watch();
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  media?.addEventListener?.('change', refresh);
  stop = () => {
    observer?.disconnect();
    media?.removeEventListener?.('change', refresh);
  };
}

/** For `useSyncExternalStore`: told when the page's mode changes. */
export function subscribePageColorMode(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    cached = readPageColorMode();
    start();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
      cached = null;
    }
  };
}

/** For `useSyncExternalStore`: the page's mode (kept while anyone listens, else read now). */
export function getPageColorMode(): PageColorMode {
  return listeners.size > 0 && cached !== null ? cached : readPageColorMode();
}
