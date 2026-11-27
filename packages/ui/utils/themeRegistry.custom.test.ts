/**
 * Custom themes in the page's registry (themeRegistry.ts): what
 * `/plannotator-themes.js` hands the page. The failures these guard: a custom
 * id normalized away to the default (the cookie or config.json naming it, the
 * page drawing Plannotator instead), a one-half theme assigned to the half it
 * cannot draw, a malformed or forged entry (a built-in's id, a colour that is
 * not one) reaching a picker tile, and the server's list of built-in ids
 * (core/theme-file.ts, which the Inbox and the CLI check ids against) drifting
 * from the registry and the theme files.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUILT_IN_THEME_IDS, builtInThemeModeSupport } from '@plannotator/core/theme-file';
import {
  BUILT_IN_THEMES,
  getAllThemes,
  getUnsupportedMode,
  isKnownTheme,
  normalizeThemePair,
  setCustomThemes,
  themeSupportsHalf,
  themesForHalf,
} from './themeRegistry';

const swatch = { primary: '#4cc2ff', secondary: '#5fd4c4', accent: '#ffb547', background: '#0c0f14', foreground: '#d9dee7' };
const entry = (id: string, modeSupport: 'both' | 'dark-only' | 'light-only' = 'both', name = id) => ({ id, name, modeSupport, colors: { dark: swatch, light: swatch } });

afterEach(() => setCustomThemes([]));

describe('custom themes in the registry', () => {
  test('a custom id is known, survives normalization, and is listed before the built-ins', () => {
    setCustomThemes([entry('instrument')]);
    expect(isKnownTheme('instrument')).toBe(true);
    expect(normalizeThemePair({ mode: 'dark', light: 'instrument', dark: 'instrument' })).toEqual({ mode: 'dark', light: 'instrument', dark: 'instrument' });
    expect(getAllThemes()[0]!.id).toBe('instrument');
    expect(getAllThemes().find((t) => t.id === 'instrument')!.builtIn).toBe(false);
    expect(getAllThemes()).toHaveLength(BUILT_IN_THEMES.length + 1);
  });

  test('without it (removed since), the same pair falls back to the default palette', () => {
    expect(normalizeThemePair({ mode: 'dark', light: 'instrument', dark: 'instrument' })).toMatchObject({ light: 'plannotator', dark: 'plannotator' });
  });

  test('a one-half theme is offered and drawn only for its half', () => {
    setCustomThemes([entry('monokai-classic', 'dark-only')]);
    expect(getUnsupportedMode('monokai-classic')).toBe('light');
    expect(themeSupportsHalf('monokai-classic', 'light')).toBe(false);
    expect(themesForHalf(getAllThemes(), 'light').some((t) => t.id === 'monokai-classic')).toBe(false);
    expect(themesForHalf(getAllThemes(), 'dark')[0]!.id).toBe('monokai-classic');
    expect(normalizeThemePair({ mode: 'light', light: 'monokai-classic', dark: 'monokai-classic' })).toMatchObject({ light: 'plannotator', dark: 'monokai-classic' });
  });

  test('malformed or forged entries are dropped', () => {
    setCustomThemes([
      entry('dracula'),
      entry('Bad Id'),
      { ...entry('bad-colour'), colors: { dark: { ...swatch, primary: 'url(x)' }, light: swatch } },
      { ...entry('bad-mode'), modeSupport: 'sometimes' },
      'instrument',
      null,
      entry('kept'),
      entry('kept', 'both', 'A duplicate'),
    ]);
    expect(getAllThemes().filter((t) => !t.builtIn).map((t) => [t.id, t.name])).toEqual([['kept', 'kept']]);
    setCustomThemes({ not: 'a list' });
    expect(getAllThemes()).toBe(BUILT_IN_THEMES);
  });

  test("the server's built-in ids are exactly the registry's and the theme files'", () => {
    const registry = BUILT_IN_THEMES.map((t) => t.id).sort();
    const files = readdirSync(join(import.meta.dir, '..', 'themes')).filter((f) => f.endsWith('.css')).map((f) => f.slice(0, -4)).sort();
    expect([...BUILT_IN_THEME_IDS].sort()).toEqual(registry);
    expect(files).toEqual(registry);
  });

  test("the server's mode support for each built-in is the registry's (theme use never writes a half a page cannot draw)", () => {
    for (const theme of BUILT_IN_THEMES) expect([theme.id, builtInThemeModeSupport(theme.id)]).toEqual([theme.id, theme.modeSupport]);
    expect(builtInThemeModeSupport('not-a-built-in')).toBeUndefined();
  });
});
