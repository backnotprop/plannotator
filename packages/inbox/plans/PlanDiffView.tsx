/**
 * Two versions of a plan compared (approval "inbox-plans", the plan-diff mock): plan review's own diff engine
 * (`computePlanDiff`, packages/ui/utils/planDiffEngine.ts) and its clean view with words marked in place
 * (`PlanCleanDiffView`, Rendered). Read only: no comment is offered on a block (no `onAddAnnotation`). The texts come
 * from `GET /api/plans/:id/diff`. Added and removed blocks are drawn as fills (plans.css), unchanged ones dimmed.
 * Under the same rules as the document (planContent.tsx): no remote picture is fetched, no link but a web one acts.
 */
import { useMemo, useState } from 'react';
import type { PlanDocumentKind } from '@plannotator/core/plans';
import { computePlanDiff } from '@plannotator/ui/utils/planDiffEngine';
import { PlanCleanDiffView } from '@plannotator/ui/components/plan-diff/PlanCleanDiffView';
import { usePlanDiff } from './store';
import { PlanContentRules } from './planContent';
import { PlanPicture } from './PlanDocument';

/** A file that is not Markdown (an HTML page, a diagram's source) is compared as its source, in a code block. */
function asCompared(text: string, kind: PlanDocumentKind): string {
  if (kind === 'markdown') return text;
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}\n`;
}

type PlanDiffProps = { id: string; from: number; to: number; doc?: string | null; kind?: PlanDocumentKind };

/** A picture page has no text to compare: the two versions side by side, the older first. */
export function PlanDiffView(props: PlanDiffProps) {
  if (props.kind !== 'image') return <PlanTextDiff {...props} />;
  const { id, from, to, doc = null } = props;
  return (
    <div className="ib-plan-docscroll ib-plan-picdiff" data-plan-diff={`${from}-${to}`}>
      {[from, to].map((n) => (
        <figure key={n}>
          <PlanPicture key={`${id}:${doc ?? ''}:${n}`} id={id} version={n} doc={doc} title={`Version ${n}`} />
          <figcaption>v{n}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function PlanTextDiff({ id, from, to, doc = null, kind = 'markdown' }: PlanDiffProps) {
  const [retry, setRetry] = useState(0);
  const { diff, error } = usePlanDiff(id, from, to, retry, doc);
  const computed = useMemo(() => (diff?.from && diff.to ? computePlanDiff(asCompared(diff.from.text, kind), asCompared(diff.to.text, kind)) : null), [diff, kind]);
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
        {same ? <p className="ib-plan-same">v{from} and v{to} have the same text.</p> : (
          <PlanContentRules>
            <PlanCleanDiffView blocks={blocks} wordLevel />
          </PlanContentRules>
        )}
      </div>
    </div>
  );
}
