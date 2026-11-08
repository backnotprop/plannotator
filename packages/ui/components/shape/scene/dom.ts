// The scene player's hands on the drawing: it finds each `data-part` piece in
// the agent's SVG (already sanitized and drawn by ShapeDrawn), measures where
// it is drawn, and sets only a short list of things on it: its `transform`
// attribute, and its style's opacity, color (the piece's currentColor),
// filter (lit), stroke dashes (draw), and its words. Each is put back as it
// was when the player goes. No script from the board runs; the board is data.
import type { ShapeScene } from '@plannotator/core/shape-scene';
import { colourCss, lookAt, places, type Geo, type PieceLook, type Pt } from './timeline';

const GEOMETRY = 'path, line, polyline, polygon, circle, ellipse, rect';
const LIT = 'drop-shadow(0 0 2.5px var(--mark)) drop-shadow(0 0 7px color-mix(in oklab, var(--mark) 55%, transparent))';

interface Piece {
  el: Element;
  svg: boolean;
  /** As found: put back when the player goes or measures again. */
  was: { transform: string | null; opacity: string; color: string; text: string | null; dashes: { el: SVGGeometryElement; da: string; dof: string }[] };
  /** What `lit` sets its filter on, each with the filter it had: the piece, or (shapes only) its shapes without its words. */
  lit: { el: HTMLElement | SVGElement; filter: string }[];
  /** Its centre in its own coordinates, and as drawn in the scene SVG's. */
  local: Pt;
  home: Pt;
  /** Its parent's coordinates → the scene SVG's (for turning a move into the parent's terms). */
  parentInv: DOMMatrix | null;
  /** The element whose words `text` sets. */
  textEl: Element | null;
  lines: { el: SVGGeometryElement; len: number }[];
}

function isSvgGraphic(el: Element): el is SVGGraphicsElement {
  return typeof (el as SVGGraphicsElement).getBBox === 'function';
}

export class SceneDom implements Geo {
  private pieces = new Map<string, Piece>();
  private placed = new Map<string, ReturnType<typeof places>>();
  private paths = new Map<string, { el: SVGGeometryElement; len: number; toRoot: DOMMatrix }>();
  private root: SVGSVGElement | null = null;
  missing: string[] = [];

  /**
   * `lit`: the filter a lit piece gets (the technical look passes a thin outline in place of the glow).
   * `litShapesOnly`: a lit group outlines its shapes and leaves its words alone, so letters never smudge.
   */
  constructor(private slot: HTMLElement, private scene: ShapeScene, private lit: string = LIT, private litShapesOnly = false) {}

  /** The scene's SVG: the first one in the slot. Its coordinates are the scene's. */
  private svg(): SVGSVGElement | null {
    return this.slot.querySelector('svg');
  }

  private find(id: string): Element | null {
    const sel = `[data-part="${CSS.escape(id)}"]`;
    return this.slot.querySelector(sel) ?? (this.slot.getRootNode() as ParentNode).querySelector?.(sel) ?? null;
  }

  /** The matrix from an element's own coordinates to the scene SVG's (screen matrices, so the board's zoom cancels out). */
  private toRoot(el: Element): DOMMatrix | null {
    const root = this.root;
    if (!root || !isSvgGraphic(el)) return null;
    const r = root.getScreenCTM(), m = (el as SVGGraphicsElement).getScreenCTM();
    if (!r || !m) return null;
    return DOMMatrix.fromMatrix(r).inverse().multiply(DOMMatrix.fromMatrix(m));
  }

  /** Find and measure every piece the scene names. Puts everything back first, so it can run again (a resize, a redraw). */
  measure() {
    this.restore();
    this.pieces.clear();
    this.paths.clear();
    this.placed.clear();
    this.root = this.svg();
    const names = new Set<string>(Object.keys(this.scene.tracks));
    for (const keys of Object.values(this.scene.tracks)) for (const k of keys) {
      if (k.to) names.add(k.to);
      if (k.along) names.add(k.along);
    }
    this.missing = [];
    for (const id of names) {
      const el = this.find(id);
      if (!el) {
        this.missing.push(id);
        continue;
      }
      const svg = isSvgGraphic(el) && el instanceof SVGElement;
      const style = (el as HTMLElement | SVGElement).style;
      const textEl = el.tagName.toLowerCase() === 'text' || !svg ? el : el.querySelector('text');
      const geoms = (el.matches(GEOMETRY) ? [el] : [...el.querySelectorAll(GEOMETRY)]) as SVGGeometryElement[];
      const lines = geoms
        .filter((g) => typeof g.getTotalLength === 'function')
        .map((g) => {
          // With pathLength set, dashes count in its units.
          const pl = Number(g.getAttribute('pathLength'));
          let len = 0;
          try {
            len = pl > 0 ? pl : g.getTotalLength();
          } catch {
            len = 0;
          }
          return { el: g, len };
        });
      let local: Pt = { x: 0, y: 0 }, home: Pt = { x: 0, y: 0 }, parentInv: DOMMatrix | null = null;
      if (svg) {
        let box: DOMRect | null = null;
        try {
          box = (el as SVGGraphicsElement).getBBox();
        } catch {
          box = null;
        }
        local = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : local;
        const m = this.toRoot(el);
        if (m) home = pt(m.transformPoint(new DOMPoint(local.x, local.y)));
        const parent = el.parentElement;
        const pm = parent ? this.toRoot(parent) : null;
        parentInv = pm ? pm.inverse() : null;
      }
      const shapes = this.litShapesOnly && svg && el.tagName.toLowerCase() !== 'text' && el.querySelector('text') ? geoms.filter((g) => !g.closest('text')) : [];
      const litEls: (HTMLElement | SVGElement)[] = shapes.length ? shapes : [el as HTMLElement | SVGElement];
      this.pieces.set(id, {
        el,
        svg,
        was: { transform: el.getAttribute('transform'), opacity: style.opacity, color: style.color, text: textEl ? textEl.textContent : null, dashes: lines.map((l) => ({ el: l.el, da: l.el.style.strokeDasharray, dof: l.el.style.strokeDashoffset })) },
        lit: litEls.map((l) => ({ el: l, filter: l.style.filter })),
        local,
        home,
        parentInv,
        textEl,
        lines,
      });
      const line = lines[0];
      if (line && svg) {
        const m = this.toRoot(line.el);
        let real = 0;
        try {
          real = line.el.getTotalLength();
        } catch {
          real = 0;
        }
        if (m && real > 0) this.paths.set(id, { el: line.el, len: real, toRoot: m });
      }
    }
    for (const [id, keys] of Object.entries(this.scene.tracks)) this.placed.set(id, places(id, keys, this));
  }

