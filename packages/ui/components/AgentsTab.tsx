import React, { useMemo, useState } from 'react';
import { Square } from 'lucide-react';
import type { AgentJobInfo, AgentCapabilities } from '../types';
import { isTerminalStatus } from '@plannotator/core/agent-jobs';
import { GUIDE_ENGINE_LABEL } from '@plannotator/core/guide';
import { CLAUDE_FALLBACK_MODELS, CODEX_FALLBACK_MODELS, modelLabel } from '@plannotator/core/model-catalog';
import type { ReviewEngine } from '../hooks/useAgentSettings';
import type { AgentLaunchParams } from '../hooks/useAgentJobs';
import { useLaunchConfig, PI_THINKING } from '../hooks/useLaunchConfig';
import type { ModelCatalogs } from '../hooks/useModelCatalogs';
import { LaunchPad } from './agents/LaunchPad';
import { JobRow, rerunParams, formatDuration, ElapsedTime } from './agents/JobRow';
import { AddReviewDialog } from './agents/AddReviewDialog';
import { findingsOf, type FindingLike } from './agents/jobFindings';

export type { AgentLaunchParams } from '../hooks/useAgentJobs';
export { PI_THINKING, formatDuration, ElapsedTime };
export type { FindingLike };

export const REVIEW_ENGINE_LABEL: Record<ReviewEngine, string> = GUIDE_ENGINE_LABEL;

export type AgentLaunchResult = AgentJobInfo | null | void;

const RERUNNABLE = new Set(['claude', 'codex', 'cursor', 'opencode', 'pi', 'copilot', 'guide']);

export function jobModelName(job: AgentJobInfo, catalogs: Pick<ModelCatalogs, 'claude' | 'codex'>): string | null {
  const engine = job.provider === 'guide' ? job.engine : job.provider;
  if (!job.model) return engine === 'claude' || engine === 'codex' ? null : 'Default';
  if (engine === 'claude') return modelLabel([...catalogs.claude.models, ...CLAUDE_FALLBACK_MODELS], job.model);
  if (engine === 'codex') return modelLabel([...catalogs.codex.models, ...CODEX_FALLBACK_MODELS], job.model);
  if (engine === 'cursor' && job.model.toLowerCase() === 'auto') return 'Auto';
  return job.model;
}

interface AgentsTabProps {
  jobs: AgentJobInfo[];
  capabilities: AgentCapabilities | null;
  onLaunch: (params: AgentLaunchParams) => AgentLaunchResult | Promise<AgentLaunchResult>;
  onKillJob: (id: string) => void;
  onKillAll: () => void;
  externalAnnotations: readonly FindingLike[];
  onOpenJobDetail?: (jobId: string) => void;
  onOpenGuide?: (jobId: string) => void;
  onOpenFinding?: (finding: FindingLike) => void;
  guideLaunchable?: boolean;
  canOpenGuideJob?: (job: AgentJobInfo) => boolean;
  scope?: React.ReactNode;
  guides?: (ctx: { startGuide: (() => void) | null }) => React.ReactNode;
}

function SectionTitle({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
      <h3 className="text-[12px] font-medium text-muted-foreground">{children}</h3>
      {trailing}
    </div>
  );
}

export const AgentsTab: React.FC<AgentsTabProps> = ({
  jobs,
  capabilities,
  onLaunch,
  onKillJob,
  onKillAll,
  externalAnnotations,
  onOpenJobDetail,
  onOpenGuide,
  onOpenFinding,
  guideLaunchable = true,
  canOpenGuideJob,
  scope,
  guides,
}) => {
  const config = useLaunchConfig(capabilities, { guideLaunchable });
  const [addReviewOpen, setAddReviewOpen] = useState(false);

  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((a, b) => {
        const aRunning = !isTerminalStatus(a.status);
        const bRunning = !isTerminalStatus(b.status);
        if (aRunning !== bRunning) return aRunning ? -1 : 1;
        return b.startedAt - a.startedAt;
      }),
    [jobs],
  );
  const runningCount = jobs.filter((j) => !isTerminalStatus(j.status)).length;
  const launch = async (params: AgentLaunchParams) => onLaunch(params);

  const openJob = (job: AgentJobInfo, findings: readonly FindingLike[]) => {
    if (job.provider === 'guide') {
      if (job.status === 'done' && onOpenGuide && (canOpenGuideJob?.(job) ?? true)) onOpenGuide(job.id);
      else onOpenJobDetail?.(job.id);
      return;
    }
    if (job.status === 'done' && findings.length > 0 && onOpenFinding) onOpenFinding(findings[0]);
    else onOpenJobDetail?.(job.id);
  };

  return (
    <div className="flex flex-col pb-3" data-agents-tab="">
      <LaunchPad config={config} scope={scope} onLaunch={launch} onAddReview={() => setAddReviewOpen(true)} />

      {sortedJobs.length > 0 && (
        <section aria-label="Runs" className="border-t border-border/60 mt-2">
          <SectionTitle
            trailing={
              runningCount >= 2 ? (
                <button
                  type="button"
                  onClick={onKillAll}
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Square size={10} aria-hidden />
                  Cancel all ({runningCount})
                </button>
              ) : null
            }
          >
            Runs
          </SectionTitle>
          <div className="px-3">
            {sortedJobs.map((job) => {
              const findings = findingsOf(job.source, externalAnnotations);
              return (
                <JobRow
                  key={job.id}
                  job={job}
                  modelName={jobModelName(job, config.catalogs)}
                  findings={findings}
                  onOpen={() => openJob(job, findings)}
                  onDetails={onOpenJobDetail ? () => onOpenJobDetail(job.id) : undefined}
                  onCancel={() => onKillJob(job.id)}
                  onRerun={RERUNNABLE.has(job.provider) ? () => void onLaunch(rerunParams(job) as AgentLaunchParams) : undefined}
                />
              );
            })}
          </div>
        </section>
      )}

      {guides?.({ startGuide: config.guide.ready ? () => void onLaunch(config.guide.buildParams()) : null })}

      {addReviewOpen && (
        <AddReviewDialog
          onClose={() => setAddReviewOpen(false)}
          onEnabled={(name) => {
            const id = `skill:${name}`;
            config.addProfile(id, name);
            config.setProfileId(id);
            setAddReviewOpen(false);
            config.refreshProfiles();
          }}
        />
      )}
    </div>
  );
};
