import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  Zap,
  Plus,
  Search,
} from 'lucide-react';
import type { AgentJobInfo, AgentCapabilities } from '../types';
import { isTerminalStatus } from '@plannotator/shared/agent-jobs';
import { cn } from '../lib/utils';
import { ReviewAgentsIcon } from './ReviewAgentsIcon';
import { ClaudeIcon, CodexIcon, CopilotIcon, CursorIcon, OpenCodeIcon, PiIcon } from './icons/AgentIcons';
import { useAgentSettings } from '../hooks/useAgentSettings';
import type { AgentEngine, AgentMode, ReviewEngine } from '../hooks/useAgentSettings';
import type { AgentLaunchParams } from '../hooks/useAgentJobs';
import { ConfigRow, SegmentedPicker, Toggle, SelectMenu } from './AgentControls';

export type { AgentLaunchParams } from '../hooks/useAgentJobs';

// --- Agent option catalogs (shared across review + tour engine dropdowns) ---

export const CLAUDE_MODELS: Array<{ value: string; label: string }> = [
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 (1M)' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M)' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const CLAUDE_EFFORT: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];

export const CODEX_MODELS: Array<{ value: string; label: string }> = [
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

export const CODEX_REASONING: Array<{ value: string; label: string }> = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

// Tour/guide Claude catalog: the CLI's latest-resolving aliases on top
// (verified against `claude --help`: "Provide an alias for the latest model
// (e.g. 'fable', 'opus', or 'sonnet') or a model's full name"), then every
// pinned version from the review catalog.
// Also reused by GuideEmptyState (packages/review-editor).
export const TOUR_CLAUDE_MODELS: Array<{ value: string; label: string }> = [
  { value: 'sonnet', label: 'Sonnet (latest)' },
  { value: 'opus', label: 'Opus (latest)' },
  { value: 'fable', label: 'Fable (latest)' },
  ...CLAUDE_MODELS,
];

// Fallback Cursor model catalog (just `auto`). The real, account-specific list
// is discovered server-side via `agent models` and delivered on the cursor
// capability; the component prefers that and only falls back to this when the
// server reports no models (e.g. unauthenticated CLI). Used by formatModel for
// job-card labels where the live list isn't threaded.
const CURSOR_MODELS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto' },
];

// Fallback OpenCode model catalog. The real list is discovered server-side via
// `opencode models` and delivered on the opencode capability; empty value means
// "use OpenCode's configured default".
const OPENCODE_MODELS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
];

// Fallback Pi model catalog. The real list is discovered server-side and
// delivered on the pi capability; empty value means "use Pi's own default".
const PI_MODELS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
];

// Fallback Copilot model catalog. The real list is discovered server-side via
// `copilot help config`; empty value means "let Copilot pick".
const COPILOT_MODELS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
];

// Pi's unified reasoning knob (`--thinking`), applied to whichever model is
// selected. xhigh is accepted only by codex-max models.
export const PI_THINKING: Array<{ value: string; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Min' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

const MODE_LABEL: Record<AgentMode, string> = {
  review: 'Code Review',
  tour: 'Code Tour',
  guide: 'Guided Review',
};

const ENGINE_LABEL: Record<AgentEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

const ENGINE_ICON: Record<AgentEngine, React.FC<{ className?: string }>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
};

// Review-only label map. Keeps Tour's narrow AgentEngine maps valid while the
// review surface offers the wider set (Cursor/OpenCode). Exported so the guide
// takeover surfaces (GuideScreen, GuideEmptyState in packages/review-editor)
// share this one source of truth instead of keeping their own copies in sync.
export const REVIEW_ENGINE_LABEL: Record<ReviewEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'Pi',
  copilot: 'Copilot',
};

// Review-only icon map — the wide set. Tour keeps the narrow ENGINE_ICON.
const REVIEW_ENGINE_ICON: Record<ReviewEngine, React.FC<{ className?: string }>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
  pi: PiIcon,
  copilot: CopilotIcon,
};

export type AgentLaunchResult = AgentJobInfo | null | void;

interface AgentsTabProps {
  jobs: AgentJobInfo[];
  capabilities: AgentCapabilities | null;
  onLaunch: (params: AgentLaunchParams) => AgentLaunchResult | Promise<AgentLaunchResult>;
  onKillJob: (id: string) => void;
  onKillAll: () => void;
  externalAnnotations: Array<{ source?: string }>;
  onOpenJobDetail?: (jobId: string) => void;
  onOpenGuide?: (jobId: string) => void;
  /** Whether the current diff has any files a guide could reference — mirrors
   *  the review-editor header's `hasSearchableFiles` gate (the "Guide" badge
   *  and its keyboard shortcut). A guide organizes changed files into
   *  chapters, so with none available there is nothing for it to do; default
   *  true so callers that don't pass it (e.g. the plan editor, which has no
   *  concept of "files") see unchanged behavior. */
  guideLaunchable?: boolean;
  /** Whether a given guide job's artifact can be opened from HERE — i.e. it
   *  belongs to the review context currently on screen. The job list spans
   *  every context visited this session, but opening only sets
   *  activeGuideJobId/guideOpen (it does NOT switch PRs), so a cross-context
   *  "Open guide" would land on the wrong guide or the empty state. Default
   *  undefined ⇒ always openable (non-review callers have no contexts). */
  canOpenGuideJob?: (job: AgentJobInfo) => boolean;
}

