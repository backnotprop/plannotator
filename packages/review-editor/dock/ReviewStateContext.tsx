import React, { createContext, useContext } from 'react';
import type { CodeAnnotation, CodeAnnotationType, SelectedLineRange, TokenAnnotationMeta, ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import type { AgentJobInfo } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import type { AIChatEntry } from '../hooks/useAIChat';
import type { ReviewSearchMatch } from '../utils/reviewSearch';
import type { PRMetadata, PRContext } from '@plannotator/shared/pr-types';
import type { PRDiffScope } from '@plannotator/shared/pr-stack';
import type { FeedbackDiffContext } from '../utils/exportFeedback';

/**
 * Shared review state consumed by dockview panel wrappers.
 *
 * App.tsx owns all this state — the context just makes it accessible
 * to panels registered in dockview's static component map (which can't
 * receive arbitrary props from a parent).
 */
export interface ReviewState {
  // Files & diff
  files: DiffFile[];
  rawPatch: string;
  focusedFileIndex: number;
  focusedFilePath: string | null;
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  expandUnchanged?: boolean;
  fontFamily?: string;
  fontSize?: string;
  /** User-selected base branch; feeds the `base` query param on file-content fetches. */
  reviewBase?: string;
  /** Active diff mode (e.g. "branch", "merge-base", "uncommitted"). Used as
   *  part of the DiffViewer remount key so mode switches invalidate cached
   *  file content — branch and merge-base compute different "old" sides. */
  activeDiffBase?: string;
  /** Diff context baked into exported feedback so downstream panels (agent job
   * detail, etc.) produce the same markdown the main feedback path sends. */
  feedbackDiffContext?: FeedbackDiffContext;
  /** PR/MR review scope label, e.g. "Layer diff" or "Full stack diff". */
  prReviewScope?: string;
  prDiffScope?: PRDiffScope;

  // Annotations
  allAnnotations: CodeAnnotation[];
  externalAnnotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel, decorations?: ConventionalDecoration[], tokenMeta?: TokenAnnotationMeta) => void;
  onAddAnnotationForFile: (filePath: string, type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel, decorations?: ConventionalDecoration[], tokenMeta?: TokenAnnotationMeta) => void;
  onAddFileComment: (text: string) => void;
  onAddFileCommentForFile: (filePath: string, text: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel | null, decorations?: ConventionalDecoration[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;

  // Viewed / staged
  viewedFiles: Set<string>;
  onToggleViewed: (filePath: string) => void;
  stagedFiles: Set<string>;
  stagingFile: string | null;
  onStage: (filePath: string) => void;
  canStageFiles: boolean;
  stageError: string | null;

  // Search
  searchQuery: string;
  isSearchPending: boolean;
  debouncedSearchQuery: string;
  activeFileSearchMatches: ReviewSearchMatch[];
  activeSearchMatchId: string | null;
  activeSearchMatch: ReviewSearchMatch | null;
  // All-files (CodeView) search surface: the full match set + the unfiltered
  // active match (activeSearchMatch above is filtered to the single-file panel).
  searchMatches: ReviewSearchMatch[];
  allFilesActiveSearchMatch: ReviewSearchMatch | null;

  // AI
  aiAvailable: boolean;
  aiMessages: AIChatEntry[];
  onAskAI: (question: string) => void;
  /** File-aware Ask AI for the all-files surface. onAskAI above resolves the
   *  file from the single-file panel's focus index, which is wrong when the
   *  selection lives in the all-files CodeView. */
  onAskAIForFile: (filePath: string, question: string) => void;
  isAILoading: boolean;
  onViewAIResponse: (questionId?: string) => void;
  onClickAIMarker: (questionId: string) => void;
  aiHistoryForSelection: AIChatEntry[];
  /** File-aware variant of aiHistoryForSelection (same single-file caveat). */
  getAIHistoryForFile: (filePath: string) => AIChatEntry[];

  // Agent jobs
  agentJobs: AgentJobInfo[];

  // PR
  prMetadata: PRMetadata | null;
  prContext: PRContext | null;
  isPRContextLoading: boolean;
  prContextError: string | null;
  fetchPRContext: () => void;
  platformUser: string | null;

  // Diff navigation
  openDiffFile: (filePath: string) => void;
  onAllFilesVisibleFileChange: (filePath: string | null) => void;
  isAllFilesActive: boolean;
  isSemanticDiffActive: boolean;
  semanticDiffAvailable: boolean;
  onSemanticDiffUnavailable: () => void;
  onSemanticDiffLoadError: () => boolean;
  onSemanticDiffLoadSuccess: () => void;

  // Tour
  openTourPanel: (jobId: string) => void;

  // Code navigation
  onCodeNavRequest?: (request: import('@plannotator/shared/code-nav').CodeNavRequest) => void;
  codeNavResult: import('@plannotator/shared/code-nav').CodeNavResponse | null;
  codeNavIsLoading: boolean;
  codeNavActiveSymbol: string | null;
}

const ReviewStateContext = createContext<ReviewState | null>(null);

export function ReviewStateProvider({
  value,
  children,
}: {
  value: ReviewState;
  children: React.ReactNode;
}) {
  return (
    <ReviewStateContext.Provider value={value}>
      {children}
    </ReviewStateContext.Provider>
  );
}

export function useReviewState(): ReviewState {
  const ctx = useContext(ReviewStateContext);
  if (!ctx) throw new Error('useReviewState must be used within ReviewStateProvider');
  return ctx;
}

/** Like useReviewState but returns null instead of throwing — for components that may render outside the provider. */
export function useReviewStateOptional(): ReviewState | null {
  return useContext(ReviewStateContext);
}
