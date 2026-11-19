/**
 * A snapshot as a still picture: one self-contained SVG, no script, no
 * outside reference. It is the fallback a plan carries for places the live
 * canvas cannot go (another Markdown viewer, an export, a canvas that cannot
 * be loaded). Simpler than the figure on purpose: one line of text per
 * object, no embedded HTML, and a picture is drawn as its words in a box, so
 * the file never asks the network for anything. A host writes it to a file
 * or an asset and puts that address in the plan, never the SVG itself.
 */
import type { CanvasColor } from '../model/color';
import { captureDocument } from '../model/capture';
import { resolveArrow } from '../model/document';
import type { CanvasDocument, CanvasObject, SnapshotId } from '../model/types';
import { isPlaced } from '../model/types';
import { referenceAddress } from '../model/reference';

interface Palette {
  stage: string;
  card: string;
  line: string;
  ink: string;
  muted: string;
  arrow: string;
  note: string;
  onNote: string;
  named: Record<string, { stroke: string; fill: string }>;
}

const LIGHT: Palette = {
  stage: '#f5f6f8',
  card: '#ffffff',
  line: '#d8dae0',
  ink: '#10131c',
  muted: '#474b57',
  arrow: '#646874',
  note: '#f4b467',
  onNote: '#2b1c08',
  named: {
    blue: { stroke: '#2f6fc4', fill: '#ebf2fc' },
    green: { stroke: '#2a8050', fill: '#e8f5ec' },
    amber: { stroke: '#a9790f', fill: '#fbf1d9' },
    red: { stroke: '#c5392f', fill: '#fcecea' },
    violet: { stroke: '#5b3fd6', fill: '#efecfd' },
  },
};

const DARK: Palette = {
  stage: '#1c1c1f',
  card: '#2d2d31',
  line: '#3f3f44',
  ink: '#eeeeef',
  muted: '#c8c8cc',
  arrow: '#9b9ba1',
  note: '#eaa860',
  onNote: '#22160a',
  named: {
    blue: { stroke: '#8cb4ee', fill: '#26344a' },
    green: { stroke: '#7fc79b', fill: '#22392c' },
    amber: { stroke: '#dcb45c', fill: '#3d3320' },
    red: { stroke: '#f09a8c', fill: '#472925' },
    violet: { stroke: '#a99cf5', fill: '#30294d' },
  },
};

/** Text made safe for XML: the five characters escaped, and the control characters XML forbids taken out (one of them makes the whole file fail to load). */
const esc = (value: string): string =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n = (value: number): string => String(Math.round(value * 100) / 100);

/** One line that fits `width` at `fontSize`, cut with an ellipsis. Widths are estimated. */
function fitLine(text: string, width: number, fontSize: number): string {
  const line = text.split('\n')[0] ?? '';
  const max = Math.max(1, Math.floor(width / (fontSize * 0.55)));
  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line;
}

function paint(color: CanvasColor | undefined, palette: Palette): { stroke: string; fill: string } {
  if (!color || color === 'neutral') return { stroke: palette.line, fill: palette.card };
  if (typeof color === 'string') return palette.named[color] ?? { stroke: palette.line, fill: palette.card };
  return { stroke: esc(color.custom), fill: palette.card };
}

