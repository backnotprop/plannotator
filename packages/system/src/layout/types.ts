export type Pt = [number, number];
export type Rect = { x: number; y: number; w: number; h: number };

export type Variant = 'plate' | 'box' | 'node' | 'chip' | 'card' | 'bar' | 'row' | 'rowx' | 'lane' | 'tile' | 'tilefor' | 'window';

export type ChangeStatus = 'added' | 'changed' | 'removed' | null;

export type PartBox = Rect & {
  v: Variant;
  band?: string;
  side?: string;
  marks: string[];
  status: ChangeStatus;
  n?: number;
  lines?: string | null;
  who?: string[];
  sub?: string | null;
  nl?: string[] | null;
  cw?: number;
  opens?: string | null;
  ov?: { tint: string | null; marks: { text: string; ink: string }[] } | null;
};

export type Zone = Rect & {
  id: string;
  label: string;
  means?: string;
  tone: string;
  marks: string[];
  band?: boolean;
  hair?: boolean;
  solid?: boolean;
  labelW?: number;
  labelH?: number;
};

export type LabelBox = Rect & { lines: string[]; side?: string; hidden?: boolean };

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
  dash?: string | null;
  style?: 'aud';
  fan?: { id: string; from: string; says: string }[];
  flow?: string | null;
  tails?: { at: number; ink: string }[] | null;
};

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
  natural: number;
  dense: boolean;
  simple: boolean;
  compact: boolean;
};
