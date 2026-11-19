/**
 * The canvas, opened from a snapshot in a plan, and the motion between the
 * two. See `transition.ts` for what moves and why it is a spring.
 *
 * The stage is mounted the moment a figure is clicked, already drawing the
 * snapshot's part of the world exactly over the figure, and takes its first
 * step before the browser paints: the first frame after the click has moved.
 *
 * Interruptible in both directions: pressing "Back to plan" while it is
 * still opening turns the same spring round, and a person who grabs the
 * board mid-flight takes the camera at once while the window finishes
 * opening around them.
 *
 * With reduced motion nothing travels: the canvas fades in, already in
 * place.
 */
import { ArrowLeft } from 'lucide-react';
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasStore } from '../events/store';
import { boundsOf } from '../model/document';
import type { Rect } from '../model/geometry';
import type { Snapshot } from '../model/types';
import { CanvasEditor, type CanvasEditorProps } from '../react/CanvasEditor';
import { CameraController, type Size, cameraPlacing, fitRect, viewportRect } from '../view/camera';
import { indexFor } from '../view/document-index';
import type { PlanDropTarget } from './plan-drop';
import { type CanvasRegistry, useRegisteredCanvas } from './registry';
import { resolveSnapshot } from './resolve';
import { FIGURE_MAX_ZOOM, type SnapshotOpenRequest } from './SnapshotFigure';
import { SNAPSHOT_STRINGS } from './strings';
import { type Spring, type TransitionEnds, frameAt, insetToClipPath, springAtRest, stepSpring } from './transition';

export interface CanvasStageProps {
  /** What to open. Null: nothing is open. */
  request: SnapshotOpenRequest | null;
  registry?: CanvasRegistry | null;
  /** The canvas has finished closing. The host clears `request`. */
  onClosed: () => void;
  onAddToPlan?: (snapshot: Snapshot, drop: PlanDropTarget | null) => void;
  resolveImageSrc?: (src: string) => string;
  /** Passed to the editor: see `CanvasEditorProps`. */
  linkPreview?: CanvasEditorProps['linkPreview'];
  resolvePaste?: CanvasEditorProps['resolvePaste'];
  onOpenReference?: CanvasEditorProps['onOpenReference'];
}

/** The figure's corner radius, to start the clip from. */
const FIGURE_RADIUS = 12;
const FADE_MS = 140;

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const boxOf = (el: HTMLElement): Rect | null => {
  if (!el.isConnected) return null;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? { x: box.left, y: box.top, w: box.width, h: box.height } : null;
};

/** The camera an opened snapshot settles on: the snapshot, whole, with air around it. */
export function openCamera(target: Rect, viewport: Size) {
  const padding = Math.max(24, Math.min(96, Math.min(viewport.w, viewport.h) * 0.12));
  return fitRect(target, viewport, padding, 1.25);
}

export function CanvasStage({ request, registry, onClosed, ...editor }: CanvasStageProps) {
  const store = useRegisteredCanvas(request?.canvas ?? '', registry);
  if (!request || !store || typeof document === 'undefined') return null;
  return createPortal(
    <OpenStage key={`${request.canvas}/${request.snapshot}`} request={request} store={store} onClosed={onClosed} {...editor} />,
    document.body,
  );
}

