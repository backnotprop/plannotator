import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { toast, Toaster } from 'sonner';
import { type Origin, getAgentName } from '@plannotator/shared/agents';
import { parseMarkdownToBlocks, exportAnnotations, exportLinkedDocAnnotations, exportEditorAnnotations, exportCodeFileAnnotations, extractFrontmatter, wrapFeedbackForAgent, Frontmatter, type LinkedDocAnnotationEntry } from '@plannotator/ui/utils/parser';
import { Viewer, ViewerHandle } from '@plannotator/ui/components/Viewer';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { ExportModal } from '@plannotator/ui/components/ExportModal';
import { ImportModal } from '@plannotator/ui/components/ImportModal';
import { ConfirmDialog } from '@plannotator/ui/components/ConfirmDialog';
import { Annotation, Block, EditorMode, type CodeAnnotation, type InputMethod, type ImageAttachment, type ActionsLabelMode } from '@plannotator/ui/types';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { Tooltip, TooltipProvider } from '@plannotator/ui/components/Tooltip';
import { AnnotationToolstrip } from '@plannotator/ui/components/AnnotationToolstrip';
import { StickyHeaderLane } from '@plannotator/ui/components/StickyHeaderLane';
import { TaterSpriteRunning } from '@plannotator/ui/components/TaterSpriteRunning';
import { TaterSpritePullup } from '@plannotator/ui/components/TaterSpritePullup';
import { useSharing } from '@plannotator/ui/hooks/useSharing';
import { getCallbackConfig, CallbackAction, executeCallback } from '@plannotator/ui/utils/callback';
import { useAgents } from '@plannotator/ui/hooks/useAgents';
import { useActiveSection } from '@plannotator/ui/hooks/useActiveSection';
import { storage } from '@plannotator/ui/utils/storage';
import { configStore } from '@plannotator/ui/config';
import { CompletionOverlay } from '@plannotator/ui/components/CompletionOverlay';
import { UpdateBanner } from '@plannotator/ui/components/UpdateBanner';
import { getObsidianSettings, getEffectiveVaultPath, isObsidianConfigured, CUSTOM_PATH_SENTINEL } from '@plannotator/ui/utils/obsidian';
import { getBearSettings } from '@plannotator/ui/utils/bear';
import { getOctarineSettings, isOctarineConfigured } from '@plannotator/ui/utils/octarine';
import { getDefaultNotesApp } from '@plannotator/ui/utils/defaultNotesApp';
import { getAgentSwitchSettings, getEffectiveAgentName } from '@plannotator/ui/utils/agentSwitch';
import { getPlanSaveSettings } from '@plannotator/ui/utils/planSave';
import { getUIPreferences, type UIPreferences, type PlanWidth } from '@plannotator/ui/utils/uiPreferences';
import { getEditorMode, saveEditorMode } from '@plannotator/ui/utils/editorMode';
import { getInputMethod, saveInputMethod } from '@plannotator/ui/utils/inputMethod';
import { useInputMethodSwitch } from '@plannotator/ui/hooks/useInputMethodSwitch';
import { usePrintMode } from '@plannotator/ui/hooks/usePrintMode';
import { useResizablePanel } from '@plannotator/ui/hooks/useResizablePanel';
import { ResizeHandle } from '@plannotator/ui/components/ResizeHandle';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { ScrollViewportContext } from '@plannotator/ui/hooks/useScrollViewport';
import { useOverlayViewport } from '@plannotator/ui/hooks/useOverlayViewport';
import { useIsMobile } from '@plannotator/ui/hooks/useIsMobile';
import {
  getPermissionModeSettings,
  needsPermissionModeSetup,
  type PermissionMode,
} from '@plannotator/ui/utils/permissionMode';
import { PermissionModeSetup } from '@plannotator/ui/components/PermissionModeSetup';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';
import { deriveImageName } from '@plannotator/ui/components/AttachmentsButton';
import { useSidebar, type SidebarTab } from '@plannotator/ui/hooks/useSidebar';
import { usePlanDiff, type VersionInfo } from '@plannotator/ui/hooks/usePlanDiff';
import { useLinkedDoc } from '@plannotator/ui/hooks/useLinkedDoc';
import { useCodeFilePopout } from '@plannotator/ui/hooks/useCodeFilePopout';
import { useAnnotationDraft } from '@plannotator/ui/hooks/useAnnotationDraft';
import { useArchive } from '@plannotator/ui/hooks/useArchive';
import { useEditorAnnotations } from '@plannotator/ui/hooks/useEditorAnnotations';
import { useExternalAnnotations } from '@plannotator/ui/hooks/useExternalAnnotations';
import { useExternalAnnotationHighlights } from '@plannotator/ui/hooks/useExternalAnnotationHighlights';
import { buildPlanAgentInstructions } from '@plannotator/ui/utils/planAgentInstructions';
import { useFileBrowser } from '@plannotator/ui/hooks/useFileBrowser';
import { isVaultBrowserEnabled } from '@plannotator/ui/utils/obsidian';
import { isFileBrowserEnabled, getFileBrowserSettings } from '@plannotator/ui/utils/fileBrowser';
import { generateId } from '@plannotator/ui/utils/generateId';
import { SidebarTabs } from '@plannotator/ui/components/sidebar/SidebarTabs';
import { SidebarContainer } from '@plannotator/ui/components/sidebar/SidebarContainer';
import type { ArchivedPlan } from '@plannotator/ui/components/sidebar/ArchiveBrowser';
import { PlanDiffViewer } from '@plannotator/ui/components/plan-diff/PlanDiffViewer';
import { CodeFilePopout, type CodeFileAnnotationInput } from '@plannotator/ui/components/CodeFilePopout';
import type { PlanDiffMode } from '@plannotator/ui/components/plan-diff/PlanDiffModeSwitcher';
// Demo content toggle. Default: the original Real-time Collaboration plan.
// Opt-in diff-engine stress test: `VITE_DIFF_DEMO=1 bun run dev:hook` swaps
// in the 20-case Auth Service Refactor test plan. dev-mock-api.ts reads the
// same env var on the server side so V2/V3 stay paired.
import { DEMO_PLAN_CONTENT as DEFAULT_DEMO_PLAN_CONTENT } from './demoPlan';
import { DIFF_DEMO_PLAN_CONTENT } from './demoPlanDiffDemo';
import { canUseAnnotateWideMode, resolveWideModeExitLayout, type WideModeLayoutSnapshot, type WideModeType } from './wideMode';
const USE_DIFF_DEMO =
  import.meta.env.VITE_DIFF_DEMO === '1' ||
  import.meta.env.VITE_DIFF_DEMO === 'true';
const DEMO_PLAN_CONTENT = USE_DIFF_DEMO
  ? DIFF_DEMO_PLAN_CONTENT
  : DEFAULT_DEMO_PLAN_CONTENT;
import { useCheckboxOverrides } from './hooks/useCheckboxOverrides';
import { AppHeader } from './components/AppHeader';

type NoteAutoSaveResults = {
  obsidian?: boolean;
  bear?: boolean;
  octarine?: boolean;
};

