/**
 * Maps a Plannotator colour theme onto the Shiki theme that renders code in it.
 *
 * This used to live in `packages/review-editor/hooks/usePierreTheme.ts` and only
 * served the diff pane. It moved here so the plan/annotate editor's markdown
 * fences resolve the SAME theme the diff pane resolves, which is what makes a
 * fenced code block and a diff hunk finally look like they belong to the same
 * app. `usePierreTheme` re-exports both symbols, so the review editor's imports
 * are unchanged.
 *
 * Names on the right are resolved by `@pierre/diffs` — the `pierre-*` ones come
 * from `@pierre/theme`, the rest from `@shikijs/themes`. Both registries are
 * already bundled (Pierre pulls in Shiki's full bundle), so consuming them here
 * costs no additional bytes.
 */

/** Plannotator theme id -> Shiki theme name, per mode. `null` = this palette
 *  has no counterpart in that mode and falls back to the Pierre default. */
export const SHIKI_THEME_MAP: Record<string, { dark: string | null; light: string | null }> = {
  'andromeeda': { dark: 'andromeeda', light: null },
  'aurora-x': { dark: 'aurora-x', light: null },
  'ayu-dark': { dark: 'ayu-dark', light: null },
  'catppuccin': { dark: 'catppuccin-mocha', light: 'catppuccin-latte' },
  'colorblind': { dark: 'pierre-dark-protanopia-deuteranopia', light: 'pierre-light-protanopia-deuteranopia' },
  'dark-plus': { dark: 'dark-plus', light: 'light-plus' },
  'dracula': { dark: 'dracula', light: null },
  'everforest': { dark: 'everforest-dark', light: 'everforest-light' },
  'everforest-hard': { dark: 'everforest-dark', light: 'everforest-light' },
  'everforest-soft': { dark: 'everforest-dark', light: 'everforest-light' },
  'github': { dark: 'github-dark', light: 'github-light' },
  'gruvbox': { dark: 'gruvbox-dark-medium', light: 'gruvbox-light-medium' },
  'houston': { dark: 'houston', light: null },
  'kanagawa-dragon': { dark: 'kanagawa-dragon', light: null },
  'kanagawa-lotus': { dark: null, light: 'kanagawa-lotus' },
  'kanagawa-wave': { dark: 'kanagawa-wave', light: null },
  'laserwave': { dark: 'laserwave', light: null },
  'material': { dark: 'material-theme', light: 'material-theme-lighter' },
  'min': { dark: 'min-dark', light: 'min-light' },
  'monokai-pro': { dark: 'monokai', light: null },
  'night-owl': { dark: 'night-owl', light: null },
  'nord': { dark: 'nord', light: null },
  'one-dark-pro': { dark: 'one-dark-pro', light: null },
  'one-light': { dark: null, light: 'one-light' },
  'plastic': { dark: 'plastic', light: null },
  'poimandres': { dark: 'poimandres', light: null },
  'red': { dark: 'red', light: null },
  'rose-pine': { dark: 'rose-pine', light: 'rose-pine-dawn' },
  'slack': { dark: 'slack-dark', light: 'slack-ochin' },
  'snazzy-light': { dark: null, light: 'snazzy-light' },
  'solarized': { dark: 'solarized-dark', light: 'solarized-light' },
  'synthwave-84': { dark: 'synthwave-84', light: null },
  'tokyo-night': { dark: 'tokyo-night', light: null },
  'vesper': { dark: 'vesper', light: null },
  'vitesse': { dark: 'vitesse-dark', light: 'vitesse-light' },
  'vitesse-black': { dark: 'vitesse-black', light: null },
};

/** `@pierre/diffs`' own `DEFAULT_THEMES`. Anything the map does not cover (the
 *  Plannotator default palette, plus every palette with no counterpart in the
 *  active mode) renders in these, which is exactly what the diff pane does when
 *  `resolveSyntaxTheme` returns `undefined`. */
export const DEFAULT_SYNTAX_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const;

/**
 * The theme pair to hand `@pierre/diffs`, or `undefined` to let it use its own
 * defaults. Returning `undefined` (rather than the default pair) is deliberate:
 * it keeps the diff pane's prop identity stable for palettes that never
 * customised it.
 */
export function resolveSyntaxTheme(colorTheme: string, mode: 'dark' | 'light'): { dark: string; light: string } | undefined {
  const map = SHIKI_THEME_MAP[colorTheme];
  if (!map || !map[mode]) return undefined;
  return { dark: map.dark || DEFAULT_SYNTAX_THEME.dark, light: map.light || DEFAULT_SYNTAX_THEME.light };
}

/**
 * The single concrete Shiki theme name for the palette currently on screen.
 * Markdown fences render one mode at a time, so unlike the diff pane (which
 * hands Pierre a dark/light pair and lets CSS pick) they want a resolved name.
 */
export function resolveFenceTheme(colorTheme: string, mode: 'dark' | 'light'): string {
  return resolveSyntaxTheme(colorTheme, mode)?.[mode] ?? DEFAULT_SYNTAX_THEME[mode];
}
