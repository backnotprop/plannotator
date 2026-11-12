import type { SystemModel } from '../format/types.ts';
import { hasSimple, restLayout } from '../layout/compose.ts';
import type { SheetLayout } from '../layout/types.ts';
import type { Lod } from '../draw/Sheet.tsx';

export const sheetOr = (model: SystemModel, code?: string) => (code && model.sheets[code] ? code : model.sheets[model.root] ? model.root : Object.keys(model.sheets)[0] ?? '');

export const layoutAtRest = (model: SystemModel, code: string, simple: boolean): SheetLayout => restLayout(model, code, { simple: simple && hasSimple(model, code) });

export const lodAt = (k: number): Lod => (k >= 0.95 ? 3 : k >= 0.3 ? 2 : 1);

export const scopeLabel = (model: SystemModel, sc: string) =>
  sc === 'root' ? model.name : (model.owner[sc] && model.parts[model.owner[sc]!]?.name) || model.scopes[sc] || sc;

export function scopePath(model: SystemModel, code: string): [string, string][] {
  const out: [string, string][] = [];
  for (let sc: string | undefined = model.sheets[code]?.scope || 'root', n = 0; sc && n < 40; n++) {
    out.unshift([sc, scopeLabel(model, sc)]);
    if (sc === 'root') break;
    sc = model.parentOf[sc] ?? 'root';
  }
  return out;
}
