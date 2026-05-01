import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { type Origin, getAgentName } from '@plannotator/shared/agents';
import { ThemeProvider, useTheme } from '@plannotator/ui/components/ThemeProvider';
import { TooltipProvider } from '@plannotator/ui/components/Tooltip';
import { ConfirmDialog } from '@plannotator/ui/components/ConfirmDialog';
import { Settings } from '@plannotator/ui/components/Settings';
import { FeedbackButton, ApproveButton, ExitButton } from '@plannotator/ui/components/ToolbarButtons';
import { AgentReviewActions } from './components/AgentReviewActions';
import { UpdateBanner } from '@plannotator/ui/components/UpdateBanner';
import { storage } from '@plannotator/ui/utils/storage';
import { CompletionOverlay } from '@plannotator/ui/components/CompletionOverlay';
import { GitHubIcon } from '@plannotator/ui/components/GitHubIcon';
import { GitLabIcon } from '@plannotator/ui/components/GitLabIcon';
import { RepoIcon } from '@plannotator/ui/components/RepoIcon';
import { PullRequestIcon } from '@plannotator/ui/components/PullRequestIcon';
import { getPlatformLabel, getMRLabel, getMRNumberLabel, getDisplayRepo } from '@plannotator/shared/pr-provider';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { loadDiffFont } from '@plannotator/ui/utils/diffFonts';
import { getAgentSwitchSettings, getEffectiveAgentName } from '@plannotator/ui/utils/agentSwitch';
import { getAIProviderSettings, saveAIProviderSettings, getPreferredModel } from '@plannotator/ui/utils/aiProvider';
import { AISetupDialog } from '@plannotator/ui/components/AISetupDialog';
import { needsAISetup } from '@plannotator/ui/utils/aiSetup';
import { DiffTypeSetupDialog } from '@plannotator/ui/components/DiffTypeSetupDialog';
import { needsDiffTypeSetup } from '@plannotator/ui/utils/diffTypeSetup';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, TokenAnnotationMeta, ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import { useResizablePanel } from '@plannotator/ui/hooks/useResizablePanel';
import { useCodeAnnotationDraft } from '@plannotator/ui/hooks/useCodeAnnotationDraft';
import { useGitAdd } from './hooks/useGitAdd';
import { generateId } from './utils/generateId';
import { useAIChat } from './hooks/useAIChat';
import { extractLinesFromPatch } from './utils/patchParser';
import { isTypingTarget, useReviewSearch, type ReviewSearchMatch } from './hooks/useReviewSearch';
import { useEditorAnnotations } from '@plannotator/ui/hooks/useEditorAnnotations';
import { useExternalAnnotations } from '@plannotator/ui/hooks/useExternalAnnotations';
import { useAgentJobs } from '@plannotator/ui/hooks/useAgentJobs';
import { exportEditorAnnotations } from '@plannotator/ui/utils/parser';
import { ResizeHandle } from '@plannotator/ui/components/ResizeHandle';
import { DockviewReact, type DockviewReadyEvent, type DockviewApi } from 'dockview-react';
import { ReviewHeaderMenu } from './components/ReviewHeaderMenu';
import { ReviewSidebar } from './components/ReviewSidebar';
import { FileTree } from './components/FileTree';
import { StackedPRLabel } from './components/StackedPRLabel';
import { PRSelector } from './components/PRSelector';
import { PRSwitchOverlay } from './components/PRSwitchOverlay';
import { usePRStack } from './hooks/usePRStack';
import { usePRSession, type PRSessionUpdate } from './hooks/usePRSession';
import { useAnnotationFactory } from './hooks/useAnnotationFactory';
import { DEMO_DIFF } from './demoData';
import { exportReviewFeedback } from './utils/exportFeedback';
import { ReviewSubmissionDialog, buildReviewSubmission, type ReviewSubmission, type SubmissionTarget } from './components/ReviewSubmissionDialog';
import { ReviewStateProvider, type ReviewState } from './dock/ReviewStateContext';
import { JobLogsProvider } from './dock/JobLogsContext';
import { reviewPanelComponents } from './dock/reviewPanelComponents';
import { ReviewDockTabRenderer } from './dock/ReviewDockTabRenderer';
import { usePRContext } from './hooks/usePRContext';
import {
  REVIEW_PANEL_TYPES,
  REVIEW_DIFF_PANEL_ID,
  makeReviewAgentJobPanelId,
  getReviewDiffPanelFilePath,
  isReviewDiffPanelId,
  REVIEW_PR_SUMMARY_PANEL_ID,
  REVIEW_PR_COMMENTS_PANEL_ID,
  REVIEW_PR_CHECKS_PANEL_ID,
} from './dock/reviewPanelTypes';
import type { DiffFile } from './types';
import type { DiffOption, WorktreeInfo, GitContext } from '@plannotator/shared/types';
import type { PRMetadata } from '@plannotator/shared/pr-provider';
import type { PRDiffScope, PRDiffScopeOption, PRStackInfo, PRStackTree } from '@plannotator/shared/pr-stack';
import { altKey } from '@plannotator/ui/utils/platform';
import { TourDialog } from './components/tour/TourDialog';
import { DEMO_TOUR_ID } from './demoTour';

declare const __APP_VERSION__: string;

interface DiffData {
  files: DiffFile[];
  rawPatch: string;
  gitRef: string;
  origin?: Origin;
  diffType?: string;
  gitContext?: GitContext;
  sharingEnabled?: boolean;
  prStackInfo?: PRStackInfo | null;
  prDiffScope?: PRDiffScope;
  prDiffScopeOptions?: PRDiffScopeOption[];
}

// Simple diff parser to extract files from unified diff
function parseDiffToFiles(rawPatch: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileChunks = rawPatch.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+) b\/(.+)/);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];

    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    files.push({
      path: newPath,
      oldPath: oldPath !== newPath ? oldPath : undefined,
      patch: 'diff --git ' + chunk,
      additions,
      deletions,
    });
  }

  return files;
}

