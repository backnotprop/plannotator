import notices from '@plannotator/diagrams/notices';
import type { DiagramPart, DiagramReference, renderDiagram } from '@plannotator/diagrams';
import type { ScreenRect } from '../../utils/diagram-projection';
import type { Viewport } from './useDiagramViewport';

export type NativeDiagramDrawing = Awaited<ReturnType<typeof renderDiagram>>;
export type NativeDiagramFileReference = Extract<DiagramReference, { kind: 'file' }>;

export interface NativeDiagramAnchor {
  kind: DiagramPart['kind'];
  id: string;
  title: string;
  /** Fractions of the part's measured bounds, preserved across layout changes. */
  x: number;
  y: number;
}

export interface NativeDiagramComment {
  id: string;
  text: string;
  anchor: NativeDiagramAnchor;
  number?: number;
}

export function partKey(part: Pick<DiagramPart, 'kind' | 'id'>): string {
  return JSON.stringify([part.kind, part.id]);
}

export function screenRect(part: DiagramPart, view: Viewport): ScreenRect {
  return { left: view.x + part.x * view.scale, top: view.y + part.y * view.scale, width: part.w * view.scale, height: part.h * view.scale };
}

export function anchorOnPart(part: DiagramPart, client?: { clientX: number; clientY: number }, bounds?: DOMRect): NativeDiagramAnchor {
  const fraction = (offset: number, length: number) => length > 0 ? Math.max(0, Math.min(1, offset / length)) : 0.5;
  return {
    kind: part.kind, id: part.id, title: part.title,
    x: bounds && client ? fraction(client.clientX - bounds.left, bounds.width) : 0.5,
    y: bounds && client ? fraction(client.clientY - bounds.top, bounds.height) : 0.5,
  };
}

const SVG = 'http://www.w3.org/2000/svg';
const LAYERS = { group: 0, link: 1, panel: 2, section: 3 } as const;

/** The renderer output is an inert SVG image. Only measured hit geometry is mounted in the host DOM. */
export function reviewSvg(drawing: NativeDiagramDrawing, imageUrl: string): SVGSVGElement {
  const root = document.createElementNS(SVG, 'svg');
  root.setAttribute('viewBox', `0 0 ${drawing.width} ${drawing.height}`);
  root.setAttribute('aria-hidden', 'true');
  const metadata = document.createElementNS(SVG, 'metadata');
  metadata.textContent = notices;
  root.appendChild(metadata);
  const image = document.createElementNS(SVG, 'image');
  image.setAttribute('href', imageUrl);
  image.setAttribute('width', String(drawing.width));
  image.setAttribute('height', String(drawing.height));
  root.appendChild(image);

  const ordered = drawing.parts.map((part, index) => ({ part, index })).sort((a, b) =>
    LAYERS[a.part.kind] - LAYERS[b.part.kind] || b.part.w * b.part.h - a.part.w * a.part.h);
  for (const { part, index } of ordered) {
    const group = document.createElementNS(SVG, 'g');
    group.setAttribute('data-native-hit', String(index));
    if (part.kind === 'link' && part.points?.length) {
      const target = document.createElementNS(SVG, 'polyline');
      target.setAttribute('points', part.points.map(p => p.join(',')).join(' '));
      target.setAttribute('fill', 'none');
      target.setAttribute('stroke', 'transparent');
      target.setAttribute('stroke-width', '14');
      target.setAttribute('pointer-events', 'stroke');
      target.setAttribute('vector-effect', 'non-scaling-stroke');
      group.appendChild(target);
    }
    const box = part.kind === 'link' && part.points?.length ? part.labelBox : part;
    if (box) {
      const target = document.createElementNS(SVG, 'rect');
      for (const [name, value] of Object.entries({ x: box.x, y: box.y, width: box.w, height: box.h, rx: 4 })) {
        target.setAttribute(name, String(value));
      }
      target.setAttribute('fill', 'transparent');
      group.appendChild(target);
    }
    root.appendChild(group);
  }
  return root;
}

/** A second pin at the same point must still be independently reachable at every zoom. */
export function placeCommentPins(comments: readonly NativeDiagramComment[], parts: ReadonlyMap<string, DiagramPart>, view: Viewport) {
  const pins: { comment: NativeDiagramComment; index: number; part: DiagramPart; x: number; y: number }[] = [];
  comments.forEach((comment, index) => {
    const part = parts.get(partKey(comment.anchor));
    if (!part) return;
    const box = screenRect(part, view);
    const x = box.left + box.width * comment.anchor.x;
    const y = box.top + box.height * comment.anchor.y;
    let left = x;
    let step = 0;
    while (pins.some(p => Math.abs(p.x - left) < 25 && Math.abs(p.y - y) < 25)) {
      step++;
      left = x + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 27;
    }
    pins.push({ comment, index, part, x: left, y });
  });
  return pins;
}