const App: React.FC = () => {
  const [markdown, setMarkdown] = useState(DEMO_PLAN_CONTENT);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [codeAnnotations, setCodeAnnotations] = useState<CodeAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedCodeAnnotationId, setSelectedCodeAnnotationId] = useState<string | null>(null);
  const frontmatter = useMemo(() => extractFrontmatter(markdown).frontmatter, [markdown]);
  const blocks = useMemo(() => parseMarkdownToBlocks(markdown), [markdown]);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFeedbackPrompt, setShowFeedbackPrompt] = useState(false);
  const [showClaudeCodeWarning, setShowClaudeCodeWarning] = useState(false);
  const [showExitWarning, setShowExitWarning] = useState(false);
  // When the warning dialog confirms, route to the handler matching the button that opened it.
  const [exitWarningAction, setExitWarningAction] = useState<'close' | 'approve'>('close');
  const [showAgentWarning, setShowAgentWarning] = useState(false);
  const [agentWarningMessage, setAgentWarningMessage] = useState('');
  const [isPanelOpen, setIsPanelOpen] = useState(() => window.innerWidth >= 768);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(getEditorMode);
  const [inputMethod, setInputMethod] = useState<InputMethod>(getInputMethod);
  const [taterMode, setTaterMode] = useState(() => {
    const stored = storage.getItem('plannotator-tater-mode');
    return stored === 'true';
  });
  const [uiPrefs, setUiPrefs] = useState(() => getUIPreferences());

  // Plan-area width (inside the OverlayScrollArea, after sidebar/panel
  // shrinkage) drives the action button label compactness. ResizeObserver
  // fires every frame during a resize drag, so we store only the BUCKET
  // ('full' | 'short' | 'icon') in state — App.tsx then re-renders at
  // most twice across an entire drag (once per threshold crossing) instead
  // of on every pixel, which would chug the whole tree.
  //
  //   full  → "Global comment" / "Copy plan"  — fits when planArea >= 800
  //   short → "Comment" / "Copy"              — fits when planArea >= 680
  //   icon  → labels hidden                    — fallback below that
  const planAreaRef = useRef<HTMLDivElement>(null);
  const [actionsLabelMode, setActionsLabelMode] = useState<ActionsLabelMode>('full');
  // useLayoutEffect + synchronous getBoundingClientRect so the initial
  // bucket is set before the browser paints. Otherwise narrow viewports
  // get a one-frame flash of "Global comment"/"Copy plan" labels before
  // the ResizeObserver callback collapses them.
  useLayoutEffect(() => {
    const el = planAreaRef.current;
    if (!el) return;
    const bucket = (w: number): ActionsLabelMode =>
      w >= 800 ? 'full' : w >= 680 ? 'short' : 'icon';
    setActionsLabelMode(bucket(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => {
      const next = bucket(entry.contentRect.width);
      setActionsLabelMode((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [isApiMode, setIsApiMode] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [gitUser, setGitUser] = useState<string | undefined>();
  const [isWSL, setIsWSL] = useState(false);
  const [globalAttachments, setGlobalAttachments] = useState<ImageAttachment[]>([]);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [gate, setGate] = useState(false);
  const [annotateSource, setAnnotateSource] = useState<'file' | 'message' | 'folder' | null>(null);
  const [sourceInfo, setSourceInfo] = useState<string | undefined>();
  const [sourceConverted, setSourceConverted] = useState(false);
  const [renderAs, setRenderAs] = useState<'markdown' | 'html'>('markdown');
  const [rawHtml, setRawHtml] = useState('');
  const [sourceFilePath, setSourceFilePath] = useState<string | undefined>();
  const [imageBaseDir, setImageBaseDir] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [submitted, setSubmitted] = useState<'approved' | 'denied' | 'exited' | null>(null);
  const [pendingPasteImage, setPendingPasteImage] = useState<{ file: File; blobUrl: string; initialName: string } | null>(null);
  const [showPermissionModeSetup, setShowPermissionModeSetup] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [sharingEnabled, setSharingEnabled] = useState(true);
  const [shareBaseUrl, setShareBaseUrl] = useState<string | undefined>(undefined);
  const [pasteApiUrl, setPasteApiUrl] = useState<string | undefined>(undefined);
  const [repoInfo, setRepoInfo] = useState<{ display: string; branch?: string; host?: string } | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [wideModeType, setWideModeType] = useState<WideModeType | null>(null);
  const wideModeSnapshotRef = useRef<WideModeLayoutSnapshot | null>(null);
  const lastAppliedTocEnabledRef = useRef(uiPrefs.tocEnabled);

  useEffect(() => {
    document.title = repoInfo ? `${repoInfo.display} · Plannotator` : "Plannotator";
  }, [repoInfo]);

  const [initialExportTab, setInitialExportTab] = useState<'share' | 'annotations' | 'notes'>();
  const [isPlanDiffActive, setIsPlanDiffActive] = useState(false);
  const [planDiffMode, setPlanDiffMode] = useState<PlanDiffMode>('clean');
  const [previousPlan, setPreviousPlan] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const isMobile = useIsMobile();

  const viewerRef = useRef<ViewerHandle>(null);
  // containerRef + scrollViewport both point at the OverlayScrollbars
  // viewport element (the node that actually scrolls), not the <main>
  // host. Consumers: useActiveSection (IntersectionObserver root) and
  // everything reading ScrollViewportContext.
  const {
    ref: containerRef,
    viewport: scrollViewport,
    onViewportReady: handleViewportReady,
  } = useOverlayViewport();

  usePrintMode();

  // Resizable panels
  const panelResize = useResizablePanel({ storageKey: 'plannotator-panel-width' });
  const tocResize = useResizablePanel({
    storageKey: 'plannotator-toc-width',
    defaultWidth: 240, minWidth: 160, maxWidth: 400, side: 'left',
  });
  const isResizing = panelResize.isDragging || tocResize.isDragging;

  // Sidebar (shared TOC + Version Browser)
  const sidebar = useSidebar(getUIPreferences().tocEnabled);

  // Whether the document has any TOC-eligible headings (level <= 3, matching
  // buildTocHierarchy). Drives the empty-doc auto-close behavior below — must
  // be declared before the effects that reference it (TDZ in dep arrays).
  const hasTocEntries = useMemo(
    () => blocks.some(b => b.type === 'heading' && (b.level ?? 0) <= 3),
    [blocks]
  );

  const exitWideMode = useCallback((options?: {
    restore?: boolean;
    sidebarTab?: SidebarTab;
    panelOpen?: boolean;
  }) => {
    if (wideModeType === null) {
      if (options?.sidebarTab) sidebar.open(options.sidebarTab);
      if (options?.panelOpen === true) setIsPanelOpen(true);
      else if (options?.panelOpen === false) setIsPanelOpen(false);
      return;
    }

    const snapshot = wideModeSnapshotRef.current;
    const layout = resolveWideModeExitLayout(snapshot, options);

    setWideModeType(null);
    wideModeSnapshotRef.current = null;

    if (layout.sidebarOpen && layout.sidebarTab) {
      sidebar.open(layout.sidebarTab);
    } else {
      sidebar.close();
    }

    if (layout.panelOpen !== undefined) {
      setIsPanelOpen(layout.panelOpen);
    }
  }, [wideModeType, sidebar.close, sidebar.open]);

  const openSidebarTab = useCallback((tab: SidebarTab) => {
    if (wideModeType !== null) {
      exitWideMode({ restore: false, sidebarTab: tab, panelOpen: false });
      return;
    }
    sidebar.open(tab);
  }, [exitWideMode, wideModeType, sidebar.open]);

  const toggleSidebarTab = useCallback((tab: SidebarTab) => {
    if (wideModeType !== null) {
      exitWideMode({ restore: false, sidebarTab: tab, panelOpen: false });
      return;
    }
    sidebar.toggleTab(tab);
  }, [exitWideMode, wideModeType, sidebar.toggleTab]);

  const handleAnnotationPanelToggle = useCallback(() => {
    if (wideModeType !== null) {
      exitWideMode({ restore: false, panelOpen: true });
      return;
    }
    setIsPanelOpen(prev => !prev);
  }, [exitWideMode, wideModeType]);

  // Sync sidebar open state when preference changes in Settings
  useEffect(() => {
    if (wideModeType !== null) return;
    if (lastAppliedTocEnabledRef.current === uiPrefs.tocEnabled) return;
    lastAppliedTocEnabledRef.current = uiPrefs.tocEnabled;
    if (uiPrefs.tocEnabled && hasTocEntries) sidebar.open('toc');
    else if (!uiPrefs.tocEnabled) sidebar.close();
  }, [wideModeType, sidebar.close, sidebar.open, uiPrefs.tocEnabled, hasTocEntries]);

  // Auto-close the sidebar when blocks parse with no TOC entries. Fires
  // only on blocks/hasTocEntries change (not on sidebar state) so a user
  // who manually re-opens the empty sidebar is left alone — until the
  // document changes again (e.g. picking a new file in annotate-folder).
  useEffect(() => {
    if (blocks.length === 0) return;
    if (hasTocEntries) return;
    if (sidebar.activeTab === 'toc' && sidebar.isOpen) {
      sidebar.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, hasTocEntries]);

  // Clear diff view when switching away from versions tab
  useEffect(() => {
    if (sidebar.activeTab === 'toc' && isPlanDiffActive) {
      setIsPlanDiffActive(false);
    }
  }, [sidebar.activeTab]);

  // Clear diff view on Escape key
  useEffect(() => {
    if (!isPlanDiffActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPlanDiffActive(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPlanDiffActive]);

  // Plan diff computation
  const planDiff = usePlanDiff(markdown, previousPlan, versionInfo);

  const linkedDocSidebar = useMemo(() => ({
    ...sidebar,
    open: openSidebarTab,
    toggleTab: toggleSidebarTab,
  }), [
    openSidebarTab,
    sidebar.activeTab,
    sidebar.close,
    sidebar.isOpen,
    toggleSidebarTab,
  ]);

  // Linked document navigation
  const linkedDocHook = useLinkedDoc({
    markdown, annotations, selectedAnnotationId, globalAttachments,
    setMarkdown, setAnnotations, setSelectedAnnotationId, setGlobalAttachments,
    viewerRef, sidebar: linkedDocSidebar, sourceFilePath, sourceConverted,
  });

  // Active document's directory — feeds both click-time popout fetches and
  // the validator hook so they resolve against the same base. Drifting
  // these would silently re-introduce the demote-correct-link bug.
  const activeDocBaseDir = useMemo(
    () => linkedDocHook.filepath
      ? linkedDocHook.filepath.replace(/\/[^/]+$/, '')
      : imageBaseDir?.includes('/') ? imageBaseDir : undefined,
    [linkedDocHook.filepath, imageBaseDir],
  );

  // Code file popout (read-only syntax-highlighted overlay)
  const codeFilePopout = useCodeFilePopout({
    buildUrl: useCallback((codePath: string) => {
      return activeDocBaseDir
        ? `/api/doc?path=${encodeURIComponent(codePath)}&base=${encodeURIComponent(activeDocBaseDir)}`
        : `/api/doc?path=${encodeURIComponent(codePath)}`;
    }, [activeDocBaseDir]),
  });

  // Archive browser
  const archive = useArchive({
    markdown, viewerRef, linkedDocHook,
    setMarkdown, setAnnotations, setSelectedAnnotationId, setSubmitted,
  });

  const canUseWideMode = useMemo(() => canUseAnnotateWideMode({
    archiveMode: archive.archiveMode,
    isPlanDiffActive,
  }), [archive.archiveMode, isPlanDiffActive]);

  const enterViewMode = useCallback((type: WideModeType) => {
    if (!canUseWideMode) return;
    if (wideModeType === null) {
      wideModeSnapshotRef.current = {
        sidebarIsOpen: sidebar.isOpen,
        sidebarTab: sidebar.activeTab,
        panelOpen: isPanelOpen,
      };
    }
    setWideModeType(type);
    sidebar.close();
    setIsPanelOpen(false);
  }, [canUseWideMode, isPanelOpen, wideModeType, sidebar.activeTab, sidebar.close, sidebar.isOpen]);

  const toggleViewMode = useCallback((type: WideModeType) => {
    if (wideModeType === type) {
      exitWideMode();
    } else {
      enterViewMode(type);
    }
  }, [enterViewMode, exitWideMode, wideModeType]);

  useEffect(() => {
    if (!canUseWideMode && wideModeType !== null) {
      exitWideMode();
    }
  }, [canUseWideMode, exitWideMode, wideModeType]);

  // Markdown file browser (also handles vault dirs via isVault flag)
  const fileBrowser = useFileBrowser();
  const vaultPath = useMemo(() => {
    if (!isVaultBrowserEnabled()) return '';
    return getEffectiveVaultPath(getObsidianSettings());
  }, [uiPrefs]);
  const showFilesTab = useMemo(
    () => !!projectRoot || isFileBrowserEnabled() || isVaultBrowserEnabled(),
    [projectRoot, uiPrefs]
  );
  const fileBrowserDirs = useMemo(() => {
    const projectDirs = projectRoot ? [projectRoot] : [];
    const userDirs = isFileBrowserEnabled()
      ? getFileBrowserSettings().directories
      : [];
    return [...new Set([...projectDirs, ...userDirs])];
  }, [projectRoot, uiPrefs]);

  // Clear active file when file browser is disabled
  useEffect(() => {
    if (!showFilesTab) fileBrowser.setActiveFile(null);
  }, [showFilesTab]);

  // When vault is disabled, prune any stale vault dirs immediately
  useEffect(() => {
    if (!vaultPath) fileBrowser.clearVaultDirs();
  }, [vaultPath]);

  useEffect(() => {
    if (sidebar.activeTab === 'files' && showFilesTab) {
      // Load regular dirs
      if (fileBrowserDirs.length > 0) {
        const regularLoaded = fileBrowser.dirs.filter(d => !d.isVault).map(d => d.path);
        const needsRegular = fileBrowserDirs.some(d => !regularLoaded.includes(d))
          || regularLoaded.some(d => !fileBrowserDirs.includes(d));
        if (needsRegular) fileBrowser.fetchAll(fileBrowserDirs);
      }
      // Load vault dir; addVaultDir atomically replaces any existing vault entry so
      // switching vault paths never accumulates stale sections
      if (vaultPath && !fileBrowser.dirs.find(d => d.isVault && d.path === vaultPath && !d.error)) {
        fileBrowser.addVaultDir(vaultPath);
      }
    }
  }, [sidebar.activeTab, showFilesTab, fileBrowserDirs, vaultPath]);

  // File browser file selection: open via linked doc system
  // For vault dirs (isVault), use the Obsidian doc endpoint; otherwise use generic /api/doc
  const handleFileBrowserSelect = React.useCallback((absolutePath: string, dirPath: string) => {
    const dirState = fileBrowser.dirs.find(d => d.path === dirPath);
    const buildUrl = dirState?.isVault
      ? (path: string) => `/api/reference/obsidian/doc?vaultPath=${encodeURIComponent(dirPath)}&path=${encodeURIComponent(path)}`
      : (path: string) => `/api/doc?path=${encodeURIComponent(path)}&base=${encodeURIComponent(dirPath)}`;
    linkedDocHook.open(absolutePath, buildUrl, 'files');
    fileBrowser.setActiveFile(absolutePath);
  }, [linkedDocHook, fileBrowser]);

  // Route linked doc opens through the correct endpoint based on current context
  const handleOpenLinkedDoc = React.useCallback((docPath: string) => {
    const activeDirState = fileBrowser.dirs.find(d => d.path === fileBrowser.activeDirPath);
    if (activeDirState?.isVault && fileBrowser.activeDirPath) {
      linkedDocHook.open(docPath, (path) =>
        `/api/reference/obsidian/doc?vaultPath=${encodeURIComponent(fileBrowser.activeDirPath!)}&path=${encodeURIComponent(path)}`
      );
    } else if (fileBrowser.activeFile && fileBrowser.activeDirPath) {
      // When viewing a file browser doc, resolve links relative to current file's directory
      const baseDir = linkedDocHook.filepath?.replace(/\/[^/]+$/, '') || fileBrowser.activeDirPath;
      linkedDocHook.open(docPath, (path) =>
        `/api/doc?path=${encodeURIComponent(path)}&base=${encodeURIComponent(baseDir)}`
      );
    } else {
      // Pass the current file's directory as base for relative path resolution
      const baseDir = linkedDocHook.filepath
        ? linkedDocHook.filepath.replace(/\/[^/]+$/, '')
        : imageBaseDir?.includes('/') ? imageBaseDir : undefined;
      if (baseDir) {
        linkedDocHook.open(docPath, (path) =>
          `/api/doc?path=${encodeURIComponent(path)}&base=${encodeURIComponent(baseDir)}`
        );
      } else {
        linkedDocHook.open(docPath);
      }
    }
  }, [fileBrowser.dirs, fileBrowser.activeDirPath, fileBrowser.activeFile, linkedDocHook, imageBaseDir]);

  // Wrap linked doc back to also clear file browser active file
  const handleLinkedDocBack = React.useCallback(() => {
    linkedDocHook.back();
    fileBrowser.setActiveFile(null);
    archive.clearSelection();
  }, [linkedDocHook, fileBrowser, archive]);

  // Derive annotation counts per file from linked doc cache (includes active doc's live state)
  const allAnnotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [fp, cached] of linkedDocHook.getDocAnnotations()) {
      const count = cached.annotations.length + cached.globalAttachments.length;
      if (count > 0) counts.set(fp, count);
    }
    return counts;
  }, [linkedDocHook.getDocAnnotations, annotations, globalAttachments]);

  // FileBrowser counts: all files under any loaded dir (regular + vault)
  const fileAnnotationCounts = useMemo(() => {
    const allDirPaths = fileBrowser.dirs.map(d => d.path);
    if (allDirPaths.length === 0) return allAnnotationCounts;
    const counts = new Map<string, number>();
    for (const [fp, count] of allAnnotationCounts) {
      if (allDirPaths.some(dir => fp.startsWith(dir + '/'))) {
        counts.set(fp, count);
      }
    }
    return counts;
  }, [allAnnotationCounts, fileBrowser.dirs]);

  const hasFileAnnotations = fileAnnotationCounts.size > 0;

  // Annotations in other files (not the current view) — for the right panel "+N" indicator
  const otherFileAnnotations = useMemo(() => {
    const currentFile = linkedDocHook.filepath;
    let count = 0;
    let files = 0;
    for (const [fp, n] of allAnnotationCounts) {
      if (fp !== currentFile) {
        count += n;
        files++;
      }
    }
    return count > 0 ? { count, files } : undefined;
  }, [allAnnotationCounts, linkedDocHook.filepath]);

  // Flash highlight for annotated files in the sidebar
  const [highlightedFiles, setHighlightedFiles] = useState<Set<string> | undefined>();
  const flashTimerRef = React.useRef<ReturnType<typeof setTimeout>>();
  const handleFlashAnnotatedFiles = React.useCallback(() => {
    const filePaths = new Set(allAnnotationCounts.keys());
    if (filePaths.size === 0) return;
    // Open sidebar to the files tab so the flash is visible
    if (!sidebar.isOpen || sidebar.activeTab !== 'files') {
      openSidebarTab('files');
    }
    // Cancel any pending clear from a previous flash
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    // Clear first so re-triggering restarts the CSS animation
    setHighlightedFiles(undefined);
    requestAnimationFrame(() => {
      setHighlightedFiles(filePaths);
      flashTimerRef.current = setTimeout(() => setHighlightedFiles(undefined), 1200);
    });
  }, [allAnnotationCounts, openSidebarTab, sidebar, hasFileAnnotations]);

  // Context-aware back label for linked doc navigation
  const backLabel = annotateSource === 'folder' ? 'file list'
    : annotateSource === 'file' ? 'file'
    : annotateSource === 'message' ? 'message'
    : 'plan';

  // Track active section for TOC highlighting
  const headingCount = useMemo(() => blocks.filter(b => b.type === 'heading').length, [blocks]);
  const activeSection = useActiveSection(containerRef, headingCount, scrollViewport);

  const { editorAnnotations, deleteEditorAnnotation } = useEditorAnnotations();
  const { externalAnnotations, updateExternalAnnotation, deleteExternalAnnotation } = useExternalAnnotations<Annotation>({ enabled: isApiMode });

  // Drive DOM highlights for SSE-delivered external annotations. Disabled
  // while a linked doc overlay is open (Viewer DOM is hidden) and while the
  // plan diff view is active (diff view has its own annotation surface).
  const { reset: resetExternalHighlights } = useExternalAnnotationHighlights({
    viewerRef,
    externalAnnotations,
    enabled: isApiMode && !linkedDocHook.isActive && !isPlanDiffActive,
    planKey: markdown,
  });

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
        ext.originalText === a.originalText
      );
    });

    return [...local, ...externalAnnotations];
  }, [annotations, externalAnnotations]);

  // Plan diff state — memoize filtered annotation lists to avoid new references per render
  const diffAnnotations = useMemo(() => allAnnotations.filter(a => !!a.diffContext), [allAnnotations]);
  const viewerAnnotations = useMemo(() => allAnnotations.filter(a => !a.diffContext), [allAnnotations]);
  // Any-annotations flag used by Close/Approve/Send guards. Consolidates the
  // four-term check that was inlined across the annotate-mode header + keyboard paths.
  const hasAnyAnnotations = useMemo(
    () => allAnnotations.length > 0
      || codeAnnotations.length > 0
      || editorAnnotations.length > 0
      || linkedDocHook.docAnnotationCount > 0
      || globalAttachments.length > 0,
    [allAnnotations.length, codeAnnotations.length, editorAnnotations.length, linkedDocHook.docAnnotationCount, globalAttachments.length],
  );
  const feedbackAnnotationCount =
    allAnnotations.length +
    codeAnnotations.length +
    editorAnnotations.length +
    linkedDocHook.docAnnotationCount +
    globalAttachments.length;
  // Code-file comments are intentionally not serialized into share URLs in v1.
  // Hide share entry points once they exist so we do not silently drop feedback.
  const canShareCurrentSession = sharingEnabled && codeAnnotations.length === 0;

  // URL-based sharing
  const {
    isSharedSession,
    isLoadingShared,
    shareUrl,
    shareUrlSize,
    shortShareUrl,
    isGeneratingShortUrl,
    shortUrlError,
    pendingSharedAnnotations,
    sharedGlobalAttachments,
    clearPendingSharedAnnotations,
    generateShortUrl,
    importFromShareUrl,
    shareLoadError,
    clearShareLoadError,
  } = useSharing(
    markdown,
    allAnnotations,
    globalAttachments,
    setMarkdown,
    setAnnotations,
    setGlobalAttachments,
    () => {
      // When loaded from share, mark as loaded
      setIsLoading(false);
    },
    shareBaseUrl,
    pasteApiUrl,
    rawHtml,
    setRawHtml,
    setRenderAs,
  );

  // Auto-save annotation drafts
  const { draftBanner, restoreDraft, dismissDraft } = useAnnotationDraft({
    annotations: allAnnotations,
    codeAnnotations,
    globalAttachments,
    isApiMode,
    isSharedSession,
    submitted: !!submitted,
  });

  const handleRestoreDraft = React.useCallback(() => {
    const { annotations: restored, codeAnnotations: restoredCode, globalAttachments: restoredGlobal } = restoreDraft();
    if (restored.length > 0 || restoredCode.length > 0 || restoredGlobal.length > 0) {
      setAnnotations(restored);
      setCodeAnnotations(restoredCode);
      if (restoredGlobal.length > 0) setGlobalAttachments(restoredGlobal);
      // Apply highlights to DOM after a tick
      setTimeout(() => {
        viewerRef.current?.applySharedAnnotations(restored.filter(a => !a.diffContext));
      }, 100);
    }
  }, [restoreDraft]);

  // Fetch available agents for OpenCode (for validation on approve)
  const { agents: availableAgents, validateAgent, getAgentWarning } = useAgents(origin);

  // Apply shared annotations to DOM after they're loaded
  useEffect(() => {
    if (pendingSharedAnnotations && pendingSharedAnnotations.length > 0) {
      // Small delay to ensure DOM is rendered
      const timer = setTimeout(() => {
        // Clear existing highlights first (important when loading new share URL)
        viewerRef.current?.clearAllHighlights();
        viewerRef.current?.applySharedAnnotations(pendingSharedAnnotations.filter(a => !a.diffContext));
        clearPendingSharedAnnotations();
        // `clearAllHighlights` wiped live external SSE highlights too;
        // tell the external-highlight bookkeeper to re-apply them.
        resetExternalHighlights();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [pendingSharedAnnotations, clearPendingSharedAnnotations, resetExternalHighlights]);

  const handleTaterModeChange = useCallback((enabled: boolean) => {
    setTaterMode(enabled);
    storage.setItem('plannotator-tater-mode', String(enabled));
  }, []);

  const handleEditorModeChange = (mode: EditorMode) => {
    setEditorMode(mode);
    saveEditorMode(mode);
  };

  const handleInputMethodChange = (method: InputMethod) => {
    setInputMethod(method);
    saveInputMethod(method);
  };

  // Alt/Option key: hold to temporarily switch, double-tap to toggle
  useInputMethodSwitch(inputMethod, handleInputMethodChange);

  // Check if we're in API mode (served from Bun hook server)
  // Skip if we loaded from a shared URL
  useEffect(() => {
    if (isLoadingShared) return; // Wait for share check to complete
    if (isSharedSession) return; // Already loaded from share

    fetch('/api/plan')
      .then(res => {
        if (!res.ok) throw new Error('Not in API mode');
        return res.json();
      })
      .then((data: { plan: string; origin?: Origin; mode?: 'annotate' | 'annotate-last' | 'annotate-folder' | 'archive'; filePath?: string; sourceInfo?: string; sourceConverted?: boolean; gate?: boolean; renderAs?: 'html' | 'markdown'; rawHtml?: string; sharingEnabled?: boolean; shareBaseUrl?: string; pasteApiUrl?: string; repoInfo?: { display: string; branch?: string; host?: string }; previousPlan?: string | null; versionInfo?: { version: number; totalVersions: number; project: string }; archivePlans?: ArchivedPlan[]; projectRoot?: string; isWSL?: boolean; serverConfig?: { displayName?: string; gitUser?: string } }) => {
        // Initialize config store with server-provided values (config file > cookie > default)
        configStore.init(data.serverConfig);
        // gitUser drives the "Use git name" button in Settings; stays undefined (button hidden) when unavailable
        setGitUser(data.serverConfig?.gitUser);
        if (data.mode === 'archive') {
          // Archive mode: show first archived plan or clear demo content
          setMarkdown(data.plan || '');
          if (data.archivePlans) archive.init(data.archivePlans);
          archive.fetchPlans();
          setSharingEnabled(false);
          sidebar.open('archive');
        } else if (data.renderAs === 'html' && data.rawHtml) {
          setRenderAs('html');
          setRawHtml(data.rawHtml);
          setMarkdown('');
        } else if (data.mode === 'annotate-folder') {
          // Folder annotation mode: clear demo content, let user pick a file
          setMarkdown('');
        } else if (data.plan) {
          setMarkdown(data.plan);
        }
        setIsApiMode(true);
        if (data.mode === 'annotate' || data.mode === 'annotate-last' || data.mode === 'annotate-folder') {
          setAnnotateMode(true);
          setGate(data.gate ?? false);
        }
        if (data.mode === 'annotate-folder') {
          sidebar.open('files');
        }
        if (data.mode && data.mode !== 'archive') {
          setAnnotateSource(data.mode === 'annotate-last' ? 'message' : data.mode === 'annotate-folder' ? 'folder' : 'file');
        }
        setSourceInfo(data.sourceInfo ?? undefined);
        setSourceConverted(!!data.sourceConverted);
        if (data.filePath) {
          setImageBaseDir(data.mode === 'annotate-folder' ? data.filePath : data.filePath.replace(/\/[^/]+$/, ''));
          if (data.mode === 'annotate') {
            setSourceFilePath(data.filePath);
          }
        }
        if (data.sharingEnabled !== undefined) {
          setSharingEnabled(data.sharingEnabled);
        }
        if (data.shareBaseUrl) {
          setShareBaseUrl(data.shareBaseUrl);
        }
        if (data.pasteApiUrl) {
          setPasteApiUrl(data.pasteApiUrl);
        }
        if (data.repoInfo) {
          setRepoInfo(data.repoInfo);
        }
        if (data.projectRoot) {
          setProjectRoot(data.projectRoot);
        }
        // Capture plan version history data
        if (data.previousPlan !== undefined) {
          setPreviousPlan(data.previousPlan);
        }
        if (data.versionInfo) {
          setVersionInfo(data.versionInfo);
        }
        if (data.origin) {
          setOrigin(data.origin);
          // For Claude Code, check if user needs to configure permission mode
          if (data.origin === 'claude-code' && needsPermissionModeSetup()) {
            setShowPermissionModeSetup(true);
          }
          // Load saved permission mode preference
          setPermissionMode(getPermissionModeSettings().mode);
        }
        if (data.isWSL) {
          setIsWSL(true);
        }
      })
      .catch(() => {
        // Not in API mode - use default content
        setIsApiMode(false);
      })
      .finally(() => setIsLoading(false));
  }, [isLoadingShared, isSharedSession]);

  // Auto-save to notes apps on plan arrival (each gated by its autoSave toggle)
  const autoSaveAttempted = useRef(false);
  const autoSaveResultsRef = useRef<NoteAutoSaveResults>({});
  const autoSavePromiseRef = useRef<Promise<NoteAutoSaveResults> | null>(null);

  useEffect(() => {
    autoSaveAttempted.current = false;
    autoSaveResultsRef.current = {};
    autoSavePromiseRef.current = null;
  }, [markdown]);

  useEffect(() => {
    if (!isApiMode || !markdown || isSharedSession || annotateMode || archive.archiveMode) return;
    if (autoSaveAttempted.current) return;

    const body: { obsidian?: object; bear?: object; octarine?: object } = {};
    const targets: string[] = [];

    const obsSettings = getObsidianSettings();
    if (obsSettings.autoSave && obsSettings.enabled) {
      const vaultPath = getEffectiveVaultPath(obsSettings);
      if (vaultPath) {
        body.obsidian = {
          vaultPath,
          folder: obsSettings.folder || 'plannotator',
          plan: markdown,
          ...(obsSettings.filenameFormat && { filenameFormat: obsSettings.filenameFormat }),
          ...(obsSettings.filenameSeparator && obsSettings.filenameSeparator !== 'space' && { filenameSeparator: obsSettings.filenameSeparator }),
        };
        targets.push('Obsidian');
      }
    }

    const bearSettings = getBearSettings();
    if (bearSettings.autoSave && bearSettings.enabled) {
      body.bear = {
        plan: markdown,
        customTags: bearSettings.customTags,
        tagPosition: bearSettings.tagPosition,
      };
      targets.push('Bear');
    }

    const octSettings = getOctarineSettings();
    if (octSettings.autoSave && isOctarineConfigured()) {
      body.octarine = {
        plan: markdown,
        workspace: octSettings.workspace,
        folder: octSettings.folder || 'plannotator',
      };
      targets.push('Octarine');
    }

    if (targets.length === 0) return;
    autoSaveAttempted.current = true;

    const autoSavePromise = fetch('/api/save-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(res => res.json())
      .then(data => {
        const results: NoteAutoSaveResults = {
          ...(body.obsidian ? { obsidian: Boolean(data.results?.obsidian?.success) } : {}),
          ...(body.bear ? { bear: Boolean(data.results?.bear?.success) } : {}),
          ...(body.octarine ? { octarine: Boolean(data.results?.octarine?.success) } : {}),
        };
        autoSaveResultsRef.current = results;

        const failed = targets.filter(t => !data.results?.[t.toLowerCase()]?.success);
        if (failed.length === 0) {
          toast.success(`Auto-saved to ${targets.join(' & ')}`);
        } else {
          toast.error(`Auto-save failed for ${failed.join(' & ')}`);
        }

        return results;
      })
      .catch(() => {
        autoSaveResultsRef.current = {};
        toast.error('Auto-save failed');
        return {};
      });
    autoSavePromiseRef.current = autoSavePromise;
  }, [isApiMode, markdown, isSharedSession, annotateMode]);

  // Global paste listener for image attachments
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            // Derive name before showing annotator so user sees it immediately
            const initialName = deriveImageName(file.name, globalAttachments.map(g => g.name));
            const blobUrl = URL.createObjectURL(file);
            setPendingPasteImage({ file, blobUrl, initialName });
          }
          break;
        }
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [globalAttachments]);

  // Handle paste annotator accept — name comes from ImageAnnotator
  const handlePasteAnnotatorAccept = async (blob: Blob, hasDrawings: boolean, name: string) => {
    if (!pendingPasteImage) return;

    try {
      const formData = new FormData();
      const fileToUpload = hasDrawings
        ? new File([blob], 'annotated.png', { type: 'image/png' })
        : pendingPasteImage.file;
      formData.append('file', fileToUpload);

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (res.ok) {
        const data = await res.json();
        setGlobalAttachments(prev => [...prev, { path: data.path, name }]);
      }
    } catch {
      // Upload failed silently
    } finally {
      URL.revokeObjectURL(pendingPasteImage.blobUrl);
      setPendingPasteImage(null);
    }
  };

  const handlePasteAnnotatorClose = () => {
    if (pendingPasteImage) {
      URL.revokeObjectURL(pendingPasteImage.blobUrl);
      setPendingPasteImage(null);
    }
  };

  // API mode handlers
  const handleApprove = async () => {
    setIsSubmitting(true);
    try {
      const obsidianSettings = getObsidianSettings();
      const bearSettings = getBearSettings();
      const octarineSettings = getOctarineSettings();
      const planSaveSettings = getPlanSaveSettings();
      const autoSaveResults = bearSettings.autoSave && autoSavePromiseRef.current
        ? await autoSavePromiseRef.current
        : autoSaveResultsRef.current;

      // Build request body - include integrations if enabled
      const body: { obsidian?: object; bear?: object; octarine?: object; feedback?: string; agentSwitch?: string; planSave?: { enabled: boolean; customPath?: string }; permissionMode?: string } = {};

      // Include permission mode for Claude Code
      if (origin === 'claude-code') {
        body.permissionMode = permissionMode;
      }

      const effectiveAgent = getEffectiveAgentName(getAgentSwitchSettings());
      if (effectiveAgent) {
        body.agentSwitch = effectiveAgent;
      }

      // Include plan save settings
      body.planSave = {
        enabled: planSaveSettings.enabled,
        ...(planSaveSettings.customPath && { customPath: planSaveSettings.customPath }),
      };

      const effectiveVaultPath = getEffectiveVaultPath(obsidianSettings);
      if (obsidianSettings.enabled && effectiveVaultPath) {
        body.obsidian = {
          vaultPath: effectiveVaultPath,
          folder: obsidianSettings.folder || 'plannotator',
          plan: markdown,
          ...(obsidianSettings.filenameFormat && { filenameFormat: obsidianSettings.filenameFormat }),
          ...(obsidianSettings.filenameSeparator && obsidianSettings.filenameSeparator !== 'space' && { filenameSeparator: obsidianSettings.filenameSeparator }),
        };
      }

      // Bear creates a new note each time, so don't send it again on approve
      // if the arrival auto-save already succeeded.
      if (bearSettings.enabled && !(bearSettings.autoSave && autoSaveResults.bear)) {
        body.bear = {
          plan: markdown,
          customTags: bearSettings.customTags,
          tagPosition: bearSettings.tagPosition,
        };
      }

      if (isOctarineConfigured()) {
        body.octarine = {
          plan: markdown,
          workspace: octarineSettings.workspace,
          folder: octarineSettings.folder || 'plannotator',
        };
      }

      // Include annotations as feedback if any exist (for OpenCode "approve with notes")
      const hasDocAnnotations = Array.from(linkedDocHook.getDocAnnotations().values()).some(
        (d) => d.annotations.length > 0 || d.globalAttachments.length > 0
      );
      if (allAnnotations.length > 0 || codeAnnotations.length > 0 || globalAttachments.length > 0 || hasDocAnnotations || editorAnnotations.length > 0) {
        body.feedback = annotationsOutput;
      }

      await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setSubmitted('approved');
    } catch {
      setIsSubmitting(false);
    }
  };

  const handleDeny = async () => {
    setIsSubmitting(true);
    try {
      const planSaveSettings = getPlanSaveSettings();
      await fetch('/api/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedback: annotationsOutput,
          planSave: {
            enabled: planSaveSettings.enabled,
            ...(planSaveSettings.customPath && { customPath: planSaveSettings.customPath }),
          },
        })
      });
      setSubmitted('denied');
    } catch {
      setIsSubmitting(false);
    }
  };

  // Annotate mode handler — sends feedback via /api/feedback
  const handleAnnotateFeedback = async () => {
    setIsSubmitting(true);
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedback: annotationsOutput,
          annotations: allAnnotations,
          codeAnnotations,
        }),
      });
      setSubmitted('denied'); // reuse 'denied' state for "feedback sent" overlay
    } catch {
      setIsSubmitting(false);
    }
  };

  // Annotate gate-mode handler — approves the artifact without feedback (#570)
  const handleAnnotateApprove = async () => {
    setIsSubmitting(true);
    try {
      await fetch('/api/approve', { method: 'POST' });
      setSubmitted('approved');
    } catch {
      setIsSubmitting(false);
    }
  };

  // Exit annotation session without sending feedback
  const handleAnnotateExit = useCallback(async () => {
    setIsExiting(true);
    try {
      const res = await fetch('/api/exit', { method: 'POST' });
      if (res.ok) {
        setSubmitted('exited');
      } else {
        throw new Error('Failed to exit');
      }
    } catch {
      setIsExiting(false);
    }
  }, []);

  // Global keyboard shortcuts (Cmd/Ctrl+Enter to submit)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle Cmd/Ctrl+Enter
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;

      // Don't intercept if typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Don't intercept if any modal is open
      if (showExport || showImport || showFeedbackPrompt || showClaudeCodeWarning ||
          showExitWarning || showAgentWarning || showPermissionModeSetup || pendingPasteImage) return;

      // Don't intercept if already submitted, submitting, or exiting
      if (submitted || isSubmitting || isExiting) return;

      // Don't intercept in demo/share mode (no API)
      if (!isApiMode) return;

      // Don't submit while viewing a linked doc
      if (linkedDocHook.isActive) return;

      e.preventDefault();

      // Annotate mode: gate-enabled + no annotations → approve (empty stdout).
      // Otherwise: send feedback.
      if (annotateMode) {
        if (gate && !hasAnyAnnotations) {
          handleAnnotateApprove();
          return;
        }
        handleAnnotateFeedback();
        return;
      }

      // No annotations → Approve, otherwise → Send Feedback
      const docAnnotations = linkedDocHook.getDocAnnotations();
      const hasDocAnnotations = Array.from(docAnnotations.values()).some(
        (d) => d.annotations.length > 0 || d.globalAttachments.length > 0
      );
      if (allAnnotations.length === 0 && codeAnnotations.length === 0 && editorAnnotations.length === 0 && !hasDocAnnotations) {
        // Check if agent exists for OpenCode users
        if (origin === 'opencode') {
          const warning = getAgentWarning();
          if (warning) {
            setAgentWarningMessage(warning);
            setShowAgentWarning(true);
            return;
          }
        }
        handleApprove();
      } else {
        handleDeny();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    showExport, showImport, showFeedbackPrompt, showClaudeCodeWarning, showExitWarning, showAgentWarning,
    showPermissionModeSetup, pendingPasteImage,
    submitted, isSubmitting, isExiting, isApiMode, linkedDocHook.isActive, annotations.length, codeAnnotations.length, externalAnnotations.length, annotateMode,
    gate, hasAnyAnnotations,
    origin, getAgentWarning,
  ]);

  const handleAddAnnotation = (ann: Annotation) => {
    setAnnotations(prev => [...prev, ann]);
    setSelectedAnnotationId(ann.id);
    setSelectedCodeAnnotationId(null);
    if (wideModeType === null) {
      setIsPanelOpen(true);
    }
  };

  // Keep selection behavior explicit across mobile/wide-mode transitions.
  const handleSelectAnnotation = React.useCallback((id: string | null) => {
    setSelectedAnnotationId(id);
    if (id) setSelectedCodeAnnotationId(null);
    if (id && isMobile && wideModeType === null) setIsPanelOpen(true);
  }, [isMobile, wideModeType]);

  const handleAddCodeAnnotation = React.useCallback((input: CodeFileAnnotationInput) => {
    const annotation: CodeAnnotation = {
      id: generateId('code-ann'),
      type: 'comment',
      scope: 'line',
      filePath: input.filePath,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      side: 'new',
      text: input.text,
      images: input.images,
      originalCode: input.originalCode,
      createdAt: Date.now(),
      author: configStore.get('displayName') || undefined,
    };
    setCodeAnnotations(prev => [...prev, annotation]);
    setSelectedAnnotationId(null);
    setSelectedCodeAnnotationId(annotation.id);
    if (wideModeType === null) {
      setIsPanelOpen(true);
    }
  }, [wideModeType]);

  // The code popout is full-viewport modal — the annotation panel is behind it.
  // This handler only fires when the popout is closed (sidebar visible), so
  // reopening the file via codeFilePopout.open() is the correct behavior.
  const handleSelectCodeAnnotation = React.useCallback((id: string) => {
    const annotation = codeAnnotations.find(a => a.id === id);
    if (!annotation) return;
    setSelectedAnnotationId(null);
    setSelectedCodeAnnotationId(id);
    codeFilePopout.open(annotation.filePath);
    if (isMobile && wideModeType === null) setIsPanelOpen(true);
  }, [codeAnnotations, codeFilePopout.open, isMobile, wideModeType]);

  const handleDeleteCodeAnnotation = React.useCallback((id: string) => {
    setCodeAnnotations(prev => prev.filter(a => a.id !== id));
    if (selectedCodeAnnotationId === id) setSelectedCodeAnnotationId(null);
  }, [selectedCodeAnnotationId]);

  const handleEditCodeAnnotation = React.useCallback((id: string, updates: Partial<CodeAnnotation>) => {
    setCodeAnnotations(prev => prev.map(a => a.id === id ? { ...a, ...updates } : a));
  }, []);

  // Core annotation removal — highlight cleanup + state filter + selection clear
  const removeAnnotation = (id: string) => {
    viewerRef.current?.removeHighlight(id);
    setAnnotations(prev => prev.filter(a => a.id !== id));
    if (selectedAnnotationId === id) setSelectedAnnotationId(null);
  };

  // Interactive checkbox toggling with annotation tracking
  const checkbox = useCheckboxOverrides({
    blocks,
    annotations,
    addAnnotation: handleAddAnnotation,
    removeAnnotation,
  });

  const handleDeleteAnnotation = (id: string) => {
    const ann = allAnnotations.find(a => a.id === id);
    // External annotations (live in SSE hook) route to the SSE hook, not local state.
    // Check membership by ID — source alone is insufficient because share-imported
    // and draft-restored annotations also carry source but live in local state.
    if (ann?.source && externalAnnotations.some(e => e.id === id)) {
      deleteExternalAnnotation(id);
      if (selectedAnnotationId === id) setSelectedAnnotationId(null);
      return;
    }
    // If this is a checkbox annotation, revert the visual override
    if (id.startsWith('ann-checkbox-')) {
      if (ann) {
        checkbox.revertOverride(ann.blockId);
      }
    }
    removeAnnotation(id);
  };

  const handleEditAnnotation = (id: string, updates: Partial<Annotation>) => {
    const ann = allAnnotations.find(a => a.id === id);
    if (ann?.source && externalAnnotations.some(e => e.id === id)) {
      updateExternalAnnotation(id, updates);
      return;
    }
    setAnnotations(prev => prev.map(a =>
      a.id === id ? { ...a, ...updates } : a
    ));
  };

  const handleIdentityChange = useCallback((oldIdentity: string, newIdentity: string) => {
    setAnnotations(prev => prev.map(ann =>
      ann.author === oldIdentity ? { ...ann, author: newIdentity } : ann
    ));
    setCodeAnnotations(prev => prev.map(ann =>
      ann.author === oldIdentity ? { ...ann, author: newIdentity } : ann
    ));
  }, []);

  const handleAddGlobalAttachment = (image: ImageAttachment) => {
    setGlobalAttachments(prev => [...prev, image]);
  };

  const handleRemoveGlobalAttachment = (path: string) => {
    setGlobalAttachments(prev => prev.filter(p => p.path !== path));
  };


  const handleTocNavigate = (blockId: string) => {
    // Navigation handled by TableOfContents component
    // This is just a placeholder for future custom logic
  };

  const annotationsOutput = useMemo(() => {
    const docAnnotations = linkedDocHook.getDocAnnotations();
    const hasDocAnnotations = Array.from(docAnnotations.values()).some(
      (d) => d.annotations.length > 0 || d.globalAttachments.length > 0
    );
    const hasPlanAnnotations = allAnnotations.length > 0 || globalAttachments.length > 0;
    const hasEditorAnnotations = editorAnnotations.length > 0;
    const hasCodeAnnotations = codeAnnotations.length > 0;

    if (!hasPlanAnnotations && !hasDocAnnotations && !hasEditorAnnotations && !hasCodeAnnotations) {
      return 'User reviewed the document and has no feedback.';
    }

    // Derive the conversion flag for the currently-displayed document:
    // when viewing a linked doc, use that doc's isConverted; otherwise use the root flag.
    const activeConverted = linkedDocHook.isActive
      ? (docAnnotations.get(linkedDocHook.filepath ?? '')?.isConverted ?? false)
      : sourceConverted;

    let output = hasPlanAnnotations
      ? exportAnnotations(
          blocks,
          allAnnotations,
          globalAttachments,
          annotateSource === 'message' ? 'Message Feedback' : annotateSource === 'folder' ? 'Folder Feedback' : annotateSource === 'file' ? 'File Feedback' : 'Plan Feedback',
          annotateSource ?? 'plan',
          { sourceConverted: activeConverted },
        )
      : '';

    if (hasDocAnnotations) {
      // Parse blocks for each linked doc's cached markdown so the exporter
      // can attach source line numbers per annotation.
      const enriched: Map<string, LinkedDocAnnotationEntry> = new Map(docAnnotations);
      for (const [filepath, entry] of enriched) {
        if (entry.markdown) {
          enriched.set(filepath, { ...entry, blocks: parseMarkdownToBlocks(entry.markdown) });
        }
      }
      output += exportLinkedDocAnnotations(enriched);
    }

    if (hasEditorAnnotations) {
      output += exportEditorAnnotations(editorAnnotations);
    }

    if (hasCodeAnnotations) {
      output += exportCodeFileAnnotations(codeAnnotations);
    }

    return output;
  }, [blocks, allAnnotations, globalAttachments, linkedDocHook.getDocAnnotations, editorAnnotations, codeAnnotations, sourceConverted, annotateSource, linkedDocHook.isActive, linkedDocHook.filepath]);

  // Bot callback config — read once from URL search params (?cb=&ct=)
  // TODO: bot callbacks post shareUrl which doesn't include code-file annotations.
  // If a user adds code comments and hits the callback button, those comments are silently dropped.
  // Fix: either disable callbacks when codeAnnotations exist, or include annotationsOutput in the payload.
  const callbackConfig = React.useMemo(() => getCallbackConfig(), []);

  const callCallback = React.useCallback(async (action: CallbackAction) => {
    if (!callbackConfig || isSubmitting || (!shareUrl && !shortShareUrl)) return;
    setIsSubmitting(true);
    try {
      const result = await executeCallback(action, callbackConfig, shortShareUrl || shareUrl);
      if (result) {
        if (result.type === 'success') {
          toast.success(result.message);
          setSubmitted(action === CallbackAction.Approve ? 'approved' : 'denied');
        } else {
          toast.error(result.message);
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [callbackConfig, isSubmitting, shareUrl, shortShareUrl]);

  const handleCallbackApprove = React.useCallback(() => callCallback(CallbackAction.Approve), [callCallback]);
  const handleCallbackFeedback = React.useCallback(() => callCallback(CallbackAction.Feedback), [callCallback]);

  // Quick-save handlers for export dropdown and keyboard shortcut
  const handleDownloadAnnotations = () => {
    const blob = new Blob([annotationsOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'annotations.md';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Downloaded annotations');
  };

  const handleQuickSaveToNotes = async (target: 'obsidian' | 'bear' | 'octarine') => {
    const body: { obsidian?: object; bear?: object; octarine?: object } = {};

    if (target === 'obsidian') {
      const s = getObsidianSettings();
      const vaultPath = getEffectiveVaultPath(s);
      if (vaultPath) {
        body.obsidian = {
          vaultPath,
          folder: s.folder || 'plannotator',
          plan: markdown,
          ...(s.filenameFormat && { filenameFormat: s.filenameFormat }),
          ...(s.filenameSeparator && s.filenameSeparator !== 'space' && { filenameSeparator: s.filenameSeparator }),
        };
      }
    }
    if (target === 'bear') {
      const bs = getBearSettings();
      body.bear = {
        plan: markdown,
        customTags: bs.customTags,
        tagPosition: bs.tagPosition,
      };
    }
    if (target === 'octarine') {
      const os = getOctarineSettings();
      body.octarine = {
        plan: markdown,
        workspace: os.workspace,
        folder: os.folder || 'plannotator',
      };
    }

    const targetName = target === 'obsidian' ? 'Obsidian' : target === 'bear' ? 'Bear' : 'Octarine';
    try {
      const res = await fetch('/api/save-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const result = data.results?.[target];
      if (result?.success) {
        toast.success(`Saved to ${targetName}`);
      } else {
        toast.error(result?.error || 'Save failed');
      }
    } catch {
      toast.error('Save failed');
    }
  };

  // Agent Instructions — copy a clipboard payload teaching external agents
  // (Claude Code, Codex, etc.) how to POST annotations into this session via
  // /api/external-annotations. The instruction body lives in a separate module
  // (utils/agentInstructions.ts) so it's easy to edit independently of UI code.
  const handleCopyAgentInstructions = async () => {
    const payload = buildPlanAgentInstructions(window.location.origin);
    try {
      await navigator.clipboard.writeText(payload);
      toast.success('Agent instructions copied');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handleCopyShareLink = async () => {
    const url = shortShareUrl || shareUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Share link copied');
    } catch {
      toast.error('Failed to copy');
    }
  };

  // Cmd/Ctrl+S keyboard shortcut — save to default notes app
  useEffect(() => {
    const handleSaveShortcut = (e: KeyboardEvent) => {
      if (e.key !== 's' || !(e.metaKey || e.ctrlKey)) return;

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (showExport || showFeedbackPrompt || showClaudeCodeWarning ||
          showExitWarning || showAgentWarning || showPermissionModeSetup || pendingPasteImage) return;

      if (submitted || !isApiMode) return;

      e.preventDefault();

      const defaultApp = getDefaultNotesApp();
      const obsOk = isObsidianConfigured();
      const bearOk = getBearSettings().enabled;
      const octOk = isOctarineConfigured();

      if (defaultApp === 'download') {
        handleDownloadAnnotations();
      } else if (defaultApp === 'obsidian' && obsOk) {
        handleQuickSaveToNotes('obsidian');
      } else if (defaultApp === 'bear' && bearOk) {
        handleQuickSaveToNotes('bear');
      } else if (defaultApp === 'octarine' && octOk) {
        handleQuickSaveToNotes('octarine');
      } else {
        setInitialExportTab('notes');
        setShowExport(true);
      }
    };

    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [
    showExport, showFeedbackPrompt, showClaudeCodeWarning, showExitWarning, showAgentWarning,
    showPermissionModeSetup, pendingPasteImage,
    submitted, isApiMode, markdown, annotationsOutput,
  ]);

  // Cmd/Ctrl+P keyboard shortcut — print plan
  useEffect(() => {
    const handlePrintShortcut = (e: KeyboardEvent) => {
      if (e.key !== 'p' || !(e.metaKey || e.ctrlKey)) return;

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (showExport || showFeedbackPrompt || showClaudeCodeWarning ||
          showExitWarning || showAgentWarning || showPermissionModeSetup || pendingPasteImage) return;

      if (submitted) return;

      e.preventDefault();
      window.print();
    };

    window.addEventListener('keydown', handlePrintShortcut);
    return () => window.removeEventListener('keydown', handlePrintShortcut);
  }, [
    showExport, showFeedbackPrompt, showClaudeCodeWarning, showExitWarning, showAgentWarning,
    showPermissionModeSetup, pendingPasteImage, submitted,
  ]);

  const agentName = useMemo(() => getAgentName(origin), [origin]);

  // Header handlers ref — stores latest handler references so the stable
  // callbacks below always call the current version without needing useCallback
  // dep arrays for every handler. This lets React.memo on AppHeader work.
  const headerHandlersRef = useRef({
    handleApprove,
    handleDeny,
    handleAnnotateApprove,
    handleAnnotateFeedback,
    handleAnnotateExit,
    handleQuickSaveToNotes,
    handleDownloadAnnotations,
    handleCopyAgentInstructions,
    handleCopyShareLink,
    getAgentWarning,
    getDocAnnotations: linkedDocHook.getDocAnnotations,
  });
  headerHandlersRef.current = {
    handleApprove,
    handleDeny,
    handleAnnotateApprove,
    handleAnnotateFeedback,
    handleAnnotateExit,
    handleQuickSaveToNotes,
    handleDownloadAnnotations,
    handleCopyAgentInstructions,
    handleCopyShareLink,
    getAgentWarning,
    getDocAnnotations: linkedDocHook.getDocAnnotations,
  };

  const handleHeaderAnnotateExit = useCallback(() => {
    if (hasAnyAnnotations) {
      setExitWarningAction('close');
      setShowExitWarning(true);
    } else {
      headerHandlersRef.current.handleAnnotateExit();
    }
  }, [hasAnyAnnotations]);

  const handleHeaderFeedback = useCallback(() => {
    const h = headerHandlersRef.current;
    const docAnnotations = h.getDocAnnotations();
    const hasDocAnnotations = Array.from(docAnnotations.values()).some(
      (d) => d.annotations.length > 0 || d.globalAttachments.length > 0
    );
    if (allAnnotations.length === 0 && codeAnnotations.length === 0 && editorAnnotations.length === 0 && !hasDocAnnotations) {
      setShowFeedbackPrompt(true);
    } else {
      h.handleDeny();
    }
  }, [allAnnotations.length, codeAnnotations.length, editorAnnotations.length]);

  const handleHeaderApprove = useCallback(() => {
    const h = headerHandlersRef.current;
    if (annotateMode) {
      if (hasAnyAnnotations) {
        setExitWarningAction('approve');
        setShowExitWarning(true);
        return;
      }
      h.handleAnnotateApprove();
      return;
    }
    if (origin === 'claude-code' && (allAnnotations.length > 0 || codeAnnotations.length > 0)) {
      setShowClaudeCodeWarning(true);
      return;
    }
    if (origin === 'opencode') {
      const warning = h.getAgentWarning();
      if (warning) {
        setAgentWarningMessage(warning);
        setShowAgentWarning(true);
        return;
      }
    }
    h.handleApprove();
  }, [annotateMode, hasAnyAnnotations, origin, allAnnotations.length, codeAnnotations.length]);

  const handleHeaderAnnotateFeedback = useCallback(() => headerHandlersRef.current.handleAnnotateFeedback(), []);
  const handleHeaderAnnotateApprove = useCallback(() => headerHandlersRef.current.handleAnnotateApprove(), []);
  const handleHeaderDownloadAnnotations = useCallback(() => headerHandlersRef.current.handleDownloadAnnotations(), []);
  const handleHeaderCopyAgentInstructions = useCallback(() => headerHandlersRef.current.handleCopyAgentInstructions(), []);
  const handleHeaderCopyShareLink = useCallback(() => headerHandlersRef.current.handleCopyShareLink(), []);
  const handleOpenSettings = useCallback(() => setMobileSettingsOpen(true), []);
  const handleCloseSettings = useCallback(() => setMobileSettingsOpen(false), []);
  const handleOpenExport = useCallback(() => { setInitialExportTab(undefined); setShowExport(true); }, []);
  const handlePrint = useCallback(() => window.print(), []);
  const handleOpenImport = useCallback(() => setShowImport(true), []);
  const handleSaveToObsidian = useCallback(() => headerHandlersRef.current.handleQuickSaveToNotes('obsidian'), []);
  const handleSaveToOctarine = useCallback(() => headerHandlersRef.current.handleQuickSaveToNotes('octarine'), []);
  const handleSaveToBear = useCallback(() => headerHandlersRef.current.handleQuickSaveToNotes('bear'), []);

  const planMaxWidth = useMemo(() => {
    const widths: Record<PlanWidth, number> = { compact: 832, default: 1040, wide: 1280 };
    return widths[uiPrefs.planWidth] ?? 832;
  }, [uiPrefs.planWidth]);
  const annotateReaderMaxWidth = canUseWideMode && wideModeType === 'wide' ? null : planMaxWidth;


  return (
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider delayDuration={900} skipDelayDuration={200} disableHoverableContent>
      <div data-print-region="root" className="h-screen flex flex-col bg-background overflow-hidden">
        <AppHeader
          isApiMode={isApiMode}
          annotateMode={annotateMode}
          archiveMode={archive.archiveMode}
          gate={gate}
          isSharedSession={isSharedSession}
          origin={origin}
          isSubmitting={isSubmitting}
          isExiting={isExiting}
          isPanelOpen={isPanelOpen}
          hasAnyAnnotations={hasAnyAnnotations}
          linkedDocIsActive={linkedDocHook.isActive}
          callbackShareUrlReady={callbackConfig ? Boolean(shareUrl || shortShareUrl) : true}
          canShareCurrentSession={canShareCurrentSession}
          agentName={agentName}
          availableAgents={availableAgents}
          showAnnotationsWarning={allAnnotations.length > 0 || codeAnnotations.length > 0}
          callbackConfig={callbackConfig}
          taterMode={taterMode}
          mobileSettingsOpen={mobileSettingsOpen}
          gitUser={gitUser}
          onCallbackFeedback={handleCallbackFeedback}
          onCallbackApprove={handleCallbackApprove}
          onAnnotateExit={handleHeaderAnnotateExit}
          onAnnotateFeedback={handleHeaderAnnotateFeedback}
          onAnnotateApprove={handleHeaderAnnotateApprove}
          onFeedback={handleHeaderFeedback}
          onApprove={handleHeaderApprove}
          onAnnotationPanelToggle={handleAnnotationPanelToggle}
          onArchiveCopy={archive.copy}
          onArchiveDone={archive.done}
          onTaterModeChange={handleTaterModeChange}
          onIdentityChange={handleIdentityChange}
          onUIPreferencesChange={setUiPrefs}
          onOpenSettings={handleOpenSettings}
          onCloseSettings={handleCloseSettings}
          onOpenExport={handleOpenExport}
          onCopyAgentInstructions={handleHeaderCopyAgentInstructions}
          onDownloadAnnotations={handleHeaderDownloadAnnotations}
          onPrint={handlePrint}
          onCopyShareLink={handleHeaderCopyShareLink}
          onOpenImport={handleOpenImport}
          onSaveToObsidian={handleSaveToObsidian}
          onSaveToBear={handleSaveToBear}
          onSaveToOctarine={handleSaveToOctarine}
          appVersion={typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
          agentInstructionsEnabled={isApiMode && !archive.archiveMode && !annotateMode}
          obsidianConfigured={isObsidianConfigured()}
          bearConfigured={getBearSettings().enabled}
          octarineConfigured={isOctarineConfigured()}
        />

        {/* Linked document error banner */}
        {linkedDocHook.error && (
          <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2 flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-destructive">{linkedDocHook.error}</span>
            <button
              onClick={linkedDocHook.dismissError}
              className="ml-auto text-xs text-destructive/60 hover:text-destructive"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Main Content */}
        <ScrollViewportContext.Provider value={scrollViewport}>
        <div data-print-region="content" className={`flex-1 flex overflow-hidden relative z-0 ${isResizing ? 'select-none' : ''}`}>
          {/* Tater sprites — inside content wrapper so z-0 stacking context applies */}
          {taterMode && <TaterSpriteRunning />}
          {/* Left Sidebar: collapsed tab flags (when sidebar is closed) */}
          {wideModeType === null && !sidebar.isOpen && (
            <SidebarTabs
              activeTab={sidebar.activeTab}
              onToggleTab={toggleSidebarTab}
              hasDiff={planDiff.hasPreviousVersion}
              showVersionsTab={versionInfo !== null && versionInfo.totalVersions > 1}
              showFilesTab={showFilesTab && !archive.archiveMode}
              hasFileAnnotations={hasFileAnnotations}
              className="hidden lg:flex absolute left-0 top-0 z-10"
            />
          )}

          {/* Left Sidebar: open state (TOC or Version Browser) */}
          {sidebar.isOpen && (
            <>
              <SidebarContainer
                activeTab={sidebar.activeTab}
                onTabChange={(tab) => {
                  toggleSidebarTab(tab);
                  if (tab === 'archive' && !archive.archiveMode) archive.fetchPlans();
                }}
                onClose={sidebar.close}
                width={tocResize.width}
                blocks={blocks}
                annotations={annotations}
                activeSection={activeSection}
                onTocNavigate={handleTocNavigate}
                linkedDocFilepath={linkedDocHook.filepath}
                onLinkedDocBack={linkedDocHook.isActive ? handleLinkedDocBack : undefined}
                backLabel={backLabel}
                showFilesTab={showFilesTab && !archive.archiveMode}
                fileAnnotationCounts={fileAnnotationCounts}
                highlightedFiles={highlightedFiles}
                fileBrowser={fileBrowser}
                onFilesSelectFile={handleFileBrowserSelect}
                onFilesFetchAll={() => fileBrowser.fetchAll(fileBrowserDirs)}
                onFilesRetryVaultDir={(vaultPath) => fileBrowser.addVaultDir(vaultPath)}
                hasFileAnnotations={hasFileAnnotations}
                showVersionsTab={versionInfo !== null && versionInfo.totalVersions > 1}
                versionInfo={versionInfo}
                versions={planDiff.versions}
                selectedBaseVersion={planDiff.diffBaseVersion}
                onSelectBaseVersion={planDiff.selectBaseVersion}
                isPlanDiffActive={isPlanDiffActive}
                hasPreviousVersion={planDiff.hasPreviousVersion}
                onActivatePlanDiff={() => setIsPlanDiffActive(true)}
                isLoadingVersions={planDiff.isLoadingVersions}
                isSelectingVersion={planDiff.isSelectingVersion}
                fetchingVersion={planDiff.fetchingVersion}
                onFetchVersions={planDiff.fetchVersions}
                showArchiveTab={isApiMode && !annotateMode}
                archivePlans={archive.plans}
                selectedArchiveFile={archive.selectedFile}
                onArchiveSelect={archive.select}
                isLoadingArchive={archive.isLoading}
              />
              <ResizeHandle {...tocResize.handleProps} className="hidden lg:block" side="left" />
            </>
          )}

          {/* Document Area */}
          <OverlayScrollArea
            element="main"
            className={`flex-1 min-w-0 bg-grid ${!sidebar.isOpen && wideModeType === null ? 'lg:pl-[30px]' : ''}`}
            data-print-region="document"
            onViewportReady={handleViewportReady}
          >
            <ConfirmDialog
              isOpen={!!draftBanner}
              onClose={dismissDraft}
              onConfirm={handleRestoreDraft}
              title="Draft Recovered"
              message={draftBanner ? `Found ${draftBanner.count} annotation${draftBanner.count !== 1 ? 's' : ''} from ${draftBanner.timeAgo}. Would you like to restore them?` : ''}
              confirmText="Restore"
              cancelText="Dismiss"
              showCancel
            />
            <div ref={planAreaRef} className="min-h-full flex flex-col items-center px-2 py-3 md:px-10 md:py-8 xl:px-16 relative z-10">
              {/* Sticky header lane — ghost bar that pins the toolstrip +
                  badges at top: 12px once the user scrolls. Invisible at top
                  of doc; original toolstrip/badges remain the source of
                  truth there. Hidden in plan diff or archive mode, or when
                  sticky actions are disabled. remountToken re-anchors the
                  ResizeObserver when Viewer swaps content (linked docs). */}
              {!isPlanDiffActive && !archive.archiveMode && uiPrefs.stickyActionsEnabled && (
                <StickyHeaderLane
                  inputMethod={inputMethod}
                  onInputMethodChange={handleInputMethodChange}
                  mode={editorMode}
                  onModeChange={handleEditorModeChange}
                  taterMode={taterMode}
                  repoInfo={repoInfo}
                  planDiffStats={planDiff.diffStats}
                  isPlanDiffActive={isPlanDiffActive}
                  hasPreviousVersion={planDiff.hasPreviousVersion}
                  onPlanDiffToggle={() => setIsPlanDiffActive(!isPlanDiffActive)}
                  archiveInfo={archive.currentInfo}
                  maxWidth={annotateReaderMaxWidth}
                  remountToken={linkedDocHook.isActive ? `doc:${linkedDocHook.filepath}` : 'plan'}
                />
              )}

              {/* Annotation Toolstrip (hidden during plan diff and archive mode) */}
              {!isPlanDiffActive && !archive.archiveMode && (
                <div data-print-hide className="w-full mb-3 md:mb-4 flex items-center justify-start" style={annotateReaderMaxWidth == null ? undefined : { maxWidth: annotateReaderMaxWidth }}>
                  <AnnotationToolstrip
                    inputMethod={inputMethod}
                    onInputMethodChange={handleInputMethodChange}
                    mode={editorMode}
                    onModeChange={handleEditorModeChange}
                    taterMode={taterMode}
                  />
                </div>
              )}

              {/* Plan Diff View — rendered when diff data exists, hidden when inactive */}
              {planDiff.diffBlocks && planDiff.diffStats && (
                <div className="w-full flex justify-center" style={{ display: isPlanDiffActive ? undefined : 'none' }}>
                  <PlanDiffViewer
                    diffBlocks={planDiff.diffBlocks}
                    diffStats={planDiff.diffStats}
                    diffMode={planDiffMode}
                    onDiffModeChange={setPlanDiffMode}
                    onPlanDiffToggle={() => setIsPlanDiffActive(false)}
                    repoInfo={repoInfo}
                    baseVersionLabel={planDiff.diffBaseVersion != null ? `v${planDiff.diffBaseVersion}` : undefined}
                    baseVersion={planDiff.diffBaseVersion ?? undefined}
                    maxWidth={planMaxWidth}
                    annotations={diffAnnotations}
                    onAddAnnotation={handleAddAnnotation}
                    onSelectAnnotation={handleSelectAnnotation}
                    selectedAnnotationId={selectedAnnotationId}
                    mode={editorMode}
                  />
                </div>
              )}
              {/* Folder annotation empty state — shown before user picks a file */}
              {annotateSource === 'folder' && !markdown && !linkedDocHook.isActive && (
                <div className="w-full flex justify-center">
                  <div className="w-full max-w-3xl p-12 text-center text-muted-foreground">
                    <p className="text-lg font-medium mb-2">Select a file to annotate</p>
                    <p className="text-sm">Pick a markdown file from the sidebar to begin.</p>
                  </div>
                </div>
              )}
              {/* Normal Plan View — always mounted, hidden during diff mode */}
              <div className="w-full flex justify-center relative" style={{ display: (isPlanDiffActive && planDiff.diffBlocks) || (annotateSource === 'folder' && !markdown && !linkedDocHook.isActive) ? 'none' : undefined }}>
                {canUseWideMode && !isPlanDiffActive && !archive.archiveMode && (
                  <div
                    data-print-hide
                    className="absolute -top-5 left-0 right-0 mx-auto w-full flex justify-end pointer-events-none"
                    style={annotateReaderMaxWidth === null ? undefined : { maxWidth: annotateReaderMaxWidth ?? 832 }}
                  >
                    <div className={`pointer-events-auto flex items-center gap-1.5 text-[11px] tracking-wide ${taterMode ? 'mr-[60px]' : 'mr-[4px]'}`}>
                      {(['wide', 'focus'] as const).map((type, i) => (
                        <React.Fragment key={type}>
                          {i > 0 && <span aria-hidden className="text-muted-foreground/30 select-none">|</span>}
                          <Tooltip
                            side="top"
                            align="end"
                            content={type === 'wide' ? 'Hide panels and expand document width' : 'Hide panels, keep document width'}
                          >
                            <button
                              type="button"
                              onClick={() => toggleViewMode(type)}
                              aria-pressed={wideModeType === type}
                              className={`cursor-pointer rounded-sm transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:opacity-80 ${
                                wideModeType === type
                                  ? 'text-foreground'
                                  : 'text-muted-foreground/50 hover:text-muted-foreground'
                              }`}
                            >
                              {type.charAt(0).toUpperCase() + type.slice(1)}
                            </button>
                          </Tooltip>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                )}
                {renderAs === 'html' ? (
                  <HtmlViewer
                    ref={viewerRef}
                    rawHtml={rawHtml}
                    annotations={viewerAnnotations}
                    onAddAnnotation={handleAddAnnotation}
                    onSelectAnnotation={handleSelectAnnotation}
                    selectedAnnotationId={selectedAnnotationId}
                    mode={editorMode}
                    globalAttachments={globalAttachments}
                    onAddGlobalAttachment={handleAddGlobalAttachment}
                    onRemoveGlobalAttachment={handleRemoveGlobalAttachment}
                    maxWidth={annotateReaderMaxWidth}
                  />
                ) : (
                  <Viewer
                    key={linkedDocHook.isActive ? `doc:${linkedDocHook.filepath}` : 'plan'}
                    ref={viewerRef}
                    blocks={blocks}
                    markdown={markdown}
                    frontmatter={frontmatter}
                    annotations={viewerAnnotations}
                    onAddAnnotation={handleAddAnnotation}
                    onSelectAnnotation={handleSelectAnnotation}
                    selectedAnnotationId={selectedAnnotationId}
                    mode={editorMode}
                    inputMethod={inputMethod}
                    taterMode={taterMode}
                    globalAttachments={globalAttachments}
                    onAddGlobalAttachment={handleAddGlobalAttachment}
                    onRemoveGlobalAttachment={handleRemoveGlobalAttachment}
                    repoInfo={repoInfo}
                    stickyActions={uiPrefs.stickyActionsEnabled}
                    planDiffStats={linkedDocHook.isActive ? null : planDiff.diffStats}
                    isPlanDiffActive={isPlanDiffActive}
                    onPlanDiffToggle={() => setIsPlanDiffActive(!isPlanDiffActive)}
                    hasPreviousVersion={!linkedDocHook.isActive && planDiff.hasPreviousVersion}
                    showDemoBadge={!isApiMode && !isLoadingShared && !isSharedSession}
                    maxWidth={annotateReaderMaxWidth}
                    onOpenLinkedDoc={handleOpenLinkedDoc}
                    onOpenCodeFile={codeFilePopout.open}
                    linkedDocInfo={linkedDocHook.isActive ? { filepath: linkedDocHook.filepath!, onBack: handleLinkedDocBack, label: fileBrowser.dirs.find(d => d.path === fileBrowser.activeDirPath)?.isVault ? 'Vault File' : fileBrowser.activeFile ? 'File' : undefined, backLabel } : null}
                    imageBaseDir={imageBaseDir}
                    codePathBaseDir={activeDocBaseDir}
                    copyLabel={annotateSource === 'message' ? 'Copy message' : annotateSource === 'file' || annotateSource === 'folder' ? 'Copy file' : undefined}
                    archiveInfo={archive.currentInfo}
                    sourceInfo={sourceInfo}
                    onToggleCheckbox={checkbox.toggle}
                    checkboxOverrides={checkbox.overrides}
                    actionsLabelMode={actionsLabelMode}
                  />
                )}
              </div>
            </div>
          </OverlayScrollArea>

          {/* Resize Handle */}
          {isPanelOpen && wideModeType === null && <ResizeHandle {...panelResize.handleProps} className="hidden md:block" side="right" />}

          {/* Annotation Panel */}
          <AnnotationPanel
            isOpen={isPanelOpen && wideModeType === null}
            blocks={blocks}
            annotations={allAnnotations}
            selectedId={selectedAnnotationId ?? selectedCodeAnnotationId}
            onSelect={handleSelectAnnotation}
            onDelete={handleDeleteAnnotation}
            onEdit={handleEditAnnotation}
            codeAnnotations={codeAnnotations}
            onSelectCodeAnnotation={handleSelectCodeAnnotation}
            onDeleteCodeAnnotation={handleDeleteCodeAnnotation}
            onEditCodeAnnotation={handleEditCodeAnnotation}
            sharingEnabled={canShareCurrentSession}
            width={panelResize.width}
            editorAnnotations={editorAnnotations}
            onDeleteEditorAnnotation={deleteEditorAnnotation}
            onClose={() => setIsPanelOpen(false)}
            onQuickCopy={async () => {
              await navigator.clipboard.writeText(wrapFeedbackForAgent(annotationsOutput));
            }}
            onShare={canShareCurrentSession && (shareUrl || shortShareUrl) ? () => { setIsPanelOpen(false); setInitialExportTab('share'); setShowExport(true); } : undefined}
            otherFileAnnotations={otherFileAnnotations}
            onOtherFileAnnotationsClick={handleFlashAnnotatedFiles}
          />
        </div>
        </ScrollViewportContext.Provider>

        {/* Code File Popout */}
        {codeFilePopout.popoutProps && (
          <CodeFilePopout
            {...codeFilePopout.popoutProps}
            annotations={codeAnnotations.filter((ann) => ann.filePath === codeFilePopout.popoutProps?.filepath)}
            selectedAnnotationId={selectedCodeAnnotationId}
            onAddAnnotation={handleAddCodeAnnotation}
            onEditAnnotation={handleEditCodeAnnotation}
            onDeleteAnnotation={handleDeleteCodeAnnotation}
            onSelectAnnotation={(id) => {
              setSelectedAnnotationId(null);
              setSelectedCodeAnnotationId(id);
            }}
          />
        )}

        {/* Export Modal */}
        <ExportModal
          isOpen={showExport}
          onClose={() => { setShowExport(false); setInitialExportTab(undefined); }}
          shareUrl={shareUrl}
          shareUrlSize={shareUrlSize}
          shortShareUrl={shortShareUrl}
          isGeneratingShortUrl={isGeneratingShortUrl}
          shortUrlError={shortUrlError}
          onGenerateShortUrl={generateShortUrl}
          annotationsOutput={annotationsOutput}
          annotationCount={allAnnotations.length + codeAnnotations.length}
          taterSprite={taterMode ? <TaterSpritePullup /> : undefined}
          sharingEnabled={canShareCurrentSession}
          markdown={markdown}
          isApiMode={isApiMode}
          initialTab={initialExportTab}
        />

        {/* Import Modal */}
        <ImportModal
          isOpen={showImport}
          onClose={() => setShowImport(false)}
          onImport={importFromShareUrl}
          shareBaseUrl={shareBaseUrl}
        />

        {/* Feedback prompt dialog */}
        <ConfirmDialog
          isOpen={showFeedbackPrompt}
          onClose={() => setShowFeedbackPrompt(false)}
          title="Add Annotations First"
          message={`To provide feedback, select text in the plan and add annotations. ${agentName} will use your annotations to revise the plan.`}
          variant="info"
        />

        {/* Claude Code annotation warning dialog */}
        <ConfirmDialog
          isOpen={showClaudeCodeWarning}
          onClose={() => setShowClaudeCodeWarning(false)}
          onConfirm={() => {
            setShowClaudeCodeWarning(false);
            handleApprove();
          }}
          title="Annotations Won't Be Sent"
          message={<>{agentName} doesn't yet support feedback on approval. Your {allAnnotations.length + codeAnnotations.length} annotation{(allAnnotations.length + codeAnnotations.length) !== 1 ? 's' : ''} will be lost.</>}
          subMessage={
            <>
              To send feedback, use <strong>Send Feedback</strong> instead.
              <br /><br />
              Want this feature? Upvote these issues:
              <br />
              <a href="https://github.com/anthropics/claude-code/issues/16001" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">#16001</a>
              {' · '}
              <a href="https://github.com/anthropics/claude-code/issues/15755" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">#15755</a>
            </>
          }
          confirmText="Approve Anyway"
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* Unsaved-annotations warning dialog — reused by Close and (in gate mode) Approve */}
        <ConfirmDialog
          isOpen={showExitWarning}
          onClose={() => setShowExitWarning(false)}
          onConfirm={() => {
            setShowExitWarning(false);
            if (exitWarningAction === 'approve') handleAnnotateApprove();
            else handleAnnotateExit();
          }}
          title="Annotations Won't Be Sent"
          message={<>You have {feedbackAnnotationCount} annotation{feedbackAnnotationCount !== 1 ? 's' : ''} that will be lost if you {exitWarningAction === 'approve' ? 'approve' : 'close'}.</>}
          subMessage="To send your annotations, use Send Annotations instead."
          confirmText={exitWarningAction === 'approve' ? 'Approve Anyway' : 'Close Anyway'}
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* OpenCode agent not found warning dialog */}
        <ConfirmDialog
          isOpen={showAgentWarning}
          onClose={() => setShowAgentWarning(false)}
          onConfirm={() => {
            setShowAgentWarning(false);
            handleApprove();
          }}
          title="Agent Not Found"
          message={agentWarningMessage}
          subMessage={
            <>
              You can change the agent in <strong>Settings</strong>, or approve anyway and OpenCode will use the default agent.
            </>
          }
          confirmText="Approve Anyway"
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* Shared URL load failure warning */}
        <ConfirmDialog
          isOpen={!!shareLoadError && !isApiMode}
          onClose={clearShareLoadError}
          title="Shared Plan Could Not Be Loaded"
          message={shareLoadError}
          subMessage="You are viewing a demo plan. This is sample content — it is not your data or anyone else's."
          variant="warning"
        />

        <Toaster
          position="top-right"
          offset={64}
          toastOptions={{
            style: {
              '--normal-bg': 'var(--card)',
              '--normal-border': 'var(--border)',
              '--normal-text': 'var(--foreground)',
              '--success-bg': 'oklch(from var(--success) l c h / 0.15)',
              '--success-border': 'oklch(from var(--success) l c h / 0.3)',
              '--success-text': 'var(--success)',
              '--error-bg': 'oklch(from var(--destructive) l c h / 0.15)',
              '--error-border': 'oklch(from var(--destructive) l c h / 0.3)',
              '--error-text': 'var(--destructive)',
            } as React.CSSProperties,
          }}
        />

        {/* Completion overlay - shown after approve/deny */}
        <CompletionOverlay
          submitted={submitted}
          title={
            archive.archiveMode ? 'Archive Closed'
            : submitted === 'exited' ? 'Session Closed'
            : submitted === 'approved'
              ? (annotateMode ? 'Approved' : 'Plan Approved')
              : annotateMode ? 'Annotations Sent'
            : 'Feedback Sent'
          }
          subtitle={
            submitted === 'exited'
              ? 'Annotation session closed without feedback.'
              : archive.archiveMode
                ? 'You can reopen with plannotator archive.'
                : submitted === 'approved'
                  ? (annotateMode
                      ? `${agentName} will proceed.`
                      : `${agentName} will proceed with the implementation.`)
                  : annotateMode
                    ? `${agentName} will address your annotations on the ${annotateSource === 'message' ? 'message' : annotateSource === 'folder' ? 'files' : 'file'}.`
                    : `${agentName} will revise the plan based on your annotations.`
          }
          agentLabel={agentName}
        />

        {/* Update notification */}
        <UpdateBanner origin={origin} isWSL={isWSL} />

        {/* Image Annotator for pasted images */}
        <ImageAnnotator
          isOpen={!!pendingPasteImage}
          imageSrc={pendingPasteImage?.blobUrl ?? ''}
          initialName={pendingPasteImage?.initialName}
          onAccept={handlePasteAnnotatorAccept}
          onClose={handlePasteAnnotatorClose}
        />

        {/* Permission Mode Setup (Claude Code first-time) */}
        <PermissionModeSetup
          isOpen={showPermissionModeSetup}
          onComplete={(mode) => {
            setPermissionMode(mode);
            setShowPermissionModeSetup(false);
          }}
        />
      </div>
      </TooltipProvider>
    </ThemeProvider>
  );
};

export default App;
