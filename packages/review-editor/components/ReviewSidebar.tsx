import React, { useRef, useState } from 'react';
import { CodeAnnotation, type CodeAnnotationScope, type EditorAnnotation, type Annotation, type CommentAnnotation } from '@plannotator/ui/types';
import { Button } from '@plannotator/ui/components/ui/button';
import { DecisionNoteField } from '@plannotator/ui/components/DecisionControl';
import { useDismissablePopover } from '@plannotator/ui/hooks/useDismissablePopover';
import { submitHint } from '@plannotator/ui/utils/platform';
import { CommentMeta } from './CommentMeta';
import { EditorAnnotationCard } from '@plannotator/ui/components/EditorAnnotationCard';
import { CommentActions } from './CommentActions';
import { commentCopyText } from '../utils/annotationDisplay';
import { HighlightedCode } from './HighlightedCode';
import { detectLanguage } from '../utils/detectLanguage';
import { renderInlineMarkdown } from '../utils/renderInlineMarkdown';
import { FileNameChip } from './FileNameChip';
import { AITab } from './AITab';
import { AgentsTab, type AgentLaunchParams, type AgentLaunchResult } from '@plannotator/ui/components/AgentsTab';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import type { AIChatEntry, PendingPermission } from '../hooks/useAIChat';
import type { AgentJobInfo, AgentCapabilities } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import type { AIProviderOption } from '@plannotator/ui/utils/aiProvider';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { artifactAnchorLabel, artifactAnnotationQuote } from '../utils/artifactAnnotations';

export type ReviewSidebarTab = 'annotations' | 'ai' | 'agents';


interface ReviewSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  presentation?: 'panel' | 'overlay';
  activeTab: ReviewSidebarTab;
  annotations: CodeAnnotation[];
  files: DiffFile[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  /** Sidebar row click → select AND scroll the diff to the comment. */
  onNavigateToAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
  /** "+ General comment": commit a durable scope:'general' review-level
   *  comment to the session (spec §3.3). When present, the affordance renders
   *  in the General section header AND in the all-empty state — the state it
   *  is most useful in. */
  onAddGeneralComment?: (text: string) => void;
  feedbackMarkdown?: string;
  width?: number;
  editorAnnotations?: EditorAnnotation[];
  onDeleteEditorAnnotation?: (id: string) => void;
  // PR description prose annotations (comment-only) — shown in their own group.
  descriptionAnnotations?: Annotation[];
  selectedDescriptionAnnotationId?: string | null;
  onSelectDescriptionAnnotation?: (id: string | null) => void;
  onDeleteDescriptionAnnotation?: (id: string) => void;
  // PR comment annotations (notes on a whole comment) — own group.
  commentAnnotations?: CommentAnnotation[];
  selectedCommentAnnotationId?: string | null;
  onSelectCommentAnnotation?: (id: string | null) => void;
  onDeleteCommentAnnotation?: (id: string) => void;
  prMetadata?: PRMetadata | null;
  // AI props
  aiAvailable?: boolean;
  aiMessages?: AIChatEntry[];
  isAICreatingSession?: boolean;
  isAIStreaming?: boolean;
  onAIStop?: () => void;
  onScrollToAILines?: (filePath: string, lineStart: number, lineEnd: number, side: 'old' | 'new') => void;
  activeFilePath?: string;
  scrollToQuestionId?: string | null;
  onAskGeneral?: (question: string) => void;
  aiPermissionRequests?: PendingPermission[];
  onRespondToPermission?: (requestId: string, allow: boolean) => void;
  aiProviders?: AIProviderOption[];
  aiConfig?: { providerId: string | null; model: string | null; reasoningEffort?: string | null };
  onAIConfigChange?: (config: { providerId?: string | null; model?: string | null; reasoningEffort?: string | null }) => void;
  hasAISession?: boolean;
  // Agent props
  agentJobs?: AgentJobInfo[];
  agentCapabilities?: AgentCapabilities | null;
  onAgentLaunch?: (params: AgentLaunchParams) => AgentLaunchResult | Promise<AgentLaunchResult>;
  onAgentKillJob?: (id: string) => void;
  onAgentKillAll?: () => void;
  externalAnnotations?: Array<{ source?: string }>;
  onOpenJobDetail?: (jobId: string) => void;
  onOpenGuide?: (jobId: string) => void;
  /** Pass-through to AgentsTab — gates the sidebar's Guided Review mode on
   *  file availability, mirroring the header's hasSearchableFiles gate on
   *  the "Guide" badge/shortcut (see App.tsx). */
  guideLaunchable?: boolean;
  /** Pass-through to AgentsTab — gates each guide job card's "Open guide"
   *  action on whether that job belongs to the current review context. */
  canOpenGuideJob?: (job: import('@plannotator/ui/types').AgentJobInfo) => boolean;
}

