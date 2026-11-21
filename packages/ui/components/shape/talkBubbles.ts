/**
 * Comment bubbles: a small speech bubble at the corner of a part (or a dragged box) that something was asked or
 * changed on (the owner, 2026-11-16: "Yes, a small comment bubble on the part"; "very similar to how Plannotator
 * works when annotating HTML"). The look is the HTML annotation's placed marker (html-viewer/bridge-script.ts
 * `MARKER_SVG`, `.pn-marker`): the same speech-bubble path, filled with the accent, a white edge and a soft shadow,
 * kept whole inside its room and spread off what it would cover. Unlike that marker it has no number, so it never
 * reads as one of the board's numbered References bubbles (`.shp-rb`), which it also never covers.
 *
 * The bubbles live inside the drawing (as kept boxes do), so they scroll and scale with it; each is a button named
 * "Comments on …", with a dot while an answer in it is new. The host opens that part's (or box's) talk from it.
 */
import type { ShapeNoteBox } from '@plannotator/core/shape';

export interface TalkBubble {
  /** One per place: `p:<view>\0<mark>` or `b:<boxKey>`. */
  key: string;
  /** The part's mark id, or null for a box over no single part. */
  part: string | null;
  /** The box, for a bubble at a box's corner. */
  box: ShapeNoteBox | null;
  /** Where, for its name ("Shape · “Save”"). */
  label: string;
  /** An answer in it is new (not yet shown in a box). */
  dot: boolean;
}

/** The HTML marker's speech bubble (bridge-script.ts `MARKER_SVG`), its viewBox 26 × 25. */
export const TALK_BUBBLE_PATH = 'M13 1.1C6.55 1.1 1.4 5.83 1.4 11.62c0 3.62 2.02 6.8 5.08 8.68l-0.85 3.5 4.28-2.02c1.01 0.25 2.05 0.38 3.09 0.38 6.45 0 11.6-4.73 11.6-10.54C24.6 5.83 19.45 1.1 13 1.1Z';
/** Its size on screen, whatever the drawing's scale. */
export const TALK_BUBBLE_SIZE = 22;
const SPREAD = 12.5;

/** The bubbles' look, for the drawing's own style sheet (its shadow root does not see the page's). */
export const TALK_BUBBLE_CSS = `
[data-shp-talk-bubble] { position: absolute; z-index: 6; width: ${TALK_BUBBLE_SIZE}px; height: ${TALK_BUBBLE_SIZE}px; margin: 0; padding: 0; border: 0; background: transparent; cursor: pointer; transform-origin: 0 0; animation: shp-talk-bubble-in .2s ease-out both; }
[data-shp-talk-bubble] svg { display: block; width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 1px 3px rgb(0 0 0 / .3)); pointer-events: none; }
[data-shp-talk-bubble] path { fill: var(--pn-accent, #d97757); stroke: #fff; stroke-width: 1.65; }
[data-shp-talk-bubble]:hover path { filter: brightness(1.08); }
[data-shp-talk-bubble]:focus-visible { outline: 2px solid var(--pn-accent, #d97757); outline-offset: 2px; border-radius: 50%; }
[data-shp-talk-bubble] [data-dot] { position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--primary, #2563eb); box-shadow: 0 0 0 2px #fff; pointer-events: none; }
@keyframes shp-talk-bubble-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { [data-shp-talk-bubble] { animation: none; } }
`;

interface Spot { x: number; y: number }
type Rect = { left: number; top: number; right: number; bottom: number };

const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Draw `bubbles` in `scope` (the drawing's `.board`), reusing each place's button so focus stays on it. `open` is
 * called with the bubble and its button. A part not drawn (another layout, hidden) gets none.
 */
export function syncTalkBubbles(scope: HTMLElement, bubbles: readonly TalkBubble[], open: (bubble: TalkBubble, el: HTMLElement) => void): void {
  const kept = new Map<string, HTMLButtonElement>();
  for (const el of scope.querySelectorAll<HTMLButtonElement>('[data-shp-talk-bubble]')) kept.set(el.getAttribute('data-shp-talk-bubble')!, el);
  if (getComputedStyle(scope).position === 'static') scope.style.position = 'relative';
  const s = scope.getBoundingClientRect();
  const w = scope.offsetWidth;
  const h = scope.offsetHeight;
  // The drawing's scale: the bubble keeps its size on screen.
  const k = w && s.width ? s.width / w : 1;
  const size = TALK_BUBBLE_SIZE / k;
  const local = (r: DOMRect): Rect => ({ left: (r.left - s.left) / k, top: (r.top - s.top) / k, right: (r.right - s.left) / k, bottom: (r.bottom - s.top) / k });
  // What a bubble must not cover: the References bubbles, and the bubbles already placed.
  const taken: Rect[] = [...scope.querySelectorAll('.shp-rb')].map((el) => local(el.getBoundingClientRect())).filter((r) => r.right > r.left);
  const placed = new Set<string>();
  for (const b of bubbles) {
    let corners: Spot[] = [];
    if (b.part !== null) {
      const mark = scope.querySelector<Element>(`[data-mark="${CSS.escape(b.part)}"]`);
      const r = mark?.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) continue;
      const p = local(r);
      corners = [{ x: p.right, y: p.top }, { x: p.left, y: p.top }, { x: p.right, y: p.bottom }, { x: p.left, y: p.bottom }];
    } else if (b.box) {
      const x0 = b.box.x * w, y0 = b.box.y * h, x1 = (b.box.x + b.box.w) * w, y1 = (b.box.y + b.box.h) * h;
      corners = [{ x: x1, y: y0 }, { x: x0, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    }
    if (!corners.length) continue;
    // Its centre on a corner, kept whole inside the drawing; the first corner that covers nothing, else spread left.
    const inside = (c: Spot): Spot => ({ x: Math.min(Math.max(c.x, size / 2), Math.max(size / 2, w - size / 2)), y: Math.min(Math.max(c.y, size / 2), Math.max(size / 2, h - size / 2)) });
    const box = (c: Spot): Rect => ({ left: c.x - size / 2, top: c.y - size / 2, right: c.x + size / 2, bottom: c.y + size / 2 });
    let at = corners.map(inside).find((c) => !taken.some((t) => overlaps(box(c), t)));
    for (let i = 1; !at && i <= 8; i++) {
      const c = inside({ x: corners[0]!.x - i * SPREAD / k * 2, y: corners[0]!.y });
      if (!taken.some((t) => overlaps(box(c), t))) at = c;
    }
    at ??= inside(corners[0]!);
    taken.push(box(at));
    let el = kept.get(b.key);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.setAttribute('data-shp-talk-bubble', b.key);
      el.innerHTML = `<svg viewBox="0 0 26 25" aria-hidden="true" focusable="false"><path d="${TALK_BUBBLE_PATH}"/></svg>`;
      scope.appendChild(el);
    }
    const button = el;
    button.onclick = (e) => {
      e.stopPropagation();
      open(b, button);
    };
    button.setAttribute('aria-label', `Comments on ${b.label}${b.dot ? ', new answer' : ''}`);
    button.title = `Comments on ${b.label}`;
    button.style.left = `${at.x - size / 2}px`;
    button.style.top = `${at.y - size / 2}px`;
    button.style.transform = k === 1 ? '' : `scale(${1 / k})`;
    const dot = button.querySelector('[data-dot]');
    if (b.dot && !dot) button.insertAdjacentHTML('beforeend', '<span data-dot=""></span>');
    if (!b.dot) dot?.remove();
    placed.add(b.key);
  }
  for (const [key, el] of kept) if (!placed.has(key)) el.remove();
}
