/**
 * Getting a picture a person pasted or picked onto the board: read it,
 * hand its bytes to the host's `AssetPort`, and add an image object that
 * holds only the reference. Nothing here puts bytes in the document.
 *
 * Every way this can fail ends in a line the person can read
 * (`PictureProblem`), never in nothing happening.
 */
import type { CanvasStore } from '../events/store';
import type { AssetPort } from '../model/assets';
import type { Point } from '../model/geometry';
import { createId } from '../model/ids';

/** The largest file the editor will take, before the host has its own say. */
export const PICTURE_MAX_BYTES = 25 * 1024 * 1024;

export type PictureProblem = 'unavailable' | 'too-large' | 'unreadable' | 'not-saved';

/** Kinds every browser draws from an `<img>`; anything else is redrawn as PNG first. */
const DIRECT = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']);

export const looksLikePicture = (file: File): boolean => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|bmp|tiff?|heic|heif)$/i.test(file.name);

/** The picture's size, and the bytes to store: the file itself, or a PNG of it when browsers cannot draw its kind from a file. */
async function read(file: File): Promise<{ blob: Blob; w: number; h: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    // Decodes whatever this browser can (bmp everywhere; tiff and heic where the system can), and fails for the rest.
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const size = { w: bitmap.width, h: bitmap.height };
  if (size.w === 0 || size.h === 0) {
    bitmap.close();
    return null;
  }
  if (DIRECT.has(file.type)) {
    bitmap.close();
    return { blob: file, ...size };
  }
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? { blob, ...size } : null;
}

/**
 * Add a pasted or picked picture centred on `at`. Resolves with the new
 * object's id, or with the reason it was not added.
 */
export async function addPicture(store: CanvasStore, assets: AssetPort | null | undefined, file: File, at: Point): Promise<{ id: string } | { problem: PictureProblem }> {
  if (!assets) return { problem: 'unavailable' };
  if (file.size > PICTURE_MAX_BYTES) return { problem: 'too-large' };
  // An SVG has no bitmap in every browser's decoder; it is stored as it is and sized when it loads.
  const picture = file.type === 'image/svg+xml' ? { blob: file as Blob, w: 320, h: 200 } : await read(file);
  if (!picture) return { problem: 'unreadable' };
  let kept: Awaited<ReturnType<AssetPort['put']>>;
  try {
    kept = await assets.put(picture.blob, file.name);
  } catch {
    return { problem: 'not-saved' };
  }
  if ('refused' in kept) return { problem: kept.refused === 'too-large' ? 'too-large' : kept.refused === 'not-a-picture' ? 'unreadable' : 'not-saved' };
  // Keep it visible and grabbable whatever its shape: at most 320 on the long side, at least 24 on the short one.
  const scale = Math.min(1, 320 / Math.max(picture.w, picture.h));
  const w = Math.max(24, Math.round(picture.w * scale));
  const h = Math.max(24, Math.round(picture.h * scale));
  const id = createId('image');
  const result = store.dispatch({ type: 'add', objects: [{ id, type: 'image', src: kept.ref, alt: file.name.slice(0, 300) || 'Picture', x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h }] });
  return result.ok ? { id } : { problem: 'not-saved' };
}