const SuggestionPreview: React.FC<{ code: string; originalCode?: string; language?: string }> = ({ code, originalCode, language }) => {
  const diffStats = originalCode ? {
    removed: originalCode.split('\n').length,
    added: code.split('\n').length,
  } : null;

  return (
    <div className="suggestion-block compact">
      <div className="suggestion-block-header">
        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16m-7 6h7" />
        </svg>
        Suggestion
        {diffStats && (
          <span className="ml-auto text-[9px] font-mono">
            <span style={{ color: 'var(--success)' }}>+{diffStats.added}</span>
            {' '}
            <span style={{ color: 'var(--destructive)' }}>-{diffStats.removed}</span>
          </span>
        )}
      </div>
      <pre className="suggestion-block-code"><HighlightedCode code={code} language={language} /></pre>
    </div>
  );
};

/**
 * "+ General comment" — the human producer for a durable review-level comment
 * (the sole producer before this was Call Flow). The SAME button renders in
 * both placements (General section header, all-empty state); the composer is
 * the shared `DecisionNoteField` in a small anchored popover — the third
 * consumer of the note field, which is why it is a separate export from
 * `DecisionControl`.
 *
 * Fully controlled: `open`/`text` live in ReviewSidebar, shared by both
 * placements, so the draft survives a dismissal (outside click / Escape), a
 * placement flip (an external annotation arriving over SSE mid-sentence
 * unmounts the empty-state instance and mounts the section-header one), and a
 * tab switch. Only a commit clears it; collapsing the sidebar discards it
 * (accepted). An empty commit never fires the callback — it refocuses the
 * field, the same contract as the decision composers.
 */
