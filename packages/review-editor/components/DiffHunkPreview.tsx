import React, { useMemo, useState, useEffect } from 'react';
import { FileDiff } from '@pierre/diffs/react';
import { getSingularPatch } from '@pierre/diffs';
import type { DiffLineBgIntensity } from '@plannotator/shared/config';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { useConfigValue } from '@plannotator/ui/config';
import { useReviewState } from '../dock/ReviewStateContext';
import { resolveSyntaxTheme, buildLineBgOverrides } from '../hooks/usePierreTheme';

interface DiffHunkPreviewProps {
  /** Raw diff hunk string (unified diff format). */
  hunk: string;
  /** Max height in pixels before "Show more" toggle. Default 128. */
  maxHeight?: number;
  className?: string;
}

/**
 * Build the unsafeCSS string for @pierre/diffs by reading computed CSS variables.
 * Called synchronously so the first render is already themed (no flash on tooltip open).
 */
function buildPierreCSS(
  mode: 'light' | 'dark',
  fontFamily: string,
  fontSize: string,
  lineBgIntensity: DiffLineBgIntensity,
): string {
  try {
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--background').trim();
    const fg = styles.getPropertyValue('--foreground').trim();
    if (!bg || !fg) return '';

    const fontCSS = (fontFamily || fontSize) ? `
      pre, code, [data-line-content], [data-column-number] {
        ${fontFamily ? `font-family: '${fontFamily}', monospace !important;` : ''}
        ${fontSize ? `font-size: ${fontSize} !important; line-height: 1.5 !important;` : ''}
      }` : '';

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

/**
 * Renders a small inline diff hunk using @pierre/diffs.
 * Compact, read-only, no file header. Shares theme + font settings
 * with the main DiffViewer via the same unsafeCSS injection pattern.
 */
export const DiffHunkPreview: React.FC<DiffHunkPreviewProps> = ({
  hunk,
  maxHeight = 128,
  className,
}) => {
  const { resolvedMode, colorTheme } = useTheme();
  const state = useReviewState();
  const lineBgIntensity = useConfigValue('diffLineBgIntensity');
  const [expanded, setExpanded] = useState(false);

  const fileDiff = useMemo(() => {
    if (!hunk) return undefined;
    try {
      // Robustly handle all three hunk formats the tour agent might produce:
      //   1. Full git diff: starts with "diff --git" — use as-is
      //   2. File-level diff: starts with "--- " — prepend "diff --git" line only
      //   3. Bare hunk: starts with "@@ " — prepend full synthetic headers
      const patch = hunk.startsWith('diff --git')
        ? hunk
        : hunk.startsWith('--- ')
          ? `diff --git a/file b/file\n${hunk}`
          : `diff --git a/file b/file\n--- a/file\n+++ b/file\n${hunk}`;
      return getSingularPatch(patch);
    } catch {
      return undefined;
    }
  }, [hunk]);

  // Initialize synchronously so the very first render (inside a tooltip) is already themed.
  // The lazy initializer reads computed CSS variables from the document root.
  const [pierreTheme, setPierreTheme] = useState<{ type: 'dark' | 'light'; css: string }>(() => ({
    type: resolvedMode ?? 'dark',
    css: buildPierreCSS(resolvedMode ?? 'dark', state.fontFamily, state.fontSize, lineBgIntensity),
  }));

  // Re-compute on theme / font / intensity changes
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
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
