// Shape's landing: one grid of same-sized cards, newest first (the approved
// "shape-landing-grid"). A card is a 16:10 crop of the board's Picture, the
// title on one line and one quiet line, "project · when" ("drawing now"
// while the agent draws). A violet dot before the title: changed since you
// looked. Find filters as you type. The same grid is the Inbox's Shape page
// and the standalone page; the host draws its own header around it.
//
// Host-neutral like ShapeSurface: the items come in as props.
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ShapeDrawnView, ShapeRef } from '@plannotator/core/shape';
import { ShapeDrawn } from './ShapeDrawn';

export interface ShapeGridItem {
  id: string;
  title: string;
  /** The project's name. */
  project: string;
  /** When it last changed (ISO). */
  updated: string;
  /** The agent is drawing now. */
  drawing: boolean;
  /** Changed since you looked. */
  changed: boolean;
  /** The latest Picture, for the preview. Absent: an empty preview. */
  picture?: ShapeDrawnView | null;
  refs?: readonly ShapeRef[];
}

/** "now", "3m", "6h", "1d": the grid's and the search's short time. */
export function shapeAgo(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The items a query finds: in the title or the project, any case. */
export function filterShapeItems<T extends { title: string; project: string }>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((it) => it.title.toLowerCase().includes(q) || it.project.toLowerCase().includes(q));
}

const THUMB_W = 1200;
const THUMB_H = 750;
const ZOOM = 1.11111; // the mock's crop: a little past the picture's margins

/** A board's Picture, small: drawn once at a desktop width, scaled to the card. */
export function ShapeThumb({ picture, refs, className, resolveSrc }: { picture?: ShapeDrawnView | null; refs?: readonly ShapeRef[]; className?: string; resolveSrc?: (src: string) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A canvas board fills its own canvas, up to the edge: show all of it.
  const zoom = picture?.width ? 1 : ZOOM;
  const k = (w * zoom) / THUMB_W;
  return (
    <div ref={ref} className={`shp-thumb${className ? ` ${className}` : ''}`} aria-hidden="true">
      {picture && w > 0 && (
        <div className="shp-thumb-in" style={{ width: THUMB_W, height: THUMB_H, transform: `translateX(${(-(zoom - 1) / 2) * w}px) scale(${k})` }}>
          <ShapeDrawn drawn={picture} refs={refs} phase="drawn" reduce resolveSrc={resolveSrc} />
        </div>
      )}
    </div>
  );
}

export function ShapeGrid({
  items,
  onOpen,
  query,
  now,
  empty,
  assetUrl,
}: {
  items: readonly ShapeGridItem[];
  onOpen: (id: string) => void;
  /** The Find box's words (the host owns the box). */
  query?: string;
  now?: number;
  /** What to show with no boards (or none found). */
  empty?: React.ReactNode;
  /** Where a board's kept pictures load from, so a thumbnail shows them. */
  assetUrl?: (id: string, src: string) => string;
}) {
  const shown = useMemo(
    () => filterShapeItems(items, query ?? '').sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated)),
    [items, query],
  );
  if (!shown.length) return <div className="shp-grid-empty">{empty ?? (query ? 'No board matches.' : 'No boards yet.')}</div>;
  return (
    <div className="shp-grid" role="list">
      {shown.map((it) => (
        <div
          key={it.id}
          role="listitem"
          tabIndex={0}
          className="shp-gcard"
          data-shape-card={it.id}
          aria-label={`${it.title}${it.changed ? ', changed since you looked' : ''}`}
          onClick={() => onOpen(it.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpen(it.id);
            }
          }}
        >
          <ShapeThumb picture={it.picture} refs={it.refs} className="shp-gprev" resolveSrc={assetUrl ? (src) => assetUrl(it.id, src) : undefined} />
          <div className="shp-glab">
            <div className="shp-gt">
              {it.changed && <span className="shp-gdot" aria-hidden="true" />}
              <span>{it.title}</span>
            </div>
            <div className="shp-gm">
              {it.project} · {it.drawing ? 'drawing now' : shapeAgo(it.updated, now)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
