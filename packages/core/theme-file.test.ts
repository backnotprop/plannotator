/**
 * A person's theme file (theme-file.ts) is untrusted input that ends up in a
 * stylesheet. The failures these guard: a value that is not exactly one colour
 * reaching the CSS (url(), var(), a `;` or `}` that closes the rule and starts
 * another, a quote, a line break), a theme taking a built-in's id, a refusal
 * that does not name its field, a left-out token not falling back to the
 * default theme's value for that half, and the body-text contrast reading a
 * different number than WCAG's.
 */
import { describe, expect, test } from 'bun:test';
import {
  BUILT_IN_THEME_IDS,
  DEFAULT_THEME_TOKENS,
  THEME_TOKENS,
  bodyTextContrast,
  contrastRatio,
  customThemeInfo,
  isCustomThemeInfo,
  isThemeColour,
  missingThemeTokens,
  parseThemeColour,
  themeFileCss,
  themeFileModeSupport,
  validateThemeFile,
  type ThemeFile,
} from './theme-file';

const ok = (extra: Record<string, unknown> = {}) => ({ plannotatorTheme: 1, id: 'harbor', name: 'Harbor', dark: { background: '#0f1419' }, ...extra });

describe('colours: one colour or nothing', () => {
  test('the four colour forms pass, in the shapes people write them', () => {
    for (const value of [
      '#fff', '#FFFF', '#0f1419', '#0F1419CC',
      'rgb(15, 20, 25)', 'rgba(15,20,25,0.5)', 'rgb(15 20 25)', 'rgb(15 20 25 / 50%)', 'rgb(100%, 0%, 0%)',
      'hsl(210, 25%, 8%)', 'hsla(210deg, 25%, 8%, .5)', 'hsl(210 25% 8% / 0.4)',
      'oklch(0.15 0.02 260)', 'oklch(15% 0.02 260deg)', 'oklch(0.7 0.2 60 / 0.8)',
    ]) {
      expect({ value, ok: isThemeColour(value) }).toEqual({ value, ok: true });
    }
  });

  test('hostile and almost-colours are refused', () => {
    const hostile: unknown[] = [
      'url(https://example.com/x.png)', 'var(--primary)', 'red', 'transparent', 'currentColor', 'inherit',
      '#fff; } body { display: none', '#ffffff;', '#fff}', '#fff{', 'rgb(1,2,3);', 'rgb(1,2,3)}',
      'expression(alert(1))', 'calc(1px + 2px)', '"#fff"', "'#fff'", '#fff\n', ' #fff', '#fff ', 'rgb(1 2 3)\n',
      'rgb(1,2,3) !important', 'hsl(1 2% 3%) /* x */', 'oklch(0.5 0.1 200) url(x)', '\\23 fff', '#ggg', '#12345',
      '#1234567', 'rgb(1,2,3,4,5)', 'rgb(attr(x))', '#fff</style><script>alert(1)</script>', 'RGB(1,2,3)',
      'oklch(from red l c h)', 'color-mix(in oklch, red, blue)', 'lab(50 0 0)', 'hsl(var(--h) 50% 50%)',
      'rgb(1e3, 2, 3)', '＃fff', 'rgb(1,2,3) ', 'rgb(1,\n2,3)', 'rgb(1,\t2,3)', `#${'f'.repeat(70)}`,
      `rgb(${'1'.repeat(80)}, 2, 3)`, 'rgb(1, 2, 3', 'rgb 1, 2, 3)', '', 12345, null, undefined, ['#fff'], { r: 1 },
    ];
    for (const value of hostile) expect({ value, ok: isThemeColour(value) }).toEqual({ value, ok: false });
  });

  test('fuzz: anything accepted is made of colour characters only', () => {
    // Random strings over an alphabet heavy in CSS syntax. The grammar is closed, so whatever passes
    // holds no character that could end a declaration, open a string, a comment or another function.
    const alphabet = '#0123456789abcdefABCDEF(),.%/ -;:{}<>"\'\\\n\turlvargbhsoklcdeg!*';
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    // Mutations of valid colours: one to three random inserts, deletes or replacements each.
    const seeds = ['#0f1419', '#fff', 'rgb(15, 20, 25)', 'rgb(15 20 25 / 50%)', 'hsl(210 25% 8%)', 'hsla(210, 25%, 8%, .5)', 'oklch(0.15 0.02 260)', 'oklch(15% 0.02 260deg / 0.8)'];
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 40_000; i++) {
      let s = seeds[Math.floor(rand() * seeds.length)]!;
      const edits = 1 + Math.floor(rand() * 3);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rand() * (s.length + 1));
        const ch = alphabet[Math.floor(rand() * alphabet.length)]!;
        const op = rand();
        s = op < 0.4 ? s.slice(0, at) + ch + s.slice(at) : op < 0.7 ? s.slice(0, at) + s.slice(at + 1) : s.slice(0, at) + ch + s.slice(at + 1);
      }
      if (!isThemeColour(s)) {
        refused++;
        continue;
      }
      accepted++;
      expect(s).toMatch(/^[#0-9a-fA-F(),.%/ a-z-]+$/);
      expect(s).not.toMatch(/[;:{}<>"'\\\n\t!*]|url|var/);
    }
    // Both sides of the grammar were reached, so the loop proved something.
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
  });

  test('parsing agrees with the forms it accepts', () => {
    const near = (c: ReturnType<typeof parseThemeColour>, r: number, g: number, b: number) => {
      expect(c).not.toBeNull();
      expect(Math.round(c!.r * 255)).toBe(r);
      expect(Math.round(c!.g * 255)).toBe(g);
      expect(Math.round(c!.b * 255)).toBe(b);
    };
    near(parseThemeColour('#0f1419'), 15, 20, 25);
    near(parseThemeColour('rgb(15 20 25)'), 15, 20, 25);
    near(parseThemeColour('hsl(0, 100%, 50%)'), 255, 0, 0);
    near(parseThemeColour('oklch(1 0 0)'), 255, 255, 255);
    near(parseThemeColour('oklch(0 0 0)'), 0, 0, 0);
    expect(parseThemeColour('url(x)')).toBeNull();
  });
});

describe('validating a theme file', () => {
  test('a good file passes, the name trimmed', () => {
    const result = validateThemeFile(ok({ name: '  Harbor  ', light: { background: 'oklch(0.97 0.01 240)' } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.theme).toEqual({ plannotatorTheme: 1, id: 'harbor', name: 'Harbor', dark: { background: '#0f1419' }, light: { background: 'oklch(0.97 0.01 240)' } });
  });

  test('each refusal names the field that is wrong', () => {
    const field = (input: unknown) => {
      const r = validateThemeFile(input);
      return r.ok ? null : r.problem.field;
    };
    expect(field([])).toBe('(file)');
    expect(field({ ...ok(), plannotatorTheme: 2 })).toBe('plannotatorTheme');
    expect(field(ok({ colors: {} }))).toBe('colors');
    expect(field(ok({ id: 'Harbor' }))).toBe('id');
    expect(field(ok({ id: '-x' }))).toBe('id');
    expect(field(ok({ id: 'a'.repeat(65) }))).toBe('id');
    expect(field(ok({ id: '../../etc' }))).toBe('id');
    expect(field(ok({ name: '' }))).toBe('name');
    expect(field(ok({ name: 'a\nb' }))).toBe('name');
    expect(field(ok({ name: 'x'.repeat(61) }))).toBe('name');
    expect(field(ok({ dark: '#000' }))).toBe('dark');
    expect(field(ok({ dark: { backgroud: '#000' } }))).toBe('dark.backgroud');
    expect(field(ok({ dark: { '--background': '#000' } }))).toBe('dark.--background');
    expect(field(ok({ dark: { 'font-sans': 'Comic Sans' } }))).toBe('dark.font-sans');
    expect(field(ok({ light: { primary: 'url(x)' } }))).toBe('light.primary');
    expect(field({ plannotatorTheme: 1, id: 'harbor', name: 'Harbor' })).toBe('dark');
  });

  test('a token written with its leading -- says how to write it', () => {
    const r = validateThemeFile(ok({ dark: { '--background': '#000' } }));
    expect(r.ok ? '' : r.problem.message).toContain('"background"');
  });

  test('no custom theme takes a built-in id', () => {
    for (const id of BUILT_IN_THEME_IDS) {
      const r = validateThemeFile(ok({ id }));
      expect(r.ok ? null : r.problem.field).toBe('id');
    }
    expect(BUILT_IN_THEME_IDS.length).toBe(55);
  });
});

describe('the stylesheet a theme writes', () => {
  const full = (half: 'dark' | 'light') => Object.fromEntries(THEME_TOKENS.map((t) => [t, half === 'dark' ? '#101010' : '#f0f0f0']));

  test('only colour declarations under the theme selectors, plus the app fonts and radius', () => {
    const theme = validateThemeFile(ok({ dark: full('dark'), light: { ...full('light'), 'accent-text': 'rgb(150 70 0)' } }));
    if (!theme.ok) throw new Error('fixture');
    const css = themeFileCss(theme.theme);
    const selectors = [...css.matchAll(/^([^\s].*) \{$/gm)].map((m) => m[1]);
    expect(selectors).toEqual(['.theme-harbor', '.theme-harbor', '.theme-harbor.light']);
    for (const line of css.split('\n')) {
      if (/^[^\s].* \{$/.test(line) || line === '}') continue;
      const decl = /^ {2}--([a-z-]+): (.+);$/.exec(line);
      expect(decl).not.toBeNull();
      const [, name, value] = decl!;
      if (name === 'font-sans' || name === 'font-mono' || name === 'radius') continue;
      expect(isThemeColour(value)).toBe(true);
    }
  });

  test('a value that slipped past validation is never written', () => {
    const forged = { plannotatorTheme: 1, id: 'harbor', name: 'H', dark: { background: '#000;} body{display:none' } } as unknown as ThemeFile;
    expect(() => themeFileCss(forged)).toThrow();
    expect(() => themeFileCss({ ...forged, dark: { 'x;}': '#000' } } as unknown as ThemeFile)).toThrow();
    expect(() => themeFileCss({ plannotatorTheme: 1, id: 'a b{', name: 'H', dark: {} })).toThrow();
    expect(() => themeFileCss({ plannotatorTheme: 1, id: 'dracula', name: 'H', dark: {} })).toThrow();
  });

  test('a left-out token takes the default theme value for its own half', () => {
    const r = validateThemeFile(ok({ dark: { background: '#0f1419' }, light: { background: '#fafafa' } }));
    if (!r.ok) throw new Error('fixture');
    const css = themeFileCss(r.theme);
    const [dark, light] = css.split('.theme-harbor.light');
    expect(dark).toContain('--background: #0f1419;');
    expect(dark).toContain(`--card: ${DEFAULT_THEME_TOKENS.dark.card};`);
    expect(light).toContain('--background: #fafafa;');
    expect(light).toContain(`--card: ${DEFAULT_THEME_TOKENS.light.card};`);
    expect(light).toContain(`--focus-highlight: ${DEFAULT_THEME_TOKENS.light['focus-highlight']};`);
    expect(missingThemeTokens(r.theme.dark)).toHaveLength(THEME_TOKENS.length - 1);
  });

  test('a one-half theme is drawn under the bare class and says which half it has', () => {
    const r = validateThemeFile({ plannotatorTheme: 1, id: 'paper', name: 'Paper', light: { background: '#fbfaf7' } });
    if (!r.ok) throw new Error('fixture');
    expect(themeFileModeSupport(r.theme)).toBe('light-only');
    const css = themeFileCss(r.theme);
    expect(css).not.toContain('.light');
    expect(css).toContain('--background: #fbfaf7;');
    expect(customThemeInfo(r.theme).colors.dark).toEqual(customThemeInfo(r.theme).colors.light);
  });

  test("the registry entry it hands the page passes the page's own check, and a forged one does not", () => {
    const r = validateThemeFile(ok());
    if (!r.ok) throw new Error('fixture');
    const info = customThemeInfo(r.theme);
    expect(isCustomThemeInfo(info)).toBe(true);
    expect(isCustomThemeInfo({ ...info, id: 'dracula' })).toBe(false);
    expect(isCustomThemeInfo({ ...info, colors: { ...info.colors, dark: { ...info.colors.dark, primary: 'url(x)' } } })).toBe(false);
  });
});

describe('body text contrast (a note, never a refusal)', () => {
  test('WCAG ratios: black on white is 21, a colour on itself is 1', () => {
    expect(contrastRatio(parseThemeColour('#000')!, parseThemeColour('#fff')!)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseThemeColour('#777')!, parseThemeColour('#777')!)).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1.
    expect(contrastRatio(parseThemeColour('#767676')!, parseThemeColour('#fff')!)).toBeCloseTo(4.54, 2);
  });

  test('a low-contrast theme is still a valid theme', () => {
    const r = validateThemeFile(ok({ dark: { background: '#202020', foreground: '#3a3a3a' } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(bodyTextContrast(r.theme)[0]!.ratio).toBeLessThan(4.5);
  });
});
