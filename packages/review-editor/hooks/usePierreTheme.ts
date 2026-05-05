import { useState, useEffect } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';

export const SHIKI_THEME_MAP: Record<string, { dark: string; light: string }> = {
  'andromeeda': { dark: 'andromeeda', light: 'andromeeda' },
  'aurora-x': { dark: 'aurora-x', light: 'aurora-x' },
  'ayu-dark': { dark: 'ayu-dark', light: 'ayu-dark' },
  'catppuccin': { dark: 'catppuccin-mocha', light: 'catppuccin-latte' },
  'dark-plus': { dark: 'dark-plus', light: 'light-plus' },
  'dracula': { dark: 'dracula', light: 'dracula' },
  'everforest': { dark: 'everforest-dark', light: 'everforest-light' },
  'everforest-hard': { dark: 'everforest-dark', light: 'everforest-light' },
  'everforest-soft': { dark: 'everforest-dark', light: 'everforest-light' },
  'github': { dark: 'github-dark', light: 'github-light' },
  'gruvbox': { dark: 'gruvbox-dark-medium', light: 'gruvbox-light-medium' },
  'houston': { dark: 'houston', light: 'houston' },
  'kanagawa-dragon': { dark: 'kanagawa-dragon', light: 'kanagawa-dragon' },
  'kanagawa-lotus': { dark: 'kanagawa-lotus', light: 'kanagawa-lotus' },
  'kanagawa-wave': { dark: 'kanagawa-wave', light: 'kanagawa-wave' },
  'laserwave': { dark: 'laserwave', light: 'laserwave' },
  'material': { dark: 'material-theme', light: 'material-theme-lighter' },
  'min': { dark: 'min-dark', light: 'min-light' },
  'monokai-pro': { dark: 'monokai', light: 'monokai' },
  'night-owl': { dark: 'night-owl', light: 'night-owl' },
  'nord': { dark: 'nord', light: 'nord' },
  'one-dark-pro': { dark: 'one-dark-pro', light: 'one-dark-pro' },
  'one-light': { dark: 'one-light', light: 'one-light' },
  'plastic': { dark: 'plastic', light: 'plastic' },
  'poimandres': { dark: 'poimandres', light: 'poimandres' },
  'red': { dark: 'red', light: 'red' },
  'rose-pine': { dark: 'rose-pine', light: 'rose-pine-dawn' },
  'slack': { dark: 'slack-dark', light: 'slack-ochin' },
  'snazzy-light': { dark: 'snazzy-light', light: 'snazzy-light' },
  'solarized': { dark: 'solarized-dark', light: 'solarized-light' },
  'synthwave-84': { dark: 'synthwave-84', light: 'synthwave-84' },
  'tokyo-night': { dark: 'tokyo-night', light: 'tokyo-night' },
  'vesper': { dark: 'vesper', light: 'vesper' },
  'vitesse': { dark: 'vitesse-dark', light: 'vitesse-light' },
  'vitesse-black': { dark: 'vitesse-black', light: 'vitesse-black' },
};

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
    if (!bg || !fg) return { type: resolvedMode ?? 'dark', css: '', syntaxTheme: SHIKI_THEME_MAP[colorTheme] };
    return { type: resolvedMode ?? 'dark', syntaxTheme: SHIKI_THEME_MAP[colorTheme], css: `
      :host, [data-diff], [data-file], [data-diffs-header], [data-error-wrapper], [data-virtualizer-buffer] {
        --diffs-bg: ${bg} !important; --diffs-fg: ${fg} !important;
        --diffs-dark-bg: ${bg}; --diffs-light-bg: ${bg}; --diffs-dark: ${fg}; --diffs-light: ${fg};
      }
      pre, code { background-color: ${bg} !important; }
    `};
  });

  useEffect(() => {
    requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      const bg = styles.getPropertyValue('--background').trim();
      const fg = styles.getPropertyValue('--foreground').trim();
      const muted = styles.getPropertyValue('--muted').trim();
      const primary = styles.getPropertyValue('--primary').trim();
      if (!bg || !fg) return;

      const fontCSS = fontFamily || fontSize ? `
          pre, code, [data-line-content], [data-column-number] {
            ${fontFamily ? `font-family: '${fontFamily}', monospace !important;` : ''}
            ${fontSize ? `font-size: ${fontSize} !important; line-height: 1.5 !important;` : ''}
          }` : '';

      setPierreTheme({
        type: resolvedMode,
        syntaxTheme: SHIKI_THEME_MAP[colorTheme],
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
          ${fontCSS}
        `,
      });
    });
  }, [resolvedMode, colorTheme, fontFamily, fontSize, showFileHeader]);

  return pierreTheme;
}
