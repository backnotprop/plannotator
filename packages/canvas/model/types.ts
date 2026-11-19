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
  /**
   * Its place in the drawing order: see `model/order-key.ts`. Given by the
   * planner; an object someone hands in without one is put on top.
   */
  z?: string;
  /** Who added it: a person or an agent, and which. A host shows a face from it. */
  by?: Actor;
  /** How it is drawn beyond its type and colour. Every value is a word from a short list: see `ObjectStyle`. */
  style?: ObjectStyle;
}

export const STYLE_FILLS = ['tint', 'solid', 'hachure', 'cross', 'none'] as const;
export const STYLE_SIDES = ['n', 'e', 's', 'w'] as const;
export const STYLE_ENDS = ['arrow', 'none', 'dot', 'bar', 'bar-arrow'] as const;
export type Side = (typeof STYLE_SIDES)[number];

/**
 * The style of one object. Closed: a key or a value that is not listed here
 * is refused, so a style is always something every renderer understands.
 * Nothing in it is ever needed to get a good-looking object.
 */
export interface ObjectStyle {
  /** `sketch`: drawn by hand, rough and hatched. It means "proposed, not decided". Absent: clean. */
  look?: 'sketch';
  /** How the inside is filled. `hachure` and `cross` draw in the sketch look only. Absent: tint. */
  fill?: (typeof STYLE_FILLS)[number];
  /** How rough a sketch is: 0 nearly straight, 2 loose. Absent: 1. */
  rough?: 0 | 1 | 2;
  /** What a sketch's wobble is drawn from, so it is the same every time. Absent: a number made from the id. */
  seed?: number;
  /** A dashed line: an arrow, or a shape's outline. */
  dash?: true;
  /** Arrows: the side of the object each end leaves from. Absent: chosen from where the two objects are. */
  fromSide?: Side;
  toSide?: Side;
  /** Arrows: where along the line the label sits, 0 to 1. Absent: the middle. */
  labelAt?: number;
  /** Arrows: what the ends look like. `bar-arrow` is a dimension line; `dot` a callout leader. Absent: arrow. */
  ends?: (typeof STYLE_ENDS)[number];
}

/** The outlines a box can be drawn in. Absent is `process`: the plain rounded box. */
export const BOX_SHAPES = ['process', 'decision', 'database', 'document', 'queue', 'actor', 'cloud', 'pill', 'container'] as const;
export type BoxShape = (typeof BOX_SHAPES)[number];

/** How an arrow's line runs between its ends. Absent is `elbow`: right angles round what is in the way. */
export const ARROW_ROUTINGS = ['elbow', 'straight', 'curve'] as const;
export type ArrowRouting = (typeof ARROW_ROUTINGS)[number];

/** Objects with a place and a size of their own. */
interface PlacedObject extends BaseObject, Rect {}

/** A card: a title line and an optional quieter second line. */
export interface BoxObject extends PlacedObject {
  type: 'box';
  text: string;
  detail?: string;
  /** What kind of thing it is, said by its outline: a store is a cylinder before anyone reads it. */
  shape?: BoxShape;
  /** The lanes of a `container`, top to bottom. */
  lanes?: string[];
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
  /** An asset reference, an http(s) address or a relative path: never the bytes. See `model/assets.ts`. */
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
  /** What it shows, in words. The frame takes no focus and is not read out, so this is all a screen reader gets. */
  alt?: string;
}

/** How a chart draws its rows. */
export const CHART_MARKS = ['bar', 'line', 'area', 'dot', 'cell', 'span'] as const;
export type ChartMark = (typeof CHART_MARKS)[number];

/** One value in a chart's table: a number, or a short piece of text. */
export type ChartCell = string | number;

/**
 * Which field of the table goes where. Every value is the name of one of the chart's `fields`.
 * - `x`, `y`: along the bottom and up the side. `y` may be up to four fields, each drawn as its own series.
 * - `series`: rows with the same value here are one series (one line, one colour).
 * - `x2`: where a `span` ends. `value`: how strong a `cell` is. `size`: how large a `dot` is.
 * - `facet`: one small chart for each value here, all on the same scales.
 */
export interface ChartEncode {
  x: string;
  y: string | string[];
  series?: string;
  x2?: string;
  value?: string;
  size?: string;
  facet?: string;
}

/** A line across the chart at one value, with a word: "today", a limit, a target. `on: 'x'` stands it upright. */
export interface ChartRule {
  at: ChartCell;
  label?: string;
  on?: 'x';
}

/**
 * A chart as data, not as a picture or markup: a small table and which field goes where. Whoever adds it
 * sends the numbers; the canvas draws them (`view/chart.ts`) in its own look, in both themes, in a snapshot
 * and in the still picture. Its colour is the object's colour, like anything else. Limits: `CHART_LIMITS` (`model/chart.ts`).
 */
export interface ChartObject extends PlacedObject {
  type: 'chart';
  mark: ChartMark;
  /** The table's column names, in order. */
  fields: string[];
  /** The table's rows: each as long as `fields`. */
  rows: ChartCell[][];
  encode: ChartEncode;
  /** Bars and areas: series on top of each other, not side by side. */
  stack?: true;
  /** Bars: running sideways, names down the left. */
  flip?: true;
  /** Lines: the series drawn dashed (a plan, a projection), by name. */
  dash?: string[];
  rules?: ChartRule[];
  title?: string;
  /** Written after values: "ms", "%". */
  unit?: string;
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

export const STAMP_KINDS = ['check', 'thumb', 'ask'] as const;

/** A small mark left on something: agreed, liked (with a count), or in question. */
export interface StampObject extends PlacedObject {
  type: 'stamp';
  kind: (typeof STAMP_KINDS)[number];
  /** How many, shown beside the mark when more than one. */
  count?: number;
}

/** An arrow's end: stuck to an object, or a free point. */
export type ArrowEnd = { object: ObjectId } | Point;

export interface ArrowObject extends BaseObject {
  type: 'arrow';
  from: ArrowEnd;
  to: ArrowEnd;
  label?: string;
  routing?: ArrowRouting;
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
  | ChartObject
  | ReferenceObject
  | StampObject
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
  'chart',
  'reference',
  'stamp',
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
  /**
   * Every object id once, back to front. Worked out from the objects' `z`
   * keys and kept by the reducer; never changed by hand and not saved.
   */
  order: readonly ObjectId[];
  snapshots: Readonly<Record<SnapshotId, Snapshot>>;
}

/**
 * The size an object gets when whoever adds it gives none. An agent names
 * what a thing is and where it goes; how big it is has a sensible answer.
 */
export const DEFAULT_SIZES: Readonly<Record<string, { w: number; h: number }>> = {
  box: { w: 170, h: 76 },
  'box:process': { w: 170, h: 76 },
  'box:decision': { w: 130, h: 124 },
  'box:database': { w: 124, h: 124 },
  'box:queue': { w: 170, h: 68 },
  'box:document': { w: 160, h: 92 },
  'box:cloud': { w: 166, h: 112 },
  'box:actor': { w: 104, h: 138 },
  'box:pill': { w: 170, h: 48 },
  'box:container': { w: 300, h: 360 },
  note: { w: 184, h: 158 },
  text: { w: 200, h: 28 },
  frame: { w: 640, h: 420 },
  image: { w: 320, h: 200 },
  sprite: { w: 48, h: 48 },
  html: { w: 320, h: 120 },
  chart: { w: 380, h: 240 },
  reference: { w: 252, h: 240 },
  stamp: { w: 34, h: 34 },
};
