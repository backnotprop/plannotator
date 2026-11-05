import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileKind } from '@plannotator/core/file-kind';
import type { DiffFile } from './types';
import { FileKindIcon } from './FileKindIcon';
import { useGuideHost } from './host';
import { renderInlineMarkdown } from './renderInlineMarkdown';
import { useGuideFileWindow } from './GuideViewportManager';

/** The tallest a file's box grows: a longer diff scrolls inside it. */
const MAX_DIFF_HEIGHT = 620;
/** A folded file's box: its header alone. */
const COLLAPSED_HEIGHT = 49;

function estimateDiffHeight(patch: string): number {
  const lineCount = patch.split('\n').length;
  return Math.max(150, Math.min(lineCount * 21 + 52, MAX_DIFF_HEIGHT));
}

/**
 * The box a file's diff fills when the guide fits boxes to their content (GuideView `fitFileHeights`), before the
 * renderer measures it: the rows the diff draws (its hunks' lines, not git's header lines; in Split a run of removed
 * lines and the added lines after it share rows), a separator before each hunk that does not start the file, the
 * file's header and the list's padding (AllFilesCodeView's metrics: 20 px rows, one more for a "\ No newline", a
 * 33 px header, a 40 px separator above the first hunk and 48 px between hunks, 8 px above and below the list, 8 px
 * in the code block, a 1 px border). A patch with no hunk (a binary file, a rename) keeps the old estimate.
 */
function estimateFitDiffHeight(patch: string, diffStyle: 'split' | 'unified' = 'unified'): number {
  let rows = 0;
  let hunks = 0;
  let separatorHeight = 0;
  let inHunk = false;
  // The change block being read: its removed and added lines (Split draws max of the two rows).
  let removed = 0;
  let added = 0;
  const closeBlock = () => {
    rows += diffStyle === 'split' ? Math.max(removed, added) : removed + added;
    removed = 0;
    added = 0;
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      closeBlock();
      const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (hunks > 0) separatorHeight += 48;
      else if (at && (Number(at[1]) > 1 || Number(at[2]) > 1)) separatorHeight += 40;
      hunks += 1;
      inHunk = true;
    } else if (line.startsWith('diff --git')) {
      closeBlock();
      inHunk = false;
    } else if (inHunk && line[0] === '-') {
      // A removal after additions starts a new block.
      if (added > 0) closeBlock();
      removed += 1;
    } else if (inHunk && line[0] === '+') {
      added += 1;
    } else if (inHunk && line[0] === ' ') {
      closeBlock();
      rows += 1;
    } else if (inHunk && line[0] === '\\') {
      // "\ No newline at end of file": the viewer draws it as a row of the side it follows.
      if (added > 0) added += 1;
      else if (removed > 0) removed += 1;
      else rows += 1;
    }
  }
  closeBlock();
  if (hunks === 0) return estimateDiffHeight(patch);
  return Math.min(2 + 16 + 33 + 8 + rows * 20 + separatorHeight, MAX_DIFF_HEIGHT);
}

interface GuideFileCardProps {
  file: DiffFile;
  summary?: string;
  /** The file's kind: a generated file starts folded, a test shows the flask while unmounted. */
  kind?: FileKind;
  focused: boolean;
  revealTarget: { filePath: string; token: number } | null;
  onActivate: (filePath: string) => void;
  /**
   * Size the box to the diff's content (GuideView `fitFileHeights`: the Inbox): an estimate from the hunks' rows,
   * then the height the renderer reports, both capped at the usual maximum. Off: the fixed estimate, as before.
   */
  fitContent?: boolean;
}

/**
 * One original-style Guided Review file block. The description and fixed-size
 * shell always remain in document flow; the expensive one-file CodeView only
 * exists while the shared outer viewport manager admits this file.
 */
