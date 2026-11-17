/**
 * The dithered field behind Plans' get-started screen (approval "inbox-plans": the get-started screen over the
 * dithered field). The recipe is the backdrop study's ordered dither: an 8x8 Bayer matrix over value noise (the
 * "drift" field), drawn in the theme's own ink (`--muted-foreground`), with a clear room around the words so no dot
 * sits under them.
 *
 * Motion is the "click": the field settles in 10 frames from coarse cells to fine, 12 a second, then stays still.
 * Under reduced motion, or while the window is hidden, only the still frame is drawn. It draws again (still) when the
 * theme or the size changes. Decoration only: the canvas is aria-hidden.
 *
 * The Spaces home's field is the approved home-5's own (`startStillField`): six soft blobs over the same 8x8 Bayer
 * matrix, in 3 px dots, still from the first frame (it never moves, so reduced motion changes nothing).
 */

const BAYER = (() => {
  let m: number[][] = [[0]];
  for (let n = 1; n < 8; n *= 2) {
    const o: number[][] = [];
    for (let y = 0; y < 2 * n; y++) {
      o[y] = [];
      for (let x = 0; x < 2 * n; x++) o[y]![x] = m[y % n]![x % n]! * 4 + [[0, 2], [3, 1]][Math.floor(y / n)]![Math.floor(x / n)]!;
    }
    m = o;
  }
  return Float32Array.from(m.flat().map((v) => (v + 0.5) / 64));
})();

const PERM = (() => {
  const perm = new Uint8Array(512);
  let s = 1337;
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  return perm;
})();
const VAL = Float32Array.from({ length: 256 }, (_, i) => PERM[(i * 7) & 255]! / 255);

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = PERM[(xi & 255) + PERM[yi & 255]!]!;
  const b = PERM[((xi + 1) & 255) + PERM[yi & 255]!]!;
  const c = PERM[(xi & 255) + PERM[(yi + 1) & 255]!]!;
  const d = PERM[((xi + 1) & 255) + PERM[(yi + 1) & 255]!]!;
  const x1 = VAL[a]! + (VAL[b]! - VAL[a]!) * u;
  const x2 = VAL[c]! + (VAL[d]! - VAL[c]!) * u;
  return x1 + (x2 - x1) * v;
}

/** The settle: cell sizes in px, coarse to fine; the last is the still frame. */
export const DITHER_STEPS = [12, 10, 8, 7, 6, 5, 4, 3, 3, 2] as const;
const STILL_CELL = 2;
const FRAME_MS = 1000 / 12;
const RECIPE = { density: 0.62, alphaLight: 0.26, alphaDark: 0.32, t: 31, pad: [56, 44] as const };

/** A CSS colour as [r, g, b], read by painting one pixel (oklch and color-mix included). */
function inkOf(host: HTMLElement): [number, number, number] {
  const probe = document.createElement('span');
  probe.style.color = 'var(--muted-foreground)';
  host.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [128, 128, 128];
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const p = ctx.getImageData(0, 0, 1, 1).data;
  return [p[0]!, p[1]!, p[2]!];
}

const isLight = () => document.documentElement.classList.contains('light');

function draw(host: HTMLElement, canvas: HTMLCanvasElement, rooms: readonly HTMLElement[], cell: number): void {
  const r = host.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const W = Math.ceil(r.width / cell);
  const H = Math.ceil(r.height / cell);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(W, H);
  const buf = new Uint32Array(img.data.buffer);
  const [ir, ig, ib] = inkOf(host);
  const alpha = Math.round(255 * (isLight() ? RECIPE.alphaLight : RECIPE.alphaDark));
  const px = ((alpha << 24) | (ib << 16) | (ig << 8) | ir) >>> 0;
  const clear = rooms.map((el) => {
    const b = el.getBoundingClientRect();
    return { cx: (b.left + b.width / 2 - r.left) / cell, cy: (b.top + b.height / 2 - r.top) / cell, rx: (b.width / 2 + RECIPE.pad[0]) / cell, ry: (b.height / 2 + RECIPE.pad[1]) / cell };
  });
  const s = ((1 / 64) * cell) / 2;
  const t = RECIPE.t;
  for (let y = 0; y < H; y++) {
    const row = (y & 7) * 8;
    const yy = y / H;
    for (let x = 0; x < W; x++) {
      let m = 1;
      for (const k of clear) {
        const dx = (x - k.cx) / k.rx;
        const dy = (y - k.cy) / k.ry;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          m = 0;
          break;
        }
        if (d2 < 2.2) m = Math.min(m, (Math.sqrt(d2) - 1) / 0.48);
      }
      if (m <= 0) continue;
      const n = (0.64 * vnoise(x * s + t * 0.021, y * s - t * 0.013) + 0.36 * vnoise(x * s * 2.1 - t * 0.017 + 50, y * s * 2.1 + t * 0.009 + 20)) * (0.55 + 0.6 * yy);
      let f = (n - 0.3) / 0.62;
      if (f <= 0) continue;
      f = f > 1 ? 1 : f * f * (3 - 2 * f);
      if (f * m * RECIPE.density > BAYER[row + (x & 7)]!) buf[y * W + x] = px;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** home-5's blobs (x, y, radius, in the field's width) and its home hearth's strength (`data-k`). */
export const STILL_FIELD = {
  cell: 3,
  k: 0.34,
  alphaLight: 0.22,
  alphaDark: 0.26,
  blobs: [
    [0.18, 0.2, 0.22],
    [0.7, 0.18, 0.2],
    [0.88, 0.62, 0.26],
    [0.3, 0.82, 0.28],
    [0.55, 0.95, 0.2],
    [0.05, 0.6, 0.18],
  ] as readonly (readonly [number, number, number])[],
} as const;

/** home-5's Bayer order, as its `drawDither` lists it. */
const HOME_BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];

