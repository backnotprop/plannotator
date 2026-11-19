/**
 * The camera: which part of the world a view shows. View state, not document
 * state: it is never saved with the canvas and never synced.
 *
 * `x`, `y` is the world point at the view's top-left corner and `z` is the
 * zoom (screen pixels per world unit), so
 *   screen = (world - camera) * z      world = screen / z + camera
 *
 * The maths is pure. `CameraController` holds one camera and tells its
 * listeners when it moves; the renderer listens and writes one CSS transform,
 * so a pan or a zoom never goes through React.
 */
import type { Point, Rect } from '../model/geometry';

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface Size {
  w: number;
  h: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export const screenToWorld = (camera: Camera, p: Point): Point => ({ x: p.x / camera.z + camera.x, y: p.y / camera.z + camera.y });

export const worldToScreen = (camera: Camera, p: Point): Point => ({ x: (p.x - camera.x) * camera.z, y: (p.y - camera.y) * camera.z });

export const worldRectToScreen = (camera: Camera, r: Rect): Rect => ({
  x: (r.x - camera.x) * camera.z,
  y: (r.y - camera.y) * camera.z,
  w: r.w * camera.z,
  h: r.h * camera.z,
});

/** The world rect a view of this size shows. */
export const viewportRect = (camera: Camera, size: Size): Rect => ({ x: camera.x, y: camera.y, w: size.w / camera.z, h: size.h / camera.z });

export const panBy = (camera: Camera, dxScreen: number, dyScreen: number): Camera => ({
  x: camera.x - dxScreen / camera.z,
  y: camera.y - dyScreen / camera.z,
  z: camera.z,
});

/** Zoom to `z`, keeping the world point under screen point `at` where it is. */
export function zoomAt(camera: Camera, z: number, at: Point): Camera {
  const next = clampZoom(z);
  const world = screenToWorld(camera, at);
  return { x: world.x - at.x / next, y: world.y - at.y / next, z: next };
}

/** Room kept clear round what a view is fitted to, in screen pixels: one number for every side, or one each way. */
export type FitPadding = number | { x: number; y: number };

/**
 * The room "fit" keeps round a whole board in an editor of this size.
 *
 * Above and below, the editor's bars lie over the board, so the room there
 * clears them: 72 px in any view 216 px tall or more, a third of the height
 * in one shorter than that. At the sides nothing lies over the board: the
 * room is a twentieth of the width, 72 px at most and 12 at least. So a
 * view 1440 px wide or more is as it always was; a narrower one gives a
 * board more of its width (36 px a side at 720, 20 px at 390, where it was
 * 72), and a board that is wider than it is tall, as most are, is drawn
 * larger for it.
 */
export function fitPadding(size: Size): { x: number; y: number } {
  return {
    x: Math.round(Math.max(12, Math.min(72, size.w * 0.05))),
    // The bars are as tall in a short view as in a tall one: the room for them shrinks only when a third of the view is less.
    y: Math.round(Math.max(12, Math.min(72, size.h / 3))),
  };
}

/**
 * The camera that shows `target` whole and centred in a view of `size`, with
 * `padding` screen pixels around it. `maxZoom` stops a small target from
 * being blown up.
 */
export function fitRect(target: Rect, size: Size, padding: FitPadding = 0, maxZoom = MAX_ZOOM): Camera {
  const padX = typeof padding === 'number' ? padding : padding.x;
  const padY = typeof padding === 'number' ? padding : padding.y;
  const availW = Math.max(1, size.w - padX * 2);
  const availH = Math.max(1, size.h - padY * 2);
  const z = Math.max(MIN_ZOOM, Math.min(maxZoom, availW / Math.max(1, target.w), availH / Math.max(1, target.h)));
  return {
    x: target.x + target.w / 2 - size.w / z / 2,
    y: target.y + target.h / 2 - size.h / z / 2,
    z,
  };
}

/**
 * The camera of a view of any size that puts world rect `world` exactly over
 * screen rect `screen` (given in that view's own coordinates), centred and
 * no larger than `maxZoom`: the same picture `fitRect` gives a view that is
 * only as big as `screen`. The open transition starts here: the full-size canvas draws the snapshot's part of
 * the world exactly where the figure drew it.
 */
export function cameraPlacing(world: Rect, screen: Rect, maxZoom = Infinity): Camera {
  const z = Math.max(1e-6, Math.min(maxZoom, screen.w / Math.max(1, world.w), screen.h / Math.max(1, world.h)));
  // Centre the world rect in the screen rect (the two may differ in shape).
  const cx = screen.x + screen.w / 2;
  const cy = screen.y + screen.h / 2;
  return { x: world.x + world.w / 2 - cx / z, y: world.y + world.h / 2 - cy / z, z };
}

/**
 * A camera between two others. Zoom is blended in log space and the focus
 * point is carried with it, so the picture grows at a steady rate instead of
 * rushing at one end. `size` is the view both cameras belong to.
 */
export function lerpCamera(a: Camera, b: Camera, t: number, size: Size): Camera {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const z = a.z * Math.pow(b.z / a.z, t);
  const acx = a.x + size.w / a.z / 2;
  const acy = a.y + size.h / a.z / 2;
  const bcx = b.x + size.w / b.z / 2;
  const bcy = b.y + size.h / b.z / 2;
  // Blend the centre by how far the zoom has come, so the target stays put
  // on screen while it grows.
  const k = a.z === b.z ? t : (1 / a.z - 1 / z) / (1 / a.z - 1 / b.z);
  const cx = acx + (bcx - acx) * k;
  const cy = acy + (bcy - acy) * k;
  return { x: cx - size.w / z / 2, y: cy - size.h / z / 2, z };
}

export const camerasEqual = (a: Camera, b: Camera): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

export class CameraController {
  private camera: Camera;
  private readonly listeners = new Set<(camera: Camera) => void>();

  constructor(camera: Camera = { x: 0, y: 0, z: 1 }) {
    this.camera = camera;
  }

  get = (): Camera => this.camera;

  set(camera: Camera): void {
    const next = { x: camera.x, y: camera.y, z: clampZoom(camera.z) };
    if (camerasEqual(next, this.camera)) return;
    this.camera = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  subscribe = (listener: (camera: Camera) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
