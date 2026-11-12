import { useState, useEffect } from 'react';
import type { DiffLineBgIntensity } from '@plannotator/shared/config';
import { extendThemeSwitch, useTheme } from '@plannotator/ui/components/ThemeProvider';
import { useConfigValue } from '@plannotator/ui/config';
import { buildPierreFontCSS } from '../utils/pierreFontCss';

import { resolveSyntaxTheme } from '@plannotator/ui/utils/syntaxTheme';
import { tokenHoverUnderlineCss } from '../components/tokenHoverStyles';
export { SHIKI_THEME_MAP, resolveSyntaxTheme } from '@plannotator/ui/utils/syntaxTheme';

export interface PierreTheme {
  type: 'dark' | 'light';
  css: string;
  syntaxTheme?: { dark: string; light: string };
}

interface IntensityConfig {
  restMixLight: number;
  restMixDark: number;
  hoverMixLight: number;
  hoverMixDark: number;
}

const INTENSITY_CONFIG: Record<Exclude<DiffLineBgIntensity, 'subtle'>, IntensityConfig> = {
  normal: { restMixLight: 55, restMixDark: 45, hoverMixLight: 45, hoverMixDark: 35 },
  strong: { restMixLight: 35, restMixDark: 25, hoverMixLight: 25, hoverMixDark: 15 },
};

const PIERRE_HOVER_KEEP_LIGHT = 0.97;
const PIERRE_HOVER_KEEP_DARK = 0.91;

function hoverEmittedMix(finalShare: number, keep: number): string {
  return (finalShare / keep).toFixed(2);
}

const SUBTLE_HOVER_FINALS = {
  deletion: { light: 80, dark: 75 },
  addition: { light: 80, dark: 70 },
};

const EMPHASIS_LIGHTNESS_SHIFT = 0.07;

export function buildLineBgOverrides(intensity: DiffLineBgIntensity, mode: 'light' | 'dark'): string {
  const hideEmphasisWithoutBg = `
    pre:not([data-background]) [data-line-type='change-addition'] [data-diff-span],
    pre:not([data-background]) [data-line-type='change-deletion'] [data-diff-span] {
      background-color: transparent !important;
    }
  `;
  const changedLine =
    "[data-background] :is([data-line-type='change-addition'], [data-line-type='change-deletion'])" +
    ":is([data-line], [data-no-newline])";
  if (intensity === 'subtle') {
    const del = SUBTLE_HOVER_FINALS.deletion;
    const add = SUBTLE_HOVER_FINALS.addition;
    return `
      [data-background] [data-line-type='change-deletion']:is([data-line], [data-no-newline])[data-hovered] {
        --mix-light: ${hoverEmittedMix(del.light, PIERRE_HOVER_KEEP_LIGHT)}%;
        --mix-dark: ${hoverEmittedMix(del.dark, PIERRE_HOVER_KEEP_DARK)}%;
      }
      [data-background] [data-line-type='change-addition']:is([data-line], [data-no-newline])[data-hovered] {
        --mix-light: ${hoverEmittedMix(add.light, PIERRE_HOVER_KEEP_LIGHT)}%;
        --mix-dark: ${hoverEmittedMix(add.dark, PIERRE_HOVER_KEEP_DARK)}%;
      }
      ${hideEmphasisWithoutBg}
    `;
  }
  const cfg = INTENSITY_CONFIG[intensity];
  const lShift = mode === 'dark'
    ? `+ ${EMPHASIS_LIGHTNESS_SHIFT}`
    : `- ${EMPHASIS_LIGHTNESS_SHIFT}`;
  return `
    ${changedLine}:not([data-hovered]) {
      --mix-light: ${cfg.restMixLight}%;
      --mix-dark: ${cfg.restMixDark}%;
    }
    ${changedLine}[data-hovered] {
      --mix-light: ${hoverEmittedMix(cfg.hoverMixLight, PIERRE_HOVER_KEEP_LIGHT)}%;
      --mix-dark: ${hoverEmittedMix(cfg.hoverMixDark, PIERRE_HOVER_KEEP_DARK)}%;
    }
    ${changedLine} {
      --diffs-bg-addition-emphasis: oklch(from var(--diffs-computed-diff-line-bg) calc(l ${lShift}) c h);
      --diffs-bg-deletion-emphasis: oklch(from var(--diffs-computed-diff-line-bg) calc(l ${lShift}) c h);
    }
    ${hideEmphasisWithoutBg}
  `;
}

