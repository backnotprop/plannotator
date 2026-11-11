/**
 * One problem, inline at the thing that failed (the errors system): an icon,
 * a bold line saying what happened, a muted line saying what it means, and
 * the one next step: a command to copy, a page to open, or Try again.
 * No toast, no dialog, no keyboard shortcut. Additive to @plannotator/ui: a
 * host that never passes a problem draws nothing new.
 */

import { useEffect, useRef, useState } from 'react';
import type { Problem } from '@plannotator/core/problem';
import { copyTextToClipboard } from '../utils/clipboard';

/** A clock for "still trying" (a timeout, a pause the forge asked for); a warning for everything else outside us. */
function ProblemIcon({ code }: { code: string }) {
  const waiting = code === 'tool.timed_out' || code === 'tool.rate_limited';
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`mt-[2px] flex-none ${waiting ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'}`}>
      {waiting ? (
        <>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 4.75V8l2.25 1.5" />
        </>
      ) : (
        <>
          <path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.5a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5z" />
          <path d="M8 6.25v3M8 11.4v.1" />
        </>
      )}
    </svg>
  );
}

export interface ProblemNoticeProps {
  problem: Problem;
  /** Try again (a `retry` action): drawn only when the host can ask again. */
  onRetry?: () => void;
  /** A Try again in flight: the button says so and waits. */
  retrying?: boolean;
  /** Larger targets (a phone's sheet). */
  touch?: boolean;
  /** A page the surface already links (its own "Open on GitHub"): not offered twice. */
  linked?: string;
}

export function ProblemNotice({ problem, onRetry, retrying = false, touch = false, linked }: ProblemNoticeProps) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const action = problem.action;
  const btn = touch ? 'min-h-11 px-3' : 'h-7 px-2.5';
  const copy = async (text: string) => {
    const ok = await copyTextToClipboard(text);
    setCopied(ok ? 'yes' : 'no');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 2000);
  };
  return (
    <div className="flex gap-2.5 px-3.5 py-3 text-[12.5px] leading-snug" role="status" data-problem={problem.code}>
      <ProblemIcon code={problem.code} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-foreground" data-problem-title="">
          {problem.title}
        </div>
        <div className="mt-0.5 text-muted-foreground" data-problem-detail="">
          {problem.detail}
        </div>
        {action?.kind === 'copy_command' && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/50 py-1 pl-2.5 pr-1">
            <code className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-foreground" data-problem-command="">
              {action.value}
            </code>
            <button
              type="button"
              className={`${btn} flex-none rounded-md border border-border bg-background text-[11.5px] font-medium text-foreground hover:bg-muted`}
              onClick={() => void copy(action.value)}
              aria-label={`Copy ${action.value}`}
              data-problem-copy=""
            >
              {copied === 'yes' ? 'Copied' : copied === 'no' ? "Couldn't copy" : 'Copy'}
            </button>
          </div>
        )}
        {action?.kind === 'open_url' && action.value !== linked && (
          <a href={action.value} target="_blank" rel="noopener noreferrer" className={`${btn} mt-2 inline-flex items-center gap-1 rounded-md bg-primary/10 text-[11.5px] font-medium text-primary hover:bg-primary/15`} data-problem-open="">
            {action.label} <span aria-hidden="true">↗</span>
          </a>
        )}
        {action?.kind === 'retry' && onRetry && (
          <button
            type="button"
            className={`${btn} mt-2 rounded-md border border-border bg-background text-[11.5px] font-medium text-foreground hover:bg-muted disabled:opacity-60`}
            onClick={onRetry}
            disabled={retrying}
            aria-busy={retrying || undefined}
            data-problem-retry=""
          >
            {retrying ? 'Trying again…' : 'Try again'}
          </button>
        )}
      </div>
    </div>
  );
}
