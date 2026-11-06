import type { CodeRef, SystemModel } from './types.ts';

export type Citation = CodeRef & { by: { kind: 'part' | 'flow'; id: string } };

/** Every file path the drawing cites, with the part or line that cites it. */
export function citations(model: SystemModel): Citation[] {
  const out: Citation[] = [];
  for (const p of Object.values(model.parts)) for (const ref of p.code) out.push({ ...ref, by: { kind: 'part', id: p.id } });
  for (const f of Object.values(model.flows)) {
    for (const ref of [f.code.from, f.code.to]) if (ref) out.push({ ...ref, by: { kind: 'flow', id: f.id } });
  }
  return out;
}

/** True when `path` is the cited path or sits inside it (a cited folder covers its files). */
export const covers = (cited: string, path: string) => path === cited || path.startsWith(cited + '/');
