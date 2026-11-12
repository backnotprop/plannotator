export const FULL_DEPTH_STATE = 'ibFullDepth';
export const FULL_SWITCH_STATE = 'ibFullSwitch';
export const FULL_SIDE_FROM_STATE = 'ibSideFrom';
export const FULL_OVER_STATE = 'ibFullOver';

export interface FullMark {
  depth: number;
  viaSwitch: boolean;
  sideFrom?: string;
  over?: string;
}

export function fullMark(state: unknown): FullMark | null {
  const record = state && typeof state === 'object' ? (state as Record<string, unknown>) : null;
  const depth = record?.[FULL_DEPTH_STATE];
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1) return null;
  const sideFrom = record![FULL_SIDE_FROM_STATE];
  const over = record![FULL_OVER_STATE];
  return {
    depth,
    viaSwitch: record![FULL_SWITCH_STATE] === true,
    ...(typeof sideFrom === 'string' ? { sideFrom } : {}),
    ...(typeof over === 'string' ? { over } : {}),
  };
}

function openedFrom(state: unknown): string | null {
  const from = state && typeof state === 'object' ? (state as Record<string, unknown>).ibFrom : undefined;
  return typeof from === 'string' ? from : null;
}

export function fullFromSide(state: unknown): boolean {
  return fullMark(state) !== null;
}

export function withFullMark(state: unknown, mark: FullMark | null): Record<string, unknown> {
  const base = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  delete base[FULL_DEPTH_STATE];
  delete base[FULL_SWITCH_STATE];
  delete base[FULL_SIDE_FROM_STATE];
  delete base[FULL_OVER_STATE];
  if (mark) {
    base[FULL_DEPTH_STATE] = mark.depth;
    if (mark.viaSwitch) base[FULL_SWITCH_STATE] = true;
    if (mark.sideFrom !== undefined) base[FULL_SIDE_FROM_STATE] = mark.sideFrom;
    if (mark.over !== undefined) base[FULL_OVER_STATE] = mark.over;
  }
  return base;
}

export function fullScreenExit(fromSide: boolean, locked: boolean): 'side' | 'close' {
  return !locked && fromSide ? 'side' : 'close';
}

export function fullExitFile(state: unknown): string | null {
  const mark = fullMark(state);
  if (!mark || mark.viaSwitch || mark.over === undefined) return null;
  return new URLSearchParams(mark.over.replace(/^#/, '')).get('file');
}

export type FrameMove = 'switch-full' | 'open-full' | 'exit-full' | 'show-side';

export interface EntryNow {
  hash: string;
  state: unknown;
}

export type EntryOp =
  | { kind: 'push'; hash: string; mark: FullMark | null }
  | { kind: 'replace'; hash: string; keep: true }
  | { kind: 'replace'; hash: string; keep: false; mark: null }
  | { kind: 'back'; steps: number; land: string | null };

function viewOf(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('view');
}

export function fileEntryOp(now: EntryNow, next: string, request: { move?: FrameMove; replace?: boolean } = {}): EntryOp {
  const mark = fullMark(now.state);
  switch (request.move) {
    case 'switch-full': {
      const sideFrom = openedFrom(now.state);
      return { kind: 'push', hash: next, mark: { depth: 1, viaSwitch: true, ...(sideFrom !== null ? { sideFrom } : {}) } };
    }
    case 'open-full':
      return { kind: 'push', hash: next, mark: { depth: 1, viaSwitch: false, over: now.hash } };
    case 'exit-full':
    case 'show-side':
      if (!mark) return { kind: 'replace', hash: next, keep: false, mark: null };
      return { kind: 'back', steps: mark.depth, land: request.move === 'show-side' || mark.viaSwitch ? next : null };
  }
  if (request.replace) return { kind: 'replace', hash: next, keep: true };
  return {
    kind: 'push',
    hash: next,
    mark: mark && viewOf(next) === 'full' ? { depth: mark.depth + 1, viaSwitch: mark.viaSwitch, ...(mark.over !== undefined ? { over: mark.over } : {}) } : null,
  };
}

export function pageBackPastSwitch(now: EntryNow, target: string, same: (from: string, hash: string) => boolean): boolean {
  const mark = fullMark(now.state);
  return mark !== null && mark.viaSwitch && mark.depth === 1 && mark.sideFrom !== undefined && same(mark.sideFrom, target);
}
