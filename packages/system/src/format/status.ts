// What the Inbox shows about a drawing before it draws one: its state and,
// while an agent is drawing, which sheets are done.
import { bySheetOrder } from './load.ts';
import type { LoadResult, SystemModel } from './types.ts';

export type DrawingStatus = {
  /** none: no drawing; drawing: sheets still wanted; drawn: nothing wanted; broken: the files do not load. */
  state: 'none' | 'drawing' | 'drawn' | 'broken';
  sheets: number;
  wanted: number;
  /** The commit of this repo the drawing was drawn or checked against (`sources.repos.self.at`), or null. */
  drawnAt: string | null;
};

export function drawingStatus(result: LoadResult | null): DrawingStatus {
  if (!result || (!result.model && !result.errors.length)) return { state: 'none', sheets: 0, wanted: 0, drawnAt: null };
  const model = result.model;
  if (!model || result.errors.length) return { state: 'broken', sheets: 0, wanted: 0, drawnAt: null };
  const wanted = model.wanted.filter((w) => !model.sheets[w.code]).length;
  return {
    state: wanted ? 'drawing' : 'drawn',
    sheets: Object.keys(model.sheets).length,
    wanted,
    drawnAt: model.sources?.repos.self?.at || null,
  };
}

/** One tile per sheet: the drawn ones in pivot order, then the wanted ones in the order system.yaml lists them. */
export function drawingProgress(model: SystemModel): { sheets: { code: string; title: string; kind: string; drawn: boolean }[] } {
  const drawn = Object.keys(model.sheets)
    .sort(bySheetOrder(model.sheets))
    .map((code) => ({ code, title: model.sheets[code]!.title, kind: model.sheets[code]!.kind, drawn: true }));
  const wanted = model.wanted
    .filter((w) => !model.sheets[w.code])
    .map((w) => ({ code: w.code, title: w.question, kind: w.kind, drawn: false }));
  return { sheets: [...drawn, ...wanted] };
}
