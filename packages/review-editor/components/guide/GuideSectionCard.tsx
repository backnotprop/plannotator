import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { GuideSection } from '@plannotator/shared/guide';
import { renderMarkdownProse } from '../../utils/renderMarkdownProse';
import { useReviewState } from '../../dock/ReviewStateContext';
import { GuideDiffSection } from './GuideDiffSection';

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
        checked ? 'border-primary bg-primary' : 'border-border bg-transparent'
      }`}
    >
      {checked && (
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.25L4.75 8.5L9.5 3.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

/** Left-column file chip: name, directory, +/- counts. Clicking scrolls the
 *  matching diff card in the right column into view. */
function FileChip({
  file,
  additions,
  deletions,
  missing,
  onClick,
}: {
  file: string;
  additions?: number;
  deletions?: number;
  missing: boolean;
  onClick: () => void;
}) {
  const slash = file.lastIndexOf('/');
  const name = slash >= 0 ? file.slice(slash + 1) : file;
  const dir = slash >= 0 ? file.slice(0, slash) : '';
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-left transition-colors hover:border-border"
      title={file}
    >
      <span className="truncate font-mono text-[11px] font-medium text-foreground">{name}</span>
      {dir && <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/60">{dir}</span>}
      {missing ? (
        <span className="flex-shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50">outdated</span>
      ) : (
        <span className="ml-auto flex-shrink-0 font-mono text-[10px]">
          {additions !== undefined && additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>}
          {deletions !== undefined && deletions > 0 && (
            <span className="ml-1 text-red-600/80 dark:text-red-400/80">-{deletions}</span>
          )}
        </span>
      )}
    </button>
  );
}

interface GuideSectionCardProps {
  section: GuideSection;
  index: number;
  total: number;
  reviewed: boolean;
  onToggleReviewed: () => void;
  focusedFile: string | null;
  onFocusFile: (filePath: string) => void;
}

/**
 * One chapter of the guide, laid out as a two-column body: overview on the
 * left (title, position, Reviewed checkbox, prose, file chips), the section's
 * diffs on the right. Clicking a file chip scrolls its diff into view.
 *
 * Collapsing is independent of Reviewed: the chevron (or the collapsed row)
 * toggles it freely, while checking Reviewed also collapses by default.
 * `collapsedOverride` records an explicit user choice; null falls back to
 * "collapsed iff reviewed". Toggling Reviewed clears the override so the
 * default relationship resumes.
 */
export const GuideSectionCard: React.FC<GuideSectionCardProps> = ({
  section,
  index,
  total,
  reviewed,
  onToggleReviewed,
  focusedFile,
  onFocusFile,
}) => {
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
  const state = useReviewState();
  const diffElements = useRef(new Map<string, HTMLDivElement | null>());
  const position = `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  const isCollapsed = collapsedOverride ?? reviewed;

  // Reveal channel (state.guideRevealFile): a sidebar jump — annotation click
  // or AI line citation — targeted a file placed in THIS section while the
  // guide is open. Expand if collapsed (a reviewed section has no mounted
  // viewer, so the jump would otherwise silently no-op), focus the file so
  // the selection/AI history bind to it, then scroll its diff into view.
  // rAF: the expansion's mount commits first; the element exists by the next
  // frame. Keyed on the token so the same file can be revealed repeatedly;
  // only the (unique — first-placement-wins) containing card matches.
  const revealTarget =
    state.guideRevealFile && section.diffs.some((d) => d.file === state.guideRevealFile?.path)
      ? state.guideRevealFile
      : null;
  useEffect(() => {
    if (!revealTarget) return;
    setCollapsedOverride(false);
    onFocusFile(revealTarget.path);
    const raf = requestAnimationFrame(() => {
      diffElements.current.get(revealTarget.path)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(raf);
    // Token identifies the reveal event (it increments on every set), so it's
    // the only dependency that matters; path/handler churn must not re-fire it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget?.token]);

  const handleToggleReviewed = () => {
    setCollapsedOverride(null);
    onToggleReviewed();
  };

  if (isCollapsed) {
    // Two SIBLING buttons in a flex row, not a button nested inside a button:
    // the previous markup put a clickable checkbox `<span onClick>` inside
    // the row's `<button>`, which is both invalid HTML (interactive-in-
    // interactive) and unreachable by keyboard/screen reader as its own
    // control. Same visual result, valid semantics, both independently
    // focusable and operable with Enter/Space.
    return (
      <div className="flex w-full items-center gap-3 rounded-lg border border-border/50 bg-muted/10 px-4 py-3">
        <button
          type="button"
          onClick={handleToggleReviewed}
          aria-label={reviewed ? 'Un-mark as reviewed' : 'Mark as reviewed'}
          className="flex-shrink-0 rounded"
        >
          <Checkbox checked={reviewed} />
        </button>
        <button
          type="button"
          onClick={() => setCollapsedOverride(false)}
          className="group flex min-w-0 flex-1 items-center gap-3 text-left"
          title="Expand"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/70">{section.title}</span>
          <span className="flex-shrink-0 text-[11px] text-muted-foreground/60">
            {section.diffs.length} diff{section.diffs.length !== 1 ? 's' : ''}
            {reviewed ? ' · reviewed' : ''}
          </span>
          <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground/40">{position}</span>
          <ChevronDown className="flex-shrink-0 -rotate-90 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground" size={13} />
        </button>
      </div>
    );
  }

  return (
    // overflow-CLIP, not overflow-hidden: both clip the rounded corners, but
    // hidden makes this card a (non-scrolling) scroll container, which silently
    // breaks the left column's position:sticky below — sticky binds to the
    // nearest scroll container, and a box that never scrolls never sticks.
    // clip clips paint only, so sticky binds to the guide page's scroller.
    <div className="overflow-clip rounded-lg border border-border/50 bg-card">
      <div className="md:grid md:grid-cols-[440px_minmax(0,1fr)]">
        {/* Left column: overview. The cell spans the full row height (grid
            stretch) so its border-r runs the card's height; the CONTENT is
            sticky within the cell — it pins near the top of the page scroller
            while this section's diffs scroll, then is pushed out naturally by
            the cell's bottom edge as the next chapter arrives. md+ only: the
            stacked mobile layout must not pin prose over the diffs. */}
        <div className="border-b border-border/40 md:border-b-0 md:border-r">
          {/* Capped at the visible height (48px offset ≈ the app header above
              the page scroller) and laid out as a flex column so that when the
              cap bites, ONLY the file list shrinks and scrolls internally —
              title, meta, and prose stay fixed (md:flex-none). The outer
              overflow-y-auto is a graceful fallback for the rare section whose
              prose ALONE exceeds the viewport: then the whole column scrolls.
              overflow-x-hidden matters: per spec, overflow-y:auto forces the
              computed overflow-x to auto too, which grew a horizontal
              scrollbar here. Vertical scroll only. */}
          <div className="px-6 py-5 md:sticky md:top-0 md:flex md:max-h-[calc(100dvh-48px)] md:flex-col md:overflow-y-auto md:overflow-x-hidden">
          <div className="flex items-start gap-2 md:flex-none">
            <h3 className="flex-1 text-[15px] font-semibold leading-snug text-foreground [text-wrap:balance]">
              {section.title}
            </h3>
            <button
              type="button"
              onClick={() => setCollapsedOverride(true)}
              className="mt-0.5 flex-shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-foreground"
              title="Collapse section"
            >
              <ChevronDown className="rotate-180" size={13} />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3 md:flex-none">
            <span className="font-mono text-[11px] text-muted-foreground/60">{position}</span>
            <button
              type="button"
              onClick={handleToggleReviewed}
              className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
              title={reviewed ? 'Un-mark as reviewed' : 'Mark as reviewed'}
            >
              <Checkbox checked={reviewed} />
              Reviewed
            </button>
          </div>

          {section.overview && (
            <div className="mt-3.5 space-y-2.5 md:flex-none">{renderMarkdownProse(section.overview, { tone: 'muted' })}</div>
          )}

          {/* The one shrinkable region: when the sticky column hits its height
              cap, this list scrolls internally (min-h floor keeps a few chips
              visible) while everything above stays put. */}
          {section.diffs.length > 0 && (
            <div className="mt-5 space-y-1.5 md:min-h-[84px] md:overflow-y-auto md:overflow-x-hidden">
              {section.diffs.map((ref) => {
                const file = state.files.find((f) => f.path === ref.file);
                return (
                  <FileChip
                    key={ref.file}
                    file={ref.file}
                    additions={file?.additions}
                    deletions={file?.deletions}
                    missing={!file}
                    onClick={() => {
                      // Retarget the guide's focus arbiter too: scrolling under
                      // a stationary pointer fires no pointerenter, so without
                      // this the annotation toolbar / pending selection / AI
                      // history stay bound to the previously-focused diff.
                      if (file) onFocusFile(ref.file);
                      diffElements.current.get(ref.file)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  />
                );
              })}
            </div>
          )}
          </div>
        </div>

        {/* Right column: the diffs themselves */}
        {section.diffs.length > 0 && (
          <div className="min-w-0 space-y-4 bg-muted/[0.07] px-4 py-4">
            {section.diffs.map((diffRef) => (
              <div
                key={diffRef.file}
                ref={(el) => {
                  diffElements.current.set(diffRef.file, el);
                }}
                className="scroll-mt-4"
              >
                <GuideDiffSection
                  diffRef={diffRef}
                  isFocused={focusedFile === diffRef.file}
                  onFocus={() => onFocusFile(diffRef.file)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
