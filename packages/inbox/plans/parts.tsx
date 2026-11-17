/** Small pieces Plans' screens share: a decision's mark and a whole-page message (loading, empty, failed). */
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import type { PlanDecisionTone } from './words';

/**
 * The Inbox could not read the plan history (a folder it cannot write, a full disk): a quiet line, the reason as its
 * tooltip, and Try again (the Inbox reads it now, whatever its wait after a failure).
 */
export function ImportErrorNote({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <p className="ib-plans-note" role="status" title={error} data-plans-import-error="">
      Could not read your earlier plans.{' '}
      <button type="button" className="ib-plans-link" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

export function DecisionMark({ tone }: { tone: PlanDecisionTone }) {
  return (
    <span className="ib-plans-dmark" data-tone={tone} aria-hidden="true">
      <Icon name={tone === 'approved' ? 'checkCircle' : tone === 'changes' ? 'reply' : 'clock'} />
    </span>
  );
}

export function PlansMessage({ title, body, busy, onRetry, onBack, backLabel = 'Spaces' }: { title: string; body: string; busy?: boolean; onRetry?: () => void; onBack?: () => void; backLabel?: string }) {
  return (
    <section className="ib-dpage ib-plans ib-plans-msg" aria-busy={busy || undefined} data-plans-message="">
      <div className="ib-dh">
        <SidebarTrigger />
        {onBack && (
          <button type="button" className="ib-plans-back" onClick={onBack}>
            <Icon name="chevL" />
            {backLabel}
          </button>
        )}
      </div>
      <div className="ib-plans-msg-body" role={busy ? 'status' : onRetry ? 'alert' : undefined}>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{body}</p>
        {onRetry && (
          <button type="button" className="ib-plans-quiet" onClick={onRetry} data-plans-retry="">
            Try again
          </button>
        )}
      </div>
    </section>
  );
}
