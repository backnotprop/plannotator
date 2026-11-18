/**
 * Cmd/Ctrl-click on a token jumps straight to the definition when there is exactly one, as F12 does; a click on
 * the definition itself opens References.
 *
 * What regresses if this fails: a Cmd-click always opens the References panel even with one clear definition, a
 * Cmd-click on the definition jumps to itself, or a slow lookup's late answer moves the person after they clicked
 * elsewhere or clicked again.
 */
import { describe, expect, test } from 'bun:test';
import type { CodeNavLocation } from '@plannotator/shared/code-nav';
import { clickJumpStep, createJumpGate, oneDefinition } from './definitionJump';

const def = (filePath: string, line: number, column = 1): CodeNavLocation => ({ kind: 'definition', confidence: 'likely', filePath, line, column, snippet: '' });

describe('oneDefinition', () => {
  test('exactly one, told apart by file and line', () => {
    expect(oneDefinition([def('a.ts', 3)])).toEqual(def('a.ts', 3));
    expect(oneDefinition([def('a.ts', 3, 1), def('a.ts', 3, 9)])).toMatchObject({ filePath: 'a.ts', line: 3 });
    expect(oneDefinition([def('a.ts', 3), def('b.ts', 3)])).toBeNull();
    expect(oneDefinition([])).toBeNull();
  });

  test('a click on the definition itself has nowhere to jump; F12 (no origin) keeps today\'s rule', () => {
    expect(oneDefinition([def('a.ts', 3)], { filePath: 'a.ts', line: 3 })).toBeNull();
    expect(oneDefinition([def('a.ts', 3)], { filePath: 'b.ts', line: 10 })).toEqual(def('a.ts', 3));
  });
});

describe('a late answer never moves the person', () => {
  test('a newer lookup, or a click or key meanwhile, makes the older ticket stale', () => {
    const gate = createJumpGate();
    const first = gate.next();
    expect(gate.live(first)).toBe(true);
    const second = gate.next();
    expect(gate.live(first)).toBe(false);
    expect(gate.live(second)).toBe(true);
    gate.cancel();
    expect(gate.live(second)).toBe(false);
  });

  test("a click waits on References' own lookup: one definition elsewhere jumps, several stay listed, a stale one drops", () => {
    const request = { symbol: 'save', filePath: 'b.ts', line: 10 };
    const base = { live: true, isLoading: false, activeSymbol: 'save', definitions: [def('a.ts', 3)], request };
    expect(clickJumpStep({ ...base, isLoading: true, definitions: null })).toEqual({ kind: 'wait' });
    expect(clickJumpStep(base)).toEqual({ kind: 'jump', to: def('a.ts', 3) });
    expect(clickJumpStep({ ...base, definitions: [def('a.ts', 3), def('c.ts', 8)] })).toEqual({ kind: 'stay' });
    expect(clickJumpStep({ ...base, definitions: [def('b.ts', 10)] })).toEqual({ kind: 'stay' });
    expect(clickJumpStep({ ...base, definitions: null })).toEqual({ kind: 'stay' });
    // The person clicked elsewhere or again: the answer, late or not, jumps nowhere.
    expect(clickJumpStep({ ...base, live: false })).toEqual({ kind: 'drop' });
    expect(clickJumpStep({ ...base, activeSymbol: 'load' })).toEqual({ kind: 'drop' });
  });
});
