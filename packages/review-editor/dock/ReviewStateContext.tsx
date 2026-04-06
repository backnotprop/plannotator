import React, { createContext, useContext } from 'react';
import type { CodeAnnotation, CodeAnnotationType, SelectedLineRange, TokenAnnotationMeta } from '@plannotator/ui/types';
import type { AgentJobInfo } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import type { AIChatEntry } from '../hooks/useAIChat';
import type { ReviewSearchMatch } from '../utils/reviewSearch';
import type { PRMetadata, PRContext } from '@plannotator/shared/pr-provider';

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
  focusedFileIndex: number;
  focusedFilePath: string | null;
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  fontFamily?: string;
  fontSize?: string;

  // Annotations
  allAnnotations: CodeAnnotation[];
  externalAnnotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, tokenMeta?: TokenAnnotationMeta) => void;
  onAddFileComment: (text: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string) => void;
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

  // AI
  aiAvailable: boolean;
  aiMessages: AIChatEntry[];
  onAskAI: (question: string) => void;
  isAILoading: boolean;
  onViewAIResponse: (questionId?: string) => void;
  onClickAIMarker: (questionId: string) => void;
  aiHistoryForSelection: AIChatEntry[];

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
