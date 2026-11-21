/**
 * Converting the theme files people already have (theme-import.ts) into
 * Plannotator's format. The fixtures are written by hand from documented
 * palettes (fixtures/themes/). The failures these guard: a format not detected,
 * a source colour mapped to the wrong token, a half picked wrong (a light
 * scheme drawn as dark), a neutral grey button made the primary, a translucent
 * colour kept translucent, a converted theme that does not pass the same
 * validation a hand-written one does, a converted id taking a built-in's, and a
 * theme's code colours (VS Code tokenColors, base16's scope table) lost, changed
 * or carried with something the validator would refuse.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEME_TOKENS, validateThemeFile, type ThemeFile } from './theme-file';
import { BASE16_SYNTAX, importThemeText, parseBase16Yaml, parseJsonc, themeIdFromName, vscodeSyntaxRules } from './theme-import';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'themes', name), 'utf8');

function imported(text: string): { format: string; theme: ThemeFile } {
  const r = importThemeText(text);
  if (!r.ok) throw new Error(`${r.field}: ${r.message}`);
  const v = validateThemeFile(r.theme);
  if (!v.ok) throw new Error(`${v.problem.field}: ${v.problem.message}`);
  return { format: r.format, theme: v.theme };
}

describe('base16', () => {
  test('Tomorrow Night (YAML): a dark half with every token, mapped from the scheme', () => {
    const { format, theme } = imported(fixture('tomorrow-night.base16.yaml'));
    expect(format).toBe('base16');
    expect(theme.id).toBe('tomorrow-night');
    expect(theme.name).toBe('Tomorrow Night');
    expect(theme.light).toBeUndefined();
    const dark = theme.dark!;
    for (const token of THEME_TOKENS) expect(dark[token]).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatchObject({
      background: '#1d1f21', foreground: '#c5c8c6', card: '#282a2e', 'muted-foreground': '#b4b7b4',
      primary: '#81a2be', secondary: '#8abeb7', accent: '#de935f', destructive: '#cc6666',
      success: '#b5bd68', warning: '#f0c674', border: '#373b41', ring: '#81a2be',
    });
    // A fill's text is the ground or the text, whichever reads better on it.
    expect(dark['primary-foreground']).toBe('#1d1f21');
  });

  test('a light scheme becomes the light half, and the newer palette: form and JSON read the same', () => {
    const palette = {
      base00: 'fdf6e3', base01: 'eee8d5', base02: '93a1a1', base03: '839496', base04: '657b83', base05: '586e75', base06: '073642', base07: '002b36',
      base08: 'dc322f', base09: 'cb4b16', base0A: 'b58900', base0B: '859900', base0C: '2aa198', base0D: '268bd2', base0E: '6c71c4', base0F: 'd33682',
    };
    const yaml = `system: "base16"\nname: "Solarized Light"\nvariant: "light"\npalette:\n${Object.entries(palette).map(([k, v]) => `  ${k}: "#${v}"`).join('\n')}\n`;
    const fromYaml = imported(yaml).theme;
    const fromJson = imported(JSON.stringify({ scheme: 'Solarized Light', ...palette })).theme;
    expect(fromYaml.light?.background).toBe('#fdf6e3');
    expect(fromYaml.dark).toBeUndefined();
    expect(fromJson.light).toEqual(fromYaml.light);
    expect(fromYaml.id).toBe('solarized-light');
  });

  test('a scheme with a colour missing or not hex is refused naming that colour', () => {
    const text = fixture('tomorrow-night.base16.yaml').replace('base0D: "81a2be"', 'base0D: "url(x)"');
    const r = importThemeText(text);
    expect(r.ok ? null : r.field).toBe('base0d');
    const r2 = importThemeText(fixture('tomorrow-night.base16.yaml').replace(/^base0F.*$/m, ''));
    expect(r2.ok ? null : r2.field).toBe('base0f');
  });

  test('the YAML reader takes comments off and keeps a # inside quotes', () => {
    expect(parseBase16Yaml('base00: "#1d1f21" # ground\nbase01: 282a2e # raised\n')).toEqual({ base00: '#1d1f21', base01: '282a2e' });
  });
});

describe('VS Code', () => {
  test('Monokai Classic (JSON with comments and trailing commas): a dark half mapped from its colours', () => {
    const { format, theme } = imported(fixture('monokai-classic.vscode-theme.json'));
    expect(format).toBe('vscode');
    expect(theme.id).toBe('monokai-classic');
    const dark = theme.dark!;
    for (const token of THEME_TOKENS) expect(dark[token]).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatchObject({
      background: '#272822', foreground: '#f8f8f2', card: '#1e1f1c', 'muted-foreground': '#a59f85',
      destructive: '#f92672', success: '#a6e22e', warning: '#fd971f', accent: '#ae81ff', input: '#414339', border: '#414339',
    });
    // button.background and the badge are Monokai's grey #75715e: the primary skips them for the link blue.
    expect(dark.primary).toBe('#66d9ef');
    // ...and so the button's own text colour is not used on it.
    expect(dark['primary-foreground']).toBe('#272822');
  });

  test('a light theme becomes the light half; a translucent colour is drawn over the ground', () => {
    const { theme } = imported(JSON.stringify({
      name: 'Paper Desk', type: 'light',
      colors: { 'editor.background': '#ffffff', 'editor.foreground': '#202020', 'button.background': '#0066b8', 'input.background': '#00000020' },
    }));
    expect(theme.dark).toBeUndefined();
    expect(theme.light?.primary).toBe('#0066b8');
    // #000000 at 0x20/255 alpha over white.
    expect(theme.light?.input).toBe('#dfdfdf');
    expect(theme.light?.background).toBe('#ffffff');
  });

  test('with no type, the ground decides the half; no editor.background is refused naming it', () => {
    expect(imported(JSON.stringify({ name: 'X', colors: { 'editor.background': '#fafafa' } })).theme.light).toBeDefined();
    expect(imported(JSON.stringify({ name: 'X', colors: { 'editor.background': '#111111' } })).theme.dark).toBeDefined();
    const r = importThemeText(JSON.stringify({ name: 'X', colors: { 'editor.foreground': '#111111' } }));
    expect(r.ok ? null : r.field).toBe('colors.editor.background');
  });

  test('a hostile value in a VS Code theme names nothing: only #hex is read', () => {
    const { theme } = imported(JSON.stringify({ name: 'X', type: 'dark', colors: { 'editor.background': '#101010', 'button.background': 'url(https://x)', 'errorForeground': 'red;}' } }));
    expect(theme.dark?.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme.dark?.destructive).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('the JSON-with-comments reader leaves strings alone', () => {
    expect(parseJsonc('{ "a": "x // y, }", /* c */ "b": [1, 2,], // d\n }')).toEqual({ a: 'x // y, }', b: [1, 2] });
  });
});

