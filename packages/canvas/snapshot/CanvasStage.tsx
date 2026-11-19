/**
 * The portal: stepping from a snapshot in a plan into the canvas, and back
 * out through the same opening. See `transition.ts` for the maths.
 *
 * The stage is mounted the moment a figure is clicked. It draws the live
 * canvas clipped to the figure's box, with the camera placed so that the
 * snapshot's rectangle sits exactly where the figure drew it, and takes its
 * first step before the browser paints. Then one spring grows the opening
 * to the whole window and carries the camera to the canvas's own view.
 *
 * What makes it read as a doorway rather than a pop-up:
 * - The plan is never unmounted or scrolled. It recedes a little behind the
 *   opening (`recede`) and is exactly where it was when the person returns.
 * - The opening has an edge: a soft shadow that falls on the plan.
 * - The capture itself is drawn over the live canvas, on the same camera,
 *   and dissolves as the opening grows. The capture holds only what the
 *   figure shows, so the person steps through the picture they clicked and
 *   the rest of the board arrives around it; and when the canvas has moved
 *   on since the capture, the old picture becomes the new one with no swap.
 *   Going back, it forms again, so the opening closes onto what the figure
 *   really shows.
 * - While the snapshot is behind, the canvas offers "Update snapshot" beside
 *   "Back to plan": update on the way out, or leave it.
 *
 * Interruptible both ways: "Back to plan" mid-open turns the same spring
 * round, and a person who grabs the board takes the camera at once while
 * the opening finishes around them. With reduced motion nothing travels:
 * the canvas fades in, already in place.
 */
import { ArrowLeft, RefreshCw } from 'lucide-react';
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasStore } from '../events/store';
import { boundsOf } from '../model/document';
import type { Rect } from '../model/geometry';
import type { SnapshotCapture } from '../model/types';
import { CanvasEditor, type CanvasEditorProps } from '../react/CanvasEditor';
import { CanvasView } from '../react/CanvasView';
import { CameraController, type Size, cameraPlacing, fitRect, viewportRect } from '../view/camera';
import { indexFor } from '../view/document-index';
import { frozenStore } from './frozen';
import { type CanvasRegistry, useRegisteredCanvas } from './registry';
import { snapshotStanding } from './resolve';
import { FIGURE_MAX_ZOOM, type SnapshotOpenRequest } from './SnapshotFigure';
import { SNAPSHOT_STRINGS } from './strings';
import { type Spring, type TransitionEnds, frameAt, ghostOpacity, insetToClipPath, recedeAt, rimOpacity, springAtRest, stepSpring } from './transition';

export interface CanvasStageProps extends Pick<CanvasEditorProps, 'onAddToPlan' | 'resolveImageSrc' | 'assets' | 'linkPreview' | 'resolvePaste' | 'onOpenReference'> {
  /** What to open. Null: nothing is open. */
  request: SnapshotOpenRequest | null;
  registry?: CanvasRegistry | null;
  /** The canvas has finished closing. The host clears `request`. */
  onClosed: () => void;
  /**
   * The element that holds the plan. It recedes a little while the canvas
   * opens and comes back as it closes. Absent: the plan stays still.
   */
  recede?: () => HTMLElement | null;
}

/** The figure's corner radius, to start the opening from. */
const FIGURE_RADIUS = 10;
const FADE_MS = 140;
/** A wheel still spinning from the scroll before the click is not the person taking the camera. */
const WHEEL_GRACE_MS = 150;

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

export function CanvasStage({ request, registry, ...rest }: CanvasStageProps) {
  const store = useRegisteredCanvas(request?.canvas ?? '', registry);
  if (!request || !store || typeof document === 'undefined') return null;
  return createPortal(<OpenStage key={`${request.canvas}/${request.snapshot}`} request={request} store={store} {...rest} />, document.body);
}

