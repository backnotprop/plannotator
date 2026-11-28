/**
 * Tag rows on every shipped theme (review of #3553, M2). What this catches: a pick whose row makes the row's text
 * (body or quiet grey) harder to read than on that theme's plain row in the same state (rest, hover, selected,
 * selected under the pointer), or under 4.5:1 where the plain row has 4.5:1; a theme file the walk silently skips; the
 * default theme drifting from the approved table. Reads the theme files only; real WCAG math.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INBOX_TAG_SWATCHES } from '@plannotator/core/inbox-types';
import { hexToOklch, hsvToHex, oklchToHex, tintLook, TINT_BANDS } from './tagColourMap';
import { themeSupportsHalf } from '@plannotator/ui/utils/themeRegistry';
import { contrast, DEFAULT_TINT_THEMES, hexRgb, over, plainFills, rgbHex, TINT_AA, tintRows, type Rgb, type TintTheme } from './tagTintTheme';

const DIR = join(import.meta.dir, '../ui/themes');

/** A theme token as the browser paints it over the card: hex (with alpha), oklch() or rgb(). */
function colourOf(value: string, card?: Rgb): Rgb | null {
  const v = value.trim();
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (m) return m[2] && card ? over(hexRgb(`#${m[1]}`), parseInt(m[2], 16) / 255, card) : hexRgb(`#${m[1]}`);
  m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
  if (m) return hexRgb(oklchToHex(Number(m[1]) / (m[2] ? 100 : 1), Number(m[3]), Number(m[4])));
  m = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/** A theme file's rules: each selector in a rule's list, with the rule's tokens. */
function rulesOf(text: string): { selectors: string[]; tokens: Map<string, string> }[] {
  return [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(',').map((s) => s.trim()),
    tokens: new Map([...m[2]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((t) => [t[1]!, t[2]!.trim()])),
  }));
}

/**
 * Every half a theme file can be shown in (a one-half palette only in its own), its tokens as the cascade gives them
 * (the `.light` rule over the base one), and the plain row's fills as inbox.css draws them (today's look).
 */
function themes(): { name: string; theme: TintTheme }[] {
  const out: { name: string; theme: TintTheme }[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.css')).sort()) {
    const id = file.slice(0, -4);
    const rules = rulesOf(readFileSync(join(DIR, file), 'utf8'));
    for (const mode of ['dark', 'light'] as const) {
      if (!themeSupportsHalf(id, mode)) continue;
      const tokens = new Map<string, string>();
      for (const selector of mode === 'dark' ? [`.theme-${id}`] : [`.theme-${id}`, `.theme-${id}.light`])
        for (const rule of rules) if (rule.selectors.includes(selector)) for (const [k, v] of rule.tokens) tokens.set(k, v);
      const card = colourOf(tokens.get('card') ?? '');
      if (!card) throw new Error(`${file} ${mode}: card ${tokens.get('card')}`);
      const [fg, muted, mutedFill, primary] = ['foreground', 'muted-foreground', 'muted', 'primary'].map((t) => colourOf(tokens.get(t) ?? '', card));
      if (!fg || !muted || !mutedFill || !primary) throw new Error(`${file} ${mode}: a token the walk cannot read`);
      out.push({ name: `${id} ${mode}`, theme: { card, fg, muted, plain: plainFills(card, mutedFill, primary, mode === 'light') } });
    }
  }
  return out;
}

const PICKS = [...INBOX_TAG_SWATCHES.map((s) => s.hex)];
for (let h = 0; h < 360; h += 30) for (let s = 0; s <= 100; s += 25) for (let v = 0; v <= 100; v += 25) PICKS.push(hsvToHex(h, s / 100, v / 100));

test('on every theme file, light and dark, a tinted row is never harder to read than the plain row in that state, and keeps 4.5:1 where it does', () => {
  const all = themes();
  // Every theme file is read (a file the walk cannot read throws above), each in every half it can be shown in.
  expect(all.length).toBeGreaterThan(readdirSync(DIR).filter((f) => f.endsWith('.css')).length * 1.5);
  const failures: string[] = [];
  for (const { name, theme } of all) {
    const floor = theme.plain.map((p) => [theme.fg, theme.muted].map((t) => Math.min(TINT_AA, contrast(t, p))));
    for (const pick of PICKS) {
      const { fills } = tintRows(pick, theme);
      fills.forEach((fill, state) =>
        [theme.fg, theme.muted].forEach((text, role) => {
          const got = contrast(text, hexRgb(fill));
          if (got < floor[state]![role]! - 1e-9) failures.push(`${name} ${pick} state ${state} ${role ? 'quiet' : 'body'}: ${got.toFixed(2)} < ${floor[state]![role]!.toFixed(2)}`);
        }),
      );
    }
  }
  expect(failures.slice(0, 10)).toEqual([]);
});

test('a theme that can show colour keeps it: on most themes a vivid swatch is still clearly its hue', () => {
  // As vivid as the theme allows: a row is moved only in lightness, so hue and chroma stay wherever sRGB has them.
  let coloured = 0;
  const all = themes();
  for (const { theme } of all) {
    const { fills } = tintRows('#047df1', theme);
    const row = hexToOklch(fills[0]);
    if (row.c > 0.02 && Math.abs(((row.h - hexToOklch('#047df1').h + 540) % 360) - 180) < 8) coloured++;
  }
  expect(coloured / all.length).toBeGreaterThan(0.8);
});

test('the default theme draws the approved table: every target holds, at the approved lightness', () => {
  for (const mode of ['light', 'dark'] as const) {
    const theme = DEFAULT_TINT_THEMES[mode];
    const card = hexToOklch(rgbHex(theme.card)).l;
    for (const pick of PICKS) {
      const { fills, exact } = tintRows(pick, theme);
      expect({ pick, mode, exact }).toEqual({ pick, mode, exact: true });
      const look = tintLook(pick);
      fills.forEach((fill, state) => expect(Math.abs(hexToOklch(fill).l - (card + look[mode].delta + TINT_BANDS[mode].steps[state]!))).toBeLessThan(0.006));
    }
  }
});