function getFileTabTitle(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

const ReviewApp: React.FC = () => {
  const { resolvedMode } = useTheme();
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [annotations, setAnnotations] = useState<CodeAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<SelectedLineRange | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showWorktreeDialog, setShowWorktreeDialog] = useState(false);
  const [openSettingsMenu, setOpenSettingsMenu] = useState(false);
  const [showNoAnnotationsDialog, setShowNoAnnotationsDialog] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const diffStyle = useConfigValue('diffStyle');
  const diffOverflow = useConfigValue('diffOverflow');
  const diffIndicators = useConfigValue('diffIndicators');
  const diffLineDiffType = useConfigValue('diffLineDiffType');
  const diffShowLineNumbers = useConfigValue('diffShowLineNumbers');
  const diffShowBackground = useConfigValue('diffShowBackground');
  const diffHideWhitespace = useConfigValue('diffHideWhitespace');
  const diffFontFamily = useConfigValue('diffFontFamily');
  const diffFontSize = useConfigValue('diffFontSize');

  // Load custom diff font and override --font-mono for surrounding review elements
  useEffect(() => {
    if (diffFontFamily) {
      loadDiffFont(diffFontFamily);
      document.documentElement.style.setProperty('--diff-font-override', `'${diffFontFamily}', monospace`);
    } else {
      document.documentElement.style.removeProperty('--diff-font-override');
    }
    if (diffFontSize) {
      document.documentElement.style.setProperty('--diff-font-size-override', diffFontSize);
    } else {
      document.documentElement.style.removeProperty('--diff-font-size-override');
    }
  }, [diffFontFamily, diffFontSize]);

  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [copyRawDiffStatus, setCopyRawDiffStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [hideViewedFiles, setHideViewedFiles] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [gitUser, setGitUser] = useState<string | undefined>();
  const [isWSL, setIsWSL] = useState(false);
  const [diffType, setDiffType] = useState<string>('uncommitted');
  const [gitContext, setGitContext] = useState<GitContext | null>(null);
  // Two bases:
  //   selectedBase  — what the picker is currently showing (UI intent).
  //                   Updates immediately when the user picks, so the chip
  //                   feels responsive.
  //   committedBase — the base the server last computed the patch against.
  //                   Drives file-content fetches. Only updates after
  //                   /api/diff/switch returns, so we never pair an old
  //                   patch with a new base's file contents (race that
  //                   produced "trailing context mismatch" warnings).
  const [selectedBase, setSelectedBase] = useState<string | null>(null);
  const [committedBase, setCommittedBase] = useState<string | null>(null);
  const [agentCwd, setAgentCwd] = useState<string | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [submitted, setSubmitted] = useState<'approved' | 'feedback' | 'exited' | false>(false);
  const [showApproveWarning, setShowApproveWarning] = useState(false);
  const [showExitWarning, setShowExitWarning] = useState(false);
  const [sharingEnabled, setSharingEnabled] = useState(true);
  const [repoInfo, setRepoInfo] = useState<{ display: string; branch?: string } | null>(null);

  useEffect(() => {
    document.title = repoInfo ? `${repoInfo.display} · Code Review` : "Code Review";
  }, [repoInfo]);

  const { prMetadata, prStackInfo, prStackTree, prDiffScope, prDiffScopeOptions, updatePRSession } = usePRSession();
  const { withPRContext } = useAnnotationFactory(prMetadata, prStackInfo ? prDiffScope : undefined);

  const prStackCallbacksRef = useRef<import('./hooks/usePRStack').PRStackCallbacks | null>(null);
  const {
    isSwitchingPRScope,
    handleScopeSelect: handlePRDiffScopeSelect,
    handlePRSwitch,
  } = usePRStack(prStackCallbacksRef);
  const [reviewDestination, setReviewDestination] = useState<'agent' | 'platform'>(() => {
    const stored = storage.getItem('plannotator-review-dest');
    return stored === 'agent' ? 'agent' : 'platform'; // 'github' (legacy) → 'platform'
  });
  const [showDestinationMenu, setShowDestinationMenu] = useState(false);
  const [isPlatformActioning, setIsPlatformActioning] = useState(false);
  const [platformActionError, setPlatformActionError] = useState<string | null>(null);
  const [platformUser, setPlatformUser] = useState<string | null>(null);
  const [platformCommentDialog, setPlatformCommentDialog] = useState<{ action: 'approve' | 'comment'; plan: ReviewSubmission } | null>(null);
  const [platformGeneralComment, setPlatformGeneralComment] = useState('');
  const [platformOpenPR, setPlatformOpenPR] = useState(() => {
    const platformSetting = storage.getItem('plannotator-platform-open-pr');
    if (platformSetting !== null) return platformSetting !== 'false';

    const legacyGitHubSetting = storage.getItem('plannotator-github-open-pr');
    if (legacyGitHubSetting !== null) {
      storage.setItem('plannotator-platform-open-pr', legacyGitHubSetting);
      return legacyGitHubSetting !== 'false';
    }

    return true;
  });

  // Derived: Platform mode is active when destination is platform AND we have PR/MR metadata
  const platformMode = reviewDestination === 'platform' && !!prMetadata;

  // Platform-aware labels
  const platformLabel = prMetadata ? getPlatformLabel(prMetadata) : 'GitHub';
  const mrLabel = prMetadata ? getMRLabel(prMetadata) : 'PR';
  const mrNumberLabel = prMetadata ? getMRNumberLabel(prMetadata) : '';
  const displayRepo = prMetadata ? getDisplayRepo(prMetadata) : '';
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

  const identity = useConfigValue('displayName');

  const clearPendingSelection = useCallback(() => {
    setPendingSelection(null);
  }, []);

  // VS Code editor annotations (only polls when inside VS Code webview)
  const { editorAnnotations, deleteEditorAnnotation } = useEditorAnnotations();

  // External annotations (SSE-based, for any external tool)
  // TODO: Replace !!origin with a dedicated isApiMode boolean (set on /api/diff success/failure).
  // origin is an identity field, not a connectivity signal — the standalone dev server
  // (apps/review/) doesn't set it, so external annotations are silently disabled there.
  // The same !!origin proxy is used elsewhere in this file (draft hook, feedback guard, conditional UI)
  // so this should be addressed as a broader refactor.
  const { externalAnnotations, updateExternalAnnotation, deleteExternalAnnotation } = useExternalAnnotations<CodeAnnotation>({ enabled: !!origin });
  const agentJobs = useAgentJobs({ enabled: !!origin });

  // Tour dialog state — opens as an overlay instead of a dock panel
  const [tourDialogJobId, setTourDialogJobId] = useState<string | null>(null);

  // Dockview center panel API for the review workspace.
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const needsInitialDiffPanel = useRef(true);

  // PR context (lifted from sidebar so center dock PR panels can access it)
  const { prContext, isLoading: isPRContextLoading, error: prContextError, fetchContext: fetchPRContext } = usePRContext(prMetadata ?? null);

  // Sync activeFileIndex from dockview's active panel (wired in handleDockReady)

  const openDiffFile = useCallback((filePath: string) => {
    const file = files.find(candidate => candidate.path === filePath);
    if (!file) return;

    if (!dockApi) {
      const fileIndex = files.findIndex(candidate => candidate.path === filePath);
      if (fileIndex !== -1) {
        setActiveFileIndex(fileIndex);
      }
      return;
    }

    const existing = dockApi.getPanel(REVIEW_DIFF_PANEL_ID);
    if (existing) {
      const existingFilePath = getReviewDiffPanelFilePath(existing.params);
      if (existingFilePath === filePath) {
        if (dockApi.activePanel?.id !== REVIEW_DIFF_PANEL_ID) {
          existing.api.setActive();
        }
        const fileIndex = files.findIndex(candidate => candidate.path === filePath);
        if (fileIndex !== -1) {
          setActiveFileIndex(fileIndex);
        }
        needsInitialDiffPanel.current = false;
        return;
      }

      setPendingSelection(null);
      existing.api.updateParameters({ filePath });
      existing.api.setTitle(getFileTabTitle(file.path));
      existing.api.setActive();
    } else {
      setPendingSelection(null);
      dockApi.addPanel({
        id: REVIEW_DIFF_PANEL_ID,
        component: REVIEW_PANEL_TYPES.DIFF,
        title: getFileTabTitle(file.path),
        params: { filePath },
      });
    }

    setActiveFileIndex(files.findIndex(candidate => candidate.path === filePath));
    needsInitialDiffPanel.current = false;
  }, [dockApi, files]);

  const handleRevealSearchMatch = useCallback((match: ReviewSearchMatch) => {
    openDiffFile(match.filePath);
  }, [openDiffFile]);

  const {
    searchQuery,
    debouncedSearchQuery,
    isSearchPending,
    isSearchOpen,
    activeSearchMatchId,
    activeSearchMatch,
    activeFileSearchMatches,
    searchMatches,
    searchGroups,
    searchInputRef,
    openSearch,
    closeSearch,
    clearSearch,
    stepSearchMatch,
    handleSearchInputChange,
    handleSelectSearchMatch,
  } = useReviewSearch({
    files,
    activeFilePath: files[activeFileIndex]?.path ?? null,
    onRevealMatch: handleRevealSearchMatch,
  });

  const hasSearchableFiles = files.length > 0;
  const shouldShowFileTree =
    hasSearchableFiles ||
    !!gitContext?.diffOptions?.length ||
    !!gitContext?.worktrees?.length;

  // Merge local + SSE annotations, deduping draft-restored externals against
  // live SSE versions. Prefer the SSE version when both exist (same source,
  // type, and originalText). This avoids the timing issues of an effect-based
  // cleanup — draft-restored externals persist until SSE actually re-delivers them.
  const allAnnotations = useMemo(() => {
    if (externalAnnotations.length === 0) return annotations;

    const local = annotations.filter(a => {
      if (!a.source) return true;
      return !externalAnnotations.some(ext =>
        ext.source === a.source &&
        ext.type === a.type &&
        ext.filePath === a.filePath &&
        ext.lineStart === a.lineStart &&
        ext.lineEnd === a.lineEnd &&
        ext.side === a.side
      );
    });

    return [...local, ...externalAnnotations];
  }, [annotations, externalAnnotations]);
  const allAnnotationsRef = useRef(allAnnotations);
  allAnnotationsRef.current = allAnnotations;

  // Auto-save code annotation drafts
  const { draftBanner, restoreDraft, dismissDraft } = useCodeAnnotationDraft({
    annotations: allAnnotations,
    viewedFiles,
    isApiMode: !!origin,
    submitted: !!submitted,
  });

  const handleRestoreDraft = useCallback(() => {
    const restored = restoreDraft();
    if (restored.annotations.length > 0) setAnnotations(restored.annotations);
    if (restored.viewedFiles.length > 0) setViewedFiles(new Set(restored.viewedFiles));
  }, [restoreDraft]);

  // AI Chat
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiProviders, setAiProviders] = useState<Array<{ id: string; name: string; capabilities: Record<string, boolean>; models?: Array<{ id: string; label: string; default?: boolean }> }>>([]);
  const [aiConfig, setAiConfig] = useState(() => {
    const saved = getAIProviderSettings();
    const pid = saved.providerId;
    return {
      providerId: pid,
      model: pid ? (saved.preferredModels[pid] ?? null) : null,
      reasoningEffort: null as string | null,
    };
  });
  const [showAISetup, setShowAISetup] = useState(false);
  const [aiCheckComplete, setAiCheckComplete] = useState(false);
  const [showDiffTypeSetup, setShowDiffTypeSetup] = useState(false);
  const [diffTypeSetupPending, setDiffTypeSetupPending] = useState(false);
  const [sidebarTabOverride, setSidebarTabOverride] = useState<'ai' | undefined>(undefined);
  const aiChat = useAIChat({
    patch: diffData?.rawPatch ?? '',
    providerId: aiConfig.providerId,
    model: aiConfig.model,
    reasoningEffort: aiConfig.reasoningEffort,
  });

  // Check AI capabilities on mount
  useEffect(() => {
    fetch('/api/ai/capabilities')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.available) {
          setAiAvailable(true);
          const providers = data.providers ?? [];
          setAiProviders(providers);
        }
        setAiCheckComplete(true);
      })
      .catch(() => { setAiCheckComplete(true); });
  }, []);

  const handleAIConfigChange = useCallback((config: { providerId?: string | null; model?: string | null }) => {
    setAiConfig(prev => {
      const next = { ...prev, ...config };
      // If provider changed, load that provider's preferred model
      if (config.providerId !== undefined && config.providerId !== prev.providerId) {
        next.model = config.providerId ? getPreferredModel(config.providerId) : null;
      }
      // Persist provider selection
      const saved = getAIProviderSettings();
      saveAIProviderSettings({ ...saved, providerId: next.providerId });
      return next;
    });
    aiChat.resetSession();
  }, [aiChat]);

  const handleAskAI = useCallback((question: string) => {
    if (!pendingSelection || !files[activeFileIndex]) return;
    const lineStart = Math.min(pendingSelection.start, pendingSelection.end);
    const lineEnd = Math.max(pendingSelection.start, pendingSelection.end);
    const side = pendingSelection.side === 'additions' ? 'new' : 'old';
    const selectedCode = extractLinesFromPatch(files[activeFileIndex].patch, lineStart, lineEnd, side);

    aiChat.ask({
      prompt: question,
      filePath: files[activeFileIndex].path,
      lineStart,
      lineEnd,
      side,
      selectedCode: selectedCode || undefined,
    });
  }, [pendingSelection, files, activeFileIndex, aiChat]);

  const handleViewAIResponse = useCallback((questionId?: string) => {
    setSidebarTabOverride('ai');
    setIsPanelOpen(true);
    if (questionId) {
      setScrollToQuestionId(questionId);
      setTimeout(() => setScrollToQuestionId(null), 500);
    }
  }, []);

  const handleScrollToAILines = useCallback((filePath: string, lineStart: number, lineEnd: number, side: 'old' | 'new') => {
    openDiffFile(filePath);
    // Set a selection to highlight the lines
    setPendingSelection({
      start: lineStart,
      end: lineEnd,
      side: side === 'new' ? 'additions' : 'deletions',
    });
  }, [openDiffFile]);


  // AI messages overlapping the current selection (for toolbar history)
  const aiHistoryForSelection = useMemo(() => {
    if (!pendingSelection || !files[activeFileIndex]) return [];
    const filePath = files[activeFileIndex].path;
    const selStart = Math.min(pendingSelection.start, pendingSelection.end);
    const selEnd = Math.max(pendingSelection.start, pendingSelection.end);
    const side = pendingSelection.side === 'additions' ? 'new' : 'old';
    return aiChat.messages.filter(m => {
      const q = m.question;
      return q.filePath === filePath && q.side === side &&
        q.lineStart != null && q.lineEnd != null &&
        q.lineStart <= selEnd && q.lineEnd >= selStart;
    });
  }, [pendingSelection, files, activeFileIndex, aiChat.messages]);

  // Click AI marker in diff → scroll sidebar to that Q&A
  const [scrollToQuestionId, setScrollToQuestionId] = useState<string | null>(null);
  const handleClickAIMarker = useCallback((questionId: string) => {
    setScrollToQuestionId(questionId);
    setSidebarTabOverride('ai');
    setIsPanelOpen(true);
    // Clear after a tick so it can re-trigger for the same question
    setTimeout(() => setScrollToQuestionId(null), 500);
  }, []);

  // General AI question from sidebar input
  const handleAskGeneral = useCallback((question: string) => {
    aiChat.ask({ prompt: question });
  }, [aiChat.ask]);

  // Resizable panels
  const panelResize = useResizablePanel({ storageKey: 'plannotator-review-panel-width' });
  const fileTreeResize = useResizablePanel({
    storageKey: 'plannotator-filetree-width',
    defaultWidth: 256, minWidth: 160, maxWidth: 400, side: 'left',
  });
  const isResizing = panelResize.isDragging || fileTreeResize.isDragging;

  // Dockview ready handler — stores API and wires active panel tracking.
  // Initial panel creation happens in the effect below once dockApi is set.
  const handleDockReady = useCallback((event: DockviewReadyEvent) => {
    setDockApi(event.api);

    // Sync activeFileIndex when user switches between dock tabs
    event.api.onDidActivePanelChange((panel) => {
      if (!panel || !isReviewDiffPanelId(panel.id)) return;
      const filePath = getReviewDiffPanelFilePath(panel.params);
      if (!filePath) return;
      const fileIndex = filesRef.current.findIndex(file => file.path === filePath);
      if (fileIndex !== -1) {
        setActiveFileIndex(fileIndex);
      }
    });

    // Hide Dockview chrome only for the dedicated single diff tab.
    // Any lone non-diff panel still needs a visible header so it can be
    // dragged, closed, and used as a way back out of the dock.
    const updateHeaders = () => {
      const lonePanel =
        event.api.totalPanels === 1 && event.api.groups.length === 1
          ? event.api.groups[0]?.panels[0]
          : undefined;
      const hideHeaders = lonePanel?.id === REVIEW_DIFF_PANEL_ID;
      for (const group of event.api.groups) {
        group.header.hidden = hideHeaders;
      }
    };
    event.api.onDidAddPanel(updateHeaders);
    event.api.onDidRemovePanel(updateHeaders);
    event.api.onDidAddGroup(updateHeaders);
    event.api.onDidRemoveGroup(updateHeaders);
    event.api.onDidMovePanel(updateHeaders);
    event.api.onDidLayoutChange(updateHeaders);
    updateHeaders();
  }, []);

  // Create the initial diff panel on first load and after diff switches.
  useEffect(() => {
    if (!dockApi || !needsInitialDiffPanel.current || files.length === 0) return;
    openDiffFile(files[0].path);
  }, [dockApi, files, openDiffFile]);


  // Open agent job detail as center dock panel
  const handleOpenJobDetail = useCallback((jobId: string) => {
    const api = dockApi;
    if (!api) return;
    const panelId = makeReviewAgentJobPanelId(jobId);
    const existing = api.getPanel(panelId);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const job = agentJobs.jobs.find(j => j.id === jobId);
    api.addPanel({
      id: panelId,
      component: REVIEW_PANEL_TYPES.AGENT_JOB_DETAIL,
      title: job?.label ?? `Job ${jobId.slice(0, 8)}`,
      params: { jobId },
    });
  }, [dockApi, agentJobs.jobs]);

  // Open tour as a dialog overlay
  const handleOpenTour = useCallback((jobId: string) => {
    setTourDialogJobId(jobId);
  }, []);

  // Dev-only: Cmd/Ctrl+Shift+T toggles the demo tour for fast UI iteration.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        setTourDialogJobId(prev => (prev === DEMO_TOUR_ID ? null : DEMO_TOUR_ID));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-open tour dialog when a tour job completes
  const tourAutoOpenRef = useRef(new Set<string>());
  useEffect(() => {
    for (const job of agentJobs.jobs) {
      if (
        job.provider === 'tour' &&
        job.status === 'done' &&
        !tourAutoOpenRef.current.has(job.id)
      ) {
        tourAutoOpenRef.current.add(job.id);
        setTourDialogJobId(job.id);
      }
    }
  }, [agentJobs.jobs]);

  // Open PR panel as center dock panel
  const handleOpenPRPanel = useCallback((type: 'summary' | 'comments' | 'checks') => {
    const api = dockApi;
    if (!api) return;
    const config = {
      summary: { id: REVIEW_PR_SUMMARY_PANEL_ID, component: REVIEW_PANEL_TYPES.PR_SUMMARY, title: 'PR Summary' },
      comments: { id: REVIEW_PR_COMMENTS_PANEL_ID, component: REVIEW_PANEL_TYPES.PR_COMMENTS, title: 'PR Comments' },
      checks: { id: REVIEW_PR_CHECKS_PANEL_ID, component: REVIEW_PANEL_TYPES.PR_CHECKS, title: 'PR Checks' },
    }[type];
    const existing = api.getPanel(config.id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id: config.id,
      component: config.component,
      title: config.title,
    });
  }, [dockApi]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F to focus file search when diff files are available.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !isTypingTarget(e.target)) {
        if (hasSearchableFiles) {
          e.preventDefault();
          openSearch();
        }
        return;
      }

      // Enter/F3 to step through search matches
      if ((e.key === 'Enter' || e.key === 'F3') && searchMatches.length > 0 && !isSearchPending && !isTypingTarget(e.target)) {
        e.preventDefault();
        stepSearchMatch(e.shiftKey ? -1 : 1);
        return;
      }

      // Escape closes modals or clears search
      if (e.key === 'Escape') {
        if (showDestinationMenu) {
          setShowDestinationMenu(false);
        } else if (showExportModal) {
          setShowExportModal(false);
        } else if (isSearchOpen) {
          if (searchQuery) {
            clearSearch();
          } else {
            closeSearch();
          }
        } else if (searchQuery) {
          clearSearch();
        }
      }
      // Cmd/Ctrl+Shift+C to copy diff
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
        e.preventDefault();
        handleCopyDiff();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showExportModal, showDestinationMenu, isSearchOpen, searchQuery, searchMatches, isSearchPending, openSearch, stepSearchMatch, clearSearch, closeSearch, hasSearchableFiles]);


  // Load diff content - try API first, fall back to demo
  useEffect(() => {
    fetch('/api/diff')
      .then(res => {
        if (!res.ok) throw new Error('Not in API mode');
        return res.json();
      })
      .then((data: {
        rawPatch: string;
        gitRef: string;
        origin?: Origin;
        diffType?: string;
        base?: string;
        gitContext?: GitContext;
        agentCwd?: string;
        sharingEnabled?: boolean;
        repoInfo?: { display: string; branch?: string };
        prMetadata?: PRMetadata;
        prStackInfo?: PRStackInfo | null;
        prStackTree?: PRStackTree | null;
        prDiffScope?: PRDiffScope;
        prDiffScopeOptions?: PRDiffScopeOption[];
        platformUser?: string;
        viewedFiles?: string[];
        error?: string;
        isWSL?: boolean;
        serverConfig?: { displayName?: string; gitUser?: string };
      }) => {
        // Initialize config store with server-provided values (config file > cookie > default)
        configStore.init(data.serverConfig);
        // gitUser drives the "Use git name" button in Settings; stays undefined (button hidden) when unavailable
        setGitUser(data.serverConfig?.gitUser);
        const apiFiles = parseDiffToFiles(data.rawPatch);
        setDiffData({
          files: apiFiles,
          rawPatch: data.rawPatch,
          gitRef: data.gitRef,
          origin: data.origin,
          diffType: data.diffType,
          gitContext: data.gitContext,
          sharingEnabled: data.sharingEnabled,
        });
        setFiles(apiFiles);
        if (data.origin) setOrigin(data.origin);
        if (data.diffType) setDiffType(data.diffType);
        if (data.gitContext) {
          setGitContext(data.gitContext);
          // Prefer the server's active base (survives page refresh / reconnect)
          // over the detected default, so the picker rehydrates to what the
          // server is actually using.
          const initial = data.base || data.gitContext.defaultBranch || null;
          setSelectedBase(initial);
          setCommittedBase(initial);
        }
        if (data.agentCwd) setAgentCwd(data.agentCwd);
        if (data.sharingEnabled !== undefined) setSharingEnabled(data.sharingEnabled);
        if (data.repoInfo) setRepoInfo(data.repoInfo);
        updatePRSession({
          ...(data.prMetadata && { prMetadata: data.prMetadata }),
          ...(data.prStackInfo !== undefined && { prStackInfo: data.prStackInfo }),
          ...(data.prStackTree !== undefined && { prStackTree: data.prStackTree }),
          ...(data.prDiffScope && { prDiffScope: data.prDiffScope }),
          ...(data.prDiffScopeOptions && { prDiffScopeOptions: data.prDiffScopeOptions }),
        });
        if (data.platformUser) setPlatformUser(data.platformUser);
        // Initialize viewed files from GitHub's state (set before draft restore so draft takes precedence)
        if (data.viewedFiles && data.viewedFiles.length > 0) {
          setViewedFiles(new Set(data.viewedFiles));
        }
        if (data.error) setDiffError(data.error);
        if (data.isWSL) setIsWSL(true);
        // Mark diff type setup as pending on first run (local mode only)
        if (data.diffType && !data.prMetadata && data.gitContext?.vcsType !== 'p4' && needsDiffTypeSetup()) {
          setDiffTypeSetupPending(true);
        }
      })
      .catch(() => {
        // Not in API mode - use demo content
        const demoFiles = parseDiffToFiles(DEMO_DIFF);
        setDiffData({
          files: demoFiles,
          rawPatch: DEMO_DIFF,
          gitRef: 'demo',
        });
        setFiles(demoFiles);
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Show diff type setup dialog only after AI setup dialog is dismissed (avoid stacking)
  useEffect(() => {
    if (diffTypeSetupPending && aiCheckComplete && !showAISetup) {
      setDiffTypeSetupPending(false);
      setShowDiffTypeSetup(true);
    }
  }, [diffTypeSetupPending, aiCheckComplete, showAISetup]);

  const handleDiffStyleChange = useCallback((style: 'split' | 'unified') => {
    configStore.set('diffStyle', style);
  }, []);

  // Handle line selection from diff viewer
  const handleLineSelection = useCallback((range: SelectedLineRange | null) => {
    setPendingSelection(range);
  }, []);

  // Add annotation
  const handleAddAnnotation = useCallback((
    type: CodeAnnotationType,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
    conventionalLabel?: ConventionalLabel,
    decorations?: ConventionalDecoration[],
    tokenMeta?: TokenAnnotationMeta
  ) => {
    if (!pendingSelection || !files[activeFileIndex]) return;

    // Normalize line range (in case user selected bottom-to-top)
    const lineStart = Math.min(pendingSelection.start, pendingSelection.end);
    const lineEnd = Math.max(pendingSelection.start, pendingSelection.end);

    const newAnnotation: CodeAnnotation = {
      id: generateId(),
      type,
      scope: 'line',
      filePath: files[activeFileIndex].path,
      lineStart,
      lineEnd,
      side: pendingSelection.side === 'additions' ? 'new' : 'old',
      text,
      suggestedCode,
      originalCode,
      ...(tokenMeta && {
        charStart: tokenMeta.charStart,
        charEnd: tokenMeta.charEnd,
        tokenText: tokenMeta.tokenText,
      }),
      createdAt: Date.now(),
      author: identity,
      conventionalLabel,
      decorations,
    };

    setAnnotations(prev => [...prev, withPRContext(newAnnotation)]);
    setPendingSelection(null);
  }, [pendingSelection, files, activeFileIndex, identity, withPRContext]);

  const handleAddFileComment = useCallback((text: string) => {
    const activeFile = files[activeFileIndex];
    const trimmed = text.trim();
    if (!activeFile || !trimmed) return;

    const newAnnotation: CodeAnnotation = {
      id: generateId(),
      type: 'comment',
      scope: 'file',
      filePath: activeFile.path,
      lineStart: 1,
      lineEnd: 1,
      side: 'new',
      text: trimmed,
      createdAt: Date.now(),
      author: identity,
    };

    setAnnotations(prev => [...prev, withPRContext(newAnnotation)]);
  }, [files, activeFileIndex, identity, withPRContext]);

  // Edit annotation
  const handleEditAnnotation = useCallback((
    id: string,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
    conventionalLabel?: ConventionalLabel | null,
    decorations?: ConventionalDecoration[],
  ) => {
    const ann = allAnnotationsRef.current.find(a => a.id === id);
    const updates: Partial<CodeAnnotation> = {
      ...(text !== undefined && { text }),
      ...(suggestedCode !== undefined && { suggestedCode }),
      ...(originalCode !== undefined && { originalCode }),
      // null clears the label; undefined means "not provided, keep existing"
      ...(conventionalLabel !== undefined && { conventionalLabel: conventionalLabel ?? undefined }),
      ...(decorations !== undefined && { decorations }),
    };
    if (ann?.source && externalAnnotations.some(e => e.id === id)) {
      updateExternalAnnotation(id, updates);
      return;
    }
    setAnnotations(prev => prev.map(a =>
      a.id === id ? { ...a, ...updates } : a
    ));
  }, [updateExternalAnnotation, externalAnnotations]);

  const handleDeleteAnnotation = useCallback((id: string) => {
    const ann = allAnnotationsRef.current.find(a => a.id === id);
    if (ann?.source && externalAnnotations.some(e => e.id === id)) {
      deleteExternalAnnotation(id);
      if (selectedAnnotationId === id) setSelectedAnnotationId(null);
      return;
    }
    setAnnotations(prev => prev.filter(a => a.id !== id));
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null);
    }
  }, [selectedAnnotationId, deleteExternalAnnotation, externalAnnotations]);

  // Handle identity change - update author on existing annotations
  const handleIdentityChange = useCallback((oldIdentity: string, newIdentity: string) => {
    setAnnotations(prev => prev.map(ann =>
      ann.author === oldIdentity ? { ...ann, author: newIdentity } : ann
    ));
  }, []);

  // Switch file in the dedicated center diff panel.
  const handleFilePreview = useCallback((index: number) => {
    const file = files[index];
    if (!file) return;
    openDiffFile(file.path);
  }, [files, openDiffFile]);

  // Double-click currently behaves the same as single-click.
  const handleFilePinned = useCallback((index: number) => {
    const file = files[index];
    if (!file) return;
    openDiffFile(file.path);
  }, [files, openDiffFile]);

  // Legacy file switch (used by handleSelectAnnotation, diff switch, etc.)
  const handleFileSwitch = useCallback((index: number) => {
    const file = files[index];
    if (file) {
      openDiffFile(file.path);
    }
  }, [files, openDiffFile]);

  const handleToggleViewed = useCallback((filePath: string) => {
    setViewedFiles(prev => {
      const next = new Set(prev);
      const willBeViewed = !prev.has(filePath);
      if (willBeViewed) {
        next.add(filePath);
      } else {
        next.delete(filePath);
      }
      // Sync viewed state to GitHub (fire and forget — best effort)
      // Capture willBeViewed inside the callback to ensure correctness with React batching
      if (prMetadata && prMetadata.platform === 'github') {
        fetch('/api/pr-viewed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths: [filePath], viewed: willBeViewed }),
        }).catch(() => {
          // Silently ignore — viewed sync is best-effort
        });
      }
      return next;
    });
  }, [prMetadata]);

  // Derive worktree path and base diff type from the composite diffType string
  const { activeWorktreePath, activeDiffBase } = useMemo(() => {
    if (diffType.startsWith('worktree:')) {
      const rest = diffType.slice('worktree:'.length);
      const lastColon = rest.lastIndexOf(':');
      if (lastColon !== -1) {
        const sub = rest.slice(lastColon + 1);
        if (['uncommitted', 'staged', 'unstaged', 'last-commit', 'branch', 'merge-base', 'all'].includes(sub)) {
          return { activeWorktreePath: rest.slice(0, lastColon), activeDiffBase: sub };
        }
      }
      return { activeWorktreePath: rest, activeDiffBase: 'uncommitted' };
    }
    return { activeWorktreePath: null, activeDiffBase: diffType };
  }, [diffType]);

  // Git add/staging logic
  const handleFileViewedFromStage = useCallback(
    (path: string) => setViewedFiles(prev => new Set(prev).add(path)),
    [],
  );
  const { stagedFiles, stagingFile, canStageFiles: canStageRaw, stageFile, resetStagedFiles, stageError } = useGitAdd({
    activeDiffBase,
    onFileViewed: handleFileViewedFromStage,
  });
  // Staging is never available in PR review mode — the server rejects it and the UI shouldn't offer it.
  const canStageFiles = canStageRaw && !prMetadata;

  // Shared function: apply a PR response (used by both initial load and PR switch)
  function applyPRResponse(data: PRSessionUpdate & {
    rawPatch: string; gitRef: string;
    repoInfo?: { display: string; branch?: string };
    viewedFiles?: string[]; error?: string;
  }) {
    const isPRSwitch = !!data.prMetadata;
    const nextFiles = parseDiffToFiles(data.rawPatch);
    dockApi?.getPanel(REVIEW_DIFF_PANEL_ID)?.api.close();
    needsInitialDiffPanel.current = true;
    setDiffData(prev => prev ? { ...prev, rawPatch: data.rawPatch, gitRef: data.gitRef } : prev);
    setFiles(nextFiles);
    if (isPRSwitch) {
      setActiveFileIndex(0);
    } else {
      const currentFile = files[activeFileIndex];
      const preserved = currentFile ? nextFiles.findIndex(f => f.path === currentFile.path) : -1;
      setActiveFileIndex(preserved >= 0 ? preserved : 0);
    }
    setPendingSelection(null);
    updatePRSession({
      ...(data.prMetadata && { prMetadata: data.prMetadata }),
      ...(data.prStackInfo !== undefined && { prStackInfo: data.prStackInfo }),
      ...(data.prStackTree !== undefined && { prStackTree: data.prStackTree }),
      ...(data.prDiffScope && { prDiffScope: data.prDiffScope }),
      ...(data.prDiffScopeOptions && { prDiffScopeOptions: data.prDiffScopeOptions }),
    });
    if (data.repoInfo) setRepoInfo(data.repoInfo);
    if (data.prMetadata) {
      setViewedFiles(data.viewedFiles ? new Set(data.viewedFiles) : new Set());
    }
    setDiffError(data.error || null);
    resetStagedFiles();
  }

  prStackCallbacksRef.current = {
    applyPRResponse,
    onError: (message) => setDiffError(message),
  };

  // Shared helper: fetch a diff switch and update state.
  // Returns true on success, false on failure — callers that optimistically
  // updated UI state (e.g. the base picker) can use this to revert.
  const fetchDiffSwitch = useCallback(async (fullDiffType: string, baseOverride?: string, options?: { preserveFile?: boolean }): Promise<boolean> => {
    setIsLoadingDiff(true);
    try {
      const res = await fetch('/api/diff/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          diffType: fullDiffType,
          // Server ignores base for modes that don't use it (uncommitted/staged/etc),
          // so forwarding unconditionally is safe and keeps the request shape uniform.
          ...((baseOverride ?? selectedBase) && { base: baseOverride ?? selectedBase }),
          hideWhitespace: diffHideWhitespace,
        }),
      });

      if (!res.ok) throw new Error('Failed to switch diff');

      const data = await res.json() as {
        rawPatch: string;
        gitRef: string;
        diffType: string;
        base?: string;
        gitContext?: GitContext;
        error?: string;
      };

      const nextFiles = parseDiffToFiles(data.rawPatch);

      if (options?.preserveFile) {
        // Whitespace toggle: update patch in-place, keep the active file.
        // If the current file was removed (whitespace-only), retarget the
        // dock panel to the first remaining file.
        setDiffData(prev => prev ? { ...prev, rawPatch: data.rawPatch, gitRef: data.gitRef } : prev);
        setFiles(nextFiles);
        const currentPath = files[activeFileIndex]?.path;
        const nextIdx = currentPath ? nextFiles.findIndex(f => f.path === currentPath) : -1;
        if (nextIdx !== -1) {
          setActiveFileIndex(nextIdx);
        } else if (nextFiles.length > 0) {
          setActiveFileIndex(0);
          openDiffFile(nextFiles[0].path);
        }
      } else {
        dockApi?.getPanel(REVIEW_DIFF_PANEL_ID)?.api.close();
        needsInitialDiffPanel.current = true;
        setDiffData(prev => prev ? { ...prev, rawPatch: data.rawPatch, gitRef: data.gitRef, diffType: data.diffType } : prev);
        setFiles(nextFiles);
        setDiffType(data.diffType);
        if (data.base) {
          setSelectedBase(data.base);
          setCommittedBase(data.base);
        }
        // Merge only the per-cwd fields so the sidebar reflects the worktree
        // we're now in. Keep the original `worktrees` list (already filtered to
        // exclude the server's startup cwd — replacing it with the new context's
        // list would duplicate the "Main repo" entry) and `availableBranches`
        // (shared across worktrees of the same repo).
        //
        // IMPORTANT: we deliberately do NOT overwrite `currentBranch`. The
        // WorktreePicker's top "launch" row uses it as a label, and that row
        // represents the cwd plannotator was launched in — not whichever
        // worktree is currently active. Freezing `currentBranch` at its
        // initial-load value keeps that label truthful. `defaultBranch` and
        // `diffOptions` update because they describe the active diff, which
        // other UI (empty-state text, diff-type picker) should see fresh.
        if (data.gitContext) {
          setGitContext((prev) => {
            if (!prev) return data.gitContext!;
            return {
              ...prev,
              defaultBranch: data.gitContext!.defaultBranch,
              diffOptions: data.gitContext!.diffOptions,
            };
          });
        }
        setActiveFileIndex(0);
        setPendingSelection(null);
        resetStagedFiles();
      }
      setDiffError(data.error || null);
      return true;
    } catch (err) {
      console.error('Failed to switch diff:', err);
      setDiffError(err instanceof Error ? err.message : 'Failed to switch diff');
      return false;
    } finally {
      setIsLoadingDiff(false);
    }
  }, [dockApi, resetStagedFiles, selectedBase, diffHideWhitespace, files, activeFileIndex, openDiffFile]);

  // Switch the base branch the current diff compares against.
  // Only triggers a refetch when the active mode actually uses a base.
  // Optimistically updates the picker; reverts if the server-side switch
  // fails so the chip doesn't lie about what the viewer is actually showing.
  const handleBaseSelect = useCallback(
    async (branch: string) => {
      if (branch === selectedBase) return;
      const previous = selectedBase;
      setSelectedBase(branch);
      if (activeDiffBase === 'branch' || activeDiffBase === 'merge-base') {
        const ok = await fetchDiffSwitch(diffType, branch);
        if (!ok) setSelectedBase(previous);
      }
    },
    [selectedBase, activeDiffBase, diffType, fetchDiffSwitch],
  );

  // Switch diff type (uncommitted, last-commit, branch) — composes worktree prefix if active
  const handleDiffSwitch = useCallback(async (baseDiffType: string) => {
    const fullDiffType = activeWorktreePath
      ? `worktree:${activeWorktreePath}:${baseDiffType}`
      : baseDiffType;
    if (fullDiffType === diffType) return;
    await fetchDiffSwitch(fullDiffType);
  }, [diffType, activeWorktreePath, fetchDiffSwitch]);

  // Switch worktree context (or back to main repo). Preserves the current
  // diff mode across the switch — if the reviewer was looking at "PR Diff"
  // in the main repo, they should keep looking at "PR Diff" in the target
  // worktree rather than being silently snapped back to "Uncommitted".
  const handleWorktreeSwitch = useCallback(async (worktreePath: string | null) => {
    if (worktreePath === activeWorktreePath) return;
    const fullDiffType = worktreePath
      ? `worktree:${worktreePath}:${activeDiffBase}`
      : activeDiffBase;
    await fetchDiffSwitch(fullDiffType);
  }, [activeWorktreePath, activeDiffBase, fetchDiffSwitch]);

  // Re-fetch diff when hideWhitespace toggles so the server applies git diff -w.
  // Preserves the active file since only whitespace hunks change.
  const hideWhitespaceInitialized = useRef(false);
  useEffect(() => {
    if (!origin || !gitContext) return;
    if (!hideWhitespaceInitialized.current) {
      hideWhitespaceInitialized.current = true;
      return;
    }
    fetchDiffSwitch(diffType, selectedBase, { preserveFile: true });
  }, [diffHideWhitespace, origin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Select annotation - switches file if needed and scrolls to it
  const handleSelectAnnotation = useCallback((id: string | null) => {
    if (!id) {
      setSelectedAnnotationId(null);
      return;
    }

    // Find the annotation
    const annotation = allAnnotations.find(a => a.id === id);
    if (!annotation) {
      setSelectedAnnotationId(id);
      return;
    }

    // Find and switch to the file containing this annotation
    const fileIndex = files.findIndex(f => f.path === annotation.filePath);
    if (fileIndex !== -1) {
      handleFileSwitch(fileIndex);
    }

    setSelectedAnnotationId(id);
  }, [allAnnotations, files, handleFileSwitch]);

  // Diff context bundled into local-mode feedback headers so the receiving
  // agent knows which diff the annotations are anchored to. Uses committedBase
  // (what the server actually computed) and activeDiffBase/activeWorktreePath
  // (derived from the committed diffType). Skipped in PR mode — the PR header
  // already carries the relevant context.
  // Declared before reviewStateValue because both reviewStateValue and the
  // feedbackMarkdown memo below read it; moving it below either would put it
  // in the TDZ when those memos run on first render.
  const feedbackDiffContext = useMemo(
    () =>
      prMetadata || !activeDiffBase
        ? undefined
        : {
            mode: activeDiffBase,
            base: committedBase ?? undefined,
            worktreePath: activeWorktreePath,
          },
    [prMetadata, activeDiffBase, committedBase, activeWorktreePath],
  );

  const prReviewScopeLabel = useMemo(() => {
    if (!prMetadata || !prStackInfo) return undefined;
    if (prDiffScope === 'full-stack') {
      return `Diff vs \`${prMetadata.defaultBranch ?? 'default branch'}\``;
    }
    return `Diff vs \`${prMetadata.baseBranch}\``;
  }, [prMetadata, prStackInfo, prDiffScope]);

  // Build ReviewState value for dock panel context
  const reviewStateValue = useMemo<ReviewState>(() => ({
    files,
    focusedFileIndex: activeFileIndex,
    focusedFilePath: files[activeFileIndex]?.path ?? null,
    diffStyle,
    diffOverflow,
    diffIndicators,
    lineDiffType: diffLineDiffType,
    disableLineNumbers: !diffShowLineNumbers,
    disableBackground: !diffShowBackground,
    fontFamily: diffFontFamily || undefined,
    fontSize: diffFontSize || undefined,
    // Only propagate base for modes where it affects old/new content. Avoids
    // needless file-content re-fetches when switching to uncommitted/staged/etc.
    // Uses committedBase (not selectedBase) so file-content queries wait for
    // the new patch to arrive before refetching — otherwise the viewer can
    // briefly pair an old patch with the new base's content.
    reviewBase:
      (activeDiffBase === 'branch' || activeDiffBase === 'merge-base')
        ? committedBase ?? undefined
        : undefined,
    activeDiffBase,
    feedbackDiffContext,
    prReviewScope: prReviewScopeLabel,
    prDiffScope,
    allAnnotations,
    externalAnnotations,
    selectedAnnotationId,
    pendingSelection,
    onLineSelection: handleLineSelection,
    onAddAnnotation: handleAddAnnotation,
    onAddFileComment: handleAddFileComment,
    onEditAnnotation: handleEditAnnotation,
    onSelectAnnotation: handleSelectAnnotation,
    onDeleteAnnotation: handleDeleteAnnotation,
    viewedFiles,
    onToggleViewed: handleToggleViewed,
    stagedFiles,
    stagingFile,
    onStage: stageFile,
    canStageFiles,
    stageError,
    searchQuery: isSearchPending ? '' : debouncedSearchQuery,
    isSearchPending,
    debouncedSearchQuery,
    activeFileSearchMatches,
    activeSearchMatchId,
    activeSearchMatch: activeSearchMatch?.filePath === files[activeFileIndex]?.path ? activeSearchMatch : null,
    aiAvailable,
    aiMessages: aiChat.messages,
    onAskAI: handleAskAI,
    isAILoading: aiChat.isCreatingSession || aiChat.isStreaming,
    onViewAIResponse: handleViewAIResponse,
    onClickAIMarker: handleClickAIMarker,
    aiHistoryForSelection,
    agentJobs: agentJobs.jobs,
    prMetadata,
    prContext,
    isPRContextLoading,
    prContextError,
    fetchPRContext,
    platformUser,
    openDiffFile,
    openTourPanel: handleOpenTour,
  }), [
    files, activeFileIndex, diffStyle, diffOverflow, diffIndicators,
    diffLineDiffType, diffShowLineNumbers, diffShowBackground,
    diffFontFamily, diffFontSize, activeDiffBase, committedBase, feedbackDiffContext, prReviewScopeLabel, prDiffScope,
    allAnnotations, externalAnnotations,
    selectedAnnotationId, pendingSelection, handleLineSelection,
    handleAddAnnotation, handleAddFileComment, handleEditAnnotation,
    handleSelectAnnotation, handleDeleteAnnotation, viewedFiles,
    handleToggleViewed, stagedFiles, stagingFile, stageFile,
    canStageFiles, stageError, isSearchPending, debouncedSearchQuery,
    activeFileSearchMatches, activeSearchMatchId, activeSearchMatch,
    aiAvailable, aiChat.messages, aiChat.isCreatingSession, aiChat.isStreaming,
    handleAskAI, handleViewAIResponse, handleClickAIMarker,
    aiHistoryForSelection, agentJobs.jobs, prMetadata, prContext,
    isPRContextLoading, prContextError, fetchPRContext, platformUser, openDiffFile,
    handleOpenTour,
  ]);

  // Separate context for high-frequency job logs — prevents re-rendering all panels on every SSE event
  const jobLogsValue = useMemo(() => ({ jobLogs: agentJobs.jobLogs }), [agentJobs.jobLogs]);

  // Copy raw diff to clipboard
  const handleCopyDiff = useCallback(async () => {
    if (!diffData) return;
    try {
      await navigator.clipboard.writeText(diffData.rawPatch);
      setCopyRawDiffStatus('success');
      setTimeout(() => setCopyRawDiffStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      setCopyRawDiffStatus('error');
      setTimeout(() => setCopyRawDiffStatus('idle'), 2000);
    }
  }, [diffData]);

  // Copy feedback markdown to clipboard
  const handleCopyFeedback = useCallback(async () => {
    if (allAnnotations.length === 0) {
      setShowNoAnnotationsDialog(true);
      return;
    }
    try {
      const feedback = exportReviewFeedback(allAnnotations, prMetadata, feedbackDiffContext, prReviewScopeLabel);
      await navigator.clipboard.writeText(feedback);
      setCopyFeedback('Feedback copied!');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      setCopyFeedback('Failed to copy');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [allAnnotations, prMetadata, feedbackDiffContext, prReviewScopeLabel]);

  const feedbackMarkdown = useMemo(() => {
    let output = exportReviewFeedback(allAnnotations, prMetadata, feedbackDiffContext, prReviewScopeLabel);
    if (editorAnnotations.length > 0) {
      output += exportEditorAnnotations(editorAnnotations);
    }
    return output;
  }, [allAnnotations, prMetadata, feedbackDiffContext, prReviewScopeLabel, editorAnnotations]);

  const totalAnnotationCount = allAnnotations.length + editorAnnotations.length;

  // Send feedback to OpenCode via API
  const handleSendFeedback = useCallback(async () => {
    if (totalAnnotationCount === 0) {
      setShowNoAnnotationsDialog(true);
      return;
    }
    setIsSendingFeedback(true);
    try {
      const agentSwitchSettings = getAgentSwitchSettings();
      const effectiveAgent = getEffectiveAgentName(agentSwitchSettings);

      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: false,
          feedback: feedbackMarkdown,
          annotations: allAnnotations,
          ...(effectiveAgent && { agentSwitch: effectiveAgent }),
        }),
      });
      if (res.ok) {
        setSubmitted('feedback');
      } else {
        throw new Error('Failed to send');
      }
    } catch (err) {
      console.error('Failed to send feedback:', err);
      setCopyFeedback('Failed to send');
      setTimeout(() => setCopyFeedback(null), 2000);
      setIsSendingFeedback(false);
    }
  }, [totalAnnotationCount, feedbackMarkdown, allAnnotations]);

  // Exit review session without sending any feedback
  const handleExit = useCallback(async () => {
    setIsExiting(true);
    try {
      const res = await fetch('/api/exit', { method: 'POST' });
      if (res.ok) {
        setSubmitted('exited');
      } else {
        throw new Error('Failed to exit');
      }
    } catch (error) {
      console.error('Failed to exit review:', error);
      setIsExiting(false);
    }
  }, []);

  // Approve without feedback (LGTM)
  const handleApprove = useCallback(async () => {
    setIsApproving(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: true,
          feedback: 'LGTM - no changes requested.', // unused — integrations branch on `approved` flag
          annotations: [],
        }),
      });
      if (res.ok) {
        setSubmitted('approved');
      } else {
        throw new Error('Failed to send');
      }
    } catch (err) {
      console.error('Failed to approve:', err);
      setCopyFeedback('Failed to send');
      setTimeout(() => setCopyFeedback(null), 2000);
      setIsApproving(false);
    }
  }, []);

  // Submit reviews to one or more PRs via /api/pr-action
  const handlePlatformAction = useCallback(async (action: 'approve' | 'comment', plan: ReviewSubmission, generalComment?: string) => {
    setIsPlatformActioning(true);
    setPlatformActionError(null);

    try {
      const bodyForTarget = (target: SubmissionTarget) => {
        const parts: string[] = [];
        if (generalComment) parts.push(generalComment);
        parts.push('Review from Plannotator');
        if (target.fileScopedBody) parts.push(target.fileScopedBody);
        return parts.join('\n\n');
      };

      // For approve, only post to the currently viewed PR.
      // For comment with no targets but a general comment, create a minimal target.
      let targets = plan.targets;
      if (action === 'approve' || (targets.length === 0 && generalComment?.trim())) {
        const currentTarget = plan.targets.find(t => t.prUrl === prMetadata?.url);
        targets = currentTarget ? [currentTarget] : [{
          prUrl: prMetadata?.url ?? '',
          prNumber: prMetadata ? (prMetadata.platform === 'github' ? prMetadata.number : prMetadata.iid) : 0,
          prTitle: prMetadata?.title ?? '',
          prRepo: prMetadata ? getDisplayRepo(prMetadata) : '',
          fileComments: [], fileScopedBody: '',
          fileCount: 0, annotationCount: 0, status: 'pending' as const,
        }];
      }

      const openUrls: string[] = [];
      const results = await Promise.allSettled(
        targets.map(async (target): Promise<SubmissionTarget> => {
          if (target.status === 'success') return target;
          try {
            const prRes = await fetch('/api/pr-action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action,
                body: bodyForTarget(target),
                fileComments: target.fileComments,
                targetPrUrl: target.prUrl || undefined,
              }),
            });
            const prData = await prRes.json() as { ok?: boolean; prUrl?: string; error?: string };
            if (!prRes.ok || prData.error) {
              return { ...target, status: 'failed', error: prData.error ?? 'Failed to submit' };
            }
            if (prData.prUrl) openUrls.push(prData.prUrl);
            return { ...target, status: 'success' };
          } catch (err) {
            return { ...target, status: 'failed', error: err instanceof Error ? err.message : 'Network error' };
          }
        }),
      );
      const updatedTargets = results.map((r, i) => r.status === 'fulfilled' ? r.value : { ...targets[i], status: 'failed' as const, error: 'Unexpected error' });
      const allOk = updatedTargets.every(t => t.status === 'success');

      if (!allOk) {
        setPlatformCommentDialog(prev => prev ? {
          ...prev,
          plan: { ...plan, targets: updatedTargets },
        } : null);
        return;
      }

      setPlatformCommentDialog(null);
      setSubmitted(action === 'approve' ? 'approved' : 'feedback');

      if (platformOpenPR) {
        for (const url of openUrls) window.open(url, '_blank');
      }

      const agentSwitchSettings = getAgentSwitchSettings();
      const effectiveAgent = getEffectiveAgentName(agentSwitchSettings);
      const prLinks = openUrls.join(', ');
      const statusMessage = action === 'approve'
        ? `${mrLabel === 'MR' ? 'Merge request' : 'Pull request'} approved on ${platformLabel}${prLinks ? ': ' + prLinks : ''}`
        : `${mrLabel === 'MR' ? 'Merge request' : 'Pull request'} reviewed on ${platformLabel}${prLinks ? ': ' + prLinks : ''}`;
      fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          approved: false,
          feedback: statusMessage,
          annotations: [],
          ...(effectiveAgent && { agentSwitch: effectiveAgent }),
        }),
      }).catch(() => {});
    } catch (err) {
      setPlatformActionError(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setIsPlatformActioning(false);
    }
  }, [platformOpenPR, platformLabel, mrLabel, prMetadata]);

  const openPlatformDialog = useCallback((action: 'approve' | 'comment') => {
    const diffPaths = new Set(files.map(f => f.path));
    const prMeta = prMetadata ? {
      number: prMetadata.platform === 'github' ? prMetadata.number : prMetadata.iid,
      title: prMetadata.title,
      repo: getDisplayRepo(prMetadata),
    } : undefined;
    const plan = buildReviewSubmission(allAnnotations, editorAnnotations, prMetadata?.url, diffPaths, prMeta);
    setPlatformGeneralComment('');
    setPlatformCommentDialog({ action, plan });
  }, [allAnnotations, editorAnnotations, files, prMetadata]);

  // Double-tap Option/Alt to toggle review destination (PR mode only)
  useEffect(() => {
    if (!prMetadata) return;
    let lastAltUp = 0;
    const DOUBLE_TAP_WINDOW = 300;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || e.repeat) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      const now = Date.now();
      if (now - lastAltUp < DOUBLE_TAP_WINDOW) {
        setReviewDestination(prev => {
          const next = prev === 'platform' ? 'agent' : 'platform';
          storage.setItem('plannotator-review-dest', next);
          setPlatformActionError(null);
          return next;
        });
        lastAltUp = 0;
      } else {
        lastAltUp = now;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [prMetadata]);

  // Cmd/Ctrl+Enter keyboard shortcut to approve or send feedback
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;

      // If the platform post dialog is open, Cmd+Enter submits it
      if (platformCommentDialog) {
        if (submitted || isPlatformActioning) return;
        const isApproveAction = platformCommentDialog.action === 'approve';
        const hasTargets = platformCommentDialog.plan.targets.length > 0;
        const canSubmit = isApproveAction || hasTargets || platformGeneralComment.trim();
        if (!canSubmit) return;
        e.preventDefault();
        handlePlatformAction(platformCommentDialog.action, platformCommentDialog.plan, platformGeneralComment);
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (showExportModal || showNoAnnotationsDialog || showApproveWarning || showExitWarning) return;
      if (submitted || isSendingFeedback || isApproving || isExiting || isPlatformActioning) return;
      if (!origin) return; // Demo mode

      e.preventDefault();

      if (platformMode) {
        // GitHub mode: No annotations → Approve on GitHub, otherwise → Post Review
        const isOwnPR = !!platformUser && prMetadata?.author === platformUser;
        if (totalAnnotationCount === 0 && !isOwnPR) {
          openPlatformDialog('approve');
        } else {
          openPlatformDialog('comment');
        }
      } else {
        // Agent mode: No annotations → Approve, otherwise → Send Feedback
        if (totalAnnotationCount === 0) {
          handleApprove();
        } else {
          handleSendFeedback();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    showExportModal, showNoAnnotationsDialog, showApproveWarning, showExitWarning,
    platformCommentDialog, platformGeneralComment,
    submitted, isSendingFeedback, isApproving, isExiting, isPlatformActioning,
    origin, platformMode, platformLabel, platformUser, prMetadata, totalAnnotationCount, openPlatformDialog,
    handleApprove, handleSendFeedback, handlePlatformAction
  ]);

  if (isLoading) {
    return (
      <ThemeProvider defaultTheme="dark">
        <div className="h-screen flex items-center justify-center bg-background">
          <div className="text-muted-foreground text-sm">Loading diff...</div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <ReviewStateProvider value={reviewStateValue}>
      <JobLogsProvider value={jobLogsValue}>
      {isSwitchingPRScope && <PRSwitchOverlay />}
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        {/* Header */}
        <header className="py-1 flex items-center justify-between px-2 md:px-4 border-b border-border/50 bg-card/50 backdrop-blur-xl z-50">
          <div className="min-w-0 flex items-center gap-2 md:gap-3">
            {prMetadata ? (
              <div className="min-w-0 flex items-center gap-2 md:gap-3">
                {(gitContext || agentCwd) && (
                  <button
                    onClick={() => setShowWorktreeDialog(true)}
                    className="text-[10px] font-medium text-primary/80 bg-primary/10 hover:bg-primary/20 px-1.5 py-0.5 rounded transition-colors cursor-pointer"
                  >
                    worktree
                  </button>
                )}
                <span
                  className="text-xs text-muted-foreground/60 inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <RepoIcon className="w-3 h-3 flex-shrink-0" />
                  {displayRepo}
                </span>
                <PRSelector
                  mrNumberLabel={mrNumberLabel}
                  prTitle={prMetadata.title}
                  currentNumber={prMetadata.platform === 'github' ? prMetadata.number : prMetadata.iid}
                  onSelect={handlePRSwitch}
                  disabled={isSwitchingPRScope}
                />
                <StackedPRLabel
                  metadata={prMetadata}
                  mrNumberLabel={mrNumberLabel}
                  stackInfo={prStackInfo}
                  stackTree={prStackTree}
                  scope={prDiffScope}
                  scopeOptions={prDiffScopeOptions}
                  isSwitchingScope={isSwitchingPRScope}
                  onSelectScope={handlePRDiffScopeSelect}
                  onNavigatePR={handlePRSwitch}
                />
                <div className="hidden md:flex items-center gap-0.5 ml-1">
                  <button onClick={() => handleOpenPRPanel('summary')} className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/30 transition-colors duration-150" title="PR Summary">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                  </button>
                  <button onClick={() => handleOpenPRPanel('comments')} className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/30 transition-colors duration-150" title="PR Comments">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                  </button>
                  <button onClick={() => handleOpenPRPanel('checks')} className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/30 transition-colors duration-150" title="PR Checks">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </button>
                </div>
              </div>
            ) : repoInfo ? (
              <div className="min-w-0 flex items-center gap-2 md:gap-3">
                {repoInfo.branch && (
                  <span
                    className="text-xs font-mono text-foreground truncate"
                    title={repoInfo.branch}
                  >
                    {repoInfo.branch}
                  </span>
                )}
                <span
                  className="text-xs text-muted-foreground/60 inline-flex items-center gap-1 truncate max-w-[220px]"
                  title={repoInfo.display}
                >
                  <RepoIcon className="w-3 h-3 flex-shrink-0" />
                  {repoInfo.display}
                </span>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground/70">Review</span>
            )}
          </div>

          <div className="flex items-center gap-1 md:gap-2">
            {/* Diff style toggle */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
              <button
                onClick={() => handleDiffStyleChange('split')}
                className={`px-2 py-1 text-xs rounded-md transition-colors ${
                  diffStyle === 'split'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Split
              </button>
              <button
                onClick={() => handleDiffStyleChange('unified')}
                className={`px-2 py-1 text-xs rounded-md transition-colors ${
                  diffStyle === 'unified'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Unified
              </button>
            </div>

            {origin ? (
              <>
                {/* Destination dropdown (PR mode only) */}
                {prMetadata && (
                  <div className="relative">
                    <button
                      onClick={() => setShowDestinationMenu(prev => !prev)}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
                      title={reviewDestination === 'platform' ? `Posting to ${platformLabel} ${mrLabel}` : 'Sending to agent session'}
                    >
                      {reviewDestination === 'platform' ? (
                        <>
                          {prMetadata?.platform === 'gitlab' ? <GitLabIcon className="w-3.5 h-3.5" /> : <GitHubIcon className="w-3.5 h-3.5" />}
                          <span>{platformLabel}</span>
                        </>
                      ) : 'Agent'}
                      <svg className="w-3 h-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {showDestinationMenu && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowDestinationMenu(false)} />
                        <div className="absolute right-0 top-full mt-1 py-1 bg-popover border border-border rounded-lg shadow-xl z-50 min-w-[160px]">
                          <button
                            onClick={() => {
                              setReviewDestination('platform');
                              storage.setItem('plannotator-review-dest', 'platform');
                              setShowDestinationMenu(false);
                              setPlatformActionError(null);
                            }}
                            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                              reviewDestination === 'platform'
                                ? 'text-foreground bg-muted/50'
                                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                            }`}
                          >
                            <div className="font-medium">{platformLabel}</div>
                            <div className="text-muted-foreground/60">Post to {mrLabel}</div>
                          </button>
                          <button
                            onClick={() => {
                              setReviewDestination('agent');
                              storage.setItem('plannotator-review-dest', 'agent');
                              setShowDestinationMenu(false);
                              setPlatformActionError(null);
                            }}
                            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                              reviewDestination === 'agent'
                                ? 'text-foreground bg-muted/50'
                                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                            }`}
                          >
                            <div className="font-medium">Agent</div>
                            <div className="text-muted-foreground/60">Send to session</div>
                          </button>
                          <div className="border-t border-border/50 mt-1 pt-1 px-3 py-1">
                            <span className="text-[10px] text-muted-foreground/40">
                              <kbd className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded bg-muted border border-border/60 border-b-[2px] text-[9px] font-mono leading-none text-foreground/60 shadow-sm">{altKey}</kbd>
                              <kbd className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded bg-muted border border-border/60 border-b-[2px] text-[9px] font-mono leading-none text-foreground/60 shadow-sm ml-0.5">{altKey}</kbd>
                              <span className="ml-1.5">to toggle</span>
                            </span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* GitHub error message */}
                {platformActionError && (
                  <div
                    className="text-xs text-destructive px-2 py-1 bg-destructive/10 rounded border border-destructive/20 max-w-[200px] truncate"
                    title={platformActionError}
                  >
                    {platformActionError}
                  </div>
                )}

                {/* Agent mode: Close/SendFeedback flip + Approve */}
                {!platformMode ? (
                  <AgentReviewActions
                    totalAnnotationCount={totalAnnotationCount}
                    isSendingFeedback={isSendingFeedback}
                    isApproving={isApproving}
                    isExiting={isExiting}
                    onSendFeedback={handleSendFeedback}
                    onApprove={() => totalAnnotationCount > 0 ? setShowApproveWarning(true) : handleApprove()}
                    onExit={() => totalAnnotationCount > 0 ? setShowExitWarning(true) : handleExit()}
                  />
                ) : (
                  <>
                    {/* Platform mode: Close + Post Comments + Approve */}
                    <ExitButton
                      onClick={() => totalAnnotationCount > 0 ? setShowExitWarning(true) : handleExit()}
                      disabled={isSendingFeedback || isApproving || isExiting || isPlatformActioning}
                      isLoading={isExiting}
                    />
                    <FeedbackButton
                      onClick={() => openPlatformDialog('comment')}
                      disabled={isSendingFeedback || isApproving || isPlatformActioning}
                      isLoading={isSendingFeedback || isPlatformActioning}
                      label="Post Comments"
                      shortLabel="Post"
                      loadingLabel="Posting..."
                      shortLoadingLabel="Posting..."
                      title="Post review to platform"
                    />
                    <div className="relative group/approve">
                      <ApproveButton
                        onClick={() => {
                          if (platformUser && prMetadata?.author === platformUser) return;
                          openPlatformDialog('approve');
                        }}
                        disabled={
                          isSendingFeedback || isApproving || isPlatformActioning ||
                          (!!platformUser && prMetadata?.author === platformUser)
                        }
                        isLoading={isApproving}
                        muted={!!platformUser && prMetadata?.author === platformUser && !isSendingFeedback && !isApproving && !isPlatformActioning}
                        title={
                          platformUser && prMetadata?.author === platformUser
                            ? `You can't approve your own ${mrLabel}`
                            : "Approve - no changes needed"
                        }
                      />
                      {platformUser && prMetadata?.author === platformUser && (
                        <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-48 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
                          <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
                          <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
                          You can't approve your own {mrLabel === 'MR' ? 'merge request' : 'pull request'} on {platformLabel}.
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            ) : (
              <button
                onClick={handleCopyFeedback}
                className="px-2 py-1 md:px-2.5 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors flex items-center gap-1.5"
                title="Copy feedback for LLM"
              >
                {copyFeedback === 'Feedback copied!' ? (
                  <>
                    <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="hidden md:inline">Copied!</span>
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="hidden md:inline">Copy Feedback</span>
                  </>
                )}
              </button>
            )}

            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />

            {/* Utilities */}
            <ReviewHeaderMenu
              isPanelOpen={isPanelOpen}
              annotationCount={totalAnnotationCount}
              onTogglePanel={() => setIsPanelOpen(!isPanelOpen)}
              onOpenSettings={() => setOpenSettingsMenu(true)}
              onOpenExport={() => setShowExportModal(true)}
              appVersion={appVersion}
            />
          </div>
        </header>

        {/* Main content */}
        <div className={`flex-1 flex overflow-hidden ${isResizing ? 'select-none' : ''}`}>
          {/* Left sidebar stays mounted whenever it provides navigation or context. */}
          {shouldShowFileTree && (
            <>
              <FileTree
                files={files}
                activeFileIndex={activeFileIndex}
                onSelectFile={handleFilePreview}
                onDoubleClickFile={handleFilePinned}
                annotations={allAnnotations}
                viewedFiles={viewedFiles}
                onToggleViewed={handleToggleViewed}
                hideViewedFiles={hideViewedFiles}
                onToggleHideViewed={() => setHideViewedFiles(prev => !prev)}
                enableKeyboardNav={!showExportModal && hasSearchableFiles}
                diffOptions={gitContext?.diffOptions}
                activeDiffType={activeDiffBase}
                onSelectDiff={handleDiffSwitch}
                isLoadingDiff={isLoadingDiff}
                width={fileTreeResize.width}
                worktrees={gitContext?.worktrees}
                activeWorktreePath={activeWorktreePath}
                onSelectWorktree={handleWorktreeSwitch}
                currentBranch={gitContext?.currentBranch}
                availableBranches={prMetadata ? undefined : gitContext?.availableBranches}
                selectedBase={prMetadata ? undefined : selectedBase ?? undefined}
                detectedBase={prMetadata ? undefined : gitContext?.defaultBranch}
                onSelectBase={prMetadata ? undefined : handleBaseSelect}
                stagedFiles={stagedFiles}
                onCopyRawDiff={handleCopyDiff}
                canCopyRawDiff={!!diffData?.rawPatch}
                copyRawDiffStatus={copyRawDiffStatus}
                searchQuery={hasSearchableFiles ? searchQuery : ''}
                isSearchOpen={hasSearchableFiles ? isSearchOpen : false}
                isSearchPending={isSearchPending}
                searchInputRef={hasSearchableFiles ? searchInputRef : undefined}
                onOpenSearch={hasSearchableFiles ? openSearch : undefined}
                onSearchChange={hasSearchableFiles ? handleSearchInputChange : undefined}
                onSearchClear={hasSearchableFiles ? clearSearch : undefined}
                onSearchClose={hasSearchableFiles ? closeSearch : undefined}
                searchGroups={hasSearchableFiles ? searchGroups : []}
                searchMatches={hasSearchableFiles ? searchMatches : []}
                activeSearchMatchId={hasSearchableFiles ? activeSearchMatchId : null}
                onSelectSearchMatch={hasSearchableFiles ? handleSelectSearchMatch : undefined}
                onStepSearchMatch={hasSearchableFiles ? stepSearchMatch : undefined}
              />
              <ResizeHandle {...fileTreeResize.handleProps} side="left" />
            </>
          )}

          {/* Center dock area */}
          <div className="flex-1 min-w-0 overflow-hidden relative">
            <ConfirmDialog
              isOpen={!!draftBanner}
              onClose={dismissDraft}
              onConfirm={handleRestoreDraft}
              title="Draft Recovered"
              message={draftBanner ? (() => {
                const parts: string[] = [];
                if (draftBanner.count > 0) parts.push(`${draftBanner.count} annotation${draftBanner.count !== 1 ? 's' : ''}`);
                if (draftBanner.viewedCount > 0) parts.push(`${draftBanner.viewedCount} viewed file${draftBanner.viewedCount !== 1 ? 's' : ''}`);
                return `Found ${parts.join(' and ')} from ${draftBanner.timeAgo}. Would you like to restore them?`;
              })() : ''}
              confirmText="Restore"
              cancelText="Dismiss"
              showCancel
            />
            {files.length > 0 ? (
              <DockviewReact
                className={`h-full ${resolvedMode === 'light' ? 'dockview-theme-light' : 'dockview-theme-dark'}`}
                components={reviewPanelComponents}
                defaultTabComponent={ReviewDockTabRenderer}
                onReady={handleDockReady}
                disableFloatingGroups
              />
            ) : (
              <div className="h-full flex items-center justify-center">
                <div className="text-center space-y-3 max-w-md px-8">
                  <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center ${diffError ? 'bg-destructive/10' : 'bg-muted/50'}`}>
                    {diffError ? (
                      <svg className="w-6 h-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                      </svg>
                    ) : (
                      <svg className="w-6 h-6 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                      </svg>
                    )}
                  </div>
                  <div>
                    {diffError ? (
                      <>
                        <h3 className="text-sm font-medium text-destructive">Failed to load diff</h3>
                        <p className="text-xs text-muted-foreground mt-1 max-w-sm break-words line-clamp-3">{diffError}</p>
                      </>
                    ) : (
                      <>
                        <h3 className="text-sm font-medium text-foreground">No changes</h3>
                        <p className="text-xs text-muted-foreground mt-1">
                          {activeDiffBase === 'uncommitted' && `No uncommitted changes${activeWorktreePath ? ' in this worktree' : ' to review'}.`}
                          {activeDiffBase === 'staged' && "No staged changes. Stage some files with git add."}
                          {activeDiffBase === 'unstaged' && "No unstaged changes. All changes are staged."}
                          {activeDiffBase === 'last-commit' && `No changes in the last commit${activeWorktreePath ? ' in this worktree' : ''}.`}
                          {activeDiffBase === 'branch' && `No changes vs ${selectedBase || gitContext?.defaultBranch || 'main'}${activeWorktreePath ? ' in this worktree' : ''}.`}
                          {activeDiffBase === 'merge-base' && `No changes vs ${selectedBase || gitContext?.defaultBranch || 'main'}${activeWorktreePath ? ' in this worktree' : ''}.`}
                          {activeDiffBase === 'all' && `No tracked files${activeWorktreePath ? ' in this worktree' : ' in this repository'}.`}
                        </p>
                      </>
                    )}
                  </div>
                  {gitContext?.diffOptions && gitContext.diffOptions.length > 1 && (
                    <p className="text-xs text-muted-foreground/60">
                      Try selecting a different view from the dropdown.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Resize Handle */}
          {isPanelOpen && <ResizeHandle {...panelResize.handleProps} side="right" />}

          {/* Annotations panel */}
          <ReviewSidebar
            isOpen={isPanelOpen}
            onToggle={() => setIsPanelOpen(!isPanelOpen)}
            annotations={allAnnotations}
            files={files}
            selectedAnnotationId={selectedAnnotationId}
            onSelectAnnotation={handleSelectAnnotation}
            onDeleteAnnotation={handleDeleteAnnotation}
            feedbackMarkdown={feedbackMarkdown}
            width={panelResize.width}
            editorAnnotations={editorAnnotations}
            onDeleteEditorAnnotation={deleteEditorAnnotation}
            prMetadata={prMetadata}
            aiAvailable={aiAvailable}
            aiMessages={aiChat.messages}
            isAICreatingSession={aiChat.isCreatingSession}
            isAIStreaming={aiChat.isStreaming}
            onScrollToAILines={handleScrollToAILines}
            activeTabOverride={sidebarTabOverride}
            onTabChange={() => setSidebarTabOverride(undefined)}
            activeFilePath={files[activeFileIndex]?.path}
            scrollToQuestionId={scrollToQuestionId}
            onAskGeneral={handleAskGeneral}
            aiPermissionRequests={aiChat.permissionRequests}
            onRespondToPermission={aiChat.respondToPermission}
            aiProviders={aiProviders}
            aiConfig={aiConfig}
            onAIConfigChange={handleAIConfigChange}
            hasAISession={!!aiChat.sessionId}
            agentJobs={agentJobs.jobs}
            agentCapabilities={agentJobs.capabilities}
            onAgentLaunch={agentJobs.launchJob}
            onAgentKillJob={agentJobs.killJob}
            onAgentKillAll={agentJobs.killAll}
            externalAnnotations={externalAnnotations}
            onOpenJobDetail={handleOpenJobDetail}
            onOpenPRPanel={handleOpenPRPanel}
          />
        </div>

        {/* Export Modal */}
        {showExportModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
            <div className="bg-card border border-border rounded-xl w-full max-w-2xl flex flex-col max-h-[80vh] shadow-2xl">
              <div className="p-4 border-b border-border flex justify-between items-center">
                <h3 className="font-semibold text-sm">Export Review Feedback</h3>
                <button
                  onClick={() => setShowExportModal(false)}
                  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <div className="text-xs text-muted-foreground mb-2">
                  {allAnnotations.length} annotation{allAnnotations.length !== 1 ? 's' : ''}
                </div>
                <pre className="export-code-block whitespace-pre-wrap">
                  {feedbackMarkdown}
                </pre>
              </div>
              <div className="p-4 border-t border-border flex justify-end gap-2">
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(feedbackMarkdown);
                  }}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-colors"
                >
                  Copy to Clipboard
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="hidden" aria-hidden="true">
          <Settings
            taterMode={false}
            onTaterModeChange={() => {}}
            onIdentityChange={handleIdentityChange}
            origin={origin}
            mode="review"
            aiProviders={aiProviders}
            gitUser={gitUser}
            externalOpen={openSettingsMenu}
            onExternalClose={() => setOpenSettingsMenu(false)}
          />
        </div>

        {/* Worktree info dialog */}
        {(gitContext?.cwd || agentCwd) && prMetadata && (
          <ConfirmDialog
            isOpen={showWorktreeDialog}
            onClose={() => setShowWorktreeDialog(false)}
            title="Local Worktree"
            wide
            message={
              <div className="space-y-3">
                <p>This PR is checked out locally so review agents have full file access.</p>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">Path</span>
                  <button
                    onClick={() => navigator.clipboard.writeText((agentCwd || gitContext?.cwd)!)}
                    className="mt-1 w-full text-left font-mono text-xs bg-muted/50 border border-border/50 rounded-md px-3 py-2 text-foreground hover:bg-muted transition-colors cursor-pointer break-all"
                    title="Click to copy"
                  >
                    {agentCwd || gitContext?.cwd}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground/60">Automatically removed when this review session ends.</p>
              </div>
            }
            variant="info"
          />
        )}

        {/* No annotations dialog */}
        <ConfirmDialog
          isOpen={showNoAnnotationsDialog}
          onClose={() => setShowNoAnnotationsDialog(false)}
          title="No Annotations"
          message="You haven't made any annotations yet. There's nothing to copy."
          variant="info"
        />

        {/* Approve with annotations warning */}
        <ConfirmDialog
          isOpen={showApproveWarning}
          onClose={() => setShowApproveWarning(false)}
          onConfirm={() => {
            setShowApproveWarning(false);
            handleApprove();
          }}
          title="Annotations Won't Be Sent"
          message={<>You have {totalAnnotationCount} annotation{totalAnnotationCount !== 1 ? 's' : ''} that will be lost if you approve.</>}
          subMessage="To send your feedback, use Send Feedback instead."
          confirmText="Approve Anyway"
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        <ConfirmDialog
          isOpen={showExitWarning}
          onClose={() => setShowExitWarning(false)}
          onConfirm={() => {
            setShowExitWarning(false);
            handleExit();
          }}
          title="Annotations Won't Be Sent"
          message={<>You have {totalAnnotationCount} annotation{totalAnnotationCount !== 1 ? 's' : ''} that will be lost if you close.</>}
          subMessage="To send your feedback, use Send Feedback instead."
          confirmText="Close Anyway"
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* AI setup dialog — first-run only */}
        <AISetupDialog
          isOpen={showAISetup}
          providers={aiProviders}
          onComplete={(providerId) => {
            setShowAISetup(false);
            handleAIConfigChange({ providerId });
          }}
        />

        {/* Diff type setup dialog — first-run only */}
        {showDiffTypeSetup && (
          <DiffTypeSetupDialog
            onComplete={(selected) => {
              setShowDiffTypeSetup(false);
              if (selected !== diffType) handleDiffSwitch(selected);
            }}
          />
        )}

        {/* Completion overlay - shown after approve/feedback/exit */}
        <CompletionOverlay
          submitted={submitted}
          title={
            submitted === 'approved' ? 'Changes Approved'
            : submitted === 'exited' ? 'Session Closed'
            : 'Feedback Sent'
          }
          subtitle={
            submitted === 'exited'
              ? 'Review session closed without feedback.'
              : platformMode
                ? submitted === 'approved'
                  ? `Your approval was submitted to ${platformLabel}.`
                  : `Your feedback was submitted to ${platformLabel}.`
                : submitted === 'approved'
                  ? `${getAgentName(origin)} will proceed with the changes.`
                  : `${getAgentName(origin)} will address your review feedback.`
          }
          agentLabel={getAgentName(origin)}
        />

        {/* Update notification */}
        <UpdateBanner origin={origin} isWSL={isWSL} />

        {/* GitHub general comment dialog */}
        <ReviewSubmissionDialog
          isOpen={!!platformCommentDialog}
          action={platformCommentDialog?.action ?? 'comment'}
          submission={platformCommentDialog?.plan ?? { targets: [], orphans: [] }}
          generalComment={platformGeneralComment}
          onGeneralCommentChange={setPlatformGeneralComment}
          platformOpenPR={platformOpenPR}
          onPlatformOpenPRChange={(checked) => {
            setPlatformOpenPR(checked);
            storage.setItem('plannotator-platform-open-pr', String(checked));
          }}
          onConfirm={() => {
            if (!platformCommentDialog) return;
            handlePlatformAction(platformCommentDialog.action, platformCommentDialog.plan, platformGeneralComment);
          }}
          onCancel={() => setPlatformCommentDialog(null)}
          isSubmitting={isPlatformActioning}
          mrLabel={mrLabel}
          platformLabel={platformLabel}
        />
      </div>

      {/* Tour dialog overlay */}
      <TourDialog jobId={tourDialogJobId} onClose={() => setTourDialogJobId(null)} />

      {/* Dev-only: open a fully-formed demo tour without running the agent.
          Stripped from production builds via import.meta.env.DEV. */}
      {import.meta.env.DEV && (
        <button
          onClick={() => setTourDialogJobId(tourDialogJobId === DEMO_TOUR_ID ? null : DEMO_TOUR_ID)}
          title="Open the demo tour (dev only). Cmd+Shift+T also works."
          className="fixed bottom-3 right-3 z-[60] px-2.5 py-1 rounded-md bg-foreground/80 text-background text-[10px] font-mono uppercase tracking-wider shadow-lg hover:bg-foreground transition-colors"
        >
          {tourDialogJobId === DEMO_TOUR_ID ? 'Close tour' : 'Demo tour'}
        </button>
      )}

    </JobLogsProvider>
    </ReviewStateProvider>
    </TooltipProvider>
    </ThemeProvider>
  );
};

export default ReviewApp;
