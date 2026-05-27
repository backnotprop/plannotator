import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import type { PRContext, PRComment, PRReview, PRReviewThread } from '@plannotator/shared/pr-types';
import { MarkdownBody } from './PRSummaryTab';
import { CopyButton } from './CopyButton';
import { DiffHunkPreview } from './DiffHunkPreview';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PRCommentsTabProps {
  context: PRContext;
  platformUser?: string | null;
}

type TimelineEntry =
  | { kind: 'comment'; data: PRComment }
  | { kind: 'review'; data: PRReview }
  | { kind: 'thread'; data: PRReviewThread };

const REVIEW_STATE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  APPROVED: { bg: 'bg-success/15', text: 'text-success', label: 'Approved' },
  CHANGES_REQUESTED: { bg: 'bg-destructive/15', text: 'text-destructive', label: 'Changes Requested' },
  COMMENTED: { bg: 'bg-muted', text: 'text-muted-foreground', label: 'Commented' },
  DISMISSED: { bg: 'bg-muted', text: 'text-muted-foreground/60', label: 'Dismissed' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getEntryTime(entry: TimelineEntry): string {
  if (entry.kind === 'comment') return entry.data.createdAt;
  if (entry.kind === 'review') return entry.data.submittedAt;
  return entry.data.comments[0]?.createdAt ?? '';
}

function getEntryAuthor(entry: TimelineEntry): string {
  if (entry.kind === 'thread') return entry.data.comments[0]?.author ?? '';
  return entry.data.author;
}

function getEntryBody(entry: TimelineEntry): string {
  if (entry.kind === 'thread') return entry.data.comments.map((c) => c.body).join(' ');
  return entry.data.body;
}

function matchesSearch(entry: TimelineEntry, query: string): boolean {
  const q = query.toLowerCase();
  const author = getEntryAuthor(entry).toLowerCase();
  const body = getEntryBody(entry).toLowerCase();
  if (entry.kind === 'thread') {
    return author.includes(q) || body.includes(q) || entry.data.path.toLowerCase().includes(q);
  }
  return author.includes(q) || body.includes(q);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PRCommentsTab: React.FC<PRCommentsTabProps> = React.memo(({ context, platformUser }) => {
  // --- State ---
  const [searchQuery, setSearchQuery] = useState('');
  const [sortNewestFirst, setSortNewestFirst] = useState(false);
  const [hideResolved, setHideResolved] = useState(false);
  const [hideOutdated, setHideOutdated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [excludedAuthors, setExcludedAuthors] = useState<Set<string>>(new Set());

  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // --- Data pipeline ---
  const baseTimeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [
      ...context.comments.map((c): TimelineEntry => ({ kind: 'comment', data: c })),
      ...context.reviews
        .filter((r) => r.state !== 'COMMENTED' || r.body)
        .map((r): TimelineEntry => ({ kind: 'review', data: r })),
      ...(context.reviewThreads ?? [])
        .filter((t) => t.comments.length > 0)
        .map((t): TimelineEntry => ({ kind: 'thread', data: t })),
    ];
    entries.sort((a, b) => new Date(getEntryTime(a)).getTime() - new Date(getEntryTime(b)).getTime());
    return entries;
  }, [context.comments, context.reviews, context.reviewThreads]);

  const uniqueAuthors = useMemo(
    () => [...new Set(baseTimeline.map((e) => getEntryAuthor(e)).filter(Boolean))].sort(),
    [baseTimeline],
  );

  const filteredTimeline = useMemo(() => {
    let result = baseTimeline;
    if (hideResolved) {
      result = result.filter((e) => e.kind !== 'thread' || !e.data.isResolved);
    }
    if (hideOutdated) {
      result = result.filter((e) => e.kind !== 'thread' || !e.data.isOutdated);
    }
    if (excludedAuthors.size > 0) {
      result = result.filter((e) => !excludedAuthors.has(getEntryAuthor(e)));
    }
    if (searchQuery.trim()) {
      result = result.filter((e) => matchesSearch(e, searchQuery.trim()));
    }
    return result;
  }, [baseTimeline, searchQuery, excludedAuthors, hideResolved, hideOutdated]);

  const displayTimeline = useMemo(
    () => sortNewestFirst ? [...filteredTimeline].reverse() : filteredTimeline,
    [filteredTimeline, sortNewestFirst],
  );

  // --- Scroll to selected ---
  useEffect(() => {
    if (!selectedId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-comment-id="${CSS.escape(selectedId)}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selectedId]);

  // --- Keyboard ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+Shift+F → focus search
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // --- Collapse helpers ---
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsedIds(new Set(displayTimeline.map((e) => e.data.id)));
  }, [displayTimeline]);

  const expandAll = useCallback(() => setCollapsedIds(new Set()), []);

  // --- Search input keyboard ---
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (searchQuery) {
        setSearchQuery('');
      } else {
        (e.target as HTMLInputElement).blur();
      }
      e.stopPropagation();
    }
  }, [searchQuery]);

  // --- Clear all filters ---
  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setExcludedAuthors(new Set());
    setHideResolved(false);
    setHideOutdated(false);
  }, []);

  // --- Empty state (no comments at all) ---
  if (baseTimeline.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-8">
        <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-3">
          <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </div>
        <p className="text-xs text-muted-foreground">No comments on this PR.</p>
      </div>
    );
  }

  const hasFilters = !!searchQuery.trim() || excludedAuthors.size > 0 || hideResolved || hideOutdated;

  return (
    <div ref={containerRef} className="h-full flex flex-col">
      {/* ── Toolbar ── */}
      <div className="flex-shrink-0 bg-background border-b border-border/30 px-8 py-2 space-y-2">
        {/* Search */}
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search comments..."
            className="w-full pl-8 py-1.5 pr-20 bg-muted rounded text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
            {searchQuery.trim() && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {filteredTimeline.length} of {baseTimeline.length}
              </span>
            )}
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Controls row */}
        <div className="flex items-center justify-between gap-2">
          {/* Author pills — click to exclude, click again to re-include */}
          <div className="flex items-center gap-1 overflow-x-auto min-w-0">
            {excludedAuthors.size > 0 && (
              <button
                onClick={() => setExcludedAuthors(new Set())}
                className="text-[10px] px-1.5 py-0.5 rounded text-primary hover:underline whitespace-nowrap"
              >
                Show all
              </button>
            )}
            {uniqueAuthors.map((author) => (
              <AuthorPill
                key={author}
                label={author === platformUser ? `${author} (you)` : author}
                excluded={excludedAuthors.has(author)}
                onClick={() => {
                  setExcludedAuthors((prev) => {
                    const next = new Set(prev);
                    if (next.has(author)) next.delete(author); else next.add(author);
                    return next;
                  });
                }}
              />
            ))}
          </div>

          {/* Filter + sort + collapse controls */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setHideResolved((v) => !v)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${hideResolved ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
              title={hideResolved ? 'Show resolved threads' : 'Hide resolved threads'}
            >
              Resolved
            </button>
            <button
              onClick={() => setHideOutdated((v) => !v)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${hideOutdated ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
              title={hideOutdated ? 'Show outdated threads' : 'Hide outdated threads'}
            >
              Outdated
            </button>
            <div className="w-px h-3 bg-border/30 mx-0.5" />
            <button
              onClick={() => setSortNewestFirst((v) => !v)}
              className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              {sortNewestFirst ? 'Newest' : 'Oldest'}
            </button>
            <button onClick={collapseAll} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors" title="Collapse all">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 14h16M4 10h16" />
              </svg>
            </button>
            <button onClick={expandAll} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors" title="Expand all">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Timeline ── */}
      <OverlayScrollArea className="flex-1 min-h-0">
      <div className="px-8 py-4">
        <div className="space-y-3 max-w-2xl">
        {displayTimeline.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-xs text-muted-foreground mb-2">No comments match your filters.</p>
            <button onClick={clearFilters} className="text-[10px] text-primary hover:underline">
              Clear filters
            </button>
          </div>
        ) : (
          displayTimeline.map((entry) => {
            const id = entry.data.id;
            const isSelected = selectedId === id;
            const isCollapsed = collapsedIds.has(id);

            if (entry.kind === 'thread') {
              return (
                <ThreadCard
                  key={id}
                  thread={entry.data}
                  isSelected={isSelected}
                  isCollapsed={isCollapsed}
                  onSelect={() => setSelectedId(isSelected ? null : id)}
                  onToggleCollapse={() => toggleCollapsed(id)}
                />
              );
            }

            const isReview = entry.kind === 'review';
            const review = isReview ? (entry.data as PRReview) : null;
            const style = review && review.state !== 'COMMENTED'
              ? (REVIEW_STATE_STYLES[review.state] ?? null)
              : null;

            return (
              <div
                key={id}
                data-comment-id={id}
                onClick={() => setSelectedId(isSelected ? null : id)}
                className={`group/card rounded bg-card border p-3 cursor-pointer transition-all duration-150 shadow-[0_1px_3px_rgba(0,0,0,0.06)] ${
                  isSelected
                    ? 'border-primary/20 bg-primary/5 ring-1 ring-primary/10'
                    : 'border-border/40 hover:shadow-[0_2px_6px_rgba(0,0,0,0.08)]'
                }`}
              >
                <div
                  className="flex items-center justify-between"
                  onClick={(e) => { e.stopPropagation(); toggleCollapsed(id); }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-semibold text-foreground truncate">
                      {entry.data.author || 'unknown'}
                    </span>
                    {style && (
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ${style.bg} ${style.text}`}>
                        {style.label}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelativeTime(getEntryTime(entry))}
                    </span>
                    <svg className={`w-3 h-3 text-muted-foreground/40 transition-transform duration-150 ${isCollapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {!isCollapsed && entry.data.body && (
                  <div className="mt-2 text-xs text-foreground/80 leading-relaxed review-comment-markdown">
                    <MarkdownBody markdown={entry.data.body} />
                  </div>
                )}

                {!isCollapsed && (
                  <CommentActions
                    url={entry.kind === 'comment' ? (entry.data as PRComment).url : (entry.data as PRReview).url}
                    body={entry.data.body}
                  />
                )}
              </div>
            );
          })
        )}
        </div>
      </div>
      </OverlayScrollArea>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function ThreadCard({ thread, isSelected, isCollapsed, onSelect, onToggleCollapse }: {
  thread: PRReviewThread;
  isSelected: boolean;
  isCollapsed: boolean;
  onSelect: () => void;
  onToggleCollapse: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const first = thread.comments[0];
  if (!first) return null;
  const replies = thread.comments.slice(1);
  const isDimmed = thread.isResolved || thread.isOutdated;
  const lineLabel = thread.startLine && thread.line && thread.startLine !== thread.line
    ? `L${thread.startLine}–${thread.line}`
    : thread.line ? `L${thread.line}` : '';

  return (
    <div
      data-comment-id={thread.id}
      onClick={onSelect}
      className={`group/card rounded border p-3 cursor-pointer transition-all duration-150 ${
        isDimmed ? 'bg-card/50 shadow-[0_1px_2px_rgba(0,0,0,0.03)]' : 'bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]'
      } ${
        isSelected
          ? 'border-primary/20 bg-primary/5 ring-1 ring-primary/10'
          : 'border-border/40 hover:shadow-[0_2px_6px_rgba(0,0,0,0.08)]'
      }`}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between"
        onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs font-semibold truncate ${thread.isResolved ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
            {first.author || 'unknown'}
          </span>
          {thread.isOutdated && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-warning/15 text-warning flex-shrink-0">
              Outdated
            </span>
          )}
          {thread.isResolved && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-success/15 text-success flex-shrink-0">
              Resolved
            </span>
          )}
          {thread.path && (
            <span className="text-[10px] font-mono text-muted-foreground truncate flex-shrink min-w-0">
              {thread.path.split('/').pop()}{lineLabel ? `:${lineLabel}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {replies.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {replies.length} repl{replies.length === 1 ? 'y' : 'ies'}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">
            {formatRelativeTime(first.createdAt)}
          </span>
          <svg className={`w-3 h-3 text-muted-foreground/40 transition-transform duration-150 ${isCollapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Body */}
      {!isCollapsed && (
        <>
          {/* Diff hunk */}
          {first.diffHunk && (
            <div className="mt-2">
              <DiffHunkPreview hunk={first.diffHunk} maxHeight={96} />
            </div>
          )}

          {/* First comment body — truncated with fade for resolved/outdated */}
          {first.body && (
            <div className={`relative mt-2 ${isDimmed && !isExpanded ? 'max-h-16 overflow-hidden' : ''}`}>
              <div className={`text-xs leading-relaxed review-comment-markdown ${isDimmed && !isExpanded ? 'text-muted-foreground' : 'text-foreground/80'}`}>
                <MarkdownBody markdown={first.body} />
              </div>
              {isDimmed && !isExpanded && (
                <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-card to-transparent pointer-events-none" />
              )}
            </div>
          )}

          {/* Expand button for dimmed threads */}
          {isDimmed && !isExpanded && (
            <button
              onClick={(e) => { e.stopPropagation(); setIsExpanded(true); }}
              className="mt-1 text-[10px] text-primary/70 hover:text-primary transition-colors"
            >
              Show full comment{replies.length > 0 ? ` + ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}` : ''}
            </button>
          )}

          {/* Replies — only shown when expanded or not dimmed */}
          {(!isDimmed || isExpanded) && replies.length > 0 && (
            <div className="mt-2 ml-4 space-y-2 border-l border-border/30 pl-3">
              {replies.map((reply) => (
                <div key={reply.id}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-semibold text-foreground">{reply.author}</span>
                    <span className="text-[10px] text-muted-foreground">{formatRelativeTime(reply.createdAt)}</span>
                  </div>
                  <div className="text-xs text-foreground/80 leading-relaxed review-comment-markdown">
                    <MarkdownBody markdown={reply.body} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <CommentActions url={first.url} body={first.body} />
        </>
      )}
    </div>
  );
}

function CommentActions({ url, body }: { url?: string; body: string }) {
  if (!url && !body) return null;

  return (
    <div className="mt-2 pt-2 border-t border-border/20 flex items-center justify-end gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity duration-100">
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted/30 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          {url.includes('gitlab') ? 'View on GitLab' : 'View on GitHub'}
        </a>
      )}
      <CopyButton text={body} variant="inline" label="Copy" />
    </div>
  );
}

function AuthorPill({ label, excluded, onClick }: { label: string; excluded: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap transition-colors ${
        excluded
          ? 'bg-muted/50 text-muted-foreground/40 line-through'
          : 'bg-muted text-muted-foreground hover:text-foreground'
      }`}
      title={excluded ? `Show ${label}` : `Hide ${label}`}
    >
      {label}
    </button>
  );
}
