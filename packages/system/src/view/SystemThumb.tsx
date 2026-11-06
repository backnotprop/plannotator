// The card picture: one sheet at rest, drawn to a width, with no controls.
// A thread's message and a project card show it; the Inbox draws the card
// around it (the title line, Open).
import { useRef } from 'react';
import type { SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import type { Revision } from '../format/types.ts';
import { Sheet } from '../draw/Sheet.tsx';
import { layoutAtRest, lodAt, sheetOr } from './rest.ts';
import { useText } from './text.ts';

export type SystemThumbProps = {
  model: SystemModel;
  /** The sheet to draw; the landing sheet when left out. */
  sheet?: string;
  /** A change to draw on the sheet (step A5; drawn at rest without it until then). */
  revision?: Revision | GateResult;
  /** The picture's width in px; its height follows the sheet. */
  width: number;
};

export function SystemThumb({ model, sheet, width }: SystemThumbProps) {
  const ref = useRef<HTMLDivElement>(null);
  useText(ref);
  const code = sheetOr(model, sheet);
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
