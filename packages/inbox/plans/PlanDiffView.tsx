/**
 * Two versions of a plan compared (approval "inbox-plans", the plan-diff mock): plan review's own diff engine
 * (`computePlanDiff`, packages/ui/utils/planDiffEngine.ts) and its clean view with words marked in place
 * (`PlanCleanDiffView`, Rendered). Read only: no comment is offered on a block (no `onAddAnnotation`). The texts come
 * from `GET /api/plans/:id/diff`. Added and removed blocks are drawn as fills (plans.css), unchanged ones dimmed.
 */
import { useMemo, useState } from 'react';
import { computePlanDiff } from '@plannotator/ui/utils/planDiffEngine';
import { PlanCleanDiffView } from '@plannotator/ui/components/plan-diff/PlanCleanDiffView';
import { usePlanDiff } from './store';

export function PlanDiffView({ id, from, to }: { id: string; from: number; to: number }) {
  const [retry, setRetry] = useState(0);
  const { diff, error } = usePlanDiff(id, from, to, retry);
  const computed = useMemo(() => (diff?.from && diff.to ? computePlanDiff(diff.from.text, diff.to.text) : null), [diff]);
  if (error) {
    return (
      <div className="ib-plan-docstate" role="alert">
        <p>The two versions could not be read. {error}</p>
        <button type="button" className="ib-plans-quiet" onClick={() => setRetry((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!computed) {
    return (
      <div className="ib-plan-docstate" role="status" aria-busy="true">
        <p>
          Comparing v{from} with v{to}…
        </p>
      </div>
    );
  }
  const { blocks, stats } = computed;
  const same = blocks.every((b) => b.type === 'unchanged');
  return (
    <div className="ib-plan-docscroll ib-plan-diff" data-plan-diff={`${from}-${to}`}>
      <div className="ib-plan-diffwrap">
        <div className="ib-plan-legend">
          <span className="ib-plan-key" data-k="added">
            Added
          </span>
          <span className="ib-plan-key" data-k="removed">
            Removed
          </span>
          <span className="ib-plan-stats" aria-label={`${stats.additions} lines added, ${stats.deletions} removed`} data-plan-diff-stats="">
            <span data-k="added">+{stats.additions}</span> / <span data-k="removed">−{stats.deletions}</span>
          </span>
        </div>
        {same ? <p className="ib-plan-same">v{from} and v{to} have the same text.</p> : <PlanCleanDiffView blocks={blocks} wordLevel />}
      </div>
    </div>
  );
}
