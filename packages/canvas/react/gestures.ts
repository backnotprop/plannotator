/**
 * Pointer and wheel input for the editor, as one small state machine. It
 * reads the pointer, decides which gesture is under way, and speaks only in
 * commands (to the store), camera moves and editor state. No React here:
 * the editor creates one controller and forwards DOM events to it.
 *
 * There are no keyboard shortcuts. Shift held during a click or a marquee
 * adds to the selection; that is a modifier on a pointer gesture, not a key
 * command, and everything it does can also be done by marquee.
 */
import type { CanvasStore } from '../events/store';
import { selectionUnit } from '../model/document';
import { type Point, type Rect, rectFromPoints } from '../model/geometry';
import { createId } from '../model/ids';
import { type CanvasObject, type ObjectId, isPlaced } from '../model/types';
import { type CameraController, panBy, screenToWorld, zoomAt } from '../view/camera';
import { indexFor } from '../view/document-index';
import { hitTest, objectsInRect, withFrameContents } from '../view/hit-test';
import { routesFor } from '../view/routes';
import type { EditorState, Tool } from './editor-state';

/** Screen pixels a pointer may wander before a press becomes a drag. */
const SLOP = 4;
const HIT_PX = 5;

type Handle = 'nw' | 'ne' | 'sw' | 'se';

type Gesture =
  | { kind: 'pan'; last: Point }
  | { kind: 'pinch'; distance: number; center: Point }
  | { kind: 'press'; start: Point; hit: ObjectId | null; additive: boolean; wasSelected: boolean }
  | { kind: 'move'; id: string; ids: ObjectId[]; lastWorld: Point; pending: Point | null }
  | { kind: 'marquee'; start: Point; base: ObjectId[] }
  | { kind: 'region'; start: Point }
  | { kind: 'arrow'; from: Point; fromId: ObjectId | null }
  | { kind: 'resize'; id: string; object: ObjectId; handle: Handle; start: Rect; origin: Point };

export interface GestureHost {
  store: CanvasStore;
  camera: CameraController;
  state: EditorState;
  /** The view's root element: pointer positions are measured against it. */
  root: () => HTMLElement | null;
  /** The person moved the camera themselves (a transition should let go). */
  onUserCamera?: () => void;
}

/** The gesture that joins placing an object with typing its first words, so the two are one undo step. */
export const firstEditGesture = (id: ObjectId): string => `first-${id}`;

const DEFAULTS: Record<'box' | 'note' | 'text', { w: number; h: number }> = {
  box: { w: 168, h: 56 },
  note: { w: 172, h: 72 },
  text: { w: 200, h: 28 },
};

export class GestureController {
  private gesture: Gesture | null = null;
  private readonly pointers = new Map<number, Point>();
  private frame = 0;

