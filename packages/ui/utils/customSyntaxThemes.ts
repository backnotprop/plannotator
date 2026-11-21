/**
 * A custom theme's own code colours (`syntax` in its theme file), as Shiki
 * themes `@pierre/diffs` resolves by name: every fence (codeHighlight.ts), the
 * code review diff pane and the Inbox's diffs, in one highlighter.
 *
 * A half with code colours draws in `plannotator-custom-<id>-<half>`
 * (`customSyntaxThemeName`); `syntaxTheme.ts` hands that name out for the
 * palette. Pierre resolves a name through the loaders `registerCustomTheme`
 * keeps, on the main thread (its worker pool and the Inbox's fence worker are
 * handed what the page resolved). Each name is registered with a loader that
 * asks the server for the theme's code colours (`/plannotator-themes.js?syntax=<id>`)
 * the first time code renders in it, so the page script that runs before the
 * first paint stays small. What arrives is checked again (`syntaxTextMateTheme`:
 * scopes, #hex colours and font styles only); anything else, or a failed
 * fetch, draws in Pierre's default theme for that half, as a palette with no
 * code colours does.
 *
 * Registration needs Pierre's module, which loads late on most pages:
 * `connectCustomSyntaxThemes` is called by whatever loads it first (the
 * wrapper's loader, the review editor's theme hook, the Inbox's draw gate),
 * before any theme name reaches Pierre.
 */

import { syntaxTextMateTheme, type ThemeFileHalf } from '@plannotator/core/theme-file';
import { connectFenceSyntaxThemes } from './fenceSyntaxThemes';
import { getCustomThemes, type ThemeInfo } from './themeRegistry';

/** Pierre's two calls this needs (`@pierre/diffs`). */
export interface CustomSyntaxPierre {
  registerCustomTheme: (name: string, loader: () => Promise<never>) => void;
  resolveTheme: (name: never) => Promise<{ textmate?: unknown }>;
}

const PREFIX = 'plannotator-custom-';
const DEFAULT_THEME: Record<ThemeFileHalf, string> = { dark: 'pierre-dark', light: 'pierre-light' };

/** The Shiki theme name one half of a custom theme draws code in. */
export function customSyntaxThemeName(id: string, half: ThemeFileHalf): string {
  return `${PREFIX}${id}-${half}`;
}

/** The half a palette draws in a mode: its own half, or a one-half theme's only half. */
function drawnHalf(theme: ThemeInfo, mode: ThemeFileHalf): ThemeFileHalf {
  if (theme.modeSupport === 'dark-only') return 'dark';
  if (theme.modeSupport === 'light-only') return 'light';
  return mode;
}

/** The code colour theme a custom palette draws in a mode, or null (not custom, or no code colours in that half). */
export function customSyntaxThemeFor(colorTheme: string, mode: ThemeFileHalf): string | null {
  const theme = getCustomThemes().find(({ id }) => id === colorTheme);
  if (!theme?.syntax) return null;
  const half = drawnHalf(theme, mode);
  return theme.syntax.includes(half) ? customSyntaxThemeName(theme.id, half) : null;
}

/** The server's answer per theme id, fetched once a page. */
const fetched = new Map<string, Promise<unknown>>();
let fetchSyntax = (id: string): Promise<unknown> =>
  fetch(`/plannotator-themes.js?syntax=${encodeURIComponent(id)}`).then((res) => (res.ok ? res.json() : null));

const registered = new Set<string>();

/** Register every custom half with code colours with Pierre (once per name; call again after setCustomThemes). */
export function connectCustomSyntaxThemes(pierre: CustomSyntaxPierre): void {
  if (typeof pierre?.registerCustomTheme !== 'function') return;
  // The fences' default code colours (fenceSyntaxThemes.ts) resolve by name the same way.
  connectFenceSyntaxThemes(pierre);
  for (const theme of getCustomThemes()) {
    for (const half of theme.syntax ?? []) {
      const name = customSyntaxThemeName(theme.id, half);
      if (registered.has(name)) continue;
      registered.add(name);
      const id = theme.id;
      pierre.registerCustomTheme(name, (async () => {
        let answer: unknown = null;
        try {
          if (!fetched.has(id)) fetched.set(id, fetchSyntax(id).catch(() => null));
          answer = await fetched.get(id);
        } catch {
          answer = null;
        }
        const own = answer && typeof answer === 'object' ? syntaxTextMateTheme(name, half, (answer as Record<string, unknown>)[half]) : null;
        if (own) return own;
        // Not there, or not valid: Pierre's default for the half, under this name.
        const fallback = await pierre.resolveTheme(DEFAULT_THEME[half] as never);
        return { ...(fallback.textmate as object), name };
      }) as () => Promise<never>);
    }
  }
}

/** Tests: replace the fetch, and forget what was fetched. */
export function __setCustomSyntaxFetchForTests(fn: ((id: string) => Promise<unknown>) | null): void {
  fetched.clear();
  if (fn) fetchSyntax = fn;
}
