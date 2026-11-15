/**
 * Two rules of the scheduled sheet that a screen showed broken. A bare `1fr` grid track grows to its longest content,
 * so a long folder path pushed the editor past a 390-wide pane: every flexible track sets its own minimum. And the
 * native time, date and select controls drew their light-theme icons on the dark theme (a clock you could not see):
 * under the dark theme they take the dark color scheme, as the Ask card's controls do.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSheet } from '../../ui/scripts/build-inbox-thread-css';

const sheet = () => parseSheet(readFileSync(resolve(import.meta.dir, 'scheduled.css'), 'utf8'));

test('no grid track in scheduled.css is a bare fr that a long path can widen', () => {
  const bare: string[] = [];
  sheet().walkDecls('grid-template-columns', (decl) => {
    const outside = decl.value.replace(/minmax\([^)]*\)/g, '');
    if (/\dfr\b/.test(outside)) bare.push(`${(decl.parent as { selector?: string }).selector}: ${decl.value}`);
  });
  expect(bare).toEqual([]);
});

test('the native pickers take the dark color scheme under the dark theme', () => {
  const dark: string[] = [];
  sheet().walkDecls('color-scheme', (decl) => {
    const selector = (decl.parent as { selector?: string }).selector ?? '';
    if (decl.value === 'dark' && selector.startsWith(':root:not(.light)')) dark.push(selector);
  });
  expect(dark.some((selector) => /\.st-pick$/.test(selector))).toBe(true);
});