function OpenStage({ request, store, onClosed, recede, ...editor }: { request: SnapshotOpenRequest; store: CanvasStore } & Omit<CanvasStageProps, 'request' | 'registry'>) {
  const camera = useMemo(() => new CameraController(), []);
  const doc = useSyncExternalStore(store.subscribe, store.getDocument, store.getDocument);
  const snapshot = doc.snapshots[request.snapshot];
  const behind = useMemo(() => !!snapshot && snapshotStanding(doc, indexFor(store), snapshot) === 'behind', [doc, snapshot, store]);
  const stage = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const rim = useRef<HTMLDivElement>(null);
  const ghostLayer = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const spring = useRef<Spring>({ p: 0, v: 0 });
  const target = useRef(1);
  const ends = useRef<TransitionEnds | null>(null);
  const cameraDriven = useRef(true);
  const frame = useRef(0);
  const last = useRef(0);
  const receding = useRef<HTMLElement | null>(null);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedAt = useRef(0);
  const [keepMounted, setKeepMounted] = useState<Rect | null>(null);
  // While it flies the view only shrinks onto its target, so nothing beyond
  // the view needs mounting. The usual margin comes back once it has landed.
  const [flying, setFlying] = useState(true);
  // The capture, drawn over the live canvas while the opening moves. Always, not only when the canvas has
  // moved on: the capture holds just what the figure shows, so as it dissolves the rest of the board arrives
  // around the picture instead of being sliced by the opening's edge.
  const [ghost, setGhost] = useState<SnapshotCapture | null>(() => store.getDocument().snapshots[request.snapshot]?.capture ?? null);

  /** The world rectangle the opening looks at: the snapshot's own, or the whole board. */
  const place = useCallback((): Rect | null => {
    const current = store.getDocument();
    return current.snapshots[request.snapshot]?.capture.rect ?? boundsOf(current, current.order);
  }, [store, request.snapshot]);

  const settlePlan = useCallback(() => {
    const el = receding.current;
    if (!el) return;
    el.style.transform = '';
    el.style.transformOrigin = '';
    el.style.opacity = '';
    el.style.filter = '';
    el.style.willChange = '';
  }, []);

  const finish = useCallback(() => {
    const el = stage.current;
    settlePlan();
    if (target.current === 0) {
      // Unmounting puts the page back in reach and returns focus to the figure (see the opening effect's cleanup).
      closed.current();
      return;
    }
    if (el) {
      delete el.dataset.busy;
      el.style.removeProperty('--pcv-chrome');
    }
    if (clip.current) clip.current.style.clipPath = '';
    if (rim.current) rim.current.style.opacity = '0';
    setGhost(null);
    setFlying(false);
  }, [request, settlePlan]);

  const apply = useCallback(
    (p: number) => {
      const current = ends.current;
      if (!current || !clip.current || !stage.current) return;
      const at = frameAt(current, p);
      const { top, right, bottom, left, radius } = at.inset;
      clip.current.style.clipPath = insetToClipPath(at.inset);
      stage.current.style.setProperty('--pcv-chrome', String(at.chrome));
      if (rim.current) {
        rim.current.style.inset = `${top}px ${right}px ${bottom}px ${left}px`;
        rim.current.style.borderRadius = `${radius}px`;
        rim.current.style.opacity = String(rimOpacity(p));
      }
      if (ghostLayer.current) ghostLayer.current.style.opacity = String(ghostOpacity(p));
      const plan = receding.current;
      if (plan) {
        const away = recedeAt(p);
        plan.style.transform = `scale(${away.scale})`;
        plan.style.opacity = String(away.opacity);
        plan.style.filter = away.blur > 0.05 ? `blur(${away.blur.toFixed(2)}px)` : '';
      }
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

  /** Let the plan recede about the centre of the opening, so the figure stays under it. */
  const holdPlan = useCallback(
    (from: Rect) => {
      const el = recede?.() ?? null;
      receding.current = el;
      if (!el) return;
      const box = el.getBoundingClientRect();
      el.style.transformOrigin = `${from.x + from.w / 2 - box.left}px ${from.y + from.h / 2 - box.top}px`;
      el.style.willChange = 'transform, opacity, filter';
    },
    [recede],
  );

  // Open. Runs before the first paint, so the stage never shows un-placed.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const viewport = { w: el.clientWidth, h: el.clientHeight };
    const world = place();
    const from = boxOf(request.origin);
    const end = world ? openCamera(world, viewport) : camera.get();
    const stopWheel = (event: WheelEvent) => event.preventDefault();
    el.addEventListener('wheel', stopWheel, { passive: false });
    openedAt.current = performance.now();
    // The page behind takes no pointer, no focus and no reading while the canvas is open: everything else in
    // the body is made inert, which is also what keeps Tab inside the canvas. Put back exactly as it was.
    const silenced: HTMLElement[] = [];
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === el || !(sibling instanceof HTMLElement) || sibling.inert) continue;
      sibling.inert = true;
      silenced.push(sibling);
    }
    back.current?.focus({ preventScroll: true });

    if (!world || !from || prefersReducedMotion()) {
      camera.set(end);
      spring.current = { p: 1, v: 0 };
      setGhost(null);
      setFlying(false);
      el.style.opacity = '0';
      el.dataset.fade = '';
      // Read the style back so the browser takes 0 as the start of the fade.
      void el.offsetWidth;
      el.style.opacity = '1';
    } else {
      ends.current = { from, viewport, startCamera: cameraPlacing(world, from, FIGURE_MAX_ZOOM), endCamera: end, radius: FIGURE_RADIUS };
      setKeepMounted(viewportRect(end, viewport));
      holdPlan(from);
      el.dataset.busy = '';
      // One step now: the first painted frame has already left the figure.
      spring.current = stepSpring({ p: 0, v: 0 }, 1, 1 / 60);
      apply(spring.current.p);
      el.dataset.motion = 'started';
      run();
    }
    return () => {
      el.removeEventListener('wheel', stopWheel);
      for (const sibling of silenced) sibling.inert = false;
      // Back where the person came from, now that it can take focus again.
      if (target.current === 0) request.returnFocus?.focus?.({ preventScroll: true });
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      if (fade.current) clearTimeout(fade.current);
      fade.current = null;
      settlePlan();
    };
    // Opening happens once per mount; the stage is keyed by what it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    const el = stage.current;
    if (!el || target.current === 0) return;
    target.current = 0;
    const viewport = { w: el.clientWidth, h: el.clientHeight };
    const world = place();
    // The figure is measured where it rests, not where a receded plan shows it.
    settlePlan();
    const from = boxOf(request.origin);
    if (!world || !from || prefersReducedMotion()) {
      // Nowhere to go back through (the figure left the page), or no motion wanted.
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      el.dataset.fade = '';
      el.style.opacity = '0';
      if (fade.current) clearTimeout(fade.current);
      fade.current = setTimeout(() => {
        fade.current = null;
        finish();
      }, FADE_MS);
      return;
    }
    holdPlan(from);
    const current = store.getDocument();
    const now = current.snapshots[request.snapshot];
    // The opening closes onto what the figure shows: its capture forms again over the board.
    setGhost(now?.capture ?? null);
    if (spring.current.p >= 0.98) {
      // Fully open: go back from wherever the person left the camera.
      ends.current = { from, viewport, startCamera: cameraPlacing(world, from, FIGURE_MAX_ZOOM), endCamera: camera.get(), radius: FIGURE_RADIUS };
      cameraDriven.current = true;
    } else if (ends.current) {
      // Still opening: go back the way it came. If the person has taken the
      // camera, it stays theirs and only the opening closes.
      ends.current = { ...ends.current, from };
    }
    run();
  }, [camera, finish, holdPlan, place, request, run, settlePlan, store]);

  // A ghost mounted for the way back starts at the opacity the motion is at.
  useLayoutEffect(() => {
    if (ghost && ghostLayer.current) ghostLayer.current.style.opacity = String(ghostOpacity(spring.current.p));
  }, [ghost]);

  return (
    <div
      ref={stage}
      className="pcv pcv-stage"
      role="dialog"
      aria-modal="true"
      aria-label={doc.title || SNAPSHOT_STRINGS.open}
      onKeyDown={(event) => {
        // Escape leaves: first the words being typed, then the canvas. What a dialog does everywhere.
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        const typing = (event.target as HTMLElement).closest?.('[contenteditable]') as HTMLElement | null;
        event.stopPropagation();
        if (typing) typing.blur();
        else close();
      }}
    >
      <div ref={rim} className="pcv-stage-rim" style={{ opacity: 0 }} />
      <div ref={clip} className="pcv-stage-clip">
        <CanvasEditor
          store={store}
          camera={camera}
          keepMounted={keepMounted}
          overscan={flying ? 0 : undefined}
          {...editor}
          onUserCamera={() => {
            if (performance.now() - openedAt.current > WHEEL_GRACE_MS) cameraDriven.current = false;
          }}
          lead={
            <div className="pcv-bar pcv-bar-top">
              <button ref={back} type="button" className="pcv-btn" onClick={close}>
                <ArrowLeft />
                {SNAPSHOT_STRINGS.back}
              </button>
              {behind ? (
                <>
                  <span className="pcv-sep" aria-hidden="true" />
                  <button type="button" className="pcv-btn" onClick={() => store.dispatch({ type: 'update-snapshot', id: request.snapshot })}>
                    <RefreshCw />
                    {SNAPSHOT_STRINGS.updateSnapshot}
                  </button>
                </>
              ) : null}
            </div>
          }
        />
        {ghost ? (
          <div ref={ghostLayer} className="pcv-stage-ghost" aria-hidden="true">
            <CanvasView store={frozenStore(ghost)} camera={camera} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
