import React, { useState, useRef, useEffect } from 'react';
import { Annotation, AnnotationType, Block, type CodeAnnotation, type EditorAnnotation } from '../types';
import { isCurrentUser } from '../utils/identity';
import { ImageThumbnail } from './ImageThumbnail';
import { EditorAnnotationCard } from './EditorAnnotationCard';
import { useIsMobile } from '../hooks/useIsMobile';
import { OverlayScrollArea } from './OverlayScrollArea';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

// Card type-word colors. Deletion uses `destructive` (reliably red on every
// theme, matching the in-document .deletion highlight). Comment uses the
// `annotation-comment` token, which defaults to each theme's --accent (so it
// stays consistent with the .comment highlight) but is overridden to a legible
// blue in neutral themes whose accent is a low-contrast gray (e.g. "simple").
// Global has no in-document highlight, so it uses a fixed legible purple.
const TYPE_COLOR: Record<AnnotationType, string> = {
  [AnnotationType.DELETION]: 'text-destructive',
  [AnnotationType.COMMENT]: 'text-annotation-comment',
  [AnnotationType.GLOBAL_COMMENT]: 'text-purple-500',
};

const TYPE_LABEL: Record<AnnotationType, string> = {
  [AnnotationType.DELETION]: 'Deletion',
  [AnnotationType.COMMENT]: 'Comment',
  [AnnotationType.GLOBAL_COMMENT]: 'Global',
};

const PencilIcon = () => (
  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
);

