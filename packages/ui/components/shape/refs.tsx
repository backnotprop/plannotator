// A board's numbered references: small bubbles beside the words they source,
// and the same numbers in the panel's References list. Hovering a bubble
// lights its row; a row flashes its bubble; Open shows it in the real viewer.
import React, { createContext, useContext } from 'react';
import { shapeLinkUrl, type ShapeRef, type ShapeRefKind } from '@plannotator/core/shape';

export interface RefsState {
  refs: readonly ShapeRef[];
  hover: number | null;
  flash: number | null;
  onHover: (n: number | null) => void;
  onOpen: (n: number) => void;
}

export const RefsCtx = createContext<RefsState>({ refs: [], hover: null, flash: null, onHover: () => {}, onOpen: () => {} });

/** A bubble in the board's own markup (the header's claim, Requirements). Drawn views get theirs from ShapeDrawn. */
export function Bubble({ n }: { n: number }) {
  const r = useContext(RefsCtx);
  const ref = r.refs.find((x) => x.n === n);
  if (!ref) return null;
  const cls = `shp-rb${r.hover === n ? ' lit' : ''}${r.flash === n ? ' flash' : ''}`;
  const common = {
    className: cls,
    'data-ref': n,
    'aria-label': `Reference ${n}: ${ref.title}`,
    onPointerEnter: () => r.onHover(n),
    onPointerLeave: () => r.onHover(null),
  };
  // A PR or link is a real link, so the host's GitHub hover card (RefHoverCards) opens on it.
  if (ref.kind === 'pr' || ref.kind === 'link') {
    return <a {...common} href={shapeLinkUrl(ref.target) ?? undefined} target="_blank" rel="noreferrer">{n}</a>;
  }
  return (
    <button type="button" {...common} title={ref.title} onClick={(e) => { e.stopPropagation(); r.onOpen(n); }}>
      {n}
    </button>
  );
}

const KIND_ICON: Record<ShapeRefKind, React.ReactNode> = {
  message: <path d="M4 5h16v11H9l-5 4z" />,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 15l3-3 3 3 2-2 3 3" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  pr: <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4" /></>,
  diff: <path d="M12 4v8M8 8h8M8 18h8" />,
  link: <><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></>,
};

export const KindIcon = ({ kind }: { kind: ShapeRefKind }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {KIND_ICON[kind]}
  </svg>
);

/** The References tab: the board's references, by number. */
export function RefList({ onShow, canOpen }: { onShow: (n: number) => void; canOpen: (ref: ShapeRef) => boolean }) {
  const r = useContext(RefsCtx);
  if (!r.refs.length) return <p className="shp-empty-note">This board cites nothing yet.</p>;
  return (
    <ol className="shp-ref-list">
      {r.refs.map((ref) => (
        <li key={ref.n} className={r.hover === ref.n ? 'lit' : ''} onPointerEnter={() => r.onHover(ref.n)} onPointerLeave={() => r.onHover(null)}>
          <button type="button" className="shp-ref-row" onClick={() => onShow(ref.n)} title="Show it on the board">
            <span className="shp-rb static">{ref.n}</span>
            <span className="shp-ref-kind"><KindIcon kind={ref.kind} /></span>
            <span className="shp-ref-txt">
              <b>{ref.title}</b>
              {ref.sub && <span>{ref.sub}</span>}
            </span>
          </button>
          {ref.kind === 'pr' || ref.kind === 'link' ? (
            <a className="shp-ref-open" href={shapeLinkUrl(ref.target) ?? undefined} target="_blank" rel="noreferrer">Open</a>
          ) : canOpen(ref) ? (
            <button type="button" className="shp-ref-open" onClick={() => r.onOpen(ref.n)}>Open</button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
