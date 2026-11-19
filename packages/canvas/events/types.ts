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
 *
 * Events are field-level on purpose. Adding a field to an object type (a
 * shape, a style, an arrow's routing) needs no new event and no migration:
 * it is one more name `object-set` may carry.
 */
import type { CanvasColor } from '../model/color';
import type { Rect } from '../model/geometry';
import type {
  Actor,
  ArrowEnd,
  ArrowRouting,
  BoxShape,
  CanvasLink,
  ChartCell,
  ChartEncode,
  ChartMark,
  ChartRule,
  CanvasObject,
  ObjectId,
  ObjectStyle,
  ReferenceTarget,
  Snapshot,
  SnapshotId,
  SnapshotInput,
  SnapshotSource,
  StampObject,
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
  /** A chart's own fields: see `ChartObject`. `fields`, `rows` and `encode` must agree, so send together what changes together. */
  mark?: ChartMark;
  fields?: string[];
  rows?: ChartCell[][];
  encode?: ChartEncode;
  stack?: true | null;
  flip?: true | null;
  dash?: string[] | null;
  rules?: ChartRule[] | null;
  unit?: string | null;
  size?: 'small' | 'medium' | 'large';
  frames?: number;
  fps?: number;
  from?: ArrowEnd;
  to?: ArrowEnd;
  /** `null` removes the link. */
  link?: CanvasLink | null;
  /** How it is drawn: see `ObjectStyle`. `null` removes it. */
  style?: ObjectStyle | null;
  shape?: BoxShape | null;
  lanes?: string[] | null;
  kind?: StampObject['kind'];
  count?: number | null;
  routing?: ArrowRouting | null;
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
  /** Takes the capture now. A capture sent with it is ignored. */
  | { type: 'add-snapshot'; snapshot: SnapshotInput }
  /** A new title, or a new source (which takes the capture again). */
  | { type: 'edit-snapshot'; id: SnapshotId; title?: string; source?: SnapshotSource }
  /** Take the capture again from what the canvas holds now. */
  | { type: 'update-snapshot'; id: SnapshotId }
  | { type: 'remove-snapshot'; id: SnapshotId };

export type CommandType = Command['type'];

/** Field values of an object, by field name. Checked against the object's type when they are applied. */
export type ObjectFields = Record<string, unknown>;

export type CanvasEvent =
  /** The object says where it sits in the drawing order itself (`z`). */
  | { type: 'object-added'; object: CanvasObject }
  /**
   * Some fields of one object took new values (`set`) or were taken away
   * (`unset`). Only what changed is named, so two people changing different
   * fields of one object both keep their change, and undoing one of them
   * puts back only what that one touched. `id` and `type` are never set.
   * Ignored when the object is gone.
   */
  | { type: 'object-set'; id: ObjectId; set: ObjectFields; unset?: string[] }
  | { type: 'object-removed'; id: ObjectId }
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
  /** Commits of one gesture (a drag, a colour pick) share this. They are one undo step and one entry in the log. */
  gesture?: string;
  /**
   * A peer's change arrived while changes made here were still on their way
   * out, so those were applied again on top of it. More may differ from the
   * document before than `events` names; a listener that keeps something in
   * step event by event should rebuild it.
   */
  rebased?: boolean;
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
