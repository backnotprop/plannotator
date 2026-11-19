/**
 * The canvas's one vocabulary for change.
 *
 * A **command** says what someone wants: "move these", "add this image". A
 * person's drag and an agent's request are the same commands; nothing in the
 * package changes a document any other way.
 *
 * An **event** says what happened to the document, in the smallest terms
 * that can be replayed and undone: an object was added, changed, removed or
 * reordered; a snapshot was put or removed. The planner (`plan.ts`) turns one
 * command into events after checking it; the reducer (`reduce.ts`) applies
 * events and returns the events that undo them.
 *
 * An **envelope** is one committed change: who, what they asked, what
 * happened. It is what an agent receives, what a sync backend carries, and
 * what the hand-over reads (`CanvasStore.since`).
 */
import type { CanvasColor } from '../model/color';
import type { Rect } from '../model/geometry';
import type {
  Actor,
  ArrowEnd,
  CanvasLink,
  CanvasObject,
  ObjectId,
  ReferenceTarget,
  Snapshot,
  SnapshotId,
  SnapshotSource,
} from '../model/types';

/** The fields `edit` may change. Which apply depends on the object's type. */
export interface ObjectPatch {
  text?: string;
  detail?: string;
  title?: string;
  label?: string;
  alt?: string;
  description?: string;
  site?: string;
  image?: string;
  icon?: string;
  target?: ReferenceTarget;
  src?: string;
  html?: string;
  size?: 'small' | 'medium' | 'large';
  frames?: number;
  fps?: number;
  from?: ArrowEnd;
  to?: ArrowEnd;
  /** `null` removes the link. */
  link?: CanvasLink | null;
}

export type Command =
  | { type: 'add'; objects: CanvasObject[] }
  | { type: 'move'; ids: ObjectId[]; dx: number; dy: number }
  | { type: 'resize'; id: ObjectId; rect: Rect }
  | { type: 'edit'; id: ObjectId; patch: ObjectPatch }
  /** `null` puts the type's own colour back. */
  | { type: 'recolor'; ids: ObjectId[]; color: CanvasColor | null }
  | { type: 'delete'; ids: ObjectId[] }
  | { type: 'group'; id: ObjectId; ids: ObjectId[]; label?: string }
  | { type: 'ungroup'; ids: ObjectId[] }
  | { type: 'reorder'; ids: ObjectId[]; to: 'front' | 'back' }
  | { type: 'retitle'; title: string }
  | { type: 'add-snapshot'; snapshot: Snapshot }
  | { type: 'edit-snapshot'; id: SnapshotId; title?: string; source?: SnapshotSource }
  | { type: 'remove-snapshot'; id: SnapshotId };

export type CommandType = Command['type'];

export type CanvasEvent =
  /** `at` is the place in the drawing order; absent means on top. */
  | { type: 'object-added'; object: CanvasObject; at?: number }
  /** The whole new object. Ignored when the object is gone. */
  | { type: 'object-changed'; object: CanvasObject }
  | { type: 'object-removed'; id: ObjectId }
  | { type: 'object-ordered'; id: ObjectId; at: number }
  | { type: 'snapshot-put'; snapshot: Snapshot }
  | { type: 'snapshot-removed'; id: SnapshotId }
  | { type: 'title-set'; title: string };

export type EnvelopeOrigin = 'local' | 'undo' | 'redo' | 'remote';

export interface Envelope {
  /** Unique across peers. A store ignores an envelope it has already applied. */
  id: string;
  /** This store's own count of commits. Not shared between peers. */
  seq: number;
  actor: Actor;
  origin: EnvelopeOrigin;
  /** What was asked for. Absent on undo, redo and on a peer's bare events. */
  command?: Command;
  events: CanvasEvent[];
}

/**
 * What comments and the hand-over will anchor to, in a later change. Named
 * here so the event vocabulary has one way to point at part of a canvas.
 */
export type CanvasAnchor =
  | { kind: 'object'; id: ObjectId }
  | { kind: 'snapshot'; id: SnapshotId }
  | { kind: 'region'; rect: Rect };
