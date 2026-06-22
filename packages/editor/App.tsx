import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { toast, Toaster } from 'sonner';
import { type Origin, getAgentName } from '@plannotator/shared/agents';
import { annotateFileFeedback, annotateMessageFeedback } from '@plannotator/shared/feedback-templates';
import { parseMarkdownToBlocks, exportAnnotations, exportLinkedDocAnnotations, exportEditorAnnotations, exportCodeFileAnnotations, exportMessageAnnotations, extractFrontmatter, wrapFeedbackForAgent, Frontmatter, type LinkedDocAnnotationEntry, type MessageAnnotationEntry } from '@plannotator/ui/utils/parser';
import { Viewer, ViewerHandle } from '@plannotator/ui/components/Viewer';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { MarkdownEditor, type MarkdownEditorHandle } from '@plannotator/ui/components/MarkdownEditor';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { DocumentAIChatPanel } from '@plannotator/ui/components/ai/DocumentAIChatPanel';
import { SparklesIcon } from '@plannotator/ui/components/SparklesIcon';
import { ExportModal } from '@plannotator/ui/components/ExportModal';
import { ImportModal } from '@plannotator/ui/components/ImportModal';
import { ConfirmDialog } from '@plannotator/ui/components/ConfirmDialog';
import { Annotation, AnnotationType, Block, EditorMode, type CodeAnnotation, type InputMethod, type ImageAttachment, type ActionsLabelMode } from '@plannotator/ui/types';
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
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { CompletionOverlay } from '@plannotator/ui/components/CompletionOverlay';
import { useUpdateCheck } from '@plannotator/ui/hooks/useUpdateCheck';
import { PlanAIAnnouncementDialog } from '@plannotator/ui/components/PlanAIAnnouncementDialog';
import { LookAndFeelAnnouncementDialog } from '@plannotator/ui/components/LookAndFeelAnnouncementDialog';
import { getObsidianSettings, getEffectiveVaultPath, isObsidianConfigured, CUSTOM_PATH_SENTINEL } from '@plannotator/ui/utils/obsidian';
import { getBearSettings } from '@plannotator/ui/utils/bear';
import { getOctarineSettings, isOctarineConfigured } from '@plannotator/ui/utils/octarine';
import { getDefaultNotesApp } from '@plannotator/ui/utils/defaultNotesApp';
import { getAgentSwitchSettings, getEffectiveAgentName } from '@plannotator/ui/utils/agentSwitch';
import { getPlanSaveSettings } from '@plannotator/ui/utils/planSave';
import {
  getAIProviderSettings,
  resolveAIModelForProvider,
  resolveAIProviderSelection,
  saveAIProviderSelection,
  type AIProviderOption,
} from '@plannotator/ui/utils/aiProvider';
import { markPlanAIAnnouncementSeen, needsPlanAIAnnouncement } from '@plannotator/ui/utils/planAIAnnouncement';
import { markLookAndFeelAnnouncementSeen, needsLookAndFeelAnnouncement } from '@plannotator/ui/utils/lookAndFeelAnnouncement';
import { buildDefaultPrompt, useAIChat } from '@plannotator/ui/hooks/useAIChat';
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
import { useLinkedDoc, type LinkedDocSessionState } from '@plannotator/ui/hooks/useLinkedDoc';
import { useCodeFilePopout } from '@plannotator/ui/hooks/useCodeFilePopout';
import { useAnnotationDraft, type DraftEditedDocument, type DraftSavedFileChange } from '@plannotator/ui/hooks/useAnnotationDraft';
import { useArchive } from '@plannotator/ui/hooks/useArchive';
import { useEditorAnnotations } from '@plannotator/ui/hooks/useEditorAnnotations';
import { useExternalAnnotations } from '@plannotator/ui/hooks/useExternalAnnotations';
import { useExternalAnnotationHighlights } from '@plannotator/ui/hooks/useExternalAnnotationHighlights';
import { buildPlanAgentInstructions } from '@plannotator/ui/utils/planAgentInstructions';
import { useFileBrowser } from '@plannotator/ui/hooks/useFileBrowser';
import { getFileEditStatus } from '@plannotator/ui/components/sidebar/FileBrowser';
import { isVaultBrowserEnabled } from '@plannotator/ui/utils/obsidian';
import { isFileBrowserEnabled, getFileBrowserSettings } from '@plannotator/ui/utils/fileBrowser';
import { generateId } from '@plannotator/ui/utils/generateId';
import { SidebarTabs } from '@plannotator/ui/components/sidebar/SidebarTabs';
import { SidebarContainer } from '@plannotator/ui/components/sidebar/SidebarContainer';
import type { ArchivedPlan } from '@plannotator/ui/components/sidebar/ArchiveBrowser';
import type { PickerMessage } from '@plannotator/ui/components/sidebar/MessagesBrowser';
import { PlanDiffViewer } from '@plannotator/ui/components/plan-diff/PlanDiffViewer';
import { CodeFilePopout, type CodeFileAnnotationInput } from '@plannotator/ui/components/CodeFilePopout';
import type { PlanDiffMode } from '@plannotator/ui/components/plan-diff/PlanDiffModeSwitcher';
import {
  GoalSetupSurface,
  type GoalSetupActionState,
  type GoalSetupSurfaceHandle,
} from '@plannotator/ui/components/goal-setup/GoalSetupSurface';
import type { GoalSetupBundle } from '@plannotator/shared/goal-setup';
import type { AIContext } from '@plannotator/ai';
import type { CommentAskAIContext } from '@plannotator/ui/components/CommentPopover';
import {
  hasSourceSaveConflictSnapshot,
  type SourceSaveCapability,
  type SourceSaveResponse,
} from '@plannotator/shared/source-save';
import type { AgentTerminalCapability } from '@plannotator/shared/agent-terminal';
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
import {
  AnnotateAgentTerminalPanel,
  type AnnotateAgentTerminalPanelHandle,
} from './components/AnnotateAgentTerminalPanel';
import {
  buildAgentTerminalDeliveryRecord,
  buildTerminalAskPrompt,
  isMatchingAgentTerminalDelivery,
  shouldSendAgentTerminalFeedback,
  type AgentTerminalDeliveryRecord,
  type AnnotateFeedbackTarget,
} from './agentTerminalIntegration';
import {
  buildPlanEditPanelItem,
  buildDirectEditsSection,
  buildSavedFileChangePanelItems,
  buildSavedFileChangesSection,
  composeFeedbackWithEditSections,
  computeEditStats,
  normalizeEditedMarkdown,
} from './directEdits';
import {
  editableDocumentKey,
  useEditableDocuments,
  type EnabledSourceSaveCapability,
  type SavedFileChangeDraftData,
} from './editableDocuments';
import {
  validateSavedFileChanges,
} from './savedFileChangeValidation';
import { fetchSourceDocumentSnapshot, probeSourceSave } from './sourceDocumentClient';
import { reconcileSourceDocuments, type SourceDocumentReconcileEvent } from './sourceDocumentReconciliation';
import { dirnameBrowserPath, normalizeBrowserPath, pathIsInsideDir } from './sourceDocumentPaths';
import { pickRestoredSingleFileDraftToDisplay } from './draftRestoreSelection';

type NoteAutoSaveResults = {
  obsidian?: boolean;
  bear?: boolean;
  octarine?: boolean;
};

type MessageAnnotationState = {
  messageId: string;
  text: string;
  timestamp?: string;
  linkedDocSession: LinkedDocSessionState;
  codeAnnotations: CodeAnnotation[];
  selectedCodeAnnotationId: string | null;
};

const countLinkedDocSessionAnnotations = (session: LinkedDocSessionState): number => {
  let total =
    session.root.annotations.length +
    session.root.globalAttachments.length;
  for (const doc of session.docs.values()) {
    total += doc.annotations.length + doc.globalAttachments.length;
  }
  return total;
};

const countMessageAnnotations = (state: MessageAnnotationState): number =>
  countLinkedDocSessionAnnotations(state.linkedDocSession) +
  state.codeAnnotations.length;

const createEmptyMessageState = (message: PickerMessage): MessageAnnotationState => ({
  messageId: message.messageId,
  text: message.text,
  timestamp: message.timestamp,
  linkedDocSession: {
    root: {
      markdown: message.text,
      renderAs: 'markdown',
      rawHtml: '',
      shareHtml: '',
      annotations: [],
      selectedAnnotationId: null,
      globalAttachments: [],
    },
    docs: new Map(),
  },
  codeAnnotations: [],
  selectedCodeAnnotationId: null,
});

const normalizeMessageState = (
  state: MessageAnnotationState,
  message: PickerMessage,
): MessageAnnotationState => ({
  ...state,
  text: message.text,
  timestamp: message.timestamp,
  linkedDocSession: {
    root: {
      ...state.linkedDocSession.root,
      // The root document for a message is immutable and comes from the picker.
      // Keep it as the source of truth so transient UI state cannot cache an
      // empty markdown value for a message.
      markdown: message.text,
      renderAs: state.linkedDocSession.root.renderAs ?? 'markdown',
      rawHtml: state.linkedDocSession.root.rawHtml ?? '',
      shareHtml: state.linkedDocSession.root.shareHtml ?? '',
    },
    docs: new Map(state.linkedDocSession.docs),
  },
});

const buildMessageAnnotationCounts = (
  states: Map<string, MessageAnnotationState>
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const [messageId, state] of states) {
    const count = countMessageAnnotations(state);
    if (count > 0) counts.set(messageId, count);
  }
  return counts;
};

const draftBannerMessage = (banner: { count: number; timeAgo: string; hasEdits: boolean }): string => {
  const parts = [
    banner.count > 0 ? `${banner.count} annotation${banner.count !== 1 ? 's' : ''}` : '',
    banner.hasEdits ? 'unsent direct edits' : '',
  ].filter(Boolean);
  return `Found ${parts.join(' and ')} from ${banner.timeAgo}. Would you like to restore them?`;
};

const feedbackLossDescription = (annotationCount: number, hasDirectEdits: boolean): string => {
  const parts = [
    annotationCount > 0 ? `${annotationCount} annotation${annotationCount !== 1 ? 's' : ''}` : '',
    hasDirectEdits ? 'direct edits' : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' and ') : 'feedback';
};

type SourceFileEditWarningAction = 'send-feedback' | 'approve' | 'close';

