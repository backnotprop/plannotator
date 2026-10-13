import { describe, expect, test } from 'bun:test';
import {
  isMarkdownPreviewFile,
  isRemoteImageSource,
  markdownViewsFor,
  nextMarkdownView,
  parseMarkdownFileView,
  resolveMarkdownView,
  markdownPreviewDocument,
  markdownPreviewImageUrl,
  markdownPreviewSides,
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

describe('markdownPreviewSides', () => {
  const patch = [
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1,3 +1,3 @@',
    ' # Title',
    '-old',
    '+new',
    ' end',
    '',
  ].join('\n');

  test('the rendered diff needs both sides, each agreeing with the patch', () => {
    expect(markdownPreviewSides(patch, '# Title\nold\nend\n', '# Title\nnew\nend\n', 'modified'))
      .toEqual({ kind: 'ready', old: '# Title\nold\nend\n', new: '# Title\nnew\nend\n' });
    expect(markdownPreviewSides(patch, null, '# Title\nnew\nend\n', 'modified').kind).toBe('missing');
    // An old side that no longer matches the patch never renders as the base.
    expect(markdownPreviewSides(patch, '# Title\nolder\nend\n', '# Title\nnew\nend\n', 'modified').kind).toBe('stale');
  });

  test('an added file has no old side and a deleted file no new side', () => {
    const added = '--- /dev/null\n+++ b/a.md\n@@ -0,0 +1,1 @@\n+# New\n';
    expect(markdownPreviewSides(added, null, '# New\n', 'added')).toEqual({ kind: 'ready', old: null, new: '# New\n' });
    const deleted = '--- a/a.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-# Gone\n';
    expect(markdownPreviewSides(deleted, '# Gone\n', null, 'deleted')).toEqual({ kind: 'ready', old: '# Gone\n', new: null });
  });
});

describe('markdownPreviewImageUrl', () => {
  test('names the document, the side and the source as written', () => {
    const url = new URL(markdownPreviewImageUrl({ doc: 'docs/a b.md', side: 'old', src: '../img/x.png?raw=1', snapshot: 's1' }), 'http://x');
    expect(url.pathname).toBe('/api/review-markdown-image');
    expect(url.searchParams.get('doc')).toBe('docs/a b.md');
    expect(url.searchParams.get('side')).toBe('old');
    expect(url.searchParams.get('src')).toBe('../img/x.png?raw=1');
    expect(url.searchParams.get('snapshot')).toBe('s1');
  });
});

describe('isRemoteImageSource', () => {
  test('anything a browser would fetch from another server', () => {
    for (const src of [
      'https://tracker.example/p.png',
      'http://tracker.example/p.png',
      '//cdn.example/b.svg',
      'https:tracker.example/a.png',
      'https:/tracker.example/b.png',
      'https:\\\\tracker.example\\c.png',
      '\\\\tracker.example\\d.png',
      '/\\tracker.example/e.png',
      ' HTTPS://tracker.example/f.png',
      'ht\ttps://tracker.example/g.png',
    ]) {
      expect(isRemoteImageSource(src)).toBe(true);
    }
  });

  test('repository paths and inline images are not remote', () => {
    for (const src of ['img/a.png', '/img/a.png', './https/a.png', 'data:image/png;base64,AA==', 'blob:x', 'httpsdocs/a.png']) {
      expect(isRemoteImageSource(src)).toBe(false);
    }
  });
});

describe('file views', () => {
  const MODIFIED = '@@ -1 +1 @@\n-a\n+b\n';
  test('added, deleted and unchanged renames offer Source and Read; everything else all three', () => {
    expect(markdownViewsFor({ status: 'modified', patch: MODIFIED })).toEqual(['source', 'changes', 'read']);
    expect(markdownViewsFor({ status: 'renamed', patch: MODIFIED })).toEqual(['source', 'changes', 'read']);
    expect(markdownViewsFor({ status: 'added', patch: MODIFIED })).toEqual(['source', 'read']);
    expect(markdownViewsFor({ status: 'deleted', patch: MODIFIED })).toEqual(['source', 'read']);
    expect(markdownViewsFor({ status: 'renamed', patch: 'similarity index 100%\nrename from a.md\nrename to b.md\n' })).toEqual(['source', 'read']);
  });

  test('a rendered wish stays rendered where Changes is missing; P wraps around what the file has', () => {
    expect(resolveMarkdownView('changes', ['source', 'read'])).toBe('read');
    expect(resolveMarkdownView('read', ['source', 'changes', 'read'])).toBe('read');
    expect(nextMarkdownView('source', ['source', 'read'])).toBe('read');
    expect(nextMarkdownView('read', ['source', 'changes', 'read'])).toBe('source');
    expect(parseMarkdownFileView('changes')).toBe('changes');
    expect(parseMarkdownFileView('true')).toBeNull();
  });

  test('only Markdown files offer a preview', () => {
    expect(isMarkdownPreviewFile({ path: 'docs/a.md', status: 'modified' }, [])).toBe(true);
    expect(isMarkdownPreviewFile({ path: 'src/a.ts', status: 'modified' }, [])).toBe(false);
    expect(isMarkdownPreviewFile({ path: 'notes.txt', oldPath: 'notes.md', status: 'renamed' }, [])).toBe(false);
  });
});