// --- Duration display ---
// Exported so other agent-job surfaces (e.g. GuideGenerating in
// review-editor) share this one implementation instead of keeping their own
// copies in sync.

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function ElapsedTime({ startedAt }: { startedAt: number }) {
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
  if (provider === 'cursor') return catalogLabel(CURSOR_MODELS, model);
  if (provider === 'opencode') return model ? model : 'Default';
  if (provider === 'pi') return model || 'Default';
  if (provider === 'copilot') return model || 'Default';
  if (provider === 'codex' || engine === 'codex') return catalogLabel(CODEX_MODELS, model);
  if ((provider === 'tour' || provider === 'guide') && engine === 'claude') return catalogLabel(TOUR_CLAUDE_MODELS, model);
  if (provider === 'tour' || provider === 'guide') {
    if (engine === 'cursor') return catalogLabel(CURSOR_MODELS, model);
    if (engine === 'opencode' || engine === 'pi' || engine === 'copilot') return model || 'Default';
  }
  return catalogLabel(CLAUDE_MODELS, model);
}

function formatThinking(value: string): string {
  return catalogLabel(PI_THINKING, value);
}


function formatEffort(value: string): string {
  return catalogLabel(CLAUDE_EFFORT, value);
}

function formatReasoning(value: string): string {
  return catalogLabel(CODEX_REASONING, value);
}

// --- Add-a-review dialog: a type-ahead picker over every discovered skill ---

interface CatalogSkill {
  name: string;
  root: string;
  sourcePath: string;
  enabled: boolean;
}

function AddReviewDialog({
  onClose,
  onEnabled,
}: {
  onClose: () => void;
  onEnabled: (name: string) => void;
}) {
  const [skills, setSkills] = useState<CatalogSkill[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/agents/skills')
      .then((r) => r.json())
      .then((d) => {
        if (alive) setSkills(Array.isArray(d.skills) ? d.skills : []);
      })
      .catch(() => {
        if (alive) setSkills([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills ?? [])
      .filter((s) => !s.enabled)
      .filter((s) => (q ? s.name.toLowerCase().includes(q) : true));
  }, [skills, query]);

  const enable = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      const res = await fetch('/api/agents/review-skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Could not add review.');
      }
      onEnabled(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add review.');
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex max-h-[70vh] w-full max-w-sm flex-col overflow-hidden rounded-xl bg-card shadow-[var(--card-shadow)] ring-1 ring-border/20">
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-2.5">
          <span className="text-[12px] font-medium text-foreground">Add a review</span>
          <button type="button" onClick={onClose} className="text-muted-foreground/50 hover:text-foreground">
            <X size={13} />
          </button>
        </div>

        <div className="border-b border-border/40 p-2">
          <div className="flex items-center gap-2 rounded-lg border border-border/30 bg-surface-1/30 px-2.5 py-1.5">
            <Search className="shrink-0 text-muted-foreground/40" size={12} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter your skills"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground/90 outline-none placeholder:text-muted-foreground/40"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {skills === null ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground/40">
              <Loader2 className="animate-spin" size={14} />
            </div>
          ) : candidates.length === 0 ? (
            <p className="px-2 py-8 text-center text-[11px] text-muted-foreground/40">
              {query ? 'No matching skills.' : 'No skills left to add.'}
            </p>
          ) : (
            candidates.map((s) => (
              <button
                key={`${s.root}:${s.name}`}
                type="button"
                disabled={busy !== null}
                onClick={() => enable(s.name)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-1/50 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">{s.name}</span>
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/40">{s.root}</span>
                {busy === s.name ? <Loader2 className="shrink-0 animate-spin" size={11} /> : <Plus className="shrink-0 text-muted-foreground/40" size={11} />}
              </button>
            ))
          )}
        </div>

        {error && <p className="border-t border-border/40 px-3 py-2 text-[10px] text-red-500">{error}</p>}
      </div>
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
  onOpenGuide,
}: {
  job: AgentJobInfo;
  annotationCount: number;
  onKill: () => void;
  expanded: boolean;
  onToggle: () => void;
  onViewDetails?: () => void;
  onOpenGuide?: () => void;
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
            {job.thinking && <span className="rounded bg-surface-1 px-1 py-px">{formatThinking(job.thinking)}</span>}
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

      {/* Open guide — a completed guide job's direct affordance into the takeover. */}
      {job.provider === 'guide' && job.status === 'done' && onOpenGuide && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenGuide();
          }}
          className="mt-2 flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 font-medium text-[10px] text-primary transition-colors hover:bg-primary/20"
        >
          Open guide
        </button>
      )}
    </div>
  );
}

