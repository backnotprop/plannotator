/**
 * The hover card for a Linear issue (core `linear-ref-card.ts`), drawn through the ref card providers seam
 * (utils/refCardProviders.ts) in the forge card's frame and with its parts: team, identifier, Linear's own state name
 * and colour, priority, project, estimate, attached GitHub PRs as "Pull requests", the latest comment, Open in Linear.
 */
import type React from 'react';
import type { ForgeRefCardError } from '@plannotator/core/forge-ref-card';
import type { LinearCardData, LinearCardFields } from '@plannotator/core/linear-ref-card';
import { RefCardAvatar, RefCardMarkdown, RefCardStateIcon, refCardTimeAgo, type RefCardViewProps } from './RefHoverCard';

const BODY_MAX = 216;
const BODY_MAX_PINNED = 340;

const FAILURE_TEXT: Record<ForgeRefCardError, string> = {
  unsupported: "Linear details don't load in this window.",
  cli_missing: 'Add a Linear API key to see details here.',
  signed_out: 'Add a Linear API key to see details here.',
  not_found: "Your Linear key can't see this issue, or it doesn't exist.",
  rate_limited: 'Linear asked for a short break. Details come back in a minute.',
  unavailable: "Details couldn't load right now.",
};

/** Linear's own state marks: a dashed ring (backlog), a ring (todo), a part-filled ring (started), a filled check or cross (done, canceled). */
export function LinearStateIcon({ type, color, className = '' }: { type: LinearCardFields['stateType']; color: string; className?: string }) {
  const style = { color: `#${color}` };
  const cls = `h-4 w-4 flex-none ${className}`;
  if (type === 'completed' || type === 'canceled') {
    return (
      <svg viewBox="0 0 16 16" className={cls} style={style} aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="currentColor" />
        {type === 'completed' ? (
          <path d="M5.2 8.3l1.9 1.9 3.8-4" fill="none" stroke="var(--background, #fff)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M5.8 5.8l4.4 4.4m0-4.4l-4.4 4.4" fill="none" stroke="var(--background, #fff)" strokeWidth="1.6" strokeLinecap="round" />
        )}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className={cls} style={style} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6.25" strokeDasharray={type === 'backlog' || type === 'triage' ? '2 1.6' : undefined} />
      {type === 'started' ? <path d="M8 4.2A3.8 3.8 0 0 1 11.8 8H8z" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}

/**
 * `noKeyText`: what the card says when the host has no Linear key or Linear refused it; a host names where its key is
 * set. Absent: a plain "Add a Linear API key".
 */
export function LinearRefCardView({ target, href, result, pinned, onClose, sheet, tight, noKeyText }: RefCardViewProps & { noKeyText?: string }) {
  const identifier = `${target.repo}-${target.number}`;
  const btn = sheet ? 'min-h-11 px-3' : 'h-7 px-2.5';
  const footer = (extra?: React.ReactNode) => (
    <div className="flex flex-none items-center gap-2 border-t border-border px-3.5 py-2 text-[11.5px] text-muted-foreground" data-ref-card-foot="">
      <span className="min-w-0 flex-1 truncate">{extra}</span>
      {onClose && (pinned || sheet) ? (
        <button type="button" onClick={onClose} className={`${btn} rounded-md hover:bg-muted hover:text-foreground`} data-ref-card-close="">
          Close
        </button>
      ) : null}
      <a
        href={result?.ok ? result.data.url : href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${btn} inline-flex items-center gap-1 rounded-md bg-primary/10 font-medium text-primary hover:bg-primary/15`}
        data-ref-card-open=""
      >
        Open in Linear <span aria-hidden="true">↗</span>
      </a>
    </div>
  );

  if (result === undefined) {
    return (
      <div aria-busy="true" data-ref-card-loading="" data-ref-card-linear="">
        <div className="px-3.5 pb-3 pt-3">
          <div className="text-[11.5px] text-muted-foreground">
            {target.owner} · {identifier}
          </div>
          <div className="mt-2 h-4 w-4/5 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-3 w-full animate-pulse rounded bg-muted/70" />
        </div>
        {footer()}
      </div>
    );
  }

  if (!result || !result.ok) {
    const error = result && 'error' in result ? result.error : 'unavailable';
    return (
      <div data-ref-card-linear="">
        <div className="px-3.5 pb-3 pt-3">
          <div className="text-[11.5px] text-muted-foreground">{target.owner}</div>
          <div className="mt-1 text-[13.5px] font-semibold text-foreground">Issue {identifier}</div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground" data-ref-card-error={error}>
            {noKeyText && (error === 'signed_out' || error === 'cli_missing') ? noKeyText : FAILURE_TEXT[error]}
          </p>
        </div>
        {footer()}
      </div>
    );
  }

  const d = result.data as unknown as LinearCardData;
  const ln = d.linear;
  const together = !!tight && !sheet;
  const scroller = { 'data-ref-card-scroll': '', tabIndex: 0 };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ref-card-linear="">
      <div className={together ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain' : 'flex min-h-0 flex-1 flex-col'} {...(together ? { ...scroller, 'aria-label': 'Issue details' } : {})}>
        <div className="flex-none px-3.5 pt-3" data-ref-card-head="">
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span className="truncate">{ln.team || d.repo}</span>
            <span aria-hidden="true">·</span>
            <span className="flex-none">opened {refCardTimeAgo(d.createdAt)}</span>
          </div>
          <div className="mt-1.5 flex items-start gap-2">
            <LinearStateIcon type={ln.stateType} color={ln.stateColor} className="mt-[3px]" />
            <div className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]" data-ref-card-title="">
              {d.title} <span className="font-normal text-muted-foreground">{ln.identifier || `${d.repo}-${d.number}`}</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
            <span className="rounded-full px-2 py-[1px] text-[11px] font-semibold" style={{ color: `#${ln.stateColor}`, background: `#${ln.stateColor}26` }} data-ref-card-state={d.state}>
              {ln.stateName}
            </span>
            {d.author ? (
              <span className="inline-flex items-center gap-1">
                <RefCardAvatar person={d.author} size={16} />
                {d.author.login}
              </span>
            ) : null}
            {d.closedAt && d.state !== 'open' ? (
              <span>
                {d.state === 'not_planned' ? 'canceled' : 'done'} {refCardTimeAgo(d.closedAt)}
              </span>
            ) : (
              <span>updated {refCardTimeAgo(d.updatedAt)}</span>
            )}
          </div>
          {ln.priority || ln.project || ln.estimate !== null ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground" data-ref-card-linear-fields="">
              {ln.priority ? <span data-ref-card-priority={ln.priority}>{ln.priority} priority</span> : null}
              {ln.project ? <span className="min-w-0 truncate">◇ {ln.project}</span> : null}
              {ln.estimate !== null ? (
                <span>
                  {ln.estimate} pt{ln.estimate === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
          ) : null}
          {d.labels.length > 0 || d.assignees.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {d.labels.map((l) => (
                <span key={l.name} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-1.5 py-[1px] text-[10.5px] text-foreground">
                  <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: `#${l.color}` }} />
                  <span className="truncate">{l.name}</span>
                </span>
              ))}
              {d.assignees.length > 0 ? (
                <span className="ml-auto inline-flex items-center gap-1" role="img" aria-label={`Assigned to ${d.assignees.map((a) => a.login).join(', ')}`}>
                  {d.assignees.map((a) => (
                    <RefCardAvatar key={a.login} person={a} size={16} />
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div
          className={`mt-2.5 border-t border-border px-3.5 py-2.5 ${together ? '' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain'}`}
          style={sheet || together ? undefined : { maxHeight: pinned ? BODY_MAX_PINNED : BODY_MAX }}
          data-ref-card-body=""
          {...(together ? {} : { ...scroller, 'aria-label': 'Issue description' })}
        >
          {d.body.trim() ? <RefCardMarkdown markdown={d.body} /> : <p className="text-[12px] italic text-muted-foreground">No description.</p>}
          {d.bodyCut ? <p className="mt-1 text-[11px] text-muted-foreground">The rest is in Linear.</p> : null}
          {d.linked.length > 0 ? (
            <div className="mt-2.5 space-y-1">
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Pull requests</div>
              {d.linked.map((l) => (
                <div key={l.number} className="flex items-center gap-1.5 text-[12px]">
                  <RefCardStateIcon kind="pull" tone={l.state === 'open' ? 'open' : l.state === 'merged' ? 'merged' : 'closed'} />
                  <span className="min-w-0 truncate">{l.title}</span>
                  <span className="flex-none text-muted-foreground">#{l.number}</span>
                </div>
              ))}
            </div>
          ) : null}
          {d.lastComment ? (
            <div className="mt-2.5 rounded-md border border-border bg-muted/30 px-2.5 py-2" data-ref-card-comment="">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {d.lastComment.author ? <RefCardAvatar person={d.lastComment.author} size={14} /> : null}
                <span className="font-medium text-foreground">{d.lastComment.author?.login ?? 'someone'}</span>
                <span>commented {refCardTimeAgo(d.lastComment.at)}</span>
                <span className="ml-auto">latest</span>
              </div>
              <RefCardMarkdown markdown={d.lastComment.body} />
            </div>
          ) : null}
        </div>
      </div>
      {footer(
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true">💬</span> {d.comments} comment{d.comments === 1 ? '' : 's'}
          {pinned && !sheet ? <span className="ml-1.5 text-muted-foreground/80">· pinned</span> : null}
        </span>,
      )}
    </div>
  );
}
