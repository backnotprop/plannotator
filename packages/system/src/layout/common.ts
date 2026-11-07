// What every composer shares: the paper's fixed measures, the outer rule and
// the room kept under the drawing.
import type { SystemModel } from '../format/types.ts';

/** A sheet is this many units wide; the camera scales it to the screen. */
export const W = 1600;
/** The paper margin. */
export const M = 56;
/** The top of the field, below the title and the question. */
export const FIELD_TOP = 146;
const TITLE_H = 30, BOTTOM = 26;
/**
 * Lettered notes fold away at rest (a letter on the drawing, its words on hover
 * or focus), so the paper keeps no room for them. The foot keeps one line for
 * a change's tally (step A5) so a sheet with a change is as tall as without.
 */
export const REV_LINE = 38;
export const FOOT_H = REV_LINE + TITLE_H + BOTTOM;

const within = (model: SystemModel, sc: string, top: string) => {
  for (let q: string | undefined = sc, n = 0; q && n < 40; q = model.parentOf[q], n++) if (q === top) return true;
  return false;
};

/**
 * An inner sheet shows only the thing zoomed into: a part whose scope is not
 * this sheet's scope (or a scope inside it) is not drawn there. A line that
 * joins it arrives from the sheet's edge, with the outer part's name in small
 * type at the margin. Technology tiles are not parts of any scope.
 */
export function outerTest(model: SystemModel, here: string): (id: string) => boolean {
  return (id) => {
    const p = model.parts[id];
    return !!p && p.kind !== 'technology' && !within(model, p.in || 'root', here || 'root');
  };
}

/** A margin name: the outer parts' names, at most three, then a count. */
export function portText(model: SystemModel, ids: string[]): string {
  const names = ids.map((id) => model.parts[id]?.name || id);
  return names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ');
}

/** A technology's version, from its facts. */
export const versionOf = (facts: [string, string][]) => facts.find(([k]) => k.toLowerCase() === 'version')?.[1] ?? '';
