/**
 * tokens/tokens.json and generated/swift/Tokens.xcassets: the window's default
 * look (packages/ui/themes/plannotator.css, its dark and its light half) as
 * the app's colors, radius and font names.
 *
 *   bun scripts/mobile/tokens.ts [--check]
 *
 * Colors are converted from the CSS (oklch, hex) to Display P3, the space the
 * window's oklch colors are drawn in on an Apple screen, and also given as
 * sRGB hex (clipped) for anything that needs one. The catalog has one color
 * set per token, its universal entry the light half and a dark entry, so the
 * app follows the phone's appearance; Xcode makes `Color(.cardForeground)`
 * from `card-foreground`. The other themes come later.
 */
import { join, relative, resolve } from 'node:path';
import { OUT, cli, jsonText, readRepoText, type Output } from './lib';

/** The theme the app is drawn in today, and its file. */
const THEME = { id: 'plannotator', css: 'packages/ui/themes/plannotator.css' } as const;
/** The catalog's folder: one `<token>.colorset/Contents.json` per color. */
const CATALOG = 'apps/mobile/contract/generated/swift/Tokens.xcassets';
const REPO = resolve(import.meta.dir, '../..');
/**
 * A color set's file, from the repository. Written as one join of the catalog
 * folder, a name and `Contents.json`, so scripts/ci-affected.ts reads it as
 * "every color set's file" and selects the contract test when one changes.
 */
const colorSetFile = (name: string) => relative(REPO, join(REPO, CATALOG, `${name}.colorset`, 'Contents.json'));
const CATALOG_INFO = { info: { author: 'xcode', version: 1 } };

type Rgb = [number, number, number];

/** The declarations of one CSS block (`--name: value;`), by the block's selector. */
export function cssVars(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`tokens.ts: no block ${selector}`);
  const body = css.slice(at, css.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const clip = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 10000) / 10000;

/** oklch(L C h) or #rrggbb to linear sRGB. Null for anything else (a font, a length). */
export function linearSrgb(value: string): Rgb | null {
  const ok = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (ok) {
    const L = Number(ok[1]) / (ok[2] ? 100 : 1);
    const C = Number(ok[3]);
    const h = (Number(ok[4]) * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  }
  return null;
}

/** Linear sRGB to Display P3 (through XYZ, D65), gamma-encoded and clipped. */
export function displayP3(rgb: Rgb): Rgb {
  const [r, g, b] = rgb;
  const x = 0.4123907993 * r + 0.3575843394 * g + 0.1804807884 * b;
  const y = 0.2126390059 * r + 0.7151686788 * g + 0.0721923054 * b;
  const z = 0.0193308187 * r + 0.1191947798 * g + 0.9505321522 * b;
  const p = [
    2.4934969119 * x - 0.9313836179 * y - 0.4027107845 * z,
    -0.8294889696 * x + 1.7626640603 * y + 0.0236246858 * z,
    0.0358458302 * x - 0.0761723893 * y + 0.956884524 * z,
  ];
  return p.map((v) => round(clip(gamma(v)))) as Rgb;
}

export function srgbHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(clip(gamma(v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

type Color = { css: string; p3: Rgb; hex: string };

export function buildTokens(): { tokens: Record<string, unknown>; colors: Record<string, { dark: Color; light: Color }> } {
  const css = readRepoText(THEME.css);
  const dark = cssVars(css, `.theme-${THEME.id}`);
  const light = { ...dark, ...cssVars(css, `.theme-${THEME.id}.light`) };
  const colors: Record<string, { dark: Color; light: Color }> = {};
  const color = (value: string): Color | null => {
    const lin = linearSrgb(value);
    return lin ? { css: value, p3: displayP3(lin), hex: srgbHex(lin) } : null;
  };
  for (const name of Object.keys(dark)) {
    const d = color(dark[name]!);
    const l = color(light[name]!);
    if (d && l) colors[name] = { dark: d, light: l };
  }
  const rem = /^([\d.]+)rem$/.exec(dark.radius ?? '');
  const fonts = (value: string | undefined) => (value ?? '').split(',').map((f) => f.trim().replace(/^'|'$/g, '')).filter(Boolean);
  return {
    colors,
    tokens: {
      about: `GENERATED by scripts/mobile/tokens.ts from ${THEME.css}. Do not edit.`,
      theme: THEME.id,
      colors,
      /** CSS pixels (1rem = 16): the same number of points on a phone. */
      radius: rem ? Number(rem[1]) * 16 : null,
      fonts: { sans: fonts(dark['font-sans']), mono: fonts(dark['font-mono']) },
    },
  };
}

const component = (v: number) => v.toFixed(4);

function colorSet(c: { dark: Color; light: Color }): unknown {
  const entry = (x: Color, dark: boolean) => ({
    ...(dark ? { appearances: [{ appearance: 'luminosity', value: 'dark' }] } : {}),
    color: { 'color-space': 'display-p3', components: { alpha: '1.000', red: component(x.p3[0]), green: component(x.p3[1]), blue: component(x.p3[2]) } },
    idiom: 'universal',
  });
  return { colors: [entry(c.light, false), entry(c.dark, true)], ...CATALOG_INFO };
}

export function generateTokens(): Output[] {
  const { tokens, colors } = buildTokens();
  return [
    { path: OUT.tokens, text: jsonText(tokens) },
    { path: OUT.catalog, text: jsonText(CATALOG_INFO) },
    ...Object.entries(colors).map(([name, c]) => ({ path: colorSetFile(name), text: jsonText(colorSet(c)) })),
  ];
}

if (import.meta.main) cli('tokens', generateTokens);
