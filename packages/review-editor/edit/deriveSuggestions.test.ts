import { describe, expect, test } from 'bun:test';
import { deriveSuggestionHunks } from './deriveSuggestions';

const FILE = [
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export function subtract(a: number, b: number): number {',
  '  return a - b;',
  '}',
].join('\n');

describe('deriveSuggestionHunks', () => {
  test('no-op edit produces no hunks', () => {
    expect(deriveSuggestionHunks(FILE, FILE)).toEqual([]);
  });

  test('single modified line produces one hunk anchored to that line', () => {
    const edited = FILE.replace('return a + b;', 'return b + a;');
    const hunks = deriveSuggestionHunks(FILE, edited);
    expect(hunks).toEqual([
      {
        lineStart: 2,
        lineEnd: 2,
        originalCode: '  return a + b;',
        suggestedCode: '  return b + a;',
      },
    ]);
  });

  test('two separate edits produce two hunks', () => {
    const edited = FILE.replace('return a + b;', 'return b + a;').replace(
      'return a - b;',
      'return -(b - a);',
    );
    const hunks = deriveSuggestionHunks(FILE, edited);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ lineStart: 2, lineEnd: 2, suggestedCode: '  return b + a;' });
    expect(hunks[1]).toMatchObject({ lineStart: 6, lineEnd: 6, suggestedCode: '  return -(b - a);' });
  });

  test('multi-line replacement groups into one modified hunk', () => {
    const edited = FILE.replace(
      '  return a + b;\n}',
      '  const sum = a + b;\n  return sum;\n}',
    );
    const hunks = deriveSuggestionHunks(FILE, edited);
    expect(hunks).toEqual([
      {
        lineStart: 2,
        lineEnd: 2,
        originalCode: '  return a + b;',
        suggestedCode: '  const sum = a + b;\n  return sum;',
      },
    ]);
  });

  test('pure insertion anchors to the preceding line', () => {
    const edited = FILE.replace('  return a + b;', '  return a + b;\n  // done');
    const hunks = deriveSuggestionHunks(FILE, edited);
    expect(hunks).toEqual([
      {
        lineStart: 2,
        lineEnd: 2,
        originalCode: '  return a + b;',
        suggestedCode: '  return a + b;\n  // done',
      },
    ]);
  });

  test('insertion at file start anchors to the first line', () => {
    const edited = `// header\n${FILE}`;
    const hunks = deriveSuggestionHunks(FILE, edited);
    expect(hunks).toEqual([
      {
        lineStart: 1,
        lineEnd: 1,
        originalCode: 'export function add(a: number, b: number): number {',
        suggestedCode: '// header\nexport function add(a: number, b: number): number {',
      },
    ]);
  });

  test('pure deletion keeps the preceding line so suggestedCode is non-empty', () => {
    const edited = FILE.replace('  return a - b;\n', '');
    const hunks = deriveSuggestionHunks(FILE, edited);
    expect(hunks).toEqual([
      {
        lineStart: 5,
        lineEnd: 6,
        originalCode: 'export function subtract(a: number, b: number): number {\n  return a - b;',
        suggestedCode: 'export function subtract(a: number, b: number): number {',
      },
    ]);
  });

  test('deletion of the first line anchors to the following line', () => {
    const lines = FILE.split('\n');
    const edited = lines.slice(1).join('\n');
    const hunks = deriveSuggestionHunks(FILE, edited);
    expect(hunks).toEqual([
      {
        lineStart: 1,
        lineEnd: 2,
        originalCode: 'export function add(a: number, b: number): number {\n  return a + b;',
        suggestedCode: '  return a + b;',
      },
    ]);
  });

  test('emptying the whole file yields empty suggestedCode', () => {
    const hunks = deriveSuggestionHunks('one\ntwo\n', '');
    expect(hunks).toEqual([
      { lineStart: 1, lineEnd: 2, originalCode: 'one\ntwo', suggestedCode: '' },
    ]);
  });

  test('CRLF content diffs against LF edits without phantom changes', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    expect(deriveSuggestionHunks(crlf, FILE)).toEqual([]);
    const edited = FILE.replace('return a + b;', 'return b + a;');
    const hunks = deriveSuggestionHunks(crlf, edited);
    expect(hunks).toEqual([
      {
        lineStart: 2,
        lineEnd: 2,
        originalCode: '  return a + b;',
        suggestedCode: '  return b + a;',
      },
    ]);
  });

  test('trailing-newline-only difference is not a phantom hunk on untouched lines', () => {
    const hunks = deriveSuggestionHunks(`${FILE}\n`, FILE);
    // The last line loses its newline; diffLines reports the final line changed.
    // Whatever the diff engine reports must stay anchored to the final line only.
    for (const hunk of hunks) {
      expect(hunk.lineStart).toBeGreaterThanOrEqual(7);
    }
  });

  test('edit into an empty file produces an unanchored insertion hunk', () => {
    const hunks = deriveSuggestionHunks('', 'hello\n');
    expect(hunks).toEqual([
      { lineStart: 1, lineEnd: 1, originalCode: '', suggestedCode: 'hello' },
    ]);
  });
});
