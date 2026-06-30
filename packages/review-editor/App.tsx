import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { type Origin, getAgentName } from '@plannotator/shared/agents';
import { ThemeProvider, useTheme } from '@plannotator/ui/components/ThemeProvider';
import { TooltipProvider } from '@plannotator/ui/components/Tooltip';
import { ConfirmDialog } from '@plannotator/ui/components/ConfirmDialog';
import { Settings } from '@plannotator/ui/components/Settings';
import { FeedbackButton, ApproveButton, ExitButton } from '@plannotator/ui/components/ToolbarButtons';
import { AgentReviewActions } from './components/AgentReviewActions';
import { DiffOptionsPopover } from './components/DiffOptionsPopover';
import { useUpdateCheck } from '@plannotator/ui/hooks/useUpdateCheck';
import { storage } from '@plannotator/ui/utils/storage';
import { CompletionOverlay } from '@plannotator/ui/components/CompletionOverlay';
import { GitHubIcon } from '@plannotator/ui/components/GitHubIcon';
import { GitLabIcon } from '@plannotator/ui/components/GitLabIcon';
import { RepoIcon } from '@plannotator/ui/components/RepoIcon';
import { PullRequestIcon } from '@plannotator/ui/components/PullRequestIcon';
import { getPlatformLabel, getMRLabel, getMRNumberLabel, getDisplayRepo } from '@plannotator/shared/pr-types';
import type { SemanticDiffAdvert } from '@plannotator/shared/semantic-diff-types';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { loadDiffFont } from '@plannotator/ui/utils/diffFonts';
import { getAgentSwitchSettings, getEffectiveAgentName } from '@plannotator/ui/utils/agentSwitch';
import { useAIProviderConfig } from '@plannotator/ui/hooks/useAIProviderConfig';
import { DiffTypeSetupDialog } from '@plannotator/ui/components/DiffTypeSetupDialog';
import { needsDiffTypeSetup } from '@plannotator/ui/utils/diffTypeSetup';
import { LookAndFeelAnnouncementDialog } from '@plannotator/ui/components/LookAndFeelAnnouncementDialog';
import {
  markLookAndFeelAnnouncementSeen,
  needsLookAndFeelAnnouncement,
} from '@plannotator/ui/utils/lookAndFeelAnnouncement';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, TokenAnnotationMeta, ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import { useResizablePanel } from '@plannotator/ui/hooks/useResizablePanel';
import { useCodeAnnotationDraft } from '@plannotator/ui/hooks/useCodeAnnotationDraft';
import { useGitAdd } from './hooks/useGitAdd';
import { generateId } from './utils/generateId';
import { useAIChat } from './hooks/useAIChat';
import { toast, Toaster } from 'sonner';
import { useCodeNav, type CodeNavRequest } from './hooks/useCodeNav';
import { extractLinesFromPatch } from './utils/patchParser';
import { isTypingTarget, useReviewSearch, type ReviewSearchMatch } from './hooks/useReviewSearch';
import { useEditorAnnotations } from '@plannotator/ui/hooks/useEditorAnnotations';
import { useExternalAnnotations } from '@plannotator/ui/hooks/useExternalAnnotations';
import { useAgentJobs } from '@plannotator/ui/hooks/useAgentJobs';
import { exportEditorAnnotations } from '@plannotator/ui/utils/parser';
import { buildReviewAgentInstructions } from '@plannotator/ui/utils/reviewAgentInstructions';
import { ResizeHandle } from '@plannotator/ui/components/ResizeHandle';
import { FolderTree } from 'lucide-react';
import { DockviewReact, type DockviewReadyEvent, type DockviewApi } from 'dockview-react';
import { ReviewHeaderMenu } from './components/ReviewHeaderMenu';
import { ReviewSidebar } from './components/ReviewSidebar';
import type { ReviewSidebarTab } from './components/ReviewSidebar';
import { SparklesIcon } from '@plannotator/ui/components/SparklesIcon';
import { ReviewAgentsIcon } from '@plannotator/ui/components/ReviewAgentsIcon';
import { useSidebar } from '@plannotator/ui/hooks/useSidebar';
import { FileTree } from './components/FileTree';
import { StackedPRLabel } from './components/StackedPRLabel';
import { PRSelector } from './components/PRSelector';
import { PRSwitchOverlay } from './components/PRSwitchOverlay';
import { usePRStack } from './hooks/usePRStack';
import { useDiffFreshness } from './hooks/useDiffFreshness';
import { usePRSession, type PRSessionUpdate } from './hooks/usePRSession';
import { useAnnotationFactory } from './hooks/useAnnotationFactory';
import { DEMO_DIFF } from './demoData';
import { exportReviewFeedback } from './utils/exportFeedback';
import { parseDiffToFiles } from './utils/diffParser';
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
  REVIEW_SEMANTIC_DIFF_PANEL_ID,
  REVIEW_ALL_FILES_PANEL_ID,
  REVIEW_CODE_NAV_PANEL_ID,
} from './dock/reviewPanelTypes';
import type { DiffFile, AnnotationScrollTarget } from './types';
import { annotationMatchesPrScope } from './utils/annotationScope';
import type { DiffOption, WorktreeInfo, GitContext } from '@plannotator/shared/types';
import type { PRMetadata } from '@plannotator/shared/pr-types';
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
  /** Server-built "changes under review" description for Ask AI (current view). */
  aiReviewContext?: string;
  gitContext?: GitContext;
  diffOptions?: DiffOption[];
  sharingEnabled?: boolean;
  prStackInfo?: PRStackInfo | null;
  prDiffScope?: PRDiffScope;
  prDiffScopeOptions?: PRDiffScopeOption[];
  semanticDiff?: SemanticDiffAdvert;
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
  // Sidebar-initiated "scroll to this comment" signal. The token bumps on every
  // sidebar click so re-selecting the same comment re-navigates. Selecting a
  // comment in the diff sets selectedAnnotationId but NOT this — so it never
  // moves the viewport.
  const [scrollTargetAnnotation, setScrollTargetAnnotation] = useState<AnnotationScrollTarget | null>(null);
  const [isAllFilesActive, setIsAllFilesActive] = useState(false);
  // Mirror ref: handlers captured by Pierre slot portals (which only republish
  // on item version bumps) and early-declared callbacks read the CURRENT value
  // at call time instead of a stale closure capture.
  const isAllFilesActiveRef = useRef(isAllFilesActive);
  isAllFilesActiveRef.current = isAllFilesActive;
  const [isSemanticDiffActive, setIsSemanticDiffActive] = useState(false);
  const [semanticDiffAvailable, setSemanticDiffAvailable] = useState(false);
  const [isDiffPanelActive, setIsDiffPanelActive] = useState(false);
  const [allFilesVisibleFile, setAllFilesVisibleFile] = useState<string | null>(null);
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
  const diffExpandUnchanged = useConfigValue('diffExpandUnchanged');
  const diffFontFamily = useConfigValue('diffFontFamily');
  const diffFontSize = useConfigValue('diffFontSize');
  const diffTabSize = useConfigValue('diffTabSize');
  // Global plan-look preference; surfaced here only by the shared 0.20.0
  // look-and-feel announcement (the grid/clean chooser applies to plan review).
  const gridEnabled = useConfigValue('gridEnabled');

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
    document.documentElement.style.setProperty('--diffs-tab-size', String(diffTabSize));
  }, [diffFontFamily, diffFontSize, diffTabSize]);

  const reviewSidebar = useSidebar<ReviewSidebarTab>(true, 'annotations');
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [copyRawDiffStatus, setCopyRawDiffStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [hideViewedFiles, setHideViewedFiles] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [gitUser, setGitUser] = useState<string | undefined>();
  const [isWSL, setIsWSL] = useState(false);
  const [reviewMode, setReviewMode] = useState<string | null>(null);
  const [diffType, setDiffType] = useState<string>('uncommitted');
  const [gitContext, setGitContext] = useState<GitContext | null>(null);
  const [workspaceDiffOptions, setWorkspaceDiffOptions] = useState<DiffOption[] | null>(null);
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

  const { prMetadata, prStackInfo, prStackTree, prDiffScope, prDiffScopeOptions, prPatchIncomplete, prPatchUpgradeAvailable, updatePRSession } = usePRSession();
  const { withPRContext } = useAnnotationFactory(prMetadata, prStackInfo ? prDiffScope : undefined);

  const prStackCallbacksRef = useRef<import('./hooks/usePRStack').PRStackCallbacks | null>(null);
  const {
    isSwitchingPRScope,
    isLoadingFullDiff,
    handleScopeSelect: handlePRDiffScopeSelect,
    handleLoadFullDiff,
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
  const updateInfo = useUpdateCheck();
  const updateToastShown = useRef(false);
  useEffect(() => {
    if (updateInfo?.updateAvailable && !updateInfo.dismissed && !updateToastShown.current) {
      updateToastShown.current = true;
      const t = setTimeout(() => {
        toast('A new version of Plannotator is available', {
          description: 'Open the Options menu to update.',
          duration: 4000,
          position: 'top-right',
          classNames: { toast: '!w-auto', description: '!text-foreground/70' },
        });
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [updateInfo?.updateAvailable, updateInfo?.dismissed]);

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
  const semanticDiffAutoFallbackPending = useRef(false);

  // PR context (lifted from sidebar so center dock PR panels can access it)
  const { prContext, isLoading: isPRContextLoading, error: prContextError, fetchContext: fetchPRContext } = usePRContext(prMetadata ?? null);

  // Sync activeFileIndex from dockview's active panel (wired in handleDockReady)

  const openDiffFile = useCallback((filePath: string) => {
    const file = files.find(candidate => candidate.path === filePath);
    if (!file) return;
    semanticDiffAutoFallbackPending.current = false;

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
    // Respect the surface the user is in. When the all-files panel is active,
    // reveal IN PLACE — AllFilesCodeView scrolls to + highlights the active
    // match via the activeSearchMatch prop. When a single-file panel is active
    // (or there's no dock yet), open the match's file there instead (legacy
    // behavior). Unconditionally activating the all-files panel here would
    // teleport the user out of their tab just for typing a query (reveal also
    // fires on first-match auto-activation, not only on explicit clicks).
    if (dockApi && isAllFilesActiveRef.current) {
      return;
    }
    openDiffFile(match.filePath);
  }, [dockApi, openDiffFile]);

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
    (reviewMode === 'workspace' && !!workspaceDiffOptions?.length) ||
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
  const { draftBanner, restoreDraft, getDraftGeneration, dismissDraft } = useCodeAnnotationDraft({
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

  // Agent Instructions — copy a clipboard payload teaching external agents
  // (Claude Code, Codex, etc.) how to POST review comments into this session
  // via /api/external-annotations. The instruction body lives in a separate
  // module (utils/reviewAgentInstructions.ts) so it's easy to edit independently.
  const handleCopyAgentInstructions = useCallback(async () => {
    const payload = buildReviewAgentInstructions(window.location.origin);
    try {
      await navigator.clipboard.writeText(payload);
      toast.success('Agent instructions copied');
    } catch {
      toast.error('Failed to copy');
    }
  }, []);

  // AI Chat
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiProviders, setAiProviders] = useState<Array<{ id: string; name: string; capabilities: Record<string, boolean>; models?: Array<{ id: string; label: string; default?: boolean }> }>>([]);
  const [aiDefaultProvider, setAiDefaultProvider] = useState<string | null>(null);
  const { aiConfig, applyConfigChange } = useAIProviderConfig({
    providers: aiProviders,
    defaultProvider: aiDefaultProvider,
    available: aiAvailable,
    origin,
  });
  const [showDiffTypeSetup, setShowDiffTypeSetup] = useState(false);
  const [diffTypeSetupPending, setDiffTypeSetupPending] = useState(false);
  // The 0.20.0 release / look-and-feel announcement also runs in code review.
  // Seen-state is a shared cookie (host-scoped), so dismissing it in either app
  // suppresses it in the other — it appears once across both.
  const [showLookAndFeel, setShowLookAndFeel] = useState(needsLookAndFeelAnnouncement);
  const dismissLookAndFeel = useCallback(() => {
    markLookAndFeelAnnouncementSeen();
    setShowLookAndFeel(false);
  }, []);
  const aiChat = useAIChat({
    patch: diffData?.rawPatch ?? '',
    diffType,
    base: committedBase,
    reviewContext: diffData?.aiReviewContext,
    viewing: {
      scope: isAllFilesActive ? 'all' : 'file',
      filePath: isAllFilesActive ? undefined : files[activeFileIndex]?.path,
    },
    providerId: aiConfig.providerId,
    model: aiConfig.model,
    reasoningEffort: aiConfig.reasoningEffort,
  });
  const {
    messages: aiMessages,
    isCreatingSession: aiIsCreatingSession,
    isStreaming: aiIsStreaming,
    permissionRequests: aiPermissionRequests,
    respondToPermission: respondToAIPermission,
    ask: askAI,
    abort: abortAI,
    resetSession: resetAISession,
    sessionId: aiSessionId,
  } = aiChat;

  const codeNav = useCodeNav();

  const handleCodeNavRequest = useCallback((request: CodeNavRequest) => {
    if (!gitContext && !agentCwd) {
      toast('Code navigation requires a local checkout', {
        description: 'Re-run with --local for PR reviews',
        duration: 4000,
      });
      return;
    }
    codeNav.resolve(request);
    if (!dockApi) return;
    const existing = dockApi.getPanel(REVIEW_CODE_NAV_PANEL_ID);
    if (existing) {
      existing.api.setTitle(`References: ${request.symbol}`);
      existing.api.setActive();
    } else {
      const refPanel = isSemanticDiffActive
        ? REVIEW_SEMANTIC_DIFF_PANEL_ID
        : isAllFilesActive
        ? REVIEW_ALL_FILES_PANEL_ID
        : REVIEW_DIFF_PANEL_ID;
      dockApi.addPanel({
        id: REVIEW_CODE_NAV_PANEL_ID,
        component: REVIEW_PANEL_TYPES.CODE_NAV,
        title: `References: ${request.symbol}`,
        position: { direction: 'below', referencePanel: refPanel },
        initialHeight: 250,
      });
    }
  }, [codeNav.resolve, dockApi, isAllFilesActive, isSemanticDiffActive, gitContext, agentCwd]);

  // Check AI capabilities on mount
  useEffect(() => {
    fetch('/api/ai/capabilities')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.available) {
          setAiAvailable(true);
          const providers = data.providers ?? [];
          setAiProviders(providers);
          setAiDefaultProvider(data.defaultProvider ?? null);
        }
      })
      .catch(() => {});
  }, []);

  // Provider/model/effort selection logic lives in the shared hook above; the
  // app only composes the session reset (the hook can't own it — see the cycle
  // note in useAIProviderConfig).
  const handleAIConfigChange = useCallback((config: { providerId?: string | null; model?: string | null; reasoningEffort?: string | null }) => {
    applyConfigChange(config);
    resetAISession();
  }, [applyConfigChange, resetAISession]);

  // File-aware Ask AI: the all-files surface resolves the owning file itself
  // (its toolbar selection lives in a file the single-file panel may never
  // have focused), so it must NOT go through activeFileIndex.
  const handleAskAIForFile = useCallback((filePath: string, question: string) => {
    if (!pendingSelection) return;
    const file = files.find(f => f.path === filePath);
    if (!file) return;
    const lineStart = Math.min(pendingSelection.start, pendingSelection.end);
    const lineEnd = Math.max(pendingSelection.start, pendingSelection.end);
    const side = pendingSelection.side === 'additions' ? 'new' : 'old';
    const selectedCode = extractLinesFromPatch(file.patch, lineStart, lineEnd, side);

    askAI({
      prompt: question,
      filePath,
      lineStart,
      lineEnd,
      side,
      selectedCode: selectedCode || undefined,
    });
  }, [askAI, files, pendingSelection]);

  // Single-file surface: the focused file IS files[activeFileIndex].
  const handleAskAI = useCallback((question: string) => {
    const file = files[activeFileIndex];
    if (!file) return;
    handleAskAIForFile(file.path, question);
  }, [activeFileIndex, files, handleAskAIForFile]);

  const handleViewAIResponse = useCallback((questionId?: string) => {
    reviewSidebar.open('ai');
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


  // AI messages overlapping the current selection in a GIVEN file (toolbar
  // history). File-aware so the all-files surface can ask for its own active
  // file instead of inheriting the single-file panel's focus.
  const getAIHistoryForFile = useCallback((filePath: string) => {
    if (!pendingSelection) return [];
    const selStart = Math.min(pendingSelection.start, pendingSelection.end);
    const selEnd = Math.max(pendingSelection.start, pendingSelection.end);
    const side = pendingSelection.side === 'additions' ? 'new' : 'old';
    return aiMessages.filter(m => {
      const q = m.question;
      return q.filePath === filePath && q.side === side &&
        q.lineStart != null && q.lineEnd != null &&
        q.lineStart <= selEnd && q.lineEnd >= selStart;
    });
  }, [pendingSelection, aiMessages]);

  // Single-file surface variant (focused file = files[activeFileIndex]).
  const aiHistoryForSelection = useMemo(() => {
    const file = files[activeFileIndex];
    return file ? getAIHistoryForFile(file.path) : [];
  }, [files, activeFileIndex, getAIHistoryForFile]);

  // Click AI marker in diff → scroll sidebar to that Q&A
  const [scrollToQuestionId, setScrollToQuestionId] = useState<string | null>(null);
  const handleClickAIMarker = useCallback((questionId: string) => {
    setScrollToQuestionId(questionId);
    reviewSidebar.open('ai');
    // Clear after a tick so it can re-trigger for the same question
    setTimeout(() => setScrollToQuestionId(null), 500);
  }, []);

  // General AI question from sidebar input
  const handleAskGeneral = useCallback((question: string) => {
    askAI({ prompt: question });
  }, [askAI]);

  // Resizable panels
  const panelResize = useResizablePanel({
    storageKey: 'plannotator-review-panel-width',
    onSnapClose: () => reviewSidebar.close(),
  });
  const fileTreeResize = useResizablePanel({
    storageKey: 'plannotator-filetree-width',
    defaultWidth: 256, minWidth: 160, maxWidth: 400, side: 'left',
    onSnapClose: () => setIsFileTreeOpen(false),
  });
  const isResizing = panelResize.isDragging || fileTreeResize.isDragging;

  // Dockview ready handler — stores API and wires active panel tracking.
  // Initial panel creation happens in the effect below once dockApi is set.
  const handleDockReady = useCallback((event: DockviewReadyEvent) => {
    setDockApi(event.api);

    // Sync activeFileIndex when user switches between dock tabs
    event.api.onDidActivePanelChange((panel) => {
      if (!panel) {
        setIsAllFilesActive(false);
        setIsSemanticDiffActive(false);
        setIsDiffPanelActive(false);
        return;
      }
      setIsAllFilesActive(panel.id === REVIEW_ALL_FILES_PANEL_ID);
      setIsSemanticDiffActive(panel.id === REVIEW_SEMANTIC_DIFF_PANEL_ID);
      setIsDiffPanelActive(isReviewDiffPanelId(panel.id));
      if (!isReviewDiffPanelId(panel.id)) return;
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
      const hideHeaders =
        lonePanel?.id === REVIEW_DIFF_PANEL_ID ||
        lonePanel?.id === REVIEW_SEMANTIC_DIFF_PANEL_ID ||
        lonePanel?.id === REVIEW_ALL_FILES_PANEL_ID;
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

  const openAllFilesPanel = useCallback(() => {
    if (!dockApi) return;
    semanticDiffAutoFallbackPending.current = false;
    const existing = dockApi.getPanel(REVIEW_ALL_FILES_PANEL_ID);
    if (existing) { existing.api.setActive(); return; }
    dockApi.addPanel({
      id: REVIEW_ALL_FILES_PANEL_ID,
      component: REVIEW_PANEL_TYPES.ALL_FILES,
      title: 'All files',
    });
  }, [dockApi]);

  const openSemanticDiffPanel = useCallback((options?: { autoFallbackOnError?: boolean }) => {
    if (!dockApi) return;
    semanticDiffAutoFallbackPending.current = options?.autoFallbackOnError === true;
    if (!semanticDiffAvailable) {
      openAllFilesPanel();
      return;
    }
    const existing = dockApi.getPanel(REVIEW_SEMANTIC_DIFF_PANEL_ID);
    if (existing) { existing.api.setActive(); return; }
    dockApi.addPanel({
      id: REVIEW_SEMANTIC_DIFF_PANEL_ID,
      component: REVIEW_PANEL_TYPES.SEMANTIC_DIFF,
      title: 'Semantic diff',
    });
  }, [dockApi, openAllFilesPanel, semanticDiffAvailable]);

  const handleSemanticDiffUnavailable = useCallback(() => {
    semanticDiffAutoFallbackPending.current = false;
    setSemanticDiffAvailable(false);
    dockApi?.getPanel(REVIEW_SEMANTIC_DIFF_PANEL_ID)?.api.close();
    openAllFilesPanel();
  }, [dockApi, openAllFilesPanel]);

  const handleSemanticDiffLoadSuccess = useCallback(() => {
    semanticDiffAutoFallbackPending.current = false;
  }, []);

  const handleSemanticDiffLoadError = useCallback(() => {
    if (!semanticDiffAutoFallbackPending.current) return false;
    if (dockApi?.activePanel?.id !== REVIEW_SEMANTIC_DIFF_PANEL_ID) {
      // The user has already moved on; don't steal focus by auto-opening All files.
      semanticDiffAutoFallbackPending.current = false;
      return false;
    }
    semanticDiffAutoFallbackPending.current = false;
    dockApi?.getPanel(REVIEW_SEMANTIC_DIFF_PANEL_ID)?.api.close();
    openAllFilesPanel();
    return true;
  }, [dockApi, openAllFilesPanel]);

  const applySemanticDiffAdvert = useCallback((semanticDiff?: SemanticDiffAdvert) => {
    if (!semanticDiff) return;
    const available = semanticDiff.available === true;
    setSemanticDiffAvailable(available);
    if (!available) {
      semanticDiffAutoFallbackPending.current = false;
      dockApi?.getPanel(REVIEW_SEMANTIC_DIFF_PANEL_ID)?.api.close();
      if (isSemanticDiffActive) openAllFilesPanel();
    }
  }, [dockApi, isSemanticDiffActive, openAllFilesPanel]);

  // Open the All files overview on first load. Semantic diff stays available via
  // the file-tree nav entry, but it's no longer the default landing view.
  useEffect(() => {
    if (!dockApi || !needsInitialDiffPanel.current || files.length === 0) return;
    needsInitialDiffPanel.current = false;
    openAllFilesPanel();
  }, [dockApi, files, openAllFilesPanel]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F to focus file search when diff files are available.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !isTypingTarget(e.target)) {
        if (hasSearchableFiles) {
          e.preventDefault();
          setIsFileTreeOpen(true);
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
      // Cmd/Ctrl+B to toggle file tree
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && !isTypingTarget(e.target)) {
        e.preventDefault();
        setIsFileTreeOpen(prev => !prev);
      }
      // Cmd/Ctrl+. to toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === '.' && !isTypingTarget(e.target)) {
        e.preventDefault();
        if (reviewSidebar.isOpen) reviewSidebar.close();
        else reviewSidebar.open();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showExportModal, showDestinationMenu, isSearchOpen, searchQuery, searchMatches, isSearchPending, openSearch, stepSearchMatch, clearSearch, closeSearch, hasSearchableFiles, reviewSidebar.isOpen, reviewSidebar.open, reviewSidebar.close, isFileTreeOpen]);


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
        aiReviewContext?: string;
        origin?: Origin;
        mode?: string;
        diffType?: string;
        base?: string;
        gitContext?: GitContext;
        diffOptions?: DiffOption[];
        agentCwd?: string | null;
        sharingEnabled?: boolean;
        repoInfo?: { display: string; branch?: string };
        prMetadata?: PRMetadata;
        prStackInfo?: PRStackInfo | null;
        prStackTree?: PRStackTree | null;
        prDiffScope?: PRDiffScope;
        prDiffScopeOptions?: PRDiffScopeOption[];
        prPatchIncomplete?: boolean;
        prPatchUpgradeAvailable?: boolean;
        platformUser?: string;
        viewedFiles?: string[];
        error?: string;
        isWSL?: boolean;
        semanticDiff?: SemanticDiffAdvert;
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
          aiReviewContext: data.aiReviewContext,
          gitContext: data.gitContext,
          diffOptions: data.diffOptions,
          sharingEnabled: data.sharingEnabled,
        });
        setFiles(apiFiles);
        setReviewMode(data.mode ?? null);
        setWorkspaceDiffOptions(data.mode === 'workspace' ? (data.diffOptions ?? []) : null);
        if (data.origin) setOrigin(data.origin);
        if (data.diffType) setDiffType(data.diffType);
        if (data.gitContext) {
          setGitContext(data.gitContext);
          // Prefer the server's active base (survives page refresh / reconnect)
          // over the detected default, so the picker rehydrates to what the
          // server is actually using.
          const initial = data.base || data.gitContext.defaultBranch || data.gitContext.compareTarget?.fallback || null;
          setSelectedBase(initial);
          setCommittedBase(initial);
        }
        if (data.agentCwd !== undefined) setAgentCwd(data.agentCwd);
        if (data.sharingEnabled !== undefined) setSharingEnabled(data.sharingEnabled);
        if (data.repoInfo) setRepoInfo(data.repoInfo);
        updatePRSession({
          ...(data.prMetadata && { prMetadata: data.prMetadata }),
          ...(data.prStackInfo !== undefined && { prStackInfo: data.prStackInfo }),
          ...(data.prStackTree !== undefined && { prStackTree: data.prStackTree }),
          ...(data.prDiffScope && { prDiffScope: data.prDiffScope }),
          ...(data.prDiffScopeOptions && { prDiffScopeOptions: data.prDiffScopeOptions }),
          ...(data.prMetadata && {
            prPatchIncomplete: data.prPatchIncomplete === true,
            prPatchUpgradeAvailable: data.prPatchUpgradeAvailable === true,
          }),
        });
        if (data.platformUser) setPlatformUser(data.platformUser);
        // Initialize viewed files from GitHub's state (set before draft restore so draft takes precedence)
        if (data.viewedFiles && data.viewedFiles.length > 0) {
          setViewedFiles(new Set(data.viewedFiles));
        }
        if (data.error) setDiffError(data.error);
        if (data.isWSL) setIsWSL(true);
        setSemanticDiffAvailable(data.semanticDiff?.available === true);
        // Mark diff type setup as pending on first run (local mode only)
        if (data.diffType && data.mode !== 'workspace' && !data.prMetadata && data.gitContext && data.gitContext.vcsType !== 'p4' && data.gitContext.vcsType !== 'jj' && needsDiffTypeSetup()) {
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
        setWorkspaceDiffOptions(null);
        setSemanticDiffAvailable(false);
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Show diff type setup after the initial diff payload marks it pending.
  useEffect(() => {
    if (diffTypeSetupPending) {
      setDiffTypeSetupPending(false);
      setShowDiffTypeSetup(true);
    }
  }, [diffTypeSetupPending]);

  const handleDiffStyleChange = useCallback((style: 'split' | 'unified') => {
    configStore.set('diffStyle', style);
  }, []);

  // Handle line selection from diff viewer
  const handleLineSelection = useCallback((range: SelectedLineRange | null) => {
    setPendingSelection(range);
  }, []);

  const handleAddAnnotationForFile = useCallback((
    filePath: string,
    type: CodeAnnotationType,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
    conventionalLabel?: ConventionalLabel,
    decorations?: ConventionalDecoration[],
    tokenMeta?: TokenAnnotationMeta
  ) => {
    if (!pendingSelection) return;
    const lineStart = Math.min(pendingSelection.start, pendingSelection.end);
    const lineEnd = Math.max(pendingSelection.start, pendingSelection.end);
    const newAnnotation: CodeAnnotation = {
      id: generateId(),
      type,
      scope: 'line',
      filePath,
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
  }, [pendingSelection, identity, withPRContext]);

  const handleAddAnnotation = useCallback((
    type: CodeAnnotationType,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
    conventionalLabel?: ConventionalLabel,
    decorations?: ConventionalDecoration[],
    tokenMeta?: TokenAnnotationMeta
  ) => {
    if (!files[activeFileIndex]) return;
    handleAddAnnotationForFile(files[activeFileIndex].path, type, text, suggestedCode, originalCode, conventionalLabel, decorations, tokenMeta);
  }, [files, activeFileIndex, handleAddAnnotationForFile]);

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

  const handleAddFileCommentForFile = useCallback((filePath: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const newAnnotation: CodeAnnotation = {
      id: generateId(),
      type: 'comment',
      scope: 'file',
      filePath,
      lineStart: 1,
      lineEnd: 1,
      side: 'new',
      text: trimmed,
      createdAt: Date.now(),
      author: identity,
    };

    setAnnotations(prev => [...prev, withPRContext(newAnnotation)]);
  }, [identity, withPRContext]);

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

  // selectedAnnotationId is cleared via a functional update (not a captured
  // value): this handler is captured by Pierre slot portals (inline annotation
  // delete buttons) that only republish on item version bumps — a closure over
  // the state value goes stale and would leave a dangling selection id after
  // deleting the currently-selected annotation.
  const handleDeleteAnnotation = useCallback((id: string) => {
    const ann = allAnnotationsRef.current.find(a => a.id === id);
    if (ann?.source && externalAnnotations.some(e => e.id === id)) {
      deleteExternalAnnotation(id);
      setSelectedAnnotationId(prev => (prev === id ? null : prev));
      return;
    }
    setAnnotations(prev => prev.filter(a => a.id !== id));
    setSelectedAnnotationId(prev => (prev === id ? null : prev));
  }, [deleteExternalAnnotation, externalAnnotations]);

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
  const canStageInWorkspace = reviewMode !== 'workspace' || workspaceDiffOptions?.some((option) => option.id === 'workspace-staged');
  const canStageFiles = canStageRaw && !prMetadata && canStageInWorkspace;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || isTypingTarget(e.target)) return;
      if (!isDiffPanelActive) return;
      const filePath = files[activeFileIndex]?.path;
      if (!filePath) return;

      if (e.key === 'v') {
        e.preventDefault();
        handleToggleViewed(filePath);
      } else if (e.key === 'a' && canStageFiles) {
        e.preventDefault();
        stageFile(filePath);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [files, activeFileIndex, isDiffPanelActive, handleToggleViewed, canStageFiles, stageFile]);

  // Shared function: apply a PR response (used by both initial load and PR switch)
  function applyPRResponse(data: PRSessionUpdate & {
    rawPatch: string; gitRef: string;
    aiReviewContext?: string;
    repoInfo?: { display: string; branch?: string };
    viewedFiles?: string[]; error?: string;
    semanticDiff?: SemanticDiffAdvert;
    agentCwd?: string | null;
  }) {
    const isPRSwitch = !!data.prMetadata;
    const nextFiles = parseDiffToFiles(data.rawPatch);
    dockApi?.getPanel(REVIEW_DIFF_PANEL_ID)?.api.close();
    needsInitialDiffPanel.current = true;
    setDiffData(prev => prev ? { ...prev, rawPatch: data.rawPatch, gitRef: data.gitRef, aiReviewContext: data.aiReviewContext } : prev);
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
      // Scope/switch responses authoritatively report partiality; absence
      // means the patch is complete (e.g. after the local recompute upgrade).
      prPatchIncomplete: data.prPatchIncomplete === true,
      prPatchUpgradeAvailable: data.prPatchUpgradeAvailable === true,
    });
    if (data.repoInfo) setRepoInfo(data.repoInfo);
    if (data.prMetadata) {
      setViewedFiles(data.viewedFiles ? new Set(data.viewedFiles) : new Set());
    }
    setDiffError(data.error || null);
    applySemanticDiffAdvert(data.semanticDiff);
    // The PR's local checkout changes on switch (and warms in later). Use the
    // server's value when present; otherwise clear it on a switch so the Open-in
    // button can't keep pointing at the previous PR's checkout (the 5s freshness
    // probe re-advertises the new one). Scope toggles keep the same checkout.
    if (data.agentCwd !== undefined) {
      setAgentCwd(data.agentCwd);
    } else if (isPRSwitch) {
      setAgentCwd(null);
    }
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
        aiReviewContext?: string;
        diffType: string;
        base?: string;
        gitContext?: GitContext;
        diffOptions?: DiffOption[];
        error?: string;
        semanticDiff?: SemanticDiffAdvert;
      };

      const nextFiles = parseDiffToFiles(data.rawPatch);
      applySemanticDiffAdvert(data.semanticDiff);

      if (options?.preserveFile) {
        // Whitespace toggle: update patch in-place, keep the active file.
        // If the current file was removed (whitespace-only), retarget the
        // dock panel to the first remaining file.
        setDiffData(prev => prev ? { ...prev, rawPatch: data.rawPatch, gitRef: data.gitRef, aiReviewContext: data.aiReviewContext } : prev);
        if (data.diffOptions) setWorkspaceDiffOptions(data.diffOptions);
        setFiles(nextFiles);
        const currentPath = files[activeFileIndex]?.path;
        const nextIdx = currentPath ? nextFiles.findIndex(f => f.path === currentPath) : -1;
        if (nextIdx !== -1) {
          setActiveFileIndex(nextIdx);
        } else if (nextFiles.length > 0) {
          setActiveFileIndex(0);
          openDiffFile(nextFiles[0].path);
        }
        // Line numbers can shift when whitespace handling changes, so a
        // selection anchored to the old patch is stale — clear it (the
        // non-preserve branch below already does).
        setPendingSelection(null);
      } else {
        dockApi?.getPanel(REVIEW_DIFF_PANEL_ID)?.api.close();
        needsInitialDiffPanel.current = true;
        setDiffData(prev => prev ? { ...prev, rawPatch: data.rawPatch, gitRef: data.gitRef, diffType: data.diffType, aiReviewContext: data.aiReviewContext } : prev);
        setFiles(nextFiles);
        setDiffType(data.diffType);
        if (data.diffOptions) setWorkspaceDiffOptions(data.diffOptions);
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
              compareTarget: data.gitContext!.compareTarget,
              jjEvologs: data.gitContext!.jjEvologs,
              // HEAD differs per worktree, so refresh the commit-baseline picker.
              recentCommits: data.gitContext!.recentCommits,
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
  }, [dockApi, resetStagedFiles, selectedBase, diffHideWhitespace, files, activeFileIndex, openDiffFile, applySemanticDiffAdvert]);

  // Switch the base branch the current diff compares against.
  // Only triggers a refetch when the active mode actually uses a base.
  // Optimistically updates the picker; reverts if the server-side switch
  // fails so the chip doesn't lie about what the viewer is actually showing.
  const handleBaseSelect = useCallback(
    async (branch: string) => {
      if (branch === selectedBase) return;
      const previous = selectedBase;
      setSelectedBase(branch);
      if (activeDiffBase === 'branch' || activeDiffBase === 'merge-base' || activeDiffBase === 'jj-line' || activeDiffBase === 'jj-evolog') {
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
    // For evolog, default to the second entry (previous state of @) so the
    // server doesn't fall back to the jj bookmark/trunk revset.
    // When leaving evolog, restore the base to the detected compare target
    // so other base-dependent modes (jj-line) don't inherit a commit ID.
    const enteringEvolog =
      baseDiffType === 'jj-evolog' && gitContext?.jjEvologs && gitContext.jjEvologs.length >= 2;
    const leavingEvolog =
      !enteringEvolog && activeDiffBase === 'jj-evolog' && gitContext?.defaultBranch;
    const baseOverride = enteringEvolog
      ? gitContext!.jjEvologs![1].commitId
      : leavingEvolog
        ? gitContext!.defaultBranch
        : undefined;
    if (baseOverride) setSelectedBase(baseOverride);
    await fetchDiffSwitch(fullDiffType, baseOverride);
  }, [diffType, activeWorktreePath, fetchDiffSwitch, gitContext]);

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
    if (!origin || (!gitContext && reviewMode !== 'workspace')) return;
    if (!hideWhitespaceInitialized.current) {
      hideWhitespaceInitialized.current = true;
      return;
    }
    fetchDiffSwitch(diffType, selectedBase, { preserveFile: true });
  }, [diffHideWhitespace, origin, reviewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Diff staleness ---------------------------------------------------------
  // Files changing mid-review (an agent editing/committing while the user
  // reviews) make the snapshot on screen stale. The hook polls the server's
  // cheap fingerprint check; the toolbar shows a non-blocking notice and the
  // user refreshes when THEY are ready — never automatically (annotations are
  // line-anchored; rug-pulling the diff under them is worse than staleness).
  const diffFreshness = useDiffFreshness({
    enabled: !!origin,
    resetKey: diffData?.rawPatch ?? '',
    onAgentCwd: setAgentCwd,
  });

  const handleRefreshStaleDiff = useCallback(() => {
    if (prMetadata) {
      // Only the full-stack scope can go stale locally — the layer diff is
      // computed platform-side and its fingerprint never flips.
      if (prDiffScope === 'full-stack') handlePRDiffScopeSelect('full-stack');
      return;
    }
    // Same params, fresh snapshot. preserveFile keeps the reviewer on the
    // file they were reading.
    void fetchDiffSwitch(diffType, selectedBase, { preserveFile: true });
  }, [prMetadata, prDiffScope, handlePRDiffScopeSelect, fetchDiffSwitch, diffType, selectedBase]);

  // Select annotation - switches file if needed and scrolls to it.
  // isAllFilesActive is read through the ref (declared with the state): this
  // handler is baked into Pierre slot portals, which only republish on item
  // version bumps — a stale captured value would yank the user out of the
  // all-files tab into the single-file panel when they click an annotation.
  // Inline-card selection: toggle the highlight + ring only. No scroll, no file
  // switch — the clicked card is already on screen. Clicking the selected card
  // again (or a null id) clears it.
  const handleSelectAnnotation = useCallback((id: string | null) => {
    // An inline selection supersedes any pending sidebar/findings navigate target,
    // so a later remount (Refresh / base switch) doesn't re-scroll back to it.
    setScrollTargetAnnotation(null);
    setSelectedAnnotationId(prev => (!id || prev === id ? null : id));
  }, []);

  // Sidebar navigation: select AND scroll-to the comment (DiffsHub "set +
  // scroll"). The token bump re-fires the panels' scroll effect even when the
  // same comment is clicked twice; in single-file mode it switches to the
  // owning file first so the scroll target exists.
  const handleNavigateToAnnotation = useCallback((id: string | null) => {
    if (!id) {
      setSelectedAnnotationId(null);
      return;
    }
    const annotation = allAnnotationsRef.current.find(a => a.id === id);
    // An annotation that's gone (deleted) or filtered out of the active
    // PR/diff-scope has nothing in the current diff to scroll to or highlight,
    // so don't fake a selection on it. Clear the current selection instead of
    // silently no-opping, so the click still gives visible feedback rather than
    // appearing broken (e.g. after an in-place PR switch leaves stale sidebar
    // cards listed).
    if (!annotation || !annotationMatchesPrScope(annotation, prMetadata?.url, prDiffScope)) {
      setSelectedAnnotationId(null);
      return;
    }
    if (!isAllFilesActiveRef.current) {
      const fileIndex = files.findIndex(f => f.path === annotation.filePath);
      if (fileIndex !== -1) handleFileSwitch(fileIndex);
    }
    setSelectedAnnotationId(id);
    setScrollTargetAnnotation(prev => ({ id, token: (prev?.token ?? 0) + 1 }));
  }, [files, handleFileSwitch, prMetadata, prDiffScope]);

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
    rawPatch: diffData?.rawPatch ?? '',
    focusedFileIndex: activeFileIndex,
    focusedFilePath: files[activeFileIndex]?.path ?? null,
    diffStyle,
    diffOverflow,
    diffIndicators,
    lineDiffType: diffLineDiffType,
    disableLineNumbers: !diffShowLineNumbers,
    disableBackground: !diffShowBackground,
    expandUnchanged: diffExpandUnchanged,
    fontFamily: diffFontFamily || undefined,
    fontSize: diffFontSize || undefined,
    // Only propagate base for modes where it affects old/new content. Avoids
    // needless file-content re-fetches when switching to uncommitted/staged/etc.
    // Uses committedBase (not selectedBase) so file-content queries wait for
    // the new patch to arrive before refetching — otherwise the viewer can
    // briefly pair an old patch with the new base's content.
    reviewBase:
        (activeDiffBase === 'branch' || activeDiffBase === 'merge-base' || activeDiffBase === 'jj-line' || activeDiffBase === 'jj-evolog')
        ? committedBase ?? undefined
        : undefined,
    activeDiffBase,
    feedbackDiffContext,
    prReviewScope: prReviewScopeLabel,
    prDiffScope,
    agentCwd,
    allAnnotations,
    externalAnnotations,
    selectedAnnotationId,
    scrollTargetAnnotation,
    pendingSelection,
    onLineSelection: handleLineSelection,
    onAddAnnotation: handleAddAnnotation,
    onAddAnnotationForFile: handleAddAnnotationForFile,
    onAddFileComment: handleAddFileComment,
    onAddFileCommentForFile: handleAddFileCommentForFile,
    onEditAnnotation: handleEditAnnotation,
    onSelectAnnotation: handleSelectAnnotation,
    onNavigateToAnnotation: handleNavigateToAnnotation,
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
    searchMatches,
    allFilesActiveSearchMatch: activeSearchMatch,
    aiAvailable,
    aiMessages,
    onAskAI: handleAskAI,
    onAskAIForFile: handleAskAIForFile,
    isAILoading: aiIsCreatingSession || aiIsStreaming,
    onViewAIResponse: handleViewAIResponse,
    onClickAIMarker: handleClickAIMarker,
    aiHistoryForSelection,
    getAIHistoryForFile,
    agentJobs: agentJobs.jobs,
    prMetadata,
    prContext,
    isPRContextLoading,
    prContextError,
    fetchPRContext,
    platformUser,
    openDiffFile,
    onAllFilesVisibleFileChange: setAllFilesVisibleFile,
    isAllFilesActive,
    isSemanticDiffActive,
    semanticDiffAvailable,
    onSemanticDiffUnavailable: handleSemanticDiffUnavailable,
    onSemanticDiffLoadError: handleSemanticDiffLoadError,
    onSemanticDiffLoadSuccess: handleSemanticDiffLoadSuccess,
    openTourPanel: handleOpenTour,
    onCodeNavRequest: handleCodeNavRequest,
    codeNavResult: codeNav.result,
    codeNavIsLoading: codeNav.isLoading,
    codeNavActiveSymbol: codeNav.activeSymbol,
  }), [
    files, diffData?.rawPatch, activeFileIndex, diffStyle, diffOverflow, diffIndicators,
    diffLineDiffType, diffShowLineNumbers, diffShowBackground,
    diffExpandUnchanged, diffFontFamily, diffFontSize, activeDiffBase, committedBase, feedbackDiffContext, prReviewScopeLabel, prDiffScope, agentCwd,
    allAnnotations, externalAnnotations,
    selectedAnnotationId, scrollTargetAnnotation, pendingSelection, handleLineSelection,
    handleAddAnnotation, handleAddFileComment, handleAddFileCommentForFile, handleEditAnnotation,
    handleSelectAnnotation, handleNavigateToAnnotation, handleDeleteAnnotation, viewedFiles,
    handleToggleViewed, stagedFiles, stagingFile, stageFile,
    canStageFiles, stageError, isSearchPending, debouncedSearchQuery,
    activeFileSearchMatches, activeSearchMatchId, activeSearchMatch, searchMatches,
    aiAvailable, aiMessages, aiIsCreatingSession, aiIsStreaming,
    handleAskAI, handleAskAIForFile, handleViewAIResponse, handleClickAIMarker,
    aiHistoryForSelection, getAIHistoryForFile, agentJobs.jobs, prMetadata, prContext,
    isPRContextLoading, prContextError, fetchPRContext, platformUser, openDiffFile,
    handleOpenTour, isAllFilesActive, isSemanticDiffActive, semanticDiffAvailable,
    handleSemanticDiffUnavailable, handleSemanticDiffLoadError, handleSemanticDiffLoadSuccess, handleAddAnnotationForFile,
    handleCodeNavRequest, codeNav.result, codeNav.isLoading, codeNav.activeSymbol,
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
          draftGeneration: getDraftGeneration(),
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
  }, [totalAnnotationCount, feedbackMarkdown, allAnnotations, getDraftGeneration]);

  // Exit review session without sending any feedback
  const handleExit = useCallback(async () => {
    setIsExiting(true);
    try {
      const res = await fetch(`/api/exit?draftGeneration=${getDraftGeneration()}`, { method: 'POST' });
      if (res.ok) {
        setSubmitted('exited');
      } else {
        throw new Error('Failed to exit');
      }
    } catch (error) {
      console.error('Failed to exit review:', error);
      setIsExiting(false);
    }
  }, [getDraftGeneration]);

  // Approve without feedback (LGTM)
  const handleApprove = useCallback(async () => {
    setIsApproving(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draftGeneration: getDraftGeneration(),
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
  }, [getDraftGeneration]);

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
            {shouldShowFileTree && (
              <>
                <button
                  onClick={() => setIsFileTreeOpen(prev => !prev)}
                  className={`p-1 rounded-md transition-all focus-visible:outline-none ${
                    isFileTreeOpen
                      ? 'text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                  title={isFileTreeOpen ? 'Hide file tree' : 'Show file tree'}
                >
                  <FolderTree className="w-3.5 h-3.5" />
                </button>
                <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
              </>
            )}
            {prMetadata ? (
              <div className="min-w-0 flex items-center gap-2 md:gap-3">
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
            {/* Diff-display controls: Split/Unified toggle + settings cog in
                one pill. The cog is an action (not a toggle segment), set off
                by a divider so the grouping reads clearly. */}
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
              <div className="w-px h-4 bg-border/60 mx-0.5" />
              <DiffOptionsPopover />
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

                {reviewMode === 'workspace' && diffError && (
                  <div
                    className="text-xs text-amber-700 dark:text-amber-300 px-2 py-1 bg-amber-500/10 rounded border border-amber-500/25 max-w-[240px] truncate"
                    title={diffError}
                  >
                    {files.length > 0 ? 'Some workspace changes could not be loaded' : 'Workspace changes could not be loaded'}
                  </div>
                )}

                {/* Partial PR diff notice — the platform withheld per-file
                    content (PR too large). "Load full diff" re-requests the
                    layer scope; the server recomputes the exact diff from the
                    local checkout (waiting out the warmup if needed). The
                    request is non-blocking on purpose: it can park for
                    minutes behind a cold clone, and the reviewer keeps
                    working with the partial diff meanwhile. */}
                {prPatchIncomplete && prDiffScope === 'layer' && !isSwitchingPRScope && (
                  <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 px-2 py-1 bg-amber-500/10 rounded border border-amber-500/25">
                    <span className="hidden md:inline" title={`${prMetadata?.platform === 'gitlab' ? 'GitLab' : 'GitHub'} omitted diff content for some files because this PR is too large`}>
                      Partial diff
                    </span>
                    <span className="md:hidden">Partial</span>
                    {!prPatchUpgradeAvailable ? (
                      // Partiality without a local checkout: informational
                      // only — never offer a button that cannot work. The
                      // visible text stays runtime-neutral (--local is a CLI
                      // remedy that not every runtime supports).
                      <span
                        className="hidden sm:inline text-amber-700/70 dark:text-amber-300/70"
                        title="The platform omitted diff content for some files and this session has no local checkout to recompute from. CLI sessions can re-run the review with --local."
                      >
                        (no local checkout — full diff unavailable)
                      </span>
                    ) : isLoadingFullDiff ? (
                      <span className="flex items-center gap-1.5 font-medium" title="Recomputing the full diff from the local checkout — waiting for the background clone if it's still running. You can keep reviewing.">
                        <span className="inline-block w-3 h-3 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" aria-hidden />
                        Loading full diff…
                      </span>
                    ) : (
                      <button
                        onClick={handleLoadFullDiff}
                        className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100 transition-colors"
                        title="Recompute the full diff from the local checkout (may wait for the background clone to finish — you can keep reviewing meanwhile)"
                      >
                        Load full diff
                      </button>
                    )}
                  </div>
                )}

                {/* Diff staleness notice — files changed since this snapshot
                    was computed (agent editing mid-review). Non-blocking; the
                    user refreshes when ready. */}
                {diffFreshness.isStale && !isLoadingDiff && (
                  <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 px-2 py-1 bg-amber-500/10 rounded border border-amber-500/25">
                    <span className="hidden md:inline">Diff out of date</span>
                    <span className="md:hidden">Stale</span>
                    <button
                      onClick={handleRefreshStaleDiff}
                      className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100 transition-colors"
                      title="Re-run the diff with the current settings"
                    >
                      Refresh
                    </button>
                    <button
                      onClick={diffFreshness.dismiss}
                      className="text-amber-700/60 dark:text-amber-300/60 hover:text-amber-900 dark:hover:text-amber-100 transition-colors leading-none"
                      title="Dismiss"
                      aria-label="Dismiss stale diff notice"
                    >
                      ×
                    </button>
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

            {/* Sidebar tab toggles */}
            <button
              onClick={() => reviewSidebar.toggleTab('annotations')}
              className={`relative p-1.5 rounded-md transition-all ${
                reviewSidebar.isOpen && reviewSidebar.activeTab === 'annotations'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              title="Annotations"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              {totalAnnotationCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground px-0.5">
                  {totalAnnotationCount > 99 ? '99+' : totalAnnotationCount}
                </span>
              )}
            </button>
            {aiAvailable && (
              <button
                onClick={() => reviewSidebar.toggleTab('ai')}
                className={`relative p-1.5 rounded-md transition-all ${
                  reviewSidebar.isOpen && reviewSidebar.activeTab === 'ai'
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
                title="AI Chat"
              >
                <SparklesIcon className="w-4 h-4" />
                {aiMessages.length > 0 && !(reviewSidebar.isOpen && reviewSidebar.activeTab === 'ai') && (
                  <span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </button>
            )}
            {agentJobs.capabilities?.available && (
              <button
                onClick={() => reviewSidebar.toggleTab('agents')}
                className={`relative p-1.5 rounded-md transition-all ${
                  reviewSidebar.isOpen && reviewSidebar.activeTab === 'agents'
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
                title="Review Agents"
              >
                <ReviewAgentsIcon className="w-4 h-4" />
                {agentJobs.jobs.some(j => j.status === 'running' || j.status === 'starting') && !(reviewSidebar.isOpen && reviewSidebar.activeTab === 'agents') && (
                  <span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                )}
              </button>
            )}

            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />

            <ReviewHeaderMenu
              onOpenSettings={() => setOpenSettingsMenu(true)}
              onOpenExport={() => setShowExportModal(true)}
              onCopyAgentInstructions={handleCopyAgentInstructions}
              onToggleFileTree={() => setIsFileTreeOpen(prev => !prev)}
              onToggleSidebar={() => reviewSidebar.isOpen ? reviewSidebar.close() : reviewSidebar.open()}
              isFileTreeOpen={isFileTreeOpen}
              isSidebarOpen={reviewSidebar.isOpen}
              agentInstructionsEnabled={!!origin}
              appVersion={appVersion}
              updateInfo={updateInfo}
              origin={origin}
              isWSL={isWSL}
            />
          </div>
        </header>

        {/* Main content */}
        <div className={`flex-1 flex overflow-hidden ${isResizing ? 'select-none' : ''}`}>
          {shouldShowFileTree && isFileTreeOpen && (
            <div className="contents group/sidebar">
              <FileTree
                files={files}
                activeFileIndex={activeFileIndex}
                onSelectSemanticDiff={() => openSemanticDiffPanel()}
                isSemanticDiffActive={isSemanticDiffActive}
                semanticDiffAvailable={semanticDiffAvailable}
                onSelectAllFiles={openAllFilesPanel}
                isAllFilesActive={isAllFilesActive}
                scrollHighlightIndex={isAllFilesActive && allFilesVisibleFile ? files.findIndex(f => f.path === allFilesVisibleFile) : undefined}
                onSelectFile={handleFilePreview}
                onDoubleClickFile={handleFilePinned}
                annotations={allAnnotations}
                viewedFiles={viewedFiles}
                onToggleViewed={handleToggleViewed}
                hideViewedFiles={hideViewedFiles}
                onToggleHideViewed={() => setHideViewedFiles(prev => !prev)}
                enableKeyboardNav={!showExportModal && hasSearchableFiles}
                diffOptions={reviewMode === 'workspace' ? (workspaceDiffOptions ?? undefined) : gitContext?.diffOptions}
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
                detectedBase={prMetadata ? undefined : gitContext?.defaultBranch || gitContext?.compareTarget?.fallback}
                onSelectBase={prMetadata ? undefined : handleBaseSelect}
                compareTarget={gitContext?.compareTarget}
                recentCommits={prMetadata ? undefined : gitContext?.recentCommits}
                jjEvologs={prMetadata ? undefined : gitContext?.jjEvologs}
                detectedEvoBase={prMetadata ? undefined : gitContext?.jjEvologs?.[1]?.commitId}
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
                repoRoot={prMetadata ? null : (activeWorktreePath ?? agentCwd ?? gitContext?.cwd ?? null)}
              />
              <ResizeHandle {...fileTreeResize.handleProps} className="z-10" side="left" onCollapse={() => setIsFileTreeOpen(false)} />
            </div>
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
                          {activeDiffBase === 'jj-current' && "No changes in the current jj change."}
                          {activeDiffBase === 'jj-last' && "No changes in the last jj change."}
                          {activeDiffBase === 'workspace-current' && "No current changes in the workspace repositories."}
                          {activeDiffBase === 'workspace-staged' && "No staged changes in the workspace repositories."}
                          {activeDiffBase === 'workspace-unstaged' && "No unstaged changes in the workspace repositories."}
                          {activeDiffBase === 'workspace-last' && "No changes in the last change across workspace repositories."}
                          {activeDiffBase === 'jj-line' && `No changes in your line of work vs ${selectedBase || gitContext?.defaultBranch || '@-'}.`}
                          {activeDiffBase === 'jj-evolog' && `No changes since evolution ${selectedBase ? selectedBase.slice(0, 8) : 'previous'} — the change looks the same as before.`}
                          {activeDiffBase === 'jj-all' && "No files at the current jj change."}
                          {activeDiffBase === 'branch' && `No changes vs ${selectedBase || gitContext?.defaultBranch || 'main'}${activeWorktreePath ? ' in this worktree' : ''}.`}
                          {activeDiffBase === 'merge-base' && `No changes vs ${selectedBase || gitContext?.defaultBranch || 'main'}${activeWorktreePath ? ' in this worktree' : ''}.`}
                          {activeDiffBase === 'all' && `No tracked files${activeWorktreePath ? ' in this worktree' : ' in this repository'}.`}
                        </p>
                      </>
                    )}
                  </div>
                  {((reviewMode === 'workspace' ? workspaceDiffOptions : gitContext?.diffOptions)?.length ?? 0) > 1 && (
                    <p className="text-xs text-muted-foreground/60">
                      Try selecting a different view from the dropdown.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Resize Handle + Sidebar */}
          {reviewSidebar.isOpen && (
            <div className="contents group/sidebar">
              <ResizeHandle {...panelResize.handleProps} className="z-10" side="right" onCollapse={() => reviewSidebar.close()} />
              <ReviewSidebar
                isOpen
                onClose={reviewSidebar.close}
                activeTab={reviewSidebar.activeTab}
                annotations={allAnnotations}
                files={files}
                selectedAnnotationId={selectedAnnotationId}
                onSelectAnnotation={handleSelectAnnotation}
                onNavigateToAnnotation={handleNavigateToAnnotation}
                onDeleteAnnotation={handleDeleteAnnotation}
                feedbackMarkdown={feedbackMarkdown}
                width={panelResize.width}
                editorAnnotations={editorAnnotations}
                onDeleteEditorAnnotation={deleteEditorAnnotation}
                prMetadata={prMetadata}
                aiAvailable={aiAvailable}
                aiMessages={aiMessages}
                isAICreatingSession={aiIsCreatingSession}
                isAIStreaming={aiIsStreaming}
                onAIStop={abortAI}
                onScrollToAILines={handleScrollToAILines}
                activeFilePath={files[activeFileIndex]?.path}
                scrollToQuestionId={scrollToQuestionId}
                onAskGeneral={handleAskGeneral}
                aiPermissionRequests={aiPermissionRequests}
                onRespondToPermission={respondToAIPermission}
                aiProviders={aiProviders}
                aiConfig={aiConfig}
                onAIConfigChange={handleAIConfigChange}
                hasAISession={!!aiSessionId}
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
          )}
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

        {/* 0.20.0 look-and-feel / release announcement. Shared with the plan
            editor via a host-scoped cookie, so it shows once across both apps.
            Takes precedence over the diff-type setup so the two never stack. */}
        <LookAndFeelAnnouncementDialog
          isOpen={showLookAndFeel}
          gridEnabled={gridEnabled}
          onToggleGrid={(v) => configStore.set('gridEnabled', v)}
          onDismiss={dismissLookAndFeel}
        />

        {/* Diff type setup dialog — first-run only */}
        {showDiffTypeSetup && !showLookAndFeel && (
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

    <Toaster
      position="bottom-center"
      toastOptions={{
        style: {
          '--normal-bg': 'var(--card)',
          '--normal-border': 'var(--border)',
          '--normal-text': 'var(--foreground)',
        } as React.CSSProperties,
      }}
    />
    </JobLogsProvider>
    </ReviewStateProvider>
    </TooltipProvider>
    </ThemeProvider>
  );
};

export default ReviewApp;
