import { useMemo, useRef } from 'react';
import type { SystemModel } from '../format/types.ts';
import { Sheet } from '../draw/Sheet.tsx';
import { plural } from '../draw/format.ts';
import { layoutSheet } from '../layout/compose.ts';
import { STEPS_CODE } from '../change/apply.ts';
import { useSize } from './text.ts';

export function StepsStage({ model, epoch }: { model: SystemModel; epoch: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const L = useMemo(() => (model.sheets[STEPS_CODE] ? layoutSheet(model, STEPS_CODE) : null), [model, epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!L) return null;
  const n = model.sheets[STEPS_CODE]!.hops.length;
  const kw = size.w ? (size.w - 48) / L.w : 0;
  // the whole sequence when it fits, else the width, never past 1:1
  const k = Math.min(1, kw, Math.max(size.h ? (size.h - 24) / L.h : kw, kw * 0.7));
  return (
    <div ref={ref} className="sys-steps" role="region" aria-label={`${L.title}: ${plural(n, 'step')}`} tabIndex={0} data-sheet={STEPS_CODE}>
      {k > 0 && (
        <div className="sys-steps-sheet" style={{ width: Math.ceil(L.w * k), height: Math.ceil(L.h * k) }}>
          <div className="sys-scaled" style={{ transform: `scale(${k})` }}>
            <Sheet layout={L} model={model} lod={3} live />
          </div>
        </div>
      )}
    </div>
  );
}
