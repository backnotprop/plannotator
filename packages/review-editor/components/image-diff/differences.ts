import { unionCanvas, type Size } from './geometry';

export const DIFFERENCE_MAX_SIDE = 1024;
export const DIFFERENCE_THRESHOLD = 16;

export interface DifferenceMask {
  mask: ImageBitmap;
  width: number;
  height: number;
  changed: number;
  total: number;
}

function workerMain(): void {
  self.onmessage = async (event: MessageEvent) => {
    const { id, a, b, width, height, threshold } = event.data as {
      id: number;
      a: ImageBitmap | null;
      b: ImageBitmap | null;
      width: number;
      height: number;
      threshold: number;
    };
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const read = (bitmap: ImageBitmap | null) => {
      ctx.clearRect(0, 0, width, height);
      if (bitmap) ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, width, height).data;
    };
    const da = read(a);
    const db = read(b);
    const out = new ImageData(width, height);
    let changed = 0;
    for (let i = 0; i < da.length; i += 4) {
      const delta = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]));
      if (delta > threshold) {
        out.data[i] = 255;
        out.data[i + 1] = 255;
        out.data[i + 2] = 255;
        out.data[i + 3] = 255;
        changed += 1;
      }
    }
    const mask = await createImageBitmap(out);
    (self as unknown as Worker).postMessage({ id, mask, changed }, [mask]);
  };
}

export function differencesSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (result: { mask: ImageBitmap; changed: number }) => void>();

function getWorker(): Worker {
  if (!worker) {
    const source = `(${workerMain.toString()})()`;
    worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    worker.onmessage = (event: MessageEvent<{ id: number; mask: ImageBitmap; changed: number }>) => {
      pending.get(event.data.id)?.(event.data);
      pending.delete(event.data.id);
    };
  }
  return worker;
}

export function differenceScale(canvas: Size): number {
  const side = Math.max(canvas.width, canvas.height);
  return side > DIFFERENCE_MAX_SIDE ? DIFFERENCE_MAX_SIDE / side : 1;
}

const cache = new Map<string, Promise<DifferenceMask | null>>();

async function bitmapOf(url: string, size: Size, scale: number): Promise<ImageBitmap> {
  const blob = await (await fetch(url)).blob();
  const resizeWidth = Math.max(1, Math.round(size.width * scale));
  const resizeHeight = Math.max(1, Math.round(size.height * scale));
  return createImageBitmap(blob, scale < 1 ? { resizeWidth, resizeHeight, resizeQuality: 'medium' } : {});
}

export function computeDifferences(key: string, old: { url: string; size: Size }, next: { url: string; size: Size }): Promise<DifferenceMask | null> {
  const cached = cache.get(key);
  if (cached) return cached;
  const task = (async () => {
    if (!differencesSupported()) return null;
    const canvas = unionCanvas(old.size, next.size);
    const scale = differenceScale(canvas);
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    const [a, b] = await Promise.all([bitmapOf(old.url, old.size, scale), bitmapOf(next.url, next.size, scale)]);
    const id = (nextId += 1);
    const result = await new Promise<{ mask: ImageBitmap; changed: number }>((resolve) => {
      pending.set(id, resolve);
      getWorker().postMessage({ id, a, b, width, height, threshold: DIFFERENCE_THRESHOLD }, [a, b]);
    });
    return { mask: result.mask, width, height, changed: result.changed, total: width * height };
  })().catch(() => null);
  cache.set(key, task);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return task;
}
