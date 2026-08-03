import React, { createContext, useContext } from 'react';
import type { CodeAnnotation, CodeAnnotationType, SelectedLineRange, TokenAnnotationMeta, ConventionalLabel, ConventionalDecoration, Annotation, CommentAnnotation } from '@plannotator/ui/types';
import type { CommentAskAIHandler } from '@plannotator/ui/components/CommentPopover';
import type { AgentJobInfo } from '@plannotator/ui/types';
import type { DiffFile, AnnotationScrollTarget } from '../types';
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
  /** Agent working directory — base for resolving repo-relative diff paths to
   *  absolute (e.g. for the Open-in-app control). */
  agentCwd?: string | null;
  /** Whether live-working-tree actions match the snapshot currently shown. */
  canUseLiveWorkspaceActions?: boolean;

  // Annotations
  allAnnotations: CodeAnnotation[];
  externalAnnotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  /** Sidebar-initiated scroll-to-comment signal; the token re-fires per click.
   *  Selecting a comment in the diff does NOT set this, so it never scrolls. */
  scrollTargetAnnotation: AnnotationScrollTarget | null;
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel, decorations?: ConventionalDecoration[], tokenMeta?: TokenAnnotationMeta) => void;
  onAddAnnotationForFile: (filePath: string, type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel, decorations?: ConventionalDecoration[], tokenMeta?: TokenAnnotationMeta) => void;
  onAddFileComment: (text: string) => void;
  onAddFileCommentForFile: (filePath: string, text: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel | null, decorations?: ConventionalDecoration[]) => void;
  /** Highlight a comment without moving the viewport (in-diff click). */
  onSelectAnnotation: (id: string | null) => void;
  /** Select AND scroll the diff to a comment (sidebar / findings-list click). */
  onNavigateToAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;

  // PR description prose annotations (comment-only; text-anchored Annotation[],
  // kept separate from the diff CodeAnnotation[] above).
  descriptionAnnotations: Annotation[];
  selectedDescriptionAnnotationId: string | null;
  onAddDescriptionAnnotation: (ann: Annotation) => void;
  onSelectDescriptionAnnotation: (id: string | null) => void;
  onDeleteDescriptionAnnotation: (id: string) => void;
  /** Ask AI about a selection in the PR description (file-less scope ask). */
  onAskAIForDescription: CommentAskAIHandler;

  // PR comment annotations (notes attached to a whole comment/review/thread).
  commentAnnotations: CommentAnnotation[];
  selectedCommentAnnotationId: string | null;
  onAddCommentAnnotation: (commentId: string, commentAuthor: string, commentBody: string, text: string) => void;
  onSelectCommentAnnotation: (id: string | null) => void;
  onDeleteCommentAnnotation: (id: string) => void;
  /** Ask AI about a PR comment (file-less scope ask, comment body as text). */
  onAskAIForComment: CommentAskAIHandler;
  /** Sidebar-initiated "reveal this comment" signal (token bumps per click). */
  commentScrollTarget: { commentId: string; token: number } | null;

  // Viewed / staged
  viewedFiles: Set<string>;
  onToggleViewed: (filePath: string) => void;
  stagedFiles: Set<string>;
  stagingFile: string | null;
  onStage: (filePath: string) => void;
  canStageFiles: boolean;
  /** Per-file staging gate — false for committed files in since-base mode. */
  canStagePath?: (filePath: string) => boolean;
  /** Worktree path parsed from the live diffType when it's a
   *  `worktree:<path>:<subType>` string; null for the main tree and PR mode.
   *  Feeds jobMatchesReviewContext's third argument so guide/tour context
   *  matching is worktree-aware (populated from App.tsx's
   *  activeWorktreePath memo — the same parse that drives the sections/tree
   *  UI, so context matching aligns with what's on screen). */
  currentWorktreePath?: string | null;
  /** Guide-mode reveal channel: set (with a fresh token) when a sidebar jump
   *  — annotation click or AI line citation — targets a file while the guide
   *  takeover is open. The GuideSectionCard containing that file expands its
   *  collapsed (reviewed) section, focuses the file's diff, and scrolls to
   *  it; without this, jumps into collapsed sections silently no-op because
   *  no viewer is mounted for the file. Cleared when the guide closes so a
   *  reopen doesn't replay the last reveal. */
  guideRevealFile?: { path: string; token: number } | null;
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
  // Which left panel drives the all-files item order ('list' = sections order).
  allFilesOrder: 'tree' | 'list';
  // All-files collapse-all toggle — the AllFilesCodeView registers its handler
  // here; the dock header's button (ReviewDockRightActions) invokes it.
  allFilesAllCollapsed: boolean;
  onToggleAllFilesCollapsed: () => void;
  registerAllFilesCollapseToggle: (toggle: (() => void) | null) => void;
  onAllFilesCollapsedChange: (collapsed: boolean) => void;
  // Commit metadata when a commit:<sha> diff is active — heads the all-files
  // view (description card) and seeds its files collapsed.
  commitInfo: import('@plannotator/shared/types').CommitDiffInfo | null;
  semanticDiffAvailable: boolean;
  isSemanticDiffActive: boolean;
  onSemanticDiffUnavailable: () => void;
  onSemanticDiffLoadError: () => boolean;
  onSemanticDiffLoadSuccess: () => void;

  // Tour
  openTourPanel: (jobId: string) => void;

  // Guide — optional because not every host wires a guide takeover surface.
  openGuide?: (jobId: string) => void;

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
