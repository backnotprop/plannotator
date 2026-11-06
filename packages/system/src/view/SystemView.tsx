// One sheet of a drawing, in a pane or a full window, at rest. Props only: the
// Inbox owns the address, the reading and the window; this draws what it is
// given and says what the person asked for through the callbacks.
//
// Step A3 (this): the sheet at rest, Simple or Full, its bar (where it is, the
// kind, the Simple / Full switch, Open full window, close), and a window's
// "N sheets inside" cue, which asks for the first sheet inside through
// onNavigate with no motion. Step A4 adds the camera (zoom, pan, the dive),
// the crumbs and sheet chips as controls, the zoom group and Key, the
// keyboard, and the Simple / Full move. Step A5 draws a change.
import { useRef } from 'react';
import type { Revision, SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import { kindLabel } from '../draw/format.ts';
import { Sheet } from '../draw/Sheet.tsx';
import { hasSimple } from '../layout/compose.ts';
import { layoutAtRest, lodAt, scopePath, sheetOr } from './rest.ts';
import { useSize, useText } from './text.ts';

export type Reading = 'simple' | 'full';

export type SystemViewProps = {
  model: SystemModel;
  /** The sheet to draw; the landing sheet when left out. */
  sheet?: string;
  /** Simple or Full (default Full). A sheet with one reading draws it whatever this says. */
  reading?: Reading;
  /** pane: the drawing fits the pane's width and grows down; window: it fits the window. */
  layout: 'pane' | 'window';
  /** A change to draw (step A5). */
  revision?: Revision | GateResult;
  /** Before, After or Steps of a change (step A5). */
  view?: 'before' | 'after' | 'steps';
  /** plan: a change drawn dashed, for Shape's System (plan) tab (step A5). */
  mode?: 'review' | 'plan';
  /** The person asked for another sheet (a window's cue at rest; the dive and the crumbs in step A4). */
  onNavigate(sheet: string): void;
  /** Shown as the Simple / Full switch when given, on a sheet that has both readings. */
  onReading?(r: Reading): void;
  /** Before / After / Steps (step A5). */
  onView?(v: 'before' | 'after' | 'steps'): void;
  /** A part's file (step A5). */
  onOpenFile?(path: string, part: string): void;
  /** Shown as Open full window when given, in the pane. */
  onOpenFull?(): void;
  /** Shown as a close button when given. */
  onClose?(): void;
};

const PAD = 20;

export function SystemView({ model, sheet, reading = 'full', layout, onNavigate, onReading, onOpenFull, onClose }: SystemViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  useText(root);
  const size = useSize(stage);
  const code = sheetOr(model, sheet);
  const s = model.sheets[code];
  const two = !!s && hasSimple(model, code);
  const L = s ? layoutAtRest(model, code, reading === 'simple') : null;
  // at rest the sheet fits: the pane's width, or the whole window; never past 1:1
  const availW = Math.max(0, size.w - PAD * 2), availH = Math.max(0, size.h - PAD * 2);
  const k = !L || !availW ? 0 : Math.min(1, availW / L.w, layout === 'window' && availH ? availH / L.h : Infinity);
  const path = s ? scopePath(model, code) : [];
  return (
    <div ref={root} className={'sys sys-view sys-' + layout} data-sheet={code} data-reading={two ? reading : 'full'}>
      <div className="sys-bar">
        <div className="sys-crumbs" aria-label="Where this sheet is">
          <span className="sys-crumb">{model.name}</span>
          {path.map(([id, name]) => (
            <span key={id} className="sys-crumb-w">
              <span className="sys-crumb-sep" aria-hidden="true">/</span>
              <span className={'sys-crumb' + (id === s?.scope ? ' sys-here' : '')}>{name}</span>
            </span>
          ))}
          {s && <span className="sys-code">{code}</span>}
        </div>
        {s && <div className="sys-kind" aria-label="Sheet kind">{kindLabel(s.kind)}</div>}
        <div className="sys-tools">
          {two && onReading && (
            <div className="sys-seg" role="radiogroup" aria-label="Reading">
              {(['simple', 'full'] as const).map((r) => (
                <button key={r} type="button" role="radio" aria-checked={reading === r} className="sys-seg-o" data-on={reading === r ? '' : undefined} onClick={() => reading !== r && onReading(r)}>
                  {r === 'simple' ? 'Simple' : 'Full'}
                </button>
              ))}
            </div>
          )}
          {layout === 'pane' && onOpenFull && (
            <button type="button" className="sys-btn" onClick={() => onOpenFull()}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5L8 8M6.5 3.5h-3v9h9v-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Open full window
            </button>
          )}
          {onClose && (
            <button type="button" className="sys-icon-btn" aria-label="Close" onClick={() => onClose()}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          )}
        </div>
      </div>
      <div ref={stage} className="sys-stage">
        {L && k > 0 && (
          <div className="sys-fit" style={{ width: Math.ceil(L.w * k), height: Math.ceil(L.h * k), margin: `${PAD}px auto` }}>
            <div className="sys-scaled" style={{ transform: `scale(${k})` }}>
              <Sheet layout={L} model={model} lod={lodAt(k)} live onNavigate={onNavigate} />
            </div>
          </div>
        )}
        {!s && <div className="sys-empty">This drawing has no sheet {sheet ? `called ${sheet}` : 'yet'}.</div>}
      </div>
    </div>
  );
}