describe('surfaces', () => {
  // Code chips, tags and fields are muted surfaces drawn on cards (the plan document is a card).
  const lightness = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!) * 0.2104542553 + Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!) * 0.793617785 - Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!) * 0.0040720468;
  };
  const apart = (half: Record<string, string>, token: string) => Math.abs(lightness(half[token]!) - lightness(half.card!));

  test('muted, code blocks and fields stand apart from the card in every converted theme', () => {
    const halves = [
      imported(fixture('tomorrow-night.base16.yaml')).theme.dark!,
      imported(fixture('monokai-classic.vscode-theme.json')).theme.dark!,
      // A VS Code theme that paints its sidebar and its inactive tabs one colour.
      imported(JSON.stringify({ name: 'Flat', type: 'dark', colors: { 'editor.background': '#1b1b1b', 'sideBar.background': '#232323', 'tab.inactiveBackground': '#232323' } })).theme.dark!,
      imported(JSON.stringify({ name: 'Flat Light', type: 'light', colors: { 'editor.background': '#fafafa', 'sideBar.background': '#ffffff', 'tab.inactiveBackground': '#ffffff' } })).theme.light!,
    ];
    for (const half of halves) {
      for (const token of ['muted', 'code-bg', 'input']) expect(apart(half, token)).toBeGreaterThanOrEqual(0.025);
    }
  });
});

describe('detection and ids', () => {
  test("Plannotator's own format is passed through for validation", () => {
    const r = importThemeText(fixture('instrument.plannotator-theme.json'));
    expect(r.ok && r.format).toBe('plannotator');
    expect(validateThemeFile(r.ok ? r.theme : null).ok).toBe(true);
  });

  test('a file in no known format is refused', () => {
    const r = importThemeText('{"hello": "world"}');
    expect(r.ok ? null : r.field).toBe('(file)');
    expect(importThemeText('just some words').ok).toBe(false);
  });

  test("a converted theme's id never takes a built-in's", () => {
    expect(themeIdFromName('Dracula')).toBe('dracula-custom');
    expect(themeIdFromName('Tokyo Night')).toBe('tokyo-night-custom');
    expect(themeIdFromName('Café Noir ☕')).toBe('cafe-noir');
    // No Latin letter or digit: a stable id of its own, different for different names.
    expect(themeIdFromName('夜')).toMatch(/^theme-[0-9a-f]{8}$/);
    expect(themeIdFromName('夜')).toBe(themeIdFromName('夜'));
    expect(themeIdFromName('朝')).not.toBe(themeIdFromName('夜'));
    expect(themeIdFromName('!!!')).toMatch(/^theme-[0-9a-f]{8}$/);
  });
});

