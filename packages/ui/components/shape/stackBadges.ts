import { scaleOf } from './followPainter';

export const PR_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/></svg>';

/** Shared by the drawing's tags, the board's row and card, and the review's bar. */
export const stackColourVars = (paper: string) =>
  `--c: color-mix(in oklab, oklch(0.56 0.15 var(--shp-h, 186)) 74%, var(--foreground)); --c-soft: color-mix(in oklab, oklch(0.62 0.14 var(--shp-h, 186)) 15%, ${paper});`;

export const STACK_DRAWN_CSS = `
.shp-stk-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 7; pointer-events: none; }
.shp-stk-g { position: absolute; transform-origin: 0 0; display: flex; gap: 4px; pointer-events: none; white-space: nowrap; transition: opacity .25s ease; }
.shp-stk-g.dim { opacity: .2; }
.shp-stk-b { appearance: none; border: 0; margin: 0; pointer-events: auto; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;
  height: 20px; padding: 0 6px 0 5px; border-radius: 6px; font: 600 var(--ib-fs-12, 12px)/1 var(--font-mono, ui-monospace, monospace); letter-spacing: 0;
  color: var(--c); background: var(--c-soft); box-shadow: 0 0 0 2px var(--paper), inset 0 0 0 1px color-mix(in oklab, var(--c) 38%, transparent);
  transition: background-color .15s ease, color .15s ease, opacity .25s ease; }
.shp-stk-b { ${stackColourVars('var(--shp-paper, var(--background))')} }
@media (hover: hover) { .shp-stk-b:hover { background: var(--c); color: var(--paper); } }
.shp-stk-b.on { background: var(--c); color: var(--paper); }
.shp-stk-b:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
.shp-stk-b.off { opacity: .25; }
.shp-stk-b svg { flex: none; }
.board .mk.shp-stk-out { opacity: .25; transition: opacity .25s ease; }
/* A finger gets 40 px of height without the tag growing: a clear area above and below it (not beside: tags sit 4 px apart). */
@media (pointer: coarse) { .shp-stk-b { position: relative; height: 24px; padding: 0 8px 0 7px; } .shp-stk-b::after { content: ""; position: absolute; left: 0; right: 0; top: -8px; bottom: -8px; } }
@media (prefers-reduced-motion: reduce) { .shp-stk-g, .shp-stk-b, .board .mk.shp-stk-out { transition-duration: .01s; } }
`;

const byMark = (id: string) => `[data-mark="${id.replace(/["\\]/g, '\\$&')}"]`;

function boxed(el: HTMLElement): boolean {
  if (typeof getComputedStyle !== 'function') return true;
  const cs = getComputedStyle(el);
  const fill = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
  return (cs.boxShadow && cs.boxShadow !== 'none') || (cs.borderStyle && cs.borderStyle !== 'none' && parseFloat(cs.borderWidth) > 0) || !!fill || el instanceof SVGElement;
}

export interface StackBadgeOptions {
  badges: ReadonlyMap<string, readonly number[]>;
  hue: (n: number) => number;
  onOpen: (pr: number, part: string, tag: HTMLElement) => void;
}

export class StackBadgeLayer {
  readonly layer: HTMLDivElement;
  private groups: { g: HTMLElement; mark: HTMLElement; part: string; prs: readonly number[] }[] = [];
  private pick: number | null = null;
  private open: { pr: number; part: string } | null = null;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private frame = 0;
  private faded: HTMLElement[] = [];