function PendingLaunchCard({
  label,
  provider,
  startedAt,
}: {
  label: string;
  provider?: string;
  startedAt: number;
}) {
  return (
    <div className="rounded-lg bg-primary/5 px-2.5 py-2 ring-1 ring-primary/10">
      <div className="flex items-start gap-2.5">
        <StatusSquare status="starting" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-[12px] text-foreground">{label}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-muted-foreground/50">
            {provider && <span className="rounded bg-surface-1 px-1 py-px">{provider}</span>}
            <span>requesting launch</span>
            <span className="text-muted-foreground/30">·</span>
            <span className="tabular-nums"><ElapsedTime startedAt={startedAt} /></span>
          </div>
        </div>
      </div>
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
  onOpenGuide,
  guideLaunchable = true,
  canOpenGuideJob,
}) => {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<{ label: string; provider?: string; startedAt: number } | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const launchingRef = useRef(false);
  const settings = useAgentSettings();
  const {
    selectedMode,
    reviewEngine,
    reviewProfileId,
    tourEngine,
    guideEngine,
    claudeModel,
    claudeEffort,
    codexModel,
    codexReasoning,
    codexFast,
    cursorModel,
    opencodeModel,
    piModel,
    piThinking,
    copilotModel,
    tourClaudeModel,
    tourClaudeEffort,
    tourCodexModel,
    tourCodexReasoning,
    tourCodexFast,
    guideClaudeModel,
    guideClaudeEffort,
    guideCodexModel,
    guideCodexReasoning,
    guideCursorModel,
    guideOpencodeModel,
    guidePiModel,
    guidePiThinking,
    guideCopilotModel,
    setSelectedMode,
    setReviewEngine,
    setReviewProfileId,
    setTourEngine,
    setGuideEngine,
    setClaudeModel,
    setClaudeEffort,
    setCodexModel,
    setCodexReasoning,
    setCodexFast,
    setCursorModel,
    setOpencodeModel,
    setPiModel,
    setPiThinking,
    setCopilotModel,
    setTourClaudeModel,
    setTourClaudeEffort,
    setTourCodexModel,
    setTourCodexReasoning,
    setTourCodexFast,
    setGuideClaudeModel,
    setGuideClaudeEffort,
    setGuideCodexModel,
    setGuideCodexReasoning,
    setGuideCursorModel,
    setGuideOpencodeModel,
    setGuidePiModel,
    setGuidePiThinking,
    setGuideCopilotModel,
  } = settings;

  // Review profiles (built-in default plus the user's enabled skills). Loaded
  // from the discovery endpoint and refreshed after a skill is added.
  const [reviewProfiles, setReviewProfiles] = useState<Array<{ id: string; label: string; default?: boolean }>>([
    { id: 'builtin:default', label: 'Default', default: true },
  ]);
  // Until the list has loaded we can't tell a saved custom pick from a removed
  // one, so a launch in that window would silently fall back to Default. Gate
  // launch on this for a custom pick (see canLaunch).
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [addReviewOpen, setAddReviewOpen] = useState(false);

  const refreshReviewProfiles = useCallback(() => {
    fetch('/api/agents/review-profiles')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.profiles) && d.profiles.length > 0) setReviewProfiles(d.profiles);
      })
      .catch(() => {})
      .finally(() => setProfilesLoaded(true));
  }, []);

  useEffect(() => {
    refreshReviewProfiles();
  }, [refreshReviewProfiles]);

  const claudeAvailable = capabilities?.providers.some((p) => p.id === 'claude' && p.available) ?? false;
  const codexAvailable = capabilities?.providers.some((p) => p.id === 'codex' && p.available) ?? false;
  const tourAvailable = capabilities?.providers.some((p) => p.id === 'tour' && p.available) ?? false;
  const guideAvailable = capabilities?.providers.some((p) => p.id === 'guide' && p.available) ?? false;
  const cursorAvailable = capabilities?.providers.some((p) => p.id === 'cursor' && p.available) ?? false;
  const opencodeAvailable = capabilities?.providers.some((p) => p.id === 'opencode' && p.available) ?? false;
  const piAvailable = capabilities?.providers.some((p) => p.id === 'pi' && p.available) ?? false;
  const copilotAvailable = capabilities?.providers.some((p) => p.id === 'copilot' && p.available) ?? false;

  // Cursor's model catalog is account-specific and discovered server-side, so
  // prefer the live list from the capability; fall back to `auto`-only when the
  // server reports none (e.g. unauthenticated CLI).
  const cursorModels = useMemo<Array<{ value: string; label: string }>>(() => {
    const discovered = capabilities?.providers.find((p) => p.id === 'cursor')?.models ?? [];
    const opts = discovered.map((m) => ({ value: m.id, label: m.label }));
    return opts.length > 0 ? opts : CURSOR_MODELS;
  }, [capabilities]);

  // OpenCode models discovered server-side via `opencode models`; prepend the
  // "Default" option so the user can leave the model to OpenCode's config.
  const opencodeModels = useMemo<Array<{ value: string; label: string }>>(() => {
    const discovered = capabilities?.providers.find((p) => p.id === 'opencode')?.models ?? [];
    const opts = discovered.map((m) => ({ value: m.id, label: m.label }));
    return opts.length > 0 ? [...OPENCODE_MODELS, ...opts] : OPENCODE_MODELS;
  }, [capabilities]);

  // Pi models discovered server-side; prepend the "Default" option so the user
  // can leave the model to Pi's own default (same convention as OpenCode).
  const piModels = useMemo<Array<{ value: string; label: string }>>(() => {
    const discovered = capabilities?.providers.find((p) => p.id === 'pi')?.models ?? [];
    const opts = discovered.map((m) => ({ value: m.id, label: m.label }));
    return opts.length > 0 ? [...PI_MODELS, ...opts] : PI_MODELS;
  }, [capabilities]);

  // Copilot models discovered server-side via `copilot help config`; prepend
  // the "Default" option so the user can leave the model to Copilot's own pick.
  const copilotModels = useMemo<Array<{ value: string; label: string }>>(() => {
    const discovered = capabilities?.providers.find((p) => p.id === 'copilot')?.models ?? [];
    const opts = discovered.map((m) => ({ value: m.id, label: m.label }));
    return opts.length > 0 ? [...COPILOT_MODELS, ...opts] : COPILOT_MODELS;
  }, [capabilities]);

  // Tour engines (narrow union). Cursor is NOT included here — it is review-only.
  const availableEngines = useMemo<AgentEngine[]>(() => {
    const engines: AgentEngine[] = [];
    if (claudeAvailable) engines.push('claude');
    if (codexAvailable) engines.push('codex');
    return engines;
  }, [claudeAvailable, codexAvailable]);

  // Review engines (wide union) = tour engines + cursor/opencode when available.
  const availableReviewEngines = useMemo<ReviewEngine[]>(() => {
    const engines: ReviewEngine[] = [...availableEngines];
    if (cursorAvailable) engines.push('cursor');
    if (opencodeAvailable) engines.push('opencode');
    if (piAvailable) engines.push('pi');
    if (copilotAvailable) engines.push('copilot');
    return engines;
  }, [availableEngines, cursorAvailable, opencodeAvailable, piAvailable, copilotAvailable]);

  const availableModes = useMemo<AgentMode[]>(() => {
    const modes: AgentMode[] = [];
    if (availableReviewEngines.length > 0) modes.push('review');
    if (tourAvailable && availableEngines.length > 0) modes.push('tour');
    // Guide runs on the wide union — marker engines generate guides too.
    // Also gated on guideLaunchable: a guide organizes changed files into
    // chapters, so it has nothing to do against a diff with no files (same
    // gate the review-editor header applies to the "Guide" badge/shortcut).
    if (guideAvailable && availableReviewEngines.length > 0 && guideLaunchable) modes.push('guide');
    return modes;
  }, [availableReviewEngines.length, availableEngines.length, tourAvailable, guideAvailable, guideLaunchable]);
  // (availableReviewEngines.length covers the guide gate above.)

  const firstAvailableEngine = availableEngines[0] ?? null;
  const firstAvailableReviewEngine = availableReviewEngines[0] ?? null;
  const engineAvailable = (engine: AgentEngine) => engine === 'claude' ? claudeAvailable : codexAvailable;
  const reviewEngineAvailable = (engine: ReviewEngine) =>
    engine === 'cursor' ? cursorAvailable
      : engine === 'opencode' ? opencodeAvailable
      : engine === 'pi' ? piAvailable
      : engine === 'copilot' ? copilotAvailable
      : engineAvailable(engine);

  // Reconcile mode + engine choices against live capabilities. Runs when
  // capabilities change or the stored selection becomes invalid.
  useEffect(() => {
    if (!capabilities || availableModes.length === 0) return;
    if (!selectedMode || !availableModes.includes(selectedMode)) {
      setSelectedMode(availableModes[0]);
    }
    if (firstAvailableReviewEngine && !reviewEngineAvailable(reviewEngine)) {
      setReviewEngine(firstAvailableReviewEngine);
    }
    if (firstAvailableEngine && !engineAvailable(tourEngine)) {
      setTourEngine(firstAvailableEngine);
    }
    if (firstAvailableReviewEngine && !reviewEngineAvailable(guideEngine)) {
      setGuideEngine(firstAvailableReviewEngine);
    }
  }, [
    capabilities,
    availableModes,
    firstAvailableEngine,
    firstAvailableReviewEngine,
    selectedMode,
    reviewEngine,
    tourEngine,
    guideEngine,
    setSelectedMode,
    setReviewEngine,
    setTourEngine,
    setGuideEngine,
  ]);

  // Reconcile the saved Cursor/OpenCode model against the live catalog: a
  // persisted id can go stale after an account switch or discovery loss, and
  // posting it would fail the launch. Collapse it to the first option (auto/
  // Default) when it's no longer offered. Each effect also reconciles the
  // guide-scoped counterpart against the SAME catalog and availability guard
  // — the catalog is per-engine, not per-surface, so review and guide share
  // it here even though their model selections are kept independent.
  useEffect(() => {
    // Only once the engine is actually available — before capabilities load,
    // cursorModels is just the fallback, and reconciling here would wipe a valid
    // saved model before the live catalog arrives.
    if (!cursorAvailable) return;
    if (!cursorModels.some((m) => m.value === cursorModel)) {
      setCursorModel(cursorModels[0]?.value ?? 'auto');
    }
    if (!cursorModels.some((m) => m.value === guideCursorModel)) {
      setGuideCursorModel(cursorModels[0]?.value ?? 'auto');
    }
  }, [cursorAvailable, cursorModels, cursorModel, setCursorModel, guideCursorModel, setGuideCursorModel]);
  useEffect(() => {
    if (!opencodeAvailable) return;
    if (!opencodeModels.some((m) => m.value === opencodeModel)) {
      setOpencodeModel(opencodeModels[0]?.value ?? '');
    }
    if (!opencodeModels.some((m) => m.value === guideOpencodeModel)) {
      setGuideOpencodeModel(opencodeModels[0]?.value ?? '');
    }
  }, [opencodeAvailable, opencodeModels, opencodeModel, setOpencodeModel, guideOpencodeModel, setGuideOpencodeModel]);
  useEffect(() => {
    if (!piAvailable) return;
    if (!piModels.some((m) => m.value === piModel)) {
      setPiModel(piModels[0]?.value ?? '');
    }
    if (!piModels.some((m) => m.value === guidePiModel)) {
      setGuidePiModel(piModels[0]?.value ?? '');
    }
  }, [piAvailable, piModels, piModel, setPiModel, guidePiModel, setGuidePiModel]);
  useEffect(() => {
    if (!copilotAvailable) return;
    if (!copilotModels.some((m) => m.value === copilotModel)) {
      setCopilotModel(copilotModels[0]?.value ?? '');
    }
    if (!copilotModels.some((m) => m.value === guideCopilotModel)) {
      setGuideCopilotModel(copilotModels[0]?.value ?? '');
    }
  }, [copilotAvailable, copilotModels, copilotModel, setCopilotModel, guideCopilotModel, setGuideCopilotModel]);

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

  // A persisted review id can point at something not in the current list: the
  // profiles may not be loaded yet, or the skill was removed by hand. Treat
  // anything not in the list as Default, for both the dropdown and the launch.
  const effectiveReviewProfileId = reviewProfiles.some((p) => p.id === reviewProfileId)
    ? reviewProfileId
    : 'builtin:default';

  type LaunchParams = AgentLaunchParams;
  const buildReviewLaunch = (engine: ReviewEngine): LaunchParams => {
    // Carry the chosen review only when it is a custom one. Absent → the server
    // resolves to the built-in default.
    const review = effectiveReviewProfileId !== 'builtin:default' ? { reviewProfileId: effectiveReviewProfileId } : {};
    if (engine === 'claude') {
      return { provider: 'claude', label: 'Code Review', model: claudeModel, effort: claudeEffort, ...review };
    }
    if (engine === 'cursor') {
      // Omission ⇒ auto: drop the model client-side when it's `auto` so the POST
      // carries no model and the server lets Cursor pick its default.
      return {
        provider: 'cursor',
        label: 'Code Review',
        ...(cursorModel && cursorModel.toLowerCase() !== 'auto' ? { model: cursorModel } : {}),
        ...review,
      };
    }
    if (engine === 'opencode') {
      // Empty model ⇒ OpenCode's configured default; only send a real model id.
      return {
        provider: 'opencode',
        label: 'Code Review',
        ...(opencodeModel ? { model: opencodeModel } : {}),
        ...review,
      };
    }
    if (engine === 'pi') {
      // Empty model ⇒ Pi's own default; only send a real model id.
      return {
        provider: 'pi',
        label: 'Code Review',
        ...(piModel ? { model: piModel } : {}),
        thinking: piThinking,
        ...review,
      };
    }
    if (engine === 'copilot') {
      // Empty model ⇒ Copilot's own pick; only send a real model id.
      return {
        provider: 'copilot',
        label: 'Code Review',
        ...(copilotModel ? { model: copilotModel } : {}),
        ...review,
      };
    }
    return {
      provider: 'codex',
      label: 'Code Review',
      model: codexModel,
      reasoningEffort: codexReasoning,
      ...(codexFast && { fastMode: true }),
      ...review,
    };
  };
  const buildTourLaunch = (): LaunchParams => ({
    provider: 'tour',
    label: 'Code Tour',
    engine: tourEngine,
    model: tourEngine === 'claude' ? tourClaudeModel : tourCodexModel,
    ...(tourEngine === 'claude'
      ? { effort: tourClaudeEffort }
      : { reasoningEffort: tourCodexReasoning, ...(tourCodexFast && { fastMode: true }) }),
  });
  const buildGuideLaunch = (): LaunchParams => {
    if (guideEngine === 'cursor') {
      // Same omission rules as buildReviewLaunch: auto/empty ⇒ engine default.
      // Guide-scoped model — deliberately NOT the shared cursorModel (see
      // guideCursorModel's definition in useAgentSettings).
      return {
        provider: 'guide',
        label: 'Guided Review',
        engine: 'cursor',
        ...(guideCursorModel && guideCursorModel.toLowerCase() !== 'auto' ? { model: guideCursorModel } : {}),
      };
    }
    if (guideEngine === 'opencode') {
      return {
        provider: 'guide',
        label: 'Guided Review',
        engine: 'opencode',
        ...(guideOpencodeModel ? { model: guideOpencodeModel } : {}),
      };
    }
    if (guideEngine === 'pi') {
      return {
        provider: 'guide',
        label: 'Guided Review',
        engine: 'pi',
        ...(guidePiModel ? { model: guidePiModel } : {}),
        thinking: guidePiThinking,
      };
    }
    if (guideEngine === 'copilot') {
      return {
        provider: 'guide',
        label: 'Guided Review',
        engine: 'copilot',
        ...(guideCopilotModel ? { model: guideCopilotModel } : {}),
      };
    }
    return {
      provider: 'guide',
      label: 'Guided Review',
      engine: guideEngine,
      model: guideEngine === 'claude' ? guideClaudeModel : guideCodexModel,
      ...(guideEngine === 'claude'
        ? { effort: guideClaudeEffort }
        : { reasoningEffort: guideCodexReasoning }),
    };
  };

  // For a custom pick, hold launch until the profile list has loaded — otherwise
  // the saved id can't be found yet and the launch would quietly run Default. A
  // Default pick has nothing to resolve, so it never waits.
  const reviewReady = profilesLoaded || reviewProfileId === 'builtin:default';
  const canLaunch = selectedMode === 'review'
    ? reviewEngineAvailable(reviewEngine) && reviewReady
    : selectedMode === 'tour'
      ? tourAvailable && engineAvailable(tourEngine)
      : selectedMode === 'guide'
        ? guideAvailable && reviewEngineAvailable(guideEngine) && guideLaunchable
        : false;

  const handleLaunch = async () => {
    if (!canLaunch || launchingRef.current) return;
    const params = selectedMode === 'review'
      ? buildReviewLaunch(reviewEngine)
      : selectedMode === 'tour'
        ? buildTourLaunch()
        : buildGuideLaunch();
    launchingRef.current = true;
    setPendingLaunch({
      label: params.label ?? 'Agent job',
      ...(params.provider && { provider: params.provider }),
      startedAt: Date.now(),
    });
    setLaunchError(null);

    try {
      const result = await onLaunch(params);
      if (result === null) {
        setLaunchError('Could not start agent job.');
      }
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'Could not start agent job.');
    } finally {
      launchingRef.current = false;
      setPendingLaunch(null);
    }
  };

  const modeOptions = availableModes.map((mode) => ({ value: mode, label: MODE_LABEL[mode] }));
  const renderStaticChoice = (label: string, icon?: React.ReactNode) => (
    <div className="flex items-center gap-2 rounded-lg border border-border/30 bg-surface-1/30 px-2.5 py-1.5">
      {icon}
      <span className="text-[11px] text-foreground/80">{label}</span>
    </div>
  );

  // Icon-button engine row, shared by Tour (narrow claude/codex set) and Review
  // (wide claude/codex/cursor/opencode set). The caller passes the engine list
  // plus its icon/label maps so the same control renders four equal options for
  // Review exactly as it renders two for Tour.
  function renderEngineSelect<E extends string>(
    value: E,
    onChange: (engine: E) => void,
    engines: E[],
    iconMap: Record<E, React.FC<{ className?: string }>>,
    labelMap: Record<E, string>,
    configLabel: string = 'Engine',
  ) {
    const StaticIcon: React.FC<{ className?: string }> = iconMap[value];
    return (
      <ConfigRow label={configLabel} stacked>
        {engines.length > 1 ? (
          // Tap an agent's mark to pick it — no dropdown.
          <div className="flex items-center gap-1.5">
            {engines.map((engine) => {
              const Icon: React.FC<{ className?: string }> = iconMap[engine];
              const selected = value === engine;
              return (
                <button
                  key={engine}
                  type="button"
                  onClick={() => onChange(engine)}
                  title={labelMap[engine]}
                  aria-label={labelMap[engine]}
                  aria-pressed={selected}
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-lg border transition-all',
                    selected
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border/30 bg-surface-1/30 opacity-40 hover:opacity-100',
                  )}
                >
                  <Icon className="h-5 w-5" />
                </button>
              );
            })}
          </div>
        ) : (
          renderStaticChoice(labelMap[value], <StaticIcon className="h-4 w-4" />)
        )}
      </ConfigRow>
    );
  }

  // Cursor and OpenCode share the same review config: an "experimental" note and
  // a single model picker driven by their live (or fallback) catalog.
  const renderMarkerEngineConfig = (
    model: string,
    models: Array<{ value: string; label: string }>,
    setModel: (value: string) => void,
  ) => (
    <>
      <div className="flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400">
        <span className="rounded bg-amber-500/10 px-1 py-px font-medium">experimental</span>
        <span className="text-muted-foreground/50">Findings are prompt-enforced</span>
      </div>
      <ConfigRow label="Model" stacked>
        {models.length > 1 ? (
          <SelectMenu value={model} options={models} onChange={setModel} />
        ) : (
          renderStaticChoice(catalogLabel(models, model))
        )}
      </ConfigRow>
    </>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Launch panel (pinned to the top) */}
      {availableModes.length > 0 && (
        <div className="border-b border-border/40 p-3">
          <div className="mb-2 font-medium text-[9px] uppercase tracking-wider text-muted-foreground/40">
            Launch agent
          </div>

          <div className="space-y-2">
            {availableModes.length > 1 ? (
              <SelectMenu
                value={selectedMode ?? ''}
                options={modeOptions}
                onChange={(next) => setSelectedMode(next as AgentMode)}
                icon={<Bot className="shrink-0 text-muted-foreground/50" size={12} />}
                placeholder="Select mode"
              />
            ) : (
              renderStaticChoice(
                availableModes[0] ? MODE_LABEL[availableModes[0]] : '',
                <Bot className="shrink-0 text-muted-foreground/50" size={12} />,
              )
            )}

            {selectedMode === 'review' && (
              <>
                {/* Provider (engine) picker — icon-button row over the wide set
                    (claude/codex/cursor/opencode), above the review selector. */}
                {renderEngineSelect(
                  reviewEngine,
                  setReviewEngine,
                  availableReviewEngines,
                  REVIEW_ENGINE_ICON,
                  REVIEW_ENGINE_LABEL,
                  'Provider',
                )}
                <ConfigRow label="Review" stacked>
                  <SelectMenu
                    value={effectiveReviewProfileId}
                    options={reviewProfiles.map((p) => ({ value: p.id, label: p.label }))}
                    onChange={setReviewProfileId}
                    footerAction={{ label: 'Add new review', onClick: () => setAddReviewOpen(true) }}
                  />
                </ConfigRow>
                {reviewEngine === 'claude' && (
                  <>
                    <ConfigRow label="Model" stacked>
                      <SelectMenu value={claudeModel} options={CLAUDE_MODELS} onChange={setClaudeModel} />
                    </ConfigRow>
                    <ConfigRow label="Effort" stacked>
                      <SegmentedPicker options={CLAUDE_EFFORT} value={claudeEffort} onChange={setClaudeEffort} />
                    </ConfigRow>
                  </>
                )}
                {reviewEngine === 'codex' && (
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
                {reviewEngine === 'cursor' && renderMarkerEngineConfig(cursorModel, cursorModels, setCursorModel)}
                {reviewEngine === 'opencode' && renderMarkerEngineConfig(opencodeModel, opencodeModels, setOpencodeModel)}
                {reviewEngine === 'pi' && (
                  <>
                    {renderMarkerEngineConfig(piModel, piModels, setPiModel)}
                    <ConfigRow label="Thinking" stacked>
                      <SegmentedPicker options={PI_THINKING} value={piThinking} onChange={setPiThinking} />
                    </ConfigRow>
                  </>
                )}
                {reviewEngine === 'copilot' && renderMarkerEngineConfig(copilotModel, copilotModels, setCopilotModel)}
              </>
            )}

            {selectedMode === 'tour' && (
              <>
                {renderEngineSelect(tourEngine, setTourEngine, availableEngines, ENGINE_ICON, ENGINE_LABEL)}
                <ConfigRow label="Model" stacked>
                  <SelectMenu
                    value={tourEngine === 'claude' ? tourClaudeModel : tourCodexModel}
                    options={tourEngine === 'claude' ? TOUR_CLAUDE_MODELS : CODEX_MODELS}
                    onChange={tourEngine === 'claude' ? setTourClaudeModel : setTourCodexModel}
                  />
                </ConfigRow>

                {/* Claude-only: effort level */}
                {tourEngine === 'claude' && (
                  <ConfigRow label="Effort" stacked>
                    <SegmentedPicker options={CLAUDE_EFFORT} value={tourClaudeEffort} onChange={setTourClaudeEffort} />
                  </ConfigRow>
                )}

                {/* Codex-only: reasoning effort + fast mode */}
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

            {selectedMode === 'guide' && (
              <>
                {renderEngineSelect(guideEngine, setGuideEngine, availableReviewEngines, REVIEW_ENGINE_ICON, REVIEW_ENGINE_LABEL)}
                {(guideEngine === 'claude' || guideEngine === 'codex') && (
                  <ConfigRow label="Model" stacked>
                    <SelectMenu
                      value={guideEngine === 'claude' ? guideClaudeModel : guideCodexModel}
                      options={guideEngine === 'claude' ? TOUR_CLAUDE_MODELS : CODEX_MODELS}
                      onChange={guideEngine === 'claude' ? setGuideClaudeModel : setGuideCodexModel}
                    />
                  </ConfigRow>
                )}

                {/* Claude-only: effort level */}
                {guideEngine === 'claude' && (
                  <ConfigRow label="Effort" stacked>
                    <SegmentedPicker options={CLAUDE_EFFORT} value={guideClaudeEffort} onChange={setGuideClaudeEffort} />
                  </ConfigRow>
                )}

                {/* Codex-only: reasoning effort. No "Fast mode" toggle here
                    (unlike review/tour's codex blocks above) — fast mode is
                    deliberately not offered for guide. */}
                {guideEngine === 'codex' && (
                  <ConfigRow label="Reasoning" stacked>
                    <SegmentedPicker options={CODEX_REASONING} value={guideCodexReasoning} onChange={setGuideCodexReasoning} />
                  </ConfigRow>
                )}

                {/* Marker engines: same live-catalog model picker as review mode,
                    but bound to the guide-scoped settings (see useAgentSettings) so
                    tuning these doesn't change the next Cursor/OpenCode/Pi review. */}
                {guideEngine === 'cursor' && renderMarkerEngineConfig(guideCursorModel, cursorModels, setGuideCursorModel)}
                {guideEngine === 'opencode' && renderMarkerEngineConfig(guideOpencodeModel, opencodeModels, setGuideOpencodeModel)}
                {guideEngine === 'pi' && (
                  <>
                    {renderMarkerEngineConfig(guidePiModel, piModels, setGuidePiModel)}
                    <ConfigRow label="Thinking" stacked>
                      <SegmentedPicker options={PI_THINKING} value={guidePiThinking} onChange={setGuidePiThinking} />
                    </ConfigRow>
                  </>
                )}
                {guideEngine === 'copilot' && renderMarkerEngineConfig(guideCopilotModel, copilotModels, setGuideCopilotModel)}
              </>
            )}
          </div>

          <button
            onClick={handleLaunch}
            disabled={!canLaunch || pendingLaunch !== null}
            aria-busy={pendingLaunch !== null}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary py-2 font-medium text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pendingLaunch ? <Loader2 className="animate-spin" size={11} /> : <Play size={11} />}
            {pendingLaunch ? 'Starting...' : 'Run'}
          </button>
          {launchError && (
            <p className="mt-2 text-[10px] leading-snug text-destructive/80">
              {launchError}
            </p>
          )}
        </div>
      )}

      {/* Job list (scrolls; launch controls are pinned above) */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {pendingLaunch && (
          <PendingLaunchCard
            label={pendingLaunch.label}
            provider={pendingLaunch.provider}
            startedAt={pendingLaunch.startedAt}
          />
        )}
        {sortedJobs.length === 0 && !pendingLaunch ? (
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
              onOpenGuide={onOpenGuide && (canOpenGuideJob?.(job) ?? true) ? () => onOpenGuide(job.id) : undefined}
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

      {addReviewOpen && (
        <AddReviewDialog
          onClose={() => setAddReviewOpen(false)}
          onEnabled={(name) => {
            const id = `skill:${name}`;
            // Add optimistically so the dropdown can select it immediately; the
            // refresh below reconciles against the server.
            setReviewProfiles((prev) => (prev.some((p) => p.id === id) ? prev : [...prev, { id, label: name }]));
            setReviewProfileId(id);
            setAddReviewOpen(false);
            refreshReviewProfiles();
          }}
        />
      )}
    </div>
  );
};
