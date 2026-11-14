import React, { useRef, useState } from 'react';
import { BookOpenText, ChevronRight, Loader2, ScanSearch } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AgentLaunchParams } from '../../hooks/useAgentJobs';
import type { LaunchConfig, LaunchKind, LaunchSide } from '../../hooks/useLaunchConfig';
import { useLaunchFolds } from '../../hooks/useLaunchFolds';
import { useGuideInstructions } from '../../hooks/useGuideInstructions';
import { LaunchDetails } from './LaunchDetails';

const ROW: Record<LaunchKind, { title: string; action: string; Icon: React.FC<{ className?: string; size?: number }> }> = {
  guide: { title: 'Guided Review', action: 'Start', Icon: BookOpenText },
  review: { title: 'Review agent', action: 'Start', Icon: ScanSearch },
};

function LaunchRow({
  side,
  config,
  open,
  onToggle,
  onLaunch,
  instructions,
  onInstructions,
  onAddReview,
}: {
  side: LaunchSide;
  config: LaunchConfig;
  open: boolean;
  onToggle: () => void;
  onLaunch: (params: AgentLaunchParams) => Promise<unknown>;
  instructions?: string;
  onInstructions?: (value: string) => void;
  onAddReview?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const { title, action, Icon } = ROW[side.kind];
  const detailsId = `launch-details-${side.kind}`;

  const launch = async () => {
    if (!side.ready || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await onLaunch(side.buildParams(side.kind === 'guide' ? { instructions } : undefined));
      if (result === null) setError('Could not start. Check the agent CLI and try again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start. Check the agent CLI and try again.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <div data-launch-row={side.kind}>
      <div className="flex items-center gap-2 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={detailsId}
          title={open ? 'Hide options' : 'Engine, model and options'}
          className="group -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon className="shrink-0 text-muted-foreground" size={16} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-foreground">{title}</span>
            {side.models === null && !side.experimental ? (
              <span className="block truncate text-[12px] text-muted-foreground" data-launch-summary="">Loading models…</span>
            ) : (
              <LaunchSummaryLine summary={side.summary} />
            )}
          </span>
          <ChevronRight
            size={14}
            className={cn('shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')}
          />
        </button>
        <button
          type="button"
          onClick={launch}
          disabled={!side.ready || pending}
          aria-busy={pending}
          data-launch-start={side.kind}
          className="inline-flex h-7 w-16 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending && <Loader2 className="animate-spin motion-reduce:animate-none" size={12} />}
          {pending ? 'Starting' : action}
        </button>
      </div>
      {error && <p className="pb-2 pl-8 text-[12px] leading-5 text-muted-foreground" role="alert">{error}</p>}
      {side.notice && !open && (
        <p className="pb-1.5 pl-8 text-[12px] leading-5 text-muted-foreground" data-model-fallback-notice="">{side.notice}</p>
      )}
      {open && (
        <div id={detailsId}>
          <LaunchDetails side={side} config={config} instructions={instructions} onInstructions={onInstructions} onAddReview={onAddReview} />
        </div>
      )}
    </div>
  );
}

export function LaunchPad({
  config,
  scope,
  onLaunch,
  onAddReview,
}: {
  config: LaunchConfig;
  scope?: React.ReactNode;
  onLaunch: (params: AgentLaunchParams) => Promise<unknown>;
  onAddReview?: () => void;
}) {
  const { folds, toggle } = useLaunchFolds();
  const guideInstructions = useGuideInstructions(config.guide.available);
  return (
    <section aria-label="Start a review" className="px-4 pt-2" data-launch-pad="">
      {scope && (
        <p className="truncate pb-1 text-[12px] leading-5 text-muted-foreground" data-launch-scope="">
          {scope}
        </p>
      )}
      {!config.guide.available && !config.review.available && (
        <p className="py-1.5 text-[12px] leading-5 text-muted-foreground" data-launch-none="">
          No agent CLI on this machine. Install Claude Code, Codex, Cursor, OpenCode, Pi or Copilot to start reviews here.
        </p>
      )}
      {config.guide.available && (
        <LaunchRow
          side={config.guide}
          config={config}
          open={folds.guide}
          onToggle={() => toggle('guide')}
          onLaunch={onLaunch}
          instructions={guideInstructions.instructions}
          onInstructions={guideInstructions.setInstructions}
        />
      )}
      {config.review.available && (
        <LaunchRow
          side={config.review}
          config={config}
          open={folds.review}
          onToggle={() => toggle('review')}
          onLaunch={onLaunch}
          onAddReview={onAddReview}
        />
      )}
    </section>
  );
}

export function LaunchSummaryLine({ summary }: { summary: string }) {
  const [engine, model, ...rest] = summary.split(' · ');
  if (!model) return <span className="block truncate text-[12px] text-muted-foreground" data-launch-summary="">{summary}</span>;
  return (
    <span className="flex min-w-0 text-[12px] text-muted-foreground" data-launch-summary="" title={summary}>
      <span className="min-w-0 shrink-[2] truncate">{engine} ·&nbsp;</span>
      <span className="max-w-full flex-none truncate" data-launch-model="">{model}</span>
      {rest.length > 0 && <span className="min-w-0 shrink truncate">&nbsp;· {rest.join(' · ')}</span>}
    </span>
  );
}