const App: React.FC = () => {
  const [markdown, setMarkdown] = useState(DEMO_PLAN_CONTENT);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const annotationsRef = useRef<Annotation[]>(annotations);
  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);
  const [codeAnnotations, setCodeAnnotations] = useState<CodeAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedCodeAnnotationId, setSelectedCodeAnnotationId] = useState<string | null>(null);
  const editableDocuments = useEditableDocuments();
  const activeEditableDocument = editableDocuments.activeDocument;
  const displayedMarkdown = activeEditableDocument?.currentText ?? markdown;
  const frontmatter = useMemo(() => extractFrontmatter(displayedMarkdown).frontmatter, [displayedMarkdown]);
  const blocks = useMemo(() => parseMarkdownToBlocks(displayedMarkdown), [displayedMarkdown]);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFeedbackPrompt, setShowFeedbackPrompt] = useState(false);
  const [showClaudeCodeWarning, setShowClaudeCodeWarning] = useState(false);
  const [showExitWarning, setShowExitWarning] = useState(false);
  const [showSourceFileEditWarning, setShowSourceFileEditWarning] = useState(false);
  const [sourceFileEditWarningAction, setSourceFileEditWarningAction] = useState<SourceFileEditWarningAction>('send-feedback');
  const sourceFileEditWarningContinuationRef = useRef<(() => void | Promise<void>) | null>(null);
  // When the warning dialog confirms, route to the handler matching the button that opened it.
  const [exitWarningAction, setExitWarningAction] = useState<'close' | 'approve'>('close');
  const [showAgentWarning, setShowAgentWarning] = useState(false);
  const [agentWarningMessage, setAgentWarningMessage] = useState('');
  const [isPanelOpen, setIsPanelOpen] = useState(() => window.innerWidth >= 768);
  const [rightSidebarTab, setRightSidebarTab] = useState<'annotations' | 'ai'>('annotations');
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(getEditorMode);
  const [inputMethod, setInputMethod] = useState<InputMethod>(getInputMethod);
  const [taterMode, setTaterMode] = useState(() => {
    const stored = storage.getItem('plannotator-tater-mode');
    return stored === 'true';
  });
  const gridEnabled = useConfigValue('gridEnabled');
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
  const [isApiMode, setIsApiMode] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [gitUser, setGitUser] = useState<string | undefined>();
  const [isWSL, setIsWSL] = useState(false);
  const updateInfo = useUpdateCheck();
  const updateToastShown = useRef(false);
  useEffect(() => {
    if (window.location.hash) return;
    if (updateInfo?.updateAvailable && !updateInfo.dismissed && !updateToastShown.current) {
      updateToastShown.current = true;
      const t = setTimeout(() => {
        toast('A new version of Plannotator is available', {
          description: 'Open the Options menu to update.',
          duration: 4000,
          classNames: { toast: '!w-auto', description: '!text-foreground/70' },
        });
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [updateInfo?.updateAvailable, updateInfo?.dismissed]);
  // Markdown edit mode (prototype): CM6 live-preview editor over the raw plan
  // text. originalMarkdownRef is the as-submitted baseline for the edit diff —
  // set once at plan load, never by linked-doc navigation or edit commits.
  const [isEditingMarkdown, setIsEditingMarkdown] = useState(false);
  const isEditingMarkdownRef = useRef(isEditingMarkdown);
  useEffect(() => {
    isEditingMarkdownRef.current = isEditingMarkdown;
  }, [isEditingMarkdown]);
  const [editStats, setEditStats] = useState<{ added: number; removed: number } | null>(null);
  // Bumped on every edit commit so the Viewer remounts: web-highlighter mutates
  // the Viewer DOM, and reconciling changed blocks against the old subtree throws.
  const [editGeneration, setEditGeneration] = useState(0);
  // True while the open editor buffer differs from what it mounted with.
  const [editorDirty, setEditorDirty] = useState(false);
  // True while the open editor buffer differs from the as-submitted baseline.
  const [editorDiffersFromBaseline, setEditorDiffersFromBaseline] = useState(false);
  const [agentFeedbackRevision, setAgentFeedbackRevision] = useState(0);
  // Two-step guard for the "Cancel" (discard edits + exit) action.
  const [confirmCancelEdits, setConfirmCancelEdits] = useState(false);
  const originalMarkdownRef = useRef<string | null>(null);
  // Last COMMITTED editor text (null = no edits). The Direct Edits diff reads
  // this — never the shared `markdown` state, which linked-doc navigation,
  // message switching, and checkbox toggles repurpose.
  const editedMarkdownRef = useRef<string | null>(null);
  // What the current edit session mounted with, for live dirty tracking.
  const editSessionBaseRef = useRef<string>('');
  const markdownEditorHandleRef = useRef<MarkdownEditorHandle | null>(null);
  const suspendedRootEditableKeyRef = useRef<string | null>(null);
  const [globalAttachments, setGlobalAttachments] = useState<ImageAttachment[]>([]);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [gate, setGate] = useState(false);
  const [annotateSource, setAnnotateSource] = useState<'file' | 'message' | 'folder' | null>(null);
  const [recentMessages, setRecentMessages] = useState<PickerMessage[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const messageStateCacheRef = useRef<Map<string, MessageAnnotationState>>(new Map());
  const [cachedMessageAnnotationCounts, setCachedMessageAnnotationCounts] = useState<Map<string, number>>(new Map());
  const [goalSetupBundle, setGoalSetupBundle] = useState<GoalSetupBundle | null>(null);
  const goalSetupSurfaceRef = useRef<GoalSetupSurfaceHandle>(null);
  const [goalSetupAction, setGoalSetupAction] = useState<GoalSetupActionState>({
    canSubmit: false,
    isSubmitting: false,
    submitted: false,
    submitLabel: 'Submit',
  });
  const [sourceInfo, setSourceInfo] = useState<string | undefined>();
  const [sourceConverted, setSourceConverted] = useState(false);
  const [renderAs, setRenderAs] = useState<'markdown' | 'html'>('markdown');
  // HTML plans render edge-to-edge (full-viewport) instead of in the centered,
  // card-chromed markdown column. Branch the document-area containers on this.
  const isHtmlSurface = renderAs === 'html';
  const [rawHtml, setRawHtml] = useState('');
  const [shareHtml, setShareHtml] = useState('');
  // Session-level force-markdown preference (`--markdown`). When set, folder/linked HTML
  // files are converted instead of rendered raw — threaded into /api/doc as &convert=1.
  const [convertHtml, setConvertHtml] = useState(false);
  // Hide the floating HTML annotation controls (toolstrip + action cluster) so the
  // user can read the rendered page unobstructed. Selections/annotations are unaffected.
  const [htmlToolsHidden, setHtmlToolsHidden] = useState(false);
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
  const [agentTerminalCapability, setAgentTerminalCapability] = useState<AgentTerminalCapability | null>(null);
  const [isAgentTerminalOpen, setIsAgentTerminalOpen] = useState(false);
  const [isAgentTerminalRunning, setIsAgentTerminalRunning] = useState(false);
  const [isAgentTerminalReady, setIsAgentTerminalReady] = useState(false);
  const [agentTerminalSessionId, setAgentTerminalSessionId] = useState<number | null>(null);
  const [agentTerminalDelivery, setAgentTerminalDeliveryState] = useState<AgentTerminalDeliveryRecord | null>(null);
  const agentTerminalDeliveryRef = useRef<AgentTerminalDeliveryRecord | null>(null);
  const agentTerminalSessionSeqRef = useRef(0);
  const agentTerminalRef = useRef<AnnotateAgentTerminalPanelHandle>(null);
  const [wideModeType, setWideModeType] = useState<WideModeType | null>(null);
  const wideModeSnapshotRef = useRef<WideModeLayoutSnapshot | null>(null);
  const initialSidebarPreferenceAppliedRef = useRef(false);
  const lastAppliedTocEnabledRef = useRef(uiPrefs.tocEnabled);
  const goalSetupMode = goalSetupBundle !== null;

  useEffect(() => {
    document.title = repoInfo ? `${repoInfo.display} · Plannotator` : "Plannotator";
  }, [repoInfo]);

  const [initialExportTab, setInitialExportTab] = useState<'share' | 'annotations' | 'notes'>();
  const [isPlanDiffActive, setIsPlanDiffActive] = useState(false);
  const [planDiffMode, setPlanDiffMode] = useState<PlanDiffMode>('clean');
  const [previousPlan, setPreviousPlan] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [aiSessionEnabled, setAISessionEnabled] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiProviders, setAiProviders] = useState<Array<{ id: string; name: string; capabilities?: Record<string, boolean>; models?: Array<{ id: string; label: string; default?: boolean }> }>>([]);
  const [aiConfig, setAIConfig] = useState(() => {
    const saved = getAIProviderSettings();
    const providerId = saved.providerId;
    return {
      providerId,
      model: providerId ? (saved.preferredModels[providerId] ?? null) : null,
      reasoningEffort: null as string | null,
    };
  });
  const [showPlanAIAnnouncement, setShowPlanAIAnnouncement] = useState(needsPlanAIAnnouncement);
  const [showLookAndFeelAnnouncement, setShowLookAndFeelAnnouncement] = useState(needsLookAndFeelAnnouncement);
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

  // Sidebar (shared TOC + Version Browser)
  const sidebar = useSidebar(false);

  // Resizable panels
  const panelResize = useResizablePanel({
    storageKey: 'plannotator-panel-width',
    // Drag the right panel skinny → snap it shut (matches the contents sidebar).
    onSnapClose: () => setIsPanelOpen(false),
    // Render-free drag: write the live width to a :root var the panel reads,
    // so dragging never re-renders this (heavy) App.
    apply: (w) => document.documentElement.style.setProperty('--rpanel-w', `${w}px`),
  });
  const tocResize = useResizablePanel({
    storageKey: 'plannotator-toc-width',
    defaultWidth: 240, minWidth: 160, maxWidth: 400, side: 'left',
    // Drag the contents panel skinny → snap it shut (prototype behavior).
    onSnapClose: sidebar.close,
    // Render-free drag: write the live width to a :root var the panel reads.
    apply: (w) => document.documentElement.style.setProperty('--toc-w', `${w}px`),
  });
  const agentTerminalResize = useResizablePanel({
    storageKey: 'plannotator-agent-terminal-width',
    defaultWidth: 360,
    minWidth: 280,
    maxWidth: 640,
    side: 'left',
    onSnapClose: () => setIsAgentTerminalOpen(false),
    apply: (w) => document.documentElement.style.setProperty('--agent-terminal-w', `${w}px`),
  });
  const isResizing = panelResize.isDragging || tocResize.isDragging || agentTerminalResize.isDragging;

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
      setRightSidebarTab('annotations');
      return;
    }
    setRightSidebarTab('annotations');
    setIsPanelOpen(prev => rightSidebarTab === 'annotations' ? !prev : true);
  }, [exitWideMode, rightSidebarTab, wideModeType]);

  const dismissPlanAIAnnouncement = useCallback(() => {
    markPlanAIAnnouncementSeen();
    setShowPlanAIAnnouncement(false);
  }, []);

  const dismissLookAndFeelAnnouncement = useCallback(() => {
    markLookAndFeelAnnouncementSeen();
    setShowLookAndFeelAnnouncement(false);
  }, []);

  const handleAIChatToggle = useCallback(() => {
    dismissPlanAIAnnouncement();
    if (wideModeType !== null) {
      exitWideMode({ restore: false, panelOpen: true });
      setRightSidebarTab('ai');
      return;
    }
    setRightSidebarTab('ai');
    setIsPanelOpen(prev => rightSidebarTab === 'ai' ? !prev : true);
  }, [dismissPlanAIAnnouncement, exitWideMode, rightSidebarTab, wideModeType]);

  const hideAgentTerminal = useCallback(() => {
    setIsAgentTerminalOpen(false);
  }, []);

  const setAgentTerminalDelivery = useCallback((delivery: AgentTerminalDeliveryRecord | null) => {
    agentTerminalDeliveryRef.current = delivery;
    setAgentTerminalDeliveryState(delivery);
  }, []);

  const closeAgentTerminal = useCallback(() => {
    if (agentTerminalRef.current) {
      agentTerminalRef.current.stop();
      return;
    }
    setIsAgentTerminalRunning(false);
    setIsAgentTerminalReady(false);
    setAgentTerminalSessionId(null);
    setAgentTerminalDelivery(null);
    hideAgentTerminal();
  }, [hideAgentTerminal, setAgentTerminalDelivery]);

  const handleAgentTerminalReadyChange = useCallback((ready: boolean) => {
    setIsAgentTerminalReady(ready);
    setAgentTerminalDelivery(null);
    if (!ready) {
      setAgentTerminalSessionId(null);
      return;
    }
    agentTerminalSessionSeqRef.current += 1;
    setAgentTerminalSessionId(agentTerminalSessionSeqRef.current);
  }, [setAgentTerminalDelivery]);

  const openAgentTerminal = useCallback(() => {
    if (wideModeType !== null) {
      exitWideMode({ restore: false, panelOpen: false });
    }
    setIsAgentTerminalOpen(true);
  }, [exitWideMode, wideModeType]);

  const toggleAgentTerminal = useCallback(() => {
    if (isAgentTerminalOpen) {
      hideAgentTerminal();
      return;
    }
    openAgentTerminal();
  }, [hideAgentTerminal, isAgentTerminalOpen, openAgentTerminal]);

  useEffect(() => {
    if (annotateMode && annotateSource !== 'message' && agentTerminalCapability) return;
    closeAgentTerminal();
  }, [agentTerminalCapability, annotateMode, annotateSource, closeAgentTerminal]);

  // Sync sidebar open state when the "Auto-open Sidebar" preference changes in
  // Settings. Deliberately does NOT react to the document or render mode —
  // switching files (e.g. in annotate-folder) leaves the sidebar exactly as the
  // user left it.
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
  const warnFinishEditingFirst = useCallback((target: 'versions' | 'diff') => {
    toast('Finish editing first', {
      description: target === 'versions'
        ? 'Use "Done editing" before changing the comparison version.'
        : 'Use "Done editing" before opening the version diff.',
    });
  }, []);
  const handleSelectBaseVersion = useCallback((version: number) => {
    if (isEditingMarkdown) {
      warnFinishEditingFirst('versions');
      return Promise.resolve();
    }
    return planDiff.selectBaseVersion(version);
  }, [isEditingMarkdown, planDiff.selectBaseVersion, warnFinishEditingFirst]);
  const handleActivatePlanDiff = useCallback(() => {
    if (isEditingMarkdown) {
      warnFinishEditingFirst('diff');
      return;
    }
    setIsPlanDiffActive(true);
  }, [isEditingMarkdown, warnFinishEditingFirst]);

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

  const snapshotActiveEditableDocument = useCallback(() => {
    if (!activeEditableDocument) return;
    if (isEditingMarkdown) {
      const live = markdownEditorHandleRef.current?.getMarkdown();
      if (live != null) editableDocuments.updateActiveText(live, { forceNotify: true });
      return;
    }
    editableDocuments.updateActiveText(displayedMarkdown, { forceNotify: true });
  }, [activeEditableDocument, displayedMarkdown, editableDocuments, isEditingMarkdown]);

  const getLinkedDocumentMarkdown = useCallback((filepath: string, fallback?: string) => {
    return editableDocuments.getCurrentText(`file:${filepath}`) ?? fallback;
  }, [editableDocuments]);

  const restoreLinkedDocumentEditableKey = useCallback(() => {
    const restoreKey = suspendedRootEditableKeyRef.current;
    suspendedRootEditableKeyRef.current = null;
    editableDocuments.setActiveKey(restoreKey);
  }, [editableDocuments]);

  const handleLinkedDocumentLoaded = useCallback((doc: { markdown?: string; filepath?: string; renderAs?: 'markdown' | 'html'; sourceSave?: SourceSaveCapability }) => {
    if (annotateSource !== 'folder') {
      if (activeEditableDocument?.sourceSave?.enabled) {
        suspendedRootEditableKeyRef.current = activeEditableDocument.key;
        editableDocuments.setActiveKey(null);
      }
      return undefined;
    }

    if (doc.renderAs === 'html' || !doc.filepath || doc.markdown == null) {
      editableDocuments.setActiveKey(null);
      return undefined;
    }

    const sourceSave = doc.sourceSave ?? null;
    const key = editableDocumentKey(sourceSave, `file:${doc.filepath}`);
    editableDocuments.openDocument({ key, text: doc.markdown, sourceSave });
    const currentText = editableDocuments.getCurrentText(key) ?? doc.markdown;
    const record = editableDocuments.getDocument(key);

    if (isEditingMarkdown) {
      editSessionBaseRef.current = currentText;
      setEditorDirty(false);
      setEditorDiffersFromBaseline(record ? currentText !== record.diskBaseline : false);
    }

    return currentText;
  }, [activeEditableDocument, annotateSource, editableDocuments, isEditingMarkdown]);

  // Linked document navigation
  const linkedDocHook = useLinkedDoc({
    markdown, annotations, selectedAnnotationId, globalAttachments,
    setMarkdown, setAnnotations, setSelectedAnnotationId, setGlobalAttachments,
    renderAs, rawHtml, shareHtml, setRenderAs, setRawHtml, setShareHtml,
    viewerRef, sidebar: linkedDocSidebar, sourceFilePath, sourceConverted,
    onBeforeNavigate: snapshotActiveEditableDocument,
    onDocumentLoaded: handleLinkedDocumentLoaded,
    getDocumentMarkdown: getLinkedDocumentMarkdown,
    onAfterBack: restoreLinkedDocumentEditableKey,
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
    if (isAgentTerminalOpen) hideAgentTerminal();
    setWideModeType(type);
    sidebar.close();
    setIsPanelOpen(false);
  }, [canUseWideMode, hideAgentTerminal, isAgentTerminalOpen, isPanelOpen, wideModeType, sidebar.activeTab, sidebar.close, sidebar.isOpen]);

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

  const buildCurrentMessageState = React.useCallback((): MessageAnnotationState | null => {
    if (annotateSource !== 'message' || !selectedMessageId) return null;
    const msg = recentMessages.find((m) => m.messageId === selectedMessageId);
    if (!msg) return null;
    const snapshot = linkedDocHook.snapshotSession();
    return normalizeMessageState({
      messageId: msg.messageId,
      text: msg.text,
      timestamp: msg.timestamp,
      linkedDocSession: snapshot,
      codeAnnotations: [...codeAnnotations],
      selectedCodeAnnotationId,
    }, msg);
  }, [
    annotateSource,
    selectedMessageId,
    recentMessages,
    linkedDocHook.snapshotSession,
    codeAnnotations,
    selectedCodeAnnotationId,
  ]);

  const getMessageStatesWithCurrent = React.useCallback((): Map<string, MessageAnnotationState> => {
    const states = new Map(messageStateCacheRef.current);
    const current = buildCurrentMessageState();
    if (current) states.set(current.messageId, current);
    return states;
  }, [buildCurrentMessageState]);

  const saveCurrentMessageState = React.useCallback((): Map<string, MessageAnnotationState> => {
    const states = getMessageStatesWithCurrent();
    messageStateCacheRef.current = states;
    setCachedMessageAnnotationCounts(buildMessageAnnotationCounts(states));
    return states;
  }, [getMessageStatesWithCurrent]);

  const buildMessageAnnotationEntries = React.useCallback((): MessageAnnotationEntry[] => {
    if (annotateSource !== 'message' || recentMessages.length === 0) return [];
    // Must be a PURE read: this runs on the render path via
    // currentFeedbackPayload (useMemo) -> getCurrentFeedbackPayload ->
    // buildFullAnnotationsOutput. saveCurrentMessageState() writes React state
    // (setCachedMessageAnnotationCounts), which during render is an infinite
    // re-render loop in multi-message mode (#949). getMessageStatesWithCurrent
    // returns the same merged data without the setState side effect; the cache
    // persistence happens in event handlers (handleSelectMessage) instead.
    const states = getMessageStatesWithCurrent();
    return recentMessages.map((msg) => {
      const state = states.get(msg.messageId) ?? createEmptyMessageState(msg);
      const linkedDocs: Map<string, LinkedDocAnnotationEntry> = new Map();
      for (const [filepath, doc] of state.linkedDocSession.docs) {
        linkedDocs.set(filepath, {
          ...doc,
          blocks: doc.markdown ? parseMarkdownToBlocks(doc.markdown) : undefined,
        });
      }
      return {
        messageId: msg.messageId,
        text: msg.text,
        timestamp: msg.timestamp,
        annotations: state.linkedDocSession.root.annotations,
        globalAttachments: state.linkedDocSession.root.globalAttachments,
        blocks: parseMarkdownToBlocks(state.linkedDocSession.root.markdown),
        linkedDocs,
        codeAnnotations: state.codeAnnotations,
      };
    });
  }, [annotateSource, recentMessages, getMessageStatesWithCurrent]);

  const activeMessageAnnotationCounts = React.useMemo(() => {
    const counts = new Map(cachedMessageAnnotationCounts);
    const current = buildCurrentMessageState();
    if (current) {
      const count = countMessageAnnotations(current);
      if (count > 0) counts.set(current.messageId, count);
      else counts.delete(current.messageId);
    }
    return counts;
  }, [cachedMessageAnnotationCounts, buildCurrentMessageState]);

  const messageFeedbackAnnotationCount = React.useMemo(
    () => Array.from(activeMessageAnnotationCounts.values()).reduce((sum, count) => sum + count, 0),
    [activeMessageAnnotationCounts]
  );

  const annotatedMessageIds = React.useMemo(
    () => Array.from(activeMessageAnnotationCounts.keys()),
    [activeMessageAnnotationCounts]
  );

  // File browser file selection: open via linked doc system
  // For vault dirs (isVault), use the Obsidian doc endpoint; otherwise use generic /api/doc
  const handleSelectMessage = React.useCallback((messageId: string) => {
    const msg = recentMessages.find((m) => m.messageId === messageId);
    if (!msg || messageId === selectedMessageId) return;

    const states = saveCurrentMessageState();
    const targetState = normalizeMessageState(
      states.get(messageId) ?? createEmptyMessageState(msg),
      msg,
    );

    setSelectedMessageId(messageId);
    linkedDocHook.restoreSession(targetState.linkedDocSession);
    setCodeAnnotations([...targetState.codeAnnotations]);
    setSelectedCodeAnnotationId(targetState.selectedCodeAnnotationId);
  }, [
    recentMessages,
    selectedMessageId,
    saveCurrentMessageState,
    linkedDocHook.restoreSession,
  ]);

  const handleFileBrowserSelect = React.useCallback((absolutePath: string, dirPath: string) => {
    const normalizedAbsolutePath = normalizeBrowserPath(absolutePath);
    const dirState = fileBrowser.dirs.find(d => d.path === dirPath);
    const normalizedDirPath = normalizeBrowserPath(dirPath);
    const dirPrefix = normalizedDirPath === "/" || /^[A-Za-z]:\/$/.test(normalizedDirPath)
      ? normalizedDirPath
      : `${normalizedDirPath}/`;
    const relativePath = normalizedAbsolutePath === normalizedDirPath
      ? ""
      : normalizedAbsolutePath.startsWith(dirPrefix)
        ? normalizedAbsolutePath.slice(dirPrefix.length)
        : undefined;
    const editableStatus = getFileEditStatus(
      absolutePath,
      editableDocuments.fileEditStatuses,
      relativePath,
      dirState?.workspaceStatus,
    );
    const editableKey = editableStatus?.key ?? `file:${absolutePath}`;
    const editableRecord = editableDocuments.getDocument(editableKey);
    if (editableRecord?.missingOnDisk && editableRecord.sourceSave?.enabled) {
      linkedDocHook.openLoaded({
        filepath: editableRecord.path ?? absolutePath,
        markdown: editableRecord.currentText,
        renderAs: 'markdown',
        sourceSave: editableRecord.sourceSave,
      }, 'files', { notifyDocumentLoaded: false });
      editableDocuments.setActiveKey(editableKey);
      if (isEditingMarkdown) {
        editSessionBaseRef.current = editableRecord.currentText;
        setEditorDirty(false);
        setEditorDiffersFromBaseline(editableRecord.currentText !== editableRecord.diskBaseline);
        setEditStats(
          editableRecord.currentText !== editableRecord.diskBaseline
            ? computeEditStats(editableRecord.diskBaseline, editableRecord.currentText)
            : null,
        );
      }
      fileBrowser.setActiveFile(absolutePath);
      return;
    }

    const buildUrl = dirState?.isVault
      ? (path: string) => `/api/reference/obsidian/doc?vaultPath=${encodeURIComponent(dirPath)}&path=${encodeURIComponent(path)}`
      : (path: string) => `/api/doc?path=${encodeURIComponent(path)}&base=${encodeURIComponent(dirPath)}${convertHtml ? '&convert=1' : ''}`;
    linkedDocHook.open(absolutePath, buildUrl, 'files');
    fileBrowser.setActiveFile(absolutePath);
  }, [editableDocuments, linkedDocHook, fileBrowser, convertHtml, isEditingMarkdown]);

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
        `/api/doc?path=${encodeURIComponent(path)}&base=${encodeURIComponent(baseDir)}${convertHtml ? '&convert=1' : ''}`
      );
    } else {
      // Pass the current file's directory as base for relative path resolution
      const baseDir = linkedDocHook.filepath
        ? linkedDocHook.filepath.replace(/\/[^/]+$/, '')
        : imageBaseDir?.includes('/') ? imageBaseDir : undefined;
      if (baseDir) {
        linkedDocHook.open(docPath, (path) =>
          `/api/doc?path=${encodeURIComponent(path)}&base=${encodeURIComponent(baseDir)}${convertHtml ? '&convert=1' : ''}`
        );
      } else {
        linkedDocHook.open(docPath);
      }
    }
  }, [fileBrowser.dirs, fileBrowser.activeDirPath, fileBrowser.activeFile, linkedDocHook, imageBaseDir, convertHtml]);

  // Wrap linked doc back to also clear file browser active file
  const handleLinkedDocBack = React.useCallback(() => {
    linkedDocHook.back();
    if (isEditingMarkdown) {
      setIsEditingMarkdown(false);
      setEditorDirty(false);
      setEditorDiffersFromBaseline(false);
    }
    fileBrowser.setActiveFile(null);
    archive.clearSelection();
  }, [linkedDocHook, isEditingMarkdown, fileBrowser, archive]);

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
      if (allDirPaths.some(dir => pathIsInsideDir(fp, dir))) {
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

  // Viewer identity must change when the rendered document changes: web-highlighter
  // mutates the Viewer DOM, so reconciling new content against the old subtree throws
  // removeChild errors — a changed key remounts it cleanly instead. StickyHeaderLane
  // observes a node inside Viewer, so it re-anchors off the same token.
  const viewerContentKey = linkedDocHook.isActive
    ? `doc:${linkedDocHook.filepath}`
    : annotateSource === 'message' && selectedMessageId
      ? `msg:${selectedMessageId}`
      : `plan:${editGeneration}`;

  // Track active section for TOC highlighting
  const headingCount = useMemo(() => blocks.filter(b => b.type === 'heading').length, [blocks]);
  const activeSection = useActiveSection(containerRef, headingCount, scrollViewport);

  const { editorAnnotations, deleteEditorAnnotation } = useEditorAnnotations();
  const { externalAnnotations, updateExternalAnnotation, deleteExternalAnnotation } = useExternalAnnotations<Annotation>({ enabled: isApiMode && !goalSetupMode });

  // Drive DOM highlights for SSE-delivered external annotations. Disabled
  // while a linked doc overlay is open (Viewer DOM is hidden) and while the
  // plan diff view is active (diff view has its own annotation surface).
  const { reset: resetExternalHighlights } = useExternalAnnotationHighlights({
    viewerRef,
    externalAnnotations,
    enabled: isApiMode && !goalSetupMode && !linkedDocHook.isActive && !isPlanDiffActive && !isEditingMarkdown,
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
  const messageMultiSelectMode = annotateSource === 'message' && recentMessages.length > 1;
  const hasAnyAnnotations = useMemo(
    () => messageMultiSelectMode
      ? messageFeedbackAnnotationCount > 0 || editorAnnotations.length > 0
      : allAnnotations.length > 0
        || codeAnnotations.length > 0
        || editorAnnotations.length > 0
        || linkedDocHook.docAnnotationCount > 0
        || globalAttachments.length > 0,
    [
      messageMultiSelectMode,
      messageFeedbackAnnotationCount,
      allAnnotations.length,
      codeAnnotations.length,
      editorAnnotations.length,
      linkedDocHook.docAnnotationCount,
      globalAttachments.length,
    ],
  );
  const feedbackAnnotationCount = messageMultiSelectMode
    ? messageFeedbackAnnotationCount + editorAnnotations.length
    : allAnnotations.length +
      codeAnnotations.length +
      editorAnnotations.length +
      linkedDocHook.docAnnotationCount +
      globalAttachments.length;

  const buildFullAnnotationsOutput = React.useCallback((): string => {
    if (messageMultiSelectMode) {
      let output = exportMessageAnnotations(buildMessageAnnotationEntries());
      if (editorAnnotations.length > 0) {
        output += `\n\n${exportEditorAnnotations(editorAnnotations)}`;
      }
      return output;
    }
    return '';
  }, [messageMultiSelectMode, buildMessageAnnotationEntries, editorAnnotations]);

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

  // Code-file comments are intentionally not serialized into share URLs in v1.
  // Hide share entry points once they exist so we do not silently drop feedback.
  const canShareCurrentSession = sharingEnabled && codeAnnotations.length === 0;

  const resolveRawHtmlForShare = useCallback(async (): Promise<string | null> => {
    if (renderAs !== 'html' || !rawHtml) return null;
    if (shareHtml) return shareHtml;
    if (!isApiMode) return rawHtml;

    const params = new URLSearchParams();
    const activePath = linkedDocHook.filepath ?? sourceFilePath;
    if (activePath) params.set('path', activePath);
    const query = params.toString();
    const res = await fetch(`/api/share-html${query ? `?${query}` : ''}`);
    const data = (await res.json().catch(() => ({}))) as { shareHtml?: unknown; error?: string };
    if (!res.ok || data.error || typeof data.shareHtml !== 'string') {
      throw new Error(data.error || 'Failed to prepare HTML for sharing');
    }
    setShareHtml(data.shareHtml);
    return data.shareHtml;
  }, [isApiMode, linkedDocHook.filepath, rawHtml, renderAs, shareHtml, sourceFilePath]);

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
    renderAs === 'html' ? rawHtml : undefined,
    resolveRawHtmlForShare,
    setRawHtml,
    setShareHtml,
    setRenderAs,
  );

  useEffect(() => {
    if (initialSidebarPreferenceAppliedRef.current) return;
    if (isLoading || isLoadingShared) return;
    if (wideModeType !== null) return;

    initialSidebarPreferenceAppliedRef.current = true;
    if (archive.archiveMode || goalSetupMode || annotateSource === 'folder') return;
    if (renderAs === 'html') {
      sidebar.close();
      return;
    }
    if (uiPrefs.tocEnabled && hasTocEntries) {
      sidebar.open('toc');
    }
  }, [
    annotateSource,
    archive.archiveMode,
    goalSetupMode,
    hasTocEntries,
    isLoading,
    isLoadingShared,
    renderAs,
    sidebar.close,
    sidebar.open,
    uiPrefs.tocEnabled,
    wideModeType,
  ]);

  const ensureShareLink = useCallback(async (): Promise<string | null> => {
    const existing = shortShareUrl || shareUrl;
    if (existing) return existing;
    if (!canShareCurrentSession) return null;
    return await generateShortUrl();
  }, [canShareCurrentSession, generateShortUrl, shareUrl, shortShareUrl]);

  // useLayoutEffect + synchronous getBoundingClientRect so the initial
  // bucket is set before the browser paints. Otherwise narrow viewports
  // get a one-frame flash of "Global comment"/"Copy plan" labels before
  // the ResizeObserver callback collapses them.
  useLayoutEffect(() => {
    if (isLoading && !isSharedSession) return;

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
  }, [isLoading, isSharedSession]);

  // The user's current direct-edit text: the open editor buffer, else the
  // last commit; null when there is none or it matches the baseline. Never
  // the shared `markdown` state, which linked docs, message switching, and
  // checkbox toggles legitimately mutate. Feeds both the draft auto-save and
  // the Direct Edits feedback section.
  const getEditedMarkdown = useCallback((): string | null => {
    const activeDocument = editableDocuments.getActiveDocumentLive();
    if (activeDocument?.sourceSave?.enabled) {
      const live = isEditingMarkdown ? markdownEditorHandleRef.current?.getMarkdown() : null;
      return normalizeEditedMarkdown(activeDocument.diskBaseline, live ?? activeDocument.currentText);
    }

    const base = originalMarkdownRef.current;
    if (base === null) return null;
    const live = isEditingMarkdown ? markdownEditorHandleRef.current?.getMarkdown() : null;
    return normalizeEditedMarkdown(base, live ?? editedMarkdownRef.current);
  }, [editableDocuments, isEditingMarkdown]);

  const getDraftEditedMarkdown = useCallback((): string | null => {
    if (editableDocuments.getActiveDocumentLive()?.sourceSave?.enabled) return null;
    return getEditedMarkdown();
  }, [editableDocuments, getEditedMarkdown]);

  // Auto-save annotation drafts
  const { draftBanner, restoreDraft, scheduleDraftSave, scheduleDraftSaveAfterSubmitFailure, getDraftGeneration, dismissDraft } = useAnnotationDraft({
    annotations: allAnnotations,
    codeAnnotations,
    globalAttachments,
    getEditedMarkdown: getDraftEditedMarkdown,
    getEditedDocuments: editableDocuments.getDraftDocuments,
    getSavedFileChanges: editableDocuments.getDraftSavedFileChanges,
    isApiMode: isApiMode && !goalSetupMode,
    isSharedSession,
    // isSubmitting counts: a save firing while approve/deny is in flight can
    // land after the server's draft delete and ghost a "Draft Recovered"
    // banner into the next session for this plan. Saving resumes if it fails.
    submitted: !!submitted || isSubmitting,
  });

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

  // Markdown edit mode: single consolidated gate. The editor only ever opens on
  // the main plan/file markdown — never on HTML surfaces, archive/goal-setup
  // views, linked docs, messages, folder pickers, diff view, or shared sessions.
  const canEditMarkdown =
    renderAs !== 'html' &&
    // editStats non-null keeps the toggle available after committing an
    // emptied document, so the user can re-enter and undo. Source-backed files
    // are editable even when they start empty.
    (activeEditableDocument?.sourceSave?.enabled || displayedMarkdown !== '' || editStats !== null) &&
    !archive.archiveMode &&
    !goalSetupMode &&
    (!linkedDocHook.isActive || (annotateSource === 'folder' && activeEditableDocument?.sourceSave?.enabled)) &&
    !isPlanDiffActive &&
    !isSharedSession &&
    annotateSource !== 'message' &&
    !submitted;

  // Swap the document to `next` and re-resolve annotation block anchors against
  // the new parse so exported line labels don't point at stale content.
  // Annotations whose text no longer exists get blockId '' — exportAnnotations
  // omits the line label instead of emitting a wrong one. Returns the remapped
  // objects so callers repaint THOSE, not the pre-remap ones (whose stale
  // startMeta/endMeta would let fromStore() silently highlight wrong content).
  // `list` defaults to current state; draft restore passes the restored set,
  // which isn't in state yet when the remap runs.
  const applyEditedDocument = useCallback((next: string, list?: Annotation[]): Annotation[] => {
    const sourceAnnotations = list ?? annotationsRef.current;
    const newBlocks = parseMarkdownToBlocks(next);
    const remapped = sourceAnnotations.map((a) => {
      if (a.diffContext || a.type === AnnotationType.GLOBAL_COMMENT || a.id.startsWith('ann-checkbox-')) return a;
      const blk = newBlocks.find((b) => b.content.includes(a.originalText));
      if ((blk?.id ?? '') === a.blockId) return a;
      // Block moved: also strip startMeta/endMeta — fromStore() anchors by
      // positional parent index without validating text. Text-search is safe.
      return { ...a, blockId: blk?.id ?? '', startMeta: undefined, endMeta: undefined };
    });
    setMarkdown(next);
    setEditGeneration((g) => g + 1);
    annotationsRef.current = remapped;
    setAnnotations(remapped);
    return remapped;
  }, []);

  // The Viewer is remounted after every edit-mode exit (it was unmounted while
  // editing), so highlight DOM is rebuilt from scratch. Re-anchor via the same
  // text-search restore used by draft/share/linked-doc flows, then report
  // annotations whose text vanished. resetExternalHighlights repaints live SSE
  // annotation highlights the same way the share-import path does.
  const repaintHighlights = useCallback((list: Annotation[]) => {
    resetExternalHighlights();
    const planAnnotations = list.filter(
      (a) => !a.diffContext && a.type !== AnnotationType.GLOBAL_COMMENT && !a.id.startsWith('ann-checkbox-')
    );
    if (planAnnotations.length === 0) return;
    setTimeout(() => {
      viewerRef.current?.applySharedAnnotations(planAnnotations);
      // web-highlighter restores use data-highlight-id; manual code-block
      // wraps use data-bind-id. Either counts as present.
      const missing = planAnnotations.filter(
        (a) => !document.querySelector(`[data-bind-id="${a.id}"], [data-highlight-id="${a.id}"]`)
      );
      if (missing.length > 0) {
        toast(`${missing.length} annotation${missing.length === 1 ? '' : 's'} no longer match the text`, {
          description: 'The highlighted text was edited. They remain listed in the panel.',
          duration: 5000,
        });
      }
    }, 120);
  }, [resetExternalHighlights]);

  // Commits the open editor buffer: updates markdown state, records the edit
  // for the Direct Edits diff, re-anchors annotations, repaints highlights.
  const commitMarkdownEdits = useCallback(() => {
    if (!isEditingMarkdown) return;
    const edited = markdownEditorHandleRef.current?.getMarkdown();
    setIsEditingMarkdown(false);
    setEditorDirty(false);
    setEditorDiffersFromBaseline(false);

    const base = originalMarkdownRef.current;
    if (edited != null) {
      if (activeEditableDocument?.sourceSave?.enabled) {
        editableDocuments.updateActiveText(edited, { forceNotify: true });
        const sourceEdited = normalizeEditedMarkdown(activeEditableDocument.diskBaseline, edited);
        editedMarkdownRef.current = null;
        setEditStats(sourceEdited !== null ? computeEditStats(activeEditableDocument.diskBaseline, sourceEdited) : null);
        if (sourceEdited !== null && window.innerWidth >= 768) {
          setRightSidebarTab('annotations');
          setIsPanelOpen(true);
        }
      } else {
        const normalizedEdited = normalizeEditedMarkdown(base, edited);
        editedMarkdownRef.current = normalizedEdited;
        setEditStats(base !== null && normalizedEdited !== null ? computeEditStats(base, normalizedEdited) : null);
        // Surface the Direct Edits card so the user sees where their changes went.
        if (base !== null && normalizedEdited !== null && window.innerWidth >= 768) {
          setRightSidebarTab('annotations');
          setIsPanelOpen(true);
        }
      }
    }

    const renderedBaseline = activeEditableDocument?.sourceSave?.enabled ? markdown : displayedMarkdown;
    const remapped = edited != null && edited !== renderedBaseline ? applyEditedDocument(edited) : annotations;
    repaintHighlights(remapped);
    scheduleDraftSave();
  }, [activeEditableDocument, displayedMarkdown, editableDocuments, isEditingMarkdown, annotations, markdown, applyEditedDocument, repaintHighlights, scheduleDraftSave]);

  // Discards direct edits for one document. Source-backed folder edits are
  // file-scoped; normal plan-review edits still have a single document.
  const handleDiscardEdits = useCallback((sourceKey?: string) => {
    const targetKey = sourceKey ?? activeEditableDocument?.key;
    const targetIsActive = !!targetKey && editableDocuments.getActiveKey() === targetKey;
    const targetRecord = targetKey ? editableDocuments.getDocument(targetKey) : null;
    if (sourceKey && !targetRecord?.sourceSave?.enabled) return;

    if (targetKey && targetRecord?.sourceSave?.enabled) {
      const discarded = editableDocuments.discardDocument(targetKey);
      if (!discarded) return;
      if (!targetIsActive) {
        scheduleDraftSave();
        return;
      }

      setIsEditingMarkdown(false);
      setEditorDirty(false);
      setEditorDiffersFromBaseline(false);
      editedMarkdownRef.current = null;
      setEditStats(null);
      if (discarded.missingOnDisk) {
        if (linkedDocHook.isActive) {
          linkedDocHook.back();
          fileBrowser.setActiveFile(null);
        } else {
          const remapped = displayedMarkdown !== ''
            ? applyEditedDocument('')
            : annotations;
          repaintHighlights(remapped);
          originalMarkdownRef.current = '';
        }
        scheduleDraftSave();
        return;
      }
      const remapped = displayedMarkdown !== discarded.diskBaseline
        ? applyEditedDocument(discarded.diskBaseline)
        : annotations;
      repaintHighlights(remapped);
      scheduleDraftSave();
      return;
    }

    const base = originalMarkdownRef.current;
    if (base === null) return;
    setIsEditingMarkdown(false);
    setEditorDirty(false);
    setEditorDiffersFromBaseline(false);
    editedMarkdownRef.current = null;
    setEditStats(null);
    const remapped = markdown !== base ? applyEditedDocument(base) : annotations;
    repaintHighlights(remapped);
    scheduleDraftSave();
  }, [activeEditableDocument, editableDocuments, displayedMarkdown, markdown, annotations, applyEditedDocument, repaintHighlights, linkedDocHook, fileBrowser, scheduleDraftSave]);

  // Restores a recovered draft: annotations always; direct edits when present
  // and the baseline exists. Edits flow through the same helpers
  // commitMarkdownEdits uses, with the RESTORED annotations remapped against
  // the edited document (they aren't in state yet when the remap runs).
  const resolveSavedFileChangeSource = useCallback((
    change: SavedFileChangeDraftData,
  ) => {
    return probeSourceSave(change.path);
  }, []);

  const validateDraftSavedFileChanges = useCallback(async (
    changes: SavedFileChangeDraftData[],
  ): Promise<{ kept: SavedFileChangeDraftData[]; changedOrMissing: SavedFileChangeDraftData[]; unverified: SavedFileChangeDraftData[] }> => {
    if (changes.length === 0) return { kept: [], changedOrMissing: [], unverified: [] };
    const result = await validateSavedFileChanges(changes, resolveSavedFileChangeSource);
    const changedOrMissing = result.dropped
      .filter((entry) => entry.reason === 'changed' || entry.reason === 'missing')
      .map((entry) => entry.change);

    if (changedOrMissing.length > 0) {
      toast('Some saved edit context was not restored', {
        description: 'Those files changed or disappeared after Plannotator saved them.',
        duration: 5000,
      });
    }
    if (result.unverified.length > 0) {
      toast('Some saved edit context could not be verified', {
        description: 'Plannotator kept it for now and will check again before sending feedback.',
        duration: 5000,
      });
    }

    return {
      kept: [...result.valid, ...result.unverified],
      changedOrMissing,
      unverified: result.unverified,
    };
  }, [resolveSavedFileChangeSource]);

  const handleRestoreDraft = React.useCallback(async () => {
    const {
      annotations: restored,
      codeAnnotations: restoredCode,
      globalAttachments: restoredGlobal,
      editedMarkdown,
      editedDocuments,
      savedFileChanges,
    } = restoreDraft();
    if (restoredCode.length > 0) setCodeAnnotations(restoredCode);
    if (restoredGlobal.length > 0) setGlobalAttachments(restoredGlobal);

    const nestedSavedFileChanges = editedDocuments
      .map((doc) => doc.savedChange)
      .filter((change): change is SavedFileChangeDraftData => !!change);
    const savedChangeCandidates = new Map<string, SavedFileChangeDraftData>();
    for (const change of [...savedFileChanges, ...nestedSavedFileChanges]) {
      savedChangeCandidates.set(change.key, change);
    }
    const validatedSaved = await validateDraftSavedFileChanges([...savedChangeCandidates.values()]);
    const validSavedChangeByKey = new Map(validatedSaved.kept.map((change) => [change.key, change]));
    const editedDocumentKeys = new Set(editedDocuments.map((doc) => doc.key));
    const cleanSavedFileChanges = validatedSaved.kept.filter((change) => !editedDocumentKeys.has(change.key));
    const editedDocumentsForRestore: DraftEditedDocument[] = editedDocuments.map((doc) =>
      doc.savedChange
        ? { ...doc, savedChange: validSavedChangeByKey.get(doc.savedChange.key) }
        : doc
    );

    if (cleanSavedFileChanges.length > 0) {
      editableDocuments.restoreSavedFileChanges(cleanSavedFileChanges);
      if (window.innerWidth >= 768) {
        setRightSidebarTab('annotations');
        setIsPanelOpen(true);
      }
    }

    if (editedDocumentsForRestore.length > 0) {
      if (isEditingMarkdown) {
        toast('Draft file edits were not restored', {
          description: 'You already have edits in this session — those take precedence.',
          duration: 5000,
        });
      } else {
        const restoredDocumentKeys = editableDocuments.restoreDraftDocuments(editedDocumentsForRestore);
        if (restoredDocumentKeys.length < editedDocumentsForRestore.length) {
          toast('Some draft file edits were not restored', {
            description: 'You already have edits in this session — those take precedence.',
            duration: 5000,
          });
        }
        const restoredSingleFileDraft = pickRestoredSingleFileDraftToDisplay(
          editedDocumentsForRestore,
          restoredDocumentKeys,
          editableDocuments.getActiveKey(),
        );
        if (restoredSingleFileDraft) {
          editableDocuments.setActiveKey(restoredSingleFileDraft.key);
          const restoredDocument = editableDocuments.getDocument(restoredSingleFileDraft.key);
          if (restoredDocument?.sourceSave?.enabled) {
            const remapped = applyEditedDocument(restoredDocument.currentText, restored);
            repaintHighlights(remapped);
            if (restoredDocument.currentText !== restoredDocument.diskBaseline) {
              setEditStats(computeEditStats(restoredDocument.diskBaseline, restoredDocument.currentText));
              if (window.innerWidth >= 768) {
                setRightSidebarTab('annotations');
                setIsPanelOpen(true);
              }
            }
            scheduleDraftSave();
            return;
          }
        }
        const activeRestoredDocument = editableDocuments.getActiveDocumentLive();
        const activeDraft = activeRestoredDocument?.sourceSave?.enabled && restoredDocumentKeys.includes(activeRestoredDocument.key)
          ? editedDocumentsForRestore.find((doc) => doc.key === activeRestoredDocument.key)
          : undefined;
        if (activeDraft && activeRestoredDocument) {
          const remapped = applyEditedDocument(activeRestoredDocument.currentText, restored);
          repaintHighlights(remapped);
          if (activeRestoredDocument.currentText !== activeRestoredDocument.diskBaseline) {
            setEditStats(computeEditStats(activeRestoredDocument.diskBaseline, activeRestoredDocument.currentText));
            if (window.innerWidth >= 768) {
              setRightSidebarTab('annotations');
              setIsPanelOpen(true);
            }
          }
          scheduleDraftSave();
          return;
        }
      }
    }

    // CRLF normalize is insurance against a hand-edited draft file — a \r
    // here would fabricate a whole-document diff against the LF baseline.
    const base = originalMarkdownRef.current;
    const edited = editedMarkdown !== null ? editedMarkdown.replace(/\r\n?/g, '\n') : null;
    // editStats/isEditingMarkdown guards are defensive: the restore dialog is
    // modal on load, so live edits can't exist yet — but if they ever do,
    // the user's current work wins over the draft.
    if (edited !== null && base !== null && edited !== base && editStats === null && !isEditingMarkdown) {
      editedMarkdownRef.current = edited;
      setEditorDiffersFromBaseline(false);
      setEditStats(computeEditStats(base, edited));
      if (window.innerWidth >= 768) {
        setRightSidebarTab('annotations');
        setIsPanelOpen(true);
      }
      const remapped = applyEditedDocument(edited, restored);
      repaintHighlights(remapped);
      scheduleDraftSave();
      return;
    }
    if (edited !== null && (editStats !== null || isEditingMarkdown)) {
      // Skipped, not silently dropped: the user started editing before the
      // (late) draft banner was answered. Their live work wins.
      toast('Draft edits were not restored', {
        description: 'You already have edits in this session — those take precedence.',
        duration: 5000,
      });
    }

    if (restored.length > 0) {
      setAnnotations(restored);
      // Apply highlights to DOM after a tick
      setTimeout(() => {
        viewerRef.current?.applySharedAnnotations(restored.filter(a => !a.diffContext));
      }, 100);
    }
    scheduleDraftSave();
  }, [restoreDraft, validateDraftSavedFileChanges, editStats, isEditingMarkdown, editableDocuments, activeEditableDocument, markdown, applyEditedDocument, repaintHighlights, scheduleDraftSave]);

  const handleEditToggle = useCallback(() => {
    if (isEditingMarkdown) {
      commitMarkdownEdits();
      return;
    }
    // Normalize CRLF before it becomes a baseline (e.g. share-imported content) —
    // CM6 emits \n-joined text, and a CRLF baseline would fabricate a full diff.
    const normalized = displayedMarkdown.includes('\r') ? displayedMarkdown.replace(/\r\n?/g, '\n') : displayedMarkdown;
    if (normalized !== displayedMarkdown) {
      if (activeEditableDocument?.sourceSave?.enabled) {
        editableDocuments.updateActiveText(normalized, { forceNotify: true });
      } else {
        setMarkdown(normalized);
      }
    }
    // Safety net for paths that loaded content without setting the baseline.
    if (originalMarkdownRef.current === null) originalMarkdownRef.current = normalized;
    const base = originalMarkdownRef.current;
    editSessionBaseRef.current = normalized;
    if (activeEditableDocument?.sourceSave?.enabled) {
      editableDocuments.beginEdit(normalized);
    }
    setEditorDirty(false);
    setEditorDiffersFromBaseline(
      activeEditableDocument?.sourceSave?.enabled
        ? normalized !== activeEditableDocument.diskBaseline
        : base !== null && normalized !== base
    );
    setIsEditingMarkdown(true);
  }, [activeEditableDocument, displayedMarkdown, editableDocuments, isEditingMarkdown, commitMarkdownEdits]);

  // Live dirty tracking for the open editor session. String compare per
  // keystroke is fine at plan sizes; setState bails out on unchanged values.
  const handleEditorChange = useCallback((md: string) => {
    setEditorDirty(md !== editSessionBaseRef.current);
    if (activeEditableDocument?.sourceSave?.enabled) {
      editableDocuments.updateActiveText(md);
      setEditorDiffersFromBaseline(md !== activeEditableDocument.diskBaseline);
    } else {
      const base = originalMarkdownRef.current;
      setEditorDiffersFromBaseline(base !== null && md !== base);
    }
    // Mid-edit keystrokes persist too — a crash loses at most the debounce
    // window. The hook reads the live buffer via getDraftEditedMarkdown.
    if (agentTerminalDeliveryRef.current) {
      setAgentFeedbackRevision((version) => version + 1);
    }
    scheduleDraftSave();
  }, [activeEditableDocument, editableDocuments, scheduleDraftSave]);

  const unsavedEditableDocuments = useMemo(
    () => editableDocuments.getUnsavedDocuments(),
    [editableDocuments, editableDocuments.version],
  );
  const savedFileChanges = useMemo(
    () => editableDocuments.getSavedFileChanges(),
    [editableDocuments, editableDocuments.version],
  );
  const openSourceDocuments = useMemo(
    () => editableDocuments.getSourceDocuments(),
    [editableDocuments, editableDocuments.version],
  );
  const savedFileChangesForValidation = useMemo(() => {
    const sourceByKey = new Map(openSourceDocuments.map((doc) => [doc.key, doc.sourceSave]));
    return savedFileChanges
      .map((change): SavedFileChangeDraftData | null => {
        const sourceSave = sourceByKey.get(change.key);
        return sourceSave ? { ...change, sourceSave } : null;
      })
      .filter((change): change is SavedFileChangeDraftData => change !== null);
  }, [openSourceDocuments, savedFileChanges]);
  const activeSourceSave = activeEditableDocument?.sourceSave?.enabled
    ? activeEditableDocument.sourceSave
    : null;

  // Save-button display is driven by the editableDocuments state machine — one
  // source of truth for dirty/saving/saved, rather than a parallel flag.
  const activeSaveStatus = activeEditableDocument?.saveStatus;
  const hasUnsavedDiskChanges =
    activeSaveStatus === 'dirty' || activeSaveStatus === 'conflict' || activeSaveStatus === 'error' || activeSaveStatus === 'missing';
  // Emphasize the Save control (dot + primary text) whenever there is work to
  // persist or a save is in flight — one predicate drives both so they can't diverge.
  const emphasizeSave = hasUnsavedDiskChanges || activeSaveStatus === 'saving';
  // A rejected save (disk conflict or write error) — surfaced as a destructive
  // dot/label so it reads as "save failed, retry" rather than ordinary unsaved.
  const saveFailed = activeSaveStatus === 'conflict' || activeSaveStatus === 'error';
  const activeSourceBufferDirty =
    activeEditableDocument?.sourceSave?.enabled === true &&
    activeEditableDocument.currentText !== activeEditableDocument.diskBaseline;
  const canOverwriteDiskConflict =
    activeEditableDocument?.sourceSave?.enabled === true &&
    !!activeEditableDocument.diskConflict &&
    activeEditableDocument.currentText !== activeEditableDocument.diskConflict.text;

  // Editing exit control: a source-backed session with unsaved edits gets a
  // two-step "Cancel" (discard + exit). Plan mode and clean source sessions keep
  // the plain "Done" (commit edits + exit), so plan-mode keep behavior is unchanged.
  const cancelMode = isEditingMarkdown && !!activeSourceSave && (
    activeSourceBufferDirty ||
    activeSaveStatus === 'conflict' ||
    activeSaveStatus === 'error'
  );
  const handleEditExitClick = useCallback(() => {
    if (!isEditingMarkdown) { handleEditToggle(); return; }      // enter edit mode
    if (cancelMode) {                                            // discard flow (two-step)
      if (confirmCancelEdits) { setConfirmCancelEdits(false); handleDiscardEdits(); }
      else setConfirmCancelEdits(true);
      return;
    }
    handleEditToggle();                                          // commit edits + exit
  }, [isEditingMarkdown, cancelMode, confirmCancelEdits, handleEditToggle, handleDiscardEdits]);
  // Drop the discard confirmation once it no longer applies — exited the editor,
  // or the doc went clean (e.g. the user saved).
  useEffect(() => {
    if (!cancelMode && confirmCancelEdits) setConfirmCancelEdits(false);
  }, [cancelMode, confirmCancelEdits]);
  // Each file owns its edit state: switching the active file (folder mode keeps
  // the editor open across files) starts the discard confirmation fresh, so an
  // armed "Discard?" on one file can never drop another file's edits on first click.
  useEffect(() => {
    setConfirmCancelEdits(false);
  }, [activeEditableDocument?.key]);

  const hasUnsavedSourceFileBuffers = unsavedEditableDocuments.length > 0;

  // True when the feedback payload carries unsaved direct edits. Source-backed
  // file buffers are ordinary dirty editor state; they only become review
  // context once saved to disk and tracked through savedFileChanges.
  const hasDirectEdits =
    !activeSourceSave &&
    !hasUnsavedSourceFileBuffers &&
    (isEditingMarkdown ? editorDiffersFromBaseline : editedMarkdownRef.current !== null);
  const hasSavedFileChanges = savedFileChanges.length > 0;
  const hasFeedbackContent = hasAnyAnnotations || hasDirectEdits || hasSavedFileChanges;
  const feedbackLoss = feedbackLossDescription(feedbackAnnotationCount, hasDirectEdits);
  const hasUnsentFeedback = feedbackAnnotationCount > 0 || hasDirectEdits;
  const hasOnlySavedFileChanges = hasSavedFileChanges && !hasUnsentFeedback;
  const savedFileChangesLabel = savedFileChanges.length === 1 ? 'saved file change' : 'saved file changes';
  const savedFileChangesVerb = savedFileChanges.length === 1 ? 'is' : 'are';
  const savedFileChangesPronoun = savedFileChanges.length === 1 ? 'it' : 'them';
  const savedFileChangesOnDiskMessage = <>Your {savedFileChangesLabel} {savedFileChangesVerb} already on disk.</>;
  const savedFileAwarenessOnlyMessage = <>{savedFileChangesOnDiskMessage} The agent won't be told about {savedFileChangesPronoun}.</>;
  const savedFileAwarenessMixedMessage = hasSavedFileChanges
    ? <> Your {savedFileChangesLabel} will stay on disk, but the agent won't be told about {savedFileChangesPronoun}.</>
    : null;

  // Pinned "Direct edits" card data for the annotation sidebar. Source-backed
  // documents show saved-to-disk changes only; dirty buffers stay in the editor
  // and file tree until the user explicitly saves.
  const directEditsPanelInfo = useMemo(() => {
    if (savedFileChanges.length > 0) {
      return buildSavedFileChangePanelItems(savedFileChanges);
    }

    if (activeEditableDocument?.sourceSave?.enabled) return null;
    if (!editStats) return null;
    const base = originalMarkdownRef.current;
    const edited = editedMarkdownRef.current;
    if (base === null || edited === null) return null;
    return [buildPlanEditPanelItem(base, edited)];
  }, [activeEditableDocument, editStats, savedFileChanges]);

  // "Direct Edits" feedback section: unified diff of user edits vs the
  // as-submitted baseline. getEditedMarkdown owns the read discipline.
  const buildEditsSection = useCallback((): string => {
    if (activeSourceSave || hasUnsavedSourceFileBuffers) return '';
    const base = originalMarkdownRef.current;
    return buildDirectEditsSection(base, getEditedMarkdown(), sourceConverted);
  }, [activeSourceSave, getEditedMarkdown, hasUnsavedSourceFileBuffers, sourceConverted]);

  const buildSavedChangesSection = useCallback((changes = savedFileChanges): string => {
    return buildSavedFileChangesSection(
      changes.map((change) => ({
        path: change.path,
        basename: change.basename,
        beforeText: change.beforeText,
        afterText: change.afterText,
      })),
    );
  }, [savedFileChanges]);

  // Prepends the Direct Edits section to annotation feedback. When edits exist
  // but there are no annotations, the "no feedback" sentinel is replaced rather
  // than appended to.
  const composeFeedback = useCallback((annotationsText: string, checkedSavedFileChanges = savedFileChanges): string => {
    return composeFeedbackWithEditSections(
      annotationsText,
      buildEditsSection(),
      buildSavedChangesSection(checkedSavedFileChanges),
    );
  }, [buildEditsSection, buildSavedChangesSection]);

  const getCurrentFeedbackPayload = useCallback((checkedSavedFileChanges = savedFileChanges): string => {
    return composeFeedback(messageMultiSelectMode ? buildFullAnnotationsOutput() : annotationsOutput, checkedSavedFileChanges);
  }, [annotationsOutput, buildFullAnnotationsOutput, composeFeedback, messageMultiSelectMode, savedFileChanges]);

  const withDraftGeneration = useCallback((path: string): string => {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}draftGeneration=${getDraftGeneration()}`;
  }, [getDraftGeneration]);

  const validateSavedFileChangesBeforeSubmit = useCallback(async (): Promise<SavedFileChangeDraftData[] | null> => {
    if (savedFileChangesForValidation.length === 0) return [];
    const result = await validateSavedFileChanges(savedFileChangesForValidation, resolveSavedFileChangeSource);
    const stale = result.dropped.filter((entry) => entry.reason === 'changed' || entry.reason === 'missing');

    if (stale.length > 0) {
      editableDocuments.clearSavedFileChanges(stale.map((entry) => entry.change.key));
      scheduleDraftSave();
      toast.error('Saved edits changed on disk', {
        description: 'Plannotator removed the stale edit context. Nothing was sent.',
      });
      return null;
    }

    if (result.unverified.length > 0) {
      toast.error('Saved edits could not be verified', {
        description: 'Check the file tree and try sending feedback again.',
      });
      return null;
    }

    return result.valid;
  }, [editableDocuments, resolveSavedFileChangeSource, savedFileChangesForValidation, scheduleDraftSave]);

  const sourceReconcileSeqRef = useRef<Map<string, number>>(new Map());

  const reconcileOpenSourceDocuments = useCallback(async (changedDir?: string) => {
    const activeKey = editableDocuments.getActiveKey();
    if (isEditingMarkdownRef.current && activeKey) {
      const live = markdownEditorHandleRef.current?.getMarkdown();
      if (live != null) editableDocuments.updateActiveText(live, { forceNotify: true });
    }

    const handleReconcileEvent = (event: SourceDocumentReconcileEvent) => {
      const { result } = event;
      if (event.type === 'file-missing') {
        if (!result.alreadyMissing && result.record.key === editableDocuments.getActiveKey()) {
          setEditorDiffersFromBaseline(result.record.currentText !== result.record.diskBaseline);
          if (isEditingMarkdownRef.current) {
            setEditorDirty(result.record.currentText !== editSessionBaseRef.current);
            setEditStats(
              result.record.currentText !== result.record.diskBaseline
                ? computeEditStats(result.record.diskBaseline, result.record.currentText)
                : null,
            );
          }
          toast('File no longer exists on disk', {
            description: `Save ${result.record.basename} to recreate it.`,
            duration: 5000,
          });
        }
        return;
      }

      if (event.type === 'clean-updated') {
        if (result.record.key === editableDocuments.getActiveKey()) {
          const remapped = applyEditedDocument(result.record.currentText);
          repaintHighlights(remapped);
          editSessionBaseRef.current = result.record.currentText;
          setEditorDirty(false);
          setEditorDiffersFromBaseline(false);
          setEditStats(null);
        }
        if (result.clearedSavedChange) {
          toast('File updated from disk', {
            description: `${result.record.basename} changed outside Plannotator, so its old Edits card was cleared.`,
          });
        }
      } else if (event.type === 'conflict') {
        if (result.record.key === editableDocuments.getActiveKey()) {
          setEditorDirty(true);
          setEditorDiffersFromBaseline(true);
          setEditStats(computeEditStats(result.record.diskBaseline, result.record.currentText));
          toast.error('File changed on disk', {
            description: 'Choose whether to overwrite disk or reload the file.',
          });
        }
      }
    };

    const changed = await reconcileSourceDocuments({
      changedDir,
      documents: editableDocuments.getSourceDocuments(),
      sequenceByKey: sourceReconcileSeqRef.current,
      getDocument: editableDocuments.getDocument,
      fetchSnapshot: fetchSourceDocumentSnapshot,
      markFileMissing: editableDocuments.markFileMissing,
      reconcileDiskSnapshot: editableDocuments.reconcileDiskSnapshot,
      onEvent: handleReconcileEvent,
    });
    if (changed) scheduleDraftSave();
  }, [applyEditedDocument, editableDocuments, repaintHighlights, scheduleDraftSave]);
  const reconcileOpenSourceDocumentsRef = useRef(reconcileOpenSourceDocuments);
  useEffect(() => {
    reconcileOpenSourceDocumentsRef.current = reconcileOpenSourceDocuments;
  }, [reconcileOpenSourceDocuments]);

  const sourceWatchDirsKey = useMemo(() => {
    const dirs = new Set<string>();
    for (const doc of openSourceDocuments) dirs.add(dirnameBrowserPath(doc.sourceSave.path));
    return [...dirs].sort().join('\n');
  }, [openSourceDocuments]);

  useEffect(() => {
    if (!sourceWatchDirsKey || typeof EventSource === 'undefined') return;

    const dirs = sourceWatchDirsKey.split('\n').filter(Boolean);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const params = new URLSearchParams();
    for (const dir of dirs) params.append('dirPath', dir);
    const source = new EventSource(`/api/reference/files/stream?${params.toString()}`);

    const schedule = (dir?: string) => {
      const key = dir ?? '*';
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        void reconcileOpenSourceDocumentsRef.current(dir);
      }, 120));
    };

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; dirPath?: string };
        const dir = typeof data.dirPath === 'string' && dirs.includes(data.dirPath) ? data.dirPath : undefined;
        if (data.type === 'ready') {
          schedule(dir);
          return;
        }
        if (data.type !== 'changed') return;
        schedule(dir);
      } catch {
        return;
      }
    };

    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      source.close();
    };
  }, [sourceWatchDirsKey]);

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
      .then((data: { plan: string; origin?: Origin; mode?: 'annotate' | 'annotate-last' | 'annotate-folder' | 'archive' | 'goal-setup'; goalSetup?: GoalSetupBundle; filePath?: string; sourceInfo?: string; sourceConverted?: boolean; sourceSave?: SourceSaveCapability; gate?: boolean; renderAs?: 'html' | 'markdown'; rawHtml?: string; shareHtml?: string; convertHtml?: boolean; sharingEnabled?: boolean; shareBaseUrl?: string; pasteApiUrl?: string; repoInfo?: { display: string; branch?: string; host?: string }; previousPlan?: string | null; versionInfo?: { version: number; totalVersions: number; project: string }; archivePlans?: ArchivedPlan[]; projectRoot?: string; isWSL?: boolean; serverConfig?: { displayName?: string; gitUser?: string }; recentMessages?: PickerMessage[]; agentTerminal?: AgentTerminalCapability }) => {
        // Initialize config store with server-provided values (config file > cookie > default)
        configStore.init(data.serverConfig);
        // Session-level force-markdown preference (--markdown); threaded into folder/linked
        // /api/doc requests so on-demand HTML files convert too.
        setConvertHtml(data.convertHtml ?? false);
        setAISessionEnabled(data.mode !== 'archive' && data.mode !== 'goal-setup');
        // gitUser drives the "Use git name" button in Settings; stays undefined (button hidden) when unavailable
        setGitUser(data.serverConfig?.gitUser);
        if (data.mode === 'goal-setup' && data.goalSetup) {
          setGoalSetupBundle(data.goalSetup);
          setMarkdown('');
          setSharingEnabled(false);
        } else if (data.mode === 'archive') {
          // Archive mode: show first archived plan or clear demo content
          setMarkdown(data.plan || '');
          if (data.archivePlans) archive.init(data.archivePlans);
          archive.fetchPlans();
          setSharingEnabled(false);
          sidebar.open('archive');
        } else if (data.renderAs === 'html' && data.rawHtml) {
          setRenderAs('html');
          setRawHtml(data.rawHtml);
          setShareHtml(data.shareHtml ?? '');
          setMarkdown('');
        } else if (data.mode === 'annotate-folder') {
          // Folder annotation mode: clear demo content, let user pick a file
          setMarkdown('');
        } else if (typeof data.plan === 'string') {
          // CM6 joins lines with \n; CRLF input would make an untouched
          // edit round-trip fabricate a whole-document diff. Normalize once.
          const normalizedPlan = data.plan.replace(/\r\n?/g, '\n');
          setMarkdown(normalizedPlan);
          originalMarkdownRef.current = normalizedPlan;
          if (data.mode === 'annotate' && data.sourceSave?.enabled) {
            const key = editableDocumentKey(data.sourceSave, `file:${data.sourceSave.path}`);
            editableDocuments.openDocument({ key, text: normalizedPlan, sourceSave: data.sourceSave });
          }
        }
        setIsApiMode(true);
        if (data.mode === 'annotate' || data.mode === 'annotate-last' || data.mode === 'annotate-folder') {
          setAnnotateMode(true);
          setGate(data.gate ?? false);
        }
        if (data.mode === 'annotate-folder') {
          sidebar.open('files');
        }
        if (data.mode === 'annotate' || data.mode === 'annotate-last' || data.mode === 'annotate-folder') {
          setAnnotateSource(data.mode === 'annotate-last' ? 'message' : data.mode === 'annotate-folder' ? 'folder' : 'file');
        }
        if (data.mode === 'annotate-last' && data.recentMessages && data.recentMessages.length > 0) {
          messageStateCacheRef.current = new Map();
          setCachedMessageAnnotationCounts(new Map());
          setRecentMessages(data.recentMessages);
          setSelectedMessageId(data.recentMessages[0].messageId);
        } else {
          messageStateCacheRef.current = new Map();
          setCachedMessageAnnotationCounts(new Map());
          setRecentMessages([]);
          setSelectedMessageId(null);
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
        setAgentTerminalCapability(data.agentTerminal ?? null);
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
          if (data.origin === 'claude-code' && data.mode !== 'goal-setup' && needsPermissionModeSetup()) {
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
        setAISessionEnabled(false);
        setAgentTerminalCapability(null);
        // Demo mode still exercises edit mode; baseline is the demo plan.
        originalMarkdownRef.current = DEMO_PLAN_CONTENT;
      })
      .finally(() => setIsLoading(false));
  }, [isLoadingShared, isSharedSession]);

  useEffect(() => {
    if (!aiSessionEnabled || !isApiMode || isSharedSession) {
      setAiAvailable(false);
      setAiProviders([]);
      return;
    }

    let cancelled = false;
    fetch('/api/ai/capabilities')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (cancelled) return;
        if (data?.available) {
          const providers = data.providers ?? [];
          setAiAvailable(true);
          setAiProviders(providers);
          setAIConfig(prev => {
            const saved = getAIProviderSettings();
            const selection = resolveAIProviderSelection({
              providers,
              origin,
              settings: saved,
              serverDefaultProvider: data.defaultProvider ?? null,
            });

            if (prev.providerId === selection.providerId && prev.model === selection.model) return prev;

            return { ...prev, providerId: selection.providerId, model: selection.model };
          });
        } else {
          setAiAvailable(false);
          setAiProviders([]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAiAvailable(false);
          setAiProviders([]);
        }
      });

    return () => { cancelled = true; };
  }, [aiSessionEnabled, isApiMode, isSharedSession, origin]);

  // Auto-save to notes apps on plan arrival (each gated by its autoSave toggle)
  const autoSaveAttempted = useRef(false);
  const autoSaveResultsRef = useRef<NoteAutoSaveResults>({});
  const autoSavePromiseRef = useRef<Promise<NoteAutoSaveResults> | null>(null);

  useEffect(() => {
    autoSaveAttempted.current = false;
    autoSaveResultsRef.current = {};
    autoSavePromiseRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount;
    // markdown changes from edit commits, linked docs, or discard must NOT reset
    // the arrival auto-save (Bear creates a new note each time).
  }, []);

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

  const sendToAgentTerminal = useCallback((message: string) => {
    const sent = agentTerminalRef.current?.sendMessage(message) ?? false;
    if (!sent) return false;
    openAgentTerminal();
    return true;
  }, [openAgentTerminal]);

  const getAnnotateFeedbackTarget = useCallback((): AnnotateFeedbackTarget => {
    if (linkedDocHook.isActive && linkedDocHook.filepath) {
      return { fileHeader: 'File', filePath: linkedDocHook.filepath };
    }
    if (sourceFilePath) {
      return { fileHeader: 'File', filePath: sourceFilePath };
    }
    if (fileBrowser.activeFile) {
      return { fileHeader: 'File', filePath: fileBrowser.activeFile };
    }
    if (annotateSource === 'folder') {
      return { fileHeader: 'Folder', filePath: fileBrowser.activeDirPath ?? projectRoot ?? 'selected folder' };
    }
    return { fileHeader: 'File', filePath: 'current file' };
  }, [
    annotateSource,
    fileBrowser.activeDirPath,
    fileBrowser.activeFile,
    linkedDocHook.filepath,
    linkedDocHook.isActive,
    projectRoot,
    sourceFilePath,
  ]);

  const buildAnnotateAgentFeedback = useCallback((feedback: string) => {
    if (annotateSource === 'message') {
      return annotateMessageFeedback(feedback);
    }

    return annotateFileFeedback(feedback, getAnnotateFeedbackTarget());
  }, [annotateSource, getAnnotateFeedbackTarget]);

  const currentFeedbackPayload = useMemo(() => getCurrentFeedbackPayload(), [
    agentFeedbackRevision,
    editableDocuments.version,
    editorDiffersFromBaseline,
    getCurrentFeedbackPayload,
    savedFileChanges,
  ]);
  const currentAgentFeedbackTarget = useMemo(
    () => getAnnotateFeedbackTarget(),
    [getAnnotateFeedbackTarget],
  );
  const currentAgentFeedbackDelivery = useMemo(() => {
    if (agentTerminalSessionId === null) return null;
    return buildAgentTerminalDeliveryRecord({
      terminalSessionId: agentTerminalSessionId,
      feedback: currentFeedbackPayload,
      targetPath: annotateSource === 'message' ? null : currentAgentFeedbackTarget.filePath,
    });
  }, [
    agentTerminalSessionId,
    annotateSource,
    currentFeedbackPayload,
    currentAgentFeedbackTarget.filePath,
  ]);
  const isCurrentFeedbackDeliveredToAgent = isMatchingAgentTerminalDelivery(
    agentTerminalDelivery,
    currentAgentFeedbackDelivery,
  );
  const showAgentTerminalDeliveryStatus =
    annotateMode &&
    agentTerminalDelivery !== null &&
    isCurrentFeedbackDeliveredToAgent;
  const hasFeedbackToSend =
    hasFeedbackContent &&
    !isCurrentFeedbackDeliveredToAgent;

  // API mode handlers
  const handleApprove = async () => {
    setIsSubmitting(true);
    try {
      // Integrations must describe the same document the feedback diff does —
      // mid-edit submits read the live editor buffer, not stale markdown state.
      const currentMarkdown = isEditingMarkdown
        ? markdownEditorHandleRef.current?.getMarkdown() ?? displayedMarkdown
        : displayedMarkdown;
      const obsidianSettings = getObsidianSettings();
      const bearSettings = getBearSettings();
      const octarineSettings = getOctarineSettings();
      const planSaveSettings = getPlanSaveSettings();
      const autoSaveResults = bearSettings.autoSave && autoSavePromiseRef.current
        ? await autoSavePromiseRef.current
        : autoSaveResultsRef.current;

      // Build request body - include integrations if enabled
      const body: { draftGeneration: number; obsidian?: object; bear?: object; octarine?: object; feedback?: string; agentSwitch?: string; planSave?: { enabled: boolean; customPath?: string }; permissionMode?: string } = {
        draftGeneration: getDraftGeneration(),
      };

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
          plan: currentMarkdown,
          ...(obsidianSettings.filenameFormat && { filenameFormat: obsidianSettings.filenameFormat }),
          ...(obsidianSettings.filenameSeparator && obsidianSettings.filenameSeparator !== 'space' && { filenameSeparator: obsidianSettings.filenameSeparator }),
        };
      }

      // Bear creates a new note each time, so don't send it again on approve
      // if the arrival auto-save already succeeded.
      if (bearSettings.enabled && !(bearSettings.autoSave && autoSaveResults.bear)) {
        body.bear = {
          plan: currentMarkdown,
          customTags: bearSettings.customTags,
          tagPosition: bearSettings.tagPosition,
        };
      }

      if (isOctarineConfigured()) {
        body.octarine = {
          plan: currentMarkdown,
          workspace: octarineSettings.workspace,
          folder: octarineSettings.folder || 'plannotator',
        };
      }

      // Include annotations as feedback if any exist (for OpenCode "approve with notes").
      // Direct edits count as feedback too — without the editsSection check here,
      // an edit-only approval would silently drop the user's changes.
      const hasDocAnnotations = Array.from(linkedDocHook.getDocAnnotations().values()).some(
        (d) => d.annotations.length > 0 || d.globalAttachments.length > 0
      );
      const checkedSavedFileChanges = await validateSavedFileChangesBeforeSubmit();
      if (checkedSavedFileChanges === null) {
        setIsSubmitting(false);
        return;
      }
      const editsSection = buildEditsSection();
      const savedChangesSection = buildSavedChangesSection(checkedSavedFileChanges);
      if (allAnnotations.length > 0 || codeAnnotations.length > 0 || globalAttachments.length > 0 || hasDocAnnotations || editorAnnotations.length > 0 || editsSection || savedChangesSection) {
        body.feedback = getCurrentFeedbackPayload(checkedSavedFileChanges);
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
      const checkedSavedFileChanges = await validateSavedFileChangesBeforeSubmit();
      if (checkedSavedFileChanges === null) {
        setIsSubmitting(false);
        return;
      }
      const planSaveSettings = getPlanSaveSettings();
      await fetch('/api/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draftGeneration: getDraftGeneration(),
          feedback: getCurrentFeedbackPayload(checkedSavedFileChanges),
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

  // Annotate mode handler — sends feedback to the running terminal agent when
  // available, otherwise through the original server feedback channel.
  const handleAnnotateFeedback = async () => {
    setIsSubmitting(true);
    try {
      snapshotActiveEditableDocument();
      const checkedSavedFileChanges = await validateSavedFileChangesBeforeSubmit();
      if (checkedSavedFileChanges === null) {
        setIsSubmitting(false);
        return;
      }
      const feedback = getCurrentFeedbackPayload(checkedSavedFileChanges);
      const agentFeedbackDelivery = agentTerminalSessionId === null
        ? null
        : buildAgentTerminalDeliveryRecord({
            terminalSessionId: agentTerminalSessionId,
            feedback,
            targetPath: annotateSource === 'message' ? null : getAnnotateFeedbackTarget().filePath,
          });
      if (isAgentTerminalReady) {
        if (!shouldSendAgentTerminalFeedback(agentTerminalDeliveryRef.current, agentFeedbackDelivery)) {
          dismissDraft();
          setIsSubmitting(false);
          return;
        }
        const agentFeedback = buildAnnotateAgentFeedback(feedback);
        if (agentFeedbackDelivery && sendToAgentTerminal(agentFeedback)) {
          setAgentTerminalDelivery(agentFeedbackDelivery);
          dismissDraft();
          setIsSubmitting(false);
          return;
        }
        handleAgentTerminalReadyChange(false);
        toast.error('Agent terminal is not ready. Sending through the original session.');
      }

      const scopedSelectedMessageId = messageMultiSelectMode
        ? annotatedMessageIds.length === 1 ? annotatedMessageIds[0] : undefined
        : selectedMessageId ?? undefined;
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draftGeneration: getDraftGeneration(),
          feedback,
          annotations: allAnnotations,
          codeAnnotations,
          ...(scopedSelectedMessageId ? { selectedMessageId: scopedSelectedMessageId } : {}),
          ...(messageMultiSelectMode && annotatedMessageIds.length > 1 ? { feedbackScope: 'messages' } : {}),
        }),
      });
      if (!res.ok) throw new Error('Failed to send feedback');
      dismissDraft();
      setSubmitted('denied'); // reuse 'denied' state for "feedback sent" overlay
    } catch {
      setIsSubmitting(false);
      scheduleDraftSaveAfterSubmitFailure();
    }
  };

  // Annotate gate-mode handler — approves the artifact without feedback
  const handleAnnotateApprove = async () => {
    setIsSubmitting(true);
    try {
      await fetch(withDraftGeneration('/api/approve'), { method: 'POST' });
      setSubmitted('approved');
    } catch {
      setIsSubmitting(false);
    }
  };

  // Exit annotation session without sending feedback
  const handleAnnotateExit = useCallback(async () => {
    setIsExiting(true);
    try {
      const res = await fetch(withDraftGeneration('/api/exit'), { method: 'POST' });
      if (res.ok) {
        setSubmitted('exited');
      } else {
        throw new Error('Failed to exit');
      }
    } catch {
      setIsExiting(false);
    }
  }, [withDraftGeneration]);

  const handleGoalSetupSubmit = useCallback(() => {
    goalSetupSurfaceRef.current?.submit();
  }, []);

  const handleGoalSetupExit = useCallback(async () => {
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

  const confirmUnsavedSourceFileEdits = useCallback((
    action: SourceFileEditWarningAction,
    continueAction: () => void | Promise<void>,
  ) => {
    sourceFileEditWarningContinuationRef.current = continueAction;
    setSourceFileEditWarningAction(action);
    setShowSourceFileEditWarning(true);
  }, []);

  const maybeConfirmUnsavedSourceFileEdits = useCallback((
    action: SourceFileEditWarningAction,
    continueAction: () => void | Promise<void>,
  ): boolean => {
    if (!hasUnsavedSourceFileBuffers) return false;
    confirmUnsavedSourceFileEdits(action, continueAction);
    return true;
  }, [confirmUnsavedSourceFileEdits, hasUnsavedSourceFileBuffers]);

  const closeSourceFileEditWarning = useCallback(() => {
    sourceFileEditWarningContinuationRef.current = null;
    setShowSourceFileEditWarning(false);
  }, []);

  const confirmSourceFileEditWarning = useCallback(() => {
    const continuation = sourceFileEditWarningContinuationRef.current;
    sourceFileEditWarningContinuationRef.current = null;
    setShowSourceFileEditWarning(false);
    void continuation?.();
  }, []);

  // Global keyboard shortcuts (Cmd/Ctrl+Enter to submit)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle Cmd/Ctrl+Enter
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTextField = tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(target?.isContentEditable);

      // Let active confirmation dialogs own Cmd/Ctrl+Enter and Escape.
      if (document.querySelector('[data-plannotator-confirm-dialog="true"]')) return;

      // Don't intercept if any modal is open
      if (showExport || showImport || showFeedbackPrompt || showClaudeCodeWarning ||
          showSourceFileEditWarning ||
          showExitWarning || showAgentWarning || showPermissionModeSetup || pendingPasteImage) return;

      // Don't intercept if already submitted, submitting, or exiting
      if (submitted || isSubmitting || isExiting || goalSetupAction.isSubmitting) return;

      // Don't intercept in demo/share mode (no API)
      if (!isApiMode) return;

      // While the markdown editor is open, submit shortcuts belong to editing,
      // not the review session.
      if (isEditingMarkdown) return;

      // Folder files are the active review target; normal linked docs are side
      // references and should not submit the root plan.
      if (linkedDocHook.isActive && annotateSource !== 'folder') return;

      if (goalSetupMode) {
        if (document.querySelector('[data-comment-popover="true"]')) return;
        if (isTextField && !target?.closest('.goal-shell')) return;
        e.preventDefault();
        if (goalSetupAction.canSubmit) goalSetupSurfaceRef.current?.submit();
        return;
      }

      // Don't intercept if typing in an input/textarea outside goal setup.
      if (isTextField) return;

      e.preventDefault();

      // Annotate mode: gate-enabled + no annotations → approve (empty stdout).
      // Otherwise: send feedback.
      if (annotateMode) {
        if (gate && !hasFeedbackToSend) {
          if (maybeConfirmUnsavedSourceFileEdits('approve', () => handleAnnotateApprove())) return;
          handleAnnotateApprove();
          return;
        }
        if (maybeConfirmUnsavedSourceFileEdits('send-feedback', () => handleAnnotateFeedback())) return;
        handleAnnotateFeedback();
        return;
      }

      // No feedback → Approve, otherwise → Send Feedback
      if (!hasFeedbackToSend) {
        const approve = () => {
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
        };
        if (maybeConfirmUnsavedSourceFileEdits('approve', approve)) return;
        approve();
      } else {
        // Direct edits route through deny too: on Claude Code, deny is the only
        // channel whose output carries feedback to the agent.
        if (maybeConfirmUnsavedSourceFileEdits('send-feedback', () => handleDeny())) return;
        handleDeny();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    showExport, showImport, showFeedbackPrompt, showClaudeCodeWarning, showSourceFileEditWarning, showExitWarning, showAgentWarning,
    showPermissionModeSetup, pendingPasteImage,
    submitted, isSubmitting, isExiting, goalSetupAction.isSubmitting, isApiMode, isEditingMarkdown, linkedDocHook.isActive, annotations.length, codeAnnotations.length, externalAnnotations.length, annotateMode,
    gate, hasFeedbackToSend, goalSetupMode, goalSetupAction.canSubmit, isAgentTerminalReady,
    annotateSource, origin, getAgentWarning,
    maybeConfirmUnsavedSourceFileEdits,
  ]);

  const handleAddAnnotation = (ann: Annotation) => {
    setAnnotations(prev => [...prev, ann]);
    setSelectedAnnotationId(ann.id);
    setSelectedCodeAnnotationId(null);
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
  }, []);

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

  const aiAnnotationsContext = useMemo(
    () => hasAnyAnnotations ? annotationsOutput : undefined,
    [annotationsOutput, hasAnyAnnotations],
  );

  const aiDocumentPath = linkedDocHook.isActive
    ? linkedDocHook.filepath ?? 'linked document'
    : sourceFilePath ?? (annotateSource === 'message' ? 'agent message' : annotateSource === 'folder' ? 'folder document' : 'plan');
  const aiSourceInfo = linkedDocHook.isActive ? linkedDocHook.filepath ?? undefined : sourceInfo;
  const aiSourceConverted = linkedDocHook.isActive
    ? (linkedDocHook.getDocAnnotations().get(linkedDocHook.filepath ?? '')?.isConverted ?? false)
    : sourceConverted;
  // renderAs now tracks the active file (plan, linked doc, or folder file), so the AI
  // sees the current surface's mode — raw HTML for an .html file, markdown otherwise.
  const aiRenderAs = renderAs;
  const aiDocumentMode = annotateMode || linkedDocHook.isActive;
  const hasAIDocumentContext =
    !aiDocumentMode ||
    annotateSource !== 'folder' ||
    linkedDocHook.isActive ||
    !!sourceFilePath;

  const aiContext = useMemo<AIContext | null>(() => {
    if (!aiSessionEnabled || archive.archiveMode || goalSetupMode) return null;
    if (aiDocumentMode && !hasAIDocumentContext) return null;

    if (aiDocumentMode) {
      return {
        mode: 'annotate',
        annotate: {
          content: aiRenderAs === 'html' && rawHtml ? rawHtml : displayedMarkdown,
          filePath: aiDocumentPath,
          sourceInfo: aiSourceInfo,
          sourceConverted: aiSourceConverted,
          renderAs: aiRenderAs,
          annotations: aiAnnotationsContext,
        },
      };
    }

    return {
      mode: 'plan-review',
      plan: {
        plan: markdown,
        previousPlan: previousPlan ?? undefined,
        version: versionInfo?.version,
        totalVersions: versionInfo?.totalVersions,
        project: versionInfo?.project,
        annotations: aiAnnotationsContext,
      },
    };
  }, [
    aiAnnotationsContext,
    aiDocumentPath,
    aiRenderAs,
    aiSessionEnabled,
    aiSourceConverted,
    aiSourceInfo,
    aiDocumentMode,
    hasAIDocumentContext,
    archive.archiveMode,
    displayedMarkdown,
    goalSetupMode,
    markdown,
    previousPlan,
    rawHtml,
    renderAs,
    versionInfo,
  ]);

  const aiChat = useAIChat({
    context: aiContext,
    providerId: aiConfig.providerId,
    model: aiConfig.model,
    reasoningEffort: aiConfig.reasoningEffort,
    threadTitle: aiDocumentMode ? 'Document chat' : 'Plan chat',
  });
  const {
    messages: aiMessages,
    isCreatingSession: aiIsCreatingSession,
    isStreaming: aiIsStreaming,
    permissionRequests: aiPermissionRequests,
    respondToPermission: respondToAIPermission,
    ask: askAI,
    resetSession: resetAISession,
    resetThread: resetAIThread,
    sessionId: aiSessionId,
  } = aiChat;
  const canUseAI = aiAvailable && aiContext !== null;
  const canUseAskAI = canUseAI || isAgentTerminalReady;
  const canUseDocumentAskAI = canUseAskAI;
  const visibleAIMessages = isAgentTerminalReady ? [] : aiMessages;
  const visibleAIProviders = useMemo<AIProviderOption[]>(
    () => isAgentTerminalReady ? [{ id: 'agent-terminal', name: 'Agent terminal' }] : aiProviders,
    [aiProviders, isAgentTerminalReady],
  );
  const visibleAIConfig = isAgentTerminalReady
    ? { providerId: 'agent-terminal', model: null, reasoningEffort: null }
    : aiConfig;

  const terminalAskReadableFilePath = useMemo(() => {
    if (linkedDocHook.isActive && linkedDocHook.filepath) return linkedDocHook.filepath;
    if (sourceFilePath) return sourceFilePath;
    if (fileBrowser.activeFile) return fileBrowser.activeFile;
    return null;
  }, [fileBrowser.activeFile, linkedDocHook.filepath, linkedDocHook.isActive, sourceFilePath]);

  const buildAgentAskPrompt = useCallback((question: string, context?: CommentAskAIContext) => {
    const scope = context ? {
      kind: context.kind,
      label: context.label,
      text: context.text,
      sourcePath: context.sourcePath ?? aiDocumentPath,
    } : undefined;
    const scopedQuestion = buildDefaultPrompt({
      prompt: question,
      scope,
    });
    return buildTerminalAskPrompt({
      scopedQuestion,
      documentPath: aiDocumentPath,
      annotationsContext: aiAnnotationsContext,
      readableFilePath: terminalAskReadableFilePath,
      inlineDocument: terminalAskReadableFilePath
        ? null
        : {
            label: aiRenderAs === 'html' ? 'Current document HTML' : 'Current document text',
            content: aiRenderAs === 'html' && rawHtml ? rawHtml : displayedMarkdown,
          },
    });
  }, [aiAnnotationsContext, aiDocumentPath, aiRenderAs, displayedMarkdown, rawHtml, terminalAskReadableFilePath]);

  const aiDocumentKey = aiContext
    ? `${aiDocumentMode ? 'document' : 'plan'}:${aiRenderAs}:${aiDocumentPath}:${versionInfo?.version ?? 'current'}`
    : 'none';
  const previousAIDocumentKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!aiSessionEnabled) return;
    if (previousAIDocumentKeyRef.current && previousAIDocumentKeyRef.current !== aiDocumentKey) {
      resetAIThread();
    }
    previousAIDocumentKeyRef.current = aiDocumentKey;
  }, [aiDocumentKey, aiSessionEnabled, resetAIThread]);

  const handleAIConfigChange = useCallback((config: { providerId?: string | null; model?: string | null; reasoningEffort?: string | null }) => {
    setAIConfig(prev => {
      const saved = getAIProviderSettings();
      const providerId = config.providerId !== undefined ? config.providerId : prev.providerId;
      const providerChanged = config.providerId !== undefined && config.providerId !== prev.providerId;
      const provider = aiProviders.find(p => p.id === providerId) ?? null;
      const model = providerChanged
        ? (config.model !== undefined ? config.model : resolveAIModelForProvider(provider, saved.preferredModels))
        : (config.model !== undefined ? config.model : prev.model);
      const next = { ...prev, ...config, providerId, model };
      saveAIProviderSelection({
        providerId: next.providerId,
        model: next.model,
        origin,
        settings: saved,
      });
      return next;
    });
    resetAISession();
  }, [aiProviders, origin, resetAISession]);

  const openAIChat = useCallback(() => {
    if (wideModeType !== null) {
      exitWideMode({ restore: false, panelOpen: true });
    }
    setRightSidebarTab('ai');
    setIsPanelOpen(true);
  }, [exitWideMode, wideModeType]);

  const handleOpenAIAnnouncement = useCallback(() => {
    dismissPlanAIAnnouncement();
    openAIChat();
  }, [dismissPlanAIAnnouncement, openAIChat]);

  const handleAskAI = useCallback((question: string, context?: CommentAskAIContext): boolean => {
    if (isAgentTerminalReady) {
      if (sendToAgentTerminal(buildAgentAskPrompt(question, context))) {
        dismissPlanAIAnnouncement();
        return true;
      }
      handleAgentTerminalReadyChange(false);
      if (!canUseAI) {
        toast.error('Agent terminal is not ready');
        return false;
      }
    }

    if (!canUseAI) {
      toast.error('Ask AI is unavailable');
      return false;
    }
    dismissPlanAIAnnouncement();
    openAIChat();
    askAI({
      prompt: question,
      scope: context ? {
        kind: context.kind,
        label: context.label,
        text: context.text,
        sourcePath: context.sourcePath ?? aiDocumentPath,
      } : undefined,
      contextUpdate: aiSessionId ? aiAnnotationsContext : undefined,
    });
    return true;
  }, [
    aiAnnotationsContext,
    aiDocumentPath,
    aiSessionId,
    askAI,
    buildAgentAskPrompt,
    canUseAI,
    dismissPlanAIAnnouncement,
    handleAgentTerminalReadyChange,
    isAgentTerminalReady,
    openAIChat,
    sendToAgentTerminal,
  ]);

  const handleAskGeneralAI = useCallback((question: string) => {
    handleAskAI(question, { kind: 'general', label: aiDocumentMode ? 'Document' : 'Plan', sourcePath: aiDocumentPath });
  }, [aiDocumentMode, aiDocumentPath, handleAskAI]);

  // Bot callback config — read once from URL search params (?cb=&ct=)
  // TODO: bot callbacks post shareUrl which doesn't include code-file annotations.
  // If a user adds code comments and hits the callback button, those comments are silently dropped.
  // Fix: either disable callbacks when codeAnnotations exist, or include annotationsOutput in the payload.
  const callbackConfig = React.useMemo(() => getCallbackConfig(), []);

  const callCallback = React.useCallback(async (action: CallbackAction) => {
    if (!callbackConfig || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const callbackShareUrl = await ensureShareLink();
      if (!callbackShareUrl) {
        toast.error('Failed to create share link');
        return;
      }
      const result = await executeCallback(action, callbackConfig, callbackShareUrl);
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
  }, [callbackConfig, ensureShareLink, isSubmitting]);

  const handleCallbackApprove = React.useCallback(() => callCallback(CallbackAction.Approve), [callCallback]);
  const handleCallbackFeedback = React.useCallback(() => callCallback(CallbackAction.Feedback), [callCallback]);

  // Quick-save handlers for export dropdown and keyboard shortcut
  const handleDownloadAnnotations = () => {
    const output = getCurrentFeedbackPayload();
    const blob = new Blob([output], { type: 'text/plain' });
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
    // Mid-edit saves describe the live buffer, matching handleApprove.
    const quickSaveMarkdown = isEditingMarkdown
      ? markdownEditorHandleRef.current?.getMarkdown() ?? displayedMarkdown
      : displayedMarkdown;

    if (target === 'obsidian') {
      const s = getObsidianSettings();
      const vaultPath = getEffectiveVaultPath(s);
      if (vaultPath) {
        body.obsidian = {
          vaultPath,
          folder: s.folder || 'plannotator',
          plan: quickSaveMarkdown,
          ...(s.filenameFormat && { filenameFormat: s.filenameFormat }),
          ...(s.filenameSeparator && s.filenameSeparator !== 'space' && { filenameSeparator: s.filenameSeparator }),
        };
      }
    }
    if (target === 'bear') {
      const bs = getBearSettings();
      body.bear = {
        plan: quickSaveMarkdown,
        customTags: bs.customTags,
        tagPosition: bs.tagPosition,
      };
    }
    if (target === 'octarine') {
      const os = getOctarineSettings();
      body.octarine = {
        plan: quickSaveMarkdown,
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

  const handleSaveEditedSourceFile = useCallback(async (options?: { overwriteDiskConflict?: boolean }): Promise<boolean> => {
    const activeDocument = editableDocuments.getActiveDocumentLive();
    const activeSourceSave = activeDocument?.sourceSave;
    if (!activeDocument || !activeSourceSave?.enabled) {
      toast.error('This document cannot be saved to a file');
      return true;
    }

    const edited = isEditingMarkdown
      ? markdownEditorHandleRef.current?.getMarkdown()
      : activeDocument.currentText;
    if (edited == null) {
      toast.error('Editor is not ready');
      return true;
    }

    if (activeDocument.diskConflict && !options?.overwriteDiskConflict) {
      toast.error('Resolve the disk conflict first', {
        description: 'Choose Overwrite disk or Reload from disk.',
      });
      return true;
    }

    const saveBaseSource = options?.overwriteDiskConflict && activeDocument.diskConflict
      ? activeDocument.diskConflict.sourceSave
      : activeSourceSave;
    const savedChangeBaseText = options?.overwriteDiskConflict
      ? activeDocument.diskConflict?.text
      : undefined;
    const savedChangeBaseHash = options?.overwriteDiskConflict
      ? activeDocument.diskConflict?.sourceSave.hash
      : undefined;

    editableDocuments.updateActiveText(edited);
    editableDocuments.markSaving(activeDocument.key);
    try {
      const res = await fetch('/api/source/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: saveBaseSource.scope === 'folder-file' ? saveBaseSource.path : undefined,
          text: edited,
          baseHash: saveBaseSource.hash,
          baseMtimeMs: saveBaseSource.mtimeMs,
          baseEol: saveBaseSource.eol,
          allowMissingBase: true,
        }),
      });
      const data = (await res.json()) as SourceSaveResponse;

      if (!res.ok || !data.ok) {
        const message = !data.ok ? data.message : 'Save failed';
        if (!data.ok && data.code === 'conflict') {
          const hasConflictSnapshot = hasSourceSaveConflictSnapshot(data);
          if (hasConflictSnapshot) {
            const conflictSourceSave: EnabledSourceSaveCapability = {
              ...saveBaseSource,
              hash: data.currentHash,
              mtimeMs: data.currentMtimeMs,
              size: data.currentSize,
              eol: data.currentEol,
            };
            const result = editableDocuments.reconcileDiskSnapshot({
              key: activeDocument.key,
              text: data.currentText,
              sourceSave: conflictSourceSave,
            });
            if (result.type === 'conflict' && editableDocuments.getActiveKey() === activeDocument.key) {
              setEditorDirty(true);
              setEditorDiffersFromBaseline(true);
              setEditStats(computeEditStats(result.record.diskBaseline, result.record.currentText));
              scheduleDraftSave();
              toast.error('File changed on disk', {
                description: 'Choose whether to overwrite disk or reload the file.',
              });
            } else if (result.type === 'conflict') {
              scheduleDraftSave();
              toast.error('File changed on disk', {
                description: 'Choose whether to overwrite disk or reload the file.',
              });
            } else if (result.type === 'clean-updated') {
              if (editableDocuments.getActiveKey() === activeDocument.key) {
                const remapped = applyEditedDocument(result.record.currentText);
                repaintHighlights(remapped);
                editSessionBaseRef.current = result.record.currentText;
                setEditorDirty(false);
                setEditorDiffersFromBaseline(false);
                setEditStats(null);
              }
              scheduleDraftSave();
              toast('File updated from disk', {
                description: `${result.record.basename} changed outside Plannotator, so it was reloaded instead of saved.`,
              });
            } else if (!editableDocuments.getDocument(activeDocument.key)?.diskConflict) {
              editableDocuments.markError(activeDocument.key, message);
              toast.error('File changed on disk', {
                description: 'Plannotator could not load the latest disk version. Try saving again.',
              });
            }
          } else {
            editableDocuments.markError(activeDocument.key, message);
            toast.error('File changed on disk', {
              description: 'Plannotator could not load the latest disk version. Try saving again.',
            });
          }
        } else {
          editableDocuments.markError(activeDocument.key, message);
          toast.error(message);
        }
        return true;
      }

      const nextSourceSave = {
        ...saveBaseSource,
        hash: data.hash,
        mtimeMs: data.mtimeMs,
        size: data.size,
        eol: data.eol,
      };
      editableDocuments.markSaved({
        key: activeDocument.key,
        text: edited,
        sourceSave: nextSourceSave,
        savedChangeBaseText,
        savedChangeBaseHash,
      });
      const normalizedEdited = edited.replace(/\r\n?/g, '\n');
      const savedChangedFromOpen = normalizedEdited !== activeDocument.sessionOpenText;
      editedMarkdownRef.current = null;
      if (editableDocuments.getActiveKey() === activeDocument.key) {
        const live = isEditingMarkdown ? markdownEditorHandleRef.current?.getMarkdown() : null;
        const normalizedLive = live?.replace(/\r\n?/g, '\n');
        editSessionBaseRef.current = normalizedEdited;
        const currentText = normalizedLive ?? editableDocuments.getDocument(activeDocument.key)?.currentText ?? normalizedEdited;
        if (currentText === normalizedEdited) {
          setEditorDirty(false);
          setEditorDiffersFromBaseline(false);
          setEditStats(null);
        } else {
          editableDocuments.updateActiveText(currentText, { forceNotify: true });
          setEditorDirty(true);
          setEditorDiffersFromBaseline(true);
          setEditStats(computeEditStats(normalizedEdited, currentText));
        }
      }
      if (savedChangedFromOpen && window.innerWidth >= 768) {
        setRightSidebarTab('annotations');
        setIsPanelOpen(true);
      }
      scheduleDraftSave();
      toast.success(`Saved ${activeSourceSave.basename}`);
      return true;
    } catch {
      editableDocuments.markError(activeDocument.key, 'Save failed');
      toast.error('Save failed');
      return true;
    }
  }, [applyEditedDocument, editableDocuments, isEditingMarkdown, repaintHighlights, scheduleDraftSave]);

  const handleOverwriteDiskConflict = useCallback(() => {
    void handleSaveEditedSourceFile({ overwriteDiskConflict: true });
  }, [handleSaveEditedSourceFile]);

  const handleReloadDiskConflict = useCallback(() => {
    const activeDocument = editableDocuments.getActiveDocumentLive();
    if (!activeDocument?.diskConflict) return;
    const reloaded = editableDocuments.reloadDiskConflict(activeDocument.key);
    if (!reloaded) return;
    const remapped = applyEditedDocument(reloaded.currentText);
    repaintHighlights(remapped);
    editSessionBaseRef.current = reloaded.currentText;
    setEditorDirty(false);
    setEditorDiffersFromBaseline(false);
    setEditStats(null);
    scheduleDraftSave();
    toast.success(`Reloaded ${reloaded.basename} from disk`);
  }, [applyEditedDocument, editableDocuments, repaintHighlights, scheduleDraftSave]);

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
    const url = await ensureShareLink();
    if (!url) {
      setInitialExportTab('share');
      setShowExport(true);
      toast.error('Failed to create share link');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Share link copied');
    } catch {
      toast.error('Failed to copy');
    }
  };

  // Cmd/Ctrl+S keyboard shortcut — while editing, save the active source file;
  // otherwise keep the existing default notes/export behavior.
  useEffect(() => {
    const handleSaveShortcut = (e: KeyboardEvent) => {
      if (e.key !== 's' || !(e.metaKey || e.ctrlKey)) return;

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (showExport || showFeedbackPrompt || showClaudeCodeWarning ||
          showSourceFileEditWarning ||
          showExitWarning || showAgentWarning || showPermissionModeSetup || pendingPasteImage) return;

      if (submitted || !isApiMode) return;

      if (isEditingMarkdown && editableDocuments.getActiveDocumentLive()?.sourceSave?.enabled) {
        e.preventDefault();
        void handleSaveEditedSourceFile();
        return;
      }

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
    showExport, showFeedbackPrompt, showClaudeCodeWarning, showSourceFileEditWarning, showExitWarning, showAgentWarning,
    showPermissionModeSetup, pendingPasteImage,
    submitted, isApiMode, isEditingMarkdown, handleSaveEditedSourceFile, displayedMarkdown, annotationsOutput,
  ]);

  // Cmd/Ctrl+P keyboard shortcut — print plan
  useEffect(() => {
    const handlePrintShortcut = (e: KeyboardEvent) => {
      if (e.key !== 'p' || !(e.metaKey || e.ctrlKey)) return;

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (showExport || showFeedbackPrompt || showClaudeCodeWarning ||
          showSourceFileEditWarning ||
          showExitWarning || showAgentWarning || showPermissionModeSetup || pendingPasteImage) return;

      if (submitted) return;

      e.preventDefault();
      window.print();
    };

    window.addEventListener('keydown', handlePrintShortcut);
    return () => window.removeEventListener('keydown', handlePrintShortcut);
  }, [
    showExport, showFeedbackPrompt, showClaudeCodeWarning, showSourceFileEditWarning, showExitWarning, showAgentWarning,
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
    const close = () => {
      if (hasFeedbackToSend) {
        setExitWarningAction('close');
        setShowExitWarning(true);
      } else {
        headerHandlersRef.current.handleAnnotateExit();
      }
    };
    if (maybeConfirmUnsavedSourceFileEdits('close', close)) return;
    close();
  }, [hasFeedbackToSend, maybeConfirmUnsavedSourceFileEdits]);

  const handleHeaderFeedback = useCallback(() => {
    const sendFeedback = () => {
      const h = headerHandlersRef.current;
      // Direct edits count as feedback — deny is the only Claude Code channel
      // whose output carries feedback to the agent.
      if (!hasFeedbackToSend) {
        setShowFeedbackPrompt(true);
      } else {
        h.handleDeny();
      }
    };
    if (maybeConfirmUnsavedSourceFileEdits('send-feedback', sendFeedback)) return;
    sendFeedback();
  }, [hasFeedbackToSend, maybeConfirmUnsavedSourceFileEdits]);

  const handleHeaderApprove = useCallback(() => {
    const approve = () => {
      const h = headerHandlersRef.current;
      if (annotateMode) {
        if (hasFeedbackToSend) {
          setExitWarningAction('approve');
          setShowExitWarning(true);
          return;
        }
        h.handleAnnotateApprove();
        return;
      }
      if (origin === 'claude-code' && hasFeedbackToSend) {
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
    };
    if (maybeConfirmUnsavedSourceFileEdits('approve', approve)) return;
    approve();
  }, [annotateMode, hasFeedbackToSend, maybeConfirmUnsavedSourceFileEdits, origin]);

  const handleHeaderAnnotateFeedback = useCallback(() => {
    const sendFeedback = () => headerHandlersRef.current.handleAnnotateFeedback();
    if (maybeConfirmUnsavedSourceFileEdits('send-feedback', sendFeedback)) return;
    sendFeedback();
  }, [maybeConfirmUnsavedSourceFileEdits]);

  const handleHeaderAnnotateApprove = useCallback(() => {
    const approve = () => headerHandlersRef.current.handleAnnotateApprove();
    if (maybeConfirmUnsavedSourceFileEdits('approve', approve)) return;
    approve();
  }, [maybeConfirmUnsavedSourceFileEdits]);
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
  const selectedAIProvider = aiProviders.find(provider => provider.id === aiConfig.providerId) ?? null;
  const showAgentTerminalControls =
    annotateMode &&
    annotateSource !== 'message' &&
    agentTerminalCapability !== null &&
    !goalSetupMode;
  const shouldRenderAgentTerminal =
    showAgentTerminalControls &&
    agentTerminalCapability !== null &&
    wideModeType === null &&
    (isAgentTerminalOpen || isAgentTerminalRunning);
  // Only greet in a normal authoring context — not on a read-only shared session
  // (a viewer would also be able to flip the owner's gridEnabled), nor over the
  // goal-setup / permission-mode flows. Deferred (not marked seen) until then.
  const shouldShowLookAndFeelAnnouncement =
    showLookAndFeelAnnouncement &&
    !isSharedSession &&
    !goalSetupMode &&
    !showPermissionModeSetup;
  const shouldShowPlanAIAnnouncement =
    showPlanAIAnnouncement &&
    !shouldShowLookAndFeelAnnouncement &&
    canUseAI &&
    aiSessionEnabled &&
    isApiMode &&
    !isSharedSession &&
    !archive.archiveMode &&
    !goalSetupMode &&
    !showPermissionModeSetup &&
    !submitted;


  if (isLoading && !isSharedSession) {
    return (
      <ThemeProvider defaultTheme="dark">
        <div className="h-screen bg-background" />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider delayDuration={900} skipDelayDuration={200} disableHoverableContent>
      <div data-print-region="root" className="h-screen flex flex-col bg-background overflow-hidden">
        <AppHeader
          htmlSurface={isHtmlSurface}
          htmlToolsHidden={htmlToolsHidden}
          onToggleHtmlTools={() => setHtmlToolsHidden((v) => !v)}
          isApiMode={isApiMode}
          annotateMode={annotateMode}
          archiveMode={archive.archiveMode}
          goalSetupMode={goalSetupMode}
          goalSetupCanSubmit={goalSetupAction.canSubmit}
          goalSetupIsSubmitting={goalSetupAction.isSubmitting}
          goalSetupSubmitLabel={goalSetupAction.submitLabel}
          gate={gate}
          isSharedSession={isSharedSession}
          origin={origin}
          isSubmitting={isSubmitting}
          isExiting={isExiting}
          isPanelOpen={isPanelOpen && rightSidebarTab === 'annotations'}
          aiAvailable={canUseAskAI}
          isAIChatOpen={isPanelOpen && rightSidebarTab === 'ai'}
          aiHasMessages={visibleAIMessages.length > 0}
          hasAnyAnnotations={hasAnyAnnotations || hasDirectEdits || hasSavedFileChanges}
          linkedDocIsActive={linkedDocHook.isActive}
          callbackShareUrlReady={callbackConfig ? Boolean(shareUrl || shortShareUrl || (renderAs === 'html' && (shareHtml || rawHtml))) : true}
          canShareCurrentSession={canShareCurrentSession}
          agentName={agentName}
          availableAgents={availableAgents}
          showAnnotationsWarning={hasFeedbackToSend}
          callbackConfig={callbackConfig}
          taterMode={taterMode}
          mobileSettingsOpen={mobileSettingsOpen}
          gitUser={gitUser}
          onCallbackFeedback={handleCallbackFeedback}
          onCallbackApprove={handleCallbackApprove}
          onAnnotateExit={handleHeaderAnnotateExit}
          onGoalSetupExit={handleGoalSetupExit}
          onGoalSetupSubmit={handleGoalSetupSubmit}
          onAnnotateFeedback={handleHeaderAnnotateFeedback}
          onAnnotateApprove={handleHeaderAnnotateApprove}
          onFeedback={handleHeaderFeedback}
          onApprove={handleHeaderApprove}
          onAnnotationPanelToggle={handleAnnotationPanelToggle}
          onAIChatToggle={handleAIChatToggle}
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
          updateInfo={updateInfo}
          isWSL={isWSL}
          agentInstructionsEnabled={isApiMode && !archive.archiveMode && !annotateMode && !goalSetupMode}
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

        {activeEditableDocument?.diskConflict && (
          <div className="bg-warning/10 border-b border-warning/25 px-4 py-2 flex items-center gap-3 flex-shrink-0">
            <span className="min-w-0 flex-1 text-xs text-warning-foreground">
              {activeEditableDocument.basename} changed on disk{isEditingMarkdown ? ' while you were editing' : ''}.
            </span>
            {canOverwriteDiskConflict && (
              <button
                type="button"
                onClick={handleOverwriteDiskConflict}
                className="text-xs font-medium text-primary hover:text-primary/80"
              >
                Overwrite disk
              </button>
            )}
            <button
              type="button"
              onClick={handleReloadDiskConflict}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Reload from disk
            </button>
          </div>
        )}

        {activeEditableDocument?.missingOnDisk && !activeEditableDocument.diskConflict && (
          <div className="bg-warning/10 border-b border-warning/25 px-4 py-2 flex items-center gap-3 flex-shrink-0">
            <span className="min-w-0 flex-1 text-xs text-warning-foreground">
              {activeEditableDocument.basename} no longer exists on disk. Save to recreate it.
            </span>
            <button
              type="button"
              onClick={() => { void handleSaveEditedSourceFile(); }}
              disabled={activeSaveStatus === 'saving'}
              className="text-xs font-medium text-primary hover:text-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save
            </button>
          </div>
        )}
        {showAgentTerminalDeliveryStatus && (
          <div className="border-b border-primary/20 bg-primary/5 px-4 py-2 text-xs text-muted-foreground flex-shrink-0">
            <span className="font-medium text-foreground">Sent to agent.</span>{" "}
            Keep this window open while it runs. Close Plannotator when you're done.
          </div>
        )}

        {/* Main Content */}
        <ScrollViewportContext.Provider value={scrollViewport}>
        <div data-print-region="content" className={`flex-1 flex overflow-hidden relative z-0 ${isResizing ? 'select-none' : ''}`}>
          {/* Tater sprites — inside content wrapper so z-0 stacking context applies */}
          {taterMode && <TaterSpriteRunning />}
          {shouldRenderAgentTerminal && agentTerminalCapability && (
            <div
              className={
                isAgentTerminalOpen
                  ? "contents group/agent-terminal"
                  : "absolute left-0 top-0 h-full w-0 overflow-hidden pointer-events-none group/agent-terminal"
              }
              aria-hidden={!isAgentTerminalOpen}
              inert={!isAgentTerminalOpen ? true : undefined}
            >
              <AnnotateAgentTerminalPanel
                ref={agentTerminalRef}
                capability={agentTerminalCapability}
                width={`var(--agent-terminal-w, ${agentTerminalResize.width}px)`}
                onSessionActiveChange={setIsAgentTerminalRunning}
                onSessionReadyChange={handleAgentTerminalReadyChange}
                onClose={hideAgentTerminal}
              />
              {isAgentTerminalOpen && (
                <ResizeHandle
                  {...agentTerminalResize.handleProps}
                  className="hidden lg:block z-[55]"
                  side="left"
                  onCollapse={hideAgentTerminal}
                />
              )}
            </div>
          )}
          {/* Left Sidebar: collapsed tab flags (when sidebar is closed) */}
          {wideModeType === null && !sidebar.isOpen && !goalSetupMode && !isAgentTerminalOpen && (
            <SidebarTabs
              activeTab={sidebar.activeTab}
              onToggleTab={toggleSidebarTab}
              hasDiff={planDiff.hasPreviousVersion}
              showVersionsTab={versionInfo !== null && versionInfo.totalVersions > 1}
              showFilesTab={showFilesTab && !archive.archiveMode}
              showMessagesTab={annotateSource === 'message' && recentMessages.length > 1}
              showAgentTerminalTab={showAgentTerminalControls}
              isAgentTerminalOpen={isAgentTerminalOpen}
              isAgentTerminalRunning={isAgentTerminalRunning}
              onToggleAgentTerminal={toggleAgentTerminal}
              hasMessageAnnotations={activeMessageAnnotationCounts.size > 0}
              hasFileAnnotations={hasFileAnnotations}
              className="hidden lg:flex absolute left-0 top-0 z-20"
            />
          )}

          {/* Left Sidebar: open state (TOC or Version Browser) */}
          {sidebar.isOpen && !goalSetupMode && (
            <div className="contents group/sidebar">
              <SidebarContainer
                activeTab={sidebar.activeTab}
                onTabChange={(tab) => {
                  toggleSidebarTab(tab);
                  if (tab === 'archive' && !archive.archiveMode) archive.fetchPlans();
                }}
                onClose={sidebar.close}
                width={`var(--toc-w, ${tocResize.width}px)`}
                showAgentTerminalButton={showAgentTerminalControls}
                isAgentTerminalOpen={isAgentTerminalOpen}
                isAgentTerminalRunning={isAgentTerminalRunning}
                onToggleAgentTerminal={toggleAgentTerminal}
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
                fileEditStatuses={editableDocuments.fileEditStatuses}
                fileBrowser={fileBrowser}
                onFilesSelectFile={(...args: Parameters<typeof handleFileBrowserSelect>) => {
                  // Plan/review linked-doc browsing still swaps the root document
                  // under the editor. Folder mode snapshots the active file first.
                  if (isEditingMarkdown && annotateSource !== 'folder') {
                    toast('Finish editing first', { description: 'Use "Done editing" before opening files.' });
                    return;
                  }
                  if (isEditingMarkdown && !/\.(mdx?|txt)$/i.test(args[0])) {
                    toast('Finish editing first', { description: 'Use "Done editing" before opening non-editable files.' });
                    return;
                  }
                  handleFileBrowserSelect(...args);
                }}
                onFilesFetchAll={() => fileBrowser.fetchAll(fileBrowserDirs)}
                onFilesRetryVaultDir={(vaultPath) => fileBrowser.addVaultDir(vaultPath)}
                hasFileAnnotations={hasFileAnnotations}
                showVersionsTab={versionInfo !== null && versionInfo.totalVersions > 1}
                versionInfo={versionInfo}
                versions={planDiff.versions}
                selectedBaseVersion={planDiff.diffBaseVersion}
                onSelectBaseVersion={handleSelectBaseVersion}
                isPlanDiffActive={isPlanDiffActive}
                hasPreviousVersion={planDiff.hasPreviousVersion}
                onActivatePlanDiff={handleActivatePlanDiff}
                isLoadingVersions={planDiff.isLoadingVersions}
                isSelectingVersion={planDiff.isSelectingVersion}
                fetchingVersion={planDiff.fetchingVersion}
                onFetchVersions={planDiff.fetchVersions}
                showArchiveTab={isApiMode && !annotateMode && !goalSetupMode}
                archivePlans={archive.plans}
                selectedArchiveFile={archive.selectedFile}
                onArchiveSelect={(...args: Parameters<typeof archive.select>) => {
                  // Archive selection swaps the markdown state under the open
                  // editor — block it rather than corrupt the edit session.
                  if (isEditingMarkdown) {
                    toast('Finish editing first', { description: 'Use "Done editing" before browsing archived plans.' });
                    return;
                  }
                  archive.select(...args);
                }}
                isLoadingArchive={archive.isLoading}
                showMessagesTab={annotateSource === 'message' && recentMessages.length > 1}
                messages={recentMessages}
                selectedMessageId={selectedMessageId}
                onSelectMessage={handleSelectMessage}
                messageAnnotationCounts={activeMessageAnnotationCounts}
              />
              <ResizeHandle {...tocResize.handleProps} className="hidden lg:block z-[55]" side="left" onCollapse={sidebar.close} />
            </div>
          )}

          {/* Document Area */}
          <OverlayScrollArea
            element="main"
            className={`flex-1 min-w-0 ${isHtmlSurface ? 'bg-background' : `${gridEnabled ? "bg-grid " : "bg-card "}${!goalSetupMode && !sidebar.isOpen && !isAgentTerminalOpen && wideModeType === null ? 'lg:pl-[30px]' : ''}`}`}
            data-print-region="document"
            onViewportReady={handleViewportReady}
          >
            <ConfirmDialog
              isOpen={!!draftBanner}
              onClose={dismissDraft}
              onConfirm={handleRestoreDraft}
              title="Draft Recovered"
              message={draftBanner ? draftBannerMessage(draftBanner) : ''}
              confirmText="Restore"
              cancelText="Dismiss"
              showCancel
            />
            <div ref={planAreaRef} className={`${isHtmlSurface ? 'h-full flex flex-col' : 'min-h-full flex flex-col items-center px-2 py-3 md:px-10 md:py-8 xl:px-16'} relative z-10`}>
              {/* Sticky header lane — ghost bar that pins the toolstrip +
                  badges at top: 12px once the user scrolls. Invisible at top
                  of doc; original toolstrip/badges remain the source of
                  truth there. Hidden in plan diff or archive mode, or when
                  sticky actions are disabled. remountToken re-anchors the
                  ResizeObserver when Viewer swaps content (linked docs or
                  message switches). */}
              {!goalSetupMode && !isPlanDiffActive && !isHtmlSurface && !archive.archiveMode && !isEditingMarkdown && uiPrefs.stickyActionsEnabled && (
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
                  remountToken={viewerContentKey}
                />
              )}

              {/* Annotation Toolstrip — the mode switcher (selection/redline input +
                  comment/markup mode). Hidden during plan diff, and on HTML surfaces
                  when the header's "Hide tools" toggle is on (leaving the rendered HTML
                  free of overlay controls). On HTML it floats top-left over the doc. */}
              {!goalSetupMode && !isPlanDiffActive && !archive.archiveMode && !isEditingMarkdown && !(isHtmlSurface && htmlToolsHidden) && (
                <div
                  data-print-hide
                  className={isHtmlSurface
                    ? `absolute top-3 ${sidebar.isOpen ? 'left-3' : 'left-10'} z-20 flex items-center rounded-lg border border-border/50 bg-background/85 px-1.5 py-1 shadow-md backdrop-blur-sm`
                    : "w-full mb-3 md:mb-4 flex items-center justify-start"}
                  style={isHtmlSurface || annotateReaderMaxWidth == null ? undefined : { maxWidth: annotateReaderMaxWidth }}
                >
                  <AnnotationToolstrip
                    inputMethod={inputMethod}
                    onInputMethodChange={handleInputMethodChange}
                    mode={editorMode}
                    onModeChange={handleEditorModeChange}
                    taterMode={taterMode}
                    showHelpLink={!isHtmlSurface}
                  />
                </div>
              )}

              {/* Plan Diff View — rendered when diff data exists, hidden when inactive */}
              {goalSetupBundle && (
                <div className="w-full flex justify-center">
                  <GoalSetupSurface
                    ref={goalSetupSurfaceRef}
                    bundle={goalSetupBundle}
                    maxWidth={planMaxWidth}
                    onActionStateChange={setGoalSetupAction}
                    onSubmitted={() => setSubmitted('approved')}
                  />
                </div>
              )}

              {planDiff.diffBlocks && planDiff.diffStats && !goalSetupMode && (
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
              {annotateSource === 'folder' && !markdown && !linkedDocHook.isActive && !goalSetupMode && (
                <div className="w-full flex justify-center">
                  <div className="w-full max-w-3xl p-12 text-center text-muted-foreground">
                    <p className="text-lg font-medium mb-2">Select a file to annotate</p>
                    <p className="text-sm">Pick a markdown or HTML file from the sidebar to begin.</p>
                  </div>
                </div>
              )}
              {/* Normal Plan View — always mounted, hidden during diff mode */}
              <div className={`w-full relative ${isHtmlSurface ? 'flex-1 flex flex-col' : `flex justify-center${isEditingMarkdown ? ' flex-1 min-h-0' : ''}`}`} style={{ display: goalSetupMode || (isPlanDiffActive && planDiff.diffBlocks) || (annotateSource === 'folder' && !markdown && !linkedDocHook.isActive) ? 'none' : undefined }}>
                {(canUseWideMode || canEditMarkdown) && !isPlanDiffActive && !archive.archiveMode && !isHtmlSurface && (
                  <div
                    data-print-hide
                    className="absolute -top-5 left-0 right-0 mx-auto w-full flex justify-end pointer-events-none"
                    style={annotateReaderMaxWidth === null ? undefined : { maxWidth: annotateReaderMaxWidth ?? 832 }}
                  >
                    <div className={`pointer-events-auto flex items-center gap-1.5 text-[11px] tracking-wide ${taterMode ? 'mr-[60px]' : 'mr-[4px]'}`}>
                      {canUseWideMode && (['wide', 'focus'] as const).map((type, i) => (
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
                      {canEditMarkdown && (
                        <>
                          {canUseWideMode && <span aria-hidden className="text-muted-foreground/30 select-none">|</span>}
                          {isEditingMarkdown && activeSourceSave && (
                            <>
                              <Tooltip
                                side="top"
                                align="end"
                                content={`Save changes to ${activeSourceSave.basename}`}
                              >
                                <button
                                  type="button"
                                  onClick={() => { void handleSaveEditedSourceFile(); }}
                                  disabled={activeSaveStatus === 'saving'}
                                  className={`flex items-center gap-1 cursor-pointer rounded-sm transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 ${
                                    saveFailed
                                      ? 'text-destructive'
                                      : emphasizeSave
                                        ? 'text-primary'
                                        : 'text-muted-foreground/50 hover:text-muted-foreground'
                                  }`}
                                >
                                  {/* Invisible widest label reserves the width so Save/Saving/Saved
                                      swap without nudging neighbors (font-agnostic, no fixed px). */}
                                  <span className="grid justify-items-start">
                                    <span aria-hidden className="invisible col-start-1 row-start-1">Saving</span>
                                    <span className="col-start-1 row-start-1">
                                      {activeSaveStatus === 'saving'
                                        ? 'Saving'
                                        : hasUnsavedDiskChanges
                                          ? 'Save'
                                          : 'Saved'}
                                    </span>
                                  </span>
                                  {/* Dot slot is always present — only its color changes — so the
                                      button never reflows when edits appear/clear. */}
                                  <span
                                    aria-hidden
                                    className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-150 ${
                                      saveFailed ? 'bg-destructive' : emphasizeSave ? 'bg-primary' : 'bg-transparent'
                                    }`}
                                  />
                                </button>
                              </Tooltip>
                              <span aria-hidden className="text-muted-foreground/30 select-none">|</span>
                            </>
                          )}
                          <Tooltip
                            side="top"
                            align="end"
                            content={
                              !isEditingMarkdown
                                ? 'Edit the document text directly'
                                : cancelMode
                                  ? 'Discard your edits and stop editing'
                                  : 'Commit your edits and return to annotating'
                            }
                          >
                            <button
                              type="button"
                              onClick={handleEditExitClick}
                              aria-pressed={isEditingMarkdown}
                              className={`cursor-pointer rounded-sm transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:opacity-80 ${
                                cancelMode
                                  ? (confirmCancelEdits
                                      ? 'text-destructive'
                                      : 'text-muted-foreground/70 hover:text-foreground')
                                  : isEditingMarkdown
                                    ? 'text-primary'
                                    : 'text-muted-foreground/50 hover:text-muted-foreground'
                              }`}
                            >
                              {!isEditingMarkdown
                                ? 'Edit'
                                : cancelMode
                                  ? (confirmCancelEdits ? 'Discard?' : 'Cancel')
                                  : 'Done'}
                            </button>
                          </Tooltip>
                        </>
                      )}
                    </div>
                  </div>
                )}
                {renderAs === 'html' ? (
                  <HtmlViewer
                    key={linkedDocHook.isActive ? `doc:${linkedDocHook.filepath}` : 'plan'}
                    ref={viewerRef}
                    rawHtml={rawHtml}
                    annotations={viewerAnnotations}
                    onAddAnnotation={handleAddAnnotation}
                    onSelectAnnotation={handleSelectAnnotation}
                    selectedAnnotationId={selectedAnnotationId}
                    mode={editorMode}
                    inputMethod={inputMethod}
                    globalAttachments={globalAttachments}
                    onAddGlobalAttachment={handleAddGlobalAttachment}
                    onRemoveGlobalAttachment={handleRemoveGlobalAttachment}
                    maxWidth={isHtmlSurface ? null : annotateReaderMaxWidth}
                    fullViewport={isHtmlSurface}
                    hideControls={htmlToolsHidden}
                    onAskAI={canUseDocumentAskAI ? handleAskAI : undefined}
                  />
                ) : isEditingMarkdown ? (
                  <MarkdownEditor
                    markdown={displayedMarkdown}
                    documentId={`edit:${activeEditableDocument?.key ?? 'root'}:${editGeneration}`}
                    editorHandleRef={markdownEditorHandleRef}
                    onMarkdownChange={handleEditorChange}
                    maxWidth={annotateReaderMaxWidth}
                    gridEnabled={gridEnabled}
                  />
                ) : (
                  <Viewer
                    key={viewerContentKey}
                    ref={viewerRef}
                    blocks={blocks}
                    markdown={displayedMarkdown}
                    frontmatter={frontmatter}
                    annotations={viewerAnnotations}
                    onAddAnnotation={handleAddAnnotation}
                    onSelectAnnotation={handleSelectAnnotation}
                    selectedAnnotationId={selectedAnnotationId}
                    mode={editorMode}
                    inputMethod={inputMethod}
                    taterMode={taterMode}
                    gridEnabled={gridEnabled}
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
                    linkedDocInfo={
                      linkedDocHook.isActive
                        ? {
                            filepath: linkedDocHook.filepath!,
                            onBack: handleLinkedDocBack,
                            label: annotateSource === 'folder'
                              ? undefined
                              : fileBrowser.dirs.find(d => d.path === fileBrowser.activeDirPath)?.isVault
                                ? 'Vault File'
                                : fileBrowser.activeFile ? 'File' : undefined,
                            backLabel,
                            variant: annotateSource === 'folder' ? 'folder-file' : 'breadcrumb',
                          }
                        : null
                    }
                    imageBaseDir={imageBaseDir}
                    codePathBaseDir={activeDocBaseDir}
                    copyLabel={annotateSource === 'message' ? 'Copy message' : annotateSource === 'file' || annotateSource === 'folder' ? 'Copy file' : undefined}
                    archiveInfo={archive.currentInfo}
                    sourceInfo={sourceInfo}
                    openInAppPath={annotateMode ? (linkedDocHook.isActive ? (linkedDocHook.filepath ?? null) : sourceFilePath) : null}
                    messagePickerInfo={
                      annotateSource === 'message' && recentMessages.length > 1
                        ? {
                            // selectedMessageId is always one of recentMessages (set on init,
                            // only changed via handleSelectMessage), so findIndex is >= 0.
                            current: recentMessages.findIndex((m) => m.messageId === selectedMessageId) + 1,
                            total: recentMessages.length,
                            onOpen: () => sidebar.open('messages'),
                          }
                        : undefined
                    }
                    onToggleCheckbox={checkbox.toggle}
                    checkboxOverrides={checkbox.overrides}
                    actionsLabelMode={actionsLabelMode}
                    onAskAI={canUseDocumentAskAI ? handleAskAI : undefined}
                  />
                )}
              </div>
            </div>
          </OverlayScrollArea>

          {/* Right panel region — `group/sidebar` so the collapse button reveals when
              hovering the whole panel, not just the thin handle. The handle and the
              panel(s) are separate sibling conditionals, so they need a shared hover
              ancestor (`contents` = no layout box). */}
          <div className="contents group/sidebar">
          {/* Resize Handle */}
          {isPanelOpen && wideModeType === null && !goalSetupMode && (rightSidebarTab === 'annotations' || canUseAskAI) && <ResizeHandle {...panelResize.handleProps} className="hidden md:block z-[55]" side="right" onCollapse={() => setIsPanelOpen(false)} />}

          {/* Annotation Panel */}
          <AnnotationPanel
            isOpen={isPanelOpen && rightSidebarTab === 'annotations' && wideModeType === null && !goalSetupMode}
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
            width={`var(--rpanel-w, ${panelResize.width}px)`}
            editorAnnotations={editorAnnotations}
            onDeleteEditorAnnotation={deleteEditorAnnotation}
            onClose={() => setIsPanelOpen(false)}
            onQuickCopy={async () => {
              const output = getCurrentFeedbackPayload();
              await navigator.clipboard.writeText(wrapFeedbackForAgent(output));
            }}
            onShare={canShareCurrentSession ? () => { setIsPanelOpen(false); setInitialExportTab('share'); setShowExport(true); } : undefined}
            otherFileAnnotations={otherFileAnnotations}
            directEdits={directEditsPanelInfo?.map((item) => ({
              ...item,
              onDiscard: item.id === 'plan' ? () => handleDiscardEdits() : undefined,
            })) ?? null}
            onOtherFileAnnotationsClick={handleFlashAnnotatedFiles}
          />
          {isPanelOpen && rightSidebarTab === 'ai' && wideModeType === null && !goalSetupMode && canUseAskAI && (
            <aside
              data-annotation-panel="true"
              className={`border-l border-border/50 bg-card flex flex-col flex-shrink-0 ${
                isMobile ? 'fixed top-12 bottom-0 right-0 z-[60] w-full max-w-sm shadow-2xl bg-card' : ''
              }`}
              style={isMobile ? undefined : { width: `var(--rpanel-w, ${panelResize.width ?? 288}px)` }}
            >
              <div className="border-b border-border/50">
                <div className="flex h-10 items-center justify-between px-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <SparklesIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <h2 className="text-xs font-medium text-foreground">
                      AI
                    </h2>
                    {visibleAIMessages.length > 0 && (
                      <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[10px] font-medium tabular-nums text-primary">
                        {visibleAIMessages.length}
                      </span>
                    )}
                  </div>
                  {isMobile && (
                    <button
                      onClick={() => setIsPanelOpen(false)}
                      className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground md:hidden"
                      title="Close panel"
                      aria-label="Close AI panel"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <DocumentAIChatPanel
                messages={visibleAIMessages}
                isCreatingSession={isAgentTerminalReady ? false : aiIsCreatingSession}
                isStreaming={isAgentTerminalReady ? false : aiIsStreaming}
                onAskGeneral={handleAskGeneralAI}
                permissionRequests={isAgentTerminalReady ? [] : aiPermissionRequests}
                onRespondToPermission={isAgentTerminalReady ? undefined : respondToAIPermission}
                aiProviders={visibleAIProviders}
                aiConfig={visibleAIConfig}
                onAIConfigChange={isAgentTerminalReady ? undefined : handleAIConfigChange}
              />
            </aside>
          )}
          </div>
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
          annotationsOutput={
            // Computed only while the modal is open: composeFeedback runs a
            // unified diff when edits exist — not per-render work.
            showExport
              ? getCurrentFeedbackPayload()
              : ''
          }
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
          title="Add Feedback First"
          message={
            canEditMarkdown
              ? `To provide feedback, add annotations or direct edits. ${agentName} will use your feedback to revise the ${annotateMode ? 'document' : 'plan'}.`
              : `To provide feedback, select text and add annotations. ${agentName} will use your annotations to revise the ${annotateMode ? 'document' : 'plan'}.`
          }
          variant="info"
        />

        {/* Unsaved source-file edit warning dialog */}
        <ConfirmDialog
          isOpen={showSourceFileEditWarning}
          onClose={closeSourceFileEditWarning}
          onConfirm={confirmSourceFileEditWarning}
          title={sourceFileEditWarningAction === 'close' ? 'Unsaved File Edits' : "File Edits Won't Be Sent"}
          message={
            sourceFileEditWarningAction === 'close'
              ? <>You have unsaved file edits. They are not saved to disk and will be lost if you close this session.</>
              : <>You have unsaved file edits. They are not saved to disk, and {agentName} won't get them if you {sourceFileEditWarningAction === 'approve' ? 'approve' : 'send feedback'}.</>
          }
          subMessage="Save or discard the file edits first if you want Plannotator to keep them."
          confirmText={
            sourceFileEditWarningAction === 'approve'
              ? 'Approve Anyway'
              : sourceFileEditWarningAction === 'close'
                ? 'Close Anyway'
                : 'Send Anyway'
          }
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* Claude Code feedback warning dialog */}
        <ConfirmDialog
          isOpen={showClaudeCodeWarning}
          onClose={() => setShowClaudeCodeWarning(false)}
          onConfirm={() => {
            setShowClaudeCodeWarning(false);
            handleApprove();
          }}
          title="Feedback Won't Be Sent"
          message={
            hasOnlySavedFileChanges
              ? <>{agentName} doesn't yet support feedback on approval. {savedFileAwarenessOnlyMessage}</>
              : <>{agentName} doesn't yet support feedback on approval. Your {feedbackLoss} will be lost.{savedFileAwarenessMixedMessage}</>
          }
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

        {/* Unsent feedback warning dialog — reused by Close and (in gate mode) Approve */}
        <ConfirmDialog
          isOpen={showExitWarning}
          onClose={() => setShowExitWarning(false)}
          onConfirm={() => {
            setShowExitWarning(false);
            if (exitWarningAction === 'approve') handleAnnotateApprove();
            else handleAnnotateExit();
          }}
          title="Feedback Won't Be Sent"
          message={
            hasOnlySavedFileChanges
              ? <>{savedFileChangesOnDiskMessage} The agent will not get that context if you {exitWarningAction === 'approve' ? 'approve' : 'close'}.</>
              : <>You have {feedbackLoss} that will be lost if you {exitWarningAction === 'approve' ? 'approve' : 'close'}.{savedFileAwarenessMixedMessage}</>
          }
          subMessage={hasOnlySavedFileChanges ? 'To tell the agent what changed, use Send Feedback instead.' : 'To send this feedback, use Send Feedback instead.'}
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
            : goalSetupMode ? 'Answers Submitted'
            : submitted === 'approved'
              ? (annotateMode ? 'Approved' : 'Plan Approved')
              : annotateMode ? 'Feedback Sent'
            : 'Feedback Sent'
          }
          subtitle={
            submitted === 'exited'
              ? 'Annotation session closed without feedback.'
              : archive.archiveMode
                ? 'You can reopen with plannotator archive.'
                : goalSetupMode
                  ? `${agentName} will use your answers to continue.`
                : submitted === 'approved'
                  ? (annotateMode
                      ? `${agentName} will proceed.`
                      : `${agentName} will proceed with the implementation.`)
                  : annotateMode
                    ? `${agentName} will address your feedback on the ${annotateSource === 'message' ? 'message' : annotateSource === 'folder' ? 'files' : 'file'}.`
                    : `${agentName} will revise the plan based on your feedback.`
          }
          agentLabel={agentName}
        />

        <PlanAIAnnouncementDialog
          isOpen={shouldShowPlanAIAnnouncement}
          origin={origin}
          providerName={selectedAIProvider?.name ?? null}
          onOpenAI={handleOpenAIAnnouncement}
          onDismiss={dismissPlanAIAnnouncement}
        />

        <LookAndFeelAnnouncementDialog
          isOpen={shouldShowLookAndFeelAnnouncement}
          gridEnabled={gridEnabled}
          onToggleGrid={(v) => configStore.set('gridEnabled', v)}
          onDismiss={dismissLookAndFeelAnnouncement}
        />

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
