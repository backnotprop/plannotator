import { useEffect, useRef, type RefObject } from 'react';
import { parseShapeCodeTarget, SHAPE_LIMITS, type ShapeNoteBox, type ShapeNoteInput, type ShapeViewId } from '@plannotator/core/shape';

const DRAG_PX = 5;
const PICTURE_MAX_SIDE = 1600;

/** What a box hands over, one object: the same one for Change it, Ask and Show me. */
export interface ShapeBoxSelection {
  view: ShapeViewId;
  v: number;
  parts: string[];
  words: string;
  code: string[];
  box: ShapeNoteBox;
  picture: Promise<string | null>;
  label?: string;
}

type Rect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const area = (r: Rect) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

function seen(el: Element, memo: Map<Element, boolean>): boolean {
  const known = memo.get(el);
  if (known !== undefined) return known;
  const cs = getComputedStyle(el);
  const parent = el.parentElement;
  const yes = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && (!parent || seen(parent, memo));
  memo.set(el, yes);
  return yes;
}

function wordsIn(scope: Element, box: Rect, memo: Map<Element, boolean>): string {
  const out: string[] = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('.shp-rb,style,script,title,[data-shp-box]') || !seen(parent, memo)) continue;
    for (const m of (node.textContent ?? '').matchAll(/\S+/g)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const r = range.getBoundingClientRect();
      const x = (r.left + r.right) / 2;
      const y = (r.top + r.bottom) / 2;
      if (area(r) > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) out.push(m[0]);
    }
  }
  const words = out.join(' ');
  return words.length > SHAPE_LIMITS.quote ? `${words.slice(0, SHAPE_LIMITS.quote - 1).replace(/\s+\S*$/, '')}…` : words;
}

/** The parts and words inside a box on `scope` (the drawing). */
export function readBox(scope: HTMLElement, box: Rect): Pick<ShapeBoxSelection, 'parts' | 'words' | 'code'> & { box: ShapeNoteBox } | null {
  const s = scope.getBoundingClientRect();
  if (!s.width || !s.height || !overlap(s, box)) return null;
  const memo = new Map<Element, boolean>();
  const rects = new Map<Element, DOMRect>();
  const rectOf = (el: Element) => rects.get(el) ?? rects.set(el, el.getBoundingClientRect()).get(el)!;
  const cover = (el: Element) => {
    const r = rectOf(el);
    return area(r) ? overlap(r, box) / area(r) : 0;
  };
  const across = (el: Element) => {
    const r = rectOf(el);
    const w = r.right - r.left, h = r.bottom - r.top;
    return { x: w ? Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)) / w : 0, y: h ? Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)) / h : 0 };
  };
  const within = (el: Element, o: Element) => {
    if (o === el) return false;
    if (o.contains(el)) return true;
    const a = rectOf(el), b = rectOf(o);
    return a.left >= b.left - 2 && a.top >= b.top - 2 && a.right <= b.right + 2 && a.bottom <= b.bottom + 2 && area(a) < area(b);
  };
  const marks = [...scope.querySelectorAll('[data-mark]')].filter((el) => seen(el, memo));
  const taken = marks.filter((el) => {
    const c = across(el);
    return c.x >= 0.45 && c.y >= 0.45 && cover(el) >= 0.25;
  });
  let parts = taken.filter((el) => {
    if (cover(el) < 0.75 && taken.some((o) => within(o, el))) return false;
    return !taken.some((o) => within(el, o) && cover(o) >= 0.75);
  });
  if (!parts.length) {
    const under = marks
      .map((el) => ({ el, on: overlap(el.getBoundingClientRect(), box), size: area(el.getBoundingClientRect()) }))
      .filter((m) => m.on > 0)
      .sort((a, b) => b.on - a.on || a.size - b.size);
    if (under[0]) parts = [under[0].el];
  }
  const code = [...scope.querySelectorAll('[data-code]')]
    .filter((el) => seen(el, memo) && (parts.includes(el) || parts.some((p) => p.contains(el) || within(el, p))) && parseShapeCodeTarget(el.getAttribute('data-code')))
    .map((el) => el.getAttribute('data-code')!);
  const x0 = Math.max(0, (box.left - s.left) / s.width);
  const y0 = Math.max(0, (box.top - s.top) / s.height);
  const x1 = Math.min(1, (box.right - s.left) / s.width);
  const y1 = Math.min(1, (box.bottom - s.top) / s.height);
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    parts: [...new Set(parts.map((el) => el.getAttribute('data-mark')!))],
    words: wordsIn(scope, box, memo),
    code: [...new Set(code)],
    box: { x: round(x0), y: round(y0), w: round(x1 - x0), h: round(y1 - y0) },
  };
}

