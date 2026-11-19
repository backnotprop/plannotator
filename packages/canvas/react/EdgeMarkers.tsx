/**
 * Marks at the board's edges for what the furthest zoom cannot show.
 *
 * A board can be wider than fits at the smallest zoom (two things a million
 * units apart). "Zoom to fit" then shows the middle, and nothing would say
 * that more lies outside. At that zoom, and only then, each edge with
 * something beyond it gets a mark; pressing it goes to the nearest thing
 * that way.
 */
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { CanvasStore } from '../events/store';
import { boundsOf, objectBounds } from '../model/document';
import type { CanvasDocument } from '../model/types';
import { type CameraController, MIN_ZOOM, type Size, viewportRect } from '../view/camera';

export type Edge = 'n' | 'e' | 's' | 'w';
const EDGES: readonly Edge[] = ['n', 'e', 's', 'w'];
const GLYPHS = { n: ChevronUp, e: ChevronRight, s: ChevronDown, w: ChevronLeft } as const;

/** The edges of `view` that some of `all` lies beyond. */
export function edgesBeyond(all: { x: number; y: number; w: number; h: number } | null, view: { x: number; y: number; w: number; h: number }): Edge[] {
  if (!all) return [];
  const out: Edge[] = [];
  if (all.y < view.y) out.push('n');
  if (all.x + all.w > view.x + view.w) out.push('e');
  if (all.y + all.h > view.y + view.h) out.push('s');
  if (all.x < view.x) out.push('w');
  return out;
}

/** The middle of the nearest object wholly beyond one edge of `view`, or null. */
export function nearestBeyond(doc: CanvasDocument, view: { x: number; y: number; w: number; h: number }, edge: Edge): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let least = Infinity;
  for (const id of doc.order) {
    const r = objectBounds(doc, id);
    if (!r) continue;
    const gap = edge === 'n' ? view.y - (r.y + r.h) : edge === 's' ? r.y - (view.y + view.h) : edge === 'w' ? view.x - (r.x + r.w) : r.x - (view.x + view.w);
    if (gap < 0 || gap >= least) continue;
    least = gap;
    best = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }
  return best;
}

export function EdgeMarkers({ store, camera, viewSize, label }: { store: CanvasStore; camera: CameraController; viewSize: () => Size; label: string }) {
  const [edges, setEdges] = useState('');
  useEffect(() => {
    let bounds: { doc: CanvasDocument; all: ReturnType<typeof boundsOf> } | null = null;
    const read = () => {
      const c = camera.get();
      let next = '';
      // Only at the furthest zoom: anywhere else, zooming out is how more is seen.
      if (c.z <= MIN_ZOOM * 1.001) {
        const doc = store.getDocument();
        if (bounds?.doc !== doc) bounds = { doc, all: boundsOf(doc, doc.order) };
        next = edgesBeyond(bounds.all, viewportRect(c, viewSize())).join('');
      }
      setEdges((before) => (before === next ? before : next));
    };
    read();
    const offCamera = camera.subscribe(read);
    const offStore = store.subscribe(read);
    return () => {
      offCamera();
      offStore();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, store]);

  if (!edges) return null;
  const go = (edge: Edge) => {
    const c = camera.get();
    const size = viewSize();
    const to = nearestBeyond(store.getDocument(), viewportRect(c, size), edge);
    if (to) camera.set({ x: to.x - size.w / c.z / 2, y: to.y - size.h / c.z / 2, z: c.z });
  };
  return (
    <>
      {EDGES.filter((edge) => edges.includes(edge)).map((edge) => {
        const Glyph = GLYPHS[edge];
        return (
          <button key={edge} type="button" className="pcv-edge" data-edge={edge} aria-label={label} title={label} onClick={() => go(edge)} onPointerDown={(event) => event.stopPropagation()}>
            <Glyph />
          </button>
        );
      })}
    </>
  );
}
