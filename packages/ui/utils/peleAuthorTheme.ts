/**
 * An author's colours under Pele: a diagram whose source names a Mermaid
 * theme or theme variables (`%%{init: {"theme": …, "themeVariables": {…}}}%%`,
 * or front matter `config:`) is drawn in those colours; with neither, the
 * person's Plannotator theme applies as before (`peleTheme.ts`).
 *
 * The same adapter shape as `peleTheme.ts`: Mermaid's colour names in, Pele's
 * colour variables out (`--pele-bg`, `-fg`, `-muted`, `-line`, `-surface`,
 * `-surface-alt`, `-border`, `-accent`, `-critical`, `-series-1..8`).
 *   - A theme name (default, dark, forest, neutral, base) starts from that
 *     theme's colours as Mermaid computes them (`MERMAID_THEMES`, checked
 *     against Mermaid itself in `peleAuthorTheme.dom.test.ts`).
 *   - Theme variables: under `base` (Mermaid's theme for custom colours) the
 *     colours an author does not give are derived from the ones they give as
 *     Mermaid's base theme derives them; under another theme, or with no
 *     theme (over the person's palette), each given colour replaces its own.
 *   - Every value must be a colour by the strict pattern labels use
 *     (`safeLabelColor`): nothing that can carry `url(`, `var(` or `;`.
 *     Unknown keys are ignored, and so is `themeCSS` (arbitrary CSS).
 * Pure; `readPeleAuthorTheme` reads nothing but the source.
 */
import { parseCssColor, toHex, type RgbColor } from './cssColor';
import { ensureContrast } from './mermaidTheme';
import { safeLabelColor } from './pele-labels';
import { PELE_SERIES_COUNT, PELE_TEXT_MIN, type PeleThemeVariables } from './peleTheme';

export const MERMAID_THEME_NAMES = ['default', 'dark', 'forest', 'neutral', 'base'] as const;
export type MermaidThemeName = (typeof MERMAID_THEME_NAMES)[number];

/** The Mermaid colours Pele draws with. */
const KEYS = [
  'background',
  'primaryTextColor',
  'titleColor',
  'lineColor',
  'mainBkg',
  'clusterBkg',
  'nodeBorder',
  'taskBkgColor',
  'critBkgColor',
  ...Array.from({ length: PELE_SERIES_COUNT }, (_, i) => `cScale${i}`),
] as const;
type Key = (typeof KEYS)[number];
type Colors = Record<Key, string>;

/** Mermaid 12.2's named themes, as its own theme classes compute them (hex). */
export const MERMAID_THEMES: Readonly<Record<MermaidThemeName, Readonly<Colors>>> = {
  default: { background: '#ffffff', primaryTextColor: '#131300', titleColor: '#333333', lineColor: '#333333', mainBkg: '#ececff', clusterBkg: '#ffffde', nodeBorder: '#9370db', taskBkgColor: '#8a90dd', critBkgColor: '#ff0000', cScale0: '#8686ff', cScale1: '#ffff78', cScale2: '#d7ff86', cScale3: '#c286ff', cScale4: '#ff86ff', cScale5: '#ff86c2', cScale6: '#ff8686', cScale7: '#ffc286' },
  dark: { background: '#333333', primaryTextColor: '#e0dfdf', titleColor: '#f9fffe', lineColor: '#d3d3d3', mainBkg: '#1f2020', clusterBkg: '#474949', nodeBorder: '#cccccc', taskBkgColor: '#595c5c', critBkgColor: '#e83737', cScale0: '#1f2020', cScale1: '#0b0000', cScale2: '#4d1037', cScale3: '#3f5258', cScale4: '#4f2f1b', cScale5: '#6e0a0a', cScale6: '#3b0048', cScale7: '#995a01' },
  forest: { background: '#ffffff', primaryTextColor: '#321b67', titleColor: '#333333', lineColor: '#000000', mainBkg: '#cde498', clusterBkg: '#cdffb2', nodeBorder: '#13540c', taskBkgColor: '#487e3a', critBkgColor: '#ff0000', cScale0: '#b9d970', cScale1: '#acff7f', cScale2: '#cde498', cScale3: '#84d970', cScale4: '#70d990', cScale5: '#70d9c5', cScale6: '#70b9d9', cScale7: '#7084d9' },
  neutral: { background: '#ffffff', primaryTextColor: '#111111', titleColor: '#333333', lineColor: '#666666', mainBkg: '#eeeeee', clusterBkg: '#fcfcfc', nodeBorder: '#999999', taskBkgColor: '#707070', critBkgColor: '#dd4422', cScale0: '#555555', cScale1: '#f4f4f4', cScale2: '#555555', cScale3: '#bbbbbb', cScale4: '#777777', cScale5: '#999999', cScale6: '#dddddd', cScale7: '#ffffff' },
  base: { background: '#f4f4f4', primaryTextColor: '#333333', titleColor: '#090600', lineColor: '#0b0b0b', mainBkg: '#fff4dd', clusterBkg: '#f6f9ff', nodeBorder: '#eeddbb', taskBkgColor: '#fff4dd', critBkgColor: '#ff0000', cScale0: '#ffcb5d', cScale1: '#cb5dff', cScale2: '#77a3ff', cScale3: '#e3ff5d', cScale4: '#92ff5d', cScale5: '#5dff7a', cScale6: '#5dffcb', cScale7: '#5de3ff' },
};

