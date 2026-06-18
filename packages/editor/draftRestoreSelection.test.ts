import { describe, expect, test } from 'bun:test';
import type { DraftEditedDocument } from '@plannotator/ui/hooks/useAnnotationDraft';
import { pickRestoredSingleFileDraftToDisplay } from './draftRestoreSelection';

function draft(key: string, scope: 'single-file' | 'folder-file' = 'single-file'): DraftEditedDocument {
  return {
    key,
    sourceSave: {
      enabled: true,
      kind: 'local-text-file',
      scope,
      path: `/repo/${key}.md`,
      basename: `${key}.md`,
      language: 'markdown',
      hash: `sha256:${key}`,
      mtimeMs: 1,
      size: 2,
      eol: 'lf',
    },
    sessionOpenText: 'a\n',
    diskBaseline: 'a\n',
    currentText: 'b\n',
  };
}

describe('pickRestoredSingleFileDraftToDisplay', () => {
  test('keeps the active restored single-file draft visible', () => {
    expect(
      pickRestoredSingleFileDraftToDisplay([draft('a'), draft('b')], ['a', 'b'], 'b')?.key,
    ).toBe('b');
  });

  test('shows the only restored single-file draft when nothing is active', () => {
    expect(
      pickRestoredSingleFileDraftToDisplay([draft('a')], ['a'], null)?.key,
    ).toBe('a');
  });

  test('does not guess across multiple drafts or folder files', () => {
    expect(pickRestoredSingleFileDraftToDisplay([draft('a'), draft('b')], ['a', 'b'], null)).toBeUndefined();
    expect(pickRestoredSingleFileDraftToDisplay([draft('a', 'folder-file')], ['a'], null)).toBeUndefined();
  });
});