const GeneralCommentComposer: React.FC<{
  onAdd: (text: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  text: string;
  onTextChange: (text: string) => void;
  /** Popover alignment relative to the button: section header anchors right,
   *  the centered empty-state button anchors center. */
  align: 'right' | 'center';
  /** The sidebar panel's width when it is a fixed-width panel; undefined in
   *  the full-screen overlay presentation (the 100vw class guard covers it). */
  panelWidth?: number;
  touchTarget?: boolean;
}> = ({ onAdd, open, onOpenChange, text, onTextChange, align, panelWidth, touchTarget }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDismissablePopover({ enabled: open, ref, onDismiss: () => onOpenChange(false) });

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      ref.current?.querySelector<HTMLTextAreaElement>('[data-decision-note-input]')?.focus();
      return;
    }
    onAdd(trimmed);
    onTextChange('');
    onOpenChange(false);
  };

  // Width clamp — the popover lives inside OverlayScrollArea (overflow-x
  // hidden) in a panel the user can persist anywhere in 200-600px, so an
  // unclamped w-64 (256px) clips unrecoverably below ~276px. Cap it to the
  // panel width minus 32px. Geometry at the extremes: the section-header
  // anchor's right edge sits 24px in from the panel's right (p-2 + p-2 + px-2
  // nesting), so at 200px the clamped 168px popover's left edge lands at
  // 200-24-168 = 8px; the empty-state anchor is panel-centered, 100±84 =
  // 16..184px. At 288px the clamp equals w-64 (256px, left edge 8px); wider
  // panels keep the 256px cap. Inline style so it tracks live resizes.
  const clampStyle = panelWidth !== undefined ? { maxWidth: panelWidth - 32 } : undefined;

  return (
    <div ref={ref} className="relative" data-review-general-composer={open ? 'open' : 'closed'}>
      <button
        type="button"
        data-pn-touch-target={touchTarget || undefined}
        data-add-general-comment
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Add a review-level comment"
        className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        + General comment
      </button>
      {open && (
        <div
          className={`absolute top-full z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-2 shadow-xl ${
            align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
          }`}
          style={clampStyle}
        >
          <DecisionNoteField
            text={text}
            onTextChange={onTextChange}
            onSubmit={submit}
            onCancel={() => onOpenChange(false)}
            placeholder="Add a general comment..."
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10px] leading-snug text-muted-foreground">{submitHint}</span>
            <Button size="xs" data-general-comment-add onClick={submit} title="Add the comment to this review">
              Add comment
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

const SCOPE_ORDER = { general: 0, file: 1, line: 2 } as const;

function getAnnotationScope(annotation: CodeAnnotation): CodeAnnotationScope {
  return annotation.scope ?? 'line';
}

function compareCodeAnnotations(a: CodeAnnotation, b: CodeAnnotation): number {
  const aScope = getAnnotationScope(a);
  const bScope = getAnnotationScope(b);

  if (aScope !== bScope) {
    return SCOPE_ORDER[aScope] - SCOPE_ORDER[bScope];
  }

  return aScope === 'line'
    ? a.lineStart - b.lineStart
    : b.createdAt - a.createdAt;
}


export const ReviewSidebar: React.FC<ReviewSidebarProps> = /* React.memo */({
  isOpen,
  onClose,
  presentation = 'panel',
  activeTab,
  annotations,
  files,
  selectedAnnotationId,
  onSelectAnnotation,
  onNavigateToAnnotation,
  onDeleteAnnotation,
  onAddGeneralComment,
  feedbackMarkdown,
  width,
  editorAnnotations,
  onDeleteEditorAnnotation,
  descriptionAnnotations,
  selectedDescriptionAnnotationId,
  onSelectDescriptionAnnotation,
  onDeleteDescriptionAnnotation,
  commentAnnotations,
  selectedCommentAnnotationId,
  onSelectCommentAnnotation,
  onDeleteCommentAnnotation,
  prMetadata,
  aiAvailable = false,
  aiMessages = [],
  isAICreatingSession = false,
  isAIStreaming = false,
  onAIStop,
  onScrollToAILines,
  activeFilePath,
  scrollToQuestionId,
  onAskGeneral,
  aiPermissionRequests = [],
  onRespondToPermission,
  aiProviders,
  aiConfig,
  onAIConfigChange,
  hasAISession,
  agentJobs,
  agentCapabilities,
  onAgentLaunch,
  onAgentKillJob,
  onAgentKillAll,
  externalAnnotations,
  onOpenJobDetail,
  onOpenGuide,
  guideLaunchable,
  canOpenGuideJob,
}) => {
  const totalCount = annotations.length + (editorAnnotations?.length ?? 0) + (descriptionAnnotations?.length ?? 0) + (commentAnnotations?.length ?? 0);
  const [copied, setCopied] = useState(false);
  // General-comment composer state lives HERE, not in GeneralCommentComposer:
  // the two placements (empty state vs section header) are different branches,
  // so a totalCount 0→1 flip mid-sentence (an external annotation arriving
  // over SSE) or a tab switch unmounts the instance — parent state keeps the
  // draft and open popover across both. Collapsing the sidebar unmounts this
  // component and discards the draft (accepted).
  const [generalComposerOpen, setGeneralComposerOpen] = useState(false);
  const [generalDraft, setGeneralDraft] = useState('');
  // Available panel width for the popover clamp; the overlay presentation is
  // full-screen, where the 100vw class guard applies instead.
  const generalComposerPanelWidth = presentation === 'overlay' ? undefined : (width ?? 288);

  const handleQuickCopy = async () => {
    if (!feedbackMarkdown) return;
    if (await copyTextToClipboard(feedbackMarkdown)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Failed to copy');
    }
  };

  // Split out general (review-level) comments — they belong to no file — then
  // group the rest by file, optionally by PR first.
  const { generalAnnotations, groupedAnnotations, prGroups, isMultiPR } = React.useMemo(() => {
    const general: CodeAnnotation[] = [];
    const placed: CodeAnnotation[] = [];
    for (const ann of annotations) {
      if ((ann.scope ?? 'line') === 'general') general.push(ann);
      else placed.push(ann);
    }
    general.sort((a, b) => b.createdAt - a.createdAt);

    const prUrls = new Set(placed.map(a => a.prUrl).filter(Boolean));
    const multiPR = prUrls.size > 1;

    const grouped = new Map<string, CodeAnnotation[]>();
    for (const ann of placed) {
      const existing = grouped.get(ann.filePath) || [];
      existing.push(ann);
      grouped.set(ann.filePath, existing);
    }
    for (const [, anns] of grouped) {
      anns.sort(compareCodeAnnotations);
    }

    let prs: Map<string, Map<string, CodeAnnotation[]>> | null = null;
    if (multiPR) {
      prs = new Map();
      for (const ann of placed) {
        const prKey = ann.prUrl ?? '_none';
        if (!prs.has(prKey)) prs.set(prKey, new Map());
        const fileMap = prs.get(prKey)!;
        const existing = fileMap.get(ann.filePath) || [];
        existing.push(ann);
        fileMap.set(ann.filePath, existing);
      }
      for (const fileMap of prs.values()) {
        for (const anns of fileMap.values()) {
          anns.sort(compareCodeAnnotations);
        }
      }
    }

    return { generalAnnotations: general, groupedAnnotations: grouped, prGroups: prs, isMultiPR: multiPR };
  }, [annotations]);

  if (!isOpen) return null;

  function renderAnnotationCard(annotation: CodeAnnotation) {
    const isSelected = selectedAnnotationId === annotation.id;
    const scope = getAnnotationScope(annotation);
    const isFileScope = scope === 'file';
    const isGeneralScope = scope === 'general';
    return (
      <div
        key={annotation.id}
        onClick={() => onNavigateToAnnotation(annotation.id)}
        className={`group relative p-2.5 rounded border cursor-pointer transition-colors duration-150 ${
          isSelected
            ? 'bg-primary/5 border-primary/30'
            : 'border-transparent hover:bg-muted/30'
        }`}
      >
        <CommentMeta
          leading={
            isGeneralScope && annotation.callFlowTargets?.length ? (
              <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                flow · {annotation.callFlowTargets.length} {annotation.callFlowTargets.length === 1 ? 'step' : 'steps'}
              </span>
            ) : isGeneralScope ? (
              <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                general
              </span>
            ) : isFileScope ? (
              <span className="inline-flex items-center gap-1.5">
                <FileNameChip path={annotation.filePath} />
                {annotation.callFlowTargets?.length ? (
                  <span className="text-[9px] text-primary/80">
                    flow · {annotation.callFlowTargets.length} {annotation.callFlowTargets.length === 1 ? 'step' : 'steps'}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-[10px] font-mono text-muted-foreground">
                {annotation.callFlowTargets?.length ? (
                  <span className="mr-1 text-primary/80">
                    flow · {annotation.callFlowTargets.length} {annotation.callFlowTargets.length === 1 ? 'step' : 'steps'} ·
                  </span>
                ) : null}
                {annotation.lineStart === annotation.lineEnd
                  ? `L${annotation.lineStart}`
                  : `L${annotation.lineStart}-${annotation.lineEnd}`}
                {annotation.tokenText && (
                  <span className="ml-1 text-primary/70">{`\`${annotation.tokenText.length > 30 ? annotation.tokenText.slice(0, 27) + '...' : annotation.tokenText}\``}</span>
                )}
              </span>
            )
          }
          conventionalLabel={annotation.conventionalLabel}
          decorations={annotation.decorations}
          reviewProfileLabel={annotation.reviewProfileLabel}
          source={annotation.source}
          author={annotation.author}
          createdAt={annotation.createdAt}
        />
        {annotation.text && (
          <div className="text-xs text-foreground/80 line-clamp-2 review-comment-markdown">
            {renderInlineMarkdown(annotation.text)}
          </div>
        )}
        {annotation.suggestedCode && !isGeneralScope && (
          <div className="mt-1.5">
            <SuggestionPreview code={annotation.suggestedCode} originalCode={annotation.originalCode} language={detectLanguage(annotation.filePath)} />
          </div>
        )}
        <CommentActions
          copyText={annotation.text ? commentCopyText(annotation, scope) : undefined}
          onDelete={() => onDeleteAnnotation(annotation.id)}
        />
      </div>
    );
  }

  // Prose annotations on the PR description — comment-only, anchored to selected
  // text (no file/line). Mirrors renderAnnotationCard for visual consistency.
  // Shared card shell for prose annotations (PR description + PR comment): a
  // scope label, the quoted source text, the reviewer's note, select + delete.
  // Thin per-type call sites below map their fields onto it.
  function renderProseAnnotationCard(opts: {
    id: string;
    label: string;
    quote?: string;
    quoteClamp?: string;
    note?: string;
    author?: string;
    createdAt: number;
    source?: string;
    isSelected: boolean;
    onSelect: () => void;
    onDelete: () => void;
  }) {
    const { id, label, quote, quoteClamp = 'line-clamp-2', note, author, createdAt, source, isSelected, onSelect, onDelete } = opts;
    return (
      <div
        key={id}
        onClick={onSelect}
        className={`group relative p-2.5 rounded border cursor-pointer transition-colors duration-150 ${
          isSelected ? 'bg-primary/5 border-primary/30' : 'border-transparent hover:bg-muted/30'
        }`}
      >
        <CommentMeta
          leading={
            <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
              {label}
            </span>
          }
          source={source}
          author={author}
          createdAt={createdAt}
        />
        {quote && (
          <div className={`mt-1 mb-1 border-l-2 border-border/40 pl-1.5 text-[11px] italic text-muted-foreground/80 ${quoteClamp}`}>
            {quote}
          </div>
        )}
        {note && (
          <div className="text-xs text-foreground/80 line-clamp-2 review-comment-markdown">
            {renderInlineMarkdown(note)}
          </div>
        )}
        <CommentActions copyText={note || undefined} onDelete={onDelete} />
      </div>
    );
  }

  const renderDescriptionAnnotationCard = (annotation: Annotation) => renderProseAnnotationCard({
    id: annotation.id,
    label: annotation.artifact
      ? `${annotation.artifact.artifactKind} · ${artifactAnchorLabel(annotation.artifact.anchor)}`
      : 'PR description',
    quote: annotation.artifact ? artifactAnnotationQuote(annotation.artifact) : annotation.originalText,
    quoteClamp: 'line-clamp-1',
    note: annotation.text,
    author: annotation.author,
    createdAt: annotation.createdA,
    source: annotation.source,
    isSelected: selectedDescriptionAnnotationId === annotation.id,
    onSelect: () => onSelectDescriptionAnnotation?.(annotation.id),
    onDelete: () => onDeleteDescriptionAnnotation?.(annotation.id),
  });

  const renderCommentAnnotationCard = (annotation: CommentAnnotation) => renderProseAnnotationCard({
    id: annotation.id,
    label: annotation.artifact
      ? `${annotation.artifact.artifactKind} · ${artifactAnchorLabel(annotation.artifact.anchor)}`
      : 'PR comment',
    quote: annotation.artifact ? artifactAnnotationQuote(annotation.artifact) : annotation.commentBody,
    note: annotation.text,
    author: annotation.commentAuthor,
    createdAt: annotation.createdAt,
    isSelected: selectedCommentAnnotationId === annotation.id,
    onSelect: () => onSelectCommentAnnotation?.(annotation.id),
    onDelete: () => onDeleteCommentAnnotation?.(annotation.id),
  });

  return (
    <aside
      data-pn-review-transient-overlay={presentation === 'overlay' || undefined}
      role={presentation === 'overlay' ? 'dialog' : undefined}
      aria-label={presentation === 'overlay' ? 'Review sidebar' : undefined}
      className={presentation === 'overlay'
        ? 'absolute inset-0 z-40 flex min-w-0 flex-col bg-background'
        : 'border-l border-border/50 bg-card/30 backdrop-blur-sm flex flex-col flex-shrink-0'
      }
      style={presentation === 'overlay' ? undefined : { width: width ?? 288 }}
    >
        {/* Header */}
        <div
          className={`px-3 flex items-center border-b border-border/50 ${presentation === 'overlay' ? 'min-h-[52px]' : ''}`}
          style={presentation === 'overlay' ? undefined : { height: 'var(--panel-header-h)' }}
        >
          <div className="flex items-center gap-2 w-full min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
              {activeTab === 'annotations' ? 'Annotations' : activeTab === 'ai' ? 'AI' : 'Review Agents'}
            </h2>
            {activeTab === 'annotations' && totalCount > 0 && (
              <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                {totalCount}
              </span>
            )}
            {activeTab === 'agents' && (agentJobs?.length ?? 0) > 0 && (
              <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                {agentJobs!.length}
              </span>
            )}
            {activeTab === 'ai' && aiMessages.length > 0 && (
              <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                {aiMessages.length}
              </span>
            )}
            {presentation === 'overlay' && (
              <button
                data-pn-touch-target
                data-pn-touch-target-icon
                autoFocus
                type="button"
                onClick={onClose}
                className="ml-auto inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close review sidebar"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <OverlayScrollArea className="flex-1 min-h-0">
          {/* Annotations tab */}
          {activeTab === 'annotations' && (
            <div className="p-2 space-y-1.5">
              {totalCount === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-center px-4">
                  <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-3">
                    <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                    </svg>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {presentation === 'overlay' ? 'Tap a line to add an annotation' : 'Click on lines to add annotations'}
                  </p>
                  {onAddGeneralComment && (
                    <div className="mt-3">
                      <GeneralCommentComposer
                        onAdd={onAddGeneralComment}
                        open={generalComposerOpen}
                        onOpenChange={setGeneralComposerOpen}
                        text={generalDraft}
                        onTextChange={setGeneralDraft}
                        align="center"
                        panelWidth={generalComposerPanelWidth}
                        touchTarget={presentation === 'overlay'}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-2 space-y-4">
                  {(generalAnnotations.length > 0 || onAddGeneralComment) && (
                    <div>
                      {/* z above the file/PR sticky headers (z-10/z-20) so the
                          anchored composer popover is never painted under a
                          later section's header. */}
                      <div className="sticky top-0 z-[25] bg-background/95 backdrop-blur-sm px-2 py-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-muted-foreground">General</span>
                        {onAddGeneralComment && (
                          <GeneralCommentComposer
                            onAdd={onAddGeneralComment}
                            open={generalComposerOpen}
                            onOpenChange={setGeneralComposerOpen}
                            text={generalDraft}
                            onTextChange={setGeneralDraft}
                            align="right"
                            panelWidth={generalComposerPanelWidth}
                            touchTarget={presentation === 'overlay'}
                          />
                        )}
                      </div>
                      {generalAnnotations.length > 0 && (
                        <div className="space-y-1">
                          {generalAnnotations.map((annotation) => renderAnnotationCard(annotation))}
                        </div>
                      )}
                    </div>
                  )}
                  {isMultiPR && prGroups ? (
                    Array.from(prGroups.entries()).map(([prUrl, fileMap]) => {
                      const sample = fileMap.values().next().value?.[0];
                      const prLabel = prUrl === '_none' ? 'Local Changes' :
                        `${sample?.prRepo ? `${sample.prRepo}` : ''}#${sample?.prNumber ?? '?'} ${sample?.prTitle ?? ''}`;
                      return (
                        <div key={prUrl}>
                          <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-2 py-1.5 text-[10px] font-medium text-accent/80 border-b border-border/30 mb-1">
                            {prLabel}
                          </div>
                          <div className="space-y-4">
                            {Array.from(fileMap.entries()).map(([filePath, fileAnnotations]) => (
                              <div key={filePath}>
                                <div className="sticky top-7 z-10 bg-background/95 backdrop-blur-sm px-2 py-1 text-xs font-mono text-muted-foreground truncate">
                                  {filePath.split('/').pop()}
                                </div>
                                <div className="space-y-1">
                                  {fileAnnotations.map((annotation) => renderAnnotationCard(annotation))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    Array.from(groupedAnnotations.entries()).map(([filePath, fileAnnotations]) => (
                      <div key={filePath}>
                        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-2 py-1 text-xs font-mono text-muted-foreground truncate">
                          {filePath.split('/').pop()}
                        </div>
                        <div className="space-y-1">
                          {fileAnnotations.map((annotation) => renderAnnotationCard(annotation))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Editor annotations (VS Code) */}
              {editorAnnotations && editorAnnotations.length > 0 && (
                <>
                  {annotations.length > 0 && (
                    <div className="flex items-center gap-2 pt-2 pb-1">
                      <div className="flex-1 border-t border-border/30" />
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">Editor</span>
                      <div className="flex-1 border-t border-border/30" />
                    </div>
                  )}
                  {editorAnnotations.map(ann => (
                    <EditorAnnotationCard
                      key={ann.id}
                      annotation={ann}
                      variant="code-review"
                      onDelete={() => onDeleteEditorAnnotation?.(ann.id)}
                    />
                  ))}
                </>
              )}

              {/* PR description annotations */}
              {descriptionAnnotations && descriptionAnnotations.length > 0 && (
                <>
                  {(annotations.length > 0 || (editorAnnotations?.length ?? 0) > 0) && (
                    <div className="flex items-center gap-2 pt-2 pb-1">
                      <div className="flex-1 border-t border-border/30" />
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">PR description</span>
                      <div className="flex-1 border-t border-border/30" />
                    </div>
                  )}
                  <div className="space-y-1">
                    {descriptionAnnotations.map(renderDescriptionAnnotationCard)}
                  </div>
                </>
              )}

              {/* PR comment annotations */}
              {commentAnnotations && commentAnnotations.length > 0 && (
                <>
                  {(annotations.length > 0 || (editorAnnotations?.length ?? 0) > 0 || (descriptionAnnotations?.length ?? 0) > 0) && (
                    <div className="flex items-center gap-2 pt-2 pb-1">
                      <div className="flex-1 border-t border-border/30" />
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">PR comments</span>
                      <div className="flex-1 border-t border-border/30" />
                    </div>
                  )}
                  <div className="space-y-1">
                    {commentAnnotations.map(renderCommentAnnotationCard)}
                  </div>
                </>
              )}

            </div>
          )}

          {/* AI tab */}
          {activeTab === 'ai' && (
            <AITab
              messages={aiMessages}
              isCreatingSession={isAICreatingSession}
              isStreaming={isAIStreaming}
              activeFilePath={activeFilePath}
              scrollToQuestionId={scrollToQuestionId}
              onScrollToLines={onScrollToAILines ?? (() => {})}
              onAskGeneral={onAskGeneral}
              onStop={onAIStop}
              permissionRequests={aiPermissionRequests}
              onRespondToPermission={onRespondToPermission}
              aiProviders={aiProviders}
              aiConfig={aiConfig}
              onAIConfigChange={onAIConfigChange}
              hasAISession={hasAISession}
            />
          )}

          {/* Agents tab */}
          {activeTab === 'agents' && (
            <AgentsTab
              jobs={agentJobs ?? []}
              capabilities={agentCapabilities ?? null}
              onLaunch={onAgentLaunch ?? (() => null)}
              onKillJob={onAgentKillJob ?? (() => {})}
              onKillAll={onAgentKillAll ?? (() => {})}
              externalAnnotations={externalAnnotations ?? []}
              onOpenJobDetail={onOpenJobDetail}
              onOpenGuide={onOpenGuide}
              guideLaunchable={guideLaunchable}
              canOpenGuideJob={canOpenGuideJob}
            />
          )}

        </OverlayScrollArea>

        {/* Quick Copy Footer — annotations tab only */}
        {activeTab === 'annotations' && feedbackMarkdown && totalCount > 0 && (
          <div className="p-2 border-t border-border/50">
            <button
              data-pn-touch-target={presentation === 'overlay' || undefined}
              onClick={handleQuickCopy}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-xs font-medium transition-all text-muted-foreground hover:text-foreground hover:bg-muted/50"
            >
              {copied ? (
                <>
                  <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy Feedback
                </>
              )}
            </button>
          </div>
        )}
    </aside>
  );
};
