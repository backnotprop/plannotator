/**
 * A person's own theme, as a file (`plannotator theme add <file>`).
 *
 * The format is Plannotator's: one small JSON object per theme, carrying an id,
 * a name, and for each half it supports (`dark`, `light`, or both) the colour
 * tokens the built-in CSS themes set (`packages/ui/themes/<id>.css`), written
 * without the leading `--`:
 *
 *   { "plannotatorTheme": 1, "id": "signal", "name": "Signal",
 *     "dark": { "background": "#0b0e14", "foreground": "#d7dce2", ... },
 *     "light": { ... } }
 *
 * A token left out takes the built-in Plannotator theme's value for that half
 * (DEFAULT_THEME_TOKENS), so a partial file still renders. Fonts and radius are
 * the app's, never the file's.
 *
 * The values end up in a stylesheet, so they are untrusted input: a value is
 * accepted only when the whole string is one colour in a closed grammar (hex,
 * rgb()/rgba(), hsl()/hsla(), oklch(), numbers and spaces only). Nothing else
 * can pass: no url(), var(), calc(), quotes, backslashes, semicolons, braces or
 * line breaks. themeFileCss() checks every value again as it writes.
 *
 * Browser-safe (no node imports): the CLI, the servers and the UI all use it.
 */

/** The colour tokens a theme sets, in the order the built-in theme files list them. */
export const THEME_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'border',
  'input',
  'ring',
  'code-bg',
  'focus-highlight',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/**
 * Tokens a file may set but need not: with none, the app derives it from the
 * theme's own colours (`--accent-text` is `--accent` drawn as text, theme.css).
 */
export const OPTIONAL_THEME_TOKENS = ['accent-text'] as const;

export type OptionalThemeToken = (typeof OPTIONAL_THEME_TOKENS)[number];

export type ThemeTokens = Record<ThemeToken, string> & Partial<Record<OptionalThemeToken, string>>;

export type ThemeFileHalf = 'dark' | 'light';

/**
 * One code colour rule, a VS Code / TextMate `tokenColors` entry flattened:
 * the scopes it colours (a string, comma-separated as TextMate allows, or a
 * list) and at least one of a text colour, a background and a font style.
 */
