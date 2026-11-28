/**
 * The rail's rows for the views beside This layer and Whole stack (approval "inbox-pr-dashboard", round 7): the range
 * on screen ("Layers 6–9"), and Since you looked while this layer's head moved since the person last opened it. A PR
 * with no stack rail gets its own row back to its diff.
 */
import { inboxPullLabel, type InboxPull } from '@plannotator/core/inbox-types';
import { RefMarkIcon } from '../board/RefMark';
import { Icon } from '../icons';
import type { Looked } from '../prs/looked';
import type { PullViewScope } from './viewScope';

function Counts({ add, del }: { add: number; del: number }) {
  return (
    <span className="ib-prp-counts">
      <span className="additions">+{add}</span>
      <span className="deletions"> -{del}</span>
    </span>
  );
}

export function RailScopeRows({ layer, alone, scope, rangeName, counts, before, onLayer }: {
  layer: InboxPull;
  /** No stack rail above: the PR's own diff needs a row here. */
  alone: boolean;
  scope: PullViewScope;
  rangeName: string | null;
  /** The numbers of the diff on screen, once read. */
  counts?: { add: number; del: number };
  before: Looked | null;
  onLayer: (key: string, scope: PullViewScope) => void;
}) {
  const since = scope.startsWith('since:') ? scope.slice('since:'.length) : null;
  const sinceSha = since ?? before?.sha ?? null;
  if (!rangeName && !sinceSha) return null;
  return (
    <div className="ib-prp-stack ib-prp-views">
      {rangeName && (
        <div className="ib-prp-row ib-prp-all ib-on" aria-current="true" data-pull-layer-range="">
          <Icon name="layers" size={15} />
          <span className="ib-prp-rowtitle">{rangeName}</span>
          {counts && <Counts add={counts.add} del={counts.del} />}
        </div>
      )}
      {sinceSha && alone && (
        <button type="button" className={`ib-prp-row${scope === 'layer' ? ' ib-on' : ''}`} aria-pressed={scope === 'layer'} onClick={() => scope !== 'layer' && onLayer(layer.key, 'layer')} data-pull-layer-own="">
          <RefMarkIcon kind="pr" state={layer.state} size={14} />
          <span className="ib-prp-num">{inboxPullLabel(layer)}</span>
          <bdi className="ib-prp-rowtitle">{layer.title}</bdi>
        </button>
      )}
      {sinceSha && (
        <button type="button" className={`ib-prp-row ib-prp-all${since ? ' ib-on' : ''}`} aria-pressed={!!since} onClick={() => !since && onLayer(layer.key, `since:${sinceSha}`)} data-pull-since={sinceSha}>
          <span className="ib-prp-sincedot" aria-hidden="true" />
          <span className="ib-prp-rowtitle">Since you looked</span>
          {since && counts && <Counts add={counts.add} del={counts.del} />}
        </button>
      )}
    </div>
  );
}
