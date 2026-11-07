/**
 * Stack badges on a drawn view (approval "stack-show-me", addendum 2026-11-06, take C): each part a stack's PRs
 * changed carries one tag per PR on its bottom-left edge (its top-left edge when an example's step number sits on the
 * bottom one), with the pull request icon and the PR's own colour. Built on the drawing itself (inside ShapeDrawn's
 * shadow root), like Follow an example's layer; the example's dimming leaves this layer alone (`data-shp-overlay`)
 * and each tag fades with its own part instead.
 *
 * Placement follows the drawing: a resize, a scale, the example's tags coming and going. Tags keep their size when
 * the drawing shrinks to fit, like the step numbers. A part with no box (words on a phone) gets its tags after its
 * last word.
 */
import { scaleOf } from './followPainter';

// The pull request icon (Lucide "git-pull-request", ISC License).
export const PR_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/></svg>';

/**
 * The PR colours (teal, amber, rose; kept off the board's purple), each mixed toward the ink or the paper like the
 * board's zone colours, so light and dark both hold. Shared by the drawing's tags and the board's row and card.
 */
export const STACK_COLOUR_VARS = `
  --shp-pr1: color-mix(in oklab, #0f8a80 78%, var(--foreground)); --shp-pr1-soft: color-mix(in oklab, #0f8a80 15%, var(--shp-paper, var(--background)));
  --shp-pr2: color-mix(in oklab, #b87a12 78%, var(--foreground)); --shp-pr2-soft: color-mix(in oklab, #d9971f 18%, var(--shp-paper, var(--background)));
  --shp-pr3: color-mix(in oklab, #b23a6e 76%, var(--foreground)); --shp-pr3-soft: color-mix(in oklab, #b23a6e 13%, var(--shp-paper, var(--background)));
`;

/** The layer's CSS, in the drawing's own scope (a shadow root does not see the page's). */
export const STACK_DRAWN_CSS = `
.board { ${STACK_COLOUR_VARS} }
.shp-stk-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 7; pointer-events: none; }
.shp-stk-g { position: absolute; transform-origin: 0 0; display: flex; gap: 4px; pointer-events: none; white-space: nowrap; transition: opacity .25s ease; }
.shp-stk-g.dim { opacity: .2; }
.shp-stk-b { appearance: none; border: 0; margin: 0; pointer-events: auto; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;
  height: 20px; padding: 0 6px 0 5px; border-radius: 6px; font: 600 var(--ib-fs-12, 12px)/1 var(--font-mono, ui-monospace, monospace); letter-spacing: 0;
  color: var(--c); background: var(--c-soft); box-shadow: 0 0 0 2px var(--paper), inset 0 0 0 1px color-mix(in oklab, var(--c) 38%, transparent);
  transition: background-color .15s ease, color .15s ease, opacity .25s ease; }
.shp-stk-b[data-c="1"] { --c: var(--shp-pr1); --c-soft: var(--shp-pr1-soft); }
.shp-stk-b[data-c="2"] { --c: var(--shp-pr2); --c-soft: var(--shp-pr2-soft); }
.shp-stk-b[data-c="3"] { --c: var(--shp-pr3); --c-soft: var(--shp-pr3-soft); }
@media (hover: hover) { .shp-stk-b:hover { background: var(--c); color: var(--paper); } }
.shp-stk-b.on { background: var(--c); color: var(--paper); }
.shp-stk-b:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
.shp-stk-b.off { opacity: .25; }
.shp-stk-b svg { flex: none; }
.board .mk.shp-stk-out { opacity: .25; transition: opacity .25s ease; }
@media (pointer: coarse) { .shp-stk-b { height: 24px; padding: 0 8px 0 7px; } }
@media (prefers-reduced-motion: reduce) { .shp-stk-g, .shp-stk-b, .board .mk.shp-stk-out { transition-duration: .01s; } }
`;

const byMark = (id: string) => `[data-mark="${id.replace(/["\\]/g, '\\$&')}"]`;

/** True for a part drawn as a box (a border, a fill, a shadow): its tags go on its edge. Words alone take them after the last word. */
function boxed(el: HTMLElement): boolean {
  if (typeof getComputedStyle !== 'function') return true;
  const cs = getComputedStyle(el);
  const fill = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
  return (cs.boxShadow && cs.boxShadow !== 'none') || (cs.borderStyle && cs.borderStyle !== 'none' && parseFloat(cs.borderWidth) > 0) || !!fill || el instanceof SVGElement;
}

export interface StackBadgeOptions {
  /** Part (`data-mark`) to the PRs that changed it, in landing order. */
  badges: ReadonlyMap<string, readonly number[]>;
  /** A PR's colour, 1 to 3. */
  colour: (n: number) => number;
  /** A tag was clicked (or Enter / Space on it). */
  onOpen: (pr: number, part: string, tag: HTMLElement) => void;
}

/**
 * The badges on one drawing, for as long as it shows. `setPick` keeps one PR's parts bright and fades the rest
 * (null: all back); `setOpen` marks the tag whose card is open; `destroy` leaves the drawing as it was.
 */
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
        tag.setAttribute('data-c', String(options.colour(n)));
        tag.setAttribute('data-shp-stack-pr', String(n));
        tag.setAttribute('aria-label', `Changed in #${n}: open its lines`);
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
      // The example's light (its dimming, its tags arriving) and the draw-in move what the tags avoid.
      this.mo = new view.MutationObserver((list) => {
        if (list.some((m) => !this.layer.contains(m.target))) this.later();
      });
      this.mo.observe(board, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ex-dim', 'data-s', 'style', 'class'] });
    }
    // Parts drawing in (they rise into place) and the example's tags sliding in end where nothing is observed.
    board.addEventListener('animationend', this.settled);
    board.addEventListener('transitionend', this.settled);
  }

  private settled = (e: Event) => {
    if (!(e.target instanceof Node) || !this.layer.contains(e.target)) this.later();
  };

  /** The tags of one part (tests, the host's focus return). */
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

  /** States: which tags are lit or faded, and which parts fade while a PR is picked. */
  private paint() {
    const pick = this.pick;
    for (const { g, mark, prs } of this.groups) {
      g.classList.toggle('dim', !!mark.closest('[data-ex-dim]') || (pick !== null && !prs.includes(pick)));
      for (const tag of g.querySelectorAll<HTMLElement>('.shp-stk-b')) {
        const n = Number(tag.getAttribute('data-shp-stack-pr'));
        const open = !!this.open && this.open.pr === n && this.open.part === g.getAttribute('data-shp-stack-part');
        tag.classList.toggle('on', open || (pick !== null && n === pick));
        tag.classList.toggle('off', pick !== null && n !== pick);
        if (open) tag.setAttribute('aria-expanded', 'true');
        else tag.removeAttribute('aria-expanded');
      }
    }
    // Picked: every part with none of the PR's changes, in it or inside it, fades (once: not under a faded one).
    // Only what changes is touched, so the drawing's observers see no churn.
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

  /** Puts each part's tags on its edge, in the drawing's coordinates, counter-scaled to read the same at any fit. */
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
        // Words with no box: after the last word, or under it when the line has no room.
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
        // A step number on the bottom edge: the tags take the top-left edge.
        const box = { left: b.left + left * k, top: b.top + top * k, right: b.left + (left + w) * k, bottom: b.top + (top + h) * k };
        if (steps.some((t) => t.width > 0 && t.left < box.right && box.left < t.right && t.top < box.bottom && box.top < t.bottom)) top = y(r.top) - h / 2;
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