export interface ThemeSyntaxRule {
  scope: string | string[];
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

/** One half as written: its colours, and optionally its code colours (`syntax`). */
export type ThemeFileHalfTokens = Partial<ThemeTokens> & { syntax?: ThemeSyntaxRule[] };

/** A validated theme file. Each half is partial as written; `resolveThemeHalf` fills it. */
export interface ThemeFile {
  plannotatorTheme: 1;
  id: string;
  name: string;
  dark?: ThemeFileHalfTokens;
  light?: ThemeFileHalfTokens;
}

/** The marker key (and its one version) that says a JSON file is in this format. */
export const THEME_FILE_MARKER = 'plannotatorTheme';
export const THEME_FILE_VERSION = 1;

/** A theme id: what `packages/ui/themes` names its files and the Inbox's settings route accepts. */
export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The longest name a theme may have. */
export const THEME_NAME_MAX = 60;
/** The longest colour value accepted (the longest real one, `rgba(100%, 100%, 100%, 0.5)`, is about 30). */
export const THEME_COLOUR_MAX = 64;
/**
 * The largest theme file kept in the data dir. A theme's colours fit in 2 KB;
 * the rest is room for code colours: the largest well-known VS Code themes
 * carry a few hundred `tokenColors` rules, tens of KB a half, so two halves of
 * up to THEME_SYNTAX_RULES_MAX rules fit with room.
 */
export const THEME_FILE_MAX_BYTES = 256 * 1024;
/** The most code colour rules one half may carry (`syntax`). */
export const THEME_SYNTAX_RULES_MAX = 600;
/** The longest scope selector in a rule, and the most selectors one rule may list. */
export const THEME_SCOPE_MAX = 200;
export const THEME_SCOPES_PER_RULE_MAX = 100;
/** The font styles a code colour rule may set (VS Code's set; "" clears them). */
export const THEME_FONT_STYLES = ['italic', 'bold', 'underline', 'strikethrough'] as const;
/** The most custom themes one data dir holds. */
export const CUSTOM_THEME_LIMIT = 32;

/**
 * The 56 built-in palettes (`packages/ui/utils/themeRegistry.ts`'s ids; its test
 * keeps the two lists equal). A custom theme can never take one of these ids.
 */
export const BUILT_IN_THEME_IDS: readonly string[] = [
  'plannotator', 'plannotator-graphite', 'plannotator-modern', 'simple', 'claude-plus', 'adwaita', 'andromeeda',
  'aurora-x', 'ayu-dark', 'caffeine', 'catppuccin', 'cursor-hc', 'cursor', 'colorblind', 'tritanopia', 'dark-plus', 'doom-64',
  'dracula', 'everforest', 'everforest-hard', 'everforest-soft', 'github', 'gruvbox', 'houston', 'kanagawa-dragon',
  'kanagawa-lotus', 'kanagawa-wave', 'laserwave', 'material', 'cursor-midnight', 'min', 'monokai-pro', 'night-owl',
  'nightfox', 'nord', 'one-dark-pro', 'one-light', 'paulmillr', 'plastic', 'poimandres', 'quantum-rose', 'red', 'rose-pine',
  'slack', 'snazzy-light', 'soft-pop', 'solar-dusk', 'solarized', 'synthwave-84', 'terminal', 'tinacious',
  'tokyo-night', 'tokyo-night-moon', 'vesper', 'vitesse', 'vitesse-black', 'neutral',
];
/**
 * The built-ins that draw only one half (`modeSupport` in themeRegistry.ts; its
 * test keeps the two equal). Every other built-in draws both. `theme use`
 * reads it, so it never writes a half a page cannot draw.
 */
const BUILT_IN_DARK_ONLY: ReadonlySet<string> = new Set([
  'andromeeda', 'aurora-x', 'ayu-dark', 'cursor-hc', 'dracula', 'houston', 'kanagawa-dragon', 'kanagawa-wave',
  'laserwave', 'cursor-midnight', 'monokai-pro', 'night-owl', 'nightfox', 'nord', 'one-dark-pro', 'paulmillr', 'plastic',
  'poimandres', 'red', 'synthwave-84', 'terminal', 'tokyo-night-moon', 'vesper', 'vitesse-black',
]);
const BUILT_IN_LIGHT_ONLY: ReadonlySet<string> = new Set([
  'kanagawa-lotus', 'one-light', 'snazzy-light', 'tinacious',
]);

/** A built-in's mode support, as the registry says it; undefined for an id that is not a built-in. */
export function builtInThemeModeSupport(id: string): 'both' | 'dark-only' | 'light-only' | undefined {
  if (!BUILT_IN_THEME_IDS.includes(id)) return undefined;
  return BUILT_IN_DARK_ONLY.has(id) ? 'dark-only' : BUILT_IN_LIGHT_ONLY.has(id) ? 'light-only' : 'both';
}

/**
 * The built-in Plannotator theme's tokens (`packages/ui/themes/plannotator.css`),
 * per half: what a token a file leaves out becomes. Its light half sets no
 * `--focus-highlight` (it inherits the dark one), so the dark value is repeated.
 */
export const DEFAULT_THEME_TOKENS: Record<ThemeFileHalf, ThemeTokens> = {
  dark: {
    background: 'oklch(0.15 0.02 260)',
    foreground: 'oklch(0.90 0.01 260)',
    card: 'oklch(0.22 0.02 260)',
    'card-foreground': 'oklch(0.90 0.01 260)',
    popover: 'oklch(0.28 0.025 260)',
    'popover-foreground': 'oklch(0.90 0.01 260)',
    primary: 'oklch(0.75 0.18 280)',
    'primary-foreground': 'oklch(0.15 0.02 260)',
    secondary: 'oklch(0.65 0.15 180)',
    'secondary-foreground': 'oklch(0.15 0.02 260)',
    muted: 'oklch(0.26 0.02 260)',
    'muted-foreground': 'oklch(0.72 0.02 260)',
    accent: 'oklch(0.70 0.20 60)',
    'accent-foreground': 'oklch(0.15 0.02 260)',
    destructive: 'oklch(0.65 0.20 25)',
    'destructive-foreground': 'oklch(0.98 0 0)',
    success: 'oklch(0.72 0.17 150)',
    'success-foreground': 'oklch(0.15 0.02 260)',
    warning: 'oklch(0.75 0.15 85)',
    'warning-foreground': 'oklch(0.20 0.02 260)',
    border: 'oklch(0.35 0.02 260)',
    input: 'oklch(0.26 0.02 260)',
    ring: 'oklch(0.75 0.18 280)',
    'code-bg': 'oklch(0.26 0.02 260)',
    'focus-highlight': 'oklch(0.70 0.20 200)',
  },
  light: {
    background: 'oklch(0.97 0.005 260)',
    foreground: 'oklch(0.18 0.02 260)',
    card: 'oklch(1 0 0)',
    'card-foreground': 'oklch(0.18 0.02 260)',
    popover: 'oklch(1 0 0)',
    'popover-foreground': 'oklch(0.18 0.02 260)',
    primary: 'oklch(0.50 0.25 280)',
    'primary-foreground': 'oklch(1 0 0)',
    secondary: 'oklch(0.50 0.18 180)',
    'secondary-foreground': 'oklch(1 0 0)',
    muted: 'oklch(0.92 0.01 260)',
    'muted-foreground': 'oklch(0.40 0.02 260)',
    accent: 'oklch(0.60 0.22 50)',
    'accent-foreground': 'oklch(0.18 0.02 260)',
    destructive: 'oklch(0.50 0.25 25)',
    'destructive-foreground': 'oklch(1 0 0)',
    success: 'oklch(0.45 0.20 150)',
    'success-foreground': 'oklch(1 0 0)',
    warning: 'oklch(0.55 0.18 85)',
    'warning-foreground': 'oklch(0.18 0.02 260)',
    border: 'oklch(0.88 0.01 260)',
    input: 'oklch(0.92 0.01 260)',
    ring: 'oklch(0.50 0.25 280)',
    'code-bg': 'oklch(0.92 0.01 260)',
    'focus-highlight': 'oklch(0.70 0.20 200)',
  },
};

/** The app's fonts and radius (`plannotator.css`), written into every custom theme: a file never sets them. */
const APP_FONT_AND_RADIUS = [
  "--font-sans: 'Inter Variable', 'Inter', system-ui, sans-serif",
  "--font-mono: 'Geist Mono Variable', 'Geist Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  '--radius: 0.625rem',
];

// --- Colours ----------------------------------------------------------------
//
// A closed grammar. Every piece is a number, a percent, `deg`, a comma, a slash
// or a plain space; the function names are fixed. Anchored at both ends, so a
// value is one colour or it is refused.

const NUM = String.raw`-?(?:\d{1,4}(?:\.\d{1,8})?|\.\d{1,8})`;
const PCT = `${NUM}%`;
const NUM_OR_PCT = `(?:${NUM}%?)`;
const HUE = `(?:${NUM}(?:deg)?)`;
const SP = ' *';
const ALPHA_SLASH = `(?:${SP}/${SP}(${NUM_OR_PCT}))?`;
const ALPHA_COMMA = `(?:${SP},${SP}(${NUM_OR_PCT}))?`;

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COMMA_RE = new RegExp(`^rgba?\\(${SP}(${NUM_OR_PCT})${SP},${SP}(${NUM_OR_PCT})${SP},${SP}(${NUM_OR_PCT})${ALPHA_COMMA}${SP}\\)$`);
const RGB_SPACE_RE = new RegExp(`^rgba?\\(${SP}(${NUM_OR_PCT}) +(${NUM_OR_PCT}) +(${NUM_OR_PCT})${ALPHA_SLASH}${SP}\\)$`);
const HSL_COMMA_RE = new RegExp(`^hsla?\\(${SP}(${HUE})${SP},${SP}(${PCT})${SP},${SP}(${PCT})${ALPHA_COMMA}${SP}\\)$`);
const HSL_SPACE_RE = new RegExp(`^hsla?\\(${SP}(${HUE}) +(${PCT}) +(${PCT})${ALPHA_SLASH}${SP}\\)$`);
const OKLCH_RE = new RegExp(`^oklch\\(${SP}(${NUM_OR_PCT}) +(${NUM_OR_PCT}) +(${HUE})${ALPHA_SLASH}${SP}\\)$`);

/** True when `value` is exactly one colour this format accepts, and nothing else. */
export function isThemeColour(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > THEME_COLOUR_MAX) return false;
  return (
    HEX_RE.test(value) ||
    RGB_COMMA_RE.test(value) ||
    RGB_SPACE_RE.test(value) ||
    HSL_COMMA_RE.test(value) ||
    HSL_SPACE_RE.test(value) ||
    OKLCH_RE.test(value)
  );
}