function drawObject(doc: CanvasDocument, object: CanvasObject, palette: Palette): string {
  if (object.type === 'arrow') {
    const g = resolveArrow(doc, object);
    if (!g) return '';
    const stroke = object.color && object.color !== 'neutral' ? paint(object.color, palette).stroke : palette.arrow;
    const angle = Math.atan2(g.to.y - g.from.y, g.to.x - g.from.x);
    const head = [0.42, -0.42]
      .map((spread) => `${n(g.to.x - 10 * Math.cos(angle + spread))},${n(g.to.y - 10 * Math.sin(angle + spread))}`)
      .join(' ');
    return `<line x1="${n(g.from.x)}" y1="${n(g.from.y)}" x2="${n(g.to.x)}" y2="${n(g.to.y)}" stroke="${stroke}" stroke-width="1.5"/><polygon points="${n(g.to.x)},${n(g.to.y)} ${head}" fill="${stroke}"/>`;
  }
  if (!isPlaced(object)) return '';
  const { x, y, w, h } = object;
  const box = `x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"`;
  switch (object.type) {
    case 'frame': {
      const { stroke } = paint(object.color, palette);
      return `<rect ${box} rx="12" fill="none" stroke="${stroke}"/><text x="${n(x + 2)}" y="${n(y - 8)}" font-size="12.5" font-weight="500" fill="${palette.muted}">${esc(fitLine(object.title, w, 12.5))}</text>`;
    }
    case 'box': {
      const { stroke, fill } = paint(object.color, palette);
      const detail = object.detail
        ? `<text x="${n(x + 14)}" y="${n(y + 42)}" font-size="12.5" fill="${palette.muted}">${esc(fitLine(object.detail, w - 28, 12.5))}</text>`
        : '';
      return `<rect ${box} rx="8" fill="${fill}" stroke="${stroke}"/><text x="${n(x + 14)}" y="${n(y + 25)}" font-size="14" font-weight="600" fill="${palette.ink}">${esc(fitLine(object.text, w - 28, 14))}</text>${detail}`;
    }
    case 'note': {
      const fill = object.color && object.color !== 'neutral' ? paint(object.color, palette).stroke : palette.note;
      return `<rect ${box} rx="8" fill="${fill}"/><text x="${n(x + 10)}" y="${n(y + 22)}" font-size="13" fill="${palette.onNote}">${esc(fitLine(object.text, w - 20, 13))}</text>`;
    }
    case 'text': {
      const size = object.size === 'large' ? 22 : object.size === 'small' ? 12.5 : 15;
      const fill = object.color && object.color !== 'neutral' ? paint(object.color, palette).stroke : palette.ink;
      return `<text x="${n(x)}" y="${n(y + size)}" font-size="${size}" fill="${fill}">${esc(fitLine(object.text, w, size))}</text>`;
    }
    case 'image':
    case 'sprite':
      return `<rect ${box} rx="6" fill="${palette.card}" stroke="${palette.line}" stroke-dasharray="4 3"/><text x="${n(x + 8)}" y="${n(y + 20)}" font-size="12" fill="${palette.muted}">${esc(fitLine(object.alt, w - 16, 12))}</text>`;
    case 'html':
      return `<rect ${box} rx="6" fill="none" stroke="${palette.line}" stroke-dasharray="4 3"/>`;
    case 'reference': {
      const { stroke, fill } = paint(object.color, palette);
      const title = object.title || referenceAddress(object.target);
      const site = object.site ? `<text x="${n(x + 12)}" y="${n(y + h - 12)}" font-size="11.5" fill="${palette.muted}">${esc(fitLine(object.site, w - 24, 11.5))}</text>` : '';
      return `<rect ${box} rx="10" fill="${fill}" stroke="${stroke}"/><text x="${n(x + 12)}" y="${n(y + 24)}" font-size="13.5" font-weight="600" fill="${palette.ink}">${esc(fitLine(title, w - 24, 13.5))}</text>${site}`;
    }
  }
}

export interface SnapshotPictureOptions {
  theme?: 'light' | 'dark';
}

/**
 * The snapshot's capture as SVG text. Null when the canvas has no such
 * snapshot. The same picture the figure shows, whatever the canvas holds now.
 */
export function snapshotToSvg(doc: CanvasDocument, id: SnapshotId, options: SnapshotPictureOptions = {}): string | null {
  const snapshot = doc.snapshots[id];
  if (!snapshot) return null;
  const palette = options.theme === 'dark' ? DARK : LIGHT;
  const { rect, objects } = snapshot.capture;
  const { x, y, w, h } = rect;
  const frozen = captureDocument(snapshot.capture);
  const placed: string[] = [];
  const arrows: string[] = [];
  for (const object of objects) (object.type === 'arrow' ? arrows : placed).push(drawObject(frozen, object, palette));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(x)} ${n(y)} ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}" font-family="Inter, system-ui, sans-serif" role="img">` +
    `<title>${esc(snapshot.title)}</title>` +
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${palette.stage}"/>` +
    placed.join('') +
    arrows.join('') +
    '</svg>'
  );
}
