/**
 * The files the agent reads, made here from the original capture so the
 * browser fallback has the same pixel logic as the native panel:
 *  - agent.png: long edge ≤ 2000 px, redactions blacked out, strokes and the
 *    numbered box outlines burned in (the message lists the same boxes with
 *    their coordinates in this image's pixels);
 *  - crop-<n>.png: each box smaller than 40 % of the snapshot, at full resolution,
 *    redacted, so small text stays legible.
 */

import { agentSizeFor, needsCrop, type Snapshot, type SnapshotStroke } from '@plannotator/shared/snapshots/types';
import { api, snapshotImageUrl } from './api';

const MARKER = '#ff3b30';

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  return { canvas, ctx };
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))), 'image/png'));
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: SnapshotStroke, scale: number): void {
  const points = stroke.points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  if (points.length < 2) return;
  const width = Math.max(1.5, stroke.size * scale);
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (stroke.tool === 'arrow') {
    const a = points[0]!;
    const b = points[points.length - 1]!;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = Math.max(10, width * 4);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x - Math.cos(angle) * head * 0.6, b.y - Math.sin(angle) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 7), b.y - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 7), b.y - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRedactions(ctx: CanvasRenderingContext2D, snapshot: Snapshot, scale: number, offset = { x: 0, y: 0 }): void {
  ctx.fillStyle = '#000';
  for (const redaction of snapshot.redactions) {
    const [x, y, w, h] = redaction.rect;
    ctx.fillRect((x - offset.x) * scale, (y - offset.y) * scale, w * scale, h * scale);
  }
}

function drawBoxes(ctx: CanvasRenderingContext2D, snapshot: Snapshot, scale: number, longEdge: number): void {
  const line = Math.max(2, Math.round(longEdge / 700));
  const radius = Math.max(10, Math.round(longEdge / 110));
  for (const box of snapshot.boxes) {
    const [x, y, w, h] = box.rect.map((v) => v * scale) as [number, number, number, number];
    ctx.save();
    ctx.strokeStyle = MARKER;
    ctx.lineWidth = line;
    ctx.strokeRect(x, y, w, h);
    const cx = Math.max(radius, x);
    const cy = Math.max(radius, y);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = MARKER;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(radius * 1.1)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(box.n), cx, cy + radius * 0.06);
    ctx.restore();
  }
}

/** Make and upload agent.png (and the crops) for one snapshot, unless the hub already has them for its current marks. */
export async function deriveSnapshot(snapshot: Snapshot): Promise<void> {
  const cropsDone = snapshot.boxes.filter((box) => needsCrop(box, snapshot.original.width, snapshot.original.height)).every((box) => snapshot.crops[box.id]);
  if (snapshot.agent && cropsDone) return;
  const image = await loadImage(await snapshotImageUrl(snapshot.id, snapshot.original.file));
  const size = agentSizeFor(snapshot.original.width, snapshot.original.height);
  if (!snapshot.agent) {
    const { canvas, ctx } = canvasOf(size.width, size.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, size.width, size.height);
    drawRedactions(ctx, snapshot, size.scale);
    for (const stroke of snapshot.strokes) drawStroke(ctx, stroke, size.scale);
    drawBoxes(ctx, snapshot, size.scale, Math.max(size.width, size.height));
    await api.putDerived(snapshot.id, 'agent.png', await toBlob(canvas));
  }
  for (const box of snapshot.boxes) {
    if (!needsCrop(box, snapshot.original.width, snapshot.original.height) || snapshot.crops[box.id]) continue;
    const [x, y, w, h] = box.rect;
    const crop = agentSizeFor(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const { canvas, ctx } = canvasOf(crop.width, crop.height);
    ctx.drawImage(image, x, y, w, h, 0, 0, crop.width, crop.height);
    drawRedactions(ctx, snapshot, crop.scale, { x, y });
    await api.putDerived(snapshot.id, `crop-${box.n}.png`, await toBlob(canvas), box.id);
  }
}