/** An sRGB colour, each channel 0..1, with alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const num = (s: string) => Number.parseFloat(s);
const unitOrPct = (s: string, scale: number) => (s.endsWith('%') ? num(s) / 100 : num(s) / scale);
const alphaOf = (s: string | undefined) => (s === undefined ? 1 : clamp01(unitOrPct(s, 1)));
const hueOf = (s: string) => ((num(s) % 360) + 360) % 360;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function oklabToRgb(L: number, A: number, B: number): [number, number, number] {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** OKLab of an sRGB colour (alpha ignored). */
export function rgbToOklab({ r, g, b }: Rgba): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** The sRGB colour an OKLab triple names, clipped into gamut. */
export function oklabToRgba(L: number, A: number, B: number, alpha = 1): Rgba {
  const [r, g, b] = oklabToRgb(L, A, B);
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: alpha };
}

/** Parse a colour this format accepts; null for anything else. */
export function parseThemeColour(value: unknown): Rgba | null {
  if (!isThemeColour(value)) return null;
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
    const byte = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return { r: byte(0), g: byte(2), b: byte(4), a: hex.length === 8 ? byte(6) : 1 };
  }
  let m = RGB_COMMA_RE.exec(value) ?? RGB_SPACE_RE.exec(value);
  if (m) {
    return { r: clamp01(unitOrPct(m[1]!, 255)), g: clamp01(unitOrPct(m[2]!, 255)), b: clamp01(unitOrPct(m[3]!, 255)), a: alphaOf(m[4]) };
  }
  m = HSL_COMMA_RE.exec(value) ?? HSL_SPACE_RE.exec(value);
  if (m) {
    const [r, g, b] = hslToRgb(hueOf(m[1]!), clamp01(num(m[2]!) / 100), clamp01(num(m[3]!) / 100));
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: alphaOf(m[4]) };
  }
  m = OKLCH_RE.exec(value);
  if (m) {
    const L = clamp01(unitOrPct(m[1]!, 1));
    const C = Math.max(0, m[2]!.endsWith('%') ? (num(m[2]!) / 100) * 0.4 : num(m[2]!));
    const h = (hueOf(m[3]!) * Math.PI) / 180;
    return oklabToRgba(L, C * Math.cos(h), C * Math.sin(h), alphaOf(m[4]));
  }
  return null;
}

