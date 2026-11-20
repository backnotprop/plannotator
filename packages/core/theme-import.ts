/**
 * Theme files people already have, turned into Plannotator's theme format
 * (theme-file.ts): a base16 scheme (YAML or JSON) and a VS Code colour theme
 * (JSON, comments and trailing commas allowed). Pure functions: no network, no
 * file system. `plannotator theme add <file>` reads the file and calls
 * `importThemeText`, which detects the format.
 *
 * Both formats describe one half (a scheme is light or dark), so a converted
 * theme has one half. Every token is filled: what the source names is mapped,
 * the rest is derived from the mapped colours (a mix of two of them in OKLab,
 * or, for a fill's text, whichever of the theme's ground and text reads better
 * on it). The mapping tables are in docs/agent-guides/guides-and-shared-ui.md.
 */

import {
  BUILT_IN_THEME_IDS,
  compositeOver,
  INVISIBLE_NAME_CHARS,
  isSyntaxColour,
  isSyntaxFontStyle,
  isSyntaxScope,
  contrastRatio,
  oklabToRgba,
  parseThemeColour,
  rgbaToHex,
  rgbToOklab,
  THEME_FILE_MARKER,
  THEME_ID_PATTERN,
  THEME_NAME_MAX,
  THEME_SCOPES_PER_RULE_MAX,
  THEME_SYNTAX_RULES_MAX,
  type Rgba,
  type ThemeSyntaxRule,
  type ThemeFile,
  type ThemeFileHalf,
  type ThemeTokens,
} from './theme-file';

export type ThemeSourceFormat = 'plannotator' | 'base16' | 'vscode';

/** A converter's answer: the theme, or the field of the source that stopped it. */
export type ThemeConvertResult =
  | { ok: true; theme: ThemeFile; field?: undefined; message?: undefined; syntaxLeftOut?: number }
  | { ok: false; theme?: undefined; field: string; message: string; syntaxLeftOut?: undefined };

export type ThemeImportResult =
  | { ok: true; format: ThemeSourceFormat; theme: unknown; syntaxLeftOut?: number }
  | { ok: false; field: string; message: string };

// --- Parsing ----------------------------------------------------------------

/**
 * JSON with comments and trailing commas (what VS Code's theme files are).
 * Comments and commas are removed outside strings only; the rest is JSON.parse.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ',' && /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(text.slice(i + 1, i + 4097))) {
      // A trailing comma (before a closing brace or bracket, comments between allowed): dropped.
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

/**
 * The flat `key: value` pairs of a base16 YAML scheme, at any indent (so the
 * newer `palette:` block reads the same as the classic flat file). Quotes are
 * taken off; a ` #` comment outside quotes is dropped. Nothing else of YAML is
 * needed for a scheme.
 */
export function parseBase16Yaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const q = value[0]!;
      const end = value.indexOf(q, 1);
      value = end < 0 ? value.slice(1) : value.slice(1, end);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]!.toLowerCase()] = value;
  }
  return out;
}

// --- Colour helpers ---------------------------------------------------------

const solid = (c: Rgba, ground: Rgba) => (c.a < 1 ? compositeOver(c, ground) : c);

/** Mix two colours in OKLab: t = 0 is `a`, 1 is `b`. */
export function mixColours(a: Rgba, b: Rgba, t: number): Rgba {
  const [l1, a1, b1] = rgbToOklab(a);
  const [l2, a2, b2] = rgbToOklab(b);
  return oklabToRgba(l1 + (l2 - l1) * t, a1 + (a2 - a1) * t, b1 + (b2 - b1) * t);
}

/** Of the candidates, the one that reads best on `fill`. */
function bestTextOn(fill: Rgba, candidates: Rgba[]): Rgba {
  let best = candidates[0]!;
  let ratio = -1;
  for (const c of candidates) {
    const r = contrastRatio(c, fill);
    if (r > ratio) {
      best = c;
      ratio = r;
    }
  }
  return best;
}

const isDark = (ground: Rgba) => rgbToOklab(ground)[0] < 0.6;

