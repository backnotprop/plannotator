import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, MotionConfig, type Variants } from 'motion/react';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { useTourData } from '../../hooks/tour/useTourData';
import { useReviewState } from '../../dock/ReviewStateContext';
import { TourStopCard } from './TourStopCard';
import { QAChecklist } from './QAChecklist';
import type { TourKeyTakeaway } from '../../hooks/tour/useTourData';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Intro composition cascade — each piece springs into place after the dialog
// card lands, so the landing page composes itself rather than appearing all
// at once. Spring physics give natural settle, no cartoony bounce.
// ---------------------------------------------------------------------------

const introContainerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.12 } },
};

const introItemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 220, damping: 24 },
  },
};

const takeawayListVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
};

const takeawayRowVariants: Variants = {
  hidden: { opacity: 0, y: 4 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 240, damping: 26 },
  },
};

const startButtonVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 6 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 260, damping: 18 },
  },
};

// One-shot "spark of life" — color dot pulses once when its card lands.
const dotVariants: Variants = {
  hidden: { scale: 1 },
  visible: {
    scale: [1, 1.35, 1],
    transition: { duration: 0.45, times: [0, 0.5, 1], ease: 'easeOut' },
  },
};

// ---------------------------------------------------------------------------
// Key takeaways table
// ---------------------------------------------------------------------------

const severityLabel: Record<TourKeyTakeaway['severity'], string> = {
  info: 'Info',
  important: 'Important',
  warning: 'Warning',
};

const severityLabelClass: Record<TourKeyTakeaway['severity'], string> = {
  info: 'text-muted-foreground/70',
  important: 'text-primary/80 dark:text-primary',
  warning: 'text-warning/80 dark:text-warning',
};

const severityRowClass: Record<TourKeyTakeaway['severity'], string> = {
  info: '',
  important: 'bg-primary/[0.03] dark:bg-primary/[0.10]',
  warning: 'bg-warning/[0.03] dark:bg-warning/[0.10]',
};

