import { DEFAULT_STATE, type AnnotatorState, type Stroke } from './types';

/** Internal image-annotator state that adds redo without widening the published state contract. */
export interface StrokeHistoryState extends AnnotatorState {
  futureStrokes: Stroke[];
}

export const DEFAULT_STROKE_HISTORY_STATE: StrokeHistoryState = {
  ...DEFAULT_STATE,
  futureStrokes: [],
};

/** Commit a completed stroke and invalidate the abandoned redo branch. */
export function recordStroke(state: StrokeHistoryState, stroke: Stroke): StrokeHistoryState {
  return {
    ...state,
    strokes: [...state.strokes, stroke],
    futureStrokes: [],
    currentStroke: null,
  };
}

/** Move the latest visible stroke to the redo stack. */
export function undoStroke(state: StrokeHistoryState): StrokeHistoryState {
  const stroke = state.strokes.at(-1);
  if (!stroke) return state;
  return {
    ...state,
    strokes: state.strokes.slice(0, -1),
    futureStrokes: [...state.futureStrokes, stroke],
    currentStroke: null,
  };
}

export function redoStroke(state: StrokeHistoryState): StrokeHistoryState {
  const stroke = state.futureStrokes.at(-1);
  if (!stroke) return state;
  return {
    ...state,
    strokes: [...state.strokes, stroke],
    futureStrokes: state.futureStrokes.slice(0, -1),
    currentStroke: null,
  };
}

export function clearStrokeHistory(state: StrokeHistoryState): StrokeHistoryState {
  if (state.strokes.length === 0 && state.futureStrokes.length === 0 && state.currentStroke === null) return state;
  return {
    ...state,
    strokes: [],
    futureStrokes: [],
    currentStroke: null,
  };
}
