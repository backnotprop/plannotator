import React, { useEffect, useRef, useState } from 'react';
import type { AgentJobInfo, AgentCapabilities } from '@plannotator/ui/types';
import { jobMatchesReviewContext } from '@plannotator/ui/hooks/useAgentJobs';
import type { AgentLaunchParams } from '@plannotator/ui/hooks/useAgentJobs';
import type { ReviewEngine } from '@plannotator/ui/hooks/useAgentSettings';
import { REVIEW_ENGINE_LABEL } from '@plannotator/ui/components/AgentsTab';
import { isTerminalStatus } from '@plannotator/shared/agent-jobs';
import { useGuideData } from '../../hooks/guide/useGuideData';
import { useReviewState } from '../../dock/ReviewStateContext';
import { GuideEmptyState } from './GuideEmptyState';
import { GuideGenerating } from './GuideGenerating';
import { GuideSectionSkeleton } from './GuideSkeleton';
import { GuideView } from './GuideView';

interface GuideScreenProps {
  /** Latest completed guide job id (or the demo guide id in standalone mode).
   *  Null when no guide has completed yet. */
  activeGuideJobId: string | null;
  jobs: AgentJobInfo[];
  capabilities: AgentCapabilities | null;
  launchJob: (params: AgentLaunchParams) => Promise<AgentJobInfo | null>;
  killJob: (id: string) => Promise<void>;
  /** Close the takeover and return to the diff workspace. */
  onClose: () => void;
  /** Navigate to a guide by job id once GuideEmptyState's failure-recovery
   *  panel successfully submits a manually-fixed output (POST .../submit →
   *  200). Wired to the same handler ReviewSidebar's onOpenGuide uses. */
  onOpenFixedGuide?: (jobId: string) => void;
}

/**
 * Guided Review takeover root. App.tsx renders this as a peer of the file
 * tree / center dock (which stay mounted but CSS-hidden) when `guideOpen`.
 *
 * Branches on the state of `guide`-provider jobs, in priority order:
 *   1. a running guide job always wins — regenerating shows progress, not
 *      the previous guide (single-active-guide model, v1 scope).
 *   2. otherwise, a known completed guide (`activeGuideJobId`) renders.
 *   3. otherwise, the empty/launch state.
 */
