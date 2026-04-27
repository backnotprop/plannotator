import React, { useState, useEffect, useMemo } from 'react';
import type { AgentJobInfo, AgentCapabilities } from '../types';
import { isTerminalStatus } from '@plannotator/shared/agent-jobs';
import { ReviewAgentsIcon } from './ReviewAgentsIcon';
import { useAgentSettings } from '../hooks/useAgentSettings';

// --- Agent option catalogs (shared across provider + tour-engine dropdowns) ---

const CLAUDE_MODELS: Array<{ value: string; label: string }> = [
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
];

const CLAUDE_EFFORT: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];

const CODEX_MODELS: Array<{ value: string; label: string }> = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
];

const CODEX_REASONING: Array<{ value: string; label: string }> = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

// Tour Claude reuses the same effort levels but offers a different model set.
const TOUR_CLAUDE_MODELS: Array<{ value: string; label: string }> = [
  { value: 'sonnet', label: 'Sonnet (fast)' },
  { value: 'opus', label: 'Opus (thorough)' },
];

// Dropdown labels: action first, provider second. Groups visually by action —
// you scan two "Code Review" entries and one "Code Tour" instead of three raw
// CLI names.
const PROVIDER_DROPDOWN_LABEL: Record<string, string> = {
  claude: 'Code Review · Claude',
  codex: 'Code Review · Codex',
  tour: 'Code Tour',
};

function providerDropdownLabel(id: string, fallback: string): string {
  return PROVIDER_DROPDOWN_LABEL[id] ?? fallback;
}

interface AgentsTabProps {
  jobs: AgentJobInfo[];
  capabilities: AgentCapabilities | null;
  onLaunch: (params: { provider?: string; command?: string[]; label?: string; engine?: string; model?: string; reasoningEffort?: string; effort?: string; fastMode?: boolean }) => void;
  onKillJob: (id: string) => void;
  onKillAll: () => void;
  externalAnnotations: Array<{ source?: string }>;
  onOpenJobDetail?: (jobId: string) => void;
}

// --- Duration display ---

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Date.now() - startedAt)}</>;
}

// --- Status badge ---

function StatusBadge({ status }: { status: AgentJobInfo['status'] }) {
  switch (status) {
    case 'starting':
    case 'running':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary">
          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {status === 'starting' ? 'Starting' : 'Running'}
        </span>
      );
    case 'done':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-success">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Done
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-destructive">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          Failed
        </span>
      );
    case 'killed':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 10a1 1 0 011-1h4a1 1 0 110 2h-4a1 1 0 01-1-1z" />
          </svg>
          Killed
        </span>
      );
  }
}

// --- Provider badge ---

// Lookup a human label from the catalogs; fall back to the raw id.
function catalogLabel(list: Array<{ value: string; label: string }>, value: string): string {
  return list.find((o) => o.value === value)?.label ?? value;
}

function formatModel(provider: string, engine: string | undefined, model: string): string {
  if (provider === 'codex' || engine === 'codex') return catalogLabel(CODEX_MODELS, model);
  if (provider === 'tour' && engine === 'claude') return catalogLabel(TOUR_CLAUDE_MODELS, model);
  return catalogLabel(CLAUDE_MODELS, model);
}

function formatEffort(value: string): string {
  return catalogLabel(CLAUDE_EFFORT, value);
}

function formatReasoning(value: string): string {
  return catalogLabel(CODEX_REASONING, value);
}