/** Two surfaces whose lightness differs by less than the eye picks out at a glance. */
const SURFACE_STEP_MIN = 0.025;
const surfacesTooClose = (a: Rgba, b: Rgba) => Math.abs(rgbToOklab(a)[0] - rgbToOklab(b)[0]) < SURFACE_STEP_MIN;

/**
 * Every token of one half from the few colours a source names. `named` holds
 * what the source gave (opaque); the rest is derived from ground and text.
 */
function fillHalf(named: Partial<Record<keyof ThemeTokens, Rgba>>, ground: Rgba, text: Rgba): ThemeTokens {
  const step = (t: number) => mixColours(ground, text, t);
  const fallbackHue = (hex: string) => parseThemeColour(hex)!;
  const primary = named.primary ?? fallbackHue(isDark(ground) ? '#7aa2f7' : '#2e5cb8');
  const card = named.card ?? step(0.05);
  const popover = named.popover ?? step(0.09);
  // Code chips, tags and fields are muted surfaces drawn on cards: a muted the eye
  // cannot tell from the card (a source that names one colour for both) is taken a
  // step from the card toward the text. Code blocks and fields fall back to muted
  // the same way.
  const namedMuted = named.muted ?? step(0.08);
  const muted = surfacesTooClose(namedMuted, card) ? mixColours(card, text, 0.07) : namedMuted;
  const fills = {
    primary,
    secondary: named.secondary ?? fallbackHue(isDark(ground) ? '#5fb3b3' : '#1f7a7a'),
    accent: named.accent ?? fallbackHue(isDark(ground) ? '#e0a050' : '#b35c00'),
    destructive: named.destructive ?? fallbackHue(isDark(ground) ? '#e06c75' : '#c0392b'),
    success: named.success ?? fallbackHue(isDark(ground) ? '#98c379' : '#2e7d32'),
    warning: named.warning ?? fallbackHue(isDark(ground) ? '#e5c07b' : '#9a6700'),
  };
  const textOn = (fill: Rgba) => bestTextOn(fill, [ground, text]);
  const t: Record<keyof ThemeTokens, Rgba | undefined> = {
    background: ground,
    foreground: text,
    card,
    'card-foreground': named['card-foreground'] ?? text,
    popover,
    'popover-foreground': named['popover-foreground'] ?? text,
    primary: fills.primary,
    'primary-foreground': named['primary-foreground'] ?? textOn(fills.primary),
    secondary: fills.secondary,
    'secondary-foreground': named['secondary-foreground'] ?? textOn(fills.secondary),
    muted,
    'muted-foreground': named['muted-foreground'] ?? step(0.62),
    accent: fills.accent,
    'accent-foreground': named['accent-foreground'] ?? textOn(fills.accent),
    destructive: fills.destructive,
    'destructive-foreground': named['destructive-foreground'] ?? textOn(fills.destructive),
    success: fills.success,
    'success-foreground': named['success-foreground'] ?? textOn(fills.success),
    warning: fills.warning,
    'warning-foreground': named['warning-foreground'] ?? textOn(fills.warning),
    border: named.border ?? step(0.16),
    input: named.input && !surfacesTooClose(named.input, card) ? named.input : muted,
    ring: named.ring ?? primary,
    'code-bg': named['code-bg'] && !surfacesTooClose(named['code-bg'], card) ? named['code-bg'] : muted,
    'focus-highlight': named['focus-highlight'] ?? fills.secondary,
    'accent-text': named['accent-text'],
  };
  const out = {} as ThemeTokens;
  for (const [key, value] of Object.entries(t)) if (value) (out as Record<string, string>)[key] = rgbaToHex(solid(value, ground));
  return out;
}

/** A theme id from a name: lowercase, dashes, never a built-in's id (then `-custom` is added). */
export function themeIdFromName(name: string): string {
  let slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 57)
    .replace(/-+$/g, '');
  // A name with no Latin letter or digit (夜, Ночь, an emoji) still gets its own id: theme- and a hash of the name.
  if (!slug) slug = `theme-${nameHash(name)}`;
  if (BUILT_IN_THEME_IDS.includes(slug)) slug = `${slug}-custom`;
  return THEME_ID_PATTERN.test(slug) ? slug : `theme-${nameHash(name)}`;
}

