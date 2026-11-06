// The drawing at rest: which layout a view draws, at what scale, with how
// much detail. Shared by SystemView and SystemThumb.
import type { SystemModel } from '../format/types.ts';
import { hasSimple, restLayout } from '../layout/compose.ts';
import type { SheetLayout } from '../layout/types.ts';
import type { Lod } from '../draw/Sheet.tsx';

/** The sheet a view opens on when none is asked for, or the one asked for is not in the drawing. */
export const sheetOr = (model: SystemModel, code?: string) => (code && model.sheets[code] ? code : model.sheets[model.root] ? model.root : Object.keys(model.sheets)[0] ?? '');

/** The at-rest layout of one sheet in one reading. */
export const layoutAtRest = (model: SystemModel, code: string, simple: boolean): SheetLayout => restLayout(model, code, { simple: simple && hasSimple(model, code) });

/**
 * How much the drawing says at a scale: line words from 0.3 (a thumb in a
 * thread, a pane), the quiet lines' words from 0.95, names only below 0.3.
 */
export const lodAt = (k: number): Lod => (k >= 0.95 ? 3 : k >= 0.3 ? 2 : 1);

/** The scope path of a sheet, from the landing scope down: [scope id, display name][]. */
export function scopePath(model: SystemModel, code: string): [string, string][] {
  const out: [string, string][] = [];
  for (let sc: string | undefined = model.sheets[code]?.scope || 'root', n = 0; sc && n < 40; n++) {
    out.unshift([sc, model.scopes[sc] ?? sc]);
    if (sc === 'root') break;
    sc = model.parentOf[sc] ?? 'root';
  }
  return out;
}
