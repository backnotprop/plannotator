import type { SystemModel } from '../format/types.ts';

export const W = 1600;
export const M = 56;
export const FIELD_TOP = 146;
const TITLE_H = 30, BOTTOM = 26;
export const REV_LINE = 38;
export const FOOT_H = REV_LINE + TITLE_H + BOTTOM;

const within = (model: SystemModel, sc: string, top: string) => {
  for (let q: string | undefined = sc, n = 0; q && n < 40; q = model.parentOf[q], n++) if (q === top) return true;
  return false;
};

export function outerTest(model: SystemModel, here: string): (id: string) => boolean {
  return (id) => {
    const p = model.parts[id];
    return !!p && p.kind !== 'technology' && !within(model, p.in || 'root', here || 'root');
  };
}

export function portText(model: SystemModel, ids: string[]): string {
  const names = ids.map((id) => model.parts[id]?.name || id);
  return names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ');
}

export const versionOf = (facts: [string, string][]) => facts.find(([k]) => k.toLowerCase() === 'version')?.[1] ?? '';
