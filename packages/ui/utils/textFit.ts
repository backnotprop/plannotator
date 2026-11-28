export const ELLIPSIS = '…';

type Width = (text: string) => number;

let context: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, Map<string, number>>();
const fitCache = new Map<string, string>();
const fontCache = new Map<string, string>();
const fontListeners = new Set<() => void>();
let fontsHooked = false;
let observer: ResizeObserver | null = null;
const observed = new Map<Element, (width: number) => void>();

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new (Intl as unknown as { Segmenter: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
}

function canvas(): CanvasRenderingContext2D | null {
  if (context || typeof document === 'undefined') return context;
  context = document.createElement('canvas').getContext?.('2d') ?? null;
  return context;
}

export function textWidth(font: string): Width | null {
  const ctx = canvas();
  if (!ctx || !font) return null;
  let widths = widthCache.get(font);
  if (!widths) {
    widths = new Map();
    widthCache.set(font, widths);
  }
  const cache = widths;
  return (text) => {
    let width = cache.get(text);
    if (width === undefined) {
      if (ctx.font !== font) ctx.font = font;
      width = ctx.measureText(text).width;
      cache.set(text, width);
    }
    return width;
  };
}

let elementFonts = new WeakMap<Element, string>();

function readFont(element: Element): string {
  const style = getComputedStyle(element);
  return style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

export function fontOf(element: Element, key?: string): string {
  if (key) {
    let font = fontCache.get(key);
    if (font === undefined) {
      font = readFont(element);
      fontCache.set(key, font);
    }
    return font;
  }
  let font = elementFonts.get(element);
  if (font === undefined) {
    font = readFont(element);
    elementFonts.set(element, font);
  }
  return font;
}

function hookFonts() {
  if (fontsHooked || typeof document === 'undefined' || !document.fonts) return;
  fontsHooked = true;
  const changed = () => {
    widthCache.clear();
    fitCache.clear();
    fontCache.clear();
    elementFonts = new WeakMap();
    for (const listener of fontListeners) listener();
  };
  document.fonts.addEventListener?.('loadingdone', changed);
  document.fonts.ready?.then(changed);
}

export function onFontsChanged(listener: () => void): () => void {
  hookFonts();
  fontListeners.add(listener);
  return () => fontListeners.delete(listener);
}

export function observeWidth(element: Element, onWidth: (width: number) => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) observed.get(entry.target)?.(entry.contentRect.width);
  });
  observed.set(element, onWidth);
  observer.observe(element);
  return () => {
    observed.delete(element);
    observer?.unobserve(element);
  };
}

function cached(kind: string, font: string, text: string, available: number, fit: () => string): string {
  const key = `${kind}\u0000${font}\u0000${Math.floor(available)}\u0000${text}`;
  let value = fitCache.get(key);
  if (value === undefined) {
    value = fit();
    fitCache.set(key, value);
  }
  return value;
}

export function fitStart(text: string, available: number, width: Width): string {
  if (width(text) <= available) return text;
  const parts = graphemes(text);
  let low = 1;
  let high = parts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (width(`${ELLIPSIS}${parts.slice(parts.length - mid).join('')}`) <= available) low = mid;
    else high = mid - 1;
  }
  return `${ELLIPSIS}${parts.slice(parts.length - Math.max(1, low)).join('')}`;
}

export function fitDirectory(directory: string, available: number, width: Width): string {
  if (width(directory) <= available) return directory;
  const parts = directory.split('/').filter(Boolean);
  for (let drop = 1; drop < parts.length; drop++) {
    const candidate = `${ELLIPSIS}/${parts.slice(drop).join('/')}/`;
    if (width(candidate) <= available) return candidate;
  }
  return '';
}

export function fitHeadTail(text: string, keep: number, available: number, width: Width): string {
  if (width(text) <= available) return text;
  const parts = graphemes(text);
  const tailCount = Math.min(keep, Math.max(0, parts.length - 1));
  const tail = parts.slice(parts.length - tailCount).join('');
  const head = parts.slice(0, parts.length - tailCount);
  let low = 0;
  let high = head.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (width(`${head.slice(0, mid).join('')}${ELLIPSIS}${tail}`) <= available) low = mid;
    else high = mid - 1;
  }
  if (low > 0 || width(`${ELLIPSIS}${tail}`) <= available) return `${head.slice(0, low).join('')}${ELLIPSIS}${tail}`;
  return fitStart(tail, available, width);
}

export function fitKeepTail(name: string, available: number, width: Width): string {
  if (width(name) <= available) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const base = graphemes(extension ? name.slice(0, dot) : name);
  const keep = Math.min(3, base.length);
  const stem = base.slice(0, base.length - keep);
  const tail = base.slice(base.length - keep).join('') + extension;
  let low = -1;
  let high = stem.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (width(stem.slice(0, mid).join('') + ELLIPSIS + tail) <= available) low = mid;
    else high = mid - 1;
  }
  if (low >= 0) return stem.slice(0, low).join('') + ELLIPSIS + tail;
  const tailParts = graphemes(tail);
  let size = tailParts.length - 1;
  while (size > 0 && width(ELLIPSIS + tailParts.slice(tailParts.length - size).join('')) > available) size--;
  return ELLIPSIS + tailParts.slice(tailParts.length - size).join('');
}

export type FitKind = 'start' | 'directory' | 'keep-tail' | 'branch';

export function fitText(kind: FitKind, text: string, available: number, font: string): string {
  const width = textWidth(font);
  if (!width || available <= 0) return text;
  const room = Math.floor(available) - 0.5;
  if (width(text) <= room) return text;
  return cached(kind, font, text, available, () => {
    if (kind === 'directory') return fitDirectory(text, room, width);
    if (kind === 'keep-tail') return fitKeepTail(text, room, width);
    if (kind === 'branch') return fitHeadTail(text, 8, room, width);
    return fitStart(text, room, width);
  });
}