/**
 * Which cells of a `w` x `h` field home-5's `drawDither` fills, as written: each blob adds a cone (1 at its centre, 0
 * at its radius; the radius is in the field's width, so it stays round), the sum times `k`, capped at 1, against the
 * Bayer threshold. Exported for the test that holds its coverage.
 */
export function stillFieldCells(w: number, h: number, k: number = STILL_FIELD.k): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let v = 0;
      for (const [bx, by, br] of STILL_FIELD.blobs) {
        const dx = i / w - bx;
        const dy = (j / h - by) * (h / w);
        v += Math.max(0, 1 - Math.hypot(dx, dy) / br);
      }
      v = Math.min(1, v * k);
      if (v * 64 > HOME_BAYER[(j % 8) * 8 + (i % 8)]!) out[j * w + i] = 1;
    }
  }
  return out;
}

function drawStill(host: HTMLElement, canvas: HTMLCanvasElement): void {
  const r = host.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const w = Math.ceil(r.width / STILL_FIELD.cell);
  const h = Math.ceil(r.height / STILL_FIELD.cell);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);
  const [ir, ig, ib] = inkOf(host);
  const alpha = Math.round(255 * (isLight() ? STILL_FIELD.alphaLight : STILL_FIELD.alphaDark));
  const px = ((alpha << 24) | (ib << 16) | (ig << 8) | ir) >>> 0;
  const cells = stillFieldCells(w, h);
  for (let n = 0; n < cells.length; n++) if (cells[n]) buf[n] = px;
  ctx.putImageData(img, 0, 0);
}

/** home-5's still field into `canvas`, filling `host`; drawn again when the size or the theme changes. Returns the stop. */
export function startStillField(host: HTMLElement, canvas: HTMLCanvasElement): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const still = () => drawStill(host, canvas);
  still();
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(still, 80);
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(later) : null;
  resize?.observe(host);
  const theme = typeof MutationObserver === 'function' ? new MutationObserver(later) : null;
  theme?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  return () => {
    if (timer) clearTimeout(timer);
    resize?.disconnect();
    theme?.disconnect();
  };
}

export function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Draw the field into `canvas`, filling `host`, clear around `rooms`. Returns the stop. `still` (reduced motion, a
 * hidden window): the still frame only.
 */
export function startPlansDither(host: HTMLElement, canvas: HTMLCanvasElement, rooms: () => readonly HTMLElement[]): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame = 0;
  let stopped = false;
  const still = () => {
    if (!stopped) draw(host, canvas, rooms(), STILL_CELL);
  };
  if (reducedMotion() || document.visibilityState === 'hidden') still();
  else {
    let i = 0;
    const tick = () => {
      if (stopped) return;
      if (i >= DITHER_STEPS.length || document.visibilityState === 'hidden') return still();
      draw(host, canvas, rooms(), DITHER_STEPS[i]!);
      i++;
      timer = setTimeout(() => {
        frame = requestAnimationFrame(tick);
      }, FRAME_MS);
    };
    tick();
  }
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(still, 80);
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(later) : null;
  resize?.observe(host);
  // The theme lives on the root's class and style (ThemeProvider): light, dark or a palette change draws again.
  const theme = typeof MutationObserver === 'function' ? new MutationObserver(later) : null;
  theme?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (resizeTimer) clearTimeout(resizeTimer);
    cancelAnimationFrame(frame);
    resize?.disconnect();
    theme?.disconnect();
  };
}