/** `#rrggbb` (or `#rrggbbaa` when not opaque) of an sRGB colour. */
export function rgbaToHex({ r, g, b, a }: Rgba): string {
  const byte = (n: number) => Math.round(clamp01(n) * 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a) : ''}`;
}

/** `top` drawn over `ground` (both sRGB; the result is opaque when the ground is). */
export function compositeOver(top: Rgba, ground: Rgba): Rgba {
  const a = top.a + ground.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, g: number) => (t * top.a + g * ground.a * (1 - top.a)) / a;
  return { r: mix(top.r, ground.r), g: mix(top.g, ground.g), b: mix(top.b, ground.b), a };
}

/** WCAG 2 relative luminance of an opaque sRGB colour. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2 contrast ratio of a text colour over a ground (a translucent text is drawn over the ground first). */
export function contrastRatio(text: Rgba, ground: Rgba): number {
  const solidGround = ground.a < 1 ? compositeOver(ground, { r: 1, g: 1, b: 1, a: 1 }) : ground;
  const solidText = text.a < 1 ? compositeOver(text, solidGround) : text;
  const a = relativeLuminance(solidText);
  const b = relativeLuminance(solidGround);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// --- Validation -------------------------------------------------------------

/** Why a theme file was refused: the field that is wrong (`dark.background`, `id`) and what is wrong with it. */
export interface ThemeFileProblem {
  field: string;
  message: string;
}

export type ThemeFileResult = { ok: true; theme: ThemeFile } | { ok: false; problem: ThemeFileProblem };

const KNOWN_TOKENS: ReadonlySet<string> = new Set<string>([...THEME_TOKENS, ...OPTIONAL_THEME_TOKENS]);
const SYNTAX_KEY = 'syntax';
const RULE_KEYS: ReadonlySet<string> = new Set(['scope', 'foreground', 'background', 'fontStyle']);
/**
 * A scope selector: TextMate scope names (`entity.name.function`), descendant
 * selectors with spaces, comma lists, and the selector operators `- > | & ( ) *`.
 * No quotes, brackets, braces, semicolons, slashes, `<`, `@`, `#` or control
 * characters; it is data for the highlighter, never markup or CSS.
 */
