/**
 * Text contrast in every built-in theme (WCAG 2.x), computed from the theme files as text.
 *
 * What regresses if this fails:
 * - a theme draws text that is not there: a foreground near-identical to its fill (below 1.5:1), as Simple and
 *   Neutral light's destructive buttons did (the text was the fill's own red, 1:1), or accent-coloured text on the
 *   page in an accent that is a pale fill;
 * - a light theme's muted text goes back below 4.5:1 on its background (an editor's pale comment grey);
 * - a light theme's muted text reads as strong as its body text or stronger, so the two no longer rank (raising
 *   muted text to 4.5:1 did this in themes whose body text sat near 4.5:1 too);
 * - any other solid text pair falls below 4.5:1 where it did not, or a pair already below gets worse.
 *
 * The pairs below 4.5:1 when this guard was written are pinned in themeContrastAllowList.json with their ratio: a
 * new one fails here, and one that is fixed must leave the list. Colours are clipped to sRGB per channel, as an sRGB
 * screen shows out-of-gamut oklch.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compositeOver, contrastRatio, parseCssColor, type RgbColor } from './cssColor';
import { BUILT_IN_THEMES } from './themeRegistry';
import ALLOWED from './themeContrastAllowList.json';

const FLOOR = 4.5;
/** Below this, text and what it sits on are near-identical: the text is not there. */
const INVISIBLE = 1.5;
const UI = join(import.meta.dir, '..');

/** Solid text on its surface. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['--foreground', '--background'],
  ['--muted-foreground', '--background'],
  ['--card-foreground', '--card'],
  ['--popover-foreground', '--popover'],
  ['--primary-foreground', '--primary'],
  ['--secondary-foreground', '--secondary'],
  ['--accent-foreground', '--accent'],
  ['--destructive-foreground', '--destructive'],
  ['--accent-text', '--background'],
];

/** The custom properties of the rule whose selector list names `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const d of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
  }
  return out;
}

interface Measured {
  theme: string;
  mode: 'dark' | 'light';
  pair: string;
  ratio: number;
}

/** Every offered theme-mode's pairs, as the page paints them: a translucent token over the page's background. */
function measure(): Measured[] {
  const rows: Measured[] = [];
  for (const theme of BUILT_IN_THEMES) {
    const css = readFileSync(join(UI, 'themes', `${theme.id}.css`), 'utf8');
    const dark = rule(css, `.theme-${theme.id}`);
    const modes = { dark, light: { ...dark, ...rule(css, `.theme-${theme.id}.light`) } };
    for (const mode of ['dark', 'light'] as const) {
      if ((theme.modeSupport === 'dark-only' && mode === 'light') || (theme.modeSupport === 'light-only' && mode === 'dark')) continue;
      // theme.css's :root default: accent text is the accent unless the theme sets its own.
      const tokens = { '--accent-text': modes[mode]['--accent'], ...modes[mode] };
      const color = (name: string): RgbColor => {
        const c = parseCssColor(tokens[name]);
        if (!c) throw new Error(`${theme.id} ${mode}: ${name} is missing or unreadable (${tokens[name]})`);
        return c;
      };
      const page = color('--background');
      for (const [fg, bg] of PAIRS) {
        const under = compositeOver(color(bg), page);
        rows.push({ theme: theme.id, mode, pair: `${fg} / ${bg}`, ratio: contrastRatio(compositeOver(color(fg), under), under) });
      }
    }
  }
  return rows;
}

const allowed = ALLOWED as { theme: string; mode: string; pair: string; ratio: number }[];
const key = (r: { theme: string; mode: string; pair: string }) => `${r.theme} ${r.mode} ${r.pair}`;
const lightMuted = (r: { mode: string; pair: string }) => r.mode === 'light' && r.pair === '--muted-foreground / --background';

describe('built-in theme text contrast', () => {
  const rows = measure();

  test('no theme draws text near-identical to what it sits on', () => {
    expect(rows.filter((r) => r.ratio < INVISIBLE).map((r) => `${key(r)} ${r.ratio.toFixed(2)}`)).toEqual([]);
  });

  test('muted text reads at 4.5:1 on the background in every light theme', () => {
    const light = rows.filter(lightMuted);
    expect(light.length).toBeGreaterThan(30);
    expect(light.filter((r) => r.ratio < FLOOR).map(key)).toEqual([]);
  });

  test('body text reads stronger than muted text in every light theme', () => {
    const at = new Map(rows.map((r) => [key(r), r.ratio]));
    const light = rows.filter(lightMuted);
    expect(light.length).toBeGreaterThan(30);
    const flat = light.filter((m) => at.get(key({ ...m, pair: '--foreground / --background' }))! <= m.ratio);
    expect(flat.map((m) => `${m.theme}: body ${at.get(key({ ...m, pair: '--foreground / --background' }))!.toFixed(2)}, muted ${m.ratio.toFixed(2)}`)).toEqual([]);
  });

  test('every other solid text pair reads at 4.5:1, or is pinned and has not got worse', () => {
    const pinned = new Map(allowed.map((a) => [key(a), a.ratio]));
    const fresh: string[] = [];
    const worse: string[] = [];
    for (const r of rows) {
      if (r.ratio >= FLOOR) continue;
      const pin = pinned.get(key(r));
      if (pin === undefined) fresh.push(`${key(r)} ${r.ratio.toFixed(2)}`);
      else if (r.ratio < pin - 0.005) worse.push(`${key(r)} ${r.ratio.toFixed(2)} (pinned ${pin})`);
    }
    expect(fresh).toEqual([]);
    expect(worse).toEqual([]);
  });

  test('the allow-list holds only pairs that still fail, at the ratio they have, and none the hard rules forbid', () => {
    const now = new Map(rows.map((r) => [key(r), r.ratio]));
    for (const a of allowed) {
      expect(lightMuted(a), `${key(a)}: light muted text has no exceptions`).toBe(false);
      expect(a.ratio, `${key(a)}: near-identical text has no exceptions`).toBeGreaterThanOrEqual(INVISIBLE);
      const ratio = now.get(key(a));
      expect(ratio, `${key(a)} is not a measured pair`).toBeDefined();
      expect(ratio!, `${key(a)} now reads at ${ratio!.toFixed(2)}: take it off the list`).toBeLessThan(FLOOR);
      expect(ratio!, `${key(a)} moved: update its pin`).toBeCloseTo(a.ratio, 2);
    }
  });
});
