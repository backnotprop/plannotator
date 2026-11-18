import type { CodeNavLocation } from '@plannotator/shared/code-nav';

/**
 * The one definition a jump goes to (F12, and a Cmd/Ctrl-click on a token):
 * the definitions told apart by file and line, when exactly one is left. With
 * `from` (a click), a definition at the clicked line is the token itself, so
 * there is nowhere to jump: null, and the click opens References instead.
 */
export function oneDefinition(definitions: readonly CodeNavLocation[], from?: { filePath: string; line: number }): CodeNavLocation | null {
  const distinct = [...new Map(definitions.map((d) => [`${d.filePath}:${d.line}`, d])).values()];
  if (distinct.length !== 1) return null;
  const only = distinct[0]!;
  return from && only.filePath === from.filePath && only.line === from.line ? null : only;
}

/**
 * Which code-nav jump may still land. Each lookup takes a number (`next`); a
 * newer lookup, or any click or key the person makes while it waits
 * (`cancel`), makes an older number stale, so a late answer never moves them.
 */
export function createJumpGate() {
  let seq = 0;
  return {
    next: (): number => ++seq,
    cancel: (): void => {
      seq++;
    },
    live: (ticket: number): boolean => ticket === seq,
  };
}

/** What a Cmd/Ctrl-click waiting on References' own lookup does once that lookup has an answer. */
export type ClickJumpStep =
  | { kind: 'wait' }
  | { kind: 'drop' }
  | { kind: 'stay' }
  | { kind: 'jump'; to: CodeNavLocation };

/**
 * A click opens References at once (its loading state) and waits on that
 * lookup, never a second one: still loading, wait; a stale ticket or another
 * symbol's answer, drop it; exactly one definition elsewhere, jump (and the
 * References opened for the click close); otherwise References stay, loaded.
 */
export function clickJumpStep(input: {
  live: boolean;
  isLoading: boolean;
  activeSymbol: string | null;
  definitions: readonly CodeNavLocation[] | null;
  request: { symbol: string; filePath: string; line: number };
}): ClickJumpStep {
  if (!input.live || input.activeSymbol !== input.request.symbol) return { kind: 'drop' };
  if (input.isLoading) return { kind: 'wait' };
  const only = oneDefinition(input.definitions ?? [], input.request);
  return only ? { kind: 'jump', to: only } : { kind: 'stay' };
}
