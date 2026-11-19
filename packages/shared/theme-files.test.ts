/**
 * Custom themes in the data dir (theme-files.ts) and the script every page
 * loads them through. The failures these guard: a theme file edited by hand
 * into something unsafe being drawn, a file whose name and id disagree being
 * loaded (two ids for one theme), the cap not holding, a removed theme lost
 * instead of kept, the script letting a theme's name end the script element or
 * carrying CSS that is not a colour, and the Inbox's id check accepting an id
 * that is neither built in nor added.
 *
 * Each test works in its own temp folder (never the real data dir).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUSTOM_THEME_LIMIT, type ThemeFile } from '@plannotator/core/theme-file';
import {
  customThemesDir,
  customThemesPayload,
  customThemesScript,
  isRegisteredThemeId,
  listCustomThemes,
  removeCustomTheme,
  saveCustomTheme,
} from './theme-files';

const scratch = () => mkdtempSync(join(tmpdir(), 'plannotator-theme-files-'));
const theme = (id: string, name = id): ThemeFile => ({ plannotatorTheme: 1, id, name, dark: { background: '#0f1419', foreground: '#d8dee6' } });

/** Run the served script against a stand-in document; what it handed the page. */
function runScript(source: string): { themes: unknown; css: string | null } {
  const appended: { textContent: string }[] = [];
  const doc = { createElement: () => ({ id: '', textContent: '' }), head: { appendChild: (el: { textContent: string }) => appended.push(el) } };
  const win: Record<string, unknown> = {};
  new Function('window', 'document', source)(win, doc);
  return { themes: win.__PLANNOTATOR_CUSTOM_THEMES__, css: appended[0]?.textContent ?? null };
}

describe('the themes folder', () => {
  test('saved, listed by name, replaced by id, and removed by moving it aside', () => {
    const dir = scratch();
    expect(saveCustomTheme(dir, theme('zeta', 'Zeta'))).toMatchObject({ ok: true, replaced: false });
    expect(saveCustomTheme(dir, theme('alpha', 'Alpha'))).toMatchObject({ ok: true, replaced: false });
    expect(saveCustomTheme(dir, theme('zeta', 'Zeta Two'))).toMatchObject({ ok: true, replaced: true });
    expect(listCustomThemes(dir).themes.map((t) => t.name)).toEqual(['Alpha', 'Zeta Two']);

    const movedTo = removeCustomTheme(dir, 'zeta', 1700000000000);
    expect(movedTo).toBe(join(customThemesDir(dir), 'removed', 'zeta-1700000000000.json'));
    expect(JSON.parse(readFileSync(movedTo!, 'utf8')).name).toBe('Zeta Two');
    expect(listCustomThemes(dir).themes.map((t) => t.id)).toEqual(['alpha']);
    expect(removeCustomTheme(dir, 'zeta')).toBeNull();
    expect(removeCustomTheme(dir, '../alpha')).toBeNull();
  });

  test('a hand-edited file that is not valid, too large, or named for another id is skipped with its reason', () => {
    const dir = scratch();
    const folder = customThemesDir(dir);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'evil.json'), JSON.stringify({ ...theme('evil'), dark: { background: '#000;} body{display:none' } }));
    writeFileSync(join(folder, 'other.json'), JSON.stringify(theme('someone-else')));
    writeFileSync(join(folder, 'big.json'), JSON.stringify({ ...theme('big'), name: 'x'.repeat(20_000) }));
    writeFileSync(join(folder, 'broken.json'), '{ not json');
    saveCustomTheme(dir, theme('fine'));
    const { themes, skipped } = listCustomThemes(dir);
    expect(themes.map((t) => t.id)).toEqual(['fine']);
    const reason = Object.fromEntries(skipped.map((s) => [s.file, s.reason]));
    expect(Object.keys(reason).sort()).toEqual(['big.json', 'broken.json', 'evil.json', 'other.json']);
    expect(reason['big.json']).toBe('larger than 16 KB.');
    expect(reason['broken.json']).toStartWith('not readable as JSON');
    expect(reason['evil.json']).toStartWith('dark.background: ');
    expect(reason['other.json']).toBe('its id is "someone-else"; the file must be named someone-else.json.');
    expect(customThemesPayload(dir).css).not.toContain('display');
  });

  test(`no more than ${CUSTOM_THEME_LIMIT}: one more is refused, replacing one still works`, () => {
    const dir = scratch();
    for (let i = 0; i < CUSTOM_THEME_LIMIT; i++) expect(saveCustomTheme(dir, theme(`t${i}`)).ok).toBe(true);
    expect(saveCustomTheme(dir, theme('one-more'))).toMatchObject({ ok: false, code: 'too_many' });
    expect(saveCustomTheme(dir, theme('t3', 'Renamed')).ok).toBe(true);
    expect(readdirSync(customThemesDir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(CUSTOM_THEME_LIMIT);
  });

  test('the id check accepts a built-in or an added theme, and nothing else', () => {
    const dir = scratch();
    expect(isRegisteredThemeId(dir, 'tokyo-night')).toBe(true);
    expect(isRegisteredThemeId(dir, 'harbor')).toBe(false);
    saveCustomTheme(dir, theme('harbor'));
    expect(isRegisteredThemeId(dir, 'harbor')).toBe(true);
    expect(isRegisteredThemeId(dir, 'harbor-2')).toBe(false);
    expect(isRegisteredThemeId(dir, '../harbor')).toBe(false);
  });
});

describe('the page script', () => {
  test('with no themes: an empty list and no stylesheet', () => {
    const dir = scratch();
    expect(existsSync(customThemesDir(dir))).toBe(false);
    expect(runScript(customThemesScript(dir))).toEqual({ themes: [], css: null });
  });

  test('hands the page each theme and its stylesheet, and a name cannot end the script', () => {
    const dir = scratch();
    saveCustomTheme(dir, { ...theme('harbor'), name: '</script><script>alert(1)</script>' });
    const source = customThemesScript(dir);
    expect(source).not.toContain('<');
    const { themes, css } = runScript(source);
    expect((themes as { id: string; name: string }[])[0]).toMatchObject({ id: 'harbor', name: '</script><script>alert(1)</script>' });
    expect(css).toContain('.theme-harbor {');
    expect(css).toContain('--background: #0f1419;');
  });
});
