// Sizes a scene's drawing so the scene fits the window: the drawing and the
// player under it fit the height the person can see, so the controls never
// fall off screen and watching one scene never needs a scroll.
//
//  - Never blown up: a drawing is drawn at most at its own size (1 px a unit),
//    or up to 640 px wide when it is smaller than that. A wide window used to
//    stretch drawings 1.4-1.8x, which made modest lines, corners and type fat.
//  - Too tall for the room: it scales down, its aspect kept (to a floor of
//    160 px; below that the page scrolls).
//  - A phone: when the slot is narrow and the drawing's labels would land
//    under 9 px, the drawing is drawn wider than the slot (at most 2.5x) and
//    pans sideways inside it; the player stays put under it.
//
// `sceneSize` is the pure half (tested on its own); `fitScene` measures and
// sets only the scene SVG's size, the slot's sideways scroll, and puts both back.

/** The nearest box around `el` that scrolls up and down, crossing shadow roots; null: the page. */
export function scrollerOf(el: Element): HTMLElement | null {
  let n: Element | null = el;
  while (n) {
    const up: Element | null = n.parentElement ?? (((n.getRootNode() as ShadowRoot).host as Element | undefined) ?? null);
    if (!up || up === n.ownerDocument.body || up === n.ownerDocument.documentElement) return null;
    if (up instanceof HTMLElement && /(auto|scroll)/.test(getComputedStyle(up).overflowY)) return up;
    n = up;
  }
  return null;
}

/** The height the person can see for the scene, in screen pixels. */
export function roomOf(slot: Element): number {
  const view = slot.ownerDocument.defaultView;
  const winH = view?.visualViewport?.height ?? view?.innerHeight ?? 800;
  const sc = scrollerOf(slot);
  if (!sc) return winH;
  const r = sc.getBoundingClientRect();
  const cs = getComputedStyle(sc);
  const top = Math.max(0, r.top) + (parseFloat(cs.paddingTop) || 0);
  const bottom = Math.min(winH, r.bottom) - (parseFloat(cs.paddingBottom) || 0);
  return Math.max(0, bottom - top);
}

export const SCENE_FIT = {
  /** A drawing smaller than this is drawn up to this width; a larger one at most at its own size. */
  upTo: 640,
  /** Never shorter than this to fit: below it, the page scrolls. */
  floor: 160,
  /** Under this slot width, a drawing whose labels would be too small pans sideways. */
  narrow: 600,
  /** The smallest label on a phone, in screen px. */
  label: 9,
  /** How much wider than the slot a panned drawing may be. */
  pan: 2.5,
} as const;

export interface SceneRoom {
  /** The slot's width and the height the person can see, in the board's px. */
  slotW: number;
  room: number;
  /** What else the slot holds under the drawing (the player), and the scene's offset from the top of the view. */
  others: number;
  lead: number;
  /** The drawing's viewBox size, in its units. */
  vbW: number;
  vbH: number;
  /** The drawing's median label size, in its units (0: no words). */
  label: number;
}

export interface SceneSize {
  width: number;
  height: number;
  /** Board px per drawing unit. */
  scale: number;
  /** Wider than the slot: the slot scrolls sideways. */
  pan: boolean;
}

/** How big to draw a scene's drawing. */
export function sceneSize(r: SceneRoom): SceneSize {
  const fill = r.slotW / r.vbW;
  // Never blown up: its own size, or up to `upTo` wide for a small drawing, and never wider than the slot.
  let s = Math.min(fill, Math.max(1, Math.min(r.slotW, SCENE_FIT.upTo) / r.vbW));
  // A phone: labels readable, the drawing pans.
  if (r.slotW < SCENE_FIT.narrow && r.label > 0 && s * r.label < SCENE_FIT.label) s = Math.max(s, Math.min(SCENE_FIT.label / r.label, fill * SCENE_FIT.pan));
  // The room: drawing + player fit the visible height, down to the floor.
  const maxH = Math.max(SCENE_FIT.floor, r.room - r.lead - r.others - 4);
  if (r.vbH * s > maxH) s = maxH / r.vbH;
  const width = r.vbW * s;
  return { width, height: r.vbH * s, scale: s, pan: width > r.slotW + 1 };
}

/** The median font size of the drawing's words, in its own units (0: no words). */
function medianLabel(svg: SVGSVGElement): number {
  const sizes = [...svg.querySelectorAll('text')].map((t) => parseFloat(getComputedStyle(t).fontSize) || 0).filter((n) => n > 0).sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)]! : 0;
}

/**
 * Size the slot's drawing (sceneSize) so drawing + everything else in the slot (the player) fits.
 * `k` is the board's screen scale (1 unless the board is a scaled canvas). Returns a function that puts it back.
 * A drawing without a viewBox cannot scale, so it is left as drawn.
 */
export function fitScene(slot: HTMLElement, svg: SVGSVGElement, k: number): () => void {
  const vb = svg.viewBox?.baseVal;
  if (!vb || !(vb.width > 0) || !(vb.height > 0)) return () => {};
  const keep = ['width', 'height', 'max-width', 'max-height', 'display', 'margin'] as const;
  const was = keep.map((p) => [p, svg.style.getPropertyValue(p)] as const);
  const wasOverflow = slot.style.overflowX;
  const kk = k || 1;
  const sc = scrollerOf(slot);
  const room = roomOf(slot) / kk;
  // The scene's top, inside its scroller: count it when the scene opens the view, so the first screen shows all of it.
  let lead = 0;
  if (sc) {
    const off = slot.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - (parseFloat(getComputedStyle(sc).paddingTop) || 0);
    if (off >= 0 && off < room * 0.25) lead = off / kk;
  }
  const others = Math.max(0, slot.offsetHeight - svg.getBoundingClientRect().height / kk);
  const size = sceneSize({ slotW: slot.clientWidth, room, others, lead, vbW: vb.width, vbH: vb.height, label: medianLabel(svg) });
  svg.style.setProperty('display', 'block');
  svg.style.setProperty('margin', '0 auto');
  svg.style.setProperty('max-width', 'none');
  svg.style.setProperty('max-height', 'none');
  svg.style.setProperty('width', `${size.width.toFixed(1)}px`);
  svg.style.setProperty('height', `${size.height.toFixed(1)}px`);
  slot.style.overflowX = size.pan ? 'auto' : wasOverflow;
  return () => {
    for (const [p, v] of was) {
      if (v) svg.style.setProperty(p, v);
      else svg.style.removeProperty(p);
    }
    slot.style.overflowX = wasOverflow;
  };
}