const SCOPE_RE = /^[A-Za-z0-9._ ,:>|&()*+-]+$/;
const SYNTAX_HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A code colour: hex only (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), as every VS Code and base16 theme writes them. */
export function isSyntaxColour(value: unknown): value is string {
  return typeof value === 'string' && SYNTAX_HEX_RE.test(value) && isThemeColour(value);
}

/** A font style: "" or space-separated, each of THEME_FONT_STYLES at most once. */
export function isSyntaxFontStyle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  const parts = value.split(' ');
  return parts.length <= THEME_FONT_STYLES.length && new Set(parts).size === parts.length && parts.every((p) => (THEME_FONT_STYLES as readonly string[]).includes(p));
}

/** One scope selector string. */
export function isSyntaxScope(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= THEME_SCOPE_MAX && SCOPE_RE.test(value) && /[A-Za-z]/.test(value);
}

/**
 * Validate a half's `syntax` list. Returns the rules as kept (only the four
 * known keys, every value checked) or the first problem, naming its field
 * (`dark.syntax[3].foreground`).
 */
export function validateSyntaxRules(value: unknown, field: string): { ok: true; rules: ThemeSyntaxRule[] } | { ok: false; problem: ThemeFileProblem } {
  const no = (f: string, message: string) => ({ ok: false as const, problem: { field: f, message } });
  if (!Array.isArray(value)) return no(field, 'a list of code colour rules, like [{ "scope": "comment", "foreground": "#6a737d" }].');
  if (value.length > THEME_SYNTAX_RULES_MAX) return no(field, `${value.length} rules; at most ${THEME_SYNTAX_RULES_MAX}.`);
  const rules: ThemeSyntaxRule[] = [];
  for (let i = 0; i < value.length; i++) {
    const at = `${field}[${i}]`;
    const rule = value[i];
    if (!isPlainObject(rule)) return no(at, 'a rule is an object: { "scope", "foreground", "background", "fontStyle" }.');
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) return no(`${at}.${key}`, 'not a rule field (scope, foreground, background, fontStyle).');
    }
    const { scope, foreground, background, fontStyle } = rule;
    const scopes = Array.isArray(scope) ? scope : [scope];
    if (scopes.length === 0 || scopes.length > THEME_SCOPES_PER_RULE_MAX || !scopes.every(isSyntaxScope)) {
      return no(`${at}.scope`, `${shown(Array.isArray(scope) ? scopes.find((x) => !isSyntaxScope(x)) ?? scope : scope)} is not a scope: letters, digits and . _ - , : > | & ( ) * + and spaces, at most ${THEME_SCOPE_MAX}; a list holds at most ${THEME_SCOPES_PER_RULE_MAX}.`);
    }
    const out: ThemeSyntaxRule = { scope: Array.isArray(scope) ? [...(scope as string[])] : (scope as string) };
    for (const [key, v] of [['foreground', foreground], ['background', background]] as const) {
      if (v === undefined) continue;
      if (!isSyntaxColour(v)) return no(`${at}.${key}`, `${shown(v)} is not a code colour. Use #rgb, #rrggbb or #rrggbbaa.`);
      out[key] = v;
    }
    if (fontStyle !== undefined) {
      if (!isSyntaxFontStyle(fontStyle)) return no(`${at}.fontStyle`, `${shown(fontStyle)} is not a font style: "", or any of ${THEME_FONT_STYLES.join(', ')} separated by spaces.`);
      out.fontStyle = fontStyle;
    }
    if (out.foreground === undefined && out.background === undefined && out.fontStyle === undefined) {
      return no(at, 'a rule sets a foreground, a background or a fontStyle.');
    }
    rules.push(out);
  }
  return { ok: true, rules };
}
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([THEME_FILE_MARKER, 'id', 'name', 'dark', 'light']);
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/**
 * Characters that change how a name reads without being seen: the bidi marks,
 * embeddings, overrides and isolates (a name could print its letters in
 * another order in `theme list`), the invisible spaces and joiners other than
 * ZWJ and ZWNJ (which emoji sequences and Persian need), the soft hyphen, the
 * combining grapheme joiner, the Mongolian vowel separator and the
 * interlinear annotation marks.
 */
