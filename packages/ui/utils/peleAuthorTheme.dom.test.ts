// The named-theme table and the base derivation in `peleAuthorTheme.ts`,
// against Mermaid's own theme classes. What regresses: a Mermaid upgrade
// changes a theme's colours and Pele keeps the old ones, or the base
// derivation drifts from Mermaid's for the same variables.
// DOM-gated (DOM_TESTS=1): Mermaid needs a document to load.
import { describe, expect, test } from 'bun:test';
import { parseCssColor } from './cssColor';
import { deriveBaseColors, MERMAID_THEME_NAMES, MERMAID_THEMES } from './peleAuthorTheme';

const hasDom = typeof document !== 'undefined';

/** Within one step per channel (khroma rounds its HSL; ours does not). */
function close(a: string, b: string): boolean {
  const x = parseCssColor(a);
  const y = parseCssColor(b);
  if (x === undefined || y === undefined) return a === b;
  return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b)) <= 2 / 255;
}

async function mermaidColors(theme: string, themeVariables?: Record<string, string>): Promise<Record<string, string>> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, theme: theme as 'base', ...(themeVariables ? { themeVariables } : {}) });
  return mermaid.mermaidAPI.getConfig().themeVariables as Record<string, string>;
}

describe.if(hasDom)("author themes against Mermaid's own", () => {
  test('every named theme is the colours Mermaid computes for it', async () => {
    for (const name of MERMAID_THEME_NAMES) {
      const own = await mermaidColors(name);
      for (const [key, value] of Object.entries(MERMAID_THEMES[name])) expect(close(value, own[key] ?? ''), `${name}.${key}: ${value} vs ${own[key]}`).toBe(true);
    }
  });

  test("the base theme's derived colours match Mermaid's for the variables an author gives", async () => {
    for (const given of [{ primaryColor: '#ff00aa' }, { primaryColor: '#336699', background: '#fafafa' }, { primaryColor: '#2d2d2d', darkMode: 'true', background: '#111111' }, { primaryColor: '#cde498', lineColor: '#000000', tertiaryColor: '#eeeeee' }]) {
      const own = await mermaidColors('base', given.darkMode ? { ...given, darkMode: true as unknown as string } : given);
      for (const [key, value] of Object.entries(deriveBaseColors(given))) expect(close(value, own[key] ?? ''), `${JSON.stringify(given)} ${key}: ${value} vs ${own[key]}`).toBe(true);
    }
  });
});
