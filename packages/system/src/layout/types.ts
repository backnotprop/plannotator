// What the layout computes for one sheet: every coordinate, in sheet units (a
// sheet is W = 1600 units wide). Plain data; the drawing (src/draw) renders it.

export type Pt = [number, number];
export type Rect = { x: number; y: number; w: number; h: number };

/** How a part is drawn on a sheet. */
export type Variant = 'plate' | 'box' | 'node' | 'chip' | 'card' | 'bar' | 'row' | 'rowx' | 'lane' | 'tile' | 'tilefor' | 'window';

/** A change's mark on a part or a line (step A5 sets it; at rest it is null). */
export type ChangeStatus = 'added' | 'changed' | 'removed' | null;

export type PartBox = Rect & {
  v: Variant;
  band?: string;
  side?: string;
  marks: string[];
  status: ChangeStatus;
  /** A sheet-given second line (a lane's route, a tile's "3 parts"). */
  sub?: string | null;
  /** A box name fitted to its box, when the whole name does not fit. */
  nl?: string[] | null;
  /** A window at rest: how many sheets are inside it. */
  cw?: number;
  /** The scope this part opens, when that scope has sheets. */
  opens?: string | null;
  /** What the overlays put on the part (none ship). */
  ov?: { tint: string | null; marks: { text: string; ink: string }[] } | null;
};

export type Zone = Rect & {
  id: string;
  label: string;
  means?: string;
  tone: string;
  marks: string[];
  band?: boolean;
  /** A side section with no tone: a hairline, no fill. */
  hair?: boolean;
  /** A group's frame. */
  solid?: boolean;
  /** A side label wrapped to the column's width. */
  labelW?: number;
  labelH?: number;
};

export type LabelBox = Rect & { lines: string[]; side?: string; hidden?: boolean };

/** What a line carries (its hue), from the drawing's `moves:` or read from its words. */
export type LineClass = { moves: 'data' | 'people' | 'money' | 'energy'; w: number; ink?: string };

export type PortBox = Rect & { text: string; dir: 'in' | 'out'; edge: 'top' | 'bottom' | 'right' };

export type Edge = {
  id: string;
  from: string[];
  to: string;
  both?: boolean;
  says: string;
  quiet: boolean;
  status: ChangeStatus;
  line: LineClass | null;
  pts?: Pt[];
  paths?: Pt[][];
  lb?: LabelBox | null;
  letter: string | null;
  port?: PortBox;
  /** A reply hop on a flow sheet is dashed. */
  dash?: string | null;
  /** A callout's heavy ink arrow. */
  style?: 'aud';
  /** The line ids a fan-in bus gathers. */
  fan?: { id: string; from: string; says: string }[];
  /** The flow a hop or a step draws. */
  flow?: string | null;
  /** Where each overlay's words start in `says`, and their ink (none ship). */
  tails?: { at: number; ink: string }[] | null;
};

/** Drawn things that are not parts and not model lines: lifelines, payloads, steps, decisions, ticks. */
export type Figure = {
  id: string;
  type: 'lifeline' | 'vline' | 'arrow' | 'diamond' | 'tick' | 'text' | 'step' | 'term' | 'load' | 'payload';
  under?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  y0?: number;
  y1?: number;
  pts?: Pt[];
  label?: string | null;
  heavy?: boolean;
  dashed?: boolean;
  faint?: boolean;
  arrow?: boolean;
  text?: string;
  cls?: string;
  at?: string;
  lines?: string[];
  code?: string[] | null;
  letter?: string | null;
  strong?: boolean;
  bad?: boolean;
  mono?: boolean;
  when?: string;
  size?: string | null;
  title?: string;
  schema?: boolean;
  edge?: string;
  status?: ChangeStatus;
};

export type Letter = { l: string; x: number; y: number; on: string };
export type Split = { x: number; y0: number; y1: number; left: string; right: string; ty: number };
export type CalloutBox = Rect & { id: string; title: string[]; full: string | null; text: string[]; side: string; to: string };

export type SheetLayout = {
  id: string;
  kind: string;
  scope: string;
  w: number;
  h: number;
  title: string;
  question: string;
  parts: Record<string, PartBox>;
  zones: Zone[];
  edges: Edge[];
  letters: Letter[];
  splits: Split[];
  callouts: CalloutBox[];
  figures: Figure[];
  notes: { l: string; on: string; text: string }[];
  /** The height the sheet needs, before any paper height is applied. */
  natural: number;
  /** A band wrapped or many lines: the sheet routes on channels. */
  dense: boolean;
  /** Laid out in the Simple reading. */
  simple: boolean;
  /** The at-rest form: each window a plain box with its cue. */
  compact: boolean;
};
