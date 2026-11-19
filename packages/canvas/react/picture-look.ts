/**
 * What is known of a picture once it has loaded: whether it has see-through
 * parts, and how light it is, place by place. Looked at once per address,
 * on a 24 by 24 copy.
 *
 * Two things read it. A picture with see-through parts gets a light ground
 * on a dark board. And words or a line lying over a picture take their ink
 * from the picture under them, not from the board's theme (`groundUnder`):
 * a label on a pale screenshot is dark in both themes.
 *
 * A picture from another site that does not allow reading cannot be looked
 * at (the browser refuses), and is then `null`: nothing is known.
 */
import type { Rect } from '../model/geometry';

const GRID = 24;

export interface PictureLook {
  /** It has see-through parts. */
  clear: boolean;
  /** Its own width over its height. */
  aspect: number;
  /** How light each cell of the grid is, 0 to 255 (relative luminance), row by row. A see-through cell counts as light: that is the ground it is given. */
  light: Uint8Array;
}

const LOOKS = new Map<string, PictureLook | null>();
/** How many pictures' looks are remembered. Past this the one looked at longest ago is forgotten, never all of them at once. */
const LOOKS_MAX = 2000;
/** Who is waiting to hear about which picture: only what lies over a picture hears that it has been looked at. */
const waiting = new Map<string, Set<() => void>>();
const fresh = new Set<string>();
let scheduled = false;

/** The looks that are known, and a way to hear when one picture's becomes known. */
export const pictureLooks = {
  /** Hear when `src` has been looked at. Nothing else hears it: a board of pictures with nothing lying on them tells no one. */
  subscribe(src: string, listener: () => void): () => void {
    let set = waiting.get(src);
    if (!set) waiting.set(src, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && waiting.get(src) === set) waiting.delete(src);
    };
  },
  get: (src: string): PictureLook | null | undefined => LOOKS.get(src),
};

/** Tell those waiting on the pictures looked at since the last frame, once, before the next one is drawn. */
function flush(): void {
  scheduled = false;
  const told = [...fresh];
  fresh.clear();
  for (const src of told) for (const listener of [...(waiting.get(src) ?? [])]) listener();
}

function tell(src: string): void {
  if (!waiting.has(src)) return;
  fresh.add(src);
  if (scheduled) return;
  scheduled = true;
  // Pictures finish loading one task each: gathered into one telling a frame, not one each.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else queueMicrotask(flush);
}

/** Remember a picture's look (what `lookAtPicture` does once it has looked). */
export function rememberLook(src: string, look: PictureLook | null): void {
  LOOKS.delete(src);
  LOOKS.set(src, look);
  if (LOOKS.size > LOOKS_MAX) LOOKS.delete(LOOKS.keys().next().value as string);
  tell(src);
}

/** sRGB channel (0 to 255) to linear light (0 to 1). */
const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** What a see-through part is taken to lie on: the light ground such a picture is given. */
const CLEAR_GROUND = 0.9;

/** The look of raw pixels (RGBA, `GRID` by `GRID`). Apart from the canvas, so it can be worked out anywhere. */
export function lookOfPixels(data: Uint8ClampedArray | readonly number[], aspect: number): PictureLook {
  const light = new Uint8Array(GRID * GRID);
  let clear = false;
  for (let cell = 0; cell < GRID * GRID; cell++) {
    const i = cell * 4;
    const alpha = (data[i + 3] ?? 255) / 255;
    if (alpha < 250 / 255) clear = true;
    const y = 0.2126 * linear(data[i] ?? 0) + 0.7152 * linear(data[i + 1] ?? 0) + 0.0722 * linear(data[i + 2] ?? 0);
    light[cell] = Math.round((y * alpha + CLEAR_GROUND * (1 - alpha)) * 255);
  }
  return { clear, aspect: aspect > 0 && Number.isFinite(aspect) ? aspect : 1, light };
}

/** Look at a loaded picture, once per address. Null when it cannot be read back. */
export function lookAtPicture(src: string, image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number }): PictureLook | null {
  if (LOOKS.has(src)) return LOOKS.get(src)!;
  let look: PictureLook | null = null;
  try {
    const probe = document.createElement('canvas');
    probe.width = probe.height = GRID;
    const context = probe.getContext('2d', { willReadFrequently: true });
    if (context) {
      context.drawImage(image, 0, 0, GRID, GRID);
      // A picture from another site cannot be read back (this throws), and is left as it is.
      look = lookOfPixels(context.getImageData(0, 0, GRID, GRID).data, (image.naturalWidth || 1) / (image.naturalHeight || 1));
    }
  } catch {
    look = null;
  }
  rememberLook(src, look);
  return look;
}

/** The ground a mark over a picture is read against: `picture` when the picture could not be looked at. */
export type Ground = 'light' | 'dark' | 'picture';

/**
 * Whether the part of a picture under `area` is light or dark. `box` is the
 * picture's object (the picture sits inside it whole, centred); both rects
 * are in board coordinates. Light means its relative luminance is above
 * 0.18, the same line the ink on a solid fill is chosen by: dark ink is read
 * on it at 4.5 to 1 or better, and light ink on the other side.
 */
export function groundUnder(look: PictureLook | null | undefined, box: Rect, area: Rect): Ground {
  if (!look) return 'picture';
  // Where the picture itself is drawn inside its box.
  const wide = box.w / Math.max(1, box.h) > look.aspect;
  const w = wide ? box.h * look.aspect : box.w;
  const h = wide ? box.h : box.w / look.aspect;
  const x = box.x + (box.w - w) / 2;
  const y = box.y + (box.h - h) / 2;
  // A box with no size, or a mark at no place, lands on the first cell: an answer, never not-a-number.
  const cell = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(GRID - 1, Math.floor(value * GRID))) : 0);
  const c0 = cell((area.x - x) / w);
  const c1 = cell((area.x + area.w - x) / w);
  const r0 = cell((area.y - y) / h);
  const r1 = cell((area.y + area.h - y) / h);
  let sum = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) sum += look.light[r * GRID + c];
  return sum / ((r1 - r0 + 1) * (c1 - c0 + 1)) / 255 > 0.18 ? 'light' : 'dark';
}
