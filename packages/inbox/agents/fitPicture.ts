/**
 * "Your own…": a still photo over the upload limit (a phone's 3–5 MB photo) is shrunk in the window instead of refused.
 * Only a still JPEG, PNG or WebP, or another still the browser can open (an iPhone's HEIC in Safari), is ever redrawn:
 * scaled down to fit `ICON_PICTURE_SIDE` with its own proportions and transparency (no crop, as uploads are shown),
 * turned the way the phone held it (EXIF), and written again as a PNG (it may be transparent) or a JPEG. A GIF, an SVG,
 * an animated PNG or WebP keeps today's rule and words. What comes out goes through the upload's own checks.
 */
import { PICTURE_MAX_BYTES } from '../projectPictures';

/**
 * The longest side a shrunk photo keeps: an icon is drawn at most 40 px (the dialog's grid, a finger's picker), 120
 * device pixels on a 3x phone; 256 leaves room above that.
 */
export const ICON_PICTURE_SIDE = 256;

export type PictureKind = 'jpeg' | 'png' | 'apng' | 'gif' | 'webp' | 'webp-animated' | 'svg' | 'other';

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/** What a file is, from its first bytes (a PNG's chunks up to its first picture data: an `acTL` makes it animated). */
export function pictureKind(bytes: Uint8Array): PictureKind {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return ascii(bytes, 12, 4) === 'VP8X' && ((bytes[20] ?? 0) & 0x02) !== 0 ? 'webp-animated' : 'webp';
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 8; at + 8 <= bytes.length; ) {
      const type = ascii(bytes, at + 4, 4);
      if (type === 'acTL') return 'apng';
      if (type === 'IDAT') break;
      at += 12 + view.getUint32(at);
    }
    return 'png';
  }
  const text = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (text.startsWith('<svg') || text.startsWith('<?xml') || text.startsWith('<!--')) return 'svg';
  return 'other';
}

/** Whether a file is shrunk before it is sent: over the limit, and a still that is redrawn without losing anything that moves. */
export function shrinksPicture(kind: PictureKind, size: number): boolean {
  return size > PICTURE_MAX_BYTES && (kind === 'jpeg' || kind === 'png' || kind === 'webp' || kind === 'other');
}

/** The size a picture is redrawn at: its own proportions, the longest side at most `side`, never larger than it was. */
export function fittedSize(width: number, height: number, side = ICON_PICTURE_SIDE): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const TYPE_REFUSAL = 'Picture: a PNG, JPEG, GIF, WebP or SVG image.';

/**
 * The file to send: the picked one, or a still over the limit shrunk. A big file the browser cannot open is refused
 * with the upload's own words for a kind it does not take (an iPhone's HEIC in a browser that cannot read it).
 */
export async function fitPicture(file: File): Promise<{ file: Blob } | { refused: string }> {
  if (file.size <= PICTURE_MAX_BYTES) return { file };
  const kind = pictureKind(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
  if (!shrinksPicture(kind, file.size)) return { file };
  const url = URL.createObjectURL(file);
  try {
    // An <img> opens it turned the way the phone held it (EXIF), and drawImage keeps that turn.
    const img = new Image();
    img.src = url;
    await img.decode();
    const { width, height } = fittedSize(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return { file };
    context.imageSmoothingQuality = 'high';
    context.drawImage(img, 0, 0, width, height);
    const transparent = kind === 'png' || kind === 'webp';
    const type = transparent ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type, 0.9));
    if (!blob) return { file };
    const name = `${(file.name || 'picture').replace(/\.[^.]*$/, '')}.${transparent ? 'png' : 'jpg'}`;
    return { file: new File([blob], name, { type }) };
  } catch {
    return kind === 'other' ? { refused: TYPE_REFUSAL } : { file };
  } finally {
    URL.revokeObjectURL(url);
  }
}
