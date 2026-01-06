import React, { useState } from 'react';
import { Annotation, AnnotationType, Block } from '../types';
import { isCurrentUser } from '../utils/identity';
import { ImageThumbnail } from './ImageThumbnail';

interface PanelProps {
  isOpen: boolean;
  annotations: Annotation[];
  blocks: Block[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  selectedId: string | null;
  shareUrl?: string;
}

export const AnnotationPanel: React.FC<PanelProps> = ({
  isOpen,
  annotations,
  blocks,
  onSelect,
  onDelete,
  selectedId,
  shareUrl
}) => {
  const [copied, setCopied] = useState(false);
  const sortedAnnotations = [...annotations].sort((a, b) => a.createdA - b.createdA);

  const handleQuickShare = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  if (!isOpen) return null;

  return (
    <aside className="w-72 border-l border-border/50 bg-card/30 backdrop-blur-sm flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border/50">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Annotations
          </h2>
          <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
            {annotations.length}
          </span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {sortedAnnotations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-center px-4">
            <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-3">
              <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </div>
            <p className="text-xs text-muted-foreground">
              Select text to add annotations
            </p>
          </div>
        ) : (
          sortedAnnotations.map(ann => (
            <AnnotationCard
              key={ann.id}
              annotation={ann}
              isSelected={selectedId === ann.id}
              onSelect={() => onSelect(ann.id)}
              onDelete={() => onDelete(ann.id)}
            />
          ))
        )}
      </div>

      {/* Quick Share Footer */}
      {shareUrl && annotations.length > 0 && (
        <div className="p-2 border-t border-border/50">
          <button
            onClick={handleQuickShare}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all text-muted-foreground hover:text-foreground hover:bg-muted/50"
          >
            {copied ? (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                Quick Share
              </>
            )}
          </button>
        </div>
      )}
    </aside>
  );
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
}> = ({ annotation, isSelected, onSelect, onDelete }) => {
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
    [AnnotationType.INSERTION]: {
      label: 'Insert',
      color: 'text-secondary',
      bg: 'bg-secondary/10',
      icon: (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      )
    },
    [AnnotationType.REPLACEMENT]: {
      label: 'Replace',
      color: 'text-primary',
      bg: 'bg-primary/10',
      icon: (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
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
      color: 'text-purple-500',
      bg: 'bg-purple-500/10',
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

      {/* Type Badge + Timestamp + Delete */}
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
          <span className="text-[10px] text-muted-foreground/50">
            {formatTimestamp(annotation.createdA)}
          </span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Global Comment - show text directly */}
      {annotation.type === AnnotationType.GLOBAL_COMMENT ? (
        <div className="text-xs text-foreground/90 pl-2 border-l-2 border-purple-500/50 whitespace-pre-wrap">
          {annotation.text}
        </div>
      ) : (
        <>
          {/* Original Text */}
          <div className="text-[11px] font-mono text-muted-foreground bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap max-h-24 overflow-y-auto">
            "{annotation.originalText}"
          </div>

          {/* Comment/Replacement Text */}
          {annotation.text && annotation.type !== AnnotationType.DELETION && (
            <div className="mt-2 text-xs text-foreground/90 pl-2 border-l-2 border-primary/50 whitespace-pre-wrap">
              {annotation.text}
            </div>
          )}
        </>
      )}

      {/* Attached Images */}
      {annotation.imagePaths && annotation.imagePaths.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {annotation.imagePaths.map((path, idx) => (
            <ImageThumbnail
              key={idx}
              path={path}
              size="sm"
              showRemove={false}
            />
          ))}
        </div>
      )}
    </div>
  );
};
