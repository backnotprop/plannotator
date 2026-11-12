import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { shapeLinkUrl, shapeUrlAllowed, type ShapeRef, type ShapeRefKind } from '@plannotator/core/shape';

export interface RefsState {
  refs: readonly ShapeRef[];
  hover: number | null;
  flash: number | null;
  onHover: (n: number | null) => void;
  onOpen: (n: number) => void;
  onPeek?: (n: number | null, el: HTMLElement, how: 'hover' | 'focus' | 'tap') => void;
}

export const RefsCtx = createContext<RefsState>({ refs: [], hover: null, flash: null, onHover: () => {}, onOpen: () => {} });

export function Bubble({ n }: { n: number }) {
  const r = useContext(RefsCtx);
  const ref = r.refs.find((x) => x.n === n);
  if (!ref) return null;
  const cls = `shp-rb${r.hover === n ? ' lit' : ''}${r.flash === n ? ' flash' : ''}`;
  const common = {
    className: cls,
    'data-ref': n,
    'aria-label': `Reference ${n}: ${ref.title}`,
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      r.onHover(n);
      if (e.pointerType !== 'touch') r.onPeek?.(n, e.currentTarget, 'hover');
    },
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
      r.onHover(null);
      if (e.pointerType !== 'touch') r.onPeek?.(null, e.currentTarget, 'hover');
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) r.onPeek?.(n, e.currentTarget, 'focus');
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => r.onPeek?.(null, e.currentTarget, 'focus'),
  };
  if (ref.kind === 'pr' || ref.kind === 'link') {
    return <a {...common} href={shapeLinkUrl(ref.target) ?? undefined} target="_blank" rel="noreferrer">{n}</a>;
  }
  return (
    <button
      type="button"
      {...common}
      title={r.onPeek ? undefined : ref.title}
      onClick={(e) => {
        e.stopPropagation();
        if (r.onPeek && (e.nativeEvent as PointerEvent).pointerType === 'touch') r.onPeek(n, e.currentTarget, 'tap');
        else r.onOpen(n);
      }}
    >
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

export function RefList({ onShow, canOpen, fileAction }: { onShow: (n: number) => void; canOpen: (ref: ShapeRef) => boolean; fileAction?: (ref: ShapeRef) => React.ReactNode }) {
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
          {fileAction?.(ref)}
        </li>
      ))}
    </ol>
  );
}

export function shapeRefPicture(ref: ShapeRef): { src: string; alt: string; crop?: [number, number, number, number] } | null {
  const first = ref.images?.find((im) => shapeUrlAllowed(im.src));
  if (first) return first;
  return ref.kind === 'image' && shapeUrlAllowed(ref.target) ? { src: ref.target, alt: ref.title } : null;
}

const OPEN_WORD: Record<ShapeRefKind, string> = { image: 'View', file: 'Open file', diff: 'Open diff', message: 'Go to message', pr: 'Open', link: 'Open' };

