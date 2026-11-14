import React from 'react';
import { CircleCheck, CircleSlash, CircleX, Loader2, PanelRight, RotateCcw, X } from 'lucide-react';
import type { AgentJobInfo } from '../../types';
import { isTerminalStatus } from '@plannotator/core/agent-jobs';
import { GUIDE_ENGINE_LABEL } from '@plannotator/core/guide';
import { cn } from '../../lib/utils';
import { findingCountsLine, type FindingLike } from './jobFindings';

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Date.now() - startedAt)}</>;
}

const STATUS_WORD: Record<AgentJobInfo['status'], string> = {
  starting: 'Starting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  killed: 'Cancelled',
};

function StatusIcon({ status }: { status: AgentJobInfo['status'] }) {
  const cls = 'shrink-0 text-muted-foreground';
  if (status === 'starting' || status === 'running') return <Loader2 size={14} className={cn(cls, 'animate-spin motion-reduce:animate-none text-primary')} aria-hidden />;
  if (status === 'done') return <CircleCheck size={14} className={cls} aria-hidden />;
  if (status === 'failed') return <CircleX size={14} className={cls} aria-hidden />;
  return <CircleSlash size={14} className={cls} aria-hidden />;
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

export function JobRow({
  job,
  modelName,
  findings,
  onOpen,
  onDetails,
  onCancel,
  onRerun,
}: {
  job: AgentJobInfo;
  modelName: string | null;
  findings: readonly FindingLike[];
  onOpen: () => void;
  onDetails?: () => void;
  onCancel: () => void;
  onRerun?: () => void;
}) {
  const terminal = isTerminalStatus(job.status);
  const isGuide = job.provider === 'guide';
  const engine = GUIDE_ENGINE_LABEL[(isGuide ? job.engine : job.provider) as keyof typeof GUIDE_ENGINE_LABEL] ?? job.engine ?? job.provider;
  const runTitle = job.launchLabel ?? (isGuide ? 'Guided Review' : job.reviewProfileLabel && job.reviewProfileLabel !== 'Default' ? `${job.label}: ${job.reviewProfileLabel}` : job.label);
  const detail = !terminal
    ? STATUS_WORD[job.status]
    : job.status === 'failed'
      ? `Failed${job.error ? `: ${job.error.split('\n')[0]}` : ''}`
      : job.status === 'killed'
        ? 'Cancelled'
        : isGuide
          ? 'Ready to read'
          : findingCountsLine(findings);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      data-agent-job-row={job.status}
      title={`${runTitle} · started ${new Date(job.startedAt).toLocaleString()}`}
      className="group -mx-1 flex items-start gap-2 rounded-md px-1 py-1.5 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="pt-0.5"><StatusIcon status={job.status} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" data-agent-job-label="">
            {runTitle}
          </span>
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
            {terminal && job.endedAt ? formatDuration(job.endedAt - job.startedAt) : <ElapsedTime startedAt={job.startedAt} />}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline text-[12px] text-muted-foreground">
          <span className="flex-none whitespace-nowrap" data-agent-job-engine="">{[engine, modelName ?? job.model, job.effort ?? job.reasoningEffort ?? job.thinking].filter(Boolean).join(' · ')}</span>
          <span className="flex-none whitespace-pre" aria-hidden="true"> · </span>
          <span className="min-w-0 truncate" data-agent-job-detail="" title={detail}>{detail}</span>
        </span>
        {job.warning && <span className="block text-[12px] leading-5 text-muted-foreground" role="status" data-agent-job-warning="">{job.warning}</span>}
      </span>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        {onDetails && (
          <IconButton label="Details and logs" onClick={onDetails}>
            <PanelRight size={13} />
          </IconButton>
        )}
        {terminal
          ? onRerun && (
              <IconButton label="Run again" onClick={onRerun}>
                <RotateCcw size={13} />
              </IconButton>
            )
          : (
              <IconButton label="Cancel" onClick={onCancel}>
                <X size={13} />
              </IconButton>
            )}
      </span>
    </div>
  );
}

export function rerunParams(job: AgentJobInfo): Record<string, unknown> {
  const isGuide = job.provider === 'guide';
  return {
    provider: job.provider,
    label: isGuide ? 'Guided Review' : job.label,
    ...(isGuide && job.engine ? { engine: job.engine } : {}),
    ...(job.model ? { model: job.model } : {}),
    ...(job.effort ? { effort: job.effort } : {}),
    ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
    ...(job.thinking ? { thinking: job.thinking } : {}),
    ...(job.fastMode ? { fastMode: true } : {}),
    ...(!isGuide && job.reviewProfileId && job.reviewProfileId !== 'builtin:default' ? { reviewProfileId: job.reviewProfileId } : {}),
  };
}
