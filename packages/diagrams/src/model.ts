export type Weight = "regular" | "medium" | "semibold" | "bold";
export type Side = "left" | "right" | "top" | "bottom";
export type Point = [number, number];
export type Box = {x: number; y: number; w: number; h: number};
export type State = {label: string; stroke: string; fill: string; dash?: string | null};
export type Theme = Record<
    "ink" | "muted" | "faint" | "paper" | "line" | "panel_fill" | "panel_stroke" |
    "tile_fill" | "tile_stroke" | "header_text" | "header_sub" | "header_text_on_dark" |
    "header_sub_on_dark" | "group_fill" | "group_stroke" | "note_fill" | "note_stroke" |
    "tag_color" | "graph_fill" | "graph_grid" | "graph_line", string
> & Record<
    "title" | "subtitle" | "legend" | "panel_title" | "panel_sub" | "tile" | "tile_sub" |
    "body" | "small" | "min_text" | "lid" | "depth" | "pad" | "tile_gap" | "section_gap" |
    "tile_h" | "line_h" | "header_h" | "header_h_sub" | "panel_min_w" | "tile_max_w" |
    "radius" | "col_gap" | "row_gap" | "min_gap" | "margin", number
> & {badge_text: string | null; badge_fill: string | null; tones: Record<string,string>;
     statuses: Record<string,State>; link_labels: Record<string,string>};
export type Tile = string | {label: string; sub?: string; status?: string};
export type Tiles = {tiles: Tile[]; cols?: number; label?: string};
export type Graph = {nodes: Record<string,string>; links: [string,string,string?][]; at: Record<string,Point>};
export type DiagramImage = {src: string; alt: string; width: number; height: number};
export type DiagramReference =
    | {kind: "file"; title: string; path: string; start?: number; end?: number; url?: string}
    | {kind: "link"; title: string; url: string};
export interface DiagramPart extends Box {
    kind: "panel" | "section" | "group" | "link";
    id: string;
    title: string;
    refs: DiagramReference[];
    summary?: string;
    labelBox?: Box;
    points?: Point[];
    from?: string;
    to?: string;
}
type Addressable = {id?: string; refs?: DiagramReference[]};
export type Section = {id: string; title: string; refs?: DiagramReference[]; content: Section} | string | Tile[] | Tiles | {text: string} | {row: Section[]} |
    {card: {title: string; rows: [string,string][]; intro?: string}} | {graph: Graph} | {image: DiagramImage};
export interface Panel extends Addressable {
    title: string; sub?: string; status?: string; step?: number; footer?: string;
    tone?: string; width?: number; tiles?: Tile[]; cols?: number; label?: string; sections?: Section[];
    x?: number; y?: number;
}
export interface Connection extends Addressable {
    from: string; to: string; kind?: string; label?: string; start?: Side | "auto"; end?: Side | "auto";
    lane?: "top" | "bottom"; via_x?: number; via_y?: number; cross_ok?: boolean;
}
export interface DiagramSpec {
    id?: string;
    title: string; subtitle?: string; tag?: string; note?: {title: string; lines?: string[]};
    steps?: [number,string][]; steps_label?: string; legend?: boolean; gap?: number; row_gap?: number;
    valign?: "top" | "center" | "bottom"; start_angle?: number; center?: Panel[]; ring?: Panel[];
    panels?: Panel[]; columns?: (Panel[] | Panel)[]; groups?: (Addressable & {label: string; members: string[]; sub?: string})[];
    links?: Connection[]; statuses?: Record<string,string>; theme?: Partial<Theme>;
}
export interface Face {
    upm: number; cap: number; map: Record<number,number>; glyphs: [number,number,number,string][];
    lookups: ({pairs: Record<number,number>} | {left: Record<number,number>; right: Record<number,number>; values: Record<number,number>})[];
}
export type Fonts = Record<Weight, Face>;
export interface Block {
    w: number; h: number;
    draw(x: number, y: number, w: number, h: number): void;
}
export interface Placed extends Box {id: string; panel: Panel; block: Block; head: number}
export interface Group extends Box, Addressable {label: string; sub?: string; members: string[]; titleBox: Box}
export function extent(boxes: Box[]): Box {
    let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
    for (const b of boxes) {
        x = Math.min(x,b.x); y = Math.min(y,b.y);
        right = Math.max(right,b.x+b.w); bottom = Math.max(bottom,b.y+b.h);
    }
    return {x,y,w:right-x,h:bottom-y};
}
export function separation(a: Box, b: Box) {
    return Math.max(b.x-a.x-a.w,a.x-b.x-b.w,b.y-a.y-a.h,a.y-b.y-b.h);
}
