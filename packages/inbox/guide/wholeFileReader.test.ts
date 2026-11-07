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
