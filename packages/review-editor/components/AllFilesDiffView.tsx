import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { type DiffLineAnnotation } from '@pierre/diffs/react';
import { getSingularPatch } from '@pierre/diffs';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, DiffAnnotationMetadata, TokenAnnotationMeta, ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import { usePierreTheme } from '../hooks/usePierreTheme';
import { LazyFileDiff } from './LazyFileDiff';
import { ToolbarHost, type ToolbarHostHandle } from './ToolbarHost';
import { InlineAnnotation } from './InlineAnnotation';
import { FileHeader } from './FileHeader';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { detectLanguage } from '../utils/detectLanguage';
import type { DiffFile } from '../types';
import { buildFileTree, getVisualFileOrder } from '../utils/buildFileTree';
import { getLineNumberFromNode, getSideFromNode, getDiffSelection } from '../utils/diffSelection';

interface AllFilesDiffViewProps {
  files: DiffFile[];
  annotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (filePath: string, type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel, decorations?: ConventionalDecoration[], tokenMeta?: TokenAnnotationMeta) => void;
  onAddFileComment?: (filePath: string, text: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel | null, decorations?: ConventionalDecoration[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  fontFamily?: string;
  fontSize?: string;
  viewedFiles: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  stagedFiles?: Set<string>;
  onStage?: (filePath: string) => void;
  canStageFiles?: boolean;
  stagingFile?: string | null;
  stageError?: string | null;
  reviewBase?: string;
  prUrl?: string;
  prDiffScope?: string;
  onVisibleFileChange?: (filePath: string | null) => void;
  isActive?: boolean;
}

export const AllFilesDiffView: React.FC<AllFilesDiffViewProps> = ({
  files,
  annotations,
  selectedAnnotationId,
  pendingSelection,
  onLineSelection,
  onAddAnnotation,
  onAddFileComment,
  onEditAnnotation,
  onSelectAnnotation,
  onDeleteAnnotation,
  diffStyle,
  diffOverflow,
  diffIndicators,
  lineDiffType,
  disableLineNumbers,
  disableBackground,
  fontFamily,
  fontSize,
  viewedFiles,
  onToggleViewed,
  stagedFiles,
  onStage,
  canStageFiles,
  stagingFile,
  stageError,
  reviewBase,
  prUrl,
  prDiffScope,
  onVisibleFileChange,
  isActive = true,
}) => {
  const pierreTheme = usePierreTheme({ fontFamily, fontSize });
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const pendingToolbarRange = useRef<SelectedLineRange | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const collapseHistory = useRef<string[]>([]);
  const [fileCommentAnchor, setFileCommentAnchor] = useState<{ el: HTMLElement; filePath: string } | null>(null);

  useEffect(() => {
    setActiveFilePath(null);
    setCollapsedFiles(new Set());
    collapseHistory.current = [];
  }, [files]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const activePatch = useMemo(
    () => files.find(f => f.path === activeFilePath)?.patch ?? '',
    [files, activeFilePath],
  );

  const handleAddAnnotation = useCallback((
    type: CodeAnnotationType,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
    conventionalLabel?: ConventionalLabel,
    decorations?: ConventionalDecoration[],
    tokenMeta?: TokenAnnotationMeta,
  ) => {
    if (!activeFilePath) return;
    onAddAnnotation(activeFilePath, type, text, suggestedCode, originalCode, conventionalLabel, decorations, tokenMeta);
  }, [activeFilePath, onAddAnnotation]);

  const toolbarHostRef = useRef<ToolbarHostHandle>(null);

  useEffect(() => {
    if (pendingToolbarRange.current && activePatch) {
      toolbarHostRef.current?.handleLineSelectionEnd(pendingToolbarRange.current);
      pendingToolbarRange.current = null;
    }
  }, [activePatch]);

  const handleEdit = useCallback((id: string) => {
    const ann = annotations.find(a => a.id === id);
    if (!ann) return;
    toolbarHostRef.current?.startEdit(ann);
  }, [annotations]);

  const visualOrder = useMemo(() => {
    const tree = buildFileTree(files);
    return getVisualFileOrder(tree);
  }, [files]);

  const sortedFiles = useMemo(() => visualOrder.map(i => files[i]), [files, visualOrder]);

  const baseDiffs = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getSingularPatch>>();
    for (const file of files) map.set(file.path, getSingularPatch(file.patch));
    return map;
  }, [files]);

  const toggleCollapse = useCallback((filePath: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
        collapseHistory.current.push(filePath);
        if (activeFilePath === filePath) setActiveFilePath(null);
      }
      return next;
    });
  }, [activeFilePath]);

  const setHeaderRef = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) headerRefs.current.set(path, el);
    else headerRefs.current.delete(path);
  }, []);

  // Scroll tracking for file tree highlight
  const visibleFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onVisibleFileChange) return;
    const container = scrollRef.current;
    if (!container) return;
    const onScroll = () => {
      const containerTop = container.getBoundingClientRect().top;
      const expandedFiles = sortedFiles.filter(f => !collapsedFiles.has(f.path));
      let bestPath: string | null = expandedFiles[0]?.path ?? null;
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 20;
      if (atBottom && expandedFiles.length > 0) {
        bestPath = expandedFiles[expandedFiles.length - 1].path;
      } else {
        for (const file of expandedFiles) {
          const header = headerRefs.current.get(file.path);
          if (!header) continue;
          const rect = header.getBoundingClientRect();
          if (rect.top <= containerTop + 50) bestPath = file.path;
          else break;
        }
      }
      if (bestPath !== visibleFileRef.current) {
        visibleFileRef.current = bestPath;
        onVisibleFileChange(bestPath);
      }
    };
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [onVisibleFileChange, sortedFiles, collapsedFiles]);

  // Keyboard shortcuts for all-files mode: [/] scroll, v viewed+collapse, a stage, c collapse
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;

      const currentPath = activeFilePath || visibleFileRef.current;

      if (e.key === 'z') {
        // Find the most recent entry that's actually still collapsed
        let last: string | undefined;
        while (collapseHistory.current.length > 0) {
          const candidate = collapseHistory.current.pop()!;
          if (collapsedFiles.has(candidate)) { last = candidate; break; }
        }
        if (!last) return;
        e.preventDefault();
        setCollapsedFiles(prev => {
          const next = new Set(prev);
          next.delete(last!);
          return next;
        });
        setActiveFilePath(last);
        setTimeout(() => {
          const header = headerRefs.current.get(last!);
          header?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
        return;
      }

      if (e.key === 'x' && currentPath) {
        e.preventDefault();
        toggleCollapse(currentPath);
        return;
      }

      if (e.key === 'c' && currentPath && onAddFileComment) {
        e.preventDefault();
        const header = headerRefs.current.get(currentPath);
        if (header) {
          const btn = header.querySelector<HTMLElement>('[title="Add file-scoped comment"]');
          if (btn) {
            setFileCommentAnchor({ el: btn, filePath: currentPath });
          }
        }
        return;
      }

      if (e.key === 'v' && currentPath) {
        e.preventDefault();
        const isCurrentlyViewed = viewedFiles.has(currentPath);
        onToggleViewed?.(currentPath);
        if (!isCurrentlyViewed) {
          collapseHistory.current.push(currentPath);
          setCollapsedFiles(prev => {
            const next = new Set(prev);
            next.add(currentPath);
            return next;
          });
          setActiveFilePath(null);
        }
        return;
      }

      if (e.key === 'a' && currentPath && canStageFiles) {
        e.preventDefault();
        onStage?.(currentPath);
        return;
      }

      if (e.key !== '[' && e.key !== ']') return;

      e.preventDefault();
      const expandedFiles = sortedFiles.filter(f => !collapsedFiles.has(f.path));
      if (expandedFiles.length === 0) return;

      const currentIdx = currentPath ? expandedFiles.findIndex(f => f.path === currentPath) : -1;

      let targetIdx: number;
      if (e.key === ']') {
        targetIdx = currentIdx < expandedFiles.length - 1 ? currentIdx + 1 : expandedFiles.length - 1;
      } else {
        targetIdx = currentIdx > 0 ? currentIdx - 1 : 0;
      }

      const targetFile = expandedFiles[targetIdx];
      const header = headerRefs.current.get(targetFile.path);
      if (header) {
        header.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveFilePath(targetFile.path);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive, sortedFiles, collapsedFiles, activeFilePath, toggleCollapse, viewedFiles, onToggleViewed, canStageFiles, onStage, onAddFileComment]);

  // Click-and-drag line selection in diff content
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const handler = () => {
      requestAnimationFrame(() => {
        const selection = getDiffSelection(root);
        if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
        const anchorLine = getLineNumberFromNode(selection.anchorNode);
        const focusLine = getLineNumberFromNode(selection.focusNode);
        if (anchorLine == null || focusLine == null) return;
        if (anchorLine === focusLine) return;
        const side = getSideFromNode(selection.anchorNode);
        // Determine which file the selection is in by checking header positions
        const anchorRect = selection.getRangeAt(0).getBoundingClientRect();
        let closestFile: string | null = null;
        for (const file of sortedFiles) {
          const header = headerRefs.current.get(file.path);
          if (header && header.getBoundingClientRect().top <= anchorRect.top) {
            closestFile = file.path;
          }
        }
        if (closestFile) {
          if (activeFilePath !== closestFile) {
            pendingToolbarRange.current = {
              start: Math.min(anchorLine, focusLine),
              end: Math.max(anchorLine, focusLine),
              side,
            };
            setActiveFilePath(closestFile);
            selection.removeAllRanges();
            return;
          }
          setActiveFilePath(closestFile);
        }
        toolbarHostRef.current?.handleLineSelectionEnd({
          start: Math.min(anchorLine, focusLine),
          end: Math.max(anchorLine, focusLine),
          side,
        });
        selection.removeAllRanges();
      });
    };
    root.addEventListener('mouseup', handler, true);
    return () => root.removeEventListener('mouseup', handler, true);
  }, [sortedFiles, activeFilePath]);

  // Scroll to selected annotation — auto-expand collapsed file
  useEffect(() => {
    if (!selectedAnnotationId) return;
    const ann = annotations.find(a => a.id === selectedAnnotationId);
    if (!ann) return;
    setCollapsedFiles(prev => {
      if (!prev.has(ann.filePath)) return prev;
      const next = new Set(prev);
      next.delete(ann.filePath);
      return next;
    });
    requestAnimationFrame(() => {
      const header = headerRefs.current.get(ann.filePath);
      header?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [selectedAnnotationId, annotations]);

  return (
    <div className="h-full overflow-auto" ref={scrollRef}>
      {sortedFiles.map(file => {
        const isCollapsed = collapsedFiles.has(file.path);
        const fileAnnotations = annotations
          .filter(a =>
            a.filePath === file.path &&
            (a.scope ?? 'line') === 'line' &&
            (!a.prUrl || !prUrl || a.prUrl === prUrl) &&
            (!a.diffScope || !prDiffScope || a.diffScope === prDiffScope)
          )
          .map(ann => ({
            side: ann.side === 'new' ? 'additions' as const : 'deletions' as const,
            lineNumber: ann.lineEnd,
            metadata: {
              annotationId: ann.id,
              type: ann.type,
              text: ann.text,
              suggestedCode: ann.suggestedCode,
              originalCode: ann.originalCode,
              author: ann.author,
              severity: ann.severity,
              reasoning: ann.reasoning,
              conventionalLabel: ann.conventionalLabel,
              decorations: ann.decorations,
            } as DiffAnnotationMetadata,
          }));

        return (
          <div key={file.path}>
            <div
              className="sticky top-0 z-10 bg-card border-t border-border/30 first:border-t-0"
              ref={(el) => setHeaderRef(file.path, el)}
            >
              <FileHeader
                filePath={file.path}
                patch={file.patch}
                isViewed={viewedFiles.has(file.path)}
                onToggleViewed={onToggleViewed ? () => onToggleViewed(file.path) : undefined}
                isStaged={stagedFiles?.has(file.path)}
                isStaging={stagingFile === file.path}
                onStage={onStage ? () => onStage(file.path) : undefined}
                canStage={canStageFiles}
                stageError={stagingFile === file.path ? stageError : null}
                collapseToggle={
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleCollapse(file.path); }}
                    className="flex items-center justify-center w-6 h-6 rounded hover:bg-foreground/10 transition-colors flex-shrink-0"
                  >
                    <svg
                      className={`w-3 h-3 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                }
                onCollapseToggle={() => toggleCollapse(file.path)}
                onFileComment={onAddFileComment ? (anchorEl) => setFileCommentAnchor({ el: anchorEl, filePath: file.path }) : undefined}
              />
            </div>
            {!isCollapsed && (
              <LazyFileDiff
                file={file}
                baseDiff={baseDiffs.get(file.path)!}
                scrollRoot={scrollRef.current}
                reviewBase={reviewBase}
                diffStyle={diffStyle}
                forceMount={selectedAnnotationId != null && fileAnnotations.some(a => a.metadata.annotationId === selectedAnnotationId)}
                options={{
                  themeType: pierreTheme.type,
                  unsafeCSS: pierreTheme.css,
                  ...(pierreTheme.syntaxTheme && { theme: pierreTheme.syntaxTheme }),
                  diffStyle,
                  overflow: diffOverflow,
                  diffIndicators,
                  lineDiffType,
                  disableLineNumbers,
                  disableBackground,
                  hunkSeparators: 'line-info',
                  enableLineSelection: true,
                  enableHoverUtility: true,
                  onLineSelectionEnd: (range: SelectedLineRange | null) => {
                    if (range) {
                      if (activeFilePath === file.path) {
                        toolbarHostRef.current?.handleLineSelectionEnd(range);
                      } else {
                        pendingToolbarRange.current = range;
                        setActiveFilePath(file.path);
                      }
                    }
                    onLineSelection(range);
                  },
                }}
                annotations={fileAnnotations}
                selectedLines={activeFilePath === file.path ? (pendingSelection || undefined) : undefined}
                renderAnnotation={(annotation: DiffLineAnnotation<DiffAnnotationMetadata>) => {
                  if (!annotation.metadata) return null;
                  return (
                    <InlineAnnotation
                      metadata={annotation.metadata}
                      language={detectLanguage(file.path)}
                      onSelect={onSelectAnnotation}
                      onEdit={handleEdit}
                      onDelete={onDeleteAnnotation}
                    />
                  );
                }}
                renderHoverUtility={(getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => (
                  <button
                    className="hover-add-comment"
                    onClick={(e) => {
                      e.stopPropagation();
                      const line = getHoveredLine();
                      if (!line) return;
                      const range = { start: line.lineNumber, end: line.lineNumber, side: line.side };
                      if (activeFilePath === file.path) {
                        toolbarHostRef.current?.handleLineSelectionEnd(range);
                      } else {
                        pendingToolbarRange.current = range;
                        setActiveFilePath(file.path);
                      }
                    }}
                  >
                    +
                  </button>
                )}
              />
            )}
          </div>
        );
      })}

      <ToolbarHost
        ref={toolbarHostRef}
        patch={activePatch}
        filePath={activeFilePath ?? ''}
        isFocused={true}
        onLineSelection={onLineSelection}
        onAddAnnotation={handleAddAnnotation}
        onEditAnnotation={onEditAnnotation}
      />

      {fileCommentAnchor && onAddFileComment && (
        <CommentPopover
          anchorEl={fileCommentAnchor.el}
          contextText={fileCommentAnchor.filePath.split('/').pop() || fileCommentAnchor.filePath}
          isGlobal={false}
          onSubmit={(text) => {
            onAddFileComment(fileCommentAnchor.filePath, text);
            setFileCommentAnchor(null);
          }}
          onClose={() => setFileCommentAnchor(null)}
        />
      )}
    </div>
  );
};
