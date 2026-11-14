import { describe, expect, test } from 'bun:test';
import { createKeptWholeFiles, warmsUpAtRest, WHOLE_FILE_WARM_UP_LINE_LIMIT } from './wholeFileText';

const linesOf = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join('\n') + '\n';

describe('whole file text read ahead of an expand', () => {
  test('a file up to the warm-up limit is coloured ahead at rest, a larger one waits for the reader', () => {
    expect(warmsUpAtRest({ oldContent: linesOf(WHOLE_FILE_WARM_UP_LINE_LIMIT), newContent: linesOf(10) })).toBe(true);
    expect(warmsUpAtRest({ oldContent: linesOf(10), newContent: linesOf(WHOLE_FILE_WARM_UP_LINE_LIMIT + 1) })).toBe(false);
  });

  test('peeking at kept text leaves it for the expand', async () => {
    const kept = createKeptWholeFiles();
    const text = { oldContent: 'a\n', newContent: 'b\n' };
    kept.keep('item-1', 'diff-a', text);
    expect(kept.peek('item-1', 'diff-a')).toBe(text);
    expect(kept.peek('item-1', 'diff-b')).toBeNull();
    expect(await kept.read('item-1', 'diff-a', async () => null)).toBe(text);
  });

  test('the kept text serves the first expand without a second read, once', async () => {
    const kept = createKeptWholeFiles();
    const text = { oldContent: linesOf(21000), newContent: linesOf(21002) };
    let reads = 0;
    const readFresh = async () => {
      reads += 1;
      return { oldContent: 'fresh\n', newContent: 'fresh\n' };
    };
    kept.keep('item-1', 'diff-a', text);
    expect(await kept.read('item-1', 'diff-a', readFresh)).toBe(text);
    expect(reads).toBe(0);
    expect(await kept.read('item-1', 'diff-a', readFresh)).toEqual({ oldContent: 'fresh\n', newContent: 'fresh\n' });
    expect(reads).toBe(1);
  });

  test('text kept for another diff is never served', async () => {
    const kept = createKeptWholeFiles();
    kept.keep('item-1', 'diff-a', { oldContent: 'old\n', newContent: 'old\n' });
    kept.keep('item-2', 'diff-b', { oldContent: 'b\n', newContent: 'b\n' });
    kept.keepOnly('diff-b');
    let reads = 0;
    await kept.read('item-1', 'diff-b', async () => {
      reads += 1;
      return null;
    });
    expect(reads).toBe(1);
    expect(await kept.read('item-2', 'diff-b', async () => null)).toEqual({ oldContent: 'b\n', newContent: 'b\n' });
  });
});
