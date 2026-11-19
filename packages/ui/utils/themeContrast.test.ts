/**
 * Text contrast in every built-in theme (WCAG 2.x, 4.5:1 for body text), computed from the theme files as text.
 *
 * What regresses if this fails:
 * - a theme's solid text pairs fall below 4.5:1: text on its page, muted text, card and popover text, and the text
 *   on its primary, secondary, accent and destructive fills (a destructive button whose text is the fill's own red
 *   read at 1:1 in Simple and Neutral light);
 * - one of Plannotator's own themes (plannotator, -graphite, -modern) lets any text colour it draws on its page
 *   (links, red, amber, green, accent text) fall below 4.5:1;
 * - light muted text goes back to an editor's pale comment grey;
 * - placeholder text goes back to a faded colour (an alpha on the muted text, Tailwind's half-strength default).
 *
 * The pairs that already failed in third-party palettes when this guard was written are pinned in
 * themeContrastAllowList.json with their ratio: a new failure, or a pinned one getting worse, fails here; one that is
 * fixed must leave the list. Colours are clipped to sRGB per channel, as an sRGB screen shows out-of-gamut oklch.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compositeOver, contrastRatio, parseCssColor, type RgbColor } from './cssColor';
import { BUILT_IN_THEMES } from './themeRegistry';
import ALLOWED from './themeContrastAllowList.json';

const FLOOR = 4.5;
const UI = join(import.meta.dir, '..');
const OWN = new Set(['plannotator', 'plannotator-graphite', 'plannotator-modern']);

/** Solid text on its surface, checked in every theme. */
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
/** Coloured text on the page: in Plannotator's own themes too, with no exceptions. */
const OWN_PAIRS: readonly (readonly [string, string])[] = [
  ['--primary', '--background'],
  ['--destructive', '--background'],
  ['--warning', '--background'],
  ['--success', '--background'],
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
      for (const [fg, bg] of [...PAIRS, ...(OWN.has(theme.id) ? OWN_PAIRS : [])]) {
        const under = compositeOver(color(bg), page);
        rows.push({ theme: theme.id, mode, pair: `${fg} / ${bg}`, ratio: contrastRatio(compositeOver(color(fg), under), under) });
      }
    }
  }
  return rows;
}

const allowed = ALLOWED as { theme: string; mode: string; pair: string; ratio: number }[];
const key = (r: { theme: string; mode: string; pair: string }) => `${r.theme} ${r.mode} ${r.pair}`;

describe('built-in theme text contrast', () => {
  const rows = measure();
  const pinned = new Map(allowed.map((a) => [key(a), a.ratio]));

  test('every solid text pair reads at 4.5:1, or is a pinned third-party failure that has not got worse', () => {
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

  test('the allow-list holds only pairs that still fail, at the ratio they have, and never one of our own themes', () => {
    const now = new Map(rows.map((r) => [key(r), r.ratio]));
    for (const a of allowed) {
      expect(OWN.has(a.theme), key(a)).toBe(false);
      const ratio = now.get(key(a));
      expect(ratio, `${key(a)} is not a measured pair`).toBeDefined();
      expect(ratio!, `${key(a)} now reads at ${ratio!.toFixed(2)}: take it off the list`).toBeLessThan(FLOOR);
      expect(ratio!, `${key(a)} moved: update its pin`).toBeCloseTo(a.ratio, 2);
    }
  });

  test('muted text reads at 4.5:1 on the background in every light theme', () => {
    const light = rows.filter((r) => r.mode === 'light' && r.pair === '--muted-foreground / --background');
    expect(light.length).toBeGreaterThan(30);
    expect(light.filter((r) => r.ratio < FLOOR).map(key)).toEqual([]);
  });
});

describe('placeholder text', () => {
  test("the shared rule paints placeholders in the theme's solid muted text, over Tailwind's half-strength default", () => {
    const css = readFileSync(join(UI, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const base = /\n {2}::placeholder\s*\{([^}]*)\}/.exec(css);
    expect(base).not.toBeNull();
    expect(base![1]).toContain('color: var(--muted-foreground)');
    expect(base![1]).toContain('opacity: 1');
  });

  test('no field fades its placeholder below the muted text', async () => {
    const faded: string[] = [];
    const roots = ['packages', 'apps'];
    for (const root of roots) {
      for await (const file of new Bun.Glob('**/*.{tsx,ts,css}').scan({ cwd: join(UI, '..', '..', root) })) {
        if (file.includes('node_modules') || file.includes('/dist/') || file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
        const text = readFileSync(join(UI, '..', '..', root, file), 'utf8');
        for (const m of text.matchAll(/placeholder:text-muted-foreground\/\d+/g)) faded.push(`${root}/${file}: ${m[0]}`);
        for (const m of text.matchAll(/::placeholder[^{]*\{[^}]*\}/g)) {
          if (/var\(--muted-foreground\)/.test(m[0]) && /opacity:\s*0?\.\d|color-mix\(/.test(m[0])) faded.push(`${root}/${file}: ${m[0]}`);
        }
      }
    }
    expect(faded).toEqual([]);
  });
});
