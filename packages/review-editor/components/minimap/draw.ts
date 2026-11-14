import { coverageKey, type Coverage, type MinimapKind } from './scene';

export interface MinimapColors {
  add: string;
  del: string;
  mark: string;
  line: string;
  other: string;
}

type Lane = 'del' | 'add' | 'mark' | 'edge' | 'semantic';

const KIND_STYLE: Record<string, { lane: Lane; color: keyof MinimapColors }> = {
  del: { lane: 'del', color: 'del' },
  add: { lane: 'add', color: 'add' },
  comment: { lane: 'mark', color: 'mark' },
  thread: { lane: 'edge', color: 'mark' },
  moved: { lane: 'semantic', color: 'other' },
  renamed: { lane: 'semantic', color: 'other' },
  reformatted: { lane: 'semantic', color: 'other' },
};

const LANES: Record<Exclude<Lane, 'mark'>, [number, number]> = {
  semantic: [0, 2],
  del: [3, 3],
  add: [7, 3],
  edge: [10, 2],
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

export const FLOOR_ALPHA = 0.14;
export const CEILING_ALPHA = 0.85;
const DIM = 0.4;
const STEPS = 24;

function laneBox(lane: Exclude<Lane, 'mark'>, dpr: number): [number, number] {
  const [left, width] = LANES[lane];
  return [Math.round(left * dpr), Math.max(1, Math.round(width * dpr))];
}

export function densityAlpha(value: number): number {
  if (value <= 0.002) return 0;
  return FLOOR_ALPHA + (CEILING_ALPHA - FLOOR_ALPHA) * Math.pow(Math.min(1, value), 0.75);
}

function alphaColumn(column: Float32Array): Float32Array {
  const out = new Float32Array(column.length);
  for (let i = 0; i < column.length; i++) out[i] = densityAlpha(column[i]);
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
  const gap = Math.round(6 * dpr);
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
        const [x, w] = laneBox(style.lane, dpr);
        if (style.lane === 'add' || style.lane === 'del') fillColumn(ctx, alphaColumn(column), x, w, scale);
        else fillColumn(ctx, column.map((v) => (v > 0 ? 0.9 : 0)), x, w, scale);
      }
    }
  }
  ctx.globalAlpha = 1;
}
