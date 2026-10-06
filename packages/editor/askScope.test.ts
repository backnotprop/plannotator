/**
 * `askScopeFromContext`: the composer context → Ask AI scope mapping both of
 * App's Ask AI paths use (#1731). Failure to catch: a single-line selection
 * whose host sends only `lineStart` asking with no line, or a converted
 * HTML/URL source sending converted-markdown line numbers that do not exist
 * in the file the agent reads.
 */
import { describe, expect, test } from 'bun:test';
import { askScopeFromContext } from './askScope';

const selection = { kind: 'selection' as const, label: 'Selected text', text: 'retry the job', sourcePath: '/docs/plan.md' };
const plain = { documentPath: '/docs/plan.md', sourceConverted: false };

describe('askScopeFromContext', () => {
  test('carries both lines through', () => {
    expect(askScopeFromContext({ ...selection, lineStart: 8, lineEnd: 9 }, plain)).toMatchObject({ lineStart: 8, lineEnd: 9 });
  });

  test('a lone lineStart becomes a one-line range', () => {
    expect(askScopeFromContext({ ...selection, lineStart: 8 }, plain)).toMatchObject({ lineStart: 8, lineEnd: 8 });
  });

  test('a converted source drops the lines but keeps the rest', () => {
    const scope = askScopeFromContext({ ...selection, lineStart: 8, lineEnd: 9 }, { ...plain, sourceConverted: true });
    expect(scope).toEqual({ kind: 'selection', label: 'Selected text', text: 'retry the job', sourcePath: '/docs/plan.md' });
  });

  test('a context without lines gets no line keys; a missing path falls back to the document', () => {
    const { sourcePath: _omit, ...noPath } = selection;
    const scope = askScopeFromContext(noPath, plain)!;
    expect('lineStart' in scope).toBe(false);
    expect('lineEnd' in scope).toBe(false);
    expect(scope.sourcePath).toBe('/docs/plan.md');
  });

  test('no context is a general question', () => {
    expect(askScopeFromContext(undefined, plain)).toBeUndefined();
  });
});