function TakeawaysTable({ takeaways }: { takeaways: TourKeyTakeaway[] }) {
  if (takeaways.length === 0) return null;
  return (
    <motion.div
      className="mb-6 border border-border/20 dark:border-border/40 rounded-lg overflow-hidden text-[13px]"
      variants={takeawayListVariants}
    >
      <div className="px-4 py-2 border-b border-border/15 dark:border-border/30 bg-muted/10 dark:bg-muted/30">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Key takeaways
        </span>
      </div>
      {takeaways.map((t, i) => (
        <motion.div
          key={i}
          variants={takeawayRowVariants}
          className={`flex items-start gap-4 px-4 py-2.5 ${severityRowClass[t.severity]} ${
            i > 0 ? 'border-t border-border/10 dark:border-border/30' : ''
          }`}
        >
          <span className={`flex-shrink-0 w-24 text-[10px] font-semibold uppercase tracking-wider pt-1 ${severityLabelClass[t.severity]}`}>
            {severityLabel[t.severity]}
          </span>
          <span className="text-foreground leading-relaxed">{t.text}</span>
        </motion.div>
      ))}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Page types + animation helpers
// ---------------------------------------------------------------------------

type TourPage = 'intro' | 'stops' | 'checklist';
const PAGE_ORDER: TourPage[] = ['intro', 'stops', 'checklist'];
const PAGE_LABELS: Record<TourPage, string> = {
  intro: 'Overview',
  stops: 'Walkthrough',
  checklist: 'Checklist',
};

function getPageAnimClass(
  thisPage: TourPage,
  currentPage: TourPage,
  exitingPage: TourPage | null,
  slideDir: 'fwd' | 'bwd',
): string {
  if (exitingPage === thisPage) {
    if (thisPage === 'intro') return 'tour-intro-exit';
    return slideDir === 'fwd' ? 'tour-page-exit-fwd' : 'tour-page-exit-bwd';
  }
  if (currentPage === thisPage && exitingPage !== null) {
    if (thisPage === 'stops' && exitingPage === 'intro') return '';
    return slideDir === 'fwd' ? 'tour-page-enter-fwd' : 'tour-page-enter-bwd';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Dialog wrapper
// ---------------------------------------------------------------------------

interface TourDialogProps {
  jobId: string | null;
  onClose: () => void;
}

export const TourDialog: React.FC<TourDialogProps> = ({ jobId, onClose }) => {
  // Keep the last known jobId mounted while we play the exit animation
  const [renderedJobId, setRenderedJobId] = useState<string | null>(jobId);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (jobId) {
      setRenderedJobId(jobId);
      setClosing(false);
    } else if (renderedJobId) {
      // If reduced motion is on, the exit animation is suppressed and
      // onAnimationEnd will never fire — unmount immediately instead.
      if (prefersReducedMotion()) {
        setRenderedJobId(null);
        setClosing(false);
      } else {
        setClosing(true);
      }
    }
  }, [jobId, renderedJobId]);

  const requestClose = useCallback(() => { onClose(); }, [onClose]);

  // Escape to close
  useEffect(() => {
    if (!renderedJobId || closing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); requestClose(); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [renderedJobId, closing, requestClose]);

  const handleExitEnd = useCallback((e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    setRenderedJobId(null);
    setClosing(false);
  }, []);

  if (!renderedJobId) return null;

  return (
    <MotionConfig reducedMotion="user">
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-2 md:px-8 md:py-4" onClick={requestClose}>
        {/* Backdrop */}
        <div className={`absolute inset-0 bg-black/50 backdrop-blur-[2px] ${closing ? 'tour-dialog-overlay-closing' : 'tour-dialog-overlay'}`} />

        {/* Dialog card */}
        <div
          className={`relative z-10 w-full max-w-6xl h-full max-h-[96vh] bg-background rounded-2xl shadow-2xl border border-border/15 overflow-hidden flex flex-col ${closing ? 'tour-dialog-content-closing' : 'tour-dialog-content'}`}
          onClick={(e) => e.stopPropagation()}
          onAnimationEnd={closing ? handleExitEnd : undefined}
        >
          <TourDialogContent jobId={renderedJobId} onClose={requestClose} />
        </div>
      </div>
    </MotionConfig>
  );
};

// ---------------------------------------------------------------------------
// Dialog content — 3 navigable pages
// ---------------------------------------------------------------------------

function TourDialogContent({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const state = useReviewState();
  const { tour, loading, error, checked, toggleChecked, retry } = useTourData(jobId);
  const stopsRef = useRef<(HTMLDivElement | null)[]>([]);
  const stopsSeenRef = useRef(false);
  const walkthroughAutoOpenTriggered = useRef(false);
  const [openStops, setOpenStops] = useState<Set<number>>(() => new Set());

  // Single-open accordion: opening a new stop closes any other that was open.
  // Clicking the currently-open stop closes it.
  const toggleStop = useCallback((i: number) => {
    setOpenStops((prev) => {
      if (prev.has(i)) return new Set();
      return new Set([i]);
    });
  }, []);

  const [page, setPage] = useState<TourPage>('intro');
  const [exitingPage, setExitingPage] = useState<TourPage | null>(null);
  const [slideDir, setSlideDir] = useState<'fwd' | 'bwd'>('fwd');

  const navigate = useCallback((next: TourPage) => {
    if (exitingPage || next === page) return;
    // Reduced motion suppresses the page animations, so onAnimationEnd
    // never fires to clear exitingPage — swap immediately instead.
    if (prefersReducedMotion()) {
      setPage(next);
      return;
    }
    const fromIdx = PAGE_ORDER.indexOf(page);
    const toIdx = PAGE_ORDER.indexOf(next);
    setExitingPage(page);
    setSlideDir(toIdx > fromIdx ? 'fwd' : 'bwd');
    setPage(next);
  }, [page, exitingPage]);

  const handleSlideEnd = useCallback((exiting: TourPage) => {
    setExitingPage((prev) => (prev === exiting ? null : prev));
  }, []);

  const handleAnchorClick = useCallback((filePath: string) => {
    state.openDiffFile(filePath);
    onClose();
  }, [state.openDiffFile, onClose]);

  const handleScrollToStop = useCallback((index: number) => {
    const el = stopsRef.current[index];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Mark each page as "seen" after first mount. Gated on `tour` so it doesn't
  // flip the refs during the loading render (which would strip the first-time
  // animation classes before the page ever rendered).
  useEffect(() => {
    if (!tour) return;
    if (page === 'stops' || exitingPage === 'stops') stopsSeenRef.current = true;
  }, [page, exitingPage, tour]);

  // First-visit auto-open: when the user lands on the walkthrough page for the
  // first time, wait for the stops cascade to finish + a brief breath, then
  // pop the first accordion. The card itself plays its motion accordion
  // animation in response, so this slots into the natural reveal beat.
  useEffect(() => {
    if (!tour) return;
    if (page !== 'stops') return;
    if (walkthroughAutoOpenTriggered.current) return;
    walkthroughAutoOpenTriggered.current = true;

    const stopRevealMs = 280; // .tour-stop-reveal duration
    const stopStaggerMs = 60; // delay between stops
    const lastStopFinishesAt = stopRevealMs + (tour.stops.length - 1) * stopStaggerMs;
    const breath = 500;

    const t = setTimeout(() => setOpenStops(new Set([0])), lastStopFinishesAt + breath);
    return () => clearTimeout(t);
  }, [page, tour]);

  // All hooks must run before the early returns below (rules of hooks).
  // `tour` may still be null during loading, so access it safely — the
  // filter strips the empty values out anyway.
  const introCards = useMemo(
    () =>
      [
        { label: 'Intent', value: tour?.intent, dot: 'bg-primary/70' },
        { label: 'Before', value: tour?.before, dot: 'bg-warning/70' },
        { label: 'After', value: tour?.after, dot: 'bg-success/70' },
      ].filter((card) => card.value && card.value.trim()),
    [tour?.intent, tour?.before, tour?.after],
  );

  // Loading
  if (loading) {
    return (
      <>
        <div className="flex-shrink-0 flex items-center gap-3 px-6 py-4 border-b border-border/20">
          <div className="flex-1">
            <div className="h-4 w-56 bg-muted/30 animate-pulse rounded" />
            <div className="h-3 w-20 bg-muted/20 animate-pulse rounded mt-1.5" />
          </div>
        </div>
        <div className="flex-1 px-8 py-6 space-y-4">
          <div className="h-4 w-72 bg-muted/20 animate-pulse rounded" />
          <div className="grid grid-cols-2 gap-3">
            <div className="h-16 bg-muted/15 animate-pulse rounded-lg" />
            <div className="h-16 bg-muted/15 animate-pulse rounded-lg" />
          </div>
          <div className="h-24 bg-muted/15 animate-pulse rounded-lg" />
        </div>
      </>
    );
  }

  // Error
  if (error || !tour) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center px-8">
          <p className="text-sm text-muted-foreground">{error ?? 'Tour not found'}</p>
          <button onClick={retry} className="mt-3 text-xs text-primary hover:text-primary/80 transition-colors">Retry</button>
        </div>
      </div>
    );
  }

  const verifiedCount = checked.filter(Boolean).length;
  const checklistCount = tour.qa_checklist.length;
  const isActive = (p: TourPage) => page === p && !exitingPage;

  // Mark pages as "seen" the first time we mount them so we don't re-animate
  // the section heading + staggered cards on every back-and-forth navigation.
  const stopsAlreadySeen = stopsSeenRef.current;

  return (
    <>
      {/* Title bar + close */}
      <div className="flex-shrink-0 flex items-center gap-3 px-5 py-1.5 border-b border-border/20 dark:border-border/40">
        <h2 className="text-sm font-semibold tracking-tight text-foreground truncate flex-1 min-w-0">
          {tour.title}
        </h2>
        <button
          onClick={onClose}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground/70 hover:bg-muted/20 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Page nav tabs */}
      <div className="flex-shrink-0 flex items-center gap-1 px-5 py-1.5 border-b border-border/10 dark:border-border/30">
        {PAGE_ORDER.map((p) => (
          <button
            key={p}
            onClick={() => navigate(p)}
            disabled={isActive(p)}
            className={`text-[11px] font-medium px-3 py-1.5 rounded-md transition-colors ${
              isActive(p)
                ? 'text-foreground bg-muted/30 dark:bg-muted/60 cursor-default'
                : 'text-muted-foreground/60 dark:text-muted-foreground/70 hover:text-foreground/80 hover:bg-muted/10 dark:hover:bg-muted/30'
            }`}
          >
            {PAGE_LABELS[p]}
            {p === 'checklist' && checklistCount > 0 && (
              <span className="ml-1.5 text-[9px] font-mono text-muted-foreground/50">
                {verifiedCount}/{checklistCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Page container */}
      <div className="flex-1 relative overflow-hidden">

        {/* ── OVERVIEW ── */}
        {(page === 'intro' || exitingPage === 'intro') && (
          <div
            className={`absolute inset-0 z-10 ${getPageAnimClass('intro', page, exitingPage, slideDir)}`}
            onAnimationEnd={exitingPage === 'intro'
              ? (e: React.AnimationEvent) => { if (e.target === e.currentTarget) handleSlideEnd('intro'); }
              : undefined}
          >
            <motion.div
              className="h-full flex flex-col"
              initial="hidden"
              animate="visible"
              variants={introContainerVariants}
            >
              {/* Scrollable content area with a bottom fade so content disappears
                  cleanly under the pinned Start Tour button. */}
              <div className="relative flex-1 min-h-0">
                <OverlayScrollArea className="h-full">
                  <div className="px-8 py-6 pb-12 max-w-4xl mx-auto">
                    {tour.greeting && (
                      <motion.p
                        variants={introItemVariants}
                        className="text-sm text-foreground leading-relaxed mb-5"
                      >
                        {tour.greeting}
                      </motion.p>
                    )}

                    {/* Intent · Before · After trilogy — each card lands in turn,
                        its color dot doing a single "spark of life" pulse on land. */}
                    <motion.div
                      variants={introContainerVariants}
                      className="grid grid-cols-3 gap-3 mb-5 text-[13px]"
                    >
                      {introCards.map((card) => (
                        <motion.div
                          key={card.label}
                          variants={introItemVariants}
                          className="rounded-md bg-muted/30 dark:bg-muted/60 border border-border/60 px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.03)] dark:shadow-none"
                        >
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <motion.span
                              variants={dotVariants}
                              className={`w-1.5 h-1.5 rounded-full ${card.dot}`}
                            />
                            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                              {card.label}
                            </span>
                          </div>
                          <span className="text-foreground leading-relaxed">{card.value}</span>
                        </motion.div>
                      ))}
                    </motion.div>

                    <TakeawaysTable takeaways={tour.key_takeaways} />
                  </div>
                </OverlayScrollArea>

                {/* Bottom fade — content gracefully disappears under the pinned button */}
                <div
                  className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-background backdrop-blur-xl"
                  style={{
                    WebkitMaskImage: 'linear-gradient(to top, white, transparent)',
                    maskImage: 'linear-gradient(to top, white, transparent)',
                  }}
                />
              </div>

              {/* Pinned Start Tour button — always visible in the viewport */}
              {page === 'intro' && (
                <div className="flex-shrink-0 px-8 pb-5 pt-1 max-w-4xl mx-auto w-full">
                  <motion.button
                    variants={startButtonVariants}
                    onClick={() => navigate('stops')}
                    className="group w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-lg bg-primary/85 text-primary-foreground hover:bg-primary text-sm font-medium shadow-sm hover:shadow-md active:scale-[0.98] transition-[background-color,box-shadow,transform] duration-150 ease-out"
                  >
                    Start Tour
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
                      className="transition-transform duration-150 group-hover:translate-x-0.5">
                      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5"
                        strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </motion.button>
                </div>
              )}
            </motion.div>
          </div>
        )}

        {/* ── WALKTHROUGH — deferred until intro exit completes so staggered reveals don't flash behind it ── */}
        {(page === 'stops' || exitingPage === 'stops') && exitingPage !== 'intro' && (
          <div
            className={`absolute inset-0 ${getPageAnimClass('stops', page, exitingPage, slideDir)}`}
            onAnimationEnd={exitingPage === 'stops'
              ? (e: React.AnimationEvent) => { if (e.target === e.currentTarget) handleSlideEnd('stops'); }
              : undefined}
          >
            <OverlayScrollArea className="h-full">
              <div className="px-8 py-6 pb-16 max-w-4xl mx-auto">
                <div className="relative border-l border-border/15 dark:border-border/35 ml-2.5">
                  {tour.stops.map((stop, i) => (
                    <div
                      key={i}
                      ref={(el) => { stopsRef.current[i] = el; }}
                      className={stopsAlreadySeen ? '' : 'tour-stop-reveal'}
                      style={stopsAlreadySeen ? undefined : { animationDelay: `${i * 60}ms` }}
                    >
                      <TourStopCard
                        stop={stop}
                        index={i}
                        total={tour.stops.length}
                        onAnchorClick={handleAnchorClick}
                        open={openStops.has(i)}
                        onToggle={() => toggleStop(i)}
                        dimmed={openStops.size > 0 && !openStops.has(i)}
                      />
                    </div>
                  ))}
                </div>

                <div className="mt-8 pt-4 border-t border-border/15 dark:border-border/35 text-[10px] text-muted-foreground/50 flex items-center justify-between">
                  <span>{tour.stops.length} stop{tour.stops.length !== 1 ? 's' : ''}</span>
                  {checklistCount > 0 && (
                    <button onClick={() => navigate('checklist')}
                      className="text-muted-foreground/50 hover:text-primary/60 transition-colors">
                      Checklist →
                    </button>
                  )}
                </div>
              </div>
            </OverlayScrollArea>
          </div>
        )}

        {/* ── CHECKLIST — also deferred past intro exit ── */}
        {(page === 'checklist' || exitingPage === 'checklist') && exitingPage !== 'intro' && (
          <div
            className={`absolute inset-0 ${getPageAnimClass('checklist', page, exitingPage, slideDir)}`}
            onAnimationEnd={exitingPage === 'checklist'
              ? (e: React.AnimationEvent) => { if (e.target === e.currentTarget) handleSlideEnd('checklist'); }
              : undefined}
          >
            <OverlayScrollArea className="h-full">
              <div className="px-8 py-6 pb-16 max-w-4xl mx-auto">
                {checklistCount > 0 ? (
                  <QAChecklist
                    items={tour.qa_checklist}
                    stops={tour.stops}
                    checked={checked}
                    onToggle={toggleChecked}
                    onScrollToStop={(i) => {
                      navigate('stops');
                      setTimeout(() => handleScrollToStop(i), 280);
                    }}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground/50">No checklist items for this tour.</p>
                )}
              </div>
            </OverlayScrollArea>
          </div>
        )}

      </div>
    </>
  );
}
