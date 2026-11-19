/**
 * The canvas document: what is saved, sent and synced. Plain JSON, typed,
 * versioned. Nothing here knows about the screen (no camera, no selection,
 * no hover): those belong to a view of the document, and two people looking
 * at one document each have their own.
 *
 * Rules the rest of the package relies on:
 * - An id never changes and is never reused inside a document.
 * - An object is replaced, never mutated. A change makes a new object and a
 *   new `objects` map; everything untouched keeps its identity, so a renderer
 *   can skip it with a reference check.
 * - `order` holds every object id exactly once, back to front.
 * - A reference to another object (an arrow's end, a group's member, a
 *   snapshot's source) may outlive its target. Readers must cope: see
 *   `resolveArrow` and `resolveSnapshot`.
 */
import type { CanvasColor } from './color';
import type { Point, Rect } from './geometry';

/** Bumped when a saved document needs a migration to be read (`MIGRATIONS`). */
export const CANVAS_DOCUMENT_VERSION = 1;

export type ObjectId = string;
export type SnapshotId = string;

/** Who made or last changed something. `id` names the person or the agent. */
export interface Actor {
  kind: 'person' | 'agent';
  id: string;
}

/** A place outside the canvas an object points at: the plan navigation seam. */
export interface CanvasLink {
  kind: 'plan';
  /** A heading anchor or block id in the plan document. */
  anchor: string;
}

interface BaseObject {
  id: ObjectId;
  /** Any object can carry a colour. Absent: the type's own default. */
  color?: CanvasColor;
  /** The group this object belongs to, if any. */
  group?: ObjectId;
  /** Where in the plan this object comes from or points to. */
  link?: CanvasLink;
  /** Who added it. Kept so a person's work and an agent's can be told apart. */
  by?: Actor['kind'];
  /**
   * How it is drawn beyond its type and colour: a small bag of named values
   * (`{ stroke: 'dashed', roughness: 1 }`). Stored, checked and carried by
   * every event; the renderer reads what it knows and ignores the rest, so a
   * new visual style is a renderer change, not a document migration.
   */
  style?: ObjectStyle;
}

export type ObjectStyle = Record<string, string | number | boolean>;

/** Objects with a place and a size of their own. */
interface PlacedObject extends BaseObject, Rect {
  /** The outline it is drawn in, by name (`ellipse`, `diamond`, `cylinder`). Absent: the type's own. Stored for the renderer to come. */
  shape?: string;
}

/** A card: a title line and an optional quieter second line. */
export interface BoxObject extends PlacedObject {
  type: 'box';
  text: string;
  detail?: string;
}

/** A sticky note. */
export interface NoteObject extends PlacedObject {
  type: 'note';
  text: string;
}

/** Bare text on the board. */
export interface TextObject extends PlacedObject {
  type: 'text';
  text: string;
  size?: 'small' | 'medium' | 'large';
}

/** A titled region. What lies inside it is decided by geometry, not stored. */
export interface FrameObject extends PlacedObject {
  type: 'frame';
  title: string;
}

export interface ImageObject extends PlacedObject {
  type: 'image';
  /** An http(s), blob: or data:image URL. Checked by `isSafeImageSrc`. */
  src: string;
  alt: string;
}

/** A sprite sheet played frame by frame: one row of `frames` equal cells. */
export interface SpriteObject extends PlacedObject {
  type: 'sprite';
  src: string;
  alt: string;
  frames: number;
  /** Frames per second. */
  fps: number;
}

/**
 * Custom HTML from an agent, on a transparent background. It never becomes
 * part of the page: it is drawn only inside the sandbox described in
 * `model/html-item.ts`.
 */
export interface HtmlObject extends PlacedObject {
  type: 'html';
  html: string;
}

/** What kind of thing an artifact is: decides its card's glyph and how it opens. */
export const ARTIFACT_KINDS = ['image', 'html', 'markdown', 'text', 'video', 'file'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * What a reference card points at:
 * - `web`: a page on the web, by its address.
 * - `artifact`: one of the person's own artifacts (a picture, an HTML page,
 *   Markdown, text, a video), by the host's id for it.
 * - `plan`: a plan or document, or one passage of it. The same family as
 *   `CanvasLink`: the canvas pointing into a document.
 */
