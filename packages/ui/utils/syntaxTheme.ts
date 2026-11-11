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
  'plannotator-modern': { dark: null, light: 'github-light-high-contrast' },
  'plastic': { dark: 'plastic', light: null },
  'poimandres': { dark: 'poimandres', light: null },
  'red': { dark: 'red', light: null },
  'rose-pine': { dark: 'rose-pine', light: 'rose-pine-dawn' },
  'slack': { dark: 'slack-dark', light: 'slack-ochin' },
  'snazzy-light': { dark: null, light: 'snazzy-light' },
  'solarized': { dark: 'solarized-dark', light: 'solarized-light' },
  'synthwave-84': { dark: 'synthwave-84', light: null },
  'tokyo-night': { dark: 'tokyo-night', light: null },
  'tokyo-night-moon': { dark: 'tokyo-night', light: null },
  'vesper': { dark: 'vesper', light: null },
  'vitesse': { dark: 'vitesse-dark', light: 'vitesse-light' },
  'vitesse-black': { dark: 'vitesse-black', light: null },
};

export const DEFAULT_SYNTAX_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const;

/** The theme pair to hand `@pierre/diffs`, or `undefined` to let it use its own defaults. */
export function resolveSyntaxTheme(colorTheme: string, mode: 'dark' | 'light'): { dark: string; light: string } | undefined {
  const map = SHIKI_THEME_MAP[colorTheme];
  if (!map || !map[mode]) return undefined;
  return { dark: map.dark || DEFAULT_SYNTAX_THEME.dark, light: map.light || DEFAULT_SYNTAX_THEME.light };
}

export type FenceThemeResolver = (colorTheme: string, mode: 'light' | 'dark') => string | undefined;

let fenceThemeResolver: FenceThemeResolver | null = null;

/** Install (or with `null`, remove) the host's fence theme override. */
export function setFenceThemeResolver(resolver: FenceThemeResolver | null): void {
  fenceThemeResolver = resolver;
}

export function resetFenceThemeResolver(): void {
  fenceThemeResolver = null;
}

/** The single concrete Shiki theme name for the palette currently on screen. */
export function resolveFenceTheme(colorTheme: string, mode: 'dark' | 'light'): string {
  if (fenceThemeResolver) {
    let override: string | undefined;
    try {
      override = fenceThemeResolver(colorTheme, mode);
    } catch {
      override = undefined; // a throwing host resolver must not break rendering
    }
    if (typeof override === 'string' && override) return override;
  }
  return resolveSyntaxTheme(colorTheme, mode)?.[mode] ?? DEFAULT_SYNTAX_THEME[mode];
}
