import getStroke from 'perfect-freehand';
import type { Point, Stroke } from './types';

const STROKE_OPTIONS = {
  size: 4,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.5,
};

function getSvgPathFromStroke(stroke: number[][]): string {
  if (!stroke.length) return '';

  const d = stroke.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ['M', ...stroke[0], 'Q']
  );

  d.push('Z');
  return d.join(' ');
}

export function renderPenStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  size: number,
  scale = 1
) {
  if (points.length < 2) return;

  const scaledPoints = points.map(p => [p.x * scale, p.y * scale, p.pressure ?? 0.5]);
  const stroke = getStroke(scaledPoints, { ...STROKE_OPTIONS, size: size * scale });

  const path = new Path2D(getSvgPathFromStroke(stroke));
  ctx.fillStyle = color;
  ctx.fill(path);
}

export function renderArrow(
  ctx: CanvasRenderingContext2D,
  start: Point,
  end: Point,
  color: string,
  size: number,
  scale = 1
) {
  const x1 = start.x * scale;
  const y1 = start.y * scale;
  const x2 = end.x * scale;
  const y2 = end.y * scale;

  const lineWidth = size * scale * 0.75;
  const headLength = size * scale * 3;

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle - Math.PI / 6),
    y2 - headLength * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    x2 - headLength * Math.cos(angle + Math.PI / 6),
    y2 - headLength * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
}

export function renderCircle(
  ctx: CanvasRenderingContext2D,
  start: Point,
  end: Point,
  color: string,
  size: number,
  scale = 1
) {
  const x1 = start.x * scale;
  const y1 = start.y * scale;
  const x2 = end.x * scale;
  const y2 = end.y * scale;

  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;

  const radius = Math.hypot(x2 - x1, y2 - y1) / 2;
  const lineWidth = size * scale * 0.75;

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
}

export function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  scale = 1
) {
  if (stroke.points.length < 2) return;

  switch (stroke.tool) {
    case 'pen':
      renderPenStroke(ctx, stroke.points, stroke.color, stroke.size, scale);
      break;
    case 'arrow':
      renderArrow(ctx, stroke.points[0], stroke.points[stroke.points.length - 1], stroke.color, stroke.size, scale);
      break;
    case 'circle':
      renderCircle(ctx, stroke.points[0], stroke.points[stroke.points.length - 1], stroke.color, stroke.size, scale);
      break;
  }
}
