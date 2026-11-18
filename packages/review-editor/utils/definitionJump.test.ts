/**
 * Cmd/Ctrl-click on a token jumps straight to the definition when there is exactly one, as F12 does; a click on
 * the definition itself opens References.
 *
 * What regresses if this fails: a Cmd-click always opens the References panel even with one clear definition, or a
 * Cmd-click on the definition jumps to itself.
 */
import { describe, expect, test } from 'bun:test';
import type { CodeNavLocation } from '@plannotator/shared/code-nav';
import { oneDefinition } from './definitionJump';

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