export const GuideFileCard: React.FC<GuideFileCardProps> = ({
  file,
  summary,
  kind,
  focused,
  revealTarget,
  onActivate,
  fitContent = false,
}) => {
  const { DiffRenderer, getDiffRendererProps, renderFileActions, diffStyle } = useGuideHost();
  const actions = renderFileActions?.(file) ?? null;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionRef = useRef(0);
  const [collapsed, setCollapsed] = useState(kind === 'generated');
  const fileList = useMemo(() => [file], [file]);
  const { mounted, register, requestMount } = useGuideFileWindow(file.path, focused);
  const diffHeight = useMemo(
    () => (fitContent ? estimateFitDiffHeight(file.patch, diffStyle) : estimateDiffHeight(file.patch)),
    [fitContent, file.patch, diffStyle],
  );
  // The content's height as the renderer last reported it (plus the box's border), kept while the CodeView is
  // unmounted so the box does not jump when it leaves the outer window.
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const measuredRef = useRef<number | null>(null);
  // Back in the outer window, the CodeView's first report is its layout before its inline comments are drawn: a
  // box that held comments would shrink for a frame and grow back. A first report that shrinks the box waits two
  // frames for the viewer to draw; a growth in that time lands at once and ends the wait, else the latest report lands.
  const settledRef = useRef(true);
  const pendingRef = useRef<number | null>(null);
  const settleFrameRef = useRef<number | null>(null);
  const applyMeasured = useCallback((height: number) => {
    measuredRef.current = height;
    setMeasuredHeight(height);
  }, []);
  const stopWaiting = useCallback(() => {
    if (settleFrameRef.current !== null) cancelAnimationFrame(settleFrameRef.current);
    settleFrameRef.current = null;
    pendingRef.current = null;
    settledRef.current = true;
  }, []);
  useEffect(() => {
    if (!mounted || !fitContent || measuredRef.current === null) return;
    settledRef.current = false;
    return stopWaiting;
  }, [mounted, fitContent, stopWaiting]);
  const onContentHeightChange = useCallback((height: number) => {
    const next = height + 2;
    if (!settledRef.current) {
      if (measuredRef.current !== null && next < measuredRef.current) {
        pendingRef.current = next;
        if (settleFrameRef.current === null) {
          settleFrameRef.current = requestAnimationFrame(() => {
            settleFrameRef.current = requestAnimationFrame(() => {
              const pending = pendingRef.current;
              stopWaiting();
              if (pending !== null) applyMeasured(pending);
            });
          });
        }
        return;
      }
      stopWaiting();
    }
    applyMeasured(next);
  }, [applyMeasured, stopWaiting]);
  const target = revealTarget?.filePath === file.path ? revealTarget : null;
  const renderedHeight = collapsed
    ? COLLAPSED_HEIGHT
    : fitContent && measuredHeight !== null
      ? Math.max(COLLAPSED_HEIGHT, Math.min(measuredHeight, MAX_DIFF_HEIGHT))
      : diffHeight;

  // A navigation target can live far outside the current outer window or in a
  // chapter that was just reopened. Force its CodeView first, then move the
  // lightweight shell into view; the tokenized inner target completes the jump.
  useEffect(() => {
    if (!target) return;
    setCollapsed(false);
    requestMount();
    onActivate(file.path);
    const raf = requestAnimationFrame(() => {
      shellRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(raf);
    // Token identifies the navigation event; callback identity must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.token]);

  // Keyboard/sidebar focus may reach a file through a path that does not emit a
  // fresh guide reveal token. Ensure the focused shell is eligible to mount.
  useEffect(() => {
    if (focused) requestMount();
  }, [focused, requestMount]);

  const attachShell = useCallback((element: HTMLDivElement | null) => {
    shellRef.current = element;
    register(element);
  }, [register]);

  return (
    <div
      ref={attachShell}
      data-guide-file-shell={file.path}
      className="scroll-mt-4"
      onPointerEnter={() => {
        requestMount();
        onActivate(file.path);
      }}
      onFocusCapture={() => {
        requestMount();
        onActivate(file.path);
      }}
    >
      {actions ? (
        <div className="mb-1.5 flex items-start gap-2 px-1">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{summary ? renderInlineMarkdown(summary) : null}</p>
          <div className="flex flex-shrink-0 items-center gap-1">{actions}</div>
        </div>
      ) : (
        summary && (
          <p className="mb-1.5 px-1 text-xs leading-relaxed text-muted-foreground">
            {renderInlineMarkdown(summary)}
          </p>
        )
      )}

      <div
        style={{ height: renderedHeight }}
        className="overflow-hidden rounded-lg border border-border/40 bg-background"
        data-guide-code-view-mounted={mounted ? 'true' : 'false'}
      >
        {mounted ? (
          <DiffRenderer
            {...getDiffRendererProps({ file, focused })}
            files={fileList}
            fileScrollTarget={target}
            fileOrder="list"
            mountCollapsed={collapsed}
            initialScrollPosition={scrollPositionRef.current}
            onScrollPositionChange={(position) => {
              scrollPositionRef.current = position;
            }}
            onFileCollapsedChange={(filePath, nextCollapsed) => {
              if (filePath === file.path) setCollapsed(nextCollapsed);
            }}
            isActive={focused}
            allowScrollChaining
            {...(fitContent ? { onContentHeightChange } : {})}
          />
        ) : (
          <div className="flex h-full flex-col" aria-hidden="true">
            <div className="flex h-[33px] flex-shrink-0 items-center border-b border-border/40 px-3 font-mono text-[11px] text-muted-foreground/70">
              <span className="min-w-0 truncate">{file.path}</span>
              {kind === 'test' && <FileKindIcon kind="test" className="ml-1.5 flex-shrink-0" />}
              <span className="flex-1" />
              <span className="ml-2 flex-shrink-0">
                {file.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>}
                {file.deletions > 0 && <span className="ml-1 text-red-600/80 dark:text-red-400/80">-{file.deletions}</span>}
              </span>
            </div>
            {!collapsed && <div className="min-h-0 flex-1 bg-muted/[0.06]" />}
          </div>
        )}
      </div>
    </div>
  );
};

export { estimateDiffHeight, estimateFitDiffHeight };
