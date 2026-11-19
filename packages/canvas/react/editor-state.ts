/**
 * What one editor is doing right now: the tool in hand, what is selected,
 * what is being typed into, the rubber bands on screen. View state: it
 * belongs to this screen, is never saved and never synced.
 */
import type { Point, Rect } from '../model/geometry';
import type { ObjectId } from '../model/types';

export type Tool = 'select' | 'hand' | 'box' | 'note' | 'text' | 'arrow' | 'region';

export interface EditorSnapshot {
  tool: Tool;
  selection: ReadonlySet<ObjectId>;
  editingId: ObjectId | null;
  /** The marquee being dragged, in screen pixels of the view. */
  marquee: Rect | null;
  /** A region chosen for a snapshot, in world units. */
  region: Rect | null;
  /** An arrow being drawn, in world units. */
  draftArrow: { from: Point; to: Point } | null;
  /** The objects being dragged right now. */
  carried: ReadonlySet<ObjectId>;
}

const EMPTY: ReadonlySet<ObjectId> = new Set();

export class EditorState {
  private state: EditorSnapshot = { tool: 'select', selection: EMPTY, editingId: null, marquee: null, region: null, draftArrow: null, carried: EMPTY };
  private readonly listeners = new Set<() => void>();

  get = (): EditorSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<EditorSnapshot>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof EditorSnapshot)[]) {
      if (patch[key] !== this.state[key]) changed = true;
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  select(ids: Iterable<ObjectId>): void {
    const next = new Set(ids);
    const current = this.state.selection;
    if (next.size === current.size && [...next].every((id) => current.has(id))) {
      if (this.state.region) this.set({ region: null });
      return;
    }
    this.set({ selection: next.size ? next : EMPTY, region: null });
  }

  /** Drop ids that no longer exist (someone deleted them). */
  prune(exists: (id: ObjectId) => boolean): void {
    const { selection, editingId } = this.state;
    const kept = [...selection].filter(exists);
    const patch: Partial<EditorSnapshot> = {};
    if (kept.length !== selection.size) patch.selection = kept.length ? new Set(kept) : EMPTY;
    if (editingId && !exists(editingId)) patch.editingId = null;
    this.set(patch);
  }
}