  home(id: string): Pt | null {
    return this.pieces.get(id)?.home ?? null;
  }

  along(id: string, p: number): Pt | null {
    const path = this.paths.get(id);
    if (!path) return null;
    const q = path.el.getPointAtLength(Math.max(0, Math.min(1, p)) * path.len);
    return pt(path.toRoot.transformPoint(new DOMPoint(q.x, q.y)));
  }

  /** Draw the scene at time `t`. */
  apply(t: number) {
    for (const [id, keys] of Object.entries(this.scene.tracks)) {
      const piece = this.pieces.get(id);
      if (!piece) continue;
      this.set(piece, lookAt(keys, this.placed.get(id) ?? [], t, this));
    }
  }

  private set(piece: Piece, look: PieceLook) {
    const { el } = piece;
    const style = (el as HTMLElement | SVGElement).style;
    if (piece.svg && (look.at || look.scale !== undefined || look.scaleX !== undefined || look.scaleY !== undefined || look.rotate !== undefined)) {
      const parts: string[] = [];
      if (look.at && piece.parentInv) {
        const dx = look.at.x - piece.home.x, dy = look.at.y - piece.home.y;
        const m = piece.parentInv;
        const px = m.a * dx + m.c * dy, py = m.b * dx + m.d * dy;
        if (Math.abs(px) > 1e-3 || Math.abs(py) > 1e-3) parts.push(`translate(${px.toFixed(2)} ${py.toFixed(2)})`);
      }
      if (piece.was.transform) parts.push(piece.was.transform);
      const s = look.scale ?? 1, r = look.rotate ?? 0;
      // Width and height alone multiply the whole size; all three are about the piece's centre.
      const sx = Math.max(0, s * (look.scaleX ?? 1)), sy = Math.max(0, s * (look.scaleY ?? 1));
      if (sx !== 1 || sy !== 1 || r !== 0) {
        const { x, y } = piece.local;
        parts.push(`translate(${x.toFixed(2)} ${y.toFixed(2)})`);
        if (r) parts.push(`rotate(${r.toFixed(2)})`);
        if (sx !== 1 || sy !== 1) parts.push(sx === sy ? `scale(${sx.toFixed(4)})` : `scale(${sx.toFixed(4)} ${sy.toFixed(4)})`);
        parts.push(`translate(${(-x).toFixed(2)} ${(-y).toFixed(2)})`);
      }
      if (parts.length) el.setAttribute('transform', parts.join(' '));
      else el.removeAttribute('transform');
    }
    if (look.opacity !== undefined) style.opacity = String(Math.max(0, Math.min(1, look.opacity)));
    if (look.color) style.color = colourCss(look.color);
    if (look.lit !== undefined) for (const l of piece.lit) l.el.style.filter = look.lit ? this.lit : l.filter;
    if (look.text !== undefined && piece.textEl && piece.textEl.textContent !== look.text) piece.textEl.textContent = look.text;
    if (look.draw !== undefined) {
      for (const { el: g, len } of piece.lines) {
        if (!(len > 0)) continue;
        g.style.strokeDasharray = `${len} ${len}`;
        g.style.strokeDashoffset = String(len * (1 - Math.max(0, Math.min(1, look.draw))));
      }
    }
  }

  /** Everything back as the board drew it. */
  restore() {
    for (const piece of this.pieces.values()) {
      const { el, was } = piece;
      const style = (el as HTMLElement | SVGElement).style;
      if (was.transform === null) el.removeAttribute('transform');
      else el.setAttribute('transform', was.transform);
      style.opacity = was.opacity;
      style.color = was.color;
      for (const l of piece.lit) l.el.style.filter = l.filter;
      if (piece.textEl && was.text !== null && piece.textEl.textContent !== was.text) piece.textEl.textContent = was.text;
      for (const d of was.dashes) {
        d.el.style.strokeDasharray = d.da;
        d.el.style.strokeDashoffset = d.dof;
      }
    }
  }
}

function pt(p: DOMPoint): Pt {
  return { x: p.x, y: p.y };
}
