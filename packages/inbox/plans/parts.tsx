/** Small pieces Plans' screens share: a decision's mark and a whole-page message (loading, empty, failed). */
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import type { PlanDecisionTone } from './words';

export function DecisionMark({ tone }: { tone: PlanDecisionTone }) {
  return (
    <span className="ib-plans-dmark" data-tone={tone} aria-hidden="true">
      <Icon name={tone === 'approved' ? 'checkCircle' : tone === 'changes' ? 'reply' : 'clock'} />
    </span>
  );
}

export function PlansMessage({ title, body, busy, onRetry, onBack }: { title: string; body: string; busy?: boolean; onRetry?: () => void; onBack?: () => void }) {
  return (
    <section className="ib-dpage ib-plans ib-plans-msg" aria-busy={busy || undefined} data-plans-message="">
      <div className="ib-dh">
        <SidebarTrigger />
        {onBack && (
          <button type="button" className="ib-plans-back" onClick={onBack}>
            <Icon name="chevL" />
            Plans
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
