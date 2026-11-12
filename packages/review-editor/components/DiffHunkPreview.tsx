import React, { useMemo, useState, useEffect } from 'react';
import { FileDiff } from '@pierre/diffs/react';
import { getSingularPatch } from '@pierre/diffs';
import type { DiffLineBgIntensity } from '@plannotator/shared/config';
import { extendThemeSwitch, useTheme } from '@plannotator/ui/components/ThemeProvider';
import { useConfigValue } from '@plannotator/ui/config';
import { useReviewState } from '../dock/ReviewStateContext';
import { resolveSyntaxTheme, buildLineBgOverrides } from '../hooks/usePierreTheme';
import { buildPierreFontCSS } from '../utils/pierreFontCss';

interface DiffHunkPreviewProps {
  hunk: string;
  collapsedHunk?: string;
  maxHeight?: number;
  className?: string;
}

function buildPierreCSS(
  mode: 'light' | 'dark',
  fontFamily: string | undefined,
  fontSize: string | undefined,
  lineBgIntensity: DiffLineBgIntensity,
): string {
  try {
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--background').trim();
    const fg = styles.getPropertyValue('--foreground').trim();
    if (!bg || !fg) return '';

    const fontCSS = buildPierreFontCSS(fontFamily, fontSize);

    return `
      :host, [data-diff], [data-file], [data-diffs-header], [data-error-wrapper], [data-virtualizer-buffer] {
        --diffs-bg: ${bg} !important;
        --diffs-fg: ${fg} !important;
        --diffs-dark-bg: ${bg};
        --diffs-light-bg: ${bg};
        --diffs-dark: ${fg};
        --diffs-light: ${fg};
      }
      pre, code { background-color: ${bg} !important; }
      [data-column-number] { background-color: ${bg} !important; }
      [data-file-info] { display: none !important; }
      [data-diffs-header] { display: none !important; }
      ${fontCSS}
      ${buildLineBgOverrides(lineBgIntensity, mode)}
    `;
  } catch {
    return '';
  }
}

export const DiffHunkPreview: React.FC<DiffHunkPreviewProps> = ({
  hunk,
  collapsedHunk,
  maxHeight = 128,
  className,
}) => {
  const { resolvedMode, colorTheme } = useTheme();
  const state = useReviewState();
  const lineBgIntensity = useConfigValue('diffLineBgIntensity');
  const [expanded, setExpanded] = useState(false);

  const shown = !expanded && collapsedHunk ? collapsedHunk : hunk;
  const fileDiff = useMemo(() => {
    if (!shown) return undefined;
    try {
      const patch = shown.startsWith('diff --git')
        ? shown
        : shown.startsWith('--- ')
          ? `diff --git a/file b/file\n${shown}`
          : `diff --git a/file b/file\n--- a/file\n+++ b/file\n${shown}`;
      return getSingularPatch(patch);
    } catch {
      return undefined;
    }
  }, [shown]);

  const [pierreTheme, setPierreTheme] = useState<{ type: 'dark' | 'light'; css: string }>(() => ({
    type: resolvedMode ?? 'dark',
    css: buildPierreCSS(resolvedMode ?? 'dark', state.fontFamily, state.fontSize, lineBgIntensity),
  }));

  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      extendThemeSwitch();
      setPierreTheme({
        type: resolvedMode ?? 'dark',
        css: buildPierreCSS(resolvedMode ?? 'dark', state.fontFamily, state.fontSize, lineBgIntensity),
      });
    });
    return () => cancelAnimationFrame(rafId);
  }, [resolvedMode, colorTheme, state.fontFamily, state.fontSize, lineBgIntensity]);

  const syntaxTheme = resolveSyntaxTheme(colorTheme, resolvedMode ?? 'dark');

  if (!fileDiff) {
    return (
      <div className="px-3 py-2 text-[11px] text-muted-foreground/30 italic">
        Diff not available
      </div>
    );
  }

  return (
    <div className={`rounded overflow-hidden border border-border/20 ${className ?? ''}`}>
      <div
        className="overflow-hidden"
        style={expanded ? undefined : { maxHeight }}
      >
        <FileDiff
          fileDiff={fileDiff}
          options={{
            themeType: pierreTheme.type,
            unsafeCSS: pierreTheme.css,
            ...(syntaxTheme && { theme: syntaxTheme }),
            diffStyle: 'unified',
            disableLineNumbers: true,
            overflow: 'wrap',
            ...(shown !== hunk ? { hunkSeparators: 'simple' as const } : {}),
          }}
        />
      </div>
      {!expanded && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
          className="w-full text-[10px] text-muted-foreground hover:text-foreground py-1 bg-muted/20 border-t border-border/20 transition-colors"
        >
          Show full context
        </button>
      )}
    </div>
  );
};
