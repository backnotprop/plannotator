import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FileKind } from '@plannotator/core/file-kind';
import type { DiffFile } from './types';
import { FileKindIcon } from './FileKindIcon';
import { useGuideHost } from './host';
import { renderInlineMarkdown } from './renderInlineMarkdown';
import { useGuideFileWindow } from './GuideViewportManager';

/** The tallest a file's box grows: a longer diff scrolls inside it. */
const MAX_DIFF_HEIGHT = 620;
/** A fitted box's border and padding around the viewer's own height. */
const FIT_BOX_CHROME = 2 + 16;
/** The arrow row after a file's last hunk. */
const TRAILING_ROW_HEIGHT = 32;
/** A folded file's box: its header alone. */
const COLLAPSED_HEIGHT = 49;

/** The element the page scrolls in. */
function pageOf(element: HTMLElement): HTMLElement {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return parent;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

const pageTopOf = (page: HTMLElement) => (page === document.scrollingElement ? 0 : page.getBoundingClientRect().top);

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
 * in the code block, a 1 px border). With a reader of whole files the viewer also draws an arrow row after the last
 * hunk (`trailingRow`), whose 24 px its margins leave out. A patch with no hunk (a binary file, a rename) keeps the old
 * estimate.
 */
function estimateFitDiffHeight(patch: string, diffStyle: 'split' | 'unified' = 'unified', trailingRow = false): number {
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
      if (hunks > 0) separatorHeight += 32;
      else if (at && (Number(at[1]) > 1 || Number(at[2]) > 1)) separatorHeight += 32;
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
  return FIT_BOX_CHROME + 33 + rows * 20 + separatorHeight + (trailingRow ? TRAILING_ROW_HEIGHT : 0);
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
   * Size the box to the diff's content (GuideView `fitFileHeights`: the Inbox), with no limit and no scroller of its
   * own: the page scrolls. An estimate from the hunks' rows holds the space, then the height the renderer reports.
   * Off: the fixed estimate, as before.
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
  const { DiffRenderer, getDiffRendererProps, renderFileActions, diffStyle, opensWholeFiles, collapseAll } = useGuideHost();
  const actions = renderFileActions?.(file) ?? null;
  const scrollPositionRef = useRef(0);
  const [collapsed, setCollapsed] = useState(collapseAll && collapseAll.token > 0 ? collapseAll.collapsed : kind === 'generated');
  // The host's Collapse all: a new token folds or opens this card too. The renderer reads `mountCollapsed` once, so it
  // mounts again (`key` below), but only when this card's state changes: a file already that way keeps its opened
  // context gaps and an open comment.
  const [collapseToken, setCollapseToken] = useState(collapseAll?.token ?? 0);
  const [mountKey, setMountKey] = useState(0);
  if (collapseAll && collapseAll.token !== collapseToken) {
    setCollapseToken(collapseAll.token);
    if (collapseAll.collapsed !== collapsed) {
      setCollapsed(collapseAll.collapsed);
      setMountKey((key) => key + 1);
    }
  }
  const fileList = useMemo(() => [file], [file]);
  // A file whose gap was opened stays mounted: the viewer holds the opened lines, and leaving the outer window would
  // close them, shrink the box under the reader and read the file again. A mounted viewer draws only rows near the viewport.
  const [opened, setOpened] = useState(false);
  const { mounted, register, requestMount, jumpTo } = useGuideFileWindow(file.path, focused || opened);
  const diffHeight = useMemo(
    () => (fitContent ? estimateFitDiffHeight(file.patch, diffStyle, !!opensWholeFiles && (file.status === 'modified' || file.status === 'renamed')) : estimateDiffHeight(file.patch)),
    [fitContent, file.patch, file.status, diffStyle, opensWholeFiles],
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
    const next = height + FIT_BOX_CHROME;
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
    ? COLLAPSED_HEIGHT + (fitContent ? FIT_BOX_CHROME - 16 : 0)
    : fitContent && measuredHeight !== null
      ? Math.max(COLLAPSED_HEIGHT, measuredHeight)
      : diffHeight;
  // Fitting, a mounted box follows its content by itself; the last height holds it until the viewer has drawn. No
  // `overflow: hidden` there: it would make the box the sticky header's scroller.
  const followsContent = fitContent && mounted && !collapsed;

  // A navigation target can live far outside the current outer window or in a
  // chapter that was just reopened. Force its CodeView first, then take the
  // lightweight shell there; the tokenized inner target completes the jump.
  useEffect(() => {
    if (!target) return;
    setCollapsed(false);
    requestMount();
    onActivate(file.path);
    // Fitting, at once: a page-long ride would mount boxes on the way, and holding the reader's place stops a smooth
    // scroll. Either way the manager then holds the file at its place while the boxes above it settle.
    const raf = requestAnimationFrame(() => jumpTo(fitContent ? { instant: true } : undefined));
    return () => cancelAnimationFrame(raf);
    // Token identifies the navigation event; callback identity must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.token]);

  // Keyboard/sidebar focus may reach a file through a path that does not emit a
  // fresh guide reveal token. Ensure the focused shell is eligible to mount.
  useEffect(() => {
    if (focused) requestMount();
  }, [focused, requestMount]);

  // The page holds the reader's place: a box wholly above the viewport that changes height moves the page by as much.
  // Browsers do not do this for us here (and Safari never does): `.ib-gbody` opts out so that nothing corrects twice.
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!fitContent || !box || typeof ResizeObserver === 'undefined') return;
    let height = box.offsetHeight;
    const observer = new ResizeObserver(() => {
      const before = height;
      height = box.offsetHeight;
      if (height === before) return;
      const page = pageOf(box);
      if (box.getBoundingClientRect().top + before <= pageTopOf(page)) page.scrollTop += height - before;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [fitContent]);

  // Folded from its sticky header, the box is gone from under the reader: bring the file to the top of the page, not
  // whatever now sits where they were reading. Before paint, and before the box's new height reaches the observer above.
  // Not for Collapse all: every box folds then, and the host's bar keeps the place.
  const wasCollapsed = useRef(collapsed);
  const foldedToken = useRef(collapseToken);
  useLayoutEffect(() => {
    const folded = collapsed && !wasCollapsed.current && foldedToken.current === collapseToken;
    wasCollapsed.current = collapsed;
    foldedToken.current = collapseToken;
    const box = boxRef.current;
    if (!folded || !fitContent || !box) return;
    const page = pageOf(box);
    const above = pageTopOf(page) - box.getBoundingClientRect().top;
    if (above > 0) page.scrollTop -= above;
  }, [collapsed, fitContent, collapseToken]);

  return (
    <div
      ref={register}
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
        ref={boxRef}
        style={followsContent ? { minHeight: renderedHeight } : { height: renderedHeight }}
        className={`${fitContent ? 'overflow-clip py-2' : 'overflow-hidden'} rounded-lg border border-border/40 bg-background`}
        data-guide-code-view-mounted={mounted ? 'true' : 'false'}
        onClickCapture={
          fitContent && !opened
            ? (event) => {
                if (event.nativeEvent.composedPath().some((node) => node instanceof Element && node.hasAttribute('data-expand-button'))) setOpened(true);
              }
            : undefined
        }
      >
        {mounted ? (
          <DiffRenderer
            key={mountKey}
            {...getDiffRendererProps({ file, focused })}
            files={fileList}
            fileScrollTarget={target}
            fileOrder="list"
            mountCollapsed={collapsed}
            // The page owns the position of a box that scrolls with it.
            initialScrollPosition={fitContent ? 0 : scrollPositionRef.current}
            onScrollPositionChange={(position) => {
              scrollPositionRef.current = position;
            }}
            {...(fitContent ? { onContentHeightChange, scrollsWithPage: true } : {})}
            onFileCollapsedChange={(filePath, nextCollapsed) => {
              if (filePath === file.path) setCollapsed(nextCollapsed);
            }}
            isActive={focused}
            allowScrollChaining
          />
        ) : (
          <div className="flex h-full flex-col" aria-hidden="true">
            <div data-file-header="" className="flex h-[33px] flex-shrink-0 items-center border-b border-border/40 px-3 font-mono text-[11px] text-muted-foreground/70">
              <span className="min-w-0 truncate">{file.path}</span>
              {kind === 'test' && <FileKindIcon kind="test" className="ml-1.5 flex-shrink-0" />}
              <span className="flex-1" />
              <span className="ml-2 flex-shrink-0">
                {file.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>}
                {file.deletions > 0 && <span className="ml-1 text-red-600/80 dark:text-red-400/80">-{file.deletions}</span>}
              </span>
            </div>
            {!collapsed && <div data-guide-code-placeholder="" className="min-h-0 flex-1 bg-muted/[0.06]" />}
          </div>
        )}
      </div>
    </div>
  );
};

export { estimateDiffHeight, estimateFitDiffHeight };
