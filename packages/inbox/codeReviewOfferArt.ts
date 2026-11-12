const UV = { void: '#0F0D16', indigo: '#2A2262', violet: '#5038B0', lilac: '#A79AEC', bone: '#ECE7DC' };
const DX = { plus: '#2FD872', plusDeep: '#0E6E3B', minus: '#F2443B', minusDeep: '#8A1A26' };

export interface CodeReviewArtOptions {
  unit: number;
  seed: number;
  cx: number;
}

export const CODE_REVIEW_ART_STEPS = [0, 0.34, 0.67, 1] as const;
export const CODE_REVIEW_ART_BEAT_MS = 125;

function hash(...k: number[]): number {
  let h = 2166136261 >>> 0;
  for (const v of k) {
    h ^= Math.imul((v | 0) + 0x9e3779b9, 2654435761) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

function sign(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, kind: '+' | '-', color: string, k = 0.58, t = 0.17): void {
  const th = Math.max(2, Math.round(s * t));
  const len = Math.round(s * k);
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x + (s - len) / 2), Math.round(y + (s - th) / 2), len, th);
  if (kind === '+') ctx.fillRect(Math.round(x + (s - th) / 2), Math.round(y + (s - len) / 2), th, len);
}

function dither(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, px: number, a: string, b: string, seed: number, density = 0.55): void {
  for (let yy = 0; yy < h; yy += px) {
    for (let xx = 0; xx < w; xx += px) {
      const q = hash(seed, x + xx, y + yy);
      if (q > density) continue;
      ctx.fillStyle = q < density * 0.6 ? a : b;
      ctx.fillRect(x + xx, y + yy, px, px);
    }
  }
}

function signGrid(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, n: number, kind: '+' | '-', color: string): void {
  const c = s / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sign(ctx, x + i * c, y + j * c, c, kind, color);
}

function stormCell(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number, quiet: number): void {
  if (quiet && hash(seed + 13, x, y, s) < quiet) {
    ctx.fillStyle = UV.void;
    ctx.fillRect(x, y, s, s);
    return;
  }
  const q = hash(seed, x, y, s);
  const r = hash(seed + 7, y, x);
  const n = s >= 40 ? (r < 0.4 ? 1 : r < 0.8 ? 2 : 3) : s >= 20 ? (r < 0.6 ? 1 : 2) : 1;
  if (q < 0.15) {
    ctx.fillStyle = DX.plus;
    ctx.fillRect(x, y, s, s);
    signGrid(ctx, x, y, s, n, '+', UV.void);
  } else if (q < 0.27) {
    ctx.fillStyle = q < 0.21 ? DX.plusDeep : UV.void;
    ctx.fillRect(x, y, s, s);
    signGrid(ctx, x, y, s, n, '+', DX.plus);
  } else if (q < 0.35) {
    ctx.fillStyle = DX.minus;
    ctx.fillRect(x, y, s, s);
    signGrid(ctx, x, y, s, Math.min(n, 2), '-', UV.void);
  } else if (q < 0.42) {
    ctx.fillStyle = DX.minusDeep;
    ctx.fillRect(x, y, s, s);
    if (r < 0.5) signGrid(ctx, x, y, s, n, '-', DX.minus);
    else dither(ctx, x, y, s, s, Math.max(2, (s / 12) | 0), DX.minus, UV.void, seed + 3);
  } else if (q < 0.68) {
    ctx.fillStyle = r < 0.5 ? UV.indigo : UV.void;
    ctx.fillRect(x, y, s, s);
    dither(ctx, x, y, s, s, Math.max(2, (s / 14) | 0), UV.lilac, UV.violet, seed + 5, 0.5);
  } else if (q < 0.8) {
    ctx.fillStyle = r < 0.55 ? UV.violet : UV.indigo;
    ctx.fillRect(x, y, s, s);
  } else {
    ctx.fillStyle = UV.void;
    ctx.fillRect(x, y, s, s);
    if (r < 0.25) sign(ctx, x, y, s, r < 0.15 ? '+' : '-', r < 0.15 ? DX.plus : DX.minus, 0.4, 0.12);
  }
}