export const INVISIBLE_NAME_CHARS = /[\u00ad\u034f\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g;

/** Show a refused value in a message: short, quoted, control characters visible. */
function shown(value: unknown): string {
  if (typeof value !== 'string') return value === null ? 'null' : Array.isArray(value) ? 'a list' : typeof value === 'object' ? 'an object' : String(value);
  const text = JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  return text;
}

const refuse = (field: string, message: string): ThemeFileResult => ({ ok: false, problem: { field, message } });

/** Is `id` a built-in palette's id? */
export function isBuiltInThemeId(id: string): boolean {
  return BUILT_IN_THEME_IDS.includes(id);
}

/**
 * Validate a parsed JSON value as a theme file in this format. Every key is
 * known, every value is the right kind, at least one half is present, each
 * colour is one colour (isThemeColour), and the id is a free, well-formed id.
 * The first problem found is returned, naming its field.
 */
export function validateThemeFile(input: unknown): ThemeFileResult {
  if (!isPlainObject(input)) return refuse('(file)', 'a theme file is one JSON object.');
  if (input[THEME_FILE_MARKER] !== THEME_FILE_VERSION) {
    return refuse(THEME_FILE_MARKER, `must be ${THEME_FILE_VERSION} (this says the file is a Plannotator theme).`);
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) return refuse(key, 'not a theme file field (plannotatorTheme, id, name, dark, light).');
  }
  const { id, name } = input;
  if (typeof id !== 'string' || !THEME_ID_PATTERN.test(id)) {
    return refuse('id', `${shown(id)} is not a theme id: lowercase letters, digits and dashes, starting with a letter or digit, at most 64.`);
  }
  if (isBuiltInThemeId(id)) return refuse('id', `"${id}" is a built-in theme; pick another id.`);
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > THEME_NAME_MAX || CONTROL_CHARS.test(name) || new RegExp(INVISIBLE_NAME_CHARS.source).test(name)) {
    return refuse('name', `${shown(name)} is not a theme name: 1 to ${THEME_NAME_MAX} characters on one line, with no invisible or text-direction characters.`);
  }
  const theme: ThemeFile = { plannotatorTheme: 1, id, name: name.trim() };
  for (const half of ['dark', 'light'] as const) {
    const tokens = input[half];
    if (tokens === undefined) continue;
    if (!isPlainObject(tokens)) return refuse(half, 'an object of colours, like { "background": "#101418" }.');
    const out: ThemeFileHalfTokens = {};
    for (const [key, value] of Object.entries(tokens)) {
      if (key === SYNTAX_KEY) {
        const checked = validateSyntaxRules(value, `${half}.${SYNTAX_KEY}`);
        if (!checked.ok) return { ok: false, problem: (checked as { problem: ThemeFileProblem }).problem };
        if ((checked as { rules: ThemeSyntaxRule[] }).rules.length > 0) out.syntax = (checked as { rules: ThemeSyntaxRule[] }).rules;
        continue;
      }
      if (!KNOWN_TOKENS.has(key)) {
        const hint = key.startsWith('--') && KNOWN_TOKENS.has(key.slice(2)) ? ` Write it without the leading --: "${key.slice(2)}".` : '';
        return refuse(`${half}.${key}`, `not a theme colour.${hint || ` The colours: ${THEME_TOKENS.join(', ')}, and optionally ${OPTIONAL_THEME_TOKENS.join(', ')}; code colours go in "syntax".`}`);
      }
      if (!isThemeColour(value)) {
        return refuse(`${half}.${key}`, `${shown(value)} is not a colour. Use #rrggbb, rgb(), hsl() or oklch() with plain numbers.`);
      }
      out[key as ThemeToken] = value;
    }
    theme[half] = out;
  }
  if (!theme.dark && !theme.light) return refuse('dark', 'a theme needs a "dark" half, a "light" half, or both.');
  return { ok: true, theme };
}

