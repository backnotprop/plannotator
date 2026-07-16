import React, { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AgentJobInfo } from '@plannotator/ui/types';
import { ElapsedTime } from '@plannotator/ui/components/AgentsTab';
import { LiveLogViewer } from '../LiveLogViewer';
import { useJobLogs } from '../../dock/JobLogsContext';
import { GuideSectionSkeleton } from './GuideSkeleton';

const STATUS_LABEL: Record<AgentJobInfo['status'], string> = {
  starting: 'Starting',
  running: 'Generating',
  done: 'Done',
  failed: 'Failed',
  killed: 'Cancelled',
};

/** Keep only the last ~N lines of a live log tail — the guide's generating
 *  page is a glance, not the full job-detail log view. */
function tailLines(content: string, maxLines = 200): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(lines.length - maxLines).join('\n');
}

interface GuideGeneratingProps {
  job: AgentJobInfo;
  onCancel: () => void;
}

/**
 * Running/starting state for an in-flight guide job. Occupies the same
 * full-width page as the finished guide: the header zone shows status where
 * the guide title will land, and skeleton section cards fill the width below —
 * they're replaced by the real sections when the job completes. The live log
 * is progressive disclosure ("Show activity"), collapsed by default.
 */
export const GuideGenerating: React.FC<GuideGeneratingProps> = ({ job, onCancel }) => {
  const { jobLogs } = useJobLogs();
  const [showActivity, setShowActivity] = useState(false);
  const logContent = useMemo(
    () => (showActivity ? tailLines(jobLogs.get(job.id) ?? '') : ''),
    [jobLogs, job.id, showActivity],
  );

  return (
    <div className="w-full px-10 py-8">
      {/* Header zone — replaced by the guide title when generation finishes */}
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
          {STATUS_LABEL[job.status]} your guide{'…'}
        </h1>
      </div>
      <p className="mt-1.5 max-w-[72ch] text-[13px] leading-relaxed text-muted-foreground">
        The agent is reading the changeset and organizing it into sections. The guide
        replaces this page when it's ready.
      </p>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground/60">
        {job.label}
        {job.model ? ` · ${job.model}` : ''} · <ElapsedTime startedAt={job.startedAt} />
      </p>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => setShowActivity((v) => !v)}
          aria-expanded={showActivity}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <ChevronRight className={`transition-transform ${showActivity ? 'rotate-90' : ''}`} size={12} />
          {showActivity ? 'Hide activity' : 'Show activity'}
        </button>
      </div>

      {showActivity && (
        // LiveLogViewer fills a BOUNDED parent (`h-full` inside) — an auto-height
        // wrapper lets it grow with content forever. Fixed height + its own
        // internal scroll (auto-following the tail unless the user scrolls up).
        <div className="mt-3 h-[300px] max-w-[760px]">
          <LiveLogViewer content={logContent} isLive className="h-full" />
        </div>
      )}

      <GuideSectionSkeleton />
    </div>
  );
};
