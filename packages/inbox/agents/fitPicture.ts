import { PICTURE_MAX_BYTES } from '../projectPictures';

/** Longest side a shrunk photo keeps: icons draw at most 40 px, 120 device px on a 3x phone; 256 leaves room. */
export const ICON_PICTURE_SIDE = 256;

export type PictureKind = 'jpeg' | 'png' | 'apng' | 'gif' | 'webp' | 'webp-animated' | 'svg' | 'other';

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

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

export function shrinksPicture(kind: PictureKind, size: number): boolean {
  return size > PICTURE_MAX_BYTES && (kind === 'jpeg' || kind === 'png' || kind === 'webp' || kind === 'other');
}

export function fittedSize(width: number, height: number, side = ICON_PICTURE_SIDE): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const TYPE_REFUSAL = 'Picture: a PNG, JPEG, GIF, WebP or SVG image.';

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
