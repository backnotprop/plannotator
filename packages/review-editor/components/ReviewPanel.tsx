import React, { useState } from 'react';
import { CodeAnnotation } from '@plannotator/ui/types';
import { isCurrentUser } from '@plannotator/ui/utils/identity';

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
}

interface ReviewPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  annotations: CodeAnnotation[];
  files: DiffFile[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
  onAddGlobalComment?: (text: string) => void;
  feedbackMarkdown?: string;
}

// Sentinel for global comments
const GLOBAL_FILE_PATH = '__global__';

function isGlobalAnnotation(ann: CodeAnnotation): boolean {
  return ann.filePath === GLOBAL_FILE_PATH;
}

function isFileAnnotation(ann: CodeAnnotation): boolean {
  return ann.filePath !== GLOBAL_FILE_PATH && ann.lineStart === 0 && ann.lineEnd === 0;
}

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


export const ReviewPanel: React.FC<ReviewPanelProps> = ({
  isOpen,
  onToggle,
  annotations,
  files,
  selectedAnnotationId,
  onSelectAnnotation,
  onDeleteAnnotation,
  onAddGlobalComment,
  feedbackMarkdown,
}) => {
  const [copied, setCopied] = useState(false);
  const [globalCommentText, setGlobalCommentText] = useState('');

  const handleSubmitGlobalComment = () => {
    if (!globalCommentText.trim() || !onAddGlobalComment) return;
    onAddGlobalComment(globalCommentText.trim());
    setGlobalCommentText('');
  };

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
  // Separate and group annotations
  const { globalAnnotations, groupedAnnotations } = React.useMemo(() => {
    const global: CodeAnnotation[] = [];
    const grouped = new Map<string, CodeAnnotation[]>();

    for (const ann of annotations) {
      if (isGlobalAnnotation(ann)) {
        global.push(ann);
      } else {
        const existing = grouped.get(ann.filePath) || [];
        existing.push(ann);
        grouped.set(ann.filePath, existing);
      }
    }

    // Sort each group: file-level first (lineStart=0), then by line number
    for (const [, anns] of grouped) {
      anns.sort((a, b) => {
        const aIsFile = isFileAnnotation(a);
        const bIsFile = isFileAnnotation(b);
        if (aIsFile && !bIsFile) return -1;
        if (!aIsFile && bIsFile) return 1;
        return a.lineStart - b.lineStart;
      });
    }

    return { globalAnnotations: global, groupedAnnotations: grouped };
  }, [annotations]);

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

        {/* Global comment input */}
        {onAddGlobalComment && (
          <div className="p-2 border-b border-border/50">
            <div className="relative">
              <textarea
                value={globalCommentText}
                onChange={(e) => setGlobalCommentText(e.target.value)}
                placeholder="Add general feedback..."
                className="w-full px-2.5 py-2 bg-muted/50 rounded-lg text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary/50 min-h-[60px]"
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSubmitGlobalComment();
                  }
                }}
              />
              {globalCommentText.trim() && (
                <button
                  onClick={handleSubmitGlobalComment}
                  className="absolute bottom-2 right-2 px-2 py-1 rounded text-[10px] font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  Add
                </button>
              )}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {annotations.length === 0 ? (
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
              {/* Global comments section */}
              {globalAnnotations.length > 0 && (
                <div>
                  <div className="px-2 py-1 text-xs font-medium text-secondary flex items-center gap-1.5">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    General
                  </div>
                  <div className="space-y-1">
                    {globalAnnotations.map((annotation) => {
                      const isSelected = selectedAnnotationId === annotation.id;
                      return (
                        <div
                          key={annotation.id}
                          onClick={() => onSelectAnnotation(annotation.id)}
                          className={`group relative p-2.5 rounded-lg border-l-2 border-secondary/50 bg-secondary/5 cursor-pointer transition-all ${
                            isSelected ? 'ring-1 ring-secondary/30' : 'hover:bg-secondary/10'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            {annotation.author && (
                              <span className={`text-[10px] ${isCurrentUser(annotation.author) ? 'text-muted-foreground/50' : 'text-muted-foreground/70'}`}>
                                {annotation.author}{isCurrentUser(annotation.author) && ' (me)'}
                              </span>
                            )}
                            <span className="text-[10px] text-muted-foreground/50">
                              {formatTimestamp(annotation.createdAt)}
                            </span>
                          </div>
                          {annotation.text && (
                            <div className="text-xs text-foreground/80 line-clamp-3">
                              {annotation.text}
                            </div>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteAnnotation(annotation.id);
                            }}
                            className="absolute top-2 right-2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
                            title="Delete"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* File-grouped annotations */}
              {Array.from(groupedAnnotations.entries()).map(([filePath, fileAnnotations]) => (
                <div key={filePath}>
                  {/* File header */}
                  <div className="px-2 py-1 text-xs font-mono text-muted-foreground truncate">
                    {filePath.split('/').pop()}
                  </div>

                  {/* Annotations for this file */}
                  <div className="space-y-1">
                    {fileAnnotations.map((annotation) => {
                      const isSelected = selectedAnnotationId === annotation.id;
                      const isFile = isFileAnnotation(annotation);
                      return (
                        <div
                          key={annotation.id}
                          onClick={() => onSelectAnnotation(annotation.id)}
                          className={`group relative p-2.5 rounded-lg border cursor-pointer transition-all ${
                            isFile
                              ? `border-l-2 border-l-accent/50 ${isSelected ? 'bg-accent/5 ring-1 ring-accent/30' : 'border-transparent hover:bg-accent/5'}`
                              : isSelected
                                ? 'bg-primary/5 border-primary/30 shadow-sm'
                                : 'border-transparent hover:bg-muted/50 hover:border-border/50'
                          }`}
                        >
                          {/* Header: Line/File + Timestamp */}
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              {isFile ? (
                                <span className="text-[10px] font-medium text-accent flex items-center gap-1">
                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                  </svg>
                                  File
                                </span>
                              ) : (
                                <span className="text-[10px] font-mono text-muted-foreground">
                                  {annotation.lineStart === annotation.lineEnd
                                    ? `L${annotation.lineStart}`
                                    : `L${annotation.lineStart}-${annotation.lineEnd}`}
                                </span>
                              )}
                              {annotation.author && (
                                <span className={`text-[10px] truncate max-w-[80px] ${isCurrentUser(annotation.author) ? 'text-muted-foreground/50' : 'text-muted-foreground/70'}`}>
                                  {annotation.author}{isCurrentUser(annotation.author) && ' (me)'}
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] text-muted-foreground/50">
                              {formatTimestamp(annotation.createdAt)}
                            </span>
                          </div>

                          {/* Content */}
                          {annotation.text && (
                            <div className="text-xs text-foreground/80 line-clamp-2">
                              {annotation.text}
                            </div>
                          )}

                          {annotation.suggestedCode && (
                            <div className="mt-1 text-[10px] font-mono text-muted-foreground bg-muted/50 px-2 py-1 rounded truncate">
                              {annotation.suggestedCode.split('\n')[0]}...
                            </div>
                          )}

                          {/* Delete button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteAnnotation(annotation.id);
                            }}
                            className="absolute top-2 right-2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
                            title="Delete annotation"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick Copy Footer */}
        {feedbackMarkdown && annotations.length > 0 && (
          <div className="p-2 border-t border-border/50">
            <button
              onClick={handleQuickCopy}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all text-muted-foreground hover:text-foreground hover:bg-muted/50"
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