/** What a source asks for: a theme name, theme variables, or both. */
export interface AuthorTheme {
  readonly theme?: MermaidThemeName;
  readonly themeVariables: Readonly<Record<string, string>>;
}

// ------------------------------------------------------------------ reading

/** Mermaid's JSON-ish directive object (single quotes, bare keys, trailing commas) as JSON; strings are set aside first, so nothing inside one is touched. */
function parseLooseObject(text: string): unknown {
  const strings: string[] = [];
  const held = text.replace(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/gu, (_m, single: string | undefined, double: string | undefined) => {
    strings.push(single !== undefined ? JSON.stringify(single.replace(/\\'/gu, "'")) : `"${double ?? ''}"`);
    return `\u0000${strings.length - 1}\u0000`;
  });
  const json = held
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/gu, '$1"$2":')
    .replace(/,\s*([}\]])/gu, '$1')
    .replace(/\u0000(\d+)\u0000/gu, (_m, i: string) => strings[Number(i)] ?? '""');
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `config:` map of a front matter block: nested `key: value` lines, two levels deep is all a theme needs. */
function frontMatterConfig(source: string): Record<string, unknown> | null {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i += 1;
  if ((lines[i] ?? '').trim() !== '---') return null;
  const block: string[] = [];
  for (i += 1; i < lines.length && (lines[i] ?? '').trim() !== '---'; i += 1) block.push(lines[i] ?? '');
  const root: Record<string, unknown> = {};
  const stack: { indent: number; map: Record<string, unknown> }[] = [{ indent: -1, map: root }];
  for (const line of block) {
    const m = /^(\s*)([\w$-]+)\s*:\s*(.*?)\s*$/u.exec(line.replace(/\s+#.*$/u, ''));
    if (m === null) continue;
    const indent = (m[1] ?? '').length;
    while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) stack.pop();
    const parent = stack[stack.length - 1]?.map ?? root;
    const raw = m[3] ?? '';
    if (raw === '') {
      const child: Record<string, unknown> = {};
      parent[m[2] as string] = child;
      stack.push({ indent, map: child });
    } else {
      parent[m[2] as string] = /^(['"])(.*)\1$/u.exec(raw)?.[2] ?? raw;
    }
  }
  return isObject(root['config']) ? root['config'] : null;
}

/** Every `%%{init: …}%%` (or `initialize`) object of a source, in order. */
function initDirectives(source: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const match of source.matchAll(/%%\{([\s\S]*?)\}%%/gu)) {
    const body = /^\s*(?:init|initialize)\s*:\s*([\s\S]*)$/u.exec(match[1] ?? '')?.[1];
    if (body === undefined) continue;
    const parsed = parseLooseObject(body);
    if (isObject(parsed)) out.push(parsed);
  }
  return out;
}

/** The theme a source asks for, or null when it asks for none. Values that are not safe colours are dropped here. */
export function readPeleAuthorTheme(source: string): AuthorTheme | null {
  const configs = [frontMatterConfig(source), ...initDirectives(source)].filter(isObject);
  let theme: MermaidThemeName | undefined;
  const variables: Record<string, string> = {};
  for (const config of configs) {
    const name = typeof config['theme'] === 'string' ? config['theme'].trim().toLowerCase() : undefined;
    if (name !== undefined && (MERMAID_THEME_NAMES as readonly string[]).includes(name)) theme = name as MermaidThemeName;
    const given = config['themeVariables'];
    if (!isObject(given)) continue;
    for (const [key, value] of Object.entries(given)) {
      if (key === 'darkMode' && typeof value === 'boolean') variables[key] = String(value);
      const color = typeof value === 'string' ? safeLabelColor(value) : null;
      if (color !== null) variables[key] = color;
    }
  }
  if (theme === undefined && Object.keys(variables).length === 0) return null;
  return { ...(theme === undefined ? {} : { theme }), themeVariables: variables };
}

// ---------------------------------------------------------- Mermaid's base

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl({ r, g, b }: RgbColor): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

function fromHsl({ h, s, l }: Hsl): RgbColor {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const lig = Math.min(100, Math.max(0, l)) / 100;
  if (sat === 0) return { r: lig, g: lig, b: lig, a: 1 };
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const channel = (t0: number): number => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: channel(hue + 1 / 3), g: channel(hue), b: channel(hue - 1 / 3), a: 1 };
}

/** khroma's `adjust`: add to the hue, saturation and lightness channels, clamped. */
function adjust(color: string, by: Partial<Hsl>): string {
  const rgb = parseCssColor(color);
  if (rgb === undefined) return color;
  const hsl = toHsl(rgb);
  return toHex(fromHsl({ h: hsl.h + (by.h ?? 0), s: Math.min(100, Math.max(0, hsl.s + (by.s ?? 0))), l: Math.min(100, Math.max(0, hsl.l + (by.l ?? 0))) }));
}

function invert(color: string): string {
  const rgb = parseCssColor(color);
  return rgb === undefined ? color : toHex({ r: 1 - rgb.r, g: 1 - rgb.g, b: 1 - rgb.b });
}

/**
 * The colours Pele draws with, as Mermaid's base theme derives them from the
 * variables an author gives (`theme-base.js`, `updateColors`), for the keys
 * Pele reads; a given variable always wins.
 */
export function deriveBaseColors(given: Readonly<Record<string, string>>): Colors {
  const v = (key: string): string | undefined => given[key];
  const dark = v('darkMode') === 'true';
  const background = v('background') ?? '#f4f4f4';
  const primary = v('primaryColor') ?? '#fff4dd';
  const primaryText = v('primaryTextColor') ?? (dark ? '#eee' : '#333');
  const secondary = v('secondaryColor') ?? adjust(primary, { h: -120 });
  const tertiary = v('tertiaryColor') ?? adjust(primary, { h: 180, l: 5 });
  const border = v('primaryBorderColor') ?? (dark ? adjust(primary, { s: -40, l: 10 }) : adjust(primary, { s: -40, l: -10 }));
  const hues = [0, 0, 0, 30, 60, 90, 120, 150];
  const scale = hues.map((h, i) => {
    const own = v(`cScale${i}`);
    if (own !== undefined) return own;
    const base = i === 0 ? primary : i === 1 ? secondary : i === 2 ? tertiary : adjust(primary, { h });
    return adjust(base, { l: dark ? -75 : -25 });
  });
  const colors: Record<string, string> = {
    background,
    primaryTextColor: primaryText,
    titleColor: v('titleColor') ?? v('tertiaryTextColor') ?? invert(tertiary),
    lineColor: v('lineColor') ?? invert(background),
    mainBkg: v('mainBkg') ?? primary,
    clusterBkg: v('clusterBkg') ?? tertiary,
    nodeBorder: v('nodeBorder') ?? border,
    taskBkgColor: v('taskBkgColor') ?? primary,
    critBkgColor: v('critBkgColor') ?? 'red',
  };
  scale.forEach((color, i) => (colors[`cScale${i}`] = color));
  return colors as Colors;
}

/** A given variable over a named theme's colours: each replaces its own, with Mermaid's aliases (a node's fill is `primaryColor` unless `mainBkg` is given). */
function overlay(start: Readonly<Record<string, string>>, given: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...start };
  const alias: Readonly<Record<string, readonly string[]>> = {
    primaryColor: ['mainBkg', 'cScale0'],
    primaryBorderColor: ['nodeBorder'],
    tertiaryColor: ['clusterBkg'],
    tertiaryTextColor: ['titleColor'],
    textColor: ['primaryTextColor'],
  };
  for (const [key, targets] of Object.entries(alias)) {
    const value = given[key];
    if (value !== undefined) for (const target of targets) if (given[target] === undefined) out[target] = value;
  }
  for (const key of KEYS) if (given[key] !== undefined) out[key] = given[key] as string;
  return out;
}

// --------------------------------------------------------------- to Pele

/** Mermaid colours to Pele's variables (the adapter shape of `peleTheme.ts`). Muted text is moved toward the text colour only as far as it must to read. */
function toPele(colors: Readonly<Record<string, string>>): Record<`--pele-${string}`, string> {
  const out: Record<`--pele-${string}`, string> = {};
  const put = (name: `--pele-${string}`, key: string): void => {
    const value = colors[key];
    if (value !== undefined) out[name] = hexOr(value);
  };
  put('--pele-bg', 'background');
  put('--pele-fg', 'primaryTextColor');
  put('--pele-line', 'lineColor');
  put('--pele-surface', 'mainBkg');
  put('--pele-surface-alt', 'clusterBkg');
  put('--pele-border', 'nodeBorder');
  put('--pele-accent', 'taskBkgColor');
  put('--pele-critical', 'critBkgColor');
  for (let i = 0; i < PELE_SERIES_COUNT; i += 1) put(`--pele-series-${i + 1}`, `cScale${i}`);
  const muted = parseCssColor(colors['titleColor']);
  const fg = parseCssColor(out['--pele-fg']);
  const grounds = ['--pele-bg', '--pele-surface', '--pele-surface-alt'].map((name) => parseCssColor(out[name as `--pele-${string}`])).filter((c): c is RgbColor => c !== undefined);
  if (muted !== undefined && fg !== undefined) {
    out['--pele-muted'] = toHex(grounds.reduce((current, ground) => ensureContrast(current, ground, PELE_TEXT_MIN, [fg]), muted));
  } else if (out['--pele-fg'] !== undefined) {
    out['--pele-muted'] = out['--pele-fg'];
  }
  return out;
}

/** A colour as hex when it parses, else as given (a CSS name the parser does not list; it already passed the safe pattern). */
function hexOr(value: string): string {
  const parsed = parseCssColor(value);
  return parsed === undefined || parsed.a < 1 ? value : toHex(parsed);
}

/**
 * Pele's variables for a source's own theme, or null when it gives none.
 * `person` is the person's Plannotator theme (`readPeleThemeVariables`):
 * theme variables with no theme name go over it, as they go over the site's
 * theme under Mermaid. The person's font always stays.
 */
export function peleAuthorThemeVariables(source: string, person: PeleThemeVariables | null): PeleThemeVariables | null {
  const author = readPeleAuthorTheme(source);
  if (author === null) return null;
  const font = person?.['--pele-font'];
  const keep: Record<`--pele-${string}`, string> = font === undefined ? {} : { '--pele-font': font };
  if (author.theme === 'base') return { ...toPele(deriveBaseColors(author.themeVariables)), ...keep };
  if (author.theme !== undefined) return { ...toPele(overlay(MERMAID_THEMES[author.theme], author.themeVariables)), ...keep };
  // Variables alone: each given colour replaces its own over the person's palette.
  const given = toPele(overlay({}, author.themeVariables));
  if (author.themeVariables['titleColor'] === undefined && author.themeVariables['tertiaryTextColor'] === undefined) delete given['--pele-muted'];
  return { ...(person ?? {}), ...given };
}
