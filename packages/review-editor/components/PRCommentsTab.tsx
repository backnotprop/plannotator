import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import type { PRContext, PRComment, PRReview, PRReviewThread } from '@plannotator/shared/pr-types';
import { MarkdownBody } from './MarkdownBody';
import { CopyButton } from './CopyButton';
import { DiffHunkPreview } from './DiffHunkPreview';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { getItem, setItem } from '@plannotator/ui/utils/storage';
import * as Popover from '@radix-ui/react-popover';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { useReviewState } from '../dock/ReviewStateContext';
import { Avatar } from './Avatar';

type AnnotateFn = (commentId: string, author: string, body: string, anchorEl: HTMLElement) => void;

const HIDE_BOTS_KEY = 'plannotator-pr-hide-bots';

/** Small muted "bot" tag shown next to automation-account authors. */
function BotTag() {
  return (
    <span className="shrink-0 text-[9px] uppercase tracking-wide font-semibold px-1 py-px rounded bg-muted text-muted-foreground/70">
      bot
    </span>
  );
}

/** Labeled on/off switch row for the Filters popover (checked = shown). */
function FilterSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="w-full flex items-center justify-between gap-2 px-1 py-1 group"
    >
      <span className="min-w-0 truncate text-xs text-foreground/90 group-hover:text-foreground transition-colors">{label}</span>
      <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted-foreground/25'}`}>
        <span className={`inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}

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

/** True when the entry's author is a bot (threads key off the first comment). */
function entryIsBot(entry: TimelineEntry): boolean {
  if (entry.kind === 'thread') return entry.data.comments[0]?.isBot === true;
  return entry.data.isBot === true;
}

/** Author avatar URL for the entry (threads key off the first comment). */
function getEntryAvatar(entry: TimelineEntry): string | undefined {
  if (entry.kind === 'thread') return entry.data.comments[0]?.avatarUrl;
  return entry.data.avatarUrl;
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
  const [hideBots, setHideBots] = useState(() => getItem(HIDE_BOTS_KEY) !== 'false'); // default on
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [excludedAuthors, setExcludedAuthors] = useState<Set<string>>(new Set());

  // Comment annotation: the "Annotate" button on a card opens one comment box.
  const { onAddCommentAnnotation, onAskAIForComment, commentScrollTarget } = useReviewState();
  const [annotating, setAnnotating] = useState<{ commentId: string; author: string; body: string; anchorEl: HTMLElement } | null>(null);
  const handleAnnotate = useCallback<AnnotateFn>((commentId, author, body, anchorEl) => {
    setAnnotating({ commentId, author, body, anchorEl });
  }, []);

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

  const hasBots = useMemo(() => baseTimeline.some(entryIsBot), [baseTimeline]);

  // Per-author filtering covers humans only; bots are toggled wholesale via the
  // "Bot comments" switch, so they don't clutter the author list.
  const humanAuthors = useMemo(
    () => [...new Set(
      baseTimeline
        .filter((e) => !entryIsBot(e))
        .map((e) => getEntryAuthor(e))
        .filter(Boolean),
    )].sort(),
    [baseTimeline],
  );

  const filteredTimeline = useMemo(() => {
    let result = baseTimeline;
    if (hideBots) {
      result = result.filter((e) => !entryIsBot(e));
    }
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
  }, [baseTimeline, searchQuery, excludedAuthors, hideResolved, hideOutdated, hideBots]);

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

  // --- Reveal a comment from the sidebar (clicking a "PR comment" annotation) ---
  // Select + un-collapse + scroll. The token bumps per click, so re-selecting the
  // same comment re-scrolls even though selectedId doesn't change.
  useEffect(() => {
    if (!commentScrollTarget) return;
    const { commentId } = commentScrollTarget;
    setSelectedId(commentId);
    setCollapsedIds(prev => {
      if (!prev.has(commentId)) return prev;
      const next = new Set(prev);
      next.delete(commentId);
      return next;
    });
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [commentScrollTarget]);

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

  const toggleHideBots = useCallback(() => {
    setHideBots((v) => {
      const next = !v;
      setItem(HIDE_BOTS_KEY, String(next));
      return next;
    });
  }, []);

  // --- Clear all filters ---
  // Resets the view transiently; does NOT persist hideBots (only the explicit
  // toggle changes the saved default), so a one-off "clear" can't permanently
  // disable bot-hiding for future PRs.
  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setExcludedAuthors(new Set());
    setHideResolved(false);
    setHideOutdated(false);
    setHideBots(false);
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

  // hideBots only counts as an active filter when the PR actually has bots —
  // otherwise the (default-on) bot filter is invisible (its toggle is hidden)
  // and effect-less, so it shouldn't show in the badge/count.
  const hasFilters = !!searchQuery.trim() || excludedAuthors.size > 0 || hideResolved || hideOutdated || (hasBots && hideBots);
  const activeFilterCount =
    excludedAuthors.size + (hasBots && hideBots ? 1 : 0) + (hideResolved ? 1 : 0) + (hideOutdated ? 1 : 0);
  const allCollapsed = displayTimeline.length > 0 && displayTimeline.every((e) => collapsedIds.has(e.data.id));

  return (
    <div ref={containerRef} className="h-full flex flex-col">
      {/* ── Toolbar ── search | filters | toggles on one row ── */}
      <div className="flex-shrink-0 bg-background border-b border-border/30 px-8 py-2">
        <div className="flex items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-0">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search comments..."
            className="w-full h-7 pl-8 pr-20 bg-muted rounded-md text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50"
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

          {/* Filters popover — show/hide categories + per-author toggles */}
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 h-7 px-2 text-xs rounded-md bg-muted text-muted-foreground hover:text-foreground transition-colors data-[state=open]:bg-background data-[state=open]:text-foreground data-[state=open]:shadow-sm"
                title="Filter comments"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h18M6 12h12M10 19h4" />
                </svg>
                Filters
                {activeFilterCount > 0 && (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-3.5 h-3.5 px-1 rounded-full bg-primary/20 text-primary text-[9px] font-semibold tabular-nums">
                    {activeFilterCount}
                  </span>
                )}
                <svg className="w-2.5 h-2.5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="start"
                sideOffset={6}
                className="z-50 w-56 bg-popover text-popover-foreground border border-border rounded-lg shadow-lg origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
              >
                <div className="p-2 space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 px-1">Show</div>
                  {hasBots && (
                    <FilterSwitch label="Bot comments" checked={!hideBots} onChange={toggleHideBots} />
                  )}
                  <FilterSwitch label="Resolved threads" checked={!hideResolved} onChange={() => setHideResolved((v) => !v)} />
                  <FilterSwitch label="Outdated threads" checked={!hideOutdated} onChange={() => setHideOutdated((v) => !v)} />

                  {humanAuthors.length > 0 && (
                    <>
                      <div className="border-t border-border/50 my-1" />
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Authors</span>
                        <div className="flex items-center gap-1.5 text-[10px]">
                          <button
                            type="button"
                            onClick={() => setExcludedAuthors(new Set())}
                            className="text-primary hover:underline"
                          >
                            All
                          </button>
                          <span className="text-muted-foreground/30">·</span>
                          <button
                            type="button"
                            onClick={() => setExcludedAuthors(new Set(humanAuthors))}
                            className="text-primary hover:underline"
                          >
                            None
                          </button>
                        </div>
                      </div>
                      <div className="max-h-44 overflow-y-auto pr-0.5">
                        {humanAuthors.map((author) => (
                          <FilterSwitch
                            key={author}
                            label={author === platformUser ? `${author} (you)` : author}
                            checked={!excludedAuthors.has(author)}
                            onChange={() => setExcludedAuthors((prev) => {
                              const next = new Set(prev);
                              if (next.has(author)) next.delete(author); else next.add(author);
                              return next;
                            })}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>

          {/* Sort + collapse */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setSortNewestFirst((v) => !v)}
              className="h-7 px-2 inline-flex items-center text-xs rounded-md bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              {sortNewestFirst ? 'Newest' : 'Oldest'}
            </button>
            <button
              onClick={() => allCollapsed ? expandAll() : collapseAll()}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={allCollapsed ? 'Expand all' : 'Collapse all'}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d={allCollapsed ? 'M4 6h16M4 12h16M4 18h16' : 'M4 14h16M4 10h16'} />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Timeline ── */}
      <OverlayScrollArea className="flex-1 min-h-0 scroll-fade">
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
                  onAnnotate={handleAnnotate}
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
                className={`group/card rounded-lg border bg-card px-3 py-2.5 cursor-pointer transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${
                  isSelected
                    ? 'border-primary/30 bg-primary/5 ring-1 ring-primary/10'
                    : 'border-border/40 hover:border-border/70'
                }`}
              >
                <div
                  className="flex items-center gap-2.5"
                  onClick={(e) => { e.stopPropagation(); toggleCollapsed(id); }}
                >
                  <Avatar src={getEntryAvatar(entry)} name={entry.data.author} />
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="text-[13px] font-semibold text-foreground truncate">
                      {entry.data.author || 'unknown'}
                    </span>
                    {entry.data.isBot && (
                      <BotTag />
                    )}
                    {style && (
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ${style.bg} ${style.text}`}>
                        {style.label}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {formatRelativeTime(getEntryTime(entry))}
                    </span>
                    <svg className={`w-3 h-3 text-muted-foreground/40 transition-transform duration-150 ${isCollapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {!isCollapsed && entry.data.body && (
                  <div className="mt-2 review-comment-markdown">
                    <MarkdownBody markdown={entry.data.body} textClassName="text-[13px]" />
                  </div>
                )}

                {!isCollapsed && (
                  <PRCommentLinkActions
                    url={entry.kind === 'comment' ? (entry.data as PRComment).url : (entry.data as PRReview).url}
                    body={entry.data.body}
                    commentId={id}
                    author={entry.data.author || 'unknown'}
                    onAnnotate={handleAnnotate}
                  />
                )}
              </div>
            );
          })
        )}
        </div>
      </div>
      </OverlayScrollArea>

      {annotating && (
        <CommentPopover
          anchorEl={annotating.anchorEl}
          contextText={annotating.body ? annotating.body.slice(0, 80) : `comment by ${annotating.author}`}
          isGlobal={false}
          allowImages={false}
          onSubmit={(text) => {
            onAddCommentAnnotation(annotating.commentId, annotating.author, annotating.body, text);
            setAnnotating(null);
          }}
          onClose={() => setAnnotating(null)}
          onAskAI={onAskAIForComment}
          askAIContext={{ kind: 'selection', label: 'PR comment', text: annotating.body }}
        />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function ThreadCard({ thread, isSelected, isCollapsed, onSelect, onToggleCollapse, onAnnotate }: {
  thread: PRReviewThread;
  isSelected: boolean;
  isCollapsed: boolean;
  onSelect: () => void;
  onToggleCollapse: () => void;
  onAnnotate: AnnotateFn;
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
      className={`group/card rounded-lg border px-3 py-2.5 cursor-pointer transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${
        isDimmed ? 'bg-card/50' : 'bg-card'
      } ${
        isSelected
          ? 'border-primary/30 bg-primary/5 ring-1 ring-primary/10'
          : 'border-border/40 hover:border-border/70'
      }`}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5"
        onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
      >
        <Avatar src={first.avatarUrl} name={first.author} />
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className={`text-[13px] font-semibold truncate ${thread.isResolved ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
            {first.author || 'unknown'}
          </span>
          {first.isBot && (
            <BotTag />
          )}
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
              <div className={`leading-relaxed review-comment-markdown ${isDimmed && !isExpanded ? 'text-muted-foreground' : 'text-foreground/85'}`}>
                <MarkdownBody markdown={first.body} textClassName="text-[13px]" />
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
            <div className="mt-2.5 ml-3 space-y-2.5 border-l border-border/30 pl-3">
              {replies.map((reply) => (
                <div key={reply.id}>
                  <div className="flex items-center gap-2 mb-1">
                    <Avatar src={reply.avatarUrl} name={reply.author} size={16} />
                    <span className="text-[11px] font-semibold text-foreground">{reply.author}</span>
                    {reply.isBot && (
                      <BotTag />
                    )}
                    <span className="text-[10px] text-muted-foreground">{formatRelativeTime(reply.createdAt)}</span>
                  </div>
                  <div className="pl-6 leading-relaxed review-comment-markdown text-foreground/85">
                    <MarkdownBody markdown={reply.body} textClassName="text-[13px]" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <PRCommentLinkActions
            url={first.url}
            body={first.body}
            commentId={thread.id}
            author={first.author || 'unknown'}
            onAnnotate={onAnnotate}
          />
        </>
      )}
    </div>
  );
}

function PRCommentLinkActions({ url, body, commentId, author, onAnnotate }: {
  url?: string;
  body: string;
  commentId?: string;
  author?: string;
  onAnnotate?: AnnotateFn;
}) {
  if (!url && !body && !onAnnotate) return null;

  return (
    <div className="mt-2 pt-2 border-t border-border/20 flex items-center justify-end gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity duration-100">
      {onAnnotate && commentId && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAnnotate(commentId, author || 'unknown', body, e.currentTarget); }}
          className="mr-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted/30 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-4l-4 4v-4z" />
          </svg>
          Annotate
        </button>
      )}
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
