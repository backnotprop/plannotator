/**
 * Pictures of a canvas's elements, as PNGs (CanvasBoard.tsx: an agent's drawing jobs, and the pictures a reply sent
 * from the canvas carries). Loaded with the editor's chunk, never with the window.
 */
import { exportToCanvas } from '@excalidraw/excalidraw';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { boxOf, pictureTiles, unionBox, type Box, type CanvasElement } from '@plannotator/shared/inbox/canvas/scene';

const PAD = 24;
const PICTURE_MAX = 2400;

const asCanvas = (elements: readonly ExcalidrawElement[]) => elements as unknown as CanvasElement[];

export interface Drawn {
  blob: Blob;
  canvas?: HTMLCanvasElement;
  place: { x: number; y: number; w: number; h: number; scale: number };
}

/** A PNG of some elements, always on white in the light look (what an agent reads must not depend on the person's theme). */
export async function draw(elements: readonly ExcalidrawElement[], files: BinaryFiles, max = PICTURE_MAX, most = 2): Promise<Drawn | null> {
  const shown = elements.filter((e) => !e.isDeleted);
  if (shown.length === 0) return null;
  let scale = 1;
  const canvas = await exportToCanvas({
    elements: shown,
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
    files,
    exportPadding: PAD,
    getDimensions: (width: number, height: number) => {
      scale = Math.min(most, max / Math.max(width, height, 1));
      return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
    },
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return { blob, canvas, place: { x: 0, y: 0, w: canvas.width / scale, h: canvas.height / scale, scale } };
}

/** A part of a placed picture, with what is under and around it (a ring drawn on a photo comes with the photo). */
export async function cut(whole: Drawn, part: Box, pad = 28): Promise<Blob | null> {
  if (!whole.canvas) return null;
  const { place } = whole;
  const x0 = Math.max(0, Math.floor((part.x - pad - place.x) * place.scale));
  const y0 = Math.max(0, Math.floor((part.y - pad - place.y) * place.scale));
  const x1 = Math.min(whole.canvas.width, Math.ceil((part.x + part.w + pad - place.x) * place.scale));
  const y1 = Math.min(whole.canvas.height, Math.ceil((part.y + part.h + pad - place.y) * place.scale));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const out = document.createElement('canvas');
  out.width = x1 - x0;
  out.height = y1 - y0;
  out.getContext('2d')?.drawImage(whole.canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
}

/** The same picture, with where on the canvas it is. */
export async function drawPlaced(elements: readonly ExcalidrawElement[], files: BinaryFiles, max = PICTURE_MAX, most = 2): Promise<Drawn | null> {
  const shown = elements.filter((e) => !e.isDeleted);
  const drawn = await draw(shown, files, max, most);
  if (!drawn) return null;
  const around = unionBox(asCanvas(shown).map(boxOf));
  // The picture is the elements' bounds with the padding around them; a stroke's width can push it a little past, which the size carries.
  return { blob: drawn.blob, canvas: drawn.canvas, place: { ...drawn.place, x: around.x - (drawn.place.w - around.w) / 2, y: around.y - (drawn.place.h - around.h) / 2 } };
}

/** The longest side, in pixels, of the one large drawing that pieces of a long picture are cut from. */
export const STRIP_MAX = 14_000;

/**
 * A long strip (a tall screenshot, a wide timeline) as pieces that can each be read, in order: one picture of it
 * would be a sliver. Empty when one picture is enough.
 */
export async function pieces(elements: readonly ExcalidrawElement[], files: BinaryFiles, most: number): Promise<Blob[]> {
  const shown = elements.filter((e) => !e.isDeleted);
  if (shown.length === 0) return [];
  const around = unionBox(asCanvas(shown).map(boxOf));
  const tiles = pictureTiles({ x: around.x - PAD, y: around.y - PAD, w: around.w + PAD * 2, h: around.h + PAD * 2 }, PICTURE_MAX, most);
  if (tiles.length < 2) return [];
  const whole = await drawPlaced(shown, files, STRIP_MAX, 1);
  if (!whole) return [];
  const out: Blob[] = [];
  for (const tile of tiles) {
    const part = await cut(whole, tile, 0);
    if (part) out.push(part);
  }
  return out.length === tiles.length ? out : [];
}