/** The note a box makes: parts in the note's `part` (comma-separated), its words in `quote`. */
export async function boxNoteInput(sel: ShapeBoxSelection, text: string): Promise<Omit<ShapeNoteInput, 'kind' | 'v'>> {
  let part = '';
  for (const id of sel.parts) if ((part ? part.length + 1 : 0) + id.length <= 200) part = part ? `${part},${id}` : id;
  const picture = await sel.picture;
  return { view: sel.view, part: part || null, quote: sel.words || null, text, box: sel.box, ...(sel.code.length ? { code: sel.code } : {}), ...(picture ? { picture } : {}) };
}

/** A box's own element, inside `scope`. */
export function placeBox(scope: HTMLElement, box: ShapeNoteBox, k = 1, comment?: string): HTMLElement {
  if (getComputedStyle(scope).position === 'static') scope.style.position = 'relative';
  const el = document.createElement('div');
  el.setAttribute('data-shp-box', '');
  el.style.cssText = `position:absolute;left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;box-sizing:border-box;pointer-events:none;z-index:5;border-radius:${2 / k}px;box-shadow:0 0 0 ${1 / k}px color-mix(in oklab, var(--primary) 85%, transparent);background:color-mix(in oklab, var(--primary) 5%, transparent)`;
  if (comment) {
    const tag = document.createElement('div');
    tag.textContent = comment;
    tag.title = comment;
    const under = box.y + box.h < 0.92;
    tag.style.cssText = `position:absolute;left:0;${under ? `top:100%;margin-top:${6 / k}px` : `bottom:100%;margin-bottom:${6 / k}px`};transform:scale(${1 / k});transform-origin:0 ${under ? 0 : '100%'};max-width:320px;width:max-content;padding:3px 8px;border-radius:7px;font:500 12px/1.4 var(--font-sans, inherit);color:var(--popover-foreground, var(--foreground));background:var(--popover);box-shadow:0 0 0 1px var(--border),0 4px 12px -6px rgb(0 0 0 / .3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:auto;cursor:default`;
    el.appendChild(tag);
  }
  scope.appendChild(el);
  return el;
}

export interface KeptBox {
  id: string;
  box: ShapeNoteBox;
  text: string;
}

export function syncKeptBoxes(scope: HTMLElement, boxes: readonly KeptBox[], k = 1): void {
  for (const el of scope.querySelectorAll('[data-shp-kept]')) el.remove();
  for (const b of boxes) placeBox(scope, b.box, k, b.text).setAttribute('data-shp-kept', b.id);
}

/** Bytes a host hands over (a data: URL): the drawing's images and fonts, which an image of the page cannot load itself. */
export type ShapeReadAsset = (url: string) => Promise<string | null>;

/** Safari draws a blurred box-shadow inside an SVG image as a grey block. */
const safariPicture = () => typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);

const fontData = new Map<string, Promise<string | null>>();

async function fontCss(families: string, read: ShapeReadAsset): Promise<string> {
  const faces: Promise<string | null>[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '');
      const range = rule.style.getPropertyValue('unicode-range');
      if (!family || !families.includes(family) || (range && !/u\+0+-0*ff\b/i.test(range))) continue;
      const src = rule.style.getPropertyValue('src').match(/url\(["']?([^"')]+)["']?\)/)?.[1];
      if (!src) continue;
      const url = new URL(src, sheet.href ?? document.baseURI).href;
      if (!fontData.has(url)) fontData.set(url, src.startsWith('data:') ? Promise.resolve(src) : read(url).catch(() => null));
      faces.push(fontData.get(url)!.then((data) => (data ? `@font-face{font-family:"${family}";src:url(${data});font-weight:${rule.style.getPropertyValue('font-weight') || 'normal'};font-style:${rule.style.getPropertyValue('font-style') || 'normal'}}` : null)));
    }
  }
  return (await Promise.all(faces)).filter(Boolean).join('');
}