  constructor(private readonly host: GestureHost) {}

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.gesture = null;
    this.pointers.clear();
  }

  private local(event: { clientX: number; clientY: number }): Point {
    const box = this.host.root()?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }

  private world(p: Point): Point {
    return screenToWorld(this.host.camera.get(), p);
  }

  private setDragging(on: boolean): void {
    const root = this.host.root();
    if (!root) return;
    if (on) root.dataset.dragging = '';
    else delete root.dataset.dragging;
  }

  onPointerDown = (event: React.PointerEvent | PointerEvent): void => {
    const { store, state, camera } = this.host;
    // The right button belongs to the browser's menu. It never drags.
    if (event.button === 2) return;
    const target = event.target as HTMLElement;
    if (target.closest?.('.pcv-bar')) return;
    const p = this.local(event);
    this.pointers.set(event.pointerId, p);
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      state.set({ marquee: null, draftArrow: null });
      this.host.onUserCamera?.();
      return;
    }
    if (this.pointers.size > 2) return;

    const tool: Tool = state.get().tool;
    // Typing ends by losing focus, so the words are saved by the same path
    // whatever ended it.
    if (state.get().editingId) (document.activeElement as HTMLElement | null)?.blur?.();

    if (tool === 'hand' || event.button === 1) {
      this.gesture = { kind: 'pan', last: p };
      this.setDragging(true);
      this.host.onUserCamera?.();
      return;
    }

    const handle = target.closest?.<HTMLElement>('[data-handle]');
    if (handle && tool === 'select') {
      const object = store.getDocument().objects[handle.dataset.for ?? ''];
      if (object && isPlaced(object)) {
        this.gesture = { kind: 'resize', id: createId('g'), object: object.id, handle: handle.dataset.handle as Handle, start: { x: object.x, y: object.y, w: object.w, h: object.h }, origin: this.world(p) };
        return;
      }
    }

    const doc = store.getDocument();
    const z = camera.get().z;
    const hit = hitTest(doc, indexFor(store), this.world(p), HIT_PX / z, routesFor(store));

    if (tool === 'region') {
      this.gesture = { kind: 'region', start: p };
      state.set({ region: null, selection: new Set() });
      return;
    }
    if (tool === 'arrow') {
      const from = this.world(p);
      this.gesture = { kind: 'arrow', from, fromId: hit && doc.objects[hit]?.type !== 'arrow' ? hit : null };
      state.set({ draftArrow: { from, to: from } });
      return;
    }
    if (tool === 'box' || tool === 'note' || tool === 'text') {
      this.place(tool, this.world(p));
      return;
    }
    this.gesture = { kind: 'press', start: p, hit, additive: event.shiftKey, wasSelected: !!hit && state.get().selection.has(hit) };
    if (hit && !this.gesture.wasSelected) {
      const unit = selectionUnit(doc, hit);
      state.select(event.shiftKey ? [...state.get().selection, ...unit] : unit);
    }
  };

  onPointerMove = (event: React.PointerEvent | PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    const p = this.local(event);
    this.pointers.set(event.pointerId, p);
    const { store, state, camera } = this.host;
    const g = this.gesture;
    if (!g) return;

    switch (g.kind) {
      case 'pinch': {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let next = panBy(camera.get(), center.x - g.center.x, center.y - g.center.y);
        if (g.distance > 0) next = zoomAt(next, next.z * (distance / g.distance), center);
        camera.set(next);
        g.distance = distance;
        g.center = center;
        return;
      }
      case 'pan':
        camera.set(panBy(camera.get(), p.x - g.last.x, p.y - g.last.y));
        g.last = p;
        return;
      case 'press': {
        if (Math.hypot(p.x - g.start.x, p.y - g.start.y) < SLOP) return;
        if (g.hit) {
          const doc = store.getDocument();
          const ids = withFrameContents(doc, indexFor(store), [...state.get().selection]);
          this.gesture = { kind: 'move', id: createId('g'), ids, lastWorld: this.world(g.start), pending: null };
          state.set({ carried: new Set(ids) });
          this.setDragging(true);
          this.onPointerMove(event);
        } else {
          this.gesture = { kind: 'marquee', start: g.start, base: g.additive ? [...state.get().selection] : [] };
          this.onPointerMove(event);
        }
        return;
      }
      case 'move':
        // Many pointer events can arrive in one frame. One command a frame.
        g.pending = this.world(p);
        this.schedule();
        return;
      case 'marquee': {
        const screen = rectFromPoints(g.start, p);
        const area = rectFromPoints(this.world(g.start), this.world(p));
        const doc = store.getDocument();
        const found = objectsInRect(doc, indexFor(store), area).flatMap((id) => selectionUnit(doc, id));
        state.set({ marquee: screen });
        state.select([...g.base, ...found]);
        return;
      }
      case 'region':
        state.set({ region: rectFromPoints(this.world(g.start), this.world(p)) });
        return;
      case 'arrow':
        state.set({ draftArrow: { from: g.from, to: this.world(p) } });
        return;
      case 'resize': {
        const w = this.world(p);
        const dx = w.x - g.origin.x;
        const dy = w.y - g.origin.y;
        const left = g.handle === 'nw' || g.handle === 'sw';
        const top = g.handle === 'nw' || g.handle === 'ne';
        const x0 = left ? Math.min(g.start.x + dx, g.start.x + g.start.w - 16) : g.start.x;
        const y0 = top ? Math.min(g.start.y + dy, g.start.y + g.start.h - 16) : g.start.y;
        const x1 = left ? g.start.x + g.start.w : Math.max(g.start.x + g.start.w + dx, g.start.x + 16);
        const y1 = top ? g.start.y + g.start.h : Math.max(g.start.y + g.start.h + dy, g.start.y + 16);
        store.dispatch({ type: 'resize', id: g.object, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }, { gesture: g.id });
        return;
      }
    }
  };

  onPointerUp = (event: React.PointerEvent | PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    const p = this.local(event);
    this.pointers.delete(event.pointerId);
    const { store, state } = this.host;
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      // One finger left: carry on as a pan from where it is.
      const rest = [...this.pointers.values()][0];
      this.gesture = rest ? { kind: 'pan', last: rest } : null;
      return;
    }
    this.gesture = null;
    this.setDragging(false);
    const doc = store.getDocument();

    switch (g.kind) {
      case 'press':
        if (!g.hit) state.select(g.additive ? state.get().selection : []);
        else if (g.additive && g.wasSelected) {
          const unit = new Set(selectionUnit(doc, g.hit));
          state.select([...state.get().selection].filter((id) => !unit.has(id)));
        } else if (!g.additive && g.wasSelected) state.select(selectionUnit(doc, g.hit));
        return;
      case 'move':
        this.flush(g);
        state.set({ carried: new Set() });
        return;
      case 'marquee':
        state.set({ marquee: null });
        return;
      case 'region': {
        const region = state.get().region;
        if (!region || region.w < 24 || region.h < 24) state.set({ region: null });
        state.set({ tool: 'select' });
        return;
      }
      case 'arrow': {
        state.set({ draftArrow: null, tool: 'select' });
        const to = this.world(p);
        const hit = hitTest(doc, indexFor(store), to, HIT_PX / this.host.camera.get().z, routesFor(store));
        const toId = hit && doc.objects[hit]?.type !== 'arrow' && hit !== g.fromId ? hit : null;
        if (!toId && Math.hypot(to.x - g.from.x, to.y - g.from.y) < 12) return;
        const id = createId('arrow');
        const result = store.dispatch({
          type: 'add',
          objects: [{ id, type: 'arrow', from: g.fromId ? { object: g.fromId } : g.from, to: toId ? { object: toId } : to }],
        });
        if (result.ok) state.select([id]);
        return;
      }
    }
  };

  onPointerCancel = (event: React.PointerEvent | PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    const g = this.gesture;
    this.gesture = null;
    this.setDragging(false);
    if (g?.kind === 'move') this.flush(g);
    this.host.state.set({ marquee: null, draftArrow: null, carried: new Set() });
  };

  onDoubleClick = (event: React.MouseEvent | MouseEvent): void => {
    const { store, state, camera } = this.host;
    if (state.get().tool !== 'select' || (event.target as HTMLElement).closest?.('.pcv-bar')) return;
    const doc = store.getDocument();
    const hit = hitTest(doc, indexFor(store), this.world(this.local(event)), HIT_PX / camera.get().z, routesFor(store));
    const object = hit ? doc.objects[hit] : null;
    if (object && (object.type === 'box' || object.type === 'note' || object.type === 'text' || object.type === 'frame')) {
      state.select([object.id]);
      state.set({ editingId: object.id });
    }
  };

  /** Two fingers or a plain wheel pan; a pinch or Ctrl/Cmd + wheel zooms at the pointer. */
  onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const { camera } = this.host;
    this.host.onUserCamera?.();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-Math.max(-60, Math.min(60, event.deltaY * unit)) * 0.01);
      camera.set(zoomAt(camera.get(), camera.get().z * factor, this.local(event)));
    } else {
      camera.set(panBy(camera.get(), -event.deltaX * unit, -event.deltaY * unit));
    }
  };

  private place(tool: 'box' | 'note' | 'text', at: Point): void {
    const { store, state } = this.host;
    const size = DEFAULTS[tool];
    const id = createId(tool);
    const base = { id, x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2), w: size.w, h: size.h, text: '' };
    const object: CanvasObject = tool === 'box' ? { ...base, type: 'box' } : tool === 'note' ? { ...base, type: 'note' } : { ...base, type: 'text' };
    // Placing it and typing its first words are one step: see `firstEditGesture`.
    const result = store.dispatch({ type: 'add', objects: [object] }, { gesture: firstEditGesture(id) });
    state.set({ tool: 'select' });
    if (!result.ok) return;
    state.select([id]);
    state.set({ editingId: id });
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.gesture?.kind === 'move') this.flush(this.gesture);
    });
  }

  private flush(g: Extract<Gesture, { kind: 'move' }>): void {
    if (!g.pending) return;
    const dx = g.pending.x - g.lastWorld.x;
    const dy = g.pending.y - g.lastWorld.y;
    g.lastWorld = g.pending;
    g.pending = null;
    if (dx || dy) this.host.store.dispatch({ type: 'move', ids: g.ids, dx, dy }, { gesture: g.id });
  }
}
