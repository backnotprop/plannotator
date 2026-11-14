import { coverageKey, type Coverage, type MinimapKind } from './scene';

export interface MinimapColors {
  add: string;
  del: string;
  mark: string;
  line: string;
  other: string;
}

type Lane = 'del' | 'add' | 'mark';

const KIND_STYLE: Record<string, { lane: Lane; color: keyof MinimapColors }> = {
  del: { lane: 'del', color: 'del' },
  add: { lane: 'add', color: 'add' },
  comment: { lane: 'mark', color: 'mark' },
};

const TOKENS: Record<keyof MinimapColors, string> = {
  add: '--success',
  del: '--destructive',
  mark: '--primary',
  line: '--border',
  other: '--muted-foreground',
};

export function resolveMinimapColors(probe: HTMLElement): MinimapColors {
  const out = {} as MinimapColors;
  for (const [key, token] of Object.entries(TOKENS) as [keyof MinimapColors, string][]) {
    probe.style.color = `var(${token})`;
    out[key] = getComputedStyle(probe).color;
  }
  probe.style.color = '';
  return out;
}

export interface MinimapDrawInput {
  width: number;
  height: number;
  dpr: number;
  coverage: Coverage;
  boundaries: readonly number[];
  colors: MinimapColors;
}

const MIN_ALPHA = 0.3;
const MAX_ALPHA = 0.62;
const DIM = 0.4;
const STEPS = 24;

function laneBox(lane: Lane, dpr: number, width: number): [number, number] {
  if (lane === 'mark') return [0, width];
  const left = Math.round((lane === 'del' ? 2 : 7) * dpr);
  return [left, Math.round(3 * dpr)];
}

function alphaColumn(column: Float32Array): Float32Array {
  const out = new Float32Array(column.length);
  for (let i = 0; i < column.length; i++) {
    const own = column[i] > 0 ? MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * Math.min(1, column[i]) : 0;
    const above = i > 0 && column[i - 1] > 0 ? MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * Math.min(1, column[i - 1]) : 0;
    out[i] = Math.max(own, above);
  }
  return out;
}

function fillColumn(ctx: CanvasRenderingContext2D, alpha: Float32Array, x: number, w: number, scale: number) {
  let start = 0;
  let current = 0;
  const flush = (end: number) => {
    if (current > 0 && end > start) {
      ctx.globalAlpha = (current / STEPS) * scale;
      ctx.fillRect(x, start, w, end - start);
    }
  };
  for (let i = 0; i <= alpha.length; i++) {
    const q = i < alpha.length ? Math.round(alpha[i] * STEPS) : -1;
    if (q !== current) {
      flush(i);
      start = i;
      current = q;
    }
  }
}

function fillMarks(ctx: CanvasRenderingContext2D, column: Float32Array, width: number, minHeight: number, scale: number) {
  ctx.globalAlpha = scale;
  let i = 0;
  while (i < column.length) {
    if (column[i] <= 0) {
      i++;
      continue;
    }
    const start = i;
    while (i < column.length && column[i] > 0) i++;
    const height = Math.max(minHeight, i - start);
    ctx.fillRect(0, Math.min(start, column.length - height), width, height);
  }
}

export function drawMinimap(ctx: CanvasRenderingContext2D, input: MinimapDrawInput) {
  const { width, height, dpr, coverage, boundaries, colors } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = colors.line;
  const gap = Math.round(3 * dpr);
  let last = -Infinity;
  for (const y of boundaries) {
    const row = Math.floor(y);
    if (row - last < gap) continue;
    last = row;
    ctx.fillRect(0, row, width, Math.max(1, Math.round(dpr / 2)));
  }

  const kinds = new Set<MinimapKind>();
  for (const key of coverage.keys()) kinds.add(key.replace(/:dim$/, ''));
  const ordered = [...kinds].sort((a, b) => (KIND_STYLE[a]?.lane === 'mark' ? 1 : 0) - (KIND_STYLE[b]?.lane === 'mark' ? 1 : 0));
  for (const kind of ordered) {
    const style = KIND_STYLE[kind] ?? { lane: 'mark' as const, color: 'other' as const };
    ctx.fillStyle = colors[style.color];
    for (const dim of [true, false]) {
      const column = coverage.get(coverageKey(kind, dim));
      if (!column) continue;
      const scale = dim ? DIM : 1;
      if (style.lane === 'mark') {
        fillMarks(ctx, column, width, Math.round(2 * dpr), dim ? DIM : 0.95);
      } else {
        const [x, w] = laneBox(style.lane, dpr, width);
        fillColumn(ctx, alphaColumn(column), x, w, scale);
      }
    }
  }
  ctx.globalAlpha = 1;
}