export const GuideScreen: React.FC<GuideScreenProps> = ({
  activeGuideJobId,
  jobs,
  capabilities,
  launchJob,
  killJob,
  onClose,
  onOpenFixedGuide,
}) => {
  const [cancelling, setCancelling] = useState(false);
  // GuideScreen renders inside ReviewStateProvider (ActiveGuide below already
  // relies on this), so it's safe to read prMetadata here to scope every guide
  // job lookup below to the review context currently on screen.
  const state = useReviewState();
  // Does `job` belong to the review context currently on screen? Guide jobs
  // are stamped with `prUrl` at launch (undefined for local-diff jobs — see
  // `launchPrUrl` in packages/server/review.ts). Without this, `jobs` (a flat,
  // ever-growing list spanning every PR/local-diff context visited this
  // session) would let a guide launched against PR A show up while reviewing
  // PR B, or vice versa.
  //   - PR mode (`state.prMetadata` set): only a job launched against the
  //     SAME PR url matches.
  //   - Local-diff mode (`state.prMetadata` unset): only a job with no
  //     `prUrl`, launched against the SAME worktree (or the main tree),
  //     matches — see state.currentWorktreePath (App.tsx) and
  //     jobMatchesReviewContext's worktreePath handling.
  const matchesContext = (job: AgentJobInfo): boolean =>
    jobMatchesReviewContext(job, state.prMetadata?.url, state.currentWorktreePath ?? null);
  // jobs is append-ordered (see upsertJob in useAgentJobs) — the takeover
  // follows the NEWEST launched guide, so a plain `.find` (first match) would
  // stick with a stale running job if a second guide got launched while an
  // earlier one was still winding down. Iterate from the end instead, and
  // Cancel below targets whichever job this resolves to. Filtered to the
  // current context first — a running guide job for a different PR/context
  // must not steal the takeover.
  const runningJob =
    [...jobs].reverse().find((j) => j.provider === 'guide' && matchesContext(j) && !isTerminalStatus(j.status)) ?? null;

  if (runningJob) {
    return (
      <GuideGenerating
        job={runningJob}
        onCancel={async () => {
          if (cancelling) return;
          setCancelling(true);
          try {
            await killJob(runningJob.id);
          } finally {
            setCancelling(false);
          }
        }}
      />
    );
  }

  // `jobs` is append-ordered (see upsertJob in useAgentJobs), so the last
  // `guide`-provider entry is the most recently launched one — used both by
  // the "no active guide yet" fallback below and by the newer-failure check
  // above an already-successful guide. Scoped to the current context — a
  // guide (or failure) from a different PR/local-diff context is irrelevant
  // to what's on screen right now.
  const guideJobs = jobs.filter((j) => j.provider === 'guide' && matchesContext(j));
  const latestGuideJob = guideJobs.length > 0 ? guideJobs[guideJobs.length - 1] : null;

  // The job behind activeGuideJobId may belong to a DIFFERENT context (e.g.
  // it was set while reviewing PR A, and the reviewer has since switched to
  // PR B). Two cases:
  //   - found AND mismatched context → treat activeGuideJobId as absent, so
  //     the branches below (newer-failed-job / failed / empty) take over.
  //   - not found at all (demo guide id in standalone mode, or a job the
  //     client no longer holds in `jobs`) → ALLOW it; there's no context to
  //     compare against, and this preserves the demo path plus tolerates gaps
  //     in the client's job list.
  const activeJob = jobs.find((j) => j.id === activeGuideJobId);
  const activeGuideMatchesContext = !activeJob || matchesContext(activeJob);

  // What to actually display: the active guide when it belongs to this
  // context, otherwise FALL BACK to this context's own newest completed
  // guide. Without the fallback, switching from PR A (guide open) to PR B
  // (which has its own finished guide) landed on the empty state — B's guide
  // existed but nothing selected it, since activeGuideJobId still pointed at A.
  const newestDoneGuideJob = [...guideJobs].reverse().find((j) => j.status === 'done') ?? null;
  const displayGuideJobId =
    activeGuideJobId && activeGuideMatchesContext ? activeGuideJobId : newestDoneGuideJob?.id ?? null;

  if (displayGuideJobId) {
    // A guide can already be showing (activeGuideJobId) while a LATER launch
    // (e.g. "Regenerate guide") fails — that failure must not be silently
    // lost just because a previous guide still renders fine. Only treat it as
    // "newer" than the active guide by comparing positions in the
    // append-ordered `jobs` array; a failed job that happens to be OLDER than
    // the active one (e.g. a repair attempt for a guide from before this one)
    // must never outrank what's already on screen.
    const activeIndex = jobs.findIndex((j) => j.id === displayGuideJobId);
    const latestIndex = latestGuideJob ? jobs.findIndex((j) => j.id === latestGuideJob.id) : -1;
    const newerFailedJob =
      latestGuideJob &&
      latestGuideJob.id !== displayGuideJobId &&
      (latestGuideJob.status === 'failed' || latestGuideJob.status === 'killed') &&
      latestIndex > activeIndex
        ? latestGuideJob
        : null;

    // Keyed on jobId so per-guide state (focusedFile today, anything added
    // later) resets when the user switches to a different completed guide
    // rather than carrying over stale state from the previous one.
    return (
      <ActiveGuide
        key={displayGuideJobId}
        jobId={displayGuideJobId}
        jobs={jobs}
        failedJob={newerFailedJob}
        capabilities={capabilities}
        launchJob={launchJob}
        onOpenFixedGuide={onOpenFixedGuide}
      />
    );
  }

  // No running job and no completed guide to show — if the most recent guide
  // job failed (or was killed) rather than never having been launched, surface
  // that instead of a plain "start a guide?" landing page, so the failure
  // isn't invisible.
  const failedGuideJob =
    latestGuideJob && latestGuideJob.id !== activeGuideJobId && (latestGuideJob.status === 'failed' || latestGuideJob.status === 'killed')
      ? latestGuideJob
      : null;

  if (failedGuideJob) {
    return (
      // Keyed on jobId: if a repair job also fails, the failure panel remounts
      // fresh (probe re-runs, textarea edits don't carry over from the prior
      // failed job) rather than reusing stale state from the last one.
      <GuideEmptyState
        key={failedGuideJob.id}
        capabilities={capabilities}
        launchJob={launchJob}
        onBack={onClose}
        failure={{
          jobId: failedGuideJob.id,
          engine: failedGuideJob.engine,
          error: failedGuideJob.error ?? 'Guide generation failed.',
        }}
        onOpenFixedGuide={onOpenFixedGuide}
      />
    );
  }

  return <GuideEmptyState capabilities={capabilities} launchJob={launchJob} onBack={onClose} />;
};

