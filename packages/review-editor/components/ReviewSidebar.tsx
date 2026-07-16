import React, { useState } from 'react';
import { CodeAnnotation, type CodeAnnotationScope, type EditorAnnotation, type Annotation, type CommentAnnotation } from '@plannotator/ui/types';
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
import type { AIChatEntry } from '../hooks/useAIChat';
import type { AgentJobInfo, AgentCapabilities } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import type { AIProviderOption } from '@plannotator/ui/utils/aiProvider';

export type ReviewSidebarTab = 'annotations' | 'ai' | 'agents';


interface ReviewSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: ReviewSidebarTab;
  annotations: CodeAnnotation[];
  files: DiffFile[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  /** Sidebar row click → select AND scroll the diff to the comment. */
  onNavigateToAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
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
  aiPermissionRequests?: import('../hooks/useAIChat').PendingPermission[];
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
  activeTab,
  annotations,
  files,
  selectedAnnotationId,
  onSelectAnnotation,
  onNavigateToAnnotation,
  onDeleteAnnotation,
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

  const handleQuickCopy = async () => {
    if (!feedbackMarkdown) return;
    try {
      await navigator.clipboard.writeText(feedbackMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
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
            isGeneralScope ? (
              <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                general
              </span>
            ) : isFileScope ? (
              <FileNameChip path={annotation.filePath} />
            ) : (
              <span className="text-[10px] font-mono text-muted-foreground">
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
    label: 'PR description',
    quote: annotation.originalText,
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
    label: 'PR comment',
    quote: annotation.commentBody,
    note: annotation.text,
    author: annotation.commentAuthor,
    createdAt: annotation.createdAt,
    isSelected: selectedCommentAnnotationId === annotation.id,
    onSelect: () => onSelectCommentAnnotation?.(annotation.id),
    onDelete: () => onDeleteCommentAnnotation?.(annotation.id),
  });

  return (
    <aside className="border-l border-border/50 bg-card/30 backdrop-blur-sm flex flex-col flex-shrink-0" style={{ width: width ?? 288 }}>
        {/* Header */}
        <div className="px-3 flex items-center border-b border-border/50" style={{ height: 'var(--panel-header-h)' }}>
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
                    Click on lines to add annotations
                  </p>
                </div>
              ) : (
                <div className="p-2 space-y-4">
                  {generalAnnotations.length > 0 && (
                    <div>
                      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-2 py-1 text-xs font-medium text-muted-foreground">
                        General
                      </div>
                      <div className="space-y-1">
                        {generalAnnotations.map((annotation) => renderAnnotationCard(annotation))}
                      </div>
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
