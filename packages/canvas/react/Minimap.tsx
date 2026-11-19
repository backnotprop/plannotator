/**
 * The map: the whole board in a small panel, with the part on screen
 * marked. Press or drag in it to go there.
 *
 * The board is drawn into a small canvas of its own, in the corner, when
 * the document changes (at most once a frame). The mark for what is on
 * screen is a separate element moved by the camera, so panning redraws
 * nothing. It is never a layer over the board.
 */
import React, { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { CanvasStore } from '../events/store';
import { boundsOf } from '../model/document';
import type { Rect } from '../model/geometry';
import { isPlaced } from '../model/types';
import { type CameraController, type Size, viewportRect } from '../view/camera';

export const MINIMAP_SIZE = { w: 200, h: 132 } as const;

/** The board's bounds with a margin, and the scale that fits them into the map. */
export function minimapFrame(all: Rect | null, size: Size): { world: Rect; scale: number; dx: number; dy: number } {
  const world = all ? { x: all.x - 60, y: all.y - 60, w: all.w + 120, h: all.h + 120 } : { x: 0, y: 0, w: 1000, h: 660 };
  const scale = Math.min(size.w / world.w, size.h / world.h);
  return { world, scale, dx: (size.w - world.w * scale) / 2, dy: (size.h - world.h * scale) / 2 };
}

export function Minimap({ store, camera, viewSize, label }: { store: CanvasStore; camera: CameraController; viewSize: () => Size; label: string }) {
  const doc = useSyncExternalStore(store.subscribe, store.getDocument, store.getDocument);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const frame = useRef(minimapFrame(null, MINIMAP_SIZE));
  const pending = useRef(0);

  const placeMark = () => {
    const el = mark.current;
    if (!el) return;
    const { world, scale, dx, dy } = frame.current;
    const view = viewportRect(camera.get(), viewSize());
    el.style.transform = `translate(${dx + (view.x - world.x) * scale}px, ${dy + (view.y - world.y) * scale}px)`;
    el.style.width = `${Math.max(4, view.w * scale)}px`;
    el.style.height = `${Math.max(4, view.h * scale)}px`;
  };

  useEffect(() => {
    if (pending.current) cancelAnimationFrame(pending.current);
    pending.current = requestAnimationFrame(() => {
      pending.current = 0;
      const el = canvas.current;
      const context = el?.getContext('2d');
      if (!el || !context) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      el.width = MINIMAP_SIZE.w * ratio;
      el.height = MINIMAP_SIZE.h * ratio;
      frame.current = minimapFrame(boundsOf(doc, doc.order), MINIMAP_SIZE);
      const { world, scale, dx, dy } = frame.current;
      const style = getComputedStyle(el);
      const ink = style.getPropertyValue('--pcv-muted').trim() || '#888';
      const line = style.getPropertyValue('--pcv-line').trim() || '#ccc';
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, MINIMAP_SIZE.w, MINIMAP_SIZE.h);
      // Frames as outlines first, then everything else as small patches.
      for (const id of doc.order) {
        const object = doc.objects[id];
        if (!object || !isPlaced(object)) continue;
        const x = dx + (object.x - world.x) * scale;
        const y = dy + (object.y - world.y) * scale;
        const w = Math.max(1, object.w * scale);
        const h = Math.max(1, object.h * scale);
        if (object.type === 'frame') {
          context.strokeStyle = line;
          context.lineWidth = 1;
          context.strokeRect(x + 0.5, y + 0.5, w, h);
        } else if (object.type === 'ink') {
          // A drawn line is a line here too, never a filled patch: a ring round a third of the board is not a block.
          const step = Math.max(2, (Math.ceil(object.points.length / 48) >> 1) << 1 || 2);
          context.strokeStyle = ink;
          context.lineWidth = 1;
          context.beginPath();
          for (let i = 0; i + 1 < object.points.length; i += step) context.lineTo(x + object.points[i] * w, y + object.points[i + 1] * h);
          context.lineTo(x + object.points[object.points.length - 2] * w, y + object.points[object.points.length - 1] * h);
          context.stroke();
        } else {
          context.globalAlpha = object.type === 'text' ? 0.25 : 0.55;
          context.fillStyle = ink;
          context.fillRect(x, y, w, h);
          context.globalAlpha = 1;
        }
      }
      placeMark();
    });
    return () => {
      if (pending.current) cancelAnimationFrame(pending.current);
      pending.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  useLayoutEffect(() => {
    placeMark();
    return camera.subscribe(placeMark);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  /** Put the middle of the view on the board point under the pointer. */
  const go = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const { world, scale, dx, dy } = frame.current;
    const size = viewSize();
    const c = camera.get();
    const wx = world.x + (event.clientX - box.left - dx) / scale;
    const wy = world.y + (event.clientY - box.top - dy) / scale;
    camera.set({ x: wx - size.w / c.z / 2, y: wy - size.h / c.z / 2, z: c.z });
  };

  return (
    <div
      className="pcv-minimap"
      role="img"
      aria-label={label}
      style={{ width: MINIMAP_SIZE.w, height: MINIMAP_SIZE.h }}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        go(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons & 1) go(event);
      }}
    >
      <canvas ref={canvas} style={{ width: MINIMAP_SIZE.w, height: MINIMAP_SIZE.h }} />
      <div ref={mark} className="pcv-minimap-view" />
    </div>
  );
}