const TrashCardIcon = () => (
  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

interface DirectEditsPanelItem {
  id: string;
  label?: string;
  added: number;
  removed: number;
  diffText: string;
  onDiscard?: () => void;
}

interface PanelProps {
  isOpen: boolean;
  annotations: Annotation[];
  blocks: Block[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit?: (id: string, updates: Partial<Annotation>) => void;
  selectedId: string | null;
  codeAnnotations?: CodeAnnotation[];
  onSelectCodeAnnotation?: (id: string) => void;
  onDeleteCodeAnnotation?: (id: string) => void;
  onEditCodeAnnotation?: (id: string, updates: Partial<CodeAnnotation>) => void;
  sharingEnabled?: boolean;
  width?: number | string;
  editorAnnotations?: EditorAnnotation[];
  onDeleteEditorAnnotation?: (id: string) => void;
  onClose?: () => void;
  onQuickCopy?: () => Promise<void>;
  onShare?: () => void;
  otherFileAnnotations?: { count: number; files: number };
  onOtherFileAnnotationsClick?: () => void;
  /** Committed direct edits to one or more documents. Rendered as pinned cards
    *  above the annotation timeline with expandable unified diffs. */
  directEdits?: DirectEditsPanelItem[] | null;
}

export const AnnotationPanel: React.FC<PanelProps> = ({
  isOpen,
  annotations,
  blocks,
  onSelect,
  onDelete,
  onEdit,
  selectedId,
  codeAnnotations = [],
  onSelectCodeAnnotation,
  onDeleteCodeAnnotation,
  onEditCodeAnnotation,
  sharingEnabled = true,
  width,
  editorAnnotations,
  onDeleteEditorAnnotation,
  onClose,
  onQuickCopy,
  onShare,
  otherFileAnnotations,
  onOtherFileAnnotationsClick,
  directEdits = null,
}) => {
  const isMobile = useIsMobile();
  const [copiedText, setCopiedText] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const sortedAnnotations = [...annotations].sort((a, b) => a.createdA - b.createdA);
  const sortedCodeAnnotations = [...codeAnnotations].sort((a, b) => a.createdAt - b.createdAt);
  const timelineEntries = [
    ...sortedAnnotations.map(annotation => ({ kind: 'plan' as const, ts: annotation.createdA, annotation })),
    ...sortedCodeAnnotations.map(annotation => ({ kind: 'code' as const, ts: annotation.createdAt, annotation })),
  ].sort((a, b) => a.ts - b.ts);
  const totalCount = annotations.length + codeAnnotations.length + (editorAnnotations?.length ?? 0);

  // Scroll selected annotation card into view
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const card = listRef.current.querySelector(`[data-annotation-id="${selectedId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedId]);

  if (!isOpen) return null;

  const panel = (
    <aside
      data-annotation-panel="true"
      data-plan-sidebar="right"
      className={`border-l border-border/50 bg-card flex flex-col flex-shrink-0 ${
        isMobile ? 'fixed top-12 bottom-0 right-0 z-[60] w-full max-w-sm shadow-2xl bg-card' : ''
      }`}
      style={isMobile ? undefined : { width: width ?? 288 }}
    >
      {/* Header */}
      <div className="border-b border-border/50">
        <div className="flex h-10 items-center justify-between px-3">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium text-foreground">
              Annotations
            </h2>
            {totalCount > 0 && (
              <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[10px] font-medium tabular-nums text-primary">
                {totalCount}
              </span>
            )}
          </div>
          {isMobile && onClose && (
            <button
              onClick={onClose}
              className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground md:hidden"
              title="Close panel"
              aria-label="Close panel"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        {otherFileAnnotations && otherFileAnnotations.count > 0 && (
          <button
            onClick={onOtherFileAnnotationsClick}
            className="px-3 pb-2 text-[10px] text-primary/70 hover:text-primary transition-colors cursor-pointer"
            title="Show annotated files in sidebar"
          >
            +{otherFileAnnotations.count} in {otherFileAnnotations.files} other file{otherFileAnnotations.files === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {/* List */}
      <OverlayScrollArea className="flex-1 min-h-0">
        <div ref={listRef} className="p-2 flex flex-col gap-1.5">
        {directEdits?.map((item) => (
          <DirectEditsCard key={item.id} {...item} />
        ))}
        {totalCount === 0 ? (
          (!directEdits || directEdits.length === 0) && (
            <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
              <p className="text-xs text-muted-foreground/60">
                No annotations yet
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/40">
                Select text to annotate
              </p>
            </div>
          )
        ) : (
          <>
            {timelineEntries.map(entry => (
              entry.kind === 'plan' ? (
                <AnnotationCard
                  key={entry.annotation.id}
                  annotation={entry.annotation}
                  isSelected={selectedId === entry.annotation.id}
                  isMe={isCurrentUser(entry.annotation.author)}
                  onSelect={() => onSelect(entry.annotation.id)}
                  onDelete={() => onDelete(entry.annotation.id)}
                  onEdit={onEdit ? (updates: Partial<Annotation>) => onEdit(entry.annotation.id, updates) : undefined}
                />
              ) : (
                <CodeAnnotationCard
                  key={entry.annotation.id}
                  annotation={entry.annotation}
                  isSelected={selectedId === entry.annotation.id}
                  isMe={isCurrentUser(entry.annotation.author)}
                  onSelect={() => onSelectCodeAnnotation?.(entry.annotation.id)}
                  onDelete={() => onDeleteCodeAnnotation?.(entry.annotation.id)}
                  onEdit={onEditCodeAnnotation ? (updates: Partial<CodeAnnotation>) => onEditCodeAnnotation(entry.annotation.id, updates) : undefined}
                />
              )
            ))}
            {editorAnnotations && editorAnnotations.length > 0 && (
              <>
                {timelineEntries.length > 0 && (
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
                    onDelete={() => onDeleteEditorAnnotation?.(ann.id)}
                  />
                ))}
              </>
            )}

          </>
        )}
        </div>
      </OverlayScrollArea>

      {/* Quick Actions Footer */}
      {totalCount > 0 && (
        <div className="border-t border-border/50 px-3 py-2 flex gap-1.5">
          {onQuickCopy && (
            <button
              onClick={async () => {
                await onQuickCopy();
                setCopiedText(true);
                setTimeout(() => setCopiedText(false), 2000);
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors ${
                copiedText ? 'text-green-500' : 'text-muted-foreground hover:bg-surface-1 hover:text-foreground'
              }`}
            >
              {copiedText ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          )}
          {sharingEnabled && onShare && (
            <button
              onClick={onShare}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors text-muted-foreground hover:bg-surface-1 hover:text-foreground"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              Share
            </button>
          )}
        </div>
      )}
    </aside>
  );

  if (isMobile) {
    return (
      <>
        <div
          className="fixed inset-0 z-[59] bg-background/60 backdrop-blur-sm"
          onClick={onClose}
        />
        {panel}
      </>
    );
  }

  return panel;
};

