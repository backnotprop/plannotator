/**
 * "Copy image" in a tile's menu (TileMenu): the clipboard a browser's own Copy
 * Image leaves, so a paste into a reply still adds the same file
 * (compose/reusePaste.ts reads the HTML's one `<img src>`, absolute, on this
 * origin) and a paste anywhere else is a picture (`image/png`, the one picture
 * type every browser's clipboard takes; another type is drawn to PNG first).
 */

/** The HTML Chrome's Copy Image writes: a charset `<meta>` and one `<img>` with the absolute address. */
export function copiedImageHtml(src: string, alt: string): string {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<meta charset="utf-8"><img src="${escape(src)}" alt="${escape(alt)}">`;
}

/** The image's bytes as a PNG: as served when they are one, else drawn once to a canvas. */
async function pngOf(src: string): Promise<Blob> {
  const response = await fetch(src, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`image ${response.status}`);
  const blob = await response.blob();
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('no PNG'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Puts the image at `src` (its route, as the page draws it) on the clipboard. The PNG goes in as a promise, so
 * the write starts inside the click (Safari asks for that). False: this browser has no image clipboard, or the
 * write was refused.
 */
export async function copyImageToClipboard(src: string, alt: string): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  try {
    const absolute = new URL(src, location.href).href;
    const png = pngOf(absolute);
    // A refused write may never read it: its failure is the write's, not an unhandled rejection.
    png.catch(() => {});
    const item = new ClipboardItem({
      'text/html': new Blob([copiedImageHtml(absolute, alt)], { type: 'text/html' }),
      'image/png': png,
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}
