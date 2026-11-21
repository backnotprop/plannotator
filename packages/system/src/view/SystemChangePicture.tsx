// The review card's picture (walkthrough screen 5): the sheet a PR touches
// most, cropped to the bands its changed parts sit in, with the change's inks,
// and one line under it ("3 parts added, 5 changed, 1 line removed"). The
// whole picture is one control: it asks the host to open the full System view.
// Start review stays the card's only button; this adds none of its own words.
//
// With a revision it draws what the review agent wrote (added, changed,
// removed); with only the gate's result (no revision yet, or one for an older
// head) it draws the touched parts amber and says how many changed.
import { useMemo, useRef } from 'react';
import type { Revision, SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import { applyChange } from '../change/apply.ts';
import { changeSummary, changeWords, type ChangeFile, type ChangeSummary } from '../change/summary.ts';
import { Sheet } from '../draw/Sheet.tsx';
import { hasSimple, restLayout } from '../layout/compose.ts';
import type { Rect, SheetLayout } from '../layout/types.ts';
import { lodAt } from './rest.ts';
import { useSize, useText } from './text.ts';

export type SystemChangePictureProps = {
  model: SystemModel;
  change: Revision | GateResult;
  /** The PR's changed files with their counts, when the host has them. */
  files?: ChangeFile[];
  /** A click on the picture: the host opens the full System view of the PR. */
  onOpen(): void;
};

const PAD = 18;

/** The part of a sheet a change is in: its changed parts and the bands they sit in, or the whole field when nothing is marked. */
export function changeCrop(L: SheetLayout): Rect {
  const marked = Object.values(L.parts).filter((p) => p.status);
  const boxes: Rect[] = marked.length ? [...marked] : Object.values(L.parts);
  for (const p of marked) {
    const z = p.band ? L.zones.find((x) => x.id === p.band) : null;
    if (z) boxes.push(z);
  }
  for (const e of L.edges) if (e.status && e.lb && !e.lb.hidden) boxes.push(e.lb);
  if (!boxes.length) return { x: 0, y: 0, w: L.w, h: L.h };
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - PAD), y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - PAD);
  const x1 = Math.min(L.w, Math.max(...boxes.map((b) => b.x + b.w)) + PAD), y1 = Math.min(L.h, Math.max(...boxes.map((b) => b.y + b.h)) + PAD);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Past this many lines in the crop, a card-sized picture is a tangle: it is drawn in the Simple reading, parts only. */
const BUSY = 16;
const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** The sheet as the card draws it: Full, or Simple when the change's part of it is crossed by many lines. */
export function pictureLayout(model: SystemModel, code: string): SheetLayout {
  const full = restLayout(model, code);
  if (!hasSimple(model, code)) return full;
  const crop = changeCrop(full);
  const lines = full.edges.filter((e) => e.style !== 'aud' && e.pts?.some(([x, y]) => inside(crop, x, y))).length;
  return lines > BUSY ? restLayout(model, code, { simple: true }) : full;
}

/** The change's line, each kind in its own ink. */
export function ChangeLine({ summary }: { summary: ChangeSummary }) {
  const words = changeWords(summary);
  // the line is one sentence; each clause takes its kind's ink, in the order changeWords writes them
  const gonePart = summary.parts.filter((p) => p.is === 'removed').length;
  const kinds = [summary.added && 'added', summary.changed && 'changed', gonePart && 'removed', summary.removed - gonePart && 'removed'].filter((x): x is string => !!x);
  const parts = words.split(', ');
  if (parts.length !== kinds.length) return <span className="sys-cline">{words}</span>;
  return (
    <span className="sys-cline">
      {parts.map((p, i) => <span key={i}>{i > 0 && ', '}<span className={'sys-ink-' + kinds[i]}>{p}</span></span>)}
    </span>
  );
}

export function SystemChangePicture({ model, change, files, onOpen }: SystemChangePictureProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const { epoch } = useText(ref);
  const size = useSize(ref);
  const summary = useMemo(() => changeSummary(model, change, files), [model, change, files]);
  const shown = useMemo(() => applyChange(model, change, 'after', files), [model, change, files]);
  const L = useMemo(() => (summary.sheet ? pictureLayout(shown, summary.sheet) : null), [shown, summary.sheet, epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const crop = L ? changeCrop(L) : null;
  const w = size.w;
  const k = crop && w ? w / crop.w : 0;
  const title = L ? `${L.title}: ${changeWords(summary)}` : changeWords(summary);
  return (
    <button ref={ref} type="button" className="sys sys-cpic" onClick={() => onOpen()} aria-label={`${title}. Open the System view`} data-sheet={summary.sheet}>
      <span className="sys-cpic-frame" style={crop && k ? { height: Math.ceil(crop.h * k) } : undefined}>
        {L && crop && k > 0 && (
          <span className="sys-scaled" style={{ transform: `scale(${k}) translate(${-crop.x}px, ${-crop.y}px)` }}>
            <Sheet layout={L} model={shown} lod={lodAt(k)} />
          </span>
        )}
      </span>
      <ChangeLine summary={summary} />
    </button>
  );
}
