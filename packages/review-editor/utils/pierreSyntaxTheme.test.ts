/**
 * The review editor's theme names for Pierre's diff views
 * (utils/pierreSyntaxTheme.ts, usePierreTheme.ts's `resolveSyntaxTheme`: what
 * the diff pane and the PR comments' hunk previews use). Imported from its own
 * module: other files mock usePierreTheme for the whole process. The failure this guards: a custom theme's code colour name handed to
 * Pierre before it is registered (Pierre then has no loader for it), when the
 * first code on the page is a hunk preview rather than the diff pane or a fence.
 */
import { afterEach, expect, test } from 'bun:test';
import * as pierre from '@pierre/diffs';
import { __setCustomSyntaxFetchForTests, customSyntaxThemeName } from '@plannotator/ui/utils/customSyntaxThemes';
import { setCustomThemes } from '@plannotator/ui/utils/themeRegistry';
import { resolvePierreSyntaxTheme as resolveSyntaxTheme } from './pierreSyntaxTheme';

const swatch = { primary: '#66d9ef', secondary: '#a1efe4', accent: '#ae81ff', background: '#272822', foreground: '#f8f8f2' };
const entry = (id: string) => ({ id, name: id, modeSupport: 'dark-only', colors: { dark: swatch, light: swatch }, syntax: ['dark'] });

afterEach(() => {
  setCustomThemes([]);
  __setCustomSyntaxFetchForTests(null);
});

test("a hunk preview's theme name is registered with Pierre before it is handed out", async () => {
  __setCustomSyntaxFetchForTests(async () => ({ dark: { foreground: '#f8f8f2', background: '#272822', rules: [{ scope: 'keyword', foreground: '#f92672' }] } }));
  // Nothing has registered this one: Pierre cannot resolve its name.
  setCustomThemes([entry('never-asked')]);
  await expect(pierre.resolveThemes([customSyntaxThemeName('never-asked', 'dark') as never])).rejects.toThrow();
  // Asking the review editor for the pair registers it first.
  setCustomThemes([entry('hunk-mono')]);
  const pair = resolveSyntaxTheme('hunk-mono', 'dark');
  expect(pair?.dark).toBe(customSyntaxThemeName('hunk-mono', 'dark'));
  const [resolved] = await pierre.resolveThemes([pair!.dark as never]);
  const rules = (resolved!.textmate as { settings?: { scope?: string | string[]; settings: { foreground?: string } }[] }).settings ?? [];
  expect(rules.find((rule) => rule.scope === 'keyword')?.settings.foreground).toBe('#f92672');
});