// --- Resolution and CSS -----------------------------------------------------

/** Which halves a theme draws, as the registry says it (`modeSupport`). */
export function themeFileModeSupport(theme: Pick<ThemeFile, 'dark' | 'light'>): 'both' | 'dark-only' | 'light-only' {
  if (theme.dark && theme.light) return 'both';
  return theme.dark ? 'dark-only' : 'light-only';
}

/** One half's full token table: the file's colours, and the default theme's for the rest (code colours are not tokens). */
export function resolveThemeHalf(tokens: ThemeFileHalfTokens | undefined, half: ThemeFileHalf): ThemeTokens {
  const { syntax: _syntax, ...colours } = tokens ?? {};
  return { ...DEFAULT_THEME_TOKENS[half], ...colours };
}

/** The halves whose code colours the file sets (`syntax`). */
export function themeSyntaxHalves(theme: Pick<ThemeFile, 'dark' | 'light'>): ThemeFileHalf[] {
  return (['dark', 'light'] as const).filter((half) => (theme[half]?.syntax?.length ?? 0) > 0);
}

/** One half's code colours as the page fetches them: its rules and the text and ground they sit on. */
export interface ThemeSyntaxHalf {
  foreground: string;
  background: string;
  rules: ThemeSyntaxRule[];
}

/** A theme's code colours, per half that has them (`/plannotator-themes.js?syntax=<id>`). */
export function themeSyntaxPayload(theme: ThemeFile): Partial<Record<ThemeFileHalf, ThemeSyntaxHalf>> {
  const out: Partial<Record<ThemeFileHalf, ThemeSyntaxHalf>> = {};
  for (const half of themeSyntaxHalves(theme)) {
    const tokens = resolveThemeHalf(theme[half], half);
    out[half] = { foreground: tokens.foreground, background: tokens.background, rules: theme[half]!.syntax! };
  }
  return out;
}

/**
 * The TextMate (VS Code / Shiki) theme one half's code colours make, checked
 * again (the page received it as data): every scope, colour and font style
 * passes the validators or the whole half is refused (null). The highlighter
 * colours whatever no rule names in the half's foreground.
 */
export function syntaxTextMateTheme(name: string, half: ThemeFileHalf, value: unknown): { name: string; type: ThemeFileHalf; colors: Record<string, string>; tokenColors: unknown[] } | null {
  if (!isPlainObject(value)) return null;
  const { foreground, background, rules } = value;
  if (!isThemeColour(foreground) || !isThemeColour(background)) return null;
  const checked = validateSyntaxRules(rules, 'syntax');
  if (!checked.ok) return null;
  const kept = (checked as { rules: ThemeSyntaxRule[] }).rules;
  const fg = isSyntaxColour(foreground) ? foreground : rgbaToHex(parseThemeColour(foreground)!);
  const bg = isSyntaxColour(background) ? background : rgbaToHex(parseThemeColour(background)!);
  return {
    name,
    type: half,
    colors: { 'editor.foreground': fg, 'editor.background': bg },
    tokenColors: [
      { settings: { foreground: fg, background: bg } },
      ...kept.map(({ scope, ...settings }) => ({ scope, settings })),
    ],
  };
}

/** The tokens a file left out of one half (they take the default theme's value). */
export function missingThemeTokens(tokens: Partial<ThemeTokens> | undefined): ThemeToken[] {
  return THEME_TOKENS.filter((token) => !tokens?.[token]);
}

/** One CSS block: every value checked again, so nothing but a colour is ever written. */
function cssBlock(selector: string, tokens: ThemeTokens): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(tokens)) {
    if (!KNOWN_TOKENS.has(key)) throw new Error(`theme css: ${key} is not a theme colour`);
    if (!isThemeColour(value)) throw new Error(`theme css: ${key} is not a colour`);
    lines.push(`  --${key}: ${value};`);
  }
  return `${selector} {\n${lines.join('\n')}\n}`;
}

/**
 * The stylesheet a theme file draws with: `.theme-<id>` (its dark half, or its
 * only half) and `.theme-<id>.light` (its light half when it has both), the
 * selectors the built-in themes use. Throws on anything that is not a valid
 * id or colour, so a value that slipped past validation never reaches a page.
 */