function formatTimestamp(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Pinned card for committed direct edits: +N/−M summary, expandable unified
 *  diff, and a two-step discard. Not part of the annotation timeline — edits
 *  are document state, not a selection-anchored note. */
const DirectEditsCard: React.FC<{
  label?: string;
  added: number;
  removed: number;
  diffText: string;
  onDiscard?: () => void;
}> = ({ label, added, removed, diffText, onDiscard }) => {
  const [expanded, setExpanded] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Auto-cancel the discard confirmation after a beat.
  useEffect(() => {
    if (!confirmDiscard) return;
    const t = setTimeout(() => setConfirmDiscard(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDiscard]);

  // Show from the first hunk header; the ---/+++ preamble is noise here.
  const diffLines = React.useMemo(() => {
    const lines = diffText.split('\n');
    const fileSeparators = lines.filter((l) => l.startsWith('===')).length;
    if (fileSeparators > 1) return lines;
    const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
    return firstHunk === -1 ? lines : lines.slice(firstHunk);
  }, [diffText]);

  return (
    <div className="w-full rounded-lg px-3 py-2.5 bg-surface-1/40 ring-1 ring-border/40">
      <div className="flex items-center gap-1.5">
        <PencilIcon />
        <span className="text-[11px] font-medium text-primary">Edits</span>
        {label && (
          <span className="min-w-0 truncate text-[10px] text-muted-foreground" title={label}>
            {label}
          </span>
        )}
        <span className="font-mono text-[10px] tabular-nums">
          <span className="text-success">+{added}</span>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-destructive">-{removed}</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-surface-1 hover:text-foreground"
            aria-expanded={expanded}
          >
            {expanded ? 'Hide diff' : 'Diff'}
          </button>
          {onDiscard && (
            <button
              type="button"
              onClick={() => {
                if (confirmDiscard) {
                  setConfirmDiscard(false);
                  onDiscard();
                } else {
                  setConfirmDiscard(true);
                }
              }}
              className={cn(
                'cursor-pointer rounded px-1.5 py-0.5 text-[10px] transition-colors',
                confirmDiscard
                  ? 'bg-destructive/15 text-destructive hover:bg-destructive/25'
                  : 'text-muted-foreground hover:bg-surface-1 hover:text-destructive',
              )}
            >
              {confirmDiscard ? 'Confirm?' : 'Discard'}
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-[10px] leading-snug text-muted-foreground/60">
        Your text changes — sent with the feedback as a diff.
      </p>
      {expanded && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
          {diffLines.map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith('+') ? 'text-success'
                : line.startsWith('-') ? 'text-destructive'
                : line.startsWith('@@') ? 'text-primary/70'
                : 'text-muted-foreground'
              }
            >
              {line.length === 0 ? ' ' : line}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
};

const AnnotationCard: React.FC<{
  annotation: Annotation;
  isSelected: boolean;
  isMe: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onEdit?: (updates: Partial<Annotation>) => void;
}> = ({ annotation, isSelected, isMe, onSelect, onDelete, onEdit }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(annotation.text || '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  // Update editText when annotation.text changes
  useEffect(() => {
    if (!isEditing) {
      setEditText(annotation.text || '');
    }
  }, [annotation.text, isEditing]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditText(annotation.text || '');
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    if (onEdit) {
      onEdit({ text: editText });
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditText(annotation.text || '');
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const typeColor = TYPE_COLOR[annotation.type] ?? 'text-muted-foreground';
  const typeLabel = TYPE_LABEL[annotation.type] ?? 'Note';
  const isGlobal = annotation.type === AnnotationType.GLOBAL_COMMENT;

  // Shared edit textarea — matches the prototype composer primitive
  const editComposer = (
    <div onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      <textarea
        ref={textareaRef}
        value={editText}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add your comment..."
        aria-label="Annotation comment"
        className="w-full resize-none rounded-lg border border-border/50 bg-card px-2.5 py-2 text-base leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
        style={{ fieldSizing: 'content', minHeight: 44 } as React.CSSProperties}
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <Button variant="ghost" size="xxs" onClick={handleCancelEdit}>Cancel</Button>
        <Button size="xxs" disabled={!editText.trim()} onClick={handleSaveEdit}>Save</Button>
      </div>
    </div>
  );

  return (
    <div
      data-annotation-id={annotation.id}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group w-full cursor-pointer rounded-lg px-3 py-2.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        isSelected ? 'bg-surface-1 ring-1 ring-border/50' : 'hover:bg-surface-1/50',
      )}
    >
      {/* Header: type word + author · time + actions */}
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className={cn('text-[11px] font-medium', typeColor)}>{typeLabel}</span>
        {annotation.diffContext && (
          <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">
            diff
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/50 truncate">
          {annotation.author ? `${annotation.author}${isMe ? ' (me)' : ''} · ` : ''}{formatTimestamp(annotation.createdA)}
        </span>
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {onEdit && annotation.type !== AnnotationType.DELETION && !isEditing && (
            <button
              type="button"
              onClick={handleStartEdit}
              className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground"
              title="Edit annotation"
            >
              <PencilIcon />
            </button>
          )}
          <button
            type="button"
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onDelete(); }}
            className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-destructive"
            title="Delete annotation"
          >
            <TrashCardIcon />
          </button>
        </div>
      </div>

      {/* Global Comment - show text directly */}
      {isGlobal ? (
        isEditing ? (
          editComposer
        ) : (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
            {annotation.text}
          </p>
        )
      ) : (
        <>
          {/* Quote — the annotated text */}
          <p className="mb-1.5 line-clamp-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground/80">
            "{annotation.originalText}"
          </p>

          {/* Comment/Replacement Text */}
          {annotation.type !== AnnotationType.DELETION && (
            isEditing ? (
              editComposer
            ) : (
              annotation.text && (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
                  {annotation.text}
                </p>
              )
            )
          )}
        </>
      )}

      {/* Attached Images */}
      {annotation.images && annotation.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {annotation.images.map((img, idx) => (
            <div key={idx} className="text-center">
              <ImageThumbnail
                path={img.path}
                size="sm"
                showRemove={false}
              />
              <div className="text-[9px] text-muted-foreground truncate max-w-[3rem]" title={img.name}>{img.name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const CodeAnnotationCard: React.FC<{
  annotation: CodeAnnotation;
  isSelected: boolean;
  isMe: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onEdit?: (updates: Partial<CodeAnnotation>) => void;
}> = ({ annotation, isSelected, isMe, onSelect, onDelete, onEdit }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(annotation.text || '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) setEditText(annotation.text || '');
  }, [annotation.text, isEditing]);

  const handleSaveEdit = () => {
    onEdit?.({ text: editText });
    setIsEditing(false);
  };

  const lineRange = annotation.lineStart === annotation.lineEnd
    ? `line ${annotation.lineStart}`
    : `lines ${annotation.lineStart}-${annotation.lineEnd}`;
  const fileName = annotation.filePath.split('/').pop() || annotation.filePath;

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditText(annotation.text || '');
  };

  return (
    <div
      data-annotation-id={annotation.id}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group w-full cursor-pointer rounded-lg px-3 py-2.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        isSelected ? 'bg-surface-1 ring-1 ring-border/50' : 'hover:bg-surface-1/50',
      )}
    >
      {/* Header: type word + author · time + actions */}
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-primary">Code</span>
        <span className="text-[10px] text-muted-foreground/50 truncate">
          {annotation.author ? `${annotation.author}${isMe ? ' (me)' : ''} · ` : ''}{formatTimestamp(annotation.createdAt)}
        </span>
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {onEdit && !isEditing && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
              className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground"
              title="Edit annotation"
            >
              <PencilIcon />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-destructive"
            title="Delete annotation"
          >
            <TrashCardIcon />
          </button>
        </div>
      </div>

      {/* File / line meta */}
      <div className="rounded px-2 py-1 bg-surface-1 font-mono text-[11px] text-muted-foreground truncate" title={annotation.filePath}>
        {fileName} · {lineRange}
      </div>

      {annotation.originalCode && (
        <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground/80">
          {annotation.originalCode}
        </p>
      )}

      {isEditing ? (
        <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSaveEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                handleCancelEdit();
              }
            }}
            placeholder="Add your comment..."
            aria-label="Annotation comment"
            className="w-full resize-none rounded-lg border border-border/50 bg-card px-2.5 py-2 text-base leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
            style={{ fieldSizing: 'content', minHeight: 44 } as React.CSSProperties}
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button variant="ghost" size="xxs" onClick={handleCancelEdit}>Cancel</Button>
            <Button size="xxs" disabled={!editText.trim()} onClick={handleSaveEdit}>Save</Button>
          </div>
        </div>
      ) : (
        annotation.text && (
          <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
            {annotation.text}
          </p>
        )
      )}

      {annotation.images && annotation.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {annotation.images.map((img) => (
            <div key={img.path} className="text-center">
              <ImageThumbnail path={img.path} size="sm" showRemove={false} />
              <div className="text-[9px] text-muted-foreground truncate max-w-[3rem]" title={img.name}>{img.name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
