import React, { useMemo, useState, useEffect, useCallback } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { SEVERITY_STYLES, type AgentJobInfo, type CodeAnnotation } from '@plannotator/ui/types';
import { isTerminalStatus } from '@plannotator/shared/agent-jobs';
import { useReviewState } from '../ReviewStateContext';
import { useJobLogs } from '../JobLogsContext';
import { CopyButton } from '../../components/CopyButton';
import { LiveLogViewer } from '../../components/LiveLogViewer';
import { ScrollFade } from '../../components/ScrollFade';
import { exportReviewFeedback } from '../../utils/exportFeedback';

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

type DetailTab = 'findings' | 'logs';

const SEVERITY_ORDER: Record<string, number> = { important: 0, nit: 1, pre_existing: 2 };

export const ReviewAgentJobDetailPanel: React.FC<IDockviewPanelProps> = (props) => {
  const jobId: string = props.params?.jobId ?? '';
  const state = useReviewState();

  const job = useMemo(
    () => state.agentJobs.find((j) => j.id === jobId) ?? null,
    [state.agentJobs, jobId]
  );

  const terminal = job ? isTerminalStatus(job.status) : false;
  const isTour = job?.provider === 'tour';
  const [activeTab, setActiveTab] = useState<DetailTab>(isTour ? 'logs' : 'findings');

  const { fullCommand, userMessage, systemPrompt } = useMemo(() => {
    const cmd = job?.command ?? [];
    const full = cmd.join(' ');

    // Use job.prompt if available (stored explicitly for all providers),
    // fallback to parsing last command arg (legacy Codex behavior)
    const promptText = job?.prompt || (cmd.length > 0 ? cmd[cmd.length - 1] : '');
    const sep = '\n\n---\n\n';
    const i = promptText.indexOf(sep);
    return {
      fullCommand: full,
      userMessage: i !== -1 ? promptText.substring(i + sep.length) : promptText,
      systemPrompt: i !== -1 ? promptText.substring(0, i) : '',
    };
  }, [job]);

  const [annotationSnapshot, setAnnotationSnapshot] = useState<
    Map<string, { annotation: CodeAnnotation; dismissed: boolean }>
  >(new Map());

  useEffect(() => {
    if (!job) return;
    const currentIds = new Set(
      state.externalAnnotations.filter((a) => a.source === job.source).map((a) => a.id)
    );
    setAnnotationSnapshot((prev) => {
      const next = new Map(prev);
      for (const ann of state.externalAnnotations) {
        if (ann.source !== job.source) continue;
        next.set(ann.id, { annotation: ann as CodeAnnotation, dismissed: false });
      }
      for (const [id, entry] of next) {
        if (!entry.dismissed && !currentIds.has(id)) next.set(id, { ...entry, dismissed: true });
      }
      return next;
    });
  }, [state.externalAnnotations, job]);

  const displayAnnotations = useMemo(() =>
    Array.from(annotationSnapshot.values()).sort((a, b) => {
      if (a.dismissed !== b.dismissed) return a.dismissed ? 1 : -1;
      // Sort by severity (important first), then file path, then line
      const sa = SEVERITY_ORDER[a.annotation.severity ?? ''] ?? 3;
      const sb = SEVERITY_ORDER[b.annotation.severity ?? ''] ?? 3;
      if (sa !== sb) return sa - sb;
      return a.annotation.filePath.localeCompare(b.annotation.filePath) || a.annotation.lineStart - b.annotation.lineStart;
    }),
  [annotationSnapshot]);

  const activeAnnotations = useMemo(() => displayAnnotations.filter((d) => !d.dismissed).map((d) => d.annotation), [displayAnnotations]);
  const dismissedCount = useMemo(() => displayAnnotations.filter((d) => d.dismissed).length, [displayAnnotations]);

  const handleAnnotationClick = useCallback((ann: CodeAnnotation) => {
    state.openDiffFile(ann.filePath);
    state.onSelectAnnotation(ann.id);
  }, [state.openDiffFile, state.onSelectAnnotation]);

  // Copy All uses the diff context snapshotted on the JOB at launch, not the
  // current UI state — so if the reviewer switches modes/bases after the job
  // ran, the exported markdown still describes the diff the agent actually
  // analyzed. Falls back to current UI state only if the job predates the
  // snapshotting (older jobs without diffContext).
  const copyAllText = useMemo(
    () => {
      if (activeAnnotations.length === 0) return '';
      const jobMatchesCurrent = !job?.prUrl || job.prUrl === state.prMetadata?.url;
      return exportReviewFeedback(
        activeAnnotations,
        jobMatchesCurrent ? state.prMetadata : null,
        job?.diffContext ?? state.feedbackDiffContext,
      );
    },
    [activeAnnotations, state.prMetadata, job?.prUrl, job?.diffContext, state.feedbackDiffContext],
  );

  const { jobLogs } = useJobLogs();
  const logContent = jobLogs.get(jobId) ?? '';

  if (!job) {
    return <div className="h-full flex items-center justify-center text-muted-foreground text-sm">Job not found</div>;
  }

  const isCorrect = job.summary
    ? job.summary.correctness.toLowerCase().includes('correct') && !job.summary.correctness.toLowerCase().includes('incorrect')
    : null;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* ── Header ── */}
      <div className="flex-shrink-0 px-8 py-3 border-b border-border/40">
        <div className="flex items-center gap-2">
          <StatusDot status={job.status} />
          <ProviderPill provider={job.provider} engine={job.engine} model={job.model} />
          <span className="text-sm font-medium text-foreground truncate">{job.label}</span>
          <span className="ml-auto text-[10px] font-mono text-muted-foreground">
            {terminal && job.endedAt ? formatDuration(job.endedAt - job.startedAt) : <ElapsedTime startedAt={job.startedAt} />}
          </span>
        </div>
        {job.cwd && (
          <p className="text-[10px] font-mono text-muted-foreground/50 mt-1 truncate" title={job.cwd}>{job.cwd}</p>
        )}
        {/* Inline details */}
        <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
          <span>Started {new Date(job.startedAt).toLocaleTimeString()}</span>
          {job.exitCode !== undefined && (
            <span>Exit <span className={`font-mono ${job.exitCode === 0 ? 'text-success' : 'text-destructive'}`}>{job.exitCode}</span></span>
          )}
          <CopyButton text={fullCommand} variant="inline" label="Command" />
        </div>
        {/* Prompt disclosures in header */}
        {userMessage && (
          <div className="mt-3 space-y-1.5">
            <Disclosure title="Prompt" copyText={userMessage} nested>
              <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{userMessage}</pre>
            </Disclosure>
            {systemPrompt && (
              <Disclosure title={isTour ? "Tour Prompt" : "Review Prompt"} copyText={systemPrompt} nested>
                <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{systemPrompt}</pre>
              </Disclosure>
            )}
          </div>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="flex-shrink-0 px-8 flex gap-0.5 border-b border-border/40">
        {!isTour && (
          <TabButton active={activeTab === 'findings'} onClick={() => setActiveTab('findings')}>
            Findings{activeAnnotations.length > 0 && ` (${activeAnnotations.length})`}
          </TabButton>
        )}
        {isTour && (
          <TabButton active={activeTab === 'findings'} onClick={() => setActiveTab('findings')}>
            Status
          </TabButton>
        )}
        <TabButton active={activeTab === 'logs'} onClick={() => setActiveTab('logs')}>
          Logs
          {!terminal && <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-primary animate-pulse inline-block" />}
        </TabButton>
      </div>

      {/* ── Content ── */}
      {activeTab === 'findings' ? (
        isTour ? (
          /* Tour status view — no findings, just status + Open Tour button */
          <ScrollFade>
            <div className="px-8 py-3 space-y-4 max-w-2xl">
              <TourStatusCard summary={job.summary} terminal={terminal} jobId={jobId} />
            </div>
          </ScrollFade>
        ) : (
          /* Review findings view */
          <ScrollFade>
          <div className="px-8 py-3 space-y-4 max-w-2xl">
            <VerdictCard summary={job.summary} isCorrect={isCorrect} terminal={terminal} />

            {displayAnnotations.length > 0 && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    {activeAnnotations.length} finding{activeAnnotations.length !== 1 ? 's' : ''}
                    {dismissedCount > 0 && ` · ${dismissedCount} dismissed`}
                  </span>
                  {copyAllText && <CopyButton text={copyAllText} variant="inline" label="Copy All" />}
                </div>
                {activeAnnotations.some(a => a.severity) && (
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-destructive" /> Important</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Nit</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" /> Pre-existing</span>
                  </div>
                )}
              </>
            )}

            {displayAnnotations.length === 0 ? (
              <EmptyState terminal={terminal} />
            ) : (
              <div className="space-y-2">
                {displayAnnotations.map(({ annotation: ann, dismissed }) => (
                  <AnnotationRow key={ann.id} annotation={ann} dismissed={dismissed} onClick={handleAnnotationClick} />
                ))}
              </div>
            )}

          </div>
          </ScrollFade>
        )
      ) : (
        <div className="flex-1 flex flex-col min-h-0 px-8 py-3">
          <LiveLogViewer content={logContent} isLive={!terminal} />
          {!logContent && job.error && terminal && (
            <div className="mt-2 flex-shrink-0">
              <pre className="text-xs font-mono text-destructive bg-destructive/5 rounded p-3 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {job.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function VerdictCard({ summary, isCorrect, terminal }: {
  summary: AgentJobInfo['summary'];
  isCorrect: boolean | null;
  terminal: boolean;
}) {
  if (summary) {
    const verdictText = `${isCorrect ? 'Correct' : 'Incorrect'} (${Math.round(summary.confidence * 100)}% confidence)\n\n${summary.explanation}`;
    return (
      <div className={`rounded px-3 py-2.5 ${
        isCorrect ? 'bg-success/5' : 'bg-destructive/5'
      }`}>
        <div className="flex items-baseline gap-2">
          <span className={`text-xs font-semibold ${isCorrect ? 'text-success' : 'text-destructive'}`}>
            {isCorrect ? 'Correct' : 'Incorrect'}
          </span>
          <span className="text-[10px] text-muted-foreground">
            Confidence {Math.round(summary.confidence * 100)}%
          </span>
          <span className="ml-auto"><CopyButton text={verdictText} variant="inline" /></span>
        </div>
        <p className="text-xs text-foreground/80 leading-relaxed mt-1.5">{summary.explanation}</p>
      </div>
    );
  }

  return (
    <div className="rounded bg-muted/10 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          Review Verdict
        </span>
        {!terminal && (
          <span className="text-[10px] text-muted-foreground/40 animate-pulse">Pending...</span>
        )}
      </div>
      {terminal ? (
        <p className="text-xs text-muted-foreground/50 mt-1">No verdict available.</p>
      ) : (
        <p className="text-xs text-muted-foreground/50 mt-1">Will appear when the review completes.</p>
      )}
    </div>
  );
}

function TourStatusCard({ summary, terminal, jobId }: {
  summary: AgentJobInfo['summary'];
  terminal: boolean;
  jobId: string;
}) {
  const state = useReviewState();

  if (summary) {
    return (
      <div className="space-y-3">
        <div className="rounded px-3 py-2.5 bg-success/5">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold text-success">Tour Generated</span>
          </div>
          <p className="text-xs text-foreground/80 leading-relaxed mt-1.5">{summary.explanation}</p>
        </div>
        <button
          onClick={() => state.openTourPanel(jobId)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-xs font-medium active:scale-[0.98]"
        >
          Open Tour
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 7h8M8 3.5L11 7l-3 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="rounded bg-muted/10 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          Tour Status
        </span>
        {!terminal && (
          <span className="text-[10px] text-muted-foreground/40 animate-pulse">Generating...</span>
        )}
      </div>
      {terminal ? (
        <p className="text-xs text-muted-foreground/50 mt-1">Tour generation failed.</p>
      ) : (
        <p className="text-xs text-muted-foreground/50 mt-1">The tour will be ready when the agent finishes.</p>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: AgentJobInfo['status'] }) {
  if (status === 'starting' || status === 'running') {
    return (
      <span className="relative flex h-2 w-2 flex-shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-40" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
      </span>
    );
  }
  const c: Record<string, string> = { done: 'bg-success', failed: 'bg-destructive', killed: 'bg-muted-foreground' };
  return <span className={`inline-flex rounded-full h-2 w-2 flex-shrink-0 ${c[status] ?? c.killed}`} />;
}

function ProviderPill({ provider, engine, model }: { provider: string; engine?: string; model?: string }) {
  let label: string;
  if (provider === 'tour') {
    const engineLabel = engine === 'codex' ? 'Codex' : 'Claude';
    label = model && engine !== 'codex' ? `Tour · ${engineLabel} ${model.charAt(0).toUpperCase() + model.slice(1)}` : `Tour · ${engineLabel}`;
  } else {
    label = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Shell';
  }
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
      provider === 'tour' ? 'bg-accent/10 text-accent' : 'bg-muted text-muted-foreground'
    }`}>
      {label}
    </span>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-3 py-2 text-xs font-medium border-b-2 transition-all duration-150 -mb-px ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function Disclosure({ title, copyText, nested, children }: {
  title: string;
  copyText?: string;
  nested?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={nested ? '' : 'pt-4 mt-2'}>
      <div className="flex items-center justify-between">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors duration-150"
        >
          <svg className={`w-2.5 h-2.5 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="font-medium uppercase tracking-wider">{title}</span>
        </button>
        {open && copyText && <CopyButton text={copyText} variant="inline" />}
      </div>
      {open && <div className="mt-2 ml-4">{children}</div>}
    </div>
  );
}


function AnnotationRow({ annotation: ann, dismissed, onClick }: {
  annotation: CodeAnnotation;
  dismissed: boolean;
  onClick: (ann: CodeAnnotation) => void;
}) {
  const copyText = ann.text ? `${ann.filePath}:${ann.lineStart}${ann.lineEnd !== ann.lineStart ? `-${ann.lineEnd}` : ''}\n${ann.text}${ann.reasoning ? `\n\nReasoning: ${ann.reasoning}` : ''}` : '';
  const severity = ann.severity ? SEVERITY_STYLES[ann.severity] : null;
  return (
    <div
      className={`group/finding w-full text-left px-3 py-2.5 rounded bg-card border transition-all duration-150 shadow-[0_1px_3px_rgba(0,0,0,0.06)] ${
        dismissed ? 'opacity-30 cursor-default border-border/20' : 'border-border/40 hover:shadow-[0_2px_6px_rgba(0,0,0,0.08)] cursor-pointer'
      }`}
      onClick={() => !dismissed && onClick(ann)}
    >
      <div className="flex items-center gap-2 text-[10px]">
        {severity && (
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${severity.dot}`} title={severity.label} />
        )}
        <span className={`font-mono truncate ${dismissed ? 'line-through text-muted-foreground' : 'text-primary'}`}>
          {ann.filePath}
        </span>
        <span className="text-muted-foreground flex-shrink-0">
          L{ann.lineStart}{ann.lineEnd !== ann.lineStart ? `–${ann.lineEnd}` : ''}
        </span>
        {dismissed && (
          <span className="px-1 py-0.5 rounded text-[10px] uppercase tracking-wider bg-muted text-muted-foreground/60">dismissed</span>
        )}
        {!dismissed && copyText && (
          <span className="ml-auto opacity-0 group-hover/finding:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
            <CopyButton text={copyText} variant="inline" />
          </span>
        )}
      </div>
      {ann.text && (
        <p className={`text-xs mt-1 leading-relaxed ${dismissed ? 'text-muted-foreground/40' : 'text-foreground/80'}`}>
          {ann.text}
        </p>
      )}
      {ann.reasoning && (
        <p className="text-[11px] text-muted-foreground/60 leading-relaxed mt-1.5">
          {ann.reasoning}
        </p>
      )}
    </div>
  );
}

function EmptyState({ terminal }: { terminal: boolean }) {
  return (
    <div className="text-center py-8">
      <p className="text-xs text-muted-foreground">
        {terminal ? 'No findings were produced.' : 'Findings will appear as the agent works.'}
      </p>
    </div>
  );
}

function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Date.now() - startedAt)}</>;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