  constructor(
    private board: HTMLElement,
    options: StackBadgeOptions,
  ) {
    const root = board.getRootNode() as ShadowRoot | Document;
    const doc = board.ownerDocument;
    if (!(root as ShadowRoot).getElementById?.('shp-stk-style')) {
      const style = doc.createElement('style');
      style.id = 'shp-stk-style';
      style.textContent = STACK_DRAWN_CSS;
      (root instanceof Document ? root.head : root).appendChild(style);
    }
    this.layer = doc.createElement('div');
    this.layer.className = 'shp-stk-layer';
    this.layer.setAttribute('data-shp-overlay', 'stack');
    for (const [part, prs] of options.badges) {
      const mark = board.querySelector<HTMLElement>(byMark(part));
      if (!mark || !prs.length) continue;
      const g = doc.createElement('span');
      g.className = 'shp-stk-g';
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', 'Pull requests that changed this part');
      g.setAttribute('data-shp-stack-part', part);
      for (const n of prs) {
        const tag = doc.createElement('button');
        tag.type = 'button';
        tag.className = 'shp-stk-b';
        tag.style.setProperty('--shp-h', String(options.hue(n)));
        tag.setAttribute('data-shp-stack-pr', String(n));
        tag.setAttribute('aria-label', `#${n} changed this part: open its card`);
        tag.setAttribute('aria-haspopup', 'dialog');
        tag.setAttribute('aria-expanded', 'false');
        tag.innerHTML = PR_ICON_SVG;
        tag.append(doc.createTextNode(`#${n}`));
        tag.addEventListener('click', (e) => {
          e.stopPropagation();
          options.onOpen(n, part, tag);
        });
        // The board's own pointing (Annotate) must not take a tag's press for the part under it.
        tag.addEventListener('pointerdown', (e) => e.stopPropagation());
        g.appendChild(tag);
      }
      this.layer.appendChild(g);
      this.groups.push({ g, mark, part, prs });
    }
    board.appendChild(this.layer);
    this.place();
    const view = typeof window !== 'undefined' ? board.ownerDocument.defaultView : null;
    if (view && typeof view.ResizeObserver !== 'undefined') {
      const host = (root as ShadowRoot).host as HTMLElement | undefined;
      this.ro = new view.ResizeObserver(() => this.later());
      this.ro.observe(host?.closest('.shp-drawn') ?? board);
      this.ro.observe(board);
    }
    if (view && typeof view.MutationObserver !== 'undefined') {
      this.mo = new view.MutationObserver((list) => {
        if (list.some((m) => !this.layer.contains(m.target))) this.later();
      });
      this.mo.observe(board, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ex-dim', 'data-s', 'style', 'class'] });
    }
    board.addEventListener('animationend', this.settled);
    board.addEventListener('transitionend', this.settled);
  }

  private settled = (e: Event) => {
    if (!(e.target instanceof Node) || !this.layer.contains(e.target)) this.later();
  };

  tagsOf(part: string): HTMLButtonElement[] {
    const g = this.groups.find((x) => x.part === part)?.g;
    return g ? [...g.querySelectorAll<HTMLButtonElement>('.shp-stk-b')] : [];
  }

  setPick(pick: number | null) {
    this.pick = pick;
    this.paint();
  }

  setOpen(open: { pr: number; part: string } | null) {
    this.open = open;
    this.paint();
  }

  private later() {
    const view = this.board.ownerDocument.defaultView;
    if (!view?.requestAnimationFrame) return this.place();
    if (this.frame) return;
    this.frame = view.requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  }

  private paint() {
    const pick = this.pick;
    for (const { g, mark, prs } of this.groups) {
      g.classList.toggle('dim', !!mark.closest('[data-ex-dim]') || (pick !== null && !prs.includes(pick)));
      for (const tag of g.querySelectorAll<HTMLElement>('.shp-stk-b')) {
        const n = Number(tag.getAttribute('data-shp-stack-pr'));
        const open = !!this.open && this.open.pr === n && this.open.part === g.getAttribute('data-shp-stack-part');
        tag.classList.toggle('on', open || (pick !== null && n === pick));
        tag.classList.toggle('off', pick !== null && n !== pick);
        tag.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    }
    const next: HTMLElement[] = [];
    if (pick !== null) {
      const bright = this.groups.filter((x) => x.prs.includes(pick)).map((x) => x.mark);
      for (const el of this.board.querySelectorAll<HTMLElement>('.mk[data-mark]')) {
        if (bright.some((b) => b === el || el.contains(b) || b.contains(el))) continue;
        if (next.some((f) => f.contains(el))) continue;
        next.push(el);
      }
    }
    for (const el of this.faded) if (!next.includes(el)) el.classList.remove('shp-stk-out');
    for (const el of next) if (!el.classList.contains('shp-stk-out')) el.classList.add('shp-stk-out');
    this.faded = next;
  }

  place() {
    const { b, k } = scaleOf(this.board);
    if (!k) return;
    const inv = 1 / k;
    const root = this.board.getRootNode() as ShadowRoot | Document;
    const steps = [...root.querySelectorAll<HTMLElement>('.shp-ex-tag')].map((t) => t.getBoundingClientRect());
    const x = (v: number) => (v - b.left) / k;
    const y = (v: number) => (v - b.top) / k;
    for (const { g, mark } of this.groups) {
      const r = mark.getBoundingClientRect();
      const w = (g.offsetWidth || 60) * inv;
      const h = (g.offsetHeight || 20) * inv;
      let left: number;
      let top: number;
      if (!boxed(mark) && typeof document !== 'undefined' && typeof document.createRange === 'function') {
        const range = document.createRange();
        range.selectNodeContents(mark);
        const lines = typeof range.getClientRects === 'function' ? [...range.getClientRects()] : [];
        const last = lines[lines.length - 1] ?? r;
        if ((b.right - last.right) / k > w + 10 * inv) {
          left = x(last.right) + 6 * inv;
          top = y(last.top + last.height / 2) - h / 2;
        } else {
          left = x(last.left);
          top = y(last.bottom) + 4 * inv;
        }
      } else {
        left = x(r.left) + 14 * inv;
        top = y(r.bottom) - h / 2;
        const edgeTop = b.top + top * k;
        const edgeBottom = b.top + (top + h) * k;
        if (steps.some((t) => t.width > 0 && t.left < r.right && r.left < t.right && t.top < edgeBottom && edgeTop < t.bottom)) top = y(r.top) - h / 2;
      }
      g.style.transform = `scale(${inv})`;
      g.style.left = `${left}px`;
      g.style.top = `${top}px`;
    }
    this.paint();
  }

  destroy() {
    this.board.removeEventListener('animationend', this.settled);
    this.board.removeEventListener('transitionend', this.settled);
    this.ro?.disconnect();
    this.mo?.disconnect();
    if (this.frame) this.board.ownerDocument.defaultView?.cancelAnimationFrame?.(this.frame);
    for (const el of this.faded) el.classList.remove('shp-stk-out');
    this.layer.remove();
  }
}
