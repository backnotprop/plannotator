import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile } from '../../types';
import { useReviewState } from '../../dock/ReviewStateContext';
import { renderInlineMarkdown } from '../../utils/renderInlineMarkdown';
import { AllFilesCodeView } from '../AllFilesCodeView';
import { useGuideFileWindow } from './GuideViewportManager';

function estimateDiffHeight(patch: string): number {
  const lineCount = patch.split('\n').length;
  return Math.max(150, Math.min(lineCount * 21 + 52, 620));
}

interface GuideFileCardProps {
  file: DiffFile;
  summary?: string;
  focused: boolean;
  revealTarget: { filePath: string; token: number } | null;
  onActivate: (filePath: string) => void;
}

/**
 * One original-style Guided Review file block. The description and fixed-size
 * shell always remain in document flow; the expensive one-file CodeView only
 * exists while the shared outer viewport manager admits this file.
 */
export const GuideFileCard: React.FC<GuideFileCardProps> = ({
  file,
  summary,
  focused,
  revealTarget,
  onActivate,
}) => {
  const state = useReviewState();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionRef = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  const fileList = useMemo(() => [file], [file]);
  const { mounted, register, requestMount } = useGuideFileWindow(file.path, focused);
  const diffHeight = useMemo(() => estimateDiffHeight(file.patch), [file.patch]);
  const target = revealTarget?.filePath === file.path ? revealTarget : null;
  const renderedHeight = collapsed ? 49 : diffHeight;

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
      {summary && (
        <p className="mb-1.5 px-1 text-xs leading-relaxed text-muted-foreground">
          {renderInlineMarkdown(summary)}
        </p>
      )}

      <div
        style={{ height: renderedHeight }}
        className="overflow-hidden rounded-lg border border-border/40 bg-background"
        data-guide-code-view-mounted={mounted ? 'true' : 'false'}
      >
        {mounted ? (
          <AllFilesCodeView
            files={fileList}
            diffStyle={state.diffStyle}
            diffOverflow={state.diffOverflow}
            diffIndicators={state.diffIndicators}
            lineDiffType={state.lineDiffType}
            disableLineNumbers={state.disableLineNumbers}
            disableBackground={state.disableBackground}
            expandUnchanged={state.expandUnchanged}
            fontFamily={state.fontFamily}
            fontSize={state.fontSize}
            annotations={state.allAnnotations}
            selectedAnnotationId={state.selectedAnnotationId}
            scrollTargetAnnotation={state.scrollTargetAnnotation}
            pendingSelection={focused ? state.pendingSelection : null}
            reviewBase={state.reviewBase}
            reviewSnapshotId={state.feedbackDiffContext?.snapshotId}
            onLineSelection={state.onLineSelection}
            onAddAnnotationForFile={state.onAddAnnotationForFile}
            onEditAnnotation={state.onEditAnnotation}
            onSelectAnnotation={state.onSelectAnnotation}
            onDeleteAnnotation={state.onDeleteAnnotation}
            onAddFileCommentForFile={state.onAddFileCommentForFile}
            viewedFiles={state.viewedFiles}
            onToggleViewed={state.onToggleViewed}
            stagedFiles={state.stagedFiles}
            onStage={state.onStage}
            canStageFiles={state.canStageFiles}
            canStagePath={state.canStagePath}
            stagingFile={state.stagingFile}
            stageError={state.stageError}
            prUrl={state.prMetadata?.url}
            prDiffScope={state.prDiffScope}
            searchQuery={state.isSearchPending ? '' : state.debouncedSearchQuery}
            searchMatches={state.searchMatches}
            activeSearchMatchId={state.activeSearchMatchId}
            activeSearchMatch={state.allFilesActiveSearchMatch}
            onCodeNavRequest={state.onCodeNavRequest}
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
            aiAvailable={state.aiAvailable}
            onAskAIForFile={state.onAskAIForFile}
            isAILoading={state.isAILoading}
            onViewAIResponse={state.onViewAIResponse}
            aiMessages={state.aiMessages}
            onClickAIMarker={state.onClickAIMarker}
            getAIHistoryForFile={state.getAIHistoryForFile}
            allowScrollChaining
          />
        ) : (
          <div className="flex h-full flex-col" aria-hidden="true">
            <div className="flex h-[33px] flex-shrink-0 items-center border-b border-border/40 px-3 font-mono text-[11px] text-muted-foreground/70">
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
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

export { estimateDiffHeight };
