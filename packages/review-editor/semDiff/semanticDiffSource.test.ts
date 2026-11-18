import { expect, test } from 'bun:test';
import type { SemanticDiffOkResponse } from '@plannotator/shared/semantic-diff-types';
import type { SemDiffAttempt, SemDiffClient } from './semDiffClient';
import { computeReviewSemanticDiff, SEM_DIFF_MAX_CHARS } from './semanticDiffSource';

const moved: SemDiffAttempt = {
  failed: false,
  result: {
    semanticOperations: [{ type: 'moved', lines: { old: [{ start: 1, end: 3 }], new: [{ start: 5, end: 7 }] } }] as never,
    semanticFolds: [],
    patch: '',
    summary: { skim: [], read: [] } as never,
  },
};

test('generated and oversized files are skipped before the worker, a failed file does not stop the rest, and the answer says which files were not read', async () => {
  const asked: string[] = [];
  const client: SemDiffClient = {
    supports: () => true,
    diff: async () => null,
    attempt: async (path) => {
      asked.push(path);
      return path === 'src/slow.ts' ? { result: null, failed: true } : moved;
    },
    dispose: () => {},
  };
  const text = 'function a() {}\n'.repeat(4);
  const huge = 'x'.repeat(SEM_DIFF_MAX_CHARS);
  const read = async (file: { path: string }) =>
    file.path === 'src/gone.ts'
      ? null
      : { oldContent: file.path === 'src/huge.ts' ? huge : text, newContent: file.path === 'src/huge.ts' ? `${huge}y` : `${text}\n` };
  const files = ['src/a.ts', 'src/gen.ts', 'src/huge.ts', 'src/slow.ts', 'src/gone.ts', 'src/b.ts'].map((path) => ({ path }));
  const answer = (await computeReviewSemanticDiff(files, client, read, new AbortController().signal, new Set(['src/gen.ts']))) as SemanticDiffOkResponse;
  expect(asked.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/slow.ts']);
  expect(answer.summary.fileCount).toBe(2);
  expect(answer.changes.map((change) => change.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  expect(Object.fromEntries((answer.unreadFiles ?? []).map((file) => [file.path, file.reason]))).toEqual({
    'src/gen.ts': 'generated',
    'src/huge.ts': 'too-large',
    'src/slow.ts': 'timed-out',
    'src/gone.ts': 'unreadable',
  });
});
