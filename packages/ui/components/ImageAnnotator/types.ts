export type Tool = 'pen' | 'arrow' | 'circle';

export interface Point {
  x: number;
  y: number;
  pressure?: number;
}

export interface Stroke {
  id: string;
  tool: Tool;
  points: Point[];
  color: string;
  size: number;
}

export interface AnnotatorState {
  tool: Tool;
  color: string;
  strokeSize: number;
  strokes: Stroke[];
  currentStroke: Stroke | null;
}

export const COLORS = [
  '#ef4444',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#ffffff',
] as const;

export const DEFAULT_STATE: AnnotatorState = {
  tool: 'pen',
  color: COLORS[0],
  strokeSize: 6,
  strokes: [],
  currentStroke: null,
};
