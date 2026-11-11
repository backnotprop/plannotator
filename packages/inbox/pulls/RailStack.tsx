/**
 * The stack in the PR page's rail, words not marks. Near layers stay out, far ones fold until wanted. The bar owns
 * the title, so the row you are on says where you are instead of repeating it.
 */
import { useEffect, useRef, useState } from 'react';
import { inboxPullLabel, type InboxPull } from '@plannotator/core/inbox-types';
import { RefMarkIcon } from '../board/RefMark';
import { Tip } from '../components/Tip';
import { Icon } from '../icons';
import { chainTo } from './model';
import { isOpen } from './topology';

/** Layers this many or more fold what is far from you. */
const FOLD_FROM = 8;
const NEAR = 2;

function Counts({ add, del }: { add: number; del: number }) {
  return (
    <span className="ib-prp-counts">
      <span className="additions">+{add}</span>
      <span className="deletions"> -{del}</span>
    </span>
  );
}

const foldWords = (n: number, side: string, hidden: readonly InboxPull[]) => {
  const merged = hidden.filter((l) => !isOpen(l)).length;
  return `${n} ${side}${merged ? ` · ${merged} merged` : ''}`;
};

export function RailStack({ layers, here, scope, wholeTip, wholeCounts, onLayer }: {
  layers: InboxPull[];
  here: InboxPull;
  scope: 'layer' | 'stack';
  /** What the whole stack compares: its row's tip. */
  wholeTip: string;
  /** The whole stack's own numbers, once its diff is on screen; layers' sums count a line changed twice twice. */
  wholeCounts?: { add: number; del: number };
  onLayer: (key: string, scope: 'layer' | 'stack') => void;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const [showLater, setShowLater] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const at = Math.max(0, layers.findIndex((l) => l.key === here.key));
  const foldable = layers.length >= FOLD_FROM;
  let start = foldable && !showEarlier ? Math.max(0, at - NEAR) : 0;
  let end = foldable && !showLater ? Math.min(layers.length, at + NEAR + 1) : layers.length;
  // A fold never hides just one row.
  if (start === 1) start = 0;
  if (end === layers.length - 1) end = layers.length;
  // "All": every open layer, from wherever you are. What it opens is the diff up to the topmost, so its number and its
  // counts are that diff's: merged layers are not read again, and a sibling branch is not on its chain.
  const open = layers.filter(isOpen);
  const tip = open.at(-1);
  const whole = tip ? chainTo(open, tip) : [];
  const onWhole = scope === 'stack' && here.key === tip?.key;
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[aria-current="step"]');
    if (row && list.current) list.current.scrollTop = row.offsetTop - list.current.clientHeight / 2 + row.offsetHeight / 2;
  }, [here.key, showEarlier, showLater]);
  const row = (l: InboxPull) => {
    const on = scope === 'layer' && l.key === here.key;
    return (
      <Tip key={l.key} content={l.title}>
        <button type="button" className={`ib-prp-row${on ? ' ib-on' : ''}`} aria-current={on ? 'step' : undefined} disabled={!isOpen(l)} onClick={() => onLayer(l.key, 'layer')} data-pull-layer-row={l.key}>
          <RefMarkIcon kind="pr" state={l.state} size={14} />
          <span className="ib-prp-num">{inboxPullLabel(l)}</span>
          {on ? <span className="ib-prp-rowtitle ib-prp-here">This layer</span> : <bdi className="ib-prp-rowtitle">{l.title}</bdi>}
          {on && <Counts add={l.additions} del={l.deletions} />}
        </button>
      </Tip>
    );
  };
  const fold = (words: string, onClick: () => void, name: string) => (
    <button type="button" className="ib-prp-row ib-prp-fold" onClick={onClick} data-pull-layer-fold={name}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="3" r="1" fill="currentColor" /><circle cx="7" cy="7" r="1" fill="currentColor" /><circle cx="7" cy="11" r="1" fill="currentColor" /></svg>
      <span className="ib-prp-rowtitle">{words}</span>
    </button>
  );
  return (
    <div className="ib-prp-stack">
      {/* One open layer is its own whole stack: no row that would say "All 1 layers". */}
      {whole.length > 1 && (
        <Tip content={wholeTip}>
          <button type="button" className={`ib-prp-row ib-prp-all${onWhole ? ' ib-on' : ''}`} aria-pressed={onWhole} onClick={() => tip && onLayer(tip.key, 'stack')} data-pull-layer-all="">
            <Icon name="layers" size={15} />
            <span className="ib-prp-rowtitle">All {whole.length} layers</span>
            <Counts add={onWhole && wholeCounts ? wholeCounts.add : whole.reduce((sum, l) => sum + l.additions, 0)} del={onWhole && wholeCounts ? wholeCounts.del : whole.reduce((sum, l) => sum + l.deletions, 0)} />
          </button>
        </Tip>
      )}
      <div className="ib-prp-layers" ref={list} role="list" aria-label="Layers, bottom first">
        {start > 0 && fold(foldWords(start, 'earlier', layers.slice(0, start)), () => setShowEarlier(true), 'earlier')}
        {foldable && showEarlier && at - NEAR > 1 && fold('Fold earlier', () => setShowEarlier(false), 'fold-earlier')}
        {layers.slice(start, end).map(row)}
        {foldable && showLater && layers.length - (at + NEAR + 1) > 1 && fold('Fold later', () => setShowLater(false), 'fold-later')}
        {end < layers.length && fold(foldWords(layers.length - end, 'later', layers.slice(end)), () => setShowLater(true), 'later')}
      </div>
    </div>
  );
}
