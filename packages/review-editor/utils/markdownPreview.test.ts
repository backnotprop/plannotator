import { describe, expect, test } from 'bun:test';
import {
  markdownPreviewDocument,
  markdownPreviewImageRoot,
  markdownPreviewSourcePath,
  resolveReviewRelativePath,
} from './markdownPreview';

describe('resolveReviewRelativePath', () => {
  test('resolves against the file\'s own folder', () => {
    expect(resolveReviewRelativePath('docs/guide/README.md', 'setup.md')).toBe('docs/guide/setup.md');
    expect(resolveReviewRelativePath('docs/guide/README.md', './img/a.png')).toBe('docs/guide/img/a.png');
    expect(resolveReviewRelativePath('docs/guide/README.md', '../api.md#auth')).toBe('docs/api.md');
    expect(resolveReviewRelativePath('README.md', 'docs/my%20notes.md?raw=1')).toBe('docs/my notes.md');
  });

  test('a leading slash is the repository root', () => {
    expect(resolveReviewRelativePath('docs/guide/README.md', '/CHANGELOG.md')).toBe('CHANGELOG.md');
  });

  test('refuses what is not a path inside the repository', () => {
    expect(resolveReviewRelativePath('docs/README.md', '../../outside.md')).toBeNull();
    expect(resolveReviewRelativePath('docs/README.md', '#section')).toBeNull();
    expect(resolveReviewRelativePath('docs/README.md', 'https://example.com/a.md')).toBeNull();
    expect(resolveReviewRelativePath('docs/README.md', '//cdn.example.com/a.png')).toBeNull();
    expect(resolveReviewRelativePath('docs/README.md', 'file:///etc/passwd')).toBeNull();
  });
});

describe('markdownPreviewSourcePath', () => {
  test('previews the new path, or the old one for a deletion', () => {
    expect(markdownPreviewSourcePath('a.md', undefined, 'modified', [])).toBe('a.md');
    expect(markdownPreviewSourcePath('notes.MARKDOWN', undefined, 'added', [])).toBe('notes.MARKDOWN');
    expect(markdownPreviewSourcePath('gone.md', undefined, 'deleted', [])).toBe('gone.md');
    expect(markdownPreviewSourcePath('book.livemd', undefined, 'added', ['.livemd'])).toBe('book.livemd');
  });

  test('a rename away from Markdown offers no preview', () => {
    expect(markdownPreviewSourcePath('notes.txt', 'notes.md', 'renamed', [])).toBeNull();
    expect(markdownPreviewSourcePath('notes.md', 'notes.txt', 'renamed', [])).toBe('notes.md');
  });
});

describe('markdownPreviewImageRoot', () => {
  const local = {
    isStaticPatch: false,
    isPRMode: false,
    isWorkspace: false,
    vcsType: 'git',
    activeDiffBase: 'uncommitted',
    worktreePath: null,
    repoRoot: '/repo',
  };

  test('only a Git working tree that is the new side', () => {
    expect(markdownPreviewImageRoot(local)).toBe('/repo');
    expect(markdownPreviewImageRoot({ ...local, activeDiffBase: 'since-base' })).toBe('/repo');
    expect(markdownPreviewImageRoot({ ...local, worktreePath: '/wt' })).toBe('/wt');
    for (const activeDiffBase of ['staged', 'last-commit', 'branch', 'merge-base', 'all', 'commit:abc1234']) {
      expect(markdownPreviewImageRoot({ ...local, activeDiffBase })).toBeNull();
    }
    expect(markdownPreviewImageRoot({ ...local, isPRMode: true })).toBeNull();
    expect(markdownPreviewImageRoot({ ...local, isWorkspace: true })).toBeNull();
    expect(markdownPreviewImageRoot({ ...local, isStaticPatch: true })).toBeNull();
    expect(markdownPreviewImageRoot({ ...local, vcsType: 'jj' })).toBeNull();
  });
});

describe('markdownPreviewDocument', () => {
  const patch = [
    'diff --git a/a.md b/a.md',
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1,3 +1,3 @@',
    ' # Title',
    '-old',
    '+new',
    ' end',
    '',
  ].join('\n');

  test('ready when the shown side agrees with the patch', () => {
    expect(markdownPreviewDocument(patch, '# Title\nold\nend\n', '# Title\nnew\nend\n', 'modified'))
      .toEqual({ kind: 'ready', content: '# Title\nnew\nend\n' });
  });

  test('stale when the file was edited after the diff, even to the same length', () => {
    expect(markdownPreviewDocument(patch, '# Title\nold\nend\n', '# Title\nnewer\nend\n', 'modified').kind)
      .toBe('stale');
  });

  test('context lines compare without whitespace (hide-whitespace diffs)', () => {
    expect(markdownPreviewDocument(patch, '# Title\nold\nend\n', '#  Title\nnew\nend  \n', 'modified').kind)
      .toBe('ready');
  });

  test('CRLF files match an LF patch (core.autocrlf, eol=crlf)', () => {
    expect(markdownPreviewDocument(patch, '# Title\r\nold\r\nend\r\n', '# Title\r\nnew\r\nend\r\n', 'modified'))
      .toEqual({ kind: 'ready', content: '# Title\r\nnew\r\nend\r\n' });
    // A real edit is still caught under CRLF.
    expect(markdownPreviewDocument(patch, '# Title\r\nold\r\nend\r\n', '# Title\r\nnewer\r\nend\r\n', 'modified').kind)
      .toBe('stale');
  });

  test('a deletion previews the old side', () => {
    const deleted = '--- a/a.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-# Gone\n-text\n';
    expect(markdownPreviewDocument(deleted, '# Gone\ntext\n', null, 'deleted'))
      .toEqual({ kind: 'ready', content: '# Gone\ntext\n' });
    expect(markdownPreviewDocument(deleted, null, null, 'deleted').kind).toBe('missing');
  });

  test('an added file with lines appended since the diff is stale', () => {
    const added = '--- /dev/null\n+++ b/a.md\n@@ -0,0 +1,1 @@\n+# New\n';
    expect(markdownPreviewDocument(added, null, '# New\n', 'added').kind).toBe('ready');
    expect(markdownPreviewDocument(added, null, '# New\nmore\n', 'added').kind).toBe('stale');
  });
});