describe('code colours', () => {
  const ruleFor = (theme: ThemeFile, half: 'dark' | 'light', scope: string) =>
    theme[half]!.syntax!.find((rule) => (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).includes(scope));

  test("a VS Code theme's tokenColors come across as written; what the validator would refuse is left out and counted", () => {
    const r = importThemeText(fixture('monokai-classic.vscode-theme.json'));
    if (!r.ok) throw new Error(r.message);
    // The odd scope and the named colour; the scope-less default entry is the half's foreground, not a rule.
    expect(r.syntaxLeftOut).toBe(2);
    const { theme } = imported(fixture('monokai-classic.vscode-theme.json'));
    const rules = theme.dark!.syntax!;
    expect(rules).toHaveLength(32);
    expect(ruleFor(theme, 'dark', 'keyword')).toEqual({ scope: 'keyword', foreground: '#f92672' });
    expect(ruleFor(theme, 'dark', 'string')).toEqual({ scope: 'string', foreground: '#e6db74' });
    // A comma list is split into scopes; font styles and backgrounds stay.
    expect(ruleFor(theme, 'dark', 'entity.name.class')).toEqual({ scope: ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'entity.name.scope-resolution'], foreground: '#a6e22e', fontStyle: 'underline' });
    expect(ruleFor(theme, 'dark', 'invalid')).toEqual({ scope: 'invalid', background: '#f92672', fontStyle: '', foreground: '#f8f8f0' });
    // A descendant selector is kept whole.
    expect(ruleFor(theme, 'dark', 'meta.structure.dictionary.json string.quoted.double.json')?.foreground).toBe('#cfcfc2');
    expect(JSON.stringify(rules)).not.toContain('<script>');
    expect(JSON.stringify(rules)).not.toContain('"red"');
  });

  test('tokenColors past the cap are left out and counted, never refused', () => {
    const many = Array.from({ length: 650 }, (_, i) => ({ scope: `meta.rule${i}`, settings: { foreground: '#abcdef' } }));
    const { rules, leftOut } = vscodeSyntaxRules(many);
    expect(rules).toHaveLength(600);
    expect(leftOut).toBe(50);
  });

  test('a base16 scheme gets the base16 scope table in its own colours', () => {
    const { theme } = imported(fixture('tomorrow-night.base16.yaml'));
    expect(theme.dark!.syntax).toHaveLength(BASE16_SYNTAX.length);
    // Tomorrow Night: base03 #969896 comments, base0B #b5bd68 strings, base0E #b294bb keywords, base0D #81a2be functions.
    expect(ruleFor(theme, 'dark', 'comment')).toMatchObject({ foreground: '#969896', fontStyle: 'italic' });
    expect(ruleFor(theme, 'dark', 'string')?.foreground).toBe('#b5bd68');
    expect(ruleFor(theme, 'dark', 'keyword')?.foreground).toBe('#b294bb');
    expect(ruleFor(theme, 'dark', 'entity.name.function')?.foreground).toBe('#81a2be');
    expect(ruleFor(theme, 'dark', 'constant.numeric')?.foreground).toBe('#de935f');
  });

  test('a VS Code theme with no tokenColors has no code colours (code keeps Plannotator\'s)', () => {
    const { theme } = imported(JSON.stringify({ name: 'Bare', type: 'dark', colors: { 'editor.background': '#101010' } }));
    expect(theme.dark!.syntax).toBeUndefined();
  });
});

describe('a converted name', () => {
  test('loses invisible and text-direction characters, so the theme is not refused for its source name', () => {
    const r = importThemeText(JSON.stringify({ name: 'Ev\u202eil\u200b Night', type: 'dark', colors: { 'editor.background': '#101010' } }));
    if (!r.ok) throw new Error(r.message);
    expect((r.theme as ThemeFile).name).toBe('Evil Night');
    expect(validateThemeFile(r.theme).ok).toBe(true);
  });
});

describe('a byte order mark', () => {
  test('a VS Code theme saved with a BOM (Windows editors write one) reads like one without', () => {
    const text = fixture('monokai-classic.vscode-theme.json');
    const withBom = importThemeText(`\uFEFF${text}`);
    expect(withBom.ok).toBe(true);
    expect(withBom).toEqual(importThemeText(text));
    expect(importThemeText(`\uFEFF${fixture('tomorrow-night.base16.yaml')}`)).toMatchObject({ ok: true, format: 'base16' });
  });
});