const SELECTION_BAR_PLUS_CSS = `[data-gutter-utility-slot] { display: var(--review-selection-plus, flex); }`;

const COMPACT_TOUCH_GUTTER_UTILITY_CSS = `
  [data-utility-button]::before {
    inset: 50% auto auto 50%;
    width: max(var(--pn-touch-target, 2.75rem), calc(100% + 4px));
    height: max(var(--pn-touch-target, 2.75rem), 100%);
    transform: translate(-50%, -50%);
  }
`;

const HOST_SURFACE_HOOKS_CSS = `
  [data-diffs-header][data-sticky], [data-diffs-header='default'] { background-color: var(--pn-diff-header-bg, var(--diffs-bg)); }
  pre[data-diff], pre[data-file] {
    border: var(--pn-diff-code-border, none);
    border-radius: var(--pn-diff-code-radius, 0);
    overflow: var(--pn-diff-code-overflow, visible);
  }
  [data-code]::-webkit-scrollbar-track { margin: 0 var(--pn-diff-code-radius, 0); }
`;

export function usePierreTheme(options?: {
  fontFamily?: string;
  fontSize?: string;
  showFileHeader?: boolean;
  compactTouchLayout?: boolean;
}): PierreTheme {
  const { colorTheme, resolvedMode } = useTheme();
  const fontFamily = options?.fontFamily;
  const fontSize = options?.fontSize;
  const showFileHeader = options?.showFileHeader ?? false;
  const compactTouchLayout = options?.compactTouchLayout === true;
  const compactTouchCSS = compactTouchLayout ? COMPACT_TOUCH_GUTTER_UTILITY_CSS : '';
  const lineBgIntensity = useConfigValue('diffLineBgIntensity');

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
      ${buildLineBgOverrides(lineBgIntensity, resolvedMode ?? 'dark')}
      ${compactTouchCSS}
      ${SELECTION_BAR_PLUS_CSS}
      ${HOST_SURFACE_HOOKS_CSS}
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

      const fontCSS = buildPierreFontCSS(fontFamily, fontSize);

      extendThemeSwitch();
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
          /* Pierre's own horizontal scrollbar, at the bottom of each file's
             code (theme.css lets it keep its own size). Its thumb is
             transparent until hover upstream; here it has a quiet mix of the
             text colour that reads in light and dark. Firefox has no
             -webkit- pseudo: its scrollbar-color. */
          [data-code]::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, ${fg} 28%, ${bg}) !important; }
          [data-code]::-webkit-scrollbar-thumb:hover { background-color: color-mix(in srgb, ${fg} 45%, ${bg}) !important; }
          @supports (-moz-appearance: none) {
            [data-code] { scrollbar-color: color-mix(in srgb, ${fg} 28%, ${bg}) transparent; }
          }
          .pn-token-hover {${tokenHoverUnderlineCss(primary || 'oklch(0.70 0.20 280)')}
          }
          .pn-token-nav {
            text-decoration-thickness: 2px;
            /* Pierre's [data-*] selectors outrank a bare class inside the
               shadow root, so the pointer needs the same !important the
               neighboring overrides use, or the I-beam wins. */
            cursor: pointer !important;
            opacity: 0.85;
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

          ${buildLineBgOverrides(lineBgIntensity, resolvedMode)}

          ${compactTouchCSS}
          ${SELECTION_BAR_PLUS_CSS}

          ${HOST_SURFACE_HOOKS_CSS}
        `,
      });
    });
  }, [resolvedMode, colorTheme, fontFamily, fontSize, showFileHeader, lineBgIntensity, compactTouchCSS]);

  return pierreTheme;
}
