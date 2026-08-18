import { describe, expect, test } from 'bun:test';
import { deriveSuggestionHunks, type SuggestionHunk } from './deriveSuggestions';

/** Assert the non-overlap invariant: hunks ascend and never share a line. */
function expectDisjoint(hunks: SuggestionHunk[]): void {
  for (let i = 1; i < hunks.length; i++) {
    expect(hunks[i].lineStart).toBeGreaterThan(hunks[i - 1].lineEnd);
  }
  for (const hunk of hunks) {
    expect(hunk.lineEnd).toBeGreaterThanOrEqual(hunk.lineStart);
  }
}

function splitContentLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Apply hunks the way an agent would: sequentially against original line
 * numbers, tracking the running insert/delete offset. */
function applyHunks(before: string, hunks: SuggestionHunk[]): string {
  const lines = splitContentLines(before);
  let offset = 0;
  for (const hunk of hunks) {
    const replacement = splitContentLines(hunk.suggestedCode);
    const at = hunk.lineStart - 1 + offset;
    const removeCount = Math.min(hunk.lineEnd - hunk.lineStart + 1, Math.max(0, lines.length - at));
    lines.splice(at, removeCount, ...replacement);
    offset += replacement.length - removeCount;
  }
  return lines.join('\n');
}

function normalizeForCompare(content: string): string {
  return splitContentLines(content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')).join('\n');
}

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

  describe('anchor collisions between adjacent regions', () => {
    test('file-start insert plus adjacent insert do not claim the same line', () => {
      // Region 1 (insert S before line 1) must anchor forward to line 1;
      // region 2 (insert N0 before line 2) then finds its backward anchor
      // (line 1) taken and anchors forward to line 2 instead.
      const before = 'A\nB\nC\n';
      const after = 'S\nA\nN0\nB\nC\n';
      const hunks = deriveSuggestionHunks(before, after);
      expect(hunks).toEqual([
        { lineStart: 1, lineEnd: 1, originalCode: 'A', suggestedCode: 'S\nA' },
        { lineStart: 2, lineEnd: 2, originalCode: 'B', suggestedCode: 'N0\nB' },
      ]);
      expect(applyHunks(before, hunks)).toBe(normalizeForCompare(after));
    });

    test('two deletes sharing one kept line between them do not overlap', () => {
      // Region 1 (delete line 1) anchors forward to line 2; region 2 (delete
      // line 3) finds line 2 taken and anchors forward to line 4.
      const before = 'A\nB\nC\nD\n';
      const after = 'B\nD\n';
      const hunks = deriveSuggestionHunks(before, after);
      expect(hunks).toEqual([
        { lineStart: 1, lineEnd: 2, originalCode: 'A\nB', suggestedCode: 'B' },
        { lineStart: 3, lineEnd: 4, originalCode: 'C\nD', suggestedCode: 'D' },
      ]);
      expect(applyHunks(before, hunks)).toBe(normalizeForCompare(after));
    });

    test('adjacent regions at file start: delete then insert after the kept line', () => {
      const before = 'A\nB\nC\n';
      const after = 'B\nZ\nC\n';
      const hunks = deriveSuggestionHunks(before, after);
      expectDisjoint(hunks);
      expect(applyHunks(before, hunks)).toBe(normalizeForCompare(after));
    });

    test('adjacent regions at file end merge into one spanning hunk', () => {
      // Region 1 (delete line 1) anchors forward, claiming line 2 (the last
      // line); region 2 (append X at end of file) then has no anchor in
      // either direction and merges into region 1's hunk.
      const before = 'A\nB\n';
      const after = 'B\nX\n';
      const hunks = deriveSuggestionHunks(before, after);
      expect(hunks).toEqual([
        { lineStart: 1, lineEnd: 2, originalCode: 'A\nB', suggestedCode: 'B\nX' },
      ]);
      expect(applyHunks(before, hunks)).toBe(normalizeForCompare(after));
    });

    test('delete at file end after a claimed neighbor merges into the previous hunk', () => {
      // Region 1 (insert before line 1 at file start) anchors forward to line
      // 1; region 2 (delete line 2, the last line) finds backward taken and
      // has no forward line, so it merges.
      const before = 'A\nB\n';
      const after = 'X\nA\n';
      const hunks = deriveSuggestionHunks(before, after);
      expect(hunks).toEqual([
        { lineStart: 1, lineEnd: 2, originalCode: 'A\nB', suggestedCode: 'X\nA' },
      ]);
      expect(applyHunks(before, hunks)).toBe(normalizeForCompare(after));
    });
  });

  describe('fuzz: derived hunks never overlap and reconstruct the edit', () => {
    // Deterministic seeded PRNG (mulberry32) so failures are reproducible.
    function mulberry32(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const POOL = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

    function generateCase(rand: () => number): { before: string; after: string } {
      const lineCountBefore = Math.floor(rand() * 9); // 0..8 lines
      const beforeLines: string[] = [];
      for (let i = 0; i < lineCountBefore; i++) {
        beforeLines.push(POOL[Math.floor(rand() * POOL.length)]);
      }
      const afterLines: string[] = [];
      const maybeInsert = () => {
        // Insertions between every position (including file start and end)
        // are what produce adjacent expanding regions.
        while (rand() < 0.25) {
          afterLines.push(POOL[Math.floor(rand() * POOL.length)]);
        }
      };
      maybeInsert();
      for (const line of beforeLines) {
        const roll = rand();
        if (roll < 0.25) {
          // delete the line
        } else if (roll < 0.45) {
          afterLines.push(POOL[Math.floor(rand() * POOL.length)]); // replace
        } else {
          afterLines.push(line); // keep
        }
        maybeInsert();
      }
      const terminate = (lines: string[]) => (lines.length > 0 ? `${lines.join('\n')}\n` : '');
      return { before: terminate(beforeLines), after: terminate(afterLines) };
    }

    test('5000 seeded multi-region edits: zero overlaps, all round-trip', () => {
      const rand = mulberry32(0x5eed);
      let overlaps = 0;
      let roundTripFailures = 0;
      let anchorMismatches = 0;
      for (let i = 0; i < 5000; i++) {
        const { before, after } = generateCase(rand);
        const hunks = deriveSuggestionHunks(before, after);
        const beforeLines = splitContentLines(before);
        for (let j = 1; j < hunks.length; j++) {
          if (hunks[j].lineStart <= hunks[j - 1].lineEnd) overlaps++;
        }
        for (const hunk of hunks) {
          const expectedOriginal = beforeLines
            .slice(hunk.lineStart - 1, hunk.lineEnd)
            .join('\n');
          if (hunk.originalCode !== expectedOriginal) anchorMismatches++;
        }
        if (applyHunks(before, hunks) !== normalizeForCompare(after)) roundTripFailures++;
      }
      expect(overlaps).toBe(0);
      expect(anchorMismatches).toBe(0);
      expect(roundTripFailures).toBe(0);
    });
  });
});