function OpenStage({ request, store, onClosed, ...editor }: { request: SnapshotOpenRequest; store: CanvasStore } & Omit<CanvasStageProps, 'request' | 'registry'>) {
  const camera = useMemo(() => new CameraController(), []);
  const stage = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const spring = useRef<Spring>({ p: 0, v: 0 });
  const target = useRef(1);
  const ends = useRef<TransitionEnds | null>(null);
  const cameraDriven = useRef(true);
  const frame = useRef(0);
  const last = useRef(0);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  const [keepMounted, setKeepMounted] = useState<Rect | null>(null);
  // While it flies the view only shrinks onto its target, so nothing beyond
  // the view needs mounting. The usual margin comes back once it has landed.
  const [flying, setFlying] = useState(true);

  const snapshotRect = useCallback((): Rect | null => {
    const doc = store.getDocument();
    return resolveSnapshot(doc, indexFor(store), request.snapshot).rect ?? boundsOf(doc, doc.order);
  }, [store, request.snapshot]);

  const finish = useCallback(() => {
    const el = stage.current;
    if (target.current === 0) {
      request.returnFocus?.focus?.({ preventScroll: true });
      closed.current();
      return;
    }
    if (el) {
      delete el.dataset.busy;
      el.style.removeProperty('--pcv-chrome');
    }
    setFlying(false);
    if (clip.current) clip.current.style.clipPath = '';
  }, [request]);

  const apply = useCallback(
    (p: number) => {
      const current = ends.current;
      if (!current || !clip.current || !stage.current) return;
      const at = frameAt(current, p);
      clip.current.style.clipPath = insetToClipPath(at.inset);
      stage.current.style.setProperty('--pcv-chrome', String(at.chrome));
      if (cameraDriven.current) camera.set(at.camera);
    },
    [camera],
  );

  const tick = useCallback(
    (now: number) => {
      frame.current = 0;
      const dt = Math.min(0.05, Math.max(0, (now - last.current) / 1000));
      last.current = now;
      spring.current = stepSpring(spring.current, target.current, dt);
      if (springAtRest(spring.current, target.current)) {
        spring.current = { p: target.current, v: 0 };
        apply(target.current);
        finish();
        return;
      }
      apply(spring.current.p);
      frame.current = requestAnimationFrame(tick);
    },
    [apply, finish],
  );

  const run = useCallback(() => {
    if (stage.current) stage.current.dataset.busy = '';
    if (frame.current) return;
    last.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  }, [tick]);

  // Open. Runs before the first paint, so the stage never shows un-placed.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const viewport = { w: el.clientWidth, h: el.clientHeight };
    const world = snapshotRect();
    const from = boxOf(request.origin);
    const end = world ? openCamera(world, viewport) : camera.get();
    const stopWheel = (event: WheelEvent) => event.preventDefault();
    el.addEventListener('wheel', stopWheel, { passive: false });
    back.current?.focus({ preventScroll: true });

    if (!world || !from || prefersReducedMotion()) {
      camera.set(end);
      spring.current = { p: 1, v: 0 };
      el.style.opacity = '0';
      el.dataset.fade = '';
      // Read the style back so the browser takes 0 as the start of the fade.
      void el.offsetWidth;
      el.style.opacity = '1';
    } else {
      ends.current = { from, viewport, startCamera: cameraPlacing(world, from, FIGURE_MAX_ZOOM), endCamera: end, radius: FIGURE_RADIUS };
      setKeepMounted(viewportRect(end, viewport));
      el.dataset.busy = '';
      // One step now: the first painted frame has already left the figure.
      spring.current = stepSpring({ p: 0, v: 0 }, 1, 1 / 60);
      apply(spring.current.p);
      el.dataset.motion = 'started';
      run();
    }
    return () => {
      el.removeEventListener('wheel', stopWheel);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    // Opening happens once per mount; the stage is keyed by what it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    const el = stage.current;
    if (!el || target.current === 0) return;
    target.current = 0;
    const viewport = { w: el.clientWidth, h: el.clientHeight };
    const world = snapshotRect();
    const from = boxOf(request.origin);
    if (!world || !from || prefersReducedMotion()) {
      // Nowhere to fly back to (the figure left the page), or no motion wanted.
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      el.dataset.fade = '';
      el.style.opacity = '0';
      setTimeout(finish, FADE_MS);
      return;
    }
    if (spring.current.p >= 0.98) {
      // Fully open: fly from wherever the person left the camera.
      ends.current = { from, viewport, startCamera: cameraPlacing(world, from, FIGURE_MAX_ZOOM), endCamera: camera.get(), radius: FIGURE_RADIUS };
      cameraDriven.current = true;
    } else if (ends.current) {
      // Still opening: go back the way it came. If the person has taken the
      // camera, it stays theirs and only the window closes.
      ends.current = { ...ends.current, from };
    }
    run();
  }, [camera, finish, request.origin, run, snapshotRect]);

  const title = store.getDocument().title;

  return (
    <div ref={stage} className="pcv pcv-stage" role="dialog" aria-modal="true" aria-label={title || SNAPSHOT_STRINGS.open}>
      <div ref={clip} className="pcv-stage-clip">
        <CanvasEditor
          store={store}
          camera={camera}
          keepMounted={keepMounted}
          overscan={flying ? 0 : undefined}
          {...editor}
          onUserCamera={() => {
            cameraDriven.current = false;
          }}
        >
          <div className="pcv-bar pcv-bar-top">
            <button ref={back} type="button" className="pcv-btn" onClick={close}>
              <ArrowLeft />
              {SNAPSHOT_STRINGS.back}
            </button>
          </div>
        </CanvasEditor>
      </div>
    </div>
  );
}
