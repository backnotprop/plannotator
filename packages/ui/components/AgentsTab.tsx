import React, { useState, useEffect, useMemo } from 'react';
import {
  Bot,
  Play,
  X,
  Square,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Skull,
  ExternalLink,
  ChevronDown,
  Zap,
} from 'lucide-react';
import type { AgentJobInfo, AgentCapabilities } from '../types';
import { isTerminalStatus } from '@plannotator/shared/agent-jobs';
import { cn } from '../lib/utils';
import { ReviewAgentsIcon } from './ReviewAgentsIcon';
import { useAgentSettings } from '../hooks/useAgentSettings';

// --- Agent option catalogs (shared across provider + tour-engine dropdowns) ---

const CLAUDE_MODELS: Array<{ value: string; label: string }> = [
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 (1M)' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M)' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
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

// --- Status square (colored tile + lucide glyph, matches the prototype) ---

const JOB_STATUS_BG: Record<AgentJobInfo['status'], string> = {
  starting: 'bg-muted-foreground/10',
  running: 'bg-primary/10',
  done: 'bg-green-500/10',
  failed: 'bg-red-500/10',
  killed: 'bg-orange-500/10',
};

const JOB_STATUS_ICON: Record<AgentJobInfo['status'], React.ReactNode> = {
  starting: <Loader2 className="animate-spin text-muted-foreground" size={10} />,
  running: <Loader2 className="animate-spin text-primary" size={10} />,
  done: <CheckCircle2 className="text-green-600 dark:text-green-400" size={10} />,
  failed: <AlertTriangle className="text-red-600 dark:text-red-400" size={10} />,
  killed: <Skull className="text-orange-600 dark:text-orange-400" size={10} />,
};

function StatusSquare({ status }: { status: AgentJobInfo['status'] }) {
  return (
    <div
      className={cn(
        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
        JOB_STATUS_BG[status],
      )}
    >
      {JOB_STATUS_ICON[status]}
    </div>
  );
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

// --- Launch-control primitives (ported from the prototype's sidebar) ---

// A labelled config row. Inline (label left, control right) by default; pass
// `stacked` to put a full-width control under the label — used for the model
// dropdown and the effort/reasoning segmented pickers, which need the room.
function ConfigRow({ label, stacked, children }: { label: string; stacked?: boolean; children: React.ReactNode }) {
  if (stacked) {
    return (
      <div className="space-y-1">
        <span className="block text-[10px] text-muted-foreground/50">{label}</span>
        {children}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[10px] text-muted-foreground/50">{label}</span>
      {children}
    </div>
  );
}

// Pill selector for small option sets (effort, reasoning, tour engine).
function SegmentedPicker({ options, value, onChange }: { options: Array<{ value: string; label: string }>; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-px rounded-lg bg-surface-1/50 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex-1 rounded-md px-2 py-1 font-medium text-[9px] transition-colors',
            value === opt.value
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground/50 hover:text-muted-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Animated on/off switch (fast mode).
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-border/50')}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
          checked && 'translate-x-4',
        )}
      />
    </button>
  );
}

// Dropdown button + downward popover. Reused for the provider selector and the
// model picker (whose 7–9 options rule out a segmented control). The popover
// opens downward (`top-full`) because the launch panel is pinned to the top of
// the tab.
function SelectMenu({ value, options, onChange, icon, placeholder }: { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; icon?: React.ReactNode; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-border/30 bg-surface-1/30 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-1/50"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">{current?.label ?? placeholder}</span>
        <ChevronDown className={cn('shrink-0 text-muted-foreground/30 transition-transform', open && 'rotate-180')} size={10} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full left-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-xl bg-card p-1 shadow-[var(--card-shadow)] ring-1 ring-border/20">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors',
                  value === o.value
                    ? 'bg-surface-1 text-foreground'
                    : 'text-muted-foreground hover:bg-surface-1/50 hover:text-foreground',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
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
      className={cn(
        'group relative rounded-lg px-2.5 py-2 transition-colors cursor-pointer hover:bg-surface-1/50',
        expanded && 'bg-surface-1/40',
      )}
      onClick={onViewDetails ? () => onViewDetails() : (isTerminal ? onToggle : undefined)}
    >
      <div className="flex items-start gap-2.5">
        <StatusSquare status={job.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-[12px] text-foreground">{job.label}</span>
            {onViewDetails && <ExternalLink className="shrink-0 text-muted-foreground/30" size={9} />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-muted-foreground/50">
            <span className="rounded bg-surface-1 px-1 py-px">{job.provider}</span>
            {job.model && (
              <span className="rounded bg-surface-1 px-1 py-px font-mono">{formatModel(job.provider, job.engine, job.model)}</span>
            )}
            {job.effort && <span className="rounded bg-surface-1 px-1 py-px">{formatEffort(job.effort)}</span>}
            {job.reasoningEffort && <span className="rounded bg-surface-1 px-1 py-px">{formatReasoning(job.reasoningEffort)}</span>}
            {job.fastMode && (
              <span className="rounded bg-amber-500/10 px-1 py-px text-amber-600 dark:text-amber-400">
                <Zap className="inline" size={7} /> fast
              </span>
            )}
            <span className="text-muted-foreground/30">·</span>
            <span className="tabular-nums">
              {isTerminal && job.endedAt ? formatDuration(job.endedAt - job.startedAt) : <ElapsedTime startedAt={job.startedAt} />}
            </span>
            {annotationCount > 0 && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="tabular-nums">{annotationCount} finding{annotationCount !== 1 ? 's' : ''}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {!isTerminal && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onKill();
          }}
          className="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="Kill agent"
        >
          <X size={12} />
        </button>
      )}

      {/* Error details — fallback for when the dockview detail panel is not available */}
      {!onViewDetails && job.status === 'failed' && job.error && expanded && (
        <div className="mt-2 rounded bg-destructive/5 border border-destructive/20 p-2">
          <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-destructive/80">
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
      {/* Launch panel (pinned to the top) */}
      {availableProviders.length > 0 && (
        <div className="border-b border-border/40 p-3">
          <div className="mb-2 font-medium text-[9px] uppercase tracking-wider text-muted-foreground/40">
            Launch agent
          </div>

          <div className="space-y-2">
            {/* Provider */}
            {availableProviders.length > 1 ? (
              <SelectMenu
                value={selectedProvider ?? ''}
                options={availableProviders.map((p) => ({ value: p.id, label: providerDropdownLabel(p.id, p.name) }))}
                onChange={setSelectedProvider}
                icon={<Bot className="shrink-0 text-muted-foreground/50" size={12} />}
                placeholder="Select provider"
              />
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-border/30 bg-surface-1/30 px-2.5 py-1.5">
                <Bot className="shrink-0 text-muted-foreground/50" size={12} />
                <span className="text-[11px] text-foreground/80">
                  {availableProviders[0] ? providerDropdownLabel(availableProviders[0].id, availableProviders[0].name) : ''}
                </span>
              </div>
            )}

            {/* Claude config */}
            {selectedProvider === 'claude' && (
              <>
                <ConfigRow label="Model" stacked>
                  <SelectMenu value={claudeModel} options={CLAUDE_MODELS} onChange={setClaudeModel} />
                </ConfigRow>
                <ConfigRow label="Effort" stacked>
                  <SegmentedPicker options={CLAUDE_EFFORT} value={claudeEffort} onChange={setClaudeEffort} />
                </ConfigRow>
              </>
            )}

            {/* Codex config */}
            {selectedProvider === 'codex' && (
              <>
                <ConfigRow label="Model" stacked>
                  <SelectMenu value={codexModel} options={CODEX_MODELS} onChange={setCodexModel} />
                </ConfigRow>
                <ConfigRow label="Reasoning" stacked>
                  <SegmentedPicker options={CODEX_REASONING} value={codexReasoning} onChange={setCodexReasoning} />
                </ConfigRow>
                <ConfigRow label="Fast mode">
                  <Toggle checked={codexFast} onChange={setCodexFast} />
                </ConfigRow>
              </>
            )}

            {/* Tour config */}
            {selectedProvider === 'tour' && (
              <>
                {claudeAvailable && codexAvailable && (
                  <ConfigRow label="Engine">
                    <SegmentedPicker
                      options={[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]}
                      value={tourEngine}
                      onChange={(v) => setTourEngine(v as 'claude' | 'codex')}
                    />
                  </ConfigRow>
                )}
                <ConfigRow label="Model" stacked>
                  <SelectMenu
                    value={tourEngine === 'claude' ? tourClaudeModel : tourCodexModel}
                    options={tourEngine === 'claude' ? TOUR_CLAUDE_MODELS : CODEX_MODELS}
                    onChange={tourEngine === 'claude' ? setTourClaudeModel : setTourCodexModel}
                  />
                </ConfigRow>
                {tourEngine === 'claude' && (
                  <ConfigRow label="Effort" stacked>
                    <SegmentedPicker options={CLAUDE_EFFORT} value={tourClaudeEffort} onChange={setTourClaudeEffort} />
                  </ConfigRow>
                )}
                {tourEngine === 'codex' && (
                  <>
                    <ConfigRow label="Reasoning" stacked>
                      <SegmentedPicker options={CODEX_REASONING} value={tourCodexReasoning} onChange={setTourCodexReasoning} />
                    </ConfigRow>
                    <ConfigRow label="Fast mode">
                      <Toggle checked={tourCodexFast} onChange={setTourCodexFast} />
                    </ConfigRow>
                  </>
                )}
              </>
            )}
          </div>

          <button
            onClick={handleLaunch}
            disabled={!selectedProvider}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary py-2 font-medium text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play size={11} />
            Run
          </button>
        </div>
      )}

      {/* Job list (scrolls; launch controls are pinned above) */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sortedJobs.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-center">
            <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-surface-1/50">
              <ReviewAgentsIcon className="h-4 w-4 text-muted-foreground/40" />
            </div>
            <p className="text-[11px] text-muted-foreground/40">No agent jobs</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/35">Launch an agent above</p>
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

      {/* Kill all — pinned at the bottom */}
      {runningCount >= 2 && (
        <div className="px-3 pb-2 pt-1">
          <button
            onClick={onKillAll}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 py-1.5 font-medium text-[10px] text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
          >
            <Square size={8} />
            Kill all ({runningCount})
          </button>
        </div>
      )}
    </div>
  );
};
