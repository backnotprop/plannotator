/**
 * The first arrow click's read. What regresses: a brief forge failure, or an answer of "none", being kept so the arrows
 * never work again in this reader; a file read twice for one patch.
 */
import { expect, test } from 'bun:test';
import type { DiffFile } from '@plannotator/core/diff-files';
import type { InboxFileContents } from '@plannotator/core/inbox-types';
import { wholeFileReader, type KeptWholeFiles } from './wholeFileReader';

const file: DiffFile = { path: 'a.ts', patch: 'one patch', additions: 1, deletions: 1, status: 'modified' };
const signal = new AbortController().signal;
const TEXTS: InboxFileContents = { oldContent: 'old\n', newContent: 'new\n' };

function reader(answers: InboxFileContents[]) {
  const asked = { count: 0 };
  const read = wholeFileReader(async () => answers[asked.count++]!, new Map() as KeptWholeFiles);
  return { read, asked };
}

test('what a patch already has is not read twice, and another patch of the file is', async () => {
  const { read, asked } = reader([TEXTS, TEXTS]);
  await read(file, signal);
  await read(file, signal);
  expect(asked.count).toBe(1);
  await read({ ...file, patch: 'the next patch' }, signal);
  expect(asked.count).toBe(2);
});

test('"there is none" is answered, and asked again next time', async () => {
  const { read, asked } = reader([{ oldContent: null, newContent: null }, TEXTS]);
  expect(await read(file, signal)).toEqual({ oldContent: null, newContent: null });
  expect(await read(file, signal)).toEqual(TEXTS);
  expect(asked.count).toBe(2);
});

test('a forge that did not answer throws, and the next click asks again', async () => {
  const { read, asked } = reader([{ oldContent: null, newContent: null, failed: true }, TEXTS]);
  await expect(read(file, signal)).rejects.toThrow('a.ts');
  expect(await read(file, signal)).toEqual(TEXTS);
  expect(asked.count).toBe(2);
});

test('a renamed file reads; an added or deleted one is already whole and asks nothing', async () => {
  const { read, asked } = reader([TEXTS]);
  expect(await read({ ...file, status: 'added' }, signal)).toBeNull();
  expect(await read({ ...file, status: 'deleted' }, signal)).toBeNull();
  expect(asked.count).toBe(0);
  expect(await read({ ...file, oldPath: 'b.ts', status: 'renamed' }, signal)).toEqual(TEXTS);
});

test('reads made in the background go two at a time, and an arrow read does not wait behind them', async () => {
  const started: string[] = [];
  const answers = new Map<string, (contents: InboxFileContents) => void>();
  const reader = wholeFileReader(
    (path) => {
      started.push(path);
      return new Promise((resolve) => answers.set(path, resolve));
    },
    new Map(),
  );
  const file = (path: string): DiffFile => ({ path, patch: `p ${path}`, additions: 1, deletions: 1, status: 'modified' });
  const signal = new AbortController().signal;
  const later = new AbortController();
  const background = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => reader(file(path), path === 'd.ts' ? later.signal : signal, { background: true }));
  void background[3]!.catch(() => {});
  const arrow = reader(file('e.ts'), signal);
  await Promise.resolve();
  await Promise.resolve();
  expect([...started].sort()).toEqual(['a.ts', 'b.ts', 'e.ts']);
  later.abort();
  await expect(background[3]!).rejects.toBeDefined();
  answers.get('a.ts')!({ oldContent: 'a', newContent: 'a' });
  await background[0];
  await Promise.resolve();
  expect([...started].sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'e.ts']);
  answers.get('e.ts')!({ oldContent: 'e', newContent: 'e' });
  expect(await arrow).toEqual({ oldContent: 'e', newContent: 'e' });
  for (const path of ['b.ts', 'c.ts']) answers.get(path)!({ oldContent: path, newContent: path });
  await Promise.all([background[1], background[2]]);
});

test('a background read that never answers gives up its place in the queue, and the read is told to stop', async () => {
  const signals: AbortSignal[] = [];
  const reader = wholeFileReader(
    (path, readSignal) => {
      signals.push(readSignal);
      return path === 'hung.ts' ? new Promise(() => {}) : Promise.resolve({ oldContent: 'x', newContent: 'x' });
    },
    new Map(),
    30,
  );
  const file = (path: string): DiffFile => ({ path, patch: `p ${path}`, additions: 1, deletions: 1, status: 'modified' });
  const hung = [reader(file('hung.ts'), signal, { background: true }), reader(file('hung.ts'), signal, { background: true })];
  const next = reader(file('next.ts'), signal, { background: true });
  const settled = await Promise.allSettled(hung);
  expect(settled.map((one) => (one.status === 'rejected' ? String((one.reason as Error).message) : 'answered'))).toEqual(['Reading hung.ts took too long.', 'Reading hung.ts took too long.']);
  expect(signals.slice(0, 2).every((stopped) => stopped.aborted)).toBe(true);
  expect(await next).toEqual({ oldContent: 'x', newContent: 'x' });
});
