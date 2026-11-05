/**
 * The stack in the PR page's rail, words not marks. Near layers stay out, far ones fold until wanted. The bar owns
 * the title, so the row you are on says where you are instead of repeating it.
 */
import { useEffect, useRef, useState } from 'react';
import { inboxPullLabel, type InboxPull } from '@plannotator/core/inbox-types';
import { RefMarkIcon } from '../board/RefMark';
import { Tip } from '../components/Tip';
import { Icon } from '../icons';
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

export function RailStack({ layers, here, scope, wholeTip, onLayer }: {
  layers: InboxPull[];
  here: InboxPull;
  scope: 'layer' | 'stack';
  /** What the whole stack compares: its row's tip. */
  wholeTip: string;
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
  const open = layers.filter(isOpen);
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
      <Tip content={wholeTip}>
        <button type="button" className={`ib-prp-row ib-prp-all${scope === 'stack' ? ' ib-on' : ''}`} aria-pressed={scope === 'stack'} onClick={() => onLayer(here.key, 'stack')} disabled={open.length < 2} data-pull-layer-all="">
          <Icon name="layers" size={15} />
          <span className="ib-prp-rowtitle">All {layers.length} layers</span>
          <Counts add={open.reduce((sum, l) => sum + l.additions, 0)} del={open.reduce((sum, l) => sum + l.deletions, 0)} />
        </button>
      </Tip>
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
