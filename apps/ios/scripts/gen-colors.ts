/**
 * The app's colours, generated from Plannotator's theme.
 *
 * Reads `packages/ui/themes/plannotator.css` (the dark `.theme-plannotator`
 * block and the `.theme-plannotator.light` block), converts each oklch token
 * the app uses to sRGB, and writes one colour set per token, with a light and
 * a dark appearance, into `apps/ios/Plannotator/Colors.xcassets`.
 *
 *   bun apps/ios/scripts/gen-colors.ts           # write the asset catalog
 *   bun apps/ios/scripts/gen-colors.ts --check   # exit 1 when it has drifted
 *
 * The iPhone record (`.product/approved/plannotator-mobile-iphone-2026-10-07/`)
 * draws the question card a half step between the card and the ground (a mix
 * of two theme tokens), and a plain screen and a raised row that take one
 * token in light and another in dark (white screens with grey rows in light,
 * as iOS draws them; the theme's dark ground with its card rows in dark).
 * Every other colour is a theme token as it is.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const cssPath = join(repo, 'packages/ui/themes/plannotator.css');
const catalog = join(repo, 'apps/ios/Plannotator/Colors.xcassets');

type Oklch = { l: number; c: number; h: number };
type Source = { token: string } | { mix: [string, string]; amount: number } | { light: string; dark: string };

/** The app's colour name, and the theme token (or mix) it comes from. */
const COLORS: Record<string, Source> = {
  Tint: { token: 'primary' },
  OnTint: { token: 'primary-foreground' },
  Ground: { token: 'background' },
  Card: { token: 'card' },
  Ink: { token: 'foreground' },
  InkSecondary: { token: 'muted-foreground' },
  Fill: { token: 'muted' },
  Hairline: { token: 'border' },
  Success: { token: 'success' },
  Destructive: { token: 'destructive' },
  QuestionCard: { mix: ['card', 'background'], amount: 0.5 },
  Screen: { light: 'card', dark: 'background' },
  Raised: { light: 'background', dark: 'card' },
};

function block(css: string, selector: string): Record<string, Oklch> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} not found in ${cssPath}`);
  const body = css.slice(start, css.indexOf('}', start));
  const out: Record<string, Oklch> = {};
  for (const m of body.matchAll(/--([a-z-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g)) {
    out[m[1]!] = { l: Number(m[2]), c: Number(m[3]), h: Number(m[4]) };
  }
  return out;
}

/** oklch to gamma-encoded sRGB, clamped (Björn Ottosson's OKLab matrices). */
function srgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const encode = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return linear.map(encode) as [number, number, number];
}

function resolveColor(tokens: Record<string, Oklch>, source: Source, name: string, appearance: 'light' | 'dark'): [number, number, number] {
  const read = (token: string) => {
    const value = tokens[token];
    if (!value) throw new Error(`${name}: --${token} is missing from ${cssPath}`);
    return value;
  };
  if ('token' in source) return srgb(read(source.token));
  if ('light' in source) return srgb(read(source[appearance]));
  const [x, y] = source.mix.map(read) as [Oklch, Oklch];
  const t = source.amount;
  return srgb({ l: x.l * (1 - t) + y.l * t, c: x.c * (1 - t) + y.c * t, h: x.h * (1 - t) + y.h * t });
}

function colorset(light: [number, number, number], dark: [number, number, number]): string {
  const entry = (rgb: [number, number, number], appearance?: string) => ({
    ...(appearance ? { appearances: [{ appearance: 'luminosity', value: appearance }] } : {}),
    color: {
      'color-space': 'srgb',
      components: { alpha: '1.000', red: rgb[0].toFixed(3), green: rgb[1].toFixed(3), blue: rgb[2].toFixed(3) },
    },
    idiom: 'universal',
  });
  return `${JSON.stringify({ colors: [entry(light), entry(dark, 'dark')], info: { author: 'xcode', version: 1 } }, null, 2)}\n`;
}

function generate(): Map<string, string> {
  const css = readFileSync(cssPath, 'utf8');
  const dark = block(css, '.theme-plannotator');
  const light = { ...dark, ...block(css, '.theme-plannotator.light') };
  const files = new Map<string, string>();
  files.set('Contents.json', `${JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2)}\n`);
  for (const [name, source] of Object.entries(COLORS)) {
    files.set(`${name}.colorset/Contents.json`, colorset(resolveColor(light, source, name, 'light'), resolveColor(dark, source, name, 'dark')));
  }
  return files;
}

function onDisk(): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(catalog)) return files;
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else files.set(rel, readFileSync(join(dir, entry.name), 'utf8'));
    }
  };
  walk(catalog, '');
  return files;
}

const want = generate();
if (process.argv.includes('--check')) {
  const have = onDisk();
  const drift = [...new Set([...want.keys(), ...have.keys()])].filter((k) => want.get(k) !== have.get(k));
  if (drift.length > 0) {
    process.stderr.write(`Colors.xcassets has drifted from packages/ui/themes/plannotator.css: ${drift.join(', ')}\nRun: bun apps/ios/scripts/gen-colors.ts\n`);
    process.exit(1);
  }
  process.stdout.write(`Colors.xcassets matches plannotator.css (${want.size - 1} colours).\n`);
} else {
  rmSync(catalog, { recursive: true, force: true });
  for (const [rel, text] of want) {
    mkdirSync(dirname(join(catalog, rel)), { recursive: true });
    writeFileSync(join(catalog, rel), text);
  }
  process.stdout.write(`Wrote ${want.size - 1} colours to ${catalog}\n`);
}
