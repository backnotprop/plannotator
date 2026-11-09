import { describe, expect, test } from 'bun:test';

import {
  codeBlockClassName,
  codeBlockKeepsLayout,
  CODE_BLOCK_CLASS,
  applyHighlight,
  ensureHighlight,
  highlightToHtml,
  __resetCodeHighlightCacheForTests,
} from './codeHighlight';
import { resolveFenceTheme, resolveSyntaxTheme, DEFAULT_SYNTAX_THEME, SHIKI_THEME_MAP } from './syntaxTheme';

const hasDom = typeof document !== 'undefined';

describe('code block class', () => {
  test('carries the structural class and the language hook', () => {
    expect(codeBlockClassName('rust')).toBe(`${CODE_BLOCK_CLASS} font-mono language-rust`);
  });

  test('omits the language hook for language-less fences', () => {
    expect(codeBlockClassName()).toBe(`${CODE_BLOCK_CLASS} font-mono`);
    expect(codeBlockClassName(undefined)).not.toContain('language-');
  });
});

// Plan fences wrap long lines; these pin which fences must NOT wrap because a
// wrapped row would tear a diagram or a column layout apart.
describe('codeBlockKeepsLayout', () => {
  test('keeps diagrams and column-aligned fences unwrapped', () => {
    expect(codeBlockKeepsLayout('┌────┐\n│ UI │\n└────┘')).toBe(true);
    expect(codeBlockKeepsLayout('+------+        +------+\n| hook | -----> | srv  |')).toBe(true);
    expect(codeBlockKeepsLayout('Name      Type     Default\nport      number   random')).toBe(true);
    expect(codeBlockKeepsLayout('key\tvalue')).toBe(true);
  });

  test('lets ordinary code, commands, URLs and prose wrap', () => {
    expect(codeBlockKeepsLayout('function f() {\n    return someCall(a, b, c);\n}')).toBe(false);
    expect(codeBlockKeepsLayout('bun build apps/hook/server/index.ts --compile --outfile ~/.local/bin/plannotator')).toBe(false);
    expect(codeBlockKeepsLayout('https://example.com/a/very/long/path?x=1&y=2')).toBe(false);
    expect(codeBlockKeepsLayout('First sentence.  Second sentence!  Third?  Done.')).toBe(false);
    expect(codeBlockKeepsLayout('trailing hard break  \nnext line')).toBe(false);
  });
});

describe('fence theme resolution', () => {
  test('matches the theme the diff pane resolves, per mode', () => {
    expect(resolveFenceTheme('kanagawa-wave', 'dark')).toBe('kanagawa-wave');
    expect(resolveFenceTheme('github', 'light')).toBe('github-light');
    expect(resolveFenceTheme('colorblind', 'dark')).toBe('pierre-dark-protanopia-deuteranopia');
    expect(resolveFenceTheme('colorblind', 'light')).toBe('pierre-light-protanopia-deuteranopia');
  });

  test('falls back to the Pierre defaults for unmapped palettes', () => {
    // The default Plannotator palette has no Shiki counterpart, so it renders
    // in exactly what @pierre/diffs uses when handed no theme at all.
    expect(resolveSyntaxTheme('plannotator', 'dark')).toBeUndefined();
    expect(resolveFenceTheme('plannotator', 'dark')).toBe(DEFAULT_SYNTAX_THEME.dark);
    expect(resolveFenceTheme('plannotator', 'light')).toBe(DEFAULT_SYNTAX_THEME.light);
  });

  test('falls back per mode when a palette only defines one side', () => {
    // dracula is dark-only; its light mode must still resolve to something.
    expect(SHIKI_THEME_MAP['dracula']?.light).toBeNull();
    expect(resolveFenceTheme('dracula', 'dark')).toBe('dracula');
    expect(resolveFenceTheme('dracula', 'light')).toBe(DEFAULT_SYNTAX_THEME.light);
  });

  test('every mapped theme name is non-empty', () => {
    for (const [palette, pair] of Object.entries(SHIKI_THEME_MAP)) {
      expect(pair.dark ?? pair.light, `${palette} maps to nothing`).toBeTruthy();
    }
  });
});

describe('highlightToHtml', () => {
  test('returns null until a grammar is attached, so callers render plain', () => {
    // The attachment cache is MODULE state shared with every other test file in
    // this bun process, and any file that renders a typescript fence attaches
    // that grammar for good. Reset it so this test asserts the pre-attachment
    // CONTRACT rather than whichever files happened to run first.
    __resetCodeHighlightCacheForTests();
    expect(highlightToHtml('const x = 1', 'typescript', 'pierre-dark')).toBeNull();
  });
});

// Shiki gives each line 500 ms and leaves the rest of a line that runs over it plain. A grammar compiles its
// regexes while its first fence is tokenized, and in JavaScriptCore (Safari, and Bun here) that took TypeScript's
// first line past the budget: the page's first TypeScript fence coloured unlike every later one.
describe('a pass that runs out of Shiki\'s time budget', () => {
  const CODE = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';

  test('a fence whose pass was cut short is tokenized again, so it gets every colour', async () => {
    expect(await ensureHighlight('typescript', 'pierre-dark')).toBe(true);
    const settled = highlightToHtml(CODE, 'typescript', 'pierre-dark');
    expect(settled).toContain('>number</span>');
    // One pass on a clock that jumps 200 ms at each read: Shiki cuts every line short, as a slow compile did.
    const highlighter = (await import('@pierre/diffs')).getHighlighterIfLoaded()!;
    const realDateNow = Date.now;
    const realPerfNow = performance.now.bind(performance);
    let skew = 0;
    let jumping = false;
    const own = highlighter as unknown as Record<string, unknown>;
    const realTokens = highlighter.codeToTokens.bind(highlighter);
    let passes = 0;
    own.codeToTokens = (...args: Parameters<typeof realTokens>) => {
      jumping = ++passes === 1;
      try {
        return realTokens(...args);
      } finally {
        jumping = false;
      }
    };
    Date.now = () => realDateNow() + (jumping ? (skew += 200) : skew);
    performance.now = () => realPerfNow() + skew;
    try {
      expect(highlightToHtml(CODE, 'typescript', 'pierre-dark')).toBe(settled);
      expect(passes).toBe(2);
    } finally {
      Date.now = realDateNow;
      performance.now = realPerfNow;
      delete own.codeToTokens;
    }
  });
});

describe.if(hasDom)('applyHighlight', () => {
  test('language-less fences render as plain text, never guessed (#1212)', () => {
    const el = document.createElement('code');
    applyHighlight(el, 'plain <b>text</b> & more', undefined, 'pierre-dark');
    expect(el.textContent).toBe('plain <b>text</b> & more');
    // Escaped into text nodes, not parsed as markup.
    expect(el.querySelector('b')).toBeNull();
    expect(el.children.length).toBe(0);
  });

  test('writes the exact source immediately so there is no layout shift', () => {
    const el = document.createElement('code');
    const code = 'fn main() {\n    println!("hi");\n}';
    applyHighlight(el, code, 'rust', 'pierre-dark');
    // The highlighter is cold here, so the synchronous result is the plain
    // source at its final size; the highlighted swap lands later.
    expect(el.textContent).toBe(code);
  });
});
