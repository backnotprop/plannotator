import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { sanitizeBlockHtml } from '@plannotator/ui/utils/sanitizeHtml';
import { CommentMeta } from './CommentMeta';
import { CommentActions } from './CommentActions';
import { FileNameChip } from './FileNameChip';
import { commentCopyText } from '../utils/annotationDisplay';

interface FileCommentBannerProps {
  /** File-scoped comments for ONE file (already filtered to scope === 'file'). */
  comments: CodeAnnotation[];
  selectedAnnotationId: string | null;
  onSelect: (id: string | null) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  /** Re-measure hook for the virtualized all-files host (see FileCommentCard). */
  onHeightChange?: () => void;
}

/** First non-empty line of the comment, used as the collapsed one-line preview. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.replace(/^#+\s*/, '').replace(/[*_`>]/g, '');
  }
  return text.trim();
}

/**
 * A single file-scoped comment card. Exported so the all-files view can render
 * it directly inside Pierre's annotation slot (the header-prefix slot is
 * suppressed whenever a custom header is present), while the single-file viewer
 * renders a stack of them in {@link FileCommentBanner}.
 */
export const FileCommentCard: React.FC<{
  comment: CodeAnnotation;
  isSelected: boolean;
  onSelect: (id: string | null) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  /** Fired after our rendered height changes (expand/collapse/edit) so the
   *  virtualized all-files host can re-measure this item. */
  onHeightChange?: () => void;
}> = ({ comment, isSelected, onSelect, onEdit, onDelete, onHeightChange }) => {
  // Default expanded (the comment IS the point of a guided review); the toggle
  // lets a reviewer collapse a long note back to one line to reach the hunks.
  const [collapsed, setCollapsed] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text ?? '');

  // Tell the owner to re-measure when our height changes — in the all-files view
  // these cards live in Pierre's custom-header portal, whose height isn't auto-
  // observed; without this, expanding/editing overlaps the content below.
  const mounted = useRef(false);
  // Layout effect (before paint) so the re-measure lands without a one-frame
  // overlap when the card grows/shrinks.
  useLayoutEffect(() => {
    if (mounted.current) onHeightChange?.();
    else mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, isEditing]);

  const html = useMemo(
    () => (comment.text ? sanitizeBlockHtml(comment.text) : ''),
    [comment.text],
  );

  const saveEdit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== comment.text) onEdit(comment.id, trimmed);
    setIsEditing(false);
  };

  return (
    <div
      className={`review-comment group${isSelected ? ' is-selected' : ''}`}
      data-annotation-id={comment.id}
      onClick={() => onSelect(comment.id)}
    >
      <CommentMeta
        leading={
          <>
            {/* Collapse toggle — always visible (primary affordance for reclaiming
                space from a long comment), unlike the hover-revealed actions. */}
            <button
              className="flex-none -ml-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
              title={collapsed ? 'Expand comment' : 'Collapse comment'}
            >
              <svg className={`w-3.5 h-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <FileNameChip path={comment.filePath} />
          </>
        }
        conventionalLabel={comment.conventionalLabel}
        decorations={comment.decorations}
        reviewProfileLabel={comment.reviewProfileLabel}
        source={comment.source}
        author={comment.author}
        createdAt={comment.createdAt}
      />

      {isEditing ? (
        <div className="mt-1" onClick={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); setIsEditing(false); }
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); }
            }}
            className="w-full min-h-[80px] resize-y rounded border border-border bg-background p-2 text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/40"
            placeholder="File comment (markdown supported)…"
          />
          <div className="mt-1 flex items-center justify-end gap-2">
            <button className="text-xs px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted" onClick={() => setIsEditing(false)}>
              Cancel
            </button>
            <button className="text-xs px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25" onClick={saveEdit}>
              Save
            </button>
          </div>
        </div>
      ) : comment.text ? (
        collapsed ? (
          <div className="review-comment-body truncate text-muted-foreground/80">{firstLine(comment.text)}</div>
        ) : (
          <div className="review-comment-body ai-markdown max-h-[220px] overflow-y-auto" dangerouslySetInnerHTML={{ __html: html }} />
        )
      ) : null}
      {!isEditing && (
        <CommentActions
          onEdit={() => { setDraft(comment.text ?? ''); setIsEditing(true); setCollapsed(false); }}
          copyText={comment.text ? commentCopyText(comment) : undefined}
          onDelete={() => onDelete(comment.id)}
        />
      )}
    </div>
  );
};

/**
 * Renders a file's file-scoped comments directly below the file path, above the
 * diff hunks. Long comments stay fully visible (no truncation) but can be
 * collapsed per-comment. Used in both the single-file viewer (plain React tree)
 * and the all-files view (Pierre's `renderHeaderPrefix` portal slot).
 */
export const FileCommentBanner: React.FC<FileCommentBannerProps> = ({
  comments,
  selectedAnnotationId,
  onSelect,
  onEdit,
  onDelete,
  onHeightChange,
}) => {
  if (comments.length === 0) return null;
  return (
    <div className="file-comment-banner flex flex-col px-4 pt-1 pb-1">
      {comments.map((comment) => (
        <FileCommentCard
          key={comment.id}
          comment={comment}
          isSelected={selectedAnnotationId === comment.id}
          onSelect={onSelect}
          onEdit={onEdit}
          onDelete={onDelete}
          onHeightChange={onHeightChange}
        />
      ))}
    </div>
  );
};
