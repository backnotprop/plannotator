/**
 * The code colours a fence draws in by default must be readable on a code
 * block: every token colour at least 4.5:1 (WCAG AA for text) against the
 * theme's own background and against the default palette's code block
 * (`--muted`, read from themes/plannotator.css) in that mode,
 * in both halves, through the real `@pierre/diffs` highlighter.
 *
 * What regresses if these fail: a light page draws operators, numbers,
 * constants, strings and comments at 1.8–4:1 (Pierre's light theme), or a
 * dark one draws comments and punctuation at 3–3.8:1; or a fix moves a
 * colour's hue (the palette must stay Pierre's); or a colour that already
 * read well is changed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pierre from '@pierre/diffs';
import { __resetCodeHighlightCacheForTests, ensureHighlight, highlightToHtml } from './codeHighlight';
import { FENCE_BASE_THEME, FENCE_COLOR_FIXES, FENCE_SYNTAX_THEME, type FenceHalf } from './fenceSyntaxThemes';
import { connectCustomSyntaxThemes, type CustomSyntaxPierre } from './customSyntaxThemes';
import { resolveFenceTheme } from './syntaxTheme';

const rgb = (hex: string): [number, number, number] => {
  let h = hex.replace('#', '').slice(0, 6);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
};
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** `oklch(L C H)` as `#rrggbb` (clamped to sRGB). */
const oklchHex = (value: string): string => {
  const [L, C, H] = (value.match(/[\d.]+/g) ?? []).map(Number) as [number, number, number];
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const enc = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  return '#' + linear.map((c) => Math.round(Math.min(1, Math.max(0, enc(Math.min(1, Math.max(0, c))))) * 255).toString(16).padStart(2, '0')).join('');
};

/**
 * The default palette's `--muted`, read from themes/plannotator.css (dark half,
 * then `.light`). A code block draws `bg-muted/50` over the page, so this is
 * the darkest (light) or lightest (dark) a block can be.
 */
const CODE_BLOCK: Record<FenceHalf, string> = (() => {
  const css = readFileSync(join(import.meta.dir, '../themes/plannotator.css'), 'utf8');
  const muted = [...css.matchAll(/--muted:\s*(oklch\([^)]*\))/g)].map((match) => oklchHex(match[1]!));
  if (muted.length !== 2) throw new Error('themes/plannotator.css: expected --muted in its dark and light halves');
  return { dark: muted[0]!, light: muted[1]! };
})();

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** OKLCH hue in degrees, and chroma. */
const hueOf = (hex: string): { h: number; c: number } => {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360, c: Math.hypot(A, B) };
};

type Theme = { bg?: string; fg?: string; settings?: { settings?: { foreground?: string } }[] };
async function resolved(name: string): Promise<Theme> {
  connectCustomSyntaxThemes(pierre as unknown as CustomSyntaxPierre);
  return (await pierre.resolveTheme(name as never)).textmate as Theme;
}
const foregrounds = (theme: Theme): string[] =>
  [...new Set([theme.fg, ...(theme.settings ?? []).map((rule) => rule.settings?.foreground)].filter((c): c is string => typeof c === 'string').map((c) => c.slice(0, 7).toLowerCase()))];

const SAMPLES: Record<string, string> = {
  python: '# a comment\n@dataclass\nclass Point:\n    x: int = 0\n    def norm(self, p=2.5) -> float:\n        return (self.x ** p) ** (1 / p) if self.x else None  # "done"\n',
  typescript: '// a comment\nexport const total = (items: number[]): number => items.reduce((a, b) => a + b, 0);\nconst re = /a+b?/g; let s = `n=${total([1, 2])}\\n`;\nenum Mode { On = 1, Off = 0 }\n',
  json: '{\n  "name": "plannotator",\n  "version": 1.5,\n  "private": true,\n  "tags": ["a", null]\n}\n',
  css: '/* a comment */\n.card:hover > a[href^="http"] {\n  color: #08c0ef;\n  margin: 0 auto !important;\n  --gap: calc(1rem + 2px);\n}\n',
  bash: '#!/usr/bin/env bash\n# a comment\nfor f in "$@"; do\n  echo "file: ${f}" | grep -E \'^a\' && exit 0\ndone\n',
  diff: 'diff --git a/x.ts b/x.ts\n@@ -1,3 +1,3 @@\n-const a = 1;\n+const a = 2;\n context line\n',
};

afterEach(() => {
  __resetCodeHighlightCacheForTests();
});

describe('the fences\' default code colours', () => {
  for (const half of ['light', 'dark'] as const) {
    test(`${half}: every token colour of the theme reads at least 4.5:1 on its background and on Plannotator's code block`, async () => {
      // The theme file was read: a light block in light, a dark one in dark.
      expect(half === 'light' ? luminance(CODE_BLOCK[half]) > 0.6 : luminance(CODE_BLOCK[half]) < 0.05).toBe(true);
      const theme = await resolved(FENCE_SYNTAX_THEME[half]);
      const colours = foregrounds(theme);
      expect(colours.length).toBeGreaterThan(10);
      const low = colours
        .map((c) => ({ c, own: contrast(c, theme.bg ?? CODE_BLOCK[half]), block: contrast(c, CODE_BLOCK[half]) }))
        .filter((r) => Math.min(r.own, r.block) < 4.5);
      expect(low).toEqual([]);
    });

    test(`${half}: only lightness moves; the hue stays, and a colour that read well is Pierre's own`, async () => {
      const base = await resolved(FENCE_BASE_THEME[half]);
      for (const [from, to] of Object.entries(FENCE_COLOR_FIXES[half])) {
        // Every fix names a colour Pierre's theme really has, which really read below 4.5:1.
        expect(foregrounds(base)).toContain(from);
        expect(Math.min(contrast(from, base.bg!), contrast(from, CODE_BLOCK[half]))).toBeLessThan(4.5);
        const a = hueOf(from);
        const b = hueOf(to);
        if (a.c > 0.02) expect(Math.abs(((a.h - b.h + 540) % 360) - 180)).toBeLessThan(1.5);
        else expect(b.c).toBeLessThan(0.02); // a grey stays grey
        // Darker on a light block, lighter on a dark one.
        expect(half === 'light' ? luminance(to) < luminance(from) : luminance(to) > luminance(from)).toBe(true);
      }
      const theme = await resolved(FENCE_SYNTAX_THEME[half]);
      const kept = foregrounds(base).filter((c) => !(c in FENCE_COLOR_FIXES[half]));
      for (const c of kept) expect(foregrounds(theme)).toContain(c);
    });

    test(`${half}: a page's fences in python, ts, json, css, bash and diff draw no token under 4.5:1`, async () => {
      // The default palette's fence theme, as every fence resolves it.
      const name = resolveFenceTheme('plannotator', half);
      const seen = new Set<string>();
      for (const [lang, code] of Object.entries(SAMPLES)) {
        expect(await ensureHighlight(lang, name)).toBe(true);
        const html = highlightToHtml(code, lang, name);
        expect(html).not.toBeNull();
        for (const match of html!.matchAll(/color:\s*(#[0-9a-f]{6})/gi)) seen.add(match[1]!.toLowerCase());
      }
      expect(seen.size).toBeGreaterThan(5);
      const low = [...seen].filter((c) => contrast(c, CODE_BLOCK[half]) < 4.5).map((c) => `${c} ${contrast(c, CODE_BLOCK[half]).toFixed(2)}:1`);
      expect(low).toEqual([]);
    });
  }
});