function ActiveGuide({
  jobId,
  jobs,
  failedJob,
  capabilities,
  launchJob,
  onOpenFixedGuide,
}: {
  jobId: string;
  jobs: AgentJobInfo[];
  /** A LATER guide job (different id, newer than `jobId`) that failed or was
   *  killed — surfaced as a slim strip above the still-good guide rather than
   *  silently dropped. Null when nothing newer has failed. */
  failedJob: AgentJobInfo | null;
  capabilities: AgentCapabilities | null;
  launchJob: (params: AgentLaunchParams) => Promise<AgentJobInfo | null>;
  onOpenFixedGuide?: (jobId: string) => void;
}) {
  const { guide, loading, error, reviewed, toggleReviewed, retry } = useGuideData(jobId);
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const state = useReviewState();

  // "Details" switches this screen over to the full failure-recovery panel
  // (GuideEmptyState's failure branch) for `failedJob`, instead of duplicating
  // that panel here. Local to this component: dismissing it (its onBack) just
  // flips this back off, returning to the guide — it does NOT dismiss the
  // strip itself (see dismissedRef below), so backing out without fixing
  // anything still leaves the notice in place.
  const [showRecovery, setShowRecovery] = useState(false);
  // "Fix output" launches a repair job with the same params GuideEmptyState's
  // handleFixOutput uses (repairOf + engine) — reused as a small local
  // handler rather than pulling in that component's whole state machine.
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  // Dismissed failed-job ids, keyed by id so the strip doesn't resurrect on
  // re-render once dismissed, but DOES reappear for a genuinely new failed
  // job (a different id never in this set). A ref rather than state because
  // membership itself shouldn't drive re-renders — the tick below does that,
  // only on an actual dismiss action.
  const dismissedRef = useRef<Set<string>>(new Set());
  const [, bumpDismissTick] = useState(0);

  // focusedFile otherwise stays null until pointerenter (see GuideDiffSection),
  // which leaves a keyboard-only user with nothing focused (no annotation
  // toolbar target) until they touch the mouse. Default it once the guide
  // loads: the first section's first diff file that still resolves against
  // the current diff (guide refs can go stale if the diff changed since
  // generation — see GuideDiffSection's "no longer in the current diff" case).
  useEffect(() => {
    if (focusedFile !== null || !guide) return;
    const filePathsInDiff = new Set(state.files.map((f) => f.path));
    const allRefs = guide.sections
      .flatMap((s) => s.diffs)
      .concat((guide.unplacedFiles ?? []).map((file) => ({ file })));
    const firstResolvable = allRefs.find((ref) => filePathsInDiff.has(ref.file));
    if (firstResolvable) setFocusedFile(firstResolvable.file);
  }, [guide, focusedFile, state.files]);

  const handleFixOutput = async () => {
    if (!failedJob || repairing) return;
    setRepairing(true);
    setRepairError(null);
    try {
      await launchJob({
        provider: 'guide',
        label: 'Guide Repair',
        repairOf: failedJob.id,
        ...(failedJob.engine ? { engine: failedJob.engine } : {}),
      });
      // A successful launch lands as a new running guide job — GuideScreen's
      // running-job branch takes over from here automatically (same as
      // GuideEmptyState's handleFixOutput).
    } catch (err) {
      setRepairError(err instanceof Error ? err.message : 'Could not start the repair.');
    } finally {
      setRepairing(false);
    }
  };

  if (showRecovery && failedJob) {
    return (
      <GuideEmptyState
        key={failedJob.id}
        capabilities={capabilities}
        launchJob={launchJob}
        onBack={() => setShowRecovery(false)}
        failure={{
          jobId: failedJob.id,
          engine: failedJob.engine,
          error: failedJob.error ?? 'Guide generation failed.',
        }}
        onOpenFixedGuide={onOpenFixedGuide}
      />
    );
  }

  const showStrip = !!failedJob && !dismissedRef.current.has(failedJob.id);
  const failureStrip = showStrip && failedJob ? (
    <div className="flex items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
      <span className="min-w-0 flex-1 truncate">{(failedJob.error ?? 'Guide generation failed.').split('\n')[0]}</span>
      {repairError && <span className="shrink-0 truncate text-destructive/70">{repairError}</span>}
      <button
        type="button"
        onClick={handleFixOutput}
        disabled={repairing}
        className="shrink-0 font-medium underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        {repairing ? 'Starting repair…' : 'Fix output'}
      </button>
      <button type="button" onClick={() => setShowRecovery(true)} className="shrink-0 text-destructive/80 underline-offset-2 hover:underline">
        Details
      </button>
      <button
        type="button"
        onClick={() => {
          dismissedRef.current.add(failedJob.id);
          bumpDismissTick((t) => t + 1);
        }}
        aria-label="Dismiss guide failure notice"
        className="shrink-0 text-destructive/60 hover:text-destructive"
      >
        ×
      </button>
    </div>
  ) : null;

  if (loading) {
    return (
      <div className="w-full">
        {failureStrip}
        <div className="px-10 py-8">
          <div className="h-7 w-80 animate-pulse rounded bg-muted/30" />
          <div className="mt-3 h-4 w-full max-w-md animate-pulse rounded bg-muted/20" />
          <div className="mt-2 h-3 w-48 animate-pulse rounded bg-muted/20" />
          <GuideSectionSkeleton />
        </div>
      </div>
    );
  }

  if (error || !guide) {
    return (
      <div className="w-full">
        {failureStrip}
        <div className="px-10 py-16 text-center">
          <p className="text-sm text-muted-foreground">{error ?? 'Guide not found'}</p>
          <button onClick={retry} className="mt-3 text-xs text-primary hover:text-primary/80 transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const engine = jobs.find((j) => j.id === jobId)?.engine;

  return (
    <div className="w-full">
      {failureStrip}
      <GuideView
        guide={guide}
        reviewed={reviewed}
        onToggleReviewed={toggleReviewed}
        engineLabel={engine ? REVIEW_ENGINE_LABEL[engine as ReviewEngine] ?? engine : undefined}
        focusedFile={focusedFile}
        onFocusFile={setFocusedFile}
      />
    </div>
  );
}