export function pictureRect(scope: HTMLElement, box: Rect, parts: readonly string[]): Rect {
  let { left, top, right, bottom } = box;
  for (const id of parts) {
    const el = scope.querySelector(`[data-mark="${CSS.escape(id)}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  const s = scope.getBoundingClientRect();
  const pad = parts.length ? 10 : 0;
  return { left: Math.max(s.left, left - pad), top: Math.max(s.top, top - pad), right: Math.min(s.right, right + pad), bottom: Math.min(s.bottom, bottom + pad) };
}

/** A `data:` URL on purpose: from a `blob:` one the canvas is tainted and cannot be read. */
export async function captureBox(scope: HTMLElement, box: Rect, read?: ShapeReadAsset, drawn?: Rect): Promise<string | null> {
  try {
    const root = scope.getRootNode();
    if (!(root instanceof ShadowRoot)) return null;
    const r = scope.getBoundingClientRect();
    const cs = getComputedStyle(scope);
    const css = [...root.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    const names = new Set([...css.matchAll(/--[\w-]+/g)].map((m) => m[0]));
    for (const n of ['--background', '--foreground', '--muted', '--muted-foreground', '--border', '--primary', '--primary-foreground', '--card', '--popover', '--destructive', '--font-sans', '--font-mono', '--shp-paper', '--shp-is-dark']) names.add(n);
    const vars = [...names].map((n) => [n, cs.getPropertyValue(n)] as const).filter(([, v]) => v).map(([n, v]) => `${n}:${v}`).join(';');
    const paper = cs.getPropertyValue('--shp-paper') || cs.getPropertyValue('--background');

    const clone = scope.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll('[data-shp-box]')) el.remove();
    clone.classList.remove('entering');
    clone.classList.add('skip');
    const inputs = scope.querySelectorAll<HTMLInputElement>('input');
    clone.querySelectorAll('input').forEach((input, i) => {
      if (inputs[i]?.checked) input.setAttribute('checked', '');
      else input.removeAttribute('checked');
    });
    await Promise.all([...clone.querySelectorAll('img,image')].map(async (im) => {
      const attr = im.localName === 'img' ? 'src' : im.hasAttribute('href') ? 'href' : 'xlink:href';
      const src = im.getAttribute(attr);
      if (!src || src.startsWith('data:')) return;
      const data = read ? await read(new URL(src, document.baseURI).href).catch(() => null) : null;
      if (data) im.setAttribute(attr, data);
      else im.remove();
    }));
    const faces = read ? await fontCss(`${cs.getPropertyValue('--font-sans')} ${cs.getPropertyValue('--font-mono')}`, read) : '';
    const style = document.createElement('style');
    style.textContent = `${faces}\n${css}${safariPicture() ? '\n*{box-shadow:none!important}' : ''}`;
    const ser = new XMLSerializer();
    const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="${attr(`${vars};font-family:${getComputedStyle(scope).fontFamily};width:${r.width}px;height:${r.height}px`)}">${ser.serializeToString(style)}${ser.serializeToString(clone)}</div></foreignObject></svg>`;

    const img = new Image();
    const loaded = new Promise<void>((ok, no) => {
      img.onload = () => ok();
      img.onerror = () => no(new Error('picture'));
    });
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await loaded;
    await img.decode().catch(() => {});

    const w = box.right - box.left;
    const h = box.bottom - box.top;
    let scale = Math.min(Math.max(window.devicePixelRatio || 1, 2), PICTURE_MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    const size = () => {
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
    };
    size();
    const g = canvas.getContext('2d');
    if (!g) return null;
    const ground = document.createElement('i');
    ground.style.cssText = `display:none;background:${paper}`;
    scope.appendChild(ground);
    const fill = getComputedStyle(ground).backgroundColor || '#fff';
    ground.style.background = 'var(--primary)';
    const stroke = getComputedStyle(ground).backgroundColor || '#6366f1';
    ground.remove();
    const draw = () => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = fill;
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.setTransform(scale, 0, 0, scale, (r.left - box.left) * scale, (r.top - box.top) * scale);
      g.drawImage(img, 0, 0, r.width, r.height);
      if (drawn && (drawn.left > box.left || drawn.top > box.top || drawn.right < box.right || drawn.bottom < box.bottom)) {
        g.setTransform(scale, 0, 0, scale, -box.left * scale, -box.top * scale);
        g.strokeStyle = stroke;
        g.lineWidth = 1.5;
        g.strokeRect(drawn.left, drawn.top, drawn.right - drawn.left, drawn.bottom - drawn.top);
      }
    };
    draw();
    // WebKit's first draw of an SVG image can miss what is inlined in it.
    if (safariPicture()) {
      await new Promise((ok) => setTimeout(ok, 220));
      draw();
    }
    let png = canvas.toDataURL('image/png');
    for (let tries = 0; png.length > SHAPE_LIMITS.notePicture && tries < 4; tries++) {
      scale *= Math.sqrt(SHAPE_LIMITS.notePicture / png.length) * 0.9;
      size();
      draw();
      png = canvas.toDataURL('image/png');
    }
    return png.length <= SHAPE_LIMITS.notePicture ? png : null;
  } catch {
    return null;
  }
}

export interface BoxDragOptions {
  stageRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onStart: () => void;
  onEnd: (box: Rect) => void;
}

/**
 * A mouse press that travels draws a box; a press that does not is left to be the click it was.
 * A finger or a pen never starts one (dragging scrolls).
 */
export function useBoxDrag({ stageRef, enabled, onStart, onEnd }: BoxDragOptions): RefObject<boolean> {
  const live = useRef({ onStart, onEnd });
  live.current = { onStart, onEnd };
  const dragging = useRef(false);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !enabled) return;

    // A board that goes mid-drag takes the drag with it: its listeners would otherwise eat the next Escape.
    let endDrag: (() => void) | null = null;
    const onDown = (down: PointerEvent) => {
      endDrag?.();
      if (down.pointerType !== 'mouse' || down.button !== 0 || down.ctrlKey) return;
      for (const s of stage.querySelectorAll<HTMLElement>('.shp-view:not(.leaving), .shp-drawn.pan')) {
        const r = s.getBoundingClientRect();
        const inside = down.clientX >= r.left && down.clientX <= r.right && down.clientY >= r.top && down.clientY <= r.bottom;
        if (inside && (down.clientX >= r.left + s.clientLeft + s.clientWidth || down.clientY >= r.top + s.clientTop + s.clientHeight)) return;
      }
      let band: HTMLElement | null = null;
      let cancelled = false;
      let last: Rect | null = null;
      const stageBox = stage.getBoundingClientRect();
      const panel = stage.closest('.shp-root')?.querySelector('.shp-sidep.open:not(.sheet)')?.getBoundingClientRect();
      const maxX = panel ? Math.min(stageBox.right, panel.left) : stageBox.right;
      const clampX = (x: number) => Math.max(stageBox.left, Math.min(maxX, x));
      const clampY = (y: number) => Math.max(stageBox.top, Math.min(stageBox.bottom, y));

      const finish = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onCancel, true);
        window.removeEventListener('keydown', onKey, true);
        dragging.current = false;
        band?.remove();
        band = null;
      };
      const onMove = (e: PointerEvent) => {
        if (e.pointerId !== down.pointerId || cancelled) return;
        if (!band) {
          if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_PX) return;
          dragging.current = true;
          try { stage.setPointerCapture(down.pointerId); } catch { /* the pointer is gone; pointerup ends it */ }
          band = document.createElement('div');
          band.className = 'shp-box-band';
          stage.parentElement?.appendChild(band);
          live.current.onStart();
        }
        const x0 = clampX(down.clientX), y0 = clampY(down.clientY), x1 = clampX(e.clientX), y1 = clampY(e.clientY);
        last = { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) };
        band.style.cssText = `left:${last.left}px;top:${last.top}px;width:${last.right - last.left}px;height:${last.bottom - last.top}px`;
      };
      const eatClick = () => {
        const eat = (c: Event) => {
          c.stopPropagation();
          c.preventDefault();
        };
        window.addEventListener('click', eat, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener('click', eat, true), 60);
      };
      const onUp = (e: PointerEvent) => {
        if (e.pointerId !== down.pointerId) return;
        const drew = !!band;
        const box = last;
        finish();
        if (!drew && !cancelled) return;
        eatClick();
        if (drew && !cancelled && box) live.current.onEnd(box);
      };
      const onCancel = (e: PointerEvent) => {
        if (e.pointerId === down.pointerId) finish();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || !band) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelled = true;
        band.remove();
        band = null;
        dragging.current = false;
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
      window.addEventListener('keydown', onKey, true);
      endDrag = finish;
    };
    const onDragStart = (e: Event) => e.preventDefault();
    stage.addEventListener('pointerdown', onDown, true);
    stage.addEventListener('dragstart', onDragStart, true);
    return () => {
      endDrag?.();
      stage.removeEventListener('pointerdown', onDown, true);
      stage.removeEventListener('dragstart', onDragStart, true);
    };
  }, [stageRef, enabled]);

  return dragging;
}
