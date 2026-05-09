import React, { useState, useRef, useEffect } from 'react';
import { Annotation, AnnotationType, Block, type CodeAnnotation, type EditorAnnotation } from '../types';
import { isCurrentUser } from '../utils/identity';
import { ImageThumbnail } from './ImageThumbnail';
import { EditorAnnotationCard } from './EditorAnnotationCard';
import { useIsMobile } from '../hooks/useIsMobile';
import { OverlayScrollArea } from './OverlayScrollArea';

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
  width?: number;
  editorAnnotations?: EditorAnnotation[];
  onDeleteEditorAnnotation?: (id: string) => void;
  onClose?: () => void;
  onQuickCopy?: () => Promise<void>;
  onShare?: () => void;
  otherFileAnnotations?: { count: number; files: number };
  onOtherFileAnnotationsClick?: () => void;
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
      className={`border-l border-border/50 bg-card/30 backdrop-blur-sm flex flex-col flex-shrink-0 ${
        isMobile ? 'fixed top-12 bottom-0 right-0 z-[60] w-full max-w-sm shadow-2xl bg-card' : ''
      }`}
      style={isMobile ? undefined : { width: width ?? 288 }}
    >
      {/* Header */}
      <div className="p-3 border-b border-border/50">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Annotations
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
              {totalCount}
            </span>
            {isMobile && onClose && (
              <button
                onClick={onClose}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Close panel"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {otherFileAnnotations && otherFileAnnotations.count > 0 && (
          <button
            onClick={onOtherFileAnnotationsClick}
            className="mt-1.5 text-[10px] text-primary/70 hover:text-primary transition-colors cursor-pointer"
            title="Show annotated files in sidebar"
          >
            +{otherFileAnnotations.count} in {otherFileAnnotations.files} other file{otherFileAnnotations.files === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {/* List */}
      <OverlayScrollArea className="flex-1 min-h-0">
        <div ref={listRef} className="p-2 space-y-1.5">
        {totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-center px-4">
            <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-3">
              <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </div>
            <p className="text-xs text-muted-foreground">
              Select text or code lines to add annotations
            </p>
          </div>
        ) : (
          <>
            {timelineEntries.map(entry => (
              entry.kind === 'plan' ? (
                <AnnotationCard
                  key={entry.annotation.id}
                  annotation={entry.annotation}
                  isSelected={selectedId === entry.annotation.id}
                  onSelect={() => onSelect(entry.annotation.id)}
                  onDelete={() => onDelete(entry.annotation.id)}
                  onEdit={onEdit ? (updates: Partial<Annotation>) => onEdit(entry.annotation.id, updates) : undefined}
                />
              ) : (
                <CodeAnnotationCard
                  key={entry.annotation.id}
                  annotation={entry.annotation}
                  isSelected={selectedId === entry.annotation.id}
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
        <div className="p-2 border-t border-border/50 flex gap-1.5">
          {onQuickCopy && (
            <button
              onClick={async () => {
                await onQuickCopy();
                setCopiedText(true);
                setTimeout(() => setCopiedText(false), 2000);
              }}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all text-muted-foreground hover:text-foreground hover:bg-muted/50"
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
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all text-muted-foreground hover:text-foreground hover:bg-muted/50"
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

const AnnotationCard: React.FC<{
  annotation: Annotation;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onEdit?: (updates: Partial<Annotation>) => void;
}> = ({ annotation, isSelected, onSelect, onDelete, onEdit }) => {
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

  const typeConfig = {
    [AnnotationType.DELETION]: {
      label: 'Delete',
      color: 'text-destructive',
      bg: 'bg-destructive/10',
      icon: (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      )
    },
    [AnnotationType.COMMENT]: {
      label: 'Comment',
      color: 'text-accent',
      bg: 'bg-accent/10',
      icon: (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
        </svg>
      )
    },
    [AnnotationType.GLOBAL_COMMENT]: {
      label: 'Global',
      color: 'text-secondary',
      bg: 'bg-secondary/10',
      icon: (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
        </svg>
      )
    }
  };

  // Fallback for unknown types (forward compatibility)
  const config = typeConfig[annotation.type] || {
    label: 'Note',
    color: 'text-muted-foreground',
    bg: 'bg-muted/50',
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    )
  };

  return (
    <div
      data-annotation-id={annotation.id}
      onClick={onSelect}
      className={`
        group relative p-2.5 rounded-lg border cursor-pointer transition-all
        ${isSelected
          ? 'bg-primary/5 border-primary/30 shadow-sm'
          : 'border-transparent hover:bg-muted/50 hover:border-border/50'
        }
      `}
    >
      {/* Author */}
      {annotation.author && (
        <div className={`flex items-center gap-1.5 text-[10px] font-mono truncate mb-1.5 ${isCurrentUser(annotation.author) ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
          <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          <span className="truncate">{annotation.author}{isCurrentUser(annotation.author) && ' (me)'}</span>
        </div>
      )}

      {/* Type Badge + Timestamp + Actions */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 ${config.color}`}>
            <span className={`p-1 rounded ${config.bg}`}>
              {config.icon}
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wide">
              {config.label}
            </span>
          </div>
          {annotation.diffContext && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">
              diff
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/50">
            {formatTimestamp(annotation.createdA)}
          </span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-all">
          {onEdit && annotation.type !== AnnotationType.DELETION && !isEditing && (
            <button
              onClick={handleStartEdit}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
              title="Edit annotation"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
          <button
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onDelete(); }}
            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
            title="Delete annotation"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Global Comment - show text directly */}
      {annotation.type === AnnotationType.GLOBAL_COMMENT ? (
        isEditing ? (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={editText}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditText(e.target.value)}
              onKeyDown={handleKeyDown}
              onClick={(e: React.MouseEvent<HTMLTextAreaElement>) => e.stopPropagation()}
              className="w-full text-xs text-foreground/90 pl-2 border-l-2 border-purple-500/50 bg-background border border-border rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
              rows={Math.min(editText.split('\n').length + 1, 8)}
            />
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>Press Cmd+Enter to save, Esc to cancel</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); handleSaveEdit(); }}
                className="px-2 py-1 text-[10px] font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Save
              </button>
              <button
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); handleCancelEdit(); }}
                className="px-2 py-1 text-[10px] font-medium rounded bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-foreground/90 pl-2 border-l-2 border-purple-500/50 whitespace-pre-wrap">
            {annotation.text}
          </div>
        )
      ) : (
        <>
          {/* Original Text */}
          <div className="text-[11px] font-mono text-muted-foreground bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap max-h-24 overflow-y-auto">
            "{annotation.originalText}"
          </div>

          {/* Comment/Replacement Text */}
          {annotation.type !== AnnotationType.DELETION && (
            isEditing ? (
              <div className="mt-2 space-y-2">
                <textarea
                  ref={textareaRef}
                  value={editText}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onClick={(e: React.MouseEvent<HTMLTextAreaElement>) => e.stopPropagation()}
                  className="w-full text-xs text-foreground/90 pl-2 border-l-2 border-primary/50 bg-background border border-border rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                  rows={Math.min(editText.split('\n').length + 1, 8)}
                />
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>Press Cmd+Enter to save, Esc to cancel</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); handleSaveEdit(); }}
                    className="px-2 py-1 text-[10px] font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); handleCancelEdit(); }}
                    className="px-2 py-1 text-[10px] font-medium rounded bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              annotation.text && (
                <div className="mt-2 text-xs text-foreground/90 pl-2 border-l-2 border-primary/50 whitespace-pre-wrap">
                  {annotation.text}
                </div>
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
  onSelect: () => void;
  onDelete: () => void;
  onEdit?: (updates: Partial<CodeAnnotation>) => void;
}> = ({ annotation, isSelected, onSelect, onDelete, onEdit }) => {
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

  return (
    <div
      data-annotation-id={annotation.id}
      onClick={onSelect}
      className={`group relative p-2.5 rounded-lg border cursor-pointer transition-all ${
        isSelected
          ? 'bg-primary/5 border-primary/30 shadow-sm'
          : 'border-transparent hover:bg-muted/50 hover:border-border/50'
      }`}
    >
      {annotation.author && (
        <div className={`flex items-center gap-1.5 text-[10px] font-mono truncate mb-1.5 ${isCurrentUser(annotation.author) ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
          <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          <span className="truncate">{annotation.author}{isCurrentUser(annotation.author) && ' (me)'}</span>
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <div className="min-w-0 flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-primary">
            <span className="p-1 rounded bg-primary/10">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wide">Code</span>
          </div>
          <span className="text-[10px] text-muted-foreground/50">{formatTimestamp(annotation.createdAt)}</span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-all">
          {onEdit && !isEditing && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
              }}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
              title="Edit annotation"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
            title="Delete annotation"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="text-[11px] font-mono text-muted-foreground bg-muted/50 rounded px-2 py-1.5 truncate" title={annotation.filePath}>
        {fileName} · {lineRange}
      </div>

      {annotation.originalCode && (
        <div className="mt-1.5 text-[11px] font-mono text-muted-foreground bg-muted/30 rounded px-2 py-1.5 whitespace-pre-wrap max-h-24 overflow-y-auto">
          {annotation.originalCode}
        </div>
      )}

      {isEditing ? (
        <div className="mt-2 space-y-2">
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
                setIsEditing(false);
                setEditText(annotation.text || '');
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full text-xs text-foreground/90 pl-2 border-l-2 border-primary/50 bg-background border border-border rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
            rows={Math.min(editText.split('\n').length + 1, 8)}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleSaveEdit();
              }}
              className="px-2 py-1 text-[10px] font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Save
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(false);
                setEditText(annotation.text || '');
              }}
              className="px-2 py-1 text-[10px] font-medium rounded bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        annotation.text && (
          <div className="mt-2 text-xs text-foreground/90 pl-2 border-l-2 border-primary/50 whitespace-pre-wrap">
            {annotation.text}
          </div>
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
