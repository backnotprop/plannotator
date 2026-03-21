import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ThemeProvider, useTheme } from '@plannotator/ui/components/ThemeProvider';
import { ModeToggle } from '@plannotator/ui/components/ModeToggle';
import { ConfirmDialog } from '@plannotator/ui/components/ConfirmDialog';
import { Settings } from '@plannotator/ui/components/Settings';
import { UpdateBanner } from '@plannotator/ui/components/UpdateBanner';
import { storage } from '@plannotator/ui/utils/storage';
import { CompletionOverlay } from '@plannotator/ui/components/CompletionOverlay';
import { GitHubIcon } from '@plannotator/ui/components/GitHubIcon';
import { GitLabIcon } from '@plannotator/ui/components/GitLabIcon';
import { RepoIcon } from '@plannotator/ui/components/RepoIcon';
import { PullRequestIcon } from '@plannotator/ui/components/PullRequestIcon';
import { getPlatformLabel, getMRLabel, getMRNumberLabel, getDisplayRepo } from '@plannotator/shared/pr-provider';
import { getIdentity } from '@plannotator/ui/utils/identity';
import { getAgentSwitchSettings, getEffectiveAgentName } from '@plannotator/ui/utils/agentSwitch';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange } from '@plannotator/ui/types';
import { useResizablePanel } from '@plannotator/ui/hooks/useResizablePanel';
import { useCodeAnnotationDraft } from '@plannotator/ui/hooks/useCodeAnnotationDraft';
import { useGitAdd } from './hooks/useGitAdd';
import { isTypingTarget, useReviewSearch } from './hooks/useReviewSearch';
import { useEditorAnnotations } from '@plannotator/ui/hooks/useEditorAnnotations';
import { exportEditorAnnotations } from '@plannotator/ui/utils/parser';
import { ResizeHandle } from '@plannotator/ui/components/ResizeHandle';
import { DiffViewer } from './components/DiffViewer';
import { ReviewPanel } from './components/ReviewPanel';
import { FileTree } from './components/FileTree';
import { DEMO_DIFF } from './demoData';
import { exportReviewFeedback } from './utils/exportFeedback';
import type { DiffOption, WorktreeInfo, GitContext } from '@plannotator/shared/types';
import type { PRMetadata } from '@plannotator/shared/pr-provider';

declare const __APP_VERSION__: string;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const altKey = isMac ? '⌥' : 'Alt';

interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

interface DiffData {
  files: DiffFile[];
  rawPatch: string;
  gitRef: string;
  origin?: 'opencode' | 'claude-code' | 'pi';
  diffType?: string;
  gitContext?: GitContext;
  sharingEnabled?: boolean;
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

// Generate unique ID
function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

const ReviewApp: React.FC = () => {
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [annotations, setAnnotations] = useState<CodeAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<SelectedLineRange | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showNoAnnotationsDialog, setShowNoAnnotationsDialog] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>(() => {
    return (storage.getItem('review-diff-style') as 'split' | 'unified') || 'split';
  });
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [hideViewedFiles, setHideViewedFiles] = useState(false);
  const [origin, setOrigin] = useState<'opencode' | 'claude-code' | 'pi' | null>(null);
  const [diffType, setDiffType] = useState<string>('uncommitted');
  const [gitContext, setGitContext] = useState<GitContext | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [submitted, setSubmitted] = useState<'approved' | 'feedback' | false>(false);
  const [showApproveWarning, setShowApproveWarning] = useState(false);
  const [sharingEnabled, setSharingEnabled] = useState(true);
  const [repoInfo, setRepoInfo] = useState<{ display: string; branch?: string } | null>(null);

  useEffect(() => {
    document.title = repoInfo ? `${repoInfo.display} · Code Review` : "Code Review";
  }, [repoInfo]);

  const [prMetadata, setPrMetadata] = useState<PRMetadata | null>(null);
  const [reviewDestination, setReviewDestination] = useState<'agent' | 'platform'>(() => {
    const stored = storage.getItem('plannotator-review-dest');
    return stored === 'agent' ? 'agent' : 'platform'; // 'github' (legacy) → 'platform'
  });
  const [showDestinationMenu, setShowDestinationMenu] = useState(false);
  const [isPlatformActioning, setIsPlatformActioning] = useState(false);
  const [platformActionError, setPlatformActionError] = useState<string | null>(null);
  const [platformUser, setPlatformUser] = useState<string | null>(null);
  const [platformCommentDialog, setPlatformCommentDialog] = useState<{ action: 'approve' | 'comment' } | null>(null);
  const [platformGeneralComment, setPlatformGeneralComment] = useState('');
  const [platformOpenPR, setPlatformOpenPR] = useState(() => storage.getItem('plannotator-github-open-pr') !== 'false');

