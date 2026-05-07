import { useState, useEffect } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';

export const SHIKI_THEME_MAP: Record<string, { dark: string | null; light: string | null }> = {
  'andromeeda': { dark: 'andromeeda', light: null },
  'aurora-x': { dark: 'aurora-x', light: null },
  'ayu-dark': { dark: 'ayu-dark', light: null },
  'catppuccin': { dark: 'catppuccin-mocha', light: 'catppuccin-latte' },
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

export function resolveSyntaxTheme(colorTheme: string, mode: 'dark' | 'light'): { dark: string; light: string } | undefined {
  const map = SHIKI_THEME_MAP[colorTheme];
  if (!map || !map[mode]) return undefined;
  return { dark: map.dark || 'pierre-dark', light: map.light || 'pierre-light' };
}

export interface PierreTheme {
  type: 'dark' | 'light';
  css: string;
  syntaxTheme?: { dark: string; light: string };
}

export function usePierreTheme(options?: { fontFamily?: string; fontSize?: string; showFileHeader?: boolean }): PierreTheme {
  const { colorTheme, resolvedMode } = useTheme();
  const fontFamily = options?.fontFamily;
  const fontSize = options?.fontSize;
  const showFileHeader = options?.showFileHeader ?? false;

  const [pierreTheme, setPierreTheme] = useState<PierreTheme>(() => {
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--background').trim();
    const fg = styles.getPropertyValue('--foreground').trim();
    if (!bg || !fg) return { type: resolvedMode ?? 'dark', css: '', syntaxTheme: resolveSyntaxTheme(colorTheme, resolvedMode ?? 'dark') };
    return { type: resolvedMode ?? 'dark', syntaxTheme: resolveSyntaxTheme(colorTheme, resolvedMode ?? 'dark'), css: `
      :host, [data-diff], [data-file], [data-diffs-header], [data-error-wrapper], [data-virtualizer-buffer] {
        --diffs-bg: ${bg} !important; --diffs-fg: ${fg} !important;
        --diffs-dark-bg: ${bg}; --diffs-light-bg: ${bg}; --diffs-dark: ${fg}; --diffs-light: ${fg};
      }
      pre, code { background-color: ${bg} !important; }
      :host { --diffs-bg-separator-override: color-mix(in srgb, ${fg} 8%, ${bg}); }
      [data-separator='line-info'], [data-separator='line-info-basic'] { height: 24px !important; }
      [data-separator='line-info'] { margin-block: 4px !important; }
    `};
  });

  useEffect(() => {
    requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      const bg = styles.getPropertyValue('--background').trim();
      const fg = styles.getPropertyValue('--foreground').trim();
      const muted = styles.getPropertyValue('--muted').trim();
      const mutedFg = styles.getPropertyValue('--muted-foreground').trim();
      const border = styles.getPropertyValue('--border').trim();
      const primary = styles.getPropertyValue('--primary').trim();
      if (!bg || !fg) return;

      const fontCSS = fontFamily || fontSize ? `
          pre, code, [data-line-content], [data-column-number] {
            ${fontFamily ? `font-family: '${fontFamily}', monospace !important;` : ''}
            ${fontSize ? `font-size: ${fontSize} !important; line-height: 1.5 !important;` : ''}
          }` : '';

      setPierreTheme({
        type: resolvedMode,
        syntaxTheme: resolveSyntaxTheme(colorTheme, resolvedMode),
        css: `
          :host, [data-diff], [data-file], [data-diffs-header], [data-error-wrapper], [data-virtualizer-buffer] {
            --diffs-bg: ${bg} !important;
            --diffs-fg: ${fg} !important;
            --diffs-dark-bg: ${bg};
            --diffs-light-bg: ${bg};
            --diffs-dark: ${fg};
            --diffs-light: ${fg};
          }
          pre, code { background-color: ${bg} !important; }
          [data-file-info] { background-color: ${muted} !important; }
          [data-column-number] { background-color: ${bg} !important; }
          ${showFileHeader ? '' : '[data-diffs-header] [data-title] { display: none !important; }'}
          [data-diff-type='split'][data-overflow='scroll'] {
            grid-template-columns:
              minmax(0, var(--split-left, 1fr))
              minmax(0, var(--split-right, 1fr)) !important;
          }
          [data-diff-type='split'][data-overflow='scroll'] > [data-code][data-deletions],
          [data-diff-type='split'][data-overflow='scroll'] > [data-code][data-additions],
          [data-diff-type='split'][data-overflow='scroll'] > [data-code][data-deletions] [data-content],
          [data-diff-type='split'][data-overflow='scroll'] > [data-code][data-additions] [data-content] {
            min-width: 0 !important;
          }
          .pn-token-hover {
            text-decoration: underline;
            text-decoration-color: ${primary || 'oklch(0.70 0.20 280)'};
            text-decoration-thickness: 1.5px;
            text-underline-offset: 2px;
            cursor: pointer;
          }

          /* Separator bars — slimmer, semi-transparent, integrated with theme */
          :host {
            --diffs-bg-separator-override: color-mix(in srgb, ${border || fg} 25%, ${bg});
          }
          [data-separator='line-info'],
          [data-separator='line-info-basic'] {
            height: 24px !important;
          }
          [data-separator='line-info'] {
            margin-block: 4px !important;
          }
          [data-separator-content] {
            font-size: 11px !important;
            color: ${mutedFg || fg} !important;
            opacity: 0.7;
          }
          [data-separator-content]:hover {
            opacity: 1;
          }
          [data-expand-button] {
            min-width: 24px !important;
            color: ${mutedFg || fg} !important;
            opacity: 0.5;
          }
          [data-expand-button]:hover {
            color: ${fg} !important;
            opacity: 1;
          }
          [data-expand-index] [data-separator-wrapper] {
            grid-template-columns: 24px auto !important;
          }
          [data-expand-index] [data-separator-wrapper][data-separator-multi-button] {
            grid-template-columns: 24px 24px auto !important;
          }
          @media (pointer: fine) {
            [data-separator='line-info'] [data-separator-wrapper] {
              grid-template-columns: 26px auto !important;
            }
            [data-separator='line-info'] [data-separator-wrapper][data-separator-multi-button] {
              grid-template-columns: 26px 26px auto !important;
            }
          }

          ${fontCSS}
        `,
      });
    });
  }, [resolvedMode, colorTheme, fontFamily, fontSize, showFileHeader]);

  return pierreTheme;
}
