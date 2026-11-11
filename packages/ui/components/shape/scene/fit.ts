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
  upTo: 640,
  /** Never shorter than this to fit: below it, the page scrolls. */
  floor: 160,
  narrow: 600,
  label: 9,
  pan: 2.5,
} as const;

export interface SceneRoom {
  slotW: number;
  room: number;
  others: number;
  lead: number;
  vbW: number;
  vbH: number;
  label: number;
}

export interface SceneSize {
  width: number;
  height: number;
  scale: number;
  pan: boolean;
}

export function sceneSize(r: SceneRoom): SceneSize {
  const fill = r.slotW / r.vbW;
  // Never blown up: its own size, or up to `upTo` wide for a small drawing, and never wider than the slot.
  let s = Math.min(fill, Math.max(1, Math.min(r.slotW, SCENE_FIT.upTo) / r.vbW));
  if (r.slotW < SCENE_FIT.narrow && r.label > 0 && s * r.label < SCENE_FIT.label) s = Math.max(s, Math.min(SCENE_FIT.label / r.label, fill * SCENE_FIT.pan));
  const maxH = Math.max(SCENE_FIT.floor, r.room - r.lead - r.others - 4);
  if (r.vbH * s > maxH) s = maxH / r.vbH;
  const width = r.vbW * s;
  return { width, height: r.vbH * s, scale: s, pan: width > r.slotW + 1 };
}

function medianLabel(svg: SVGSVGElement): number {
  const sizes = [...svg.querySelectorAll('text')].map((t) => parseFloat(getComputedStyle(t).fontSize) || 0).filter((n) => n > 0).sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)]! : 0;
}

/** Size the slot's drawing (sceneSize) so drawing + everything else in the slot (the player) fits. */
export function fitScene(slot: HTMLElement, svg: SVGSVGElement, k: number): () => void {
  const vb = svg.viewBox?.baseVal;
  if (!vb || !(vb.width > 0) || !(vb.height > 0)) return () => {};
  const keep = ['width', 'height', 'max-width', 'max-height', 'display', 'margin'] as const;
  const was = keep.map((p) => [p, svg.style.getPropertyValue(p)] as const);
  const wasOverflow = slot.style.overflowX;
  const kk = k || 1;
  const sc = scrollerOf(slot);
  const room = roomOf(slot) / kk;
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
