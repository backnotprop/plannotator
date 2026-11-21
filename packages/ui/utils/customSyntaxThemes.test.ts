/**
 * A custom theme's own code colours on the page (customSyntaxThemes.ts), through
 * the real `@pierre/diffs` highlighter the fences and the diff pane share. The
 * failures these guard: a theme's keyword and string drawn in other colours
 * than its file says; the diff pane's theme names (resolveSyntaxTheme) not
 * resolving through Pierre the way its worker pool resolves them; a one-half
 * theme drawing its code in the default in the other mode; a missing or forged
 * answer from the server breaking highlighting instead of falling back to the
 * default theme; and registering a name twice (Pierre logs it as an error).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as pierre from '@pierre/diffs';
import { __resetCodeHighlightCacheForTests, ensureHighlight, highlightToHtml } from './codeHighlight';
import { __setCustomSyntaxFetchForTests, connectCustomSyntaxThemes, customSyntaxThemeName, type CustomSyntaxPierre } from './customSyntaxThemes';
import { resolveFenceTheme, resolveSyntaxTheme } from './syntaxTheme';
import { setCustomThemes } from './themeRegistry';

const swatch = { primary: '#66d9ef', secondary: '#a1efe4', accent: '#ae81ff', background: '#272822', foreground: '#f8f8f2' };
const entry = (id: string, modeSupport: 'both' | 'dark-only' | 'light-only', syntax: ('dark' | 'light')[]) => ({ id, name: id, modeSupport, colors: { dark: swatch, light: swatch }, syntax });

const KEYWORD = '#f92672';
const STRING = '#e6db74';
const answer = (half: 'dark' | 'light') => ({
  [half]: {
    foreground: '#f8f8f2',
    background: '#272822',
    rules: [
      { scope: ['keyword', 'storage', 'storage.type'], foreground: KEYWORD },
      { scope: 'string', foreground: STRING },
    ],
  },
});

/** The colour of the span that holds `text` in highlighted markup. */
function colourOf(html: string, text: string): string | null {
  const span = new RegExp(`<span[^>]*style="([^"]*)"[^>]*>${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`, 'i').exec(html);
  if (!span) return null;
  const colour = /color:\s*(#[0-9a-f]{3,8})/i.exec(span[1]!);
  return colour ? colour[1]!.toLowerCase() : null;
}

afterEach(() => {
  setCustomThemes([]);
  __setCustomSyntaxFetchForTests(null);
  __resetCodeHighlightCacheForTests();
});

describe('a custom theme with code colours', () => {
  test("fences draw a keyword and a string in the theme's own colours", async () => {
    setCustomThemes([entry('fence-mono', 'dark-only', ['dark'])]);
    const asked: string[] = [];
    __setCustomSyntaxFetchForTests(async (id) => {
      asked.push(id);
      return answer('dark');
    });
    const theme = resolveFenceTheme('fence-mono', 'dark');
    expect(theme).toBe(customSyntaxThemeName('fence-mono', 'dark'));
    expect(await ensureHighlight('typescript', theme)).toBe(true);
    const html = highlightToHtml('const greeting = "hello";', 'typescript', theme);
    expect(html).not.toBeNull();
    expect(colourOf(html!, 'const')).toBe(KEYWORD);
    expect(colourOf(html!, '"hello"') ?? colourOf(html!, 'hello')).toBe(STRING);
    // Fetched once, when code first rendered in it.
    expect(asked).toEqual(['fence-mono']);
  });

  test("the diff pane's theme pair resolves through Pierre as its worker pool resolves it", async () => {
    setCustomThemes([entry('diff-mono', 'both', ['dark'])]);
    __setCustomSyntaxFetchForTests(async () => answer('dark'));
    connectCustomSyntaxThemes(pierre as unknown as CustomSyntaxPierre);
    const pair = resolveSyntaxTheme('diff-mono', 'dark');
    // The half with code colours draws in them; the other in Pierre's default.
    expect(pair).toEqual({ dark: customSyntaxThemeName('diff-mono', 'dark'), light: 'pierre-light' });
    // WorkerPoolManager resolves the names on the main thread with resolveThemes, then hands the workers the result.
    const [resolved] = await pierre.resolveThemes([pair!.dark as never]);
    const settings = (resolved!.textmate as { settings?: { scope?: string | string[]; settings: { foreground?: string } }[] }).settings ?? [];
    const keyword = settings.find((rule) => (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).includes('keyword'));
    expect(keyword?.settings.foreground?.toLowerCase()).toBe(KEYWORD);
    // In light mode the half has none: Pierre's defaults (undefined), as for a built-in with no light counterpart.
    expect(resolveSyntaxTheme('diff-mono', 'light')).toBeUndefined();
    // A fence draws that default with its low-contrast colours fixed (fenceSyntaxThemes.ts).
    expect(resolveFenceTheme('diff-mono', 'light')).toBe('plannotator-fence-light');
  });

  test('a one-half theme draws its own code colours in either mode', () => {
    setCustomThemes([entry('only-light', 'light-only', ['light'])]);
    expect(resolveFenceTheme('only-light', 'dark')).toBe(customSyntaxThemeName('only-light', 'light'));
    expect(resolveFenceTheme('only-light', 'light')).toBe(customSyntaxThemeName('only-light', 'light'));
  });

  test("a missing or forged answer draws in Pierre's default instead of breaking", async () => {
    setCustomThemes([entry('gone-mono', 'dark-only', ['dark']), entry('forged-mono', 'dark-only', ['dark'])]);
    __setCustomSyntaxFetchForTests(async (id) =>
      id === 'gone-mono' ? null : { dark: { ...answer('dark').dark, rules: [{ scope: 'keyword', foreground: 'url(x)' }] } },
    );
    const code = 'const greeting = "hello";';
    expect(await ensureHighlight('typescript', 'pierre-dark')).toBe(true);
    const fallback = highlightToHtml(code, 'typescript', 'pierre-dark');
    for (const id of ['gone-mono', 'forged-mono']) {
      const theme = resolveFenceTheme(id, 'dark');
      expect(await ensureHighlight('typescript', theme)).toBe(true);
      const html = highlightToHtml(code, 'typescript', theme);
      expect(colourOf(html!, 'const')).toBe(colourOf(fallback!, 'const'));
      expect(colourOf(html!, 'const')).not.toBe(KEYWORD);
    }
  });

  test('connecting again registers nothing twice', () => {
    setCustomThemes([entry('twice-mono', 'dark-only', ['dark'])]);
    const errors = spyOn(console, 'error');
    try {
      connectCustomSyntaxThemes(pierre as unknown as CustomSyntaxPierre);
      connectCustomSyntaxThemes(pierre as unknown as CustomSyntaxPierre);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