  // Derived: Platform mode is active when destination is platform AND we have PR/MR metadata
  const platformMode = reviewDestination === 'platform' && !!prMetadata;

  // Platform-aware labels
  const platformLabel = prMetadata ? getPlatformLabel(prMetadata) : 'GitHub';
  const mrLabel = prMetadata ? getMRLabel(prMetadata) : 'PR';
  const mrNumberLabel = prMetadata ? getMRNumberLabel(prMetadata) : '';
  const displayRepo = prMetadata ? getDisplayRepo(prMetadata) : '';

  const identity = useMemo(() => getIdentity(), []);

  const clearPendingSelection = useCallback(() => {
    setPendingSelection(null);
  }, []);

  const {
    searchQuery,
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
    activeFileIndex,
    setActiveFileIndex,
    clearPendingSelection,
  });

  // Auto-save code annotation drafts
  const { draftBanner, restoreDraft, dismissDraft } = useCodeAnnotationDraft({
    annotations,
    viewedFiles,
    isApiMode: !!origin,
    submitted: !!submitted,
  });

  const handleRestoreDraft = useCallback(() => {
    const restored = restoreDraft();
    if (restored.annotations.length > 0) setAnnotations(restored.annotations);
    if (restored.viewedFiles.length > 0) setViewedFiles(new Set(restored.viewedFiles));
  }, [restoreDraft]);

  // VS Code editor annotations (only polls when inside VS Code webview)
  const { editorAnnotations, deleteEditorAnnotation } = useEditorAnnotations();

  // Resizable panels
  const panelResize = useResizablePanel({ storageKey: 'plannotator-review-panel-width' });
  const fileTreeResize = useResizablePanel({
    storageKey: 'plannotator-filetree-width',
    defaultWidth: 256, minWidth: 160, maxWidth: 400, side: 'left',
  });
  const isResizing = panelResize.isDragging || fileTreeResize.isDragging;

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F to focus search (only when sidebar is rendered)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !isTypingTarget(e.target)) {
        if (files.length > 1 || gitContext?.diffOptions) {
          e.preventDefault();
          openSearch();
        }
        return;
      }

      // Enter/F3 to step through search matches
      if ((e.key === 'Enter' || e.key === 'F3') && searchMatches.length > 0 && !isTypingTarget(e.target)) {
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
  }, [showExportModal, showDestinationMenu, searchQuery, searchMatches, openSearch, stepSearchMatch, clearSearch, files, gitContext?.diffOptions]);

  // Get annotations for active file
  const activeFileAnnotations = useMemo(() => {
    const activeFile = files[activeFileIndex];
    if (!activeFile) return [];
    return annotations.filter(a => a.filePath === activeFile.path);
  }, [annotations, files, activeFileIndex]);

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
        origin?: 'opencode' | 'claude-code' | 'pi';
        diffType?: string;
        gitContext?: GitContext;
        sharingEnabled?: boolean;
        repoInfo?: { display: string; branch?: string };
        prMetadata?: PRMetadata;
        platformUser?: string;
        error?: string;
      }) => {
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
        if (data.gitContext) setGitContext(data.gitContext);
        if (data.sharingEnabled !== undefined) setSharingEnabled(data.sharingEnabled);
        if (data.repoInfo) setRepoInfo(data.repoInfo);
        if (data.prMetadata) setPrMetadata(data.prMetadata);
        if (data.platformUser) setPlatformUser(data.platformUser);
        if (data.error) setDiffError(data.error);
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

  // Handle diff style change
  const handleDiffStyleChange = useCallback((style: 'split' | 'unified') => {
    setDiffStyle(style);
    storage.setItem('review-diff-style', style);
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
    originalCode?: string
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
      createdAt: Date.now(),
      author: identity,
    };

    setAnnotations(prev => [...prev, newAnnotation]);
    setPendingSelection(null);
  }, [pendingSelection, files, activeFileIndex, identity]);

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

    setAnnotations(prev => [...prev, newAnnotation]);
  }, [files, activeFileIndex, identity]);

  // Edit annotation
  const handleEditAnnotation = useCallback((
    id: string,
    text?: string,
    suggestedCode?: string,
    originalCode?: string
  ) => {
    setAnnotations(prev => prev.map(ann =>
      ann.id === id ? {
        ...ann,
        ...(text !== undefined && { text }),
        ...(suggestedCode !== undefined && { suggestedCode }),
        ...(originalCode !== undefined && { originalCode }),
      } : ann
    ));
  }, []);

  // Delete annotation
  const handleDeleteAnnotation = useCallback((id: string) => {
    setAnnotations(prev => prev.filter(a => a.id !== id));
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null);
    }
  }, [selectedAnnotationId]);

  // Handle identity change - update author on existing annotations
  const handleIdentityChange = useCallback((oldIdentity: string, newIdentity: string) => {
    setAnnotations(prev => prev.map(ann =>
      ann.author === oldIdentity ? { ...ann, author: newIdentity } : ann
    ));
  }, []);

  // Switch file - clears pending selection to avoid invalid line ranges
  const handleFileSwitch = useCallback((index: number) => {
    if (index !== activeFileIndex) {
      setPendingSelection(null);
      setActiveFileIndex(index);
    }
  }, [activeFileIndex]);

  const handleToggleViewed = useCallback((filePath: string) => {
    setViewedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  // Derive worktree path and base diff type from the composite diffType string
  const { activeWorktreePath, activeDiffBase } = useMemo(() => {
    if (diffType.startsWith('worktree:')) {
      const rest = diffType.slice('worktree:'.length);
      const lastColon = rest.lastIndexOf(':');
      if (lastColon !== -1) {
        const sub = rest.slice(lastColon + 1);
        if (['uncommitted', 'staged', 'unstaged', 'last-commit', 'branch'].includes(sub)) {
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
  const { stagedFiles, stagingFile, canStageFiles, stageFile, resetStagedFiles, stageError } = useGitAdd({
    activeDiffBase,
    onFileViewed: handleFileViewedFromStage,
  });

  // Shared helper: fetch a diff switch and update state
  const fetchDiffSwitch = useCallback(async (fullDiffType: string) => {
    setIsLoadingDiff(true);
    try {
      const res = await fetch('/api/diff/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diffType: fullDiffType }),
      });

      if (!res.ok) throw new Error('Failed to switch diff');

      const data = await res.json() as {
        rawPatch: string;
        gitRef: string;
        diffType: string;
        error?: string;
      };

      setFiles(parseDiffToFiles(data.rawPatch));
      setDiffType(data.diffType);
      setActiveFileIndex(0);
      setPendingSelection(null);
      setDiffError(data.error || null);
      resetStagedFiles();
    } catch (err) {
      console.error('Failed to switch diff:', err);
      setDiffError(err instanceof Error ? err.message : 'Failed to switch diff');
    } finally {
      setIsLoadingDiff(false);
    }
  }, [resetStagedFiles]);

  // Switch diff type (uncommitted, last-commit, branch) — composes worktree prefix if active
  const handleDiffSwitch = useCallback(async (baseDiffType: string) => {
    const fullDiffType = activeWorktreePath
      ? `worktree:${activeWorktreePath}:${baseDiffType}`
      : baseDiffType;
    if (fullDiffType === diffType) return;
    await fetchDiffSwitch(fullDiffType);
  }, [diffType, activeWorktreePath, fetchDiffSwitch]);

  // Switch worktree context (or back to main repo)
  const handleWorktreeSwitch = useCallback(async (worktreePath: string | null) => {
    if (worktreePath === activeWorktreePath) return;
    const fullDiffType = worktreePath
      ? `worktree:${worktreePath}:uncommitted`
      : 'uncommitted';
    await fetchDiffSwitch(fullDiffType);
  }, [activeWorktreePath, fetchDiffSwitch]);

  // Select annotation - switches file if needed and scrolls to it
  const handleSelectAnnotation = useCallback((id: string | null) => {
    if (!id) {
      setSelectedAnnotationId(null);
      return;
    }

    // Find the annotation
    const annotation = annotations.find(a => a.id === id);
    if (!annotation) {
      setSelectedAnnotationId(id);
      return;
    }

    // Find and switch to the file containing this annotation
    const fileIndex = files.findIndex(f => f.path === annotation.filePath);
    if (fileIndex !== -1 && fileIndex !== activeFileIndex) {
      handleFileSwitch(fileIndex);
    }

    setSelectedAnnotationId(id);
  }, [annotations, files, activeFileIndex, handleFileSwitch]);

  // Copy raw diff to clipboard
  const handleCopyDiff = useCallback(async () => {
    if (!diffData) return;
    try {
      await navigator.clipboard.writeText(diffData.rawPatch);
      setCopyFeedback('Diff copied!');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      setCopyFeedback('Failed to copy');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [diffData]);

  // Copy feedback markdown to clipboard
  const handleCopyFeedback = useCallback(async () => {
    if (annotations.length === 0) {
      setShowNoAnnotationsDialog(true);
      return;
    }
    try {
      const feedback = exportReviewFeedback(annotations, prMetadata);
      await navigator.clipboard.writeText(feedback);
      setCopyFeedback('Feedback copied!');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      setCopyFeedback('Failed to copy');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [annotations, prMetadata]);

  const activeFile = files[activeFileIndex];
  const feedbackMarkdown = useMemo(() => {
    let output = exportReviewFeedback(annotations, prMetadata);
    if (editorAnnotations.length > 0) {
      output += exportEditorAnnotations(editorAnnotations);
    }
    return output;
  }, [annotations, prMetadata, editorAnnotations]);

  const totalAnnotationCount = annotations.length + editorAnnotations.length;

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
          annotations,
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
  }, [totalAnnotationCount, feedbackMarkdown, annotations]);

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

  // Build the payload for /api/pr-action from current annotations
  const buildPRReviewPayload = useCallback((action: 'approve' | 'comment', generalComment?: string) => {
    const fileAnnotations = annotations.filter(a => (a.scope ?? 'line') === 'line');
    const fileScoped = annotations.filter(a => a.scope === 'file');

    // Top-level body: file-scoped comments
    const bodyParts: string[] = [];
    if (fileScoped.length > 0) {
      for (const ann of fileScoped) {
        if (ann.text) bodyParts.push(`**${ann.filePath}:** ${ann.text}`);
      }
    }
    const body = bodyParts.length > 0
      ? `${generalComment ? generalComment + '\n\n' : ''}Review from Plannotator\n\n${bodyParts.join('\n\n')}`
      : generalComment || 'Review from Plannotator';

    // Inline file comments
    const fileComments = fileAnnotations.map(ann => {
      let commentBody = ann.text ?? '';
      if (ann.suggestedCode) {
        commentBody += `\n\n\`\`\`suggestion\n${ann.suggestedCode}\n\`\`\``;
      }
      const side = (ann.side === 'old' ? 'LEFT' : 'RIGHT') as 'LEFT' | 'RIGHT';
      const isMultiLine = ann.lineStart != null && ann.lineEnd != null && ann.lineStart !== ann.lineEnd;
      return {
        path: ann.filePath,
        line: ann.lineEnd ?? ann.lineStart,
        side,
        body: commentBody.trim(),
        ...(isMultiLine && {
          start_line: ann.lineStart,
          start_side: side,
        }),
      };
    }).filter(c => c.body.length > 0);

    // Editor annotations (VS Code extension) — always on new/RIGHT side
    // Only include annotations targeting files in the diff to avoid GitHub API rejection
    const diffPaths = new Set(files.map(f => f.path));
    for (const ea of editorAnnotations) {
      if (!diffPaths.has(ea.filePath)) continue;
      const body = ea.comment || `> ${ea.selectedText}`;
      if (!body.trim()) continue;
      const isMultiLine = ea.lineStart !== ea.lineEnd;
      fileComments.push({
        path: ea.filePath,
        line: ea.lineEnd,
        side: 'RIGHT' as const,
        body: ea.comment ? `> ${ea.selectedText}\n\n${ea.comment}` : `> ${ea.selectedText}`,
        ...(isMultiLine && {
          start_line: ea.lineStart,
          start_side: 'RIGHT' as const,
        }),
      });
    }

    return { action, body, fileComments };
  }, [annotations, editorAnnotations, files]);

  // Submit a review directly to GitHub
  const handlePlatformAction = useCallback(async (action: 'approve' | 'comment', generalComment?: string) => {
    setIsPlatformActioning(true);
    setPlatformActionError(null);
    try {
      const payload = buildPRReviewPayload(action, generalComment);
      const prRes = await fetch('/api/pr-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const prData = await prRes.json() as { ok?: boolean; prUrl?: string; error?: string };
      if (!prRes.ok || prData.error) {
        setPlatformActionError(prData.error ?? 'Failed to submit PR review');
        setIsPlatformActioning(false);
        return;
      }

      // Open PR in browser (if opted in)
      if (prData.prUrl && platformOpenPR) {
        window.open(prData.prUrl, '_blank');
      }

      // Close the local session with a neutral message — don't send annotations to the agent
      const agentSwitchSettings = getAgentSwitchSettings();
      const effectiveAgent = getEffectiveAgentName(agentSwitchSettings);
      const prLink = prData.prUrl ?? '';
      const statusMessage = action === 'approve'
        ? `${mrLabel === 'MR' ? 'Merge request' : 'Pull request'} approved on ${platformLabel}${prLink ? ': ' + prLink : ''}`
        : `${mrLabel === 'MR' ? 'Merge request' : 'Pull request'} reviewed on ${platformLabel}${prLink ? ': ' + prLink : ''}`;
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: false,
          feedback: statusMessage,
          annotations: [],
          ...(effectiveAgent && { agentSwitch: effectiveAgent }),
        }),
      });
      setSubmitted(action === 'approve' ? 'approved' : 'feedback');
    } catch (err) {
      setPlatformActionError(err instanceof Error ? err.message : 'Failed to submit PR review');
      setIsPlatformActioning(false);
    }
  }, [buildPRReviewPayload, platformOpenPR]);

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

      // If the GitHub comment dialog is open, Cmd+Enter submits it
      if (platformCommentDialog) {
        if (submitted || isPlatformActioning) return;
        const isApproveAction = platformCommentDialog.action === 'approve';
        const canSubmit = isApproveAction || totalAnnotationCount > 0 || platformGeneralComment.trim();
        if (!canSubmit) return;
        e.preventDefault();
        const { action } = platformCommentDialog;
        setPlatformCommentDialog(null);
        handlePlatformAction(action, platformGeneralComment);
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (showExportModal || showNoAnnotationsDialog || showApproveWarning) return;
      if (submitted || isSendingFeedback || isApproving || isPlatformActioning) return;
      if (!origin) return; // Demo mode

      e.preventDefault();

      if (platformMode) {
        // GitHub mode: No annotations → Approve on GitHub, otherwise → Post Review
        const isOwnPR = !!platformUser && prMetadata?.author === platformUser;
        if (totalAnnotationCount === 0 && !isOwnPR) {
          setPlatformGeneralComment('');
          setPlatformCommentDialog({ action: 'approve' });
        } else {
          setPlatformGeneralComment('');
          setPlatformCommentDialog({ action: 'comment' });
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
    showExportModal, showNoAnnotationsDialog, showApproveWarning,
    platformCommentDialog, platformGeneralComment,
    submitted, isSendingFeedback, isApproving, isPlatformActioning,
    origin, platformMode, platformUser, prMetadata, totalAnnotationCount,
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
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        {/* Header */}
        <header className="h-12 flex items-center justify-between px-2 md:px-4 border-b border-border/50 bg-card/50 backdrop-blur-xl z-50">
          <div className="flex items-center gap-2 md:gap-3">
            <a
              href="https://github.com/backnotprop/plannotator"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 md:gap-2 hover:opacity-80 transition-opacity"
            >
              <span className="text-sm font-semibold tracking-tight">Plannotator</span>
            </a>
            <a
              href="https://github.com/backnotprop/plannotator/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground font-mono opacity-60 hidden md:inline hover:opacity-100 transition-opacity"
            >
              v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
            </a>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium hidden md:inline ${
              prMetadata ? 'bg-violet-500/15 text-violet-400' : 'bg-secondary/15 text-secondary'
            }`}>
              {prMetadata ? `${mrLabel} Review` : 'Code Review'}
            </span>
            {prMetadata ? (
              <>
                <span className="text-muted-foreground/40 hidden md:inline">|</span>
                <span className="text-xs text-muted-foreground/60 hidden md:inline-flex items-center gap-1">
                  <RepoIcon className="w-3 h-3" />
                  {displayRepo}
                </span>
                <a
                  href={prMetadata.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent/80 hover:text-accent hidden md:inline-flex items-center gap-1 truncate max-w-[300px] transition-colors"
                  title={prMetadata.title}
                >
                  <PullRequestIcon className="w-3 h-3 flex-shrink-0" />
                  {mrNumberLabel} {prMetadata.title}
                </a>
              </>
            ) : repoInfo ? (
              <>
                <span className="text-muted-foreground/40 hidden md:inline">|</span>
                <span className="text-xs text-muted-foreground/60 hidden md:inline-flex items-center gap-1 truncate max-w-[200px]" title={repoInfo.display}>
                  <RepoIcon className="w-3 h-3 flex-shrink-0" />
                  {repoInfo.display}
                </span>
              </>
            ) : null}
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

            {/* Primary actions */}
            <button
              onClick={handleCopyDiff}
              className="px-2 py-1 md:px-2.5 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors flex items-center gap-1.5"
              title="Copy all raw diffs (Cmd+Shift+C)"
            >
              {copyFeedback === 'Diff copied!' ? (
                <>
                  <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="hidden md:inline">Copied!</span>
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span className="hidden md:inline">Copy Raw Diffs</span>
                </>
              )}
            </button>

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

                {/* Send Feedback button — always the same label */}
                <button
                  onClick={() => {
                    if (platformMode) {
                      setPlatformGeneralComment('');
                      setPlatformCommentDialog({ action: 'comment' });
                    } else {
                      handleSendFeedback();
                    }
                  }}
                  disabled={
                    isSendingFeedback || isApproving || isPlatformActioning ||
                    (!platformMode && totalAnnotationCount === 0)
                  }
                  className={`p-1.5 md:px-2.5 md:py-1 rounded-md text-xs font-medium transition-all ${
                    isSendingFeedback || isApproving || isPlatformActioning
                      ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                      : !platformMode && totalAnnotationCount === 0
                        ? 'opacity-50 cursor-not-allowed bg-accent/10 text-accent/50'
                        : 'bg-accent/15 text-accent hover:bg-accent/25 border border-accent/30'
                  }`}
                  title={!platformMode && totalAnnotationCount === 0 ? "Add annotations to send feedback" : "Send feedback"}
                >
                  <svg className="w-4 h-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <span className="hidden md:inline">{
                    isSendingFeedback || isPlatformActioning
                      ? (platformMode ? 'Posting...' : 'Sending...')
                      : (platformMode ? 'Post Comments' : 'Send Feedback')
                  }</span>
                </button>

                {/* Approve button — always the same label */}
                <div className="relative group/approve">
                  <button
                    onClick={() => {
                      if (platformMode) {
                        if (platformUser && prMetadata?.author === platformUser) return;
                        setPlatformGeneralComment('');
                        setPlatformCommentDialog({ action: 'approve' });
                      } else {
                        if (totalAnnotationCount > 0) {
                          setShowApproveWarning(true);
                        } else {
                          handleApprove();
                        }
                      }
                    }}
                    disabled={
                      isSendingFeedback || isApproving || isPlatformActioning ||
                      (platformMode && !!platformUser && prMetadata?.author === platformUser)
                    }
                    className={`px-2 py-1 md:px-2.5 rounded-md text-xs font-medium transition-all ${
                      isSendingFeedback || isApproving || isPlatformActioning
                        ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                        : platformMode && platformUser && prMetadata?.author === platformUser
                          ? 'opacity-40 cursor-not-allowed bg-muted text-muted-foreground'
                          : !platformMode && totalAnnotationCount > 0
                            ? 'bg-success/50 text-success-foreground/70 hover:bg-success hover:text-success-foreground'
                            : 'bg-success text-success-foreground hover:opacity-90'
                    }`}
                    title={
                      platformMode && platformUser && prMetadata?.author === platformUser
                        ? `You can't approve your own ${mrLabel}`
                        : "Approve - no changes needed"
                    }
                  >
                    <span className="md:hidden">{isApproving ? '...' : 'OK'}</span>
                    <span className="hidden md:inline">{isApproving ? 'Approving...' : 'Approve'}</span>
                  </button>
                  {/* Tooltip: own PR warning OR annotations-lost warning */}
                  {platformMode && platformUser && prMetadata?.author === platformUser ? (
                    <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-48 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
                      <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
                      <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
                      You can't approve your own {mrLabel === 'MR' ? 'merge request' : 'pull request'} on {platformLabel}.
                    </div>
                  ) : !platformMode && totalAnnotationCount > 0 ? (
                    <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-56 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
                      <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
                      <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
                      Your {totalAnnotationCount} annotation{totalAnnotationCount !== 1 ? 's' : ''} won't be sent if you approve.
                    </div>
                  ) : null}
                </div>
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
            <ModeToggle />
            <Settings
              taterMode={false}
              onTaterModeChange={() => {}}
              onIdentityChange={handleIdentityChange}
              origin={origin}
              mode="review"
            />

            {/* Panel toggle */}
            <button
              onClick={() => setIsPanelOpen(!isPanelOpen)}
              className={`p-1.5 rounded-md text-xs font-medium transition-all ${
                isPanelOpen
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              title={isPanelOpen ? 'Hide annotations' : 'Show annotations'}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </button>

            {/* Export */}
            <button
              onClick={() => setShowExportModal(true)}
              className="p-1.5 md:px-2.5 md:py-1 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
              title="Export"
            >
              <svg className="w-4 h-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <span className="hidden md:inline">Export</span>
            </button>
          </div>
        </header>

        {/* Main content */}
        <div className={`flex-1 flex overflow-hidden ${isResizing ? 'select-none' : ''}`}>
          {/* File tree sidebar - show when multiple files OR diff options available */}
          {(files.length > 1 || gitContext?.diffOptions) && (
            <>
              <FileTree
                files={files}
                activeFileIndex={activeFileIndex}
                onSelectFile={handleFileSwitch}
                annotations={annotations}
                viewedFiles={viewedFiles}
                onToggleViewed={handleToggleViewed}
                hideViewedFiles={hideViewedFiles}
                onToggleHideViewed={() => setHideViewedFiles(prev => !prev)}
                enableKeyboardNav={!showExportModal}
                diffOptions={gitContext?.diffOptions}
                activeDiffType={activeDiffBase}
                onSelectDiff={handleDiffSwitch}
                isLoadingDiff={isLoadingDiff}
                width={fileTreeResize.width}
                worktrees={gitContext?.worktrees}
                activeWorktreePath={activeWorktreePath}
                onSelectWorktree={handleWorktreeSwitch}
                currentBranch={gitContext?.currentBranch}
                stagedFiles={stagedFiles}
                searchQuery={searchQuery}
                searchInputRef={searchInputRef}
                onSearchChange={handleSearchInputChange}
                onSearchClear={clearSearch}
                searchGroups={searchGroups}
                searchMatches={searchMatches}
                activeSearchMatchId={activeSearchMatchId}
                onSelectSearchMatch={handleSelectSearchMatch}
                onStepSearchMatch={stepSearchMatch}
              />
              <ResizeHandle {...fileTreeResize.handleProps} side="left" />
            </>
          )}

          {/* Diff viewer */}
          <main className="flex-1 min-w-0 overflow-hidden">
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
            {activeFile ? (
              <DiffViewer
                patch={activeFile.patch}
                filePath={activeFile.path}
                oldPath={activeFile.oldPath}
                diffStyle={diffStyle}
                annotations={activeFileAnnotations}
                selectedAnnotationId={selectedAnnotationId}
                pendingSelection={pendingSelection}
                onLineSelection={handleLineSelection}
                onAddAnnotation={handleAddAnnotation}
                onAddFileComment={handleAddFileComment}
                onEditAnnotation={handleEditAnnotation}
                onSelectAnnotation={handleSelectAnnotation}
                onDeleteAnnotation={handleDeleteAnnotation}
                isViewed={viewedFiles.has(activeFile.path)}
                onToggleViewed={() => handleToggleViewed(activeFile.path)}
                isStaged={stagedFiles.has(activeFile.path)}
                isStaging={stagingFile === activeFile.path}
                onStage={() => stageFile(activeFile.path)}
                canStage={canStageFiles}
                stageError={stageError}
                searchQuery={searchQuery}
                searchMatches={activeFileSearchMatches}
                activeSearchMatchId={activeSearchMatchId}
                activeSearchMatch={activeSearchMatch?.filePath === activeFile.path ? activeSearchMatch : null}
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
                          {activeDiffBase === 'branch' && `No changes vs ${gitContext?.defaultBranch || 'main'}${activeWorktreePath ? ' in this worktree' : ''}.`}
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
          </main>

          {/* Resize Handle */}
          {isPanelOpen && <ResizeHandle {...panelResize.handleProps} side="right" />}

          {/* Annotations panel */}
          <ReviewPanel
            isOpen={isPanelOpen}
            onToggle={() => setIsPanelOpen(!isPanelOpen)}
            annotations={annotations}
            files={files}
            selectedAnnotationId={selectedAnnotationId}
            onSelectAnnotation={handleSelectAnnotation}
            onDeleteAnnotation={handleDeleteAnnotation}
            feedbackMarkdown={feedbackMarkdown}
            width={panelResize.width}
            editorAnnotations={editorAnnotations}
            onDeleteEditorAnnotation={deleteEditorAnnotation}
            prMetadata={prMetadata}
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
                  {annotations.length} annotation{annotations.length !== 1 ? 's' : ''}
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

        {/* Completion overlay - shown after approve/feedback */}
        <CompletionOverlay
          submitted={submitted}
          title={submitted === 'approved' ? 'Changes Approved' : 'Feedback Sent'}
          subtitle={
            platformMode
              ? submitted === 'approved'
                ? `Your approval was submitted to ${platformLabel}.`
                : `Your feedback was submitted to ${platformLabel}.`
              : submitted === 'approved'
                ? `${origin === 'claude-code' ? 'Claude Code' : origin === 'opencode' ? 'OpenCode' : origin === 'pi' ? 'Pi' : 'Your agent'} will proceed with the changes.`
                : `${origin === 'claude-code' ? 'Claude Code' : origin === 'opencode' ? 'OpenCode' : origin === 'pi' ? 'Pi' : 'Your agent'} will address your review feedback.`
          }
          agentLabel={origin === 'claude-code' ? 'Claude Code' : origin === 'opencode' ? 'OpenCode' : origin === 'pi' ? 'Pi' : 'Your agent'}
        />

        {/* Update notification */}
        <UpdateBanner origin={origin} />

        {/* GitHub general comment dialog */}
        {platformCommentDialog && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
            <div className="bg-card border border-border rounded-xl w-full max-w-sm shadow-2xl p-6">
              <h3 className="font-semibold mb-1">
                {platformCommentDialog.action === 'approve' ? `Approve ${mrLabel}` : 'Post Review Comment'}
              </h3>
              <p className="text-sm text-muted-foreground mb-3">
                Add a general comment to the review (optional).
              </p>
              <textarea
                autoFocus
                value={platformGeneralComment}
                onChange={e => setPlatformGeneralComment(e.target.value)}
                placeholder="Leave a comment..."
                rows={4}
                className="w-full rounded-md border border-border bg-background text-sm px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary mb-3"
              />
              <label className="flex items-center gap-2 text-sm text-muted-foreground mb-4 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={platformOpenPR}
                  onChange={e => {
                    setPlatformOpenPR(e.target.checked);
                    storage.setItem('plannotator-github-open-pr', String(e.target.checked));
                  }}
                  className="rounded border-border"
                />
                Open {mrLabel} after submitting
              </label>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setPlatformCommentDialog(null)}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-muted text-muted-foreground hover:bg-muted/80"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const { action } = platformCommentDialog;
                    setPlatformCommentDialog(null);
                    handlePlatformAction(action, platformGeneralComment);
                  }}
                  disabled={platformCommentDialog.action !== 'approve' && totalAnnotationCount === 0 && !platformGeneralComment.trim()}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-opacity ${
                    platformCommentDialog.action !== 'approve' && totalAnnotationCount === 0 && !platformGeneralComment.trim()
                      ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                      : platformCommentDialog.action === 'approve'
                        ? 'bg-success text-success-foreground hover:opacity-90'
                        : 'bg-primary text-primary-foreground hover:opacity-90'
                  }`}
                >
                  {platformCommentDialog.action === 'approve' ? 'Approve' : 'Post Comments'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ThemeProvider>
  );
};

export default ReviewApp;
