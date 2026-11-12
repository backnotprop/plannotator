import { useRef } from 'react';
import type { SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import type { Revision } from '../format/types.ts';
import { Sheet } from '../draw/Sheet.tsx';
import { applyChange } from '../change/apply.ts';
import { changeSummary } from '../change/summary.ts';
import { layoutAtRest, lodAt, sheetOr } from './rest.ts';
import { useText } from './text.ts';

export type SystemThumbProps = {
  model: SystemModel;
  sheet?: string;
  revision?: Revision | GateResult;
  width: number;
};

export function SystemThumb({ model: base, sheet, revision, width }: SystemThumbProps) {
  const ref = useRef<HTMLDivElement>(null);
  useText(ref);
  const model = revision ? applyChange(base, revision, 'after') : base;
  const code = sheetOr(model, sheet ?? (revision ? changeSummary(base, revision).sheet : undefined));
  const L = code ? layoutAtRest(model, code, false) : null;
  if (!L) return <div ref={ref} className="sys sys-thumb" style={{ width }} />;
  const k = width / L.w;
  return (
    <div ref={ref} className="sys sys-thumb" style={{ width, height: Math.ceil(L.h * k) }} role="img" aria-label={`${L.title}: ${L.question}`} data-sheet={L.id}>
      <div className="sys-scaled" style={{ transform: `scale(${k})` }}>
        <Sheet layout={L} model={model} lod={lodAt(k)} />
      </div>
    </div>
  );
}