export type ReferenceTarget =
  | { kind: 'web'; url: string }
  | { kind: 'artifact'; artifact: string; artifactKind: ArtifactKind }
  | { kind: 'plan'; anchor: string; document?: string };

/**
 * A card that stands for something outside the canvas and opens it. What the
 * card shows (title, description, site, picture) is stored with it, so a
 * card draws at once, offline, and for everyone the same; whoever made it
 * (a link preview, the host, an agent) filled those in. All of it is text
 * and picture addresses, never markup.
 */
export interface ReferenceObject extends PlacedObject {
  type: 'reference';
  target: ReferenceTarget;
  /** Absent while a preview is still being fetched: the card shows the address. */
  title?: string;
  description?: string;
  /** The site's or the source's name, e.g. "example.org". */
  site?: string;
  /** The preview picture. */
  image?: string;
  /** A small icon for the site or the kind. */
  icon?: string;
}

/** An arrow's end: stuck to an object, or a free point. */
export type ArrowEnd = { object: ObjectId } | Point;

export interface ArrowObject extends BaseObject {
  type: 'arrow';
  from: ArrowEnd;
  to: ArrowEnd;
  label?: string;
  /** How the line runs between its ends, by name (`straight`, `elbow`, `curved`). Absent: straight. Stored for the renderer to come. */
  routing?: string;
}

/** A set of objects that select and move as one. It has no look of its own. */
export interface GroupObject extends BaseObject {
  type: 'group';
  label?: string;
}

export type CanvasObject =
  | BoxObject
  | NoteObject
  | TextObject
  | FrameObject
  | ImageObject
  | SpriteObject
  | HtmlObject
  | ReferenceObject
  | ArrowObject
  | GroupObject;

export type CanvasObjectType = CanvasObject['type'];
export type PlacedCanvasObject = Extract<CanvasObject, Rect>;

export const PLACED_TYPES: ReadonlySet<CanvasObjectType> = new Set([
  'box',
  'note',
  'text',
  'frame',
  'image',
  'sprite',
  'html',
  'reference',
]);

export const isPlaced = (object: CanvasObject): object is PlacedCanvasObject => PLACED_TYPES.has(object.type);

/**
 * What a snapshot looks at. Three ways to say it:
 * - `frame`: one frame, by id, and whatever is in its rectangle.
 * - `objects`: a chosen set, and only those.
 * - `region`: a fixed rectangle, and whatever is in it.
 */
export type SnapshotSource =
  | { kind: 'frame'; frame: ObjectId }
  | { kind: 'objects'; objects: ObjectId[] }
  | { kind: 'region'; rect: Rect };

/**
 * What a snapshot showed when it was taken: the rectangle and a frozen copy
 * of the objects in it, back to front. See `model/capture.ts`.
 */
export interface SnapshotCapture {
  rect: Rect;
  objects: CanvasObject[];
}

/** What someone gives to make a snapshot. The capture is taken by the planner, never sent. */
export interface SnapshotInput {
  id: SnapshotId;
  title: string;
  source: SnapshotSource;
}

/**
 * A named capture of part of the canvas: a materialized view. It shows what
 * was there when it was taken (`capture`) and does not change when the
 * canvas does; `update-snapshot` takes it again. It lives in the canvas
 * document; a plan refers to it by canvas id and snapshot id, so one
 * snapshot can appear in any number of plans, any number of times, and the
 * plan's text stays two ids.
 */
export interface Snapshot extends SnapshotInput {
  capture: SnapshotCapture;
}

export interface CanvasDocument {
  version: typeof CANVAS_DOCUMENT_VERSION;
  /** The canvas's own id: what a plan's snapshot block names. */
  id: string;
  title: string;
  objects: Readonly<Record<ObjectId, CanvasObject>>;
  /** Every object id once, back to front. */
  order: readonly ObjectId[];
  snapshots: Readonly<Record<SnapshotId, Snapshot>>;
}
