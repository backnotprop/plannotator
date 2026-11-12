export interface NavLocation {
  path: string | null;
  line?: number;
  restoreView?: { path: string; view: 'changes' | 'whole' };
}

export interface NavHistory {
  back: readonly NavLocation[];
  forward: readonly NavLocation[];
}

export const EMPTY_NAV_HISTORY: NavHistory = { back: [], forward: [] };
export const MAX_NAV_HISTORY = 50;

export function sameNavLocation(a: NavLocation | null | undefined, b: NavLocation | null | undefined): boolean {
  if (!a || !b) return false;
  return a.path === b.path && (a.line ?? null) === (b.line ?? null) && !b.restoreView;
}

export function pushNavJump(history: NavHistory, from: NavLocation | null): NavHistory {
  if (!from) return { back: history.back, forward: [] };
  const last = history.back[history.back.length - 1];
  const back = sameNavLocation(last, from) ? history.back : [...history.back, from].slice(-MAX_NAV_HISTORY);
  return { back, forward: [] };
}

export function navigateBack(history: NavHistory, current: NavLocation | null): { target: NavLocation; history: NavHistory } | null {
  const target = history.back[history.back.length - 1];
  if (!target) return null;
  return {
    target,
    history: {
      back: history.back.slice(0, -1),
      forward: current ? [...history.forward, current].slice(-MAX_NAV_HISTORY) : history.forward,
    },
  };
}

export function navigateForward(history: NavHistory, current: NavLocation | null): { target: NavLocation; history: NavHistory } | null {
  const target = history.forward[history.forward.length - 1];
  if (!target) return null;
  return {
    target,
    history: {
      back: current ? [...history.back, current].slice(-MAX_NAV_HISTORY) : history.back,
      forward: history.forward.slice(0, -1),
    },
  };
}

export function pushRecentPath(recent: readonly string[], path: string, max = 20): string[] {
  return [path, ...recent.filter((entry) => entry !== path)].slice(0, max);
}

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

function lineHasSymbol(text: string, symbol: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(symbol, from);
    if (at === -1) return false;
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + symbol.length] ?? '';
    if (!IDENTIFIER_CHAR.test(before) && !IDENTIFIER_CHAR.test(after)) return true;
    from = at + 1;
  }
}

export function findSymbolLine(content: string, symbol: string | undefined, line: number, radius = 200): number | null {
  const lines = content.split('\n');
  if (!symbol) return line >= 1 && line <= lines.length ? line : null;
  const has = (n: number) => n >= 1 && n <= lines.length && lineHasSymbol(lines[n - 1], symbol);
  if (has(line)) return line;
  for (let step = 1; step <= radius; step += 1) {
    if (has(line - step)) return line - step;
    if (has(line + step)) return line + step;
  }
  return null;
}

export interface RevealTarget {
  path: string;
  line: number;
  symbol?: string;
  token: number;
}

export type JumpVia = 'definition' | 'references' | 'file';

export interface JumpCrumb {
  targetPath: string;
  from: NavLocation;
  via: JumpVia;
}

export function navLocationLabel(location: NavLocation): string {
  if (location.path == null) return 'All changes';
  const name = location.path.slice(location.path.lastIndexOf('/') + 1);
  return location.line ? `${name}:${location.line}` : name;
}