export function themeFileCss(theme: ThemeFile): string {
  if (!THEME_ID_PATTERN.test(theme.id) || isBuiltInThemeId(theme.id)) throw new Error(`theme css: bad id ${JSON.stringify(theme.id)}`);
  const base = `.theme-${theme.id}`;
  const app = `${base} {\n${APP_FONT_AND_RADIUS.map((line) => `  ${line};`).join('\n')}\n}`;
  if (theme.dark && theme.light) {
    return [app, cssBlock(base, resolveThemeHalf(theme.dark, 'dark')), cssBlock(`${base}.light`, resolveThemeHalf(theme.light, 'light'))].join('\n');
  }
  const only: ThemeFileHalf = theme.dark ? 'dark' : 'light';
  return [app, cssBlock(base, resolveThemeHalf(theme[only], only))].join('\n');
}

/** The five colours a picker tile draws for one half, as the registry holds them (`ThemeColors`). */
export interface ThemeSwatches {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  foreground: string;
}

/** A custom theme as the page's registry takes it: the same shape as a built-in's entry. */
export interface CustomThemeInfo {
  id: string;
  name: string;
  modeSupport: 'both' | 'dark-only' | 'light-only';
  colors: { dark: ThemeSwatches; light: ThemeSwatches };
  /** The halves with code colours of their own, fetched when code first renders. */
  syntax?: ThemeFileHalf[];
}

function swatchesOf(tokens: ThemeTokens): ThemeSwatches {
  return { primary: tokens.primary, secondary: tokens.secondary, accent: tokens.accent, background: tokens.background, foreground: tokens.foreground };
}

/** The registry entry for a theme file (a one-half theme shows the same swatches for both). */
export function customThemeInfo(theme: ThemeFile): CustomThemeInfo {
  const modeSupport = themeFileModeSupport(theme);
  const dark = theme.dark ? swatchesOf(resolveThemeHalf(theme.dark, 'dark')) : undefined;
  const light = theme.light ? swatchesOf(resolveThemeHalf(theme.light, 'light')) : undefined;
  const syntax = themeSyntaxHalves(theme);
  return { id: theme.id, name: theme.name, modeSupport, colors: { dark: (dark ?? light)!, light: (light ?? dark)! }, ...(syntax.length > 0 ? { syntax } : {}) };
}

/** Validate one registry entry as the page receives it (the page checks again: it is data from a script). */
export function isCustomThemeInfo(value: unknown): value is CustomThemeInfo {
  if (!isPlainObject(value)) return false;
  const { id, name, modeSupport, colors, syntax } = value;
  if (typeof id !== 'string' || !THEME_ID_PATTERN.test(id) || isBuiltInThemeId(id)) return false;
  if (syntax !== undefined && !(Array.isArray(syntax) && syntax.length <= 2 && syntax.every((h) => h === 'dark' || h === 'light'))) return false;
  if (typeof name !== 'string' || name.length === 0 || name.length > THEME_NAME_MAX) return false;
  if (modeSupport !== 'both' && modeSupport !== 'dark-only' && modeSupport !== 'light-only') return false;
  if (!isPlainObject(colors)) return false;
  return (['dark', 'light'] as const).every((half) => {
    const sw = colors[half];
    return isPlainObject(sw) && (['primary', 'secondary', 'accent', 'background', 'foreground'] as const).every((k) => isThemeColour(sw[k]));
  });
}

/** Contrast of the body text on the background, per half the theme has: what `theme add`'s note reads. */
export function bodyTextContrast(theme: ThemeFile): { half: ThemeFileHalf; ratio: number }[] {
  const out: { half: ThemeFileHalf; ratio: number }[] = [];
  for (const half of ['dark', 'light'] as const) {
    if (!theme[half]) continue;
    const tokens = resolveThemeHalf(theme[half], half);
    const fg = parseThemeColour(tokens.foreground);
    const bg = parseThemeColour(tokens.background);
    if (fg && bg) out.push({ half, ratio: contrastRatio(fg, bg) });
  }
  return out;
}

/** The WCAG AA ratio for body text. `theme add` notes (never refuses) a theme below it. */
export const BODY_TEXT_CONTRAST_NOTE_BELOW = 4.5;
