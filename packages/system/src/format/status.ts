import { bySheetOrder } from './load.ts';
import type { LoadResult, SystemModel } from './types.ts';

export type DrawingStatus = {
  state: 'none' | 'drawing' | 'drawn' | 'broken';
  sheets: number;
  wanted: number;
  drawnAt: string | null;
};

export function stillWanted(model: SystemModel): SystemModel['wanted'] {
  return model.wanted.filter((w) => !Object.hasOwn(model.sheets, w.code));
}

export function drawingStatus(result: LoadResult | null): DrawingStatus {
  if (!result || (!result.model && !result.errors.length)) return { state: 'none', sheets: 0, wanted: 0, drawnAt: null };
  const model = result.model;
  if (!model) return { state: 'broken', sheets: 0, wanted: 0, drawnAt: null };
  const wanted = stillWanted(model).length;
  return {
    state: wanted ? 'drawing' : result.errors.length ? 'broken' : 'drawn',
    sheets: Object.keys(model.sheets).length,
    wanted,
    drawnAt: model.sources?.repos.self?.at || null,
  };
}

export function drawingProgress(model: SystemModel): { sheets: { code: string; title: string; kind: string; drawn: boolean }[] } {
  const drawn = Object.keys(model.sheets)
    .sort(bySheetOrder(model.sheets))
    .map((code) => ({ code, title: model.sheets[code]!.title, kind: model.sheets[code]!.kind, drawn: true }));
  const wanted = stillWanted(model)
    .map((w) => ({ code: w.code, title: w.question, kind: w.kind, drawn: false }));
  return { sheets: [...drawn, ...wanted] };
}