function ProviderBadge({ provider, engine, model, effort, reasoningEffort, fastMode }: { provider: string; engine?: string; model?: string; effort?: string; reasoningEffort?: string; fastMode?: boolean }) {
  let label: string;
  if (provider === 'tour') {
    const engineLabel = engine === 'codex' ? 'Codex' : 'Claude';
    const parts = [`Tour · ${engineLabel}`];
    if (model) parts.push(formatModel(provider, engine, model));
    if (engine === 'claude' && effort) parts.push(formatEffort(effort));
    if (engine === 'codex' && reasoningEffort) parts.push(formatReasoning(reasoningEffort));
    if (fastMode) parts.push('Fast');
    label = parts.join(' · ');
  } else if (provider === 'codex') {
    const parts = ['Codex'];
    if (model) parts.push(formatModel(provider, engine, model));
    if (reasoningEffort) parts.push(formatReasoning(reasoningEffort));
    if (fastMode) parts.push('Fast');
    label = parts.join(' · ');
  } else if (provider === 'claude') {
    const parts = ['Claude'];
    if (model) parts.push(formatModel(provider, engine, model));
    if (effort) parts.push(formatEffort(effort));
    label = parts.join(' · ');
  } else {
    label = 'Shell';
  }
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
      provider === 'tour' ? 'bg-accent/10 text-accent' : 'bg-muted text-muted-foreground'
    }`}>
      {label}
    </span>
  );
}

// --- Job card ---

function JobCard({
  job,
  annotationCount,
  onKill,
  expanded,
  onToggle,
  onViewDetails,
}: {
  job: AgentJobInfo;
  annotationCount: number;
  onKill: () => void;
  expanded: boolean;
  onToggle: () => void;
  onViewDetails?: () => void;
}) {
  const isTerminal = isTerminalStatus(job.status);

  return (
    <div
      className={`group relative p-2.5 rounded border transition-all cursor-pointer ${
        expanded
          ? 'bg-muted/30 border-border/50'
          : 'border-transparent hover:bg-muted/30 hover:border-border/50'
      }`}
      onClick={onViewDetails ? () => onViewDetails() : (isTerminal ? onToggle : undefined)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ProviderBadge provider={job.provider} engine={job.engine} model={job.model} effort={job.effort} reasoningEffort={job.reasoningEffort} fastMode={job.fastMode} />
          <span className="text-xs text-foreground/80 truncate">{job.label}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {annotationCount > 0 && (
            <span className="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
              {annotationCount}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/60 font-mono">
            {isTerminal && job.endedAt
              ? formatDuration(job.endedAt - job.startedAt)
              : <ElapsedTime startedAt={job.startedAt} />
            }
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between mt-1.5">
        <StatusBadge status={job.status} />
        <div className="flex items-center gap-1">
          {!isTerminal && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onKill();
              }}
              className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
              title="Kill agent"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Error details — fallback for when dockview detail panel is not available */}
      {!onViewDetails && job.status === 'failed' && job.error && expanded && (
        <div className="mt-2 p-2 rounded bg-destructive/5 border border-destructive/20">
          <pre className="text-[10px] text-destructive/80 whitespace-pre-wrap break-all font-mono leading-relaxed max-h-24 overflow-y-auto">
            {job.error}
          </pre>
        </div>
      )}
    </div>
  );
}

// --- Main component ---

export const AgentsTab: React.FC<AgentsTabProps> = ({
  jobs,
  capabilities,
  onLaunch,
  onKillJob,
  onKillAll,
  externalAnnotations,
  onOpenJobDetail,
}) => {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const settings = useAgentSettings();
  const {
    selectedProvider,
    tourEngine,
    claudeModel,
    claudeEffort,
    codexModel,
    codexReasoning,
    codexFast,
    tourClaudeModel,
    tourClaudeEffort,
    tourCodexModel,
    tourCodexReasoning,
    tourCodexFast,
    setSelectedProvider,
    setTourEngine,
    setClaudeModel,
    setClaudeEffort,
    setCodexModel,
    setCodexReasoning,
    setCodexFast,
    setTourClaudeModel,
    setTourClaudeEffort,
    setTourCodexModel,
    setTourCodexReasoning,
    setTourCodexFast,
  } = settings;

  // Reconcile provider + tour engine against live capabilities. Runs when
  // capabilities change or the stored selection becomes invalid.
  useEffect(() => {
    if (!capabilities) return;
    const available = capabilities.providers.filter((p) => p.available);
    if (available.length === 0) return;
    if (!selectedProvider || !available.some((p) => p.id === selectedProvider)) {
      setSelectedProvider(available[0].id);
    }
    const hasClaude = available.some((p) => p.id === 'claude');
    const hasCodex = available.some((p) => p.id === 'codex');
    if (tourEngine === 'claude' && !hasClaude && hasCodex) setTourEngine('codex');
    else if (tourEngine === 'codex' && !hasCodex && hasClaude) setTourEngine('claude');
  }, [capabilities, selectedProvider, tourEngine, setSelectedProvider, setTourEngine]);

  const availableProviders = useMemo(
    () => capabilities?.providers.filter((p) => p.available) ?? [],
    [capabilities],
  );

  // Annotation counts per job source
  const annotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ann of externalAnnotations) {
      if (ann.source) {
        counts.set(ann.source, (counts.get(ann.source) ?? 0) + 1);
      }
    }
    return counts;
  }, [externalAnnotations]);

  // Sort: running first, then by startedAt descending
  const sortedJobs = useMemo(() => {
    return [...jobs].sort((a, b) => {
      const aRunning = !isTerminalStatus(a.status);
      const bRunning = !isTerminalStatus(b.status);
      if (aRunning !== bRunning) return aRunning ? -1 : 1;
      return b.startedAt - a.startedAt;
    });
  }, [jobs]);

  const runningCount = useMemo(
    () => jobs.filter((j) => !isTerminalStatus(j.status)).length,
    [jobs],
  );

  // Detect which engines are available for tour config
  const claudeAvailable = capabilities?.providers.some((p) => p.id === 'claude' && p.available) ?? false;
  const codexAvailable = capabilities?.providers.some((p) => p.id === 'codex' && p.available) ?? false;

  type LaunchParams = Parameters<typeof onLaunch>[0];
  const buildLaunch: Record<string, () => LaunchParams> = {
    claude: () => ({ provider: 'claude', label: 'Code Review', model: claudeModel, effort: claudeEffort }),
    codex: () => ({
      provider: 'codex',
      label: 'Code Review',
      model: codexModel,
      reasoningEffort: codexReasoning,
      ...(codexFast && { fastMode: true }),
    }),
    tour: () => ({
      provider: 'tour',
      label: 'Code Tour',
      engine: tourEngine,
      model: tourEngine === 'claude' ? tourClaudeModel : tourCodexModel,
      ...(tourEngine === 'claude'
        ? { effort: tourClaudeEffort }
        : { reasoningEffort: tourCodexReasoning, ...(tourCodexFast && { fastMode: true }) }),
    }),
  };

  const handleLaunch = () => {
    if (!selectedProvider) return;
    onLaunch(buildLaunch[selectedProvider]?.() ?? { provider: selectedProvider, label: selectedProvider });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Launch bar */}
      {availableProviders.length > 0 && (
        <div className="p-2 border-b border-border/30">
          <div className="flex items-center gap-1.5">
            {availableProviders.length > 1 ? (
              <select
                value={selectedProvider ?? ''}
                onChange={(e) => setSelectedProvider(e.target.value)}
                className="flex-1 text-xs px-2 py-1.5 rounded bg-muted/50 border border-border/50 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
              >
                {availableProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {providerDropdownLabel(p.id, p.name)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="flex-1 text-xs px-2 py-1.5 text-muted-foreground">
                {availableProviders[0] ? providerDropdownLabel(availableProviders[0].id, availableProviders[0].name) : ''}
              </span>
            )}
            <button
              onClick={handleLaunch}
              disabled={!selectedProvider}
              className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Run
            </button>
          </div>

          {/* Claude model + effort config */}
          {selectedProvider === 'claude' && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-medium w-14">Model</span>
                <select
                  value={claudeModel}
                  onChange={(e) => setClaudeModel(e.target.value)}
                  className="flex-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/50 border border-border/40 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                >
                  {CLAUDE_MODELS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-medium w-14">Effort</span>
                <select
                  value={claudeEffort}
                  onChange={(e) => setClaudeEffort(e.target.value)}
                  className="flex-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/50 border border-border/40 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                >
                  {CLAUDE_EFFORT.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Codex model + reasoning + fast mode config */}
          {selectedProvider === 'codex' && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-medium w-14">Model</span>
                <select
                  value={codexModel}
                  onChange={(e) => setCodexModel(e.target.value)}
                  className="flex-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/50 border border-border/40 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                >
                  {CODEX_MODELS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-medium w-14">Reasoning</span>
                <select
                  value={codexReasoning}
                  onChange={(e) => setCodexReasoning(e.target.value)}
                  className="flex-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/50 border border-border/40 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                >
                  {CODEX_REASONING.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-medium w-14">Fast</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={codexFast}
                    onChange={(e) => setCodexFast(e.target.checked)}
                    className="w-3 h-3 accent-primary"
                  />
                  <span className={codexFast ? 'text-foreground' : ''}>Fast mode</span>
                </label>
              </div>
            </div>
          )}

          {/* Tour engine/model config — only shown when tour is selected */}
          {selectedProvider === 'tour' && (
            <div className="mt-2 space-y-1.5">
              {/* Engine selector */}
              {claudeAvailable && codexAvailable && (
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="font-medium w-14">Engine</span>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="tour-engine"
                      checked={tourEngine === 'claude'}
                      onChange={() => setTourEngine('claude')}
                      className="w-3 h-3 accent-primary"
                    />
                    <span className={tourEngine === 'claude' ? 'text-foreground' : ''}>Claude</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="tour-engine"
                      checked={tourEngine === 'codex'}
                      onChange={() => setTourEngine('codex')}
                      className="w-3 h-3 accent-primary"
                    />
                    <span className={tourEngine === 'codex' ? 'text-foreground' : ''}>Codex</span>
                  </label>
                </div>
              )}

              {/* Model selector — engine-specific options */}
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-medium w-14">Model</span>
                <select
                  value={tourEngine === 'claude' ? tourClaudeModel : tourCodexModel}
                  onChange={(e) => (tourEngine === 'claude' ? setTourClaudeModel(e.target.value) : setTourCodexModel(e.target.value))}
                  className="flex-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/50 border border-border/40 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                >
                  {(tourEngine === 'claude' ? TOUR_CLAUDE_MODELS : CODEX_MODELS).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {/* Claude-only: effort level */}
              {tourEngine === 'claude' && (
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="font-medium w-14">Effort</span>
                  <select
                    value={tourClaudeEffort}
                    onChange={(e) => setTourClaudeEffort(e.target.value)}
                    className="flex-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/50 border border-border/40 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                  >
                    {CLAUDE_EFFORT.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              )}

              {/* Codex-only: reasoning effort + fast mode */}
              {tourEngine === 'codex' && (
                <>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="font-medium w-14">Reasoning</span>
                    <select
                      value={tourCodexReasoning}
                      onChange={(e) => setTourCodexReasoning(e.target.value)}
                      className="flex-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/50 border border-border/40 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                    >
                      {CODEX_REASONING.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="font-medium w-14">Fast</span>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={tourCodexFast}
                        onChange={(e) => setTourCodexFast(e.target.checked)}
                        className="w-3 h-3 accent-primary"
                      />
                      <span className={tourCodexFast ? 'text-foreground' : ''}>Fast mode</span>
                    </label>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Job list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sortedJobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-center px-4">
            <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-3">
              <ReviewAgentsIcon className="w-5 h-5 text-muted-foreground" />
            </div>
            <p className="text-xs text-muted-foreground">
              No agent jobs yet
            </p>
            <p className="text-[10px] text-muted-foreground/60 mt-1">
              Launch an agent to get automated review findings
            </p>
          </div>
        ) : (
          sortedJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              annotationCount={annotationCounts.get(job.source) ?? 0}
              onKill={() => onKillJob(job.id)}
              expanded={expandedJobId === job.id}
              onToggle={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
              onViewDetails={onOpenJobDetail ? () => onOpenJobDetail(job.id) : undefined}
            />
          ))
        )}
      </div>

      {/* Kill All footer */}
      {runningCount >= 2 && (
        <div className="p-2 border-t border-border/50">
          <button
            onClick={onKillAll}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-xs font-medium text-destructive hover:bg-destructive/10 transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            Kill All ({runningCount})
          </button>
        </div>
      )}
    </div>
  );
};