/** Eight hex digits of a name (FNV-1a over its UTF-16 code units): stable, so re-adding the same theme finds it again. */
function nameHash(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const cleanName = (name: unknown, fallback: string): string => {
  // A converted theme's name is the source's: control characters become spaces, invisible ones are dropped.
  const text = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(INVISIBLE_NAME_CHARS, '').trim() : '';
  return (text || fallback).slice(0, THEME_NAME_MAX).trim();
};

// --- base16 -----------------------------------------------------------------

const BASE16_KEYS = ['base00', 'base01', 'base02', 'base03', 'base04', 'base05', 'base06', 'base07', 'base08', 'base09', 'base0a', 'base0b', 'base0c', 'base0d', 'base0e', 'base0f'] as const;

/** The base16 colours of a parsed source (flat, or under `palette`), keys lowercased. */
function base16Palette(source: Record<string, unknown>): Record<string, unknown> | null {
  const lower = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  const flat = lower(source);
  if (BASE16_KEYS.some((k) => k in flat)) return flat;
  const palette = flat.palette;
  if (palette && typeof palette === 'object' && !Array.isArray(palette)) return lower(palette as Record<string, unknown>);
  return null;
}

/**
 * A base16 scheme as a Plannotator theme (one half: dark when its ground is
 * darker than its text, or as its `variant` says).
 *
 * | token | base16 |
 * | background | base00 · foreground base05 · card base01 · popover base01→base02 (half way) |
 * | muted, input, code-bg | base01→base02 (half way) · muted-foreground base04 · border base02 |
 * | primary, ring | base0D (blue) · secondary base0C (cyan) · accent base09 (orange) |
 * | destructive | base08 (red) · success base0B (green) · warning base0A (yellow) · focus-highlight base0C |
 * | each fill's text | base00 or base05, whichever reads better on it |
 */
export function base16ToThemeFile(source: Record<string, unknown>): ThemeConvertResult {
  const palette = base16Palette(source);
  if (!palette) return { ok: false, field: 'base00', message: 'a base16 scheme needs base00 to base0F.' };
  const colours: Record<string, Rgba> = {};
  for (const key of BASE16_KEYS) {
    const raw = palette[key];
    const hex = typeof raw === 'string' ? (raw.startsWith('#') ? raw : `#${raw}`) : '';
    const parsed = /^#[0-9a-fA-F]{6}$/.test(hex) ? parseThemeColour(hex) : null;
    if (!parsed) return { ok: false, field: key, message: `${raw === undefined ? 'missing' : JSON.stringify(raw)}: a base16 colour is six hex digits.` };
    colours[key] = parsed;
  }
  const c = (k: (typeof BASE16_KEYS)[number]) => colours[k]!;
  const variant = String(palette.variant ?? '').toLowerCase();
  const half: ThemeFileHalf = variant === 'light' || variant === 'dark' ? variant : isDark(c('base00')) ? 'dark' : 'light';
  const name = cleanName(palette.name ?? palette.scheme, 'Imported base16 theme');
  const tokens = fillHalf(
    {
      card: c('base01'),
      popover: mixColours(c('base01'), c('base02'), 0.5),
      // Muted sits a step above the card (as in Plannotator's own palette): code chips,
      // tags and fields are drawn on cards, so base01 for both would make them vanish.
      muted: mixColours(c('base01'), c('base02'), 0.5),
      'muted-foreground': c('base04'),
      primary: c('base0d'),
      secondary: c('base0c'),
      accent: c('base09'),
      destructive: c('base08'),
      success: c('base0b'),
      warning: c('base0a'),
      border: c('base02'),
      ring: c('base0d'),
      'focus-highlight': c('base0c'),
    },
    c('base00'),
    c('base05'),
  );
  const hex = (k: (typeof BASE16_KEYS)[number]) => rgbaToHex(c(k));
  const syntax: ThemeSyntaxRule[] = BASE16_SYNTAX.map(([scope, key, fontStyle]) => ({ scope: [...scope], foreground: hex(key), ...(fontStyle ? { fontStyle } : {}) }));
  return { ok: true, theme: { plannotatorTheme: 1, id: themeIdFromName(name), name, [half]: { ...tokens, syntax } } };
}

/**
 * Code colours for a base16 scheme: the TextMate scopes of the base16 styling
 * guidelines (base16-textmate, base16-vscode). Comments base03, punctuation and
 * operators base05, variables and tags base08, numbers and constants base09,
 * types and classes base0A, strings base0B, escapes and regexes base0C,
 * functions base0D, keywords and storage base0E, embedded and deprecated base0F.
 */
export const BASE16_SYNTAX: readonly (readonly [readonly string[], (typeof BASE16_KEYS)[number], string?])[] = [
  [['comment', 'punctuation.definition.comment'], 'base03', 'italic'],
  [['punctuation', 'keyword.operator', 'meta.brace', 'meta.delimiter'], 'base05'],
  [['variable', 'variable.other', 'entity.name.tag', 'meta.tag', 'markup.deleted', 'invalid'], 'base08'],
  [['variable.parameter', 'constant.numeric', 'constant.language', 'constant.character', 'constant.other', 'support.constant', 'entity.other.attribute-name', 'markup.link'], 'base09'],
  [['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class', 'storage.type.class', 'markup.bold'], 'base0a'],
  [['string', 'constant.other.symbol', 'markup.inserted', 'markup.inline.raw', 'markup.raw'], 'base0b'],
  [['string.regexp', 'constant.character.escape', 'support.function.builtin', 'markup.quote', 'keyword.other.unit'], 'base0c'],
  [['entity.name.function', 'support.function', 'meta.function-call', 'entity.name.section', 'markup.heading'], 'base0d'],
  [['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'markup.italic', 'markup.changed'], 'base0e'],
  [['meta.embedded', 'punctuation.section.embedded', 'invalid.deprecated'], 'base0f'],
];

// --- VS Code ----------------------------------------------------------------

/**
 * A VS Code colour theme as a Plannotator theme (one half: `type` light or
 * hcLight is light, dark, hc and hcDark are dark; with no `type`, the ground's
 * lightness decides). Translucent colours are drawn over editor.background.
 * The first key present wins; with none, the token is derived (fillHalf).
 * Muted, input and code-bg that come out the card's colour (sidebars and
 * widgets often share one) are moved a step off it, so chips and code blocks
 * still show on a card.
 */
export const VSCODE_TOKEN_SOURCES: Partial<Record<keyof ThemeTokens, readonly string[]>> = {
  background: ['editor.background'],
  foreground: ['editor.foreground', 'foreground'],
  card: ['sideBar.background', 'editorWidget.background', 'panel.background'],
  'card-foreground': ['sideBar.foreground', 'foreground', 'editor.foreground'],
  popover: ['editorWidget.background', 'editorHoverWidget.background', 'dropdown.background', 'quickInput.background'],
  'popover-foreground': ['editorWidget.foreground', 'editorHoverWidget.foreground', 'foreground', 'editor.foreground'],
  primary: ['button.background', 'activityBarBadge.background', 'textLink.foreground', 'focusBorder', 'terminal.ansiBlue'],
  'primary-foreground': ['button.foreground'],
  secondary: ['terminal.ansiCyan', 'textLink.activeForeground', 'textLink.foreground'],
  muted: ['tab.inactiveBackground', 'editorGroupHeader.tabsBackground', 'sideBar.background'],
  'muted-foreground': ['descriptionForeground', 'tab.inactiveForeground', 'editorLineNumber.activeForeground'],
  accent: ['terminal.ansiMagenta', 'editorCursor.foreground'],
  destructive: ['errorForeground', 'editorError.foreground', 'terminal.ansiRed'],
  success: ['terminal.ansiGreen', 'gitDecoration.addedResourceForeground', 'editorGutter.addedBackground'],
  warning: ['editorWarning.foreground', 'terminal.ansiYellow', 'list.warningForeground'],
  border: ['panel.border', 'sideBar.border', 'editorGroup.border', 'tab.border', 'contrastBorder'],
  input: ['input.background', 'dropdown.background'],
  ring: ['focusBorder', 'button.background', 'textLink.foreground'],
  'code-bg': ['textCodeBlock.background', 'editorWidget.background', 'sideBar.background'],
  'focus-highlight': ['terminal.ansiCyan', 'focusBorder'],
};

/** The tokens that are fills with a hue of their own (see vscodeToThemeFile). */
const CHROMATIC_TOKENS: ReadonlySet<string> = new Set(['primary', 'secondary', 'accent', 'destructive', 'success', 'warning', 'ring']);

/** OKLCH chroma of a colour. */
const chroma = (c: Rgba) => {
  const [, a, b] = rgbToOklab(c);
  return Math.hypot(a, b);
};

export function vscodeToThemeFile(source: Record<string, unknown>): ThemeConvertResult {
  const colors = source.colors;
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
    return { ok: false, field: 'colors', message: 'a VS Code colour theme has a "colors" object.' };
  }
  const table = colors as Record<string, unknown>;
  const read = (key: string): Rgba | null => {
    const raw = table[key];
    return typeof raw === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw) ? parseThemeColour(raw) : null;
  };
  const groundRaw = read('editor.background');
  if (!groundRaw) return { ok: false, field: 'colors.editor.background', message: 'missing or not a #hex colour; a theme needs its ground.' };
  const white = { r: 1, g: 1, b: 1, a: 1 };
  const ground = solid(groundRaw, white);
  const named: Partial<Record<keyof ThemeTokens, Rgba>> = {};
  const from: Partial<Record<keyof ThemeTokens, string>> = {};
  for (const [token, keys] of Object.entries(VSCODE_TOKEN_SOURCES)) {
    const present = (keys ?? [])
      .map((key) => ({ key, c: read(key) }))
      // A fully transparent colour (VS Code's way to say "none") names nothing.
      .filter((entry): entry is { key: string; c: Rgba } => !!entry.c && entry.c.a > 0)
      .map((entry) => ({ key: entry.key, c: solid(entry.c, ground) }));
    // A fill (a button, a badge, a status) takes the first source with colour in it: many themes paint
    // button.background a neutral grey, which as Plannotator's primary would be every link and selection.
    const pick = CHROMATIC_TOKENS.has(token) ? (present.find((entry) => chroma(entry.c) >= 0.04) ?? present[0]) : present[0];
    if (pick) {
      named[token as keyof ThemeTokens] = pick.c;
      from[token as keyof ThemeTokens] = pick.key;
    }
  }
  const text = named.foreground ?? (isDark(ground) ? parseThemeColour('#d4d4d4')! : parseThemeColour('#1f1f1f')!);
  const type = String(source.type ?? '').toLowerCase();
  const half: ThemeFileHalf = type === 'light' || type === 'hclight' || type === 'vs' ? 'light' : type === 'dark' || type === 'hc' || type === 'hcdark' || type === 'vs-dark' || type === 'hc-black' ? 'dark' : isDark(ground) ? 'dark' : 'light';
  // A button's own text only when the button is the primary: otherwise the derived pick.
  if (from.primary !== 'button.background') delete named['primary-foreground'];
  const name = cleanName(source.name, 'Imported VS Code theme');
  const { rules, leftOut } = vscodeSyntaxRules(source.tokenColors);
  const tokens = fillHalf(named, ground, text);
  return {
    ok: true,
    theme: { plannotatorTheme: 1, id: themeIdFromName(name), name, [half]: rules.length > 0 ? { ...tokens, syntax: rules } : tokens },
    syntaxLeftOut: leftOut,
  };
}

/**
 * A VS Code theme's `tokenColors` as code colour rules, as written: each
 * entry's scopes and its foreground, background and fontStyle. Kept only what
 * the validator takes: an entry with no scope (the theme's default text, which
 * the half's foreground already is), a scope the validator refuses, a colour
 * that is not #hex or a font style it does not know is left out, and so is
 * every rule past THEME_SYNTAX_RULES_MAX. `semanticTokenColors` is not read:
 * the highlighter has no language server, so there are no semantic tokens.
 */
export function vscodeSyntaxRules(tokenColors: unknown): { rules: ThemeSyntaxRule[]; leftOut: number } {
  if (!Array.isArray(tokenColors)) return { rules: [], leftOut: 0 };
  const rules: ThemeSyntaxRule[] = [];
  let leftOut = 0;
  for (const entry of tokenColors) {
    const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const settings = e?.settings && typeof e.settings === 'object' && !Array.isArray(e.settings) ? (e.settings as Record<string, unknown>) : null;
    if (!e || !settings) {
      leftOut++;
      continue;
    }
    if (e.scope === undefined) continue; // the default text: the half's foreground
    const raw = typeof e.scope === 'string' ? e.scope.split(',').map((x) => x.trim()).filter(Boolean) : Array.isArray(e.scope) ? e.scope : [];
    const scopes = raw.filter(isSyntaxScope).slice(0, THEME_SCOPES_PER_RULE_MAX);
    const rule: ThemeSyntaxRule = { scope: scopes.length === 1 ? scopes[0]! : scopes };
    if (isSyntaxColour(settings.foreground)) rule.foreground = settings.foreground.toLowerCase();
    if (isSyntaxColour(settings.background)) rule.background = settings.background.toLowerCase();
    if (typeof settings.fontStyle === 'string') {
      const style = settings.fontStyle.trim().split(/\s+/).filter(Boolean).join(' ');
      if (isSyntaxFontStyle(style)) rule.fontStyle = style;
    }
    if (scopes.length === 0 || (rule.foreground === undefined && rule.background === undefined && rule.fontStyle === undefined) || rules.length >= THEME_SYNTAX_RULES_MAX) {
      leftOut++;
      continue;
    }
    rules.push(rule);
  }
  return { rules, leftOut };
}

// --- Detection --------------------------------------------------------------

/** A converter's refusal as the import's (the explicit copy keeps the result's union exact without strict narrowing). */
function asFailure(r: ThemeConvertResult): ThemeImportResult {
  return { ok: false, field: r.field ?? '(file)', message: r.message ?? 'not readable as a theme.' };
}

/**
 * Read a theme file's text in any supported format. Ours is passed through
 * as parsed (the caller validates it); base16 and VS Code are converted.
 */
export function importThemeText(text: string): ThemeImportResult {
  // A byte order mark (Windows editors write one; VS Code reads such files) is not part of the theme.
  text = text.replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (THEME_FILE_MARKER in obj) return { ok: true, format: 'plannotator', theme: obj };
    if (base16Palette(obj)) {
      const r = base16ToThemeFile(obj);
      if (!r.ok) return asFailure(r);
      return { ok: true, format: 'base16', theme: r.theme! };
    }
    if ('colors' in obj || 'tokenColors' in obj) {
      const r = vscodeToThemeFile(obj);
      if (!r.ok) return asFailure(r);
      return { ok: true, format: 'vscode', theme: r.theme!, syntaxLeftOut: r.syntaxLeftOut };
    }
    return { ok: false, field: '(file)', message: 'not a theme this command knows: a Plannotator theme ("plannotatorTheme": 1), a base16 scheme (base00 to base0F) or a VS Code colour theme ("colors").' };
  }
  const yaml = parseBase16Yaml(text);
  if (BASE16_KEYS.some((k) => k in yaml) || 'palette' in yaml) {
    const r = base16ToThemeFile(yaml);
    if (!r.ok) return asFailure(r);
    return { ok: true, format: 'base16', theme: r.theme! };
  }
  return { ok: false, field: '(file)', message: 'not JSON and not a base16 YAML scheme; nothing to read.' };
}
