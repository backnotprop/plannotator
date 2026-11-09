import { describe, expect, test } from 'bun:test';
import { fileRefOf, findBarePaths, looksLikeFilePath } from './fileRefs';

const found = (text: string) => findBarePaths(text).map(({ start, end }) => text.slice(start, end));

describe('what names a file (approval inbox-file-refs-open-viewer)', () => {
  test('a code span names code, documents, pictures and films, here or anywhere, with its lines', () => {
    expect(fileRefOf('src/retry/worker.ts:42')).toEqual({ path: 'src/retry/worker.ts', line: 42 });
    expect(fileRefOf('src/a.ts:6-13')).toEqual({ path: 'src/a.ts', line: 6, lineEnd: 13 });
    expect(fileRefOf('src/a.ts#L6-L13')).toEqual({ path: 'src/a.ts', line: 6, lineEnd: 13 });
    expect(fileRefOf('README.md')).toEqual({ path: 'README.md' });
    expect(fileRefOf('shots/after.png')).toEqual({ path: 'shots/after.png' });
    expect(fileRefOf('demo/clip.mp4')).toEqual({ path: 'demo/clip.mp4' });
    expect(fileRefOf('/tmp/run/out.log:3')).toEqual({ path: '/tmp/run/out.log', line: 3 });
    expect(fileRefOf('~/notes/todo.md')).toEqual({ path: '~/notes/todo.md' });
  });

  test('words that are not a file stay words', () => {
    for (const words of ['Node.js', 'e.g.', 'RETRY_KEY_V2', 'backoffMs', 'https://example.com/a.md', 'a b.md', 'charge.lookup', '#123', 'docs/', '@scope/pkg']) {
      expect([words, looksLikeFilePath(words)]).toEqual([words, false]);
    }
  });

  test('a bare path in the text needs a folder, keeps its lines, and leaves a full stop out', () => {
    expect(found('See plan.md first.')).toEqual([]);
    expect(found('See docs/plan.md.')).toEqual(['docs/plan.md']);
    expect(found('Lines src/a.test.ts:6-13 and packages/inbox/file_refs.ts, then /tmp/shot.png or ~/notes/todo.md')).toEqual([
      'src/a.test.ts:6-13',
      'packages/inbox/file_refs.ts',
      '/tmp/shot.png',
      '~/notes/todo.md',
    ]);
    expect(found('app/[id]/page.tsx and ./scripts/run.sh')).toEqual(['app/[id]/page.tsx', './scripts/run.sh']);
  });

  test('a bare path is never found inside a word, a link or a library name', () => {
    expect(found('abc/def.ts')).toEqual(['abc/def.ts']);
    expect(found('xdocs/plan.md')).toEqual(['xdocs/plan.md']);
    expect(found('word_docs/plan.md')).toEqual(['word_docs/plan.md']);
    expect(found('[docs/plan.md](x)')).toEqual([]);
    expect(found('Uses vendor/Three.js today')).toEqual(['vendor/Three.js']);
    expect(found('Node.js and Vue.js')).toEqual([]);
  });

  test("another repository's issue or PR, and a web address without its scheme, are not files", () => {
    expect(found('Fixed upstream in vercel/next.js#123 and vuejs/vue.js#5.')).toEqual([]);
    expect(found('Pinned to owner/repo.js@3f2a9c1')).toEqual([]);
    expect(found('See example.com/docs/page.html and docs.github.com/en/a.md')).toEqual([]);
    expect(found('But src/next.js and docs/plan.md stay files.')).toEqual(['src/next.js', 'docs/plan.md']);
  });

  test('a path with a heading anchor stays a file, even one that starts like a sha', () => {
    expect(found('Details in docs/setup.md#configuration.')).toEqual(['docs/setup.md']);
    expect(found('See docs/guide.md#deploy and docs/faq.md#faq')).toEqual(['docs/guide.md', 'docs/faq.md']);
    expect(found('Lines docs/guide.md#L12 too')).toEqual(['docs/guide.md']);
    expect(found('Pinned to owner/repo.js@3f2a9c1e8b and vercel/next.js#42')).toEqual([]);
    // Too short to be a commit: an `@` that is not one leaves the file a file.
    expect(found('Ask docs/plan.md@abc')).toEqual(['docs/plan.md']);
  });
});
