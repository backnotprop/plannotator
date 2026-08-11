import { useState, useEffect } from 'react';
import type { DiffLineBgIntensity } from '@plannotator/shared/config';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { useConfigValue } from '@plannotator/ui/config';

/**
 * The (colorTheme, mode) -> Shiki theme mapping moved to
 * `@plannotator/ui/utils/syntaxTheme` so the plan editor's markdown fences
 * resolve the same theme this diff pane does. Re-exported here because it is
 * the import path the review editor has always used.
 */
import { resolveSyntaxTheme } from '@plannotator/ui/utils/syntaxTheme';
export { SHIKI_THEME_MAP, resolveSyntaxTheme } from '@plannotator/ui/utils/syntaxTheme';

export interface PierreTheme {
  type: 'dark' | 'light';
  css: string;
  syntaxTheme?: { dark: string; light: string };
}

/**
 * Bg-share percentages plugged into Pierre's `--mix-light` / `--mix-dark` —
 * the share of decoration-bg in `color-mix(decoration-bg X%, mix-target)`
 * inside Pierre's `light-dark()` switch (`Light` applies in light themes,
 * `Dark` in dark themes). Lower number = more line colour. We mirror Pierre's
 * own pattern of slightly lower values for dark themes (its defaults are
 * 88 / 80) since darker themes need a larger colour share to read at the
 * same perceptual intensity.
 *
 * `hoverMix*` values are the FINAL rendered bg shares, matching what our
 * pre-1.3 overrides produced. Since @pierre/diffs 1.3.0 the per-selector
 * hover rules (`[data-hovered] { --mix-light: … }`) are gone; hover is one
 * central rule that re-mixes `--diffs-computed-editor-active-line-bg`
 * 97% (light) / 91% (dark) toward `--diffs-hover-mix-target` (the
 * addition/deletion base colour on changed lines). Our hovered `--mix-*`
 * values therefore feed the rest formula first and get multiplied by
 * 0.97 / 0.91 on the way to the screen — `hoverEmittedMix()` divides the
 * targets back out so the composed result equals these numbers exactly
 * (color-mix in lab is linear, so the compensation is exact).
 *
 * Driving the line bg through these vars (instead of overriding the final
 * `background-color`) keeps Pierre's `--diffs-line-bg` pipeline intact, so
 * selected / hovered / decorated states keep their state-specific visuals.
 */
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

/** Pierre's central hover rule mixes the rest bg by these shares toward the
 * hover mix target (light-dark(97%, 91%) since 1.3.0). */
const PIERRE_HOVER_KEEP_LIGHT = 0.97;
const PIERRE_HOVER_KEEP_DARK = 0.91;

/** Convert a desired FINAL hovered bg share into the `--mix-*` value to emit,
 * compensating for Pierre's central hover re-mix. */
function hoverEmittedMix(finalShare: number, keep: number): string {
  return (finalShare / keep).toFixed(2);
}

/**
 * At 1.2.12 Pierre's own per-selector hover rules gave changed lines these
 * final bg shares (deletion 80/75, addition 80/70). `subtle` rode them
 * untouched; 1.3.x's central hover rule instead lands at ~85.4 light /
 * ~72.8 dark, a visibly weaker light-theme hover. We pin the old finals so
 * `subtle` hover looks the same before and after the upgrade.
 */
const SUBTLE_HOVER_FINALS = {
  deletion: { light: 80, dark: 75 },
  addition: { light: 80, dark: 70 },
};

/**
 * The word-level chip is derived from the *actual computed line bg* (not from
 * the theme's addition/deletion base colour) and nudged by this OKLCH-`l`
 * delta — darker on light themes, lighter on dark themes. Pulling it off the
 * line bg keeps the chip-vs-line relationship constant across intensities:
 * Normal and Strong each produce a chip that's "one step deeper than this
 * specific line", instead of one fixed chip that fights more or less against
 * different lines.
 */
const EMPHASIS_LIGHTNESS_SHIFT = 0.07;

/**
 * @pierre/diffs hardcodes the diff-line bg as a ~12-20% mix of the line colour
 * over the gutter (`--mix-light: 88%` / `--mix-dark: 80%`). To get a bolder
 * look we lower those percentages on changed lines, so the library's existing
 * `--diffs-line-bg` pipeline naturally produces stronger output. The hue comes
 * from the resolved theme tokens (`--diffs-addition-base` /
 * `--diffs-deletion-base`) — themes that customize diff colours keep them.
 *
 * `subtle` keeps Pierre's default line bg (its faint mix + alpha-overlay
 * emphasis is exactly what Pierre's design intends), but still emits the
 * "hide emphasis when diff bg is off" rule so that toggle behaves consistently
 * at every intensity.
 */
export function buildLineBgOverrides(intensity: DiffLineBgIntensity, mode: 'light' | 'dark'): string {
  // The library's word-emphasis rule (`[data-line-type=…] [data-diff-span] {
  // background-color: var(--diffs-bg-addition-emphasis); }`) is NOT gated on
  // `[data-background]`, so disabling diff backgrounds still leaves chips
  // showing on plain lines. We hide them explicitly. Applies regardless of
  // intensity so the "Diff background" toggle behaves consistently.
  const hideEmphasisWithoutBg = `
    pre:not([data-background]) [data-line-type='change-addition'] [data-diff-span],
    pre:not([data-background]) [data-line-type='change-deletion'] [data-diff-span] {
      background-color: transparent !important;
    }
  `;
  // Targeting `[data-line]` and `[data-no-newline]` only — the actual code
  // lines. Skipping `[data-gutter-buffer]` / `[data-column-number]` keeps the
  // line-number gutter at the page bg (matching the existing
  // `[data-column-number] { background-color: bg }` integration). Gating on
  // `[data-background]` mirrors the library's own `:where([data-background])`
  // scoping, so the "Diff background" toggle still turns line bgs off.
  //
  // Specificity is (0,4,0); wins against the library's rest rules (max
  // (0,2,0) inside `:where([data-background])`). Since 1.3.0 the library's
  // hover rule sets `--diffs-computed-hovered-line-bg` (a different property)
  // on `[data-line][data-hovered]`, so there is no specificity race on
  // `--mix-*` anymore — our hovered `--mix-*` values flow through the rest
  // formula and Pierre's central hover re-mix composes on top (compensated
  // via hoverEmittedMix, see INTENSITY_CONFIG docs).
  const changedLine =
    "[data-background] :is([data-line-type='change-addition'], [data-line-type='change-deletion'])" +
    ":is([data-line], [data-no-newline])";
  if (intensity === 'subtle') {
    // Keep Pierre's rest bg untouched, but pin the hovered finals to the
    // 1.2.x values (see SUBTLE_HOVER_FINALS). Per-type split preserved:
    // 1.2.x deletion hover was 80/75, addition 80/70.
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

export function usePierreTheme(options?: { fontFamily?: string; fontSize?: string; showFileHeader?: boolean }): PierreTheme {
  const { colorTheme, resolvedMode } = useTheme();
  const fontFamily = options?.fontFamily;
  const fontSize = options?.fontSize;
  const showFileHeader = options?.showFileHeader ?? false;
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
          .pn-token-nav {
            text-decoration-thickness: 2px;
            cursor: pointer;
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
        `,
      });
    });
  }, [resolvedMode, colorTheme, fontFamily, fontSize, showFileHeader, lineBgIntensity]);

  return pierreTheme;
}
