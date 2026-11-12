import type { ShapeScene } from '@plannotator/core/shape-scene';
import { colourCss, lookAt, places, type Geo, type PieceLook, type Pt } from './timeline';
import { ownLine } from '../litLine';

const GEOMETRY = 'path, line, polyline, polygon, circle, ellipse, rect';
const LIT = 'drop-shadow(0 0 2.5px var(--mark)) drop-shadow(0 0 7px color-mix(in oklab, var(--mark) 55%, transparent))';

interface Piece {
  el: Element;
  svg: boolean;
  was: { transform: string | null; opacity: string; color: string; text: string | null; dashes: { el: SVGGeometryElement; da: string; dof: string }[] };
  lit: { el: HTMLElement | SVGElement; filter: string; line: 'stroke' | 'border' | null; colour: string }[];
  local: Pt;
  home: Pt;
  parentInv: DOMMatrix | null;
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

  constructor(private slot: HTMLElement, private scene: ShapeScene, private lit: string = LIT, private litShapesOnly = false) {}

  private svg(): SVGSVGElement | null {
    return this.slot.querySelector('svg');
  }

  private find(id: string): Element | null {
    const sel = `[data-part="${CSS.escape(id)}"]`;
    return this.slot.querySelector(sel) ?? (this.slot.getRootNode() as ParentNode).querySelector?.(sel) ?? null;
  }

  private toRoot(el: Element): DOMMatrix | null {
    const root = this.root;
    if (!root || !isSvgGraphic(el)) return null;
    const r = root.getScreenCTM(), m = (el as SVGGraphicsElement).getScreenCTM();
    if (!r || !m) return null;
    return DOMMatrix.fromMatrix(r).inverse().multiply(DOMMatrix.fromMatrix(m));
  }

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
      const shapes = this.litShapesOnly && svg && el.tagName.toLowerCase() !== 'text' && !el.matches(GEOMETRY) ? geoms.filter((g) => !g.closest('text, [data-icon], [data-logo], [data-brand]')) : [];
      const litEls: (HTMLElement | SVGElement)[] = shapes.length ? shapes : [el as HTMLElement | SVGElement];
      this.pieces.set(id, {
        el,
        svg,
        was: { transform: el.getAttribute('transform'), opacity: style.opacity, color: style.color, text: textEl ? textEl.textContent : null, dashes: lines.map((l) => ({ el: l.el, da: l.el.style.strokeDasharray, dof: l.el.style.strokeDashoffset })) },
        lit: litEls.map((l) => {
          const line = this.litShapesOnly && (svg ? l.matches(GEOMETRY) : true) ? ownLine(l) : null;
          return { el: l, filter: l.style.filter, line, colour: line === 'stroke' ? l.style.stroke : line === 'border' ? l.style.borderColor : '' };
        }),
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
    if (look.lit !== undefined) for (const l of piece.lit) this.light(l, look.lit);
    if (look.text !== undefined && piece.textEl && piece.textEl.textContent !== look.text) piece.textEl.textContent = look.text;
    if (look.draw !== undefined) {
      for (const { el: g, len } of piece.lines) {
        if (!(len > 0)) continue;
        g.style.strokeDasharray = `${len} ${len}`;
        g.style.strokeDashoffset = String(len * (1 - Math.max(0, Math.min(1, look.draw))));
      }
    }
  }

  private light(l: Piece['lit'][number], on: boolean) {
    const style = l.el.style;
    if (!l.line) style.filter = on ? this.lit : l.filter;
    else if (on || l.colour) style.setProperty(l.line === 'stroke' ? 'stroke' : 'border-color', on ? 'var(--mark)' : l.colour);
    else style.removeProperty(l.line === 'stroke' ? 'stroke' : 'border-color');
  }

  restore() {
    for (const piece of this.pieces.values()) {
      const { el, was } = piece;
      const style = (el as HTMLElement | SVGElement).style;
      if (was.transform === null) el.removeAttribute('transform');
      else el.setAttribute('transform', was.transform);
      style.opacity = was.opacity;
      style.color = was.color;
      for (const l of piece.lit) this.light(l, false);
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
