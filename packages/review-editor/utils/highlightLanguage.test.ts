import { describe, expect, test } from 'bun:test';
import { getFiletypeFromFileName } from '@pierre/diffs';
import { applyFileLanguageFixes, fileHighlightLanguage } from './highlightLanguage';
import { detectLanguage } from './detectLanguage';

// The diff pane and the whole-file view colour a file with Pierre's own
// `getFiletypeFromFileName`; a suggestion preview with `fileHighlightLanguage`.
// Each row must come out the same from both.
const ROWS: Array<[path: string, grammar: string | undefined]> = [
  // Pierre's own table names another language.
  ['src/Foo.m', 'objective-c'],
  ['scripts/tool.pl', 'perl'],
  // Pierre's own table has nothing for these.
  ['justfile', 'just'],
  ['tools/Justfile', 'just'],
  ['app/build.gradle', 'groovy'],
  ['home/.zshrc', 'zsh'],
  ['assets/icon.svg', 'xml'],
  // Shiki has no grammar for these, so they stay plain rather than borrow one.
  ['go.mod', undefined],
  ['.gitignore', undefined],
  // Pierre's own answer, kept.
  ['src/main.zig', 'zig'],
  ['lib/app.ex', 'elixir'],
  ['lib/main.dart', 'dart'],
  ['src/Main.hs', 'haskell'],
  ['src/index.ts', 'typescript'],
  ['src/App.tsx', 'tsx'],
  ['src/foo.h', 'objective-cpp'],
  ['src/Foo.mm', 'objective-cpp'],
  ['lib/Mod.pm', 'perl'],
  ['rules.pro', 'prolog'],
  ['notebook.wl', 'wolfram'],
  ['data.mat', 'matlab'],
  ['Makefile', 'makefile'],
  ['.env', 'dotenv'],
  ['settings.gradle.kts', 'kts'],
  ['notes.txt', undefined],
];

describe('file name to grammar', () => {
  applyFileLanguageFixes();

  for (const [path, grammar] of ROWS) {
    test(`${path} → ${grammar ?? 'plain'}, in the diff and in a suggestion`, () => {
      expect(fileHighlightLanguage(path)).toBe(grammar);
      expect(getFiletypeFromFileName(path)).toBe(grammar ?? 'text');
    });
  }

  test('code navigation keeps its own names', () => {
    // The server's search reads these; colouring must not rename them.
    expect(detectLanguage('src/App.tsx')).toBe('typescript');
    expect(detectLanguage('src/foo.h')).toBe('c');
    expect(detectLanguage('src/Foo.m')).toBeUndefined();
  });
});