export function RefPeek({
  reference,
  anchor,
  bounds,
  obstacles,
  canOpen,
  resolveSrc,
  readFile,
  onOpen,
  onOpenLink,
  onEnter,
  onLeave,
  fileAction,
}: {
  reference: ShapeRef;
  anchor: DOMRect;
  bounds: DOMRect;
  obstacles?: { rect: DOMRect; number: boolean }[];
  canOpen: boolean;
  resolveSrc: (src: string) => string;
  readFile?: (path: string) => Promise<string | null>;
  onOpen: () => void;
  onOpenLink?: () => void;
  onEnter: () => void;
  onLeave: () => void;
  fileAction?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; origin: string; side: string; dot: number } | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const picture = shapeRefPicture(reference);
  const isLink = reference.kind === 'pr' || reference.kind === 'link';

  useEffect(() => {
    setLines(null);
    if (picture || reference.kind !== 'file' || !readFile) return;
    let live = true;
    void readFile(reference.target).then((text) => {
      if (!live || text == null) return;
      const at = Math.max(0, (reference.line ?? 1) - 2);
      setLines(text.split('\n').slice(at, at + 6));
    });
    return () => {
      live = false;
    };
  }, [reference.n, reference.target, reference.line, reference.kind, picture?.src, readFile]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const M = 10;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const minX = bounds.left + M;
    const maxX = bounds.right - w - M;
    const minY = bounds.top + M;
    const maxY = bounds.bottom - h - M;
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, Math.max(a, b)));
    const GAPX = 24;
    const midY = clamp(anchor.top + anchor.height / 2 - h / 2, minY, maxY);
    const midX = clamp(anchor.left + anchor.width / 2 - w / 2, minX, maxX);
    const sides = [
      { side: 'right', left: anchor.right + GAPX, top: midY, origin: 'left center' },
      { side: 'left', left: anchor.left - GAPX - w, top: midY, origin: 'right center' },
      { side: 'over', left: midX, top: anchor.top - GAPX - h, origin: 'center bottom' },
      { side: 'under', left: midX, top: anchor.bottom + GAPX, origin: 'center top' },
    ].filter((c) => c.left >= minX && c.left <= Math.max(minX, maxX) && c.top >= minY && c.top <= Math.max(minY, maxY));
    const cost = (c: { left: number; top: number }) =>
      (obstacles ?? []).reduce((sum, o) => {
        const x = Math.min(c.left + w, o.rect.right) - Math.max(c.left, o.rect.left);
        const y = Math.min(c.top + h, o.rect.bottom) - Math.max(c.top, o.rect.top);
        return x > 0 && y > 0 ? sum + (o.number ? 1_000_000 : x * y) : sum;
      }, 0);
    const best = sides.length ? sides.map((c) => ({ c, v: cost(c) })).sort((a, b) => a.v - b.v)[0]!.c : { side: 'under', left: midX, top: clamp(anchor.bottom + GAPX, minY, maxY), origin: 'center top' };
    const sideways = best.side === 'right' || best.side === 'left';
    setPlace({ ...best, dot: sideways ? clamp(anchor.top + anchor.height / 2 - best.top - 4, 14, h - 22) : clamp(anchor.left + anchor.width / 2 - best.left - 4, 14, w - 22) });
  }, [anchor, bounds, lines, reference.n]);

  const open = canOpen ? onOpen : undefined;
  return (
    <div
      ref={box}
      className="shp-peek"
      role="group"
      aria-label={`Reference ${reference.n}: ${reference.title}`}
      style={place ? ({ left: place.left, top: place.top, transformOrigin: place.origin, '--dot': `${place.dot}px` } as React.CSSProperties) : { left: -9999, top: 0, visibility: 'hidden' }}
      data-placed={place ? '' : undefined}
      data-side={place?.side}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {picture ? (
        <button type="button" className="shp-peek-pic" onClick={open} aria-label={`View ${picture.alt || reference.title} full size`} tabIndex={-1}>
          {picture.crop ? (
            <span
              className="shp-peek-crop"
              role="img"
              aria-label={picture.alt || reference.title}
              style={{
                backgroundImage: `url("${encodeURI(resolveSrc(picture.src))}")`,
                backgroundSize: `${100 / picture.crop[2]}% auto`,
                backgroundPosition: `${picture.crop[2] < 1 ? (picture.crop[0] / (1 - picture.crop[2])) * 100 : 0}% ${picture.crop[3] < 1 ? (picture.crop[1] / (1 - picture.crop[3])) * 100 : 0}%`,
              }}
            />
          ) : (
            <img src={resolveSrc(picture.src)} alt={picture.alt || reference.title} />
          )}
        </button>
      ) : lines ? (
        <button type="button" className="shp-peek-code" onClick={open} tabIndex={-1} aria-label={`Open ${reference.target}`}>
          <code>{lines.map((l, i) => <span key={i}>{l || ' '}</span>)}</code>
        </button>
      ) : null}
      <div className="shp-peek-txt">
        <div className="shp-peek-t">
          <span className="shp-rb static">{reference.n}</span>
          <b>{reference.title}</b>
        </div>
        {reference.sub && <p>{reference.sub}</p>}
        <div className="shp-peek-acts">
          {!isLink && canOpen && <button type="button" tabIndex={-1} onClick={onOpen}>{OPEN_WORD[reference.kind]}</button>}
          {isLink && picture && <button type="button" tabIndex={-1} onClick={onOpen}>View</button>}
          {isLink && <button type="button" tabIndex={-1} onClick={onOpenLink}>{reference.kind === 'pr' ? 'Open pull request' : 'Open link'} ↗</button>}
          {fileAction}
        </div>
      </div>
    </div>
  );
}