function quad(x: number, y: number, w: number, h: number, block: number, unit: number, seed: number, leaf: (x: number, y: number, s: number) => void): void {
  const rec = (cx: number, cy: number, s: number) => {
    if (s > unit && hash(seed + 11, cx, cy, s) < 0.58) {
      const t = s / 2;
      rec(cx, cy, t);
      rec(cx + t, cy, t);
      rec(cx, cy + t, t);
      rec(cx + t, cy + t, t);
    } else leaf(cx, cy, s);
  };
  for (let yy = y; yy < y + h; yy += block) for (let xx = x; xx < x + w; xx += block) rec(xx, yy, block);
}

function setup(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const box = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return { ctx, w, h };
}

export function drawCodeReviewArt(canvas: HTMLCanvasElement, f: number, o: CodeReviewArtOptions): void {
  const drawn = setup(canvas);
  if (!drawn) return;
  const { ctx, w, h } = drawn;
  const { unit, seed } = o;
  const block = unit * 4;
  ctx.fillStyle = UV.void;
  ctx.fillRect(0, 0, w, h);
  const colCells = 3;
  const sq = unit * 1.5;
  const cw = colCells * sq;
  const cx = Math.round(o.cx * w - cw / 2);
  const hole = cw + block * (0.8 + 2.2 * f);
  quad(0, 0, Math.ceil(w / block) * block, Math.ceil(h / block) * block, block, unit, seed, (x, y, s) => {
    const mid = x + s / 2;
    const jag = hash(seed + 3, x, y) * block * 0.9;
    const d = Math.abs(mid - (cx + cw / 2)) - (hole / 2 + jag * (1 - f) - jag * 0.2);
    if (d < 0) return;
    stormCell(ctx, x, y, s, seed, Math.max(0, 0.55 - d / (block * 4)));
  });
  const rows = Math.ceil(h / sq) + 1;
  const plusRows = Math.round(rows * 0.66);
  const filled = Math.round(rows * (0.35 + 0.65 * f));
  const gap = Math.max(2, Math.round(sq * 0.08));
  for (let r = 0; r < Math.min(rows, filled); r++) {
    for (let c = 0; c < colCells; c++) {
      const plus = r < plusRows;
      const px = cx + c * sq;
      const py = r * sq;
      ctx.fillStyle = plus ? DX.plus : DX.minus;
      ctx.fillRect(px, py, sq - gap, sq - gap);
      sign(ctx, px, py, sq - gap, plus ? '+' : '-', UV.void, 0.5, 0.16);
    }
  }
  if (f >= 0.66) {
    ctx.fillStyle = UV.bone;
    ctx.fillRect(cx + cw + Math.round(unit * 0.8), Math.round(h * 0.5 - unit), Math.round(unit * 0.9), Math.round(unit * 1.6));
  }
}

export function playCodeReviewArt(canvas: HTMLCanvasElement, o: CodeReviewArtOptions, still: boolean): () => void {
  const steps = still ? [1] : CODE_REVIEW_ART_STEPS;
  const timers: ReturnType<typeof setTimeout>[] = [];
  steps.forEach((f, i) => timers.push(setTimeout(() => drawCodeReviewArt(canvas, f, o), i * CODE_REVIEW_ART_BEAT_MS)));
  let resize: ReturnType<typeof setTimeout> | undefined;
  let first = true;
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (first) {
            first = false;
            return;
          }
          clearTimeout(resize);
          resize = setTimeout(() => drawCodeReviewArt(canvas, 1, o), 60);
        })
      : null;
  observer?.observe(canvas);
  return () => {
    timers.forEach(clearTimeout);
    clearTimeout(resize);
    observer?.disconnect();
  };
}
