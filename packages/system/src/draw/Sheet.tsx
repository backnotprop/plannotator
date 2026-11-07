// One sheet, drawn at rest from its layout (layout/compose.ts). Props only: no
// fetching, no routes, no camera. The view (view/SystemView.tsx) scales it.
//
// Layers, bottom to top: the paper; the bands (zones) and split rules; the
// figures under the lines (lifelines); the lines; the band labels; the parts;
// the figures over the lines; the line words; the title, callouts, split words
// and note letters.
//
// Step A4 adds the camera, the dive and the Simple / Full move around this
// component; step A5 adds the change inks (every `status` is null at rest).
import { createContext, Fragment, memo, useContext, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { Part, SystemModel } from '../format/types.ts';
import type { Edge, Figure, PartBox, SheetLayout } from '../layout/types.ts';
import { plural } from './format.ts';
import { arrowHead, midOf, roundedPath, trimEnd } from './geom.ts';
import { MOVES } from './grammar.ts';
import { hasMark, TEXT_MARKS } from './mark-ids.ts';
import { Mark, Marks } from './marks.tsx';
import { OV_SEP } from './overlays.ts';

/** Level of detail: 0 outlines, 1 names, 2 phrases (line words), 3 everything (quiet lines' words too). */
export type Lod = 0 | 1 | 2 | 3;

export type SheetProps = {
  layout: SheetLayout;
  model: SystemModel;
  lod?: Lod;
  /** Takes the pointer and the keyboard (hover lights a part's lines, a note's letter shows its words). */
  live?: boolean;
  /** A window's "N sheets inside" cue: the first sheet of the scope it opens (when onEnter is not given). */
  onNavigate?: (sheet: string) => void;
  /** A window's cue, or Enter on a window: the person asked to go inside the part (the view dives). */
  onEnter?: (part: string) => void;
};

// A part's second line is prose, set in the sans; only the code names in it (a
// dotted host, a path, a Durable Object, a protocol with a number) are mono.
const CODEY = /^(?:[\w-]+[./_][\w./_-]+|[A-Za-z]+DO|[a-z]+-?\d[\w-]*|\w+\(\))$/;
const prose = (t: string): ReactNode =>
  t.split(/(\s+)/).map((w, i) => (CODEY.test(w.replace(/[,;:.]$/, '')) ? <span key={i} className="sys-mono">{w}</span> : w));
// a text mark that only repeats the part's own words ("MCP" on "Agents over MCP") is left off
const echoes = (m: string, p: Part) =>
  (TEXT_MARKS.has(m) || !hasMark(m)) && new RegExp(`(^|[^a-z])${m.replace(/[^a-z0-9]/gi, '')}([^a-z]|$)`, 'i').test([p.name, p.role, p.sub].filter(Boolean).join(' '));

const Sub = ({ text }: { text: string }) => <div className="sys-sub sys-t-phrase">{prose(text)}</div>;

// ---------------------------------------------------------------- part bodies
function PartBody({ p, box, simple }: { p: Part; box: PartBox; simple: boolean }) {
  const v = box.v;
  const marks = p.wordmark ? box.marks : box.marks.filter((m) => !echoes(m, p));
  const sub = simple ? '' : p.sub;
  if (v === 'lane') {
    // a lane head: the part as a dark bar, on a flow or an algorithm sheet
    return (
      <div className="sys-pv sys-lane">
        <Marks ids={marks} s={18} />
        <span className="sys-nm sys-t-name">{p.name}</span>
        <span className="sys-sub sys-t-phrase">{prose(box.sub ?? '')}</span>
      </div>
    );
  }
  if (v === 'tile' || v === 'tilefor') {
    // a technology on a landscape: the mark does the talking; a tall tile also says what it is for
    return (
      <div className={'sys-pv sys-tile' + (v === 'tilefor' ? ' sys-for' : '')}>
        <div className="sys-tile-mk">{marks.length ? <Mark id={marks[0]!} s={34} /> : <span className="sys-tile-none">{p.name.slice(0, 2)}</span>}</div>
        {!(p.wordmark && marks.length) && <div className="sys-nm sys-t-name">{p.name}</div>}
        {v === 'tilefor' && p.role && <div className="sys-rl sys-t-phrase">{p.role}</div>}
        {box.sub && <Sub text={box.sub} />}
      </div>
    );
  }
  if (v === 'plate' || v === 'window') {
    return (
      <div className="sys-pv sys-plate">
        <div className="sys-top">
          <span className="sys-nm sys-t-name">{p.name}</span>
          {marks.length <= 2 && <Marks ids={marks} s={16} />}
        </div>
        <div className="sys-rl sys-t-phrase">{p.role}</div>
        {sub && <Sub text={sub} />}
        {marks.length > 2 && <div className="sys-mk-row"><Marks ids={marks} s={18} /></div>}
      </div>
    );
  }
  if (v === 'chip') {
    return (
      <div className="sys-pv sys-chip">
        <div className="sys-top"><Marks ids={marks} s={15} /><span className="sys-nm sys-t-name">{p.name}</span></div>
        <Sub text={sub || p.role} />
      </div>
    );
  }
  if (v === 'row' || v === 'rowx') {
    return (
      <div className={'sys-pv sys-row' + (v === 'rowx' ? ' sys-rowx' : '')}>
        <div className="sys-top sys-t-name">
          {p.wordmark && marks[0] ? <span className="sys-nm sys-wm"><Mark id={marks[0]} s={20} /></span> : <span className="sys-nm">{p.name}</span>}
          {!p.wordmark && v === 'row' && <Marks ids={marks} s={15} />}
        </div>
        <div className="sys-rl sys-t-phrase">{p.role}</div>
        {v === 'rowx' && <div className="sys-mk-row"><Marks ids={marks} s={17} /></div>}
      </div>
    );
  }
  if (v === 'card' && p.card) return <Card p={p} marks={marks} />;
  if (v === 'bar') {
    return (
      <div className="sys-pv sys-bar">
        <Marks ids={marks} s={18} />
        <span className="sys-nm sys-t-name">{p.name}</span>
        <span className="sys-rl sys-t-phrase">{p.role}</span>
      </div>
    );
  }
  // box and node (and a card with nothing written yet)
  const second = v === 'node' ? str(p.card?.config) || sub || p.role : sub;
  return (
    <div className={'sys-pv sys-box' + (p.kind === 'store' ? ' sys-store' : '') + (p.kind === 'client' ? ' sys-client' : '') + (p.kind === 'worker' ? ' sys-door' : '')}>
      <div className="sys-top">
        <span className={'sys-nm sys-t-name' + (box.nl ? ' sys-fit' : '')}>{box.nl ? box.nl.map((l, i) => <span key={i}>{l}</span>) : p.name}</span>
        <Marks ids={marks} s={15} />
      </div>
      {second ? <Sub text={second} /> : p.role && <div className="sys-rl sys-t-phrase">{p.role}</div>}
    </div>
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

function Card({ p, marks }: { p: Part; marks: string[] }) {
  const c = p.card!;
  const scale = str(c.scale).split(' ');
  return (
    <div className={'sys-pv sys-card' + (p.kind === 'worker' ? ' sys-door' : '')}>
      <div className="sys-card-title"><span className="sys-nm sys-t-name">{p.name}</span></div>
      <div className="sys-card-sec sys-runtime sys-t-phrase">
        <Marks ids={marks} s={20} />
        <div className="sys-cap">{str(c.runtime)}</div>
      </div>
      <div className="sys-card-sec sys-t-phrase">
        <div className="sys-sec-h">Entry points</div>
        {list(c.entry).map((r) => <div className="sys-route sys-mono" key={r} title={r}>{r}</div>)}
      </div>
      <div className="sys-card-sec sys-t-phrase">
        <div className="sys-sec-h">Bindings</div>
        {list(c.binds).map((b) => {
          const [k, ...rest] = b.split(' ');
          return <div className="sys-bind" key={b} title={b}><span className="sys-mono">{k}</span><span className="sys-bv">{rest.join(' ')}</span></div>;
        })}
      </div>
      <div className="sys-card-scale sys-t-phrase">
        <span className="sys-big">{scale[0]}</span>
        <span className="sys-lbl">{scale.slice(1).join(' ')}<em>{str(c.note)}</em></span>
      </div>
      <div className="sys-card-strip sys-t-phrase">
        <div className="sys-mono" title={str(c.runs)}>{str(c.runs)}</div>
        <div className="sys-mono sys-dim" title={str(c.config)}>{str(c.config)}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- notes
// A lettered note folded away: the letter is a small control wherever it sits
// (on a part, in a line's words, on a figure); its words show on hover or focus.
const NotesCtx = createContext<{ notes: SheetLayout['notes']; live: boolean }>({ notes: [], live: false });
function NoteMark({ l, className, style }: { l: string; className: string; style?: CSSProperties }) {
  const ctx = useContext(NotesCtx);
  const [open, setOpen] = useState(false);
  const n = ctx.notes.find((x) => x.l === l);
  // a still picture (a thumb) draws the letter only: its note opens on a live sheet
  if (!n || !ctx.live) return <span className={className} style={style}>{l}</span>;
  return (
    <button
      type="button"
      className={className + ' sys-peek'}
      style={style}
      aria-label={`Note ${l}: ${n.text}`}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={(e) => e.stopPropagation()}
    >
      {l}
      {open && (
        <span role="tooltip" className="sys-note-peek sys-t-phrase">
          <span className="sys-letter">{l}</span>
          <span>{n.text}</span>
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------- lines
// What a hover lights: a part lights its lines and their far ends; a line
// lights itself and both ends.
type Focus = { edges: Set<string>; parts: Set<string> } | null;
export function focusOf(hover: string | null, L: SheetLayout): Focus {
  if (!hover) return null;
  const edges = new Set<string>(), parts = new Set<string>();
  if (hover.startsWith('edge:')) {
    const e = L.edges.find((x) => x.id === hover.slice(5));
    if (!e) return null;
    edges.add(e.id);
    e.from.forEach((f) => parts.add(f));
    parts.add(e.to);
    return { edges, parts };
  }
  parts.add(hover);
  for (const e of L.edges)
    if (e.style !== 'aud' && (e.from.includes(hover) || e.to === hover)) {
      edges.add(e.id);
      e.from.forEach((f) => parts.add(f));
      parts.add(e.to);
    }
  return edges.size ? { edges, parts } : null; // a part with no lines dims nothing
}

function EdgeLayer({ edges, focus, live, onHover }: { edges: Edge[]; focus: Focus; live: boolean; onHover: (h: string | null) => void }) {
  return (
    <svg className="sys-abs sys-edges" width="1" height="1">
      {edges.map((e) => {
        if (!e.pts) return null;
        const lit = !!focus?.edges.has(e.id);
        const aud = e.style === 'aud';
        const w0 = e.line?.w ?? 1.3;
        const sw = aud ? 2.6 : w0 + (lit ? 0.6 : 0);
        const hl = aud ? 14 : 9, hw = aud ? 6 : 3.6;
        let pts = trimEnd(e.pts, hl - 1);
        if (e.both) pts = trimEnd(pts.slice().reverse(), hl - 1).reverse();
        // the hue for what moves; an overlay's ink replaces it
        const hue = !aud && e.line ? e.line.ink || MOVES[e.line.moves].ink : null;
        const ink = aud ? 'var(--sys-ink)' : lit ? hue || 'var(--sys-ink)' : hue || 'var(--sys-line)';
        const dim = focus && !lit && !aud ? 0.2 : 1;
        const all = [...(e.paths ?? []), e.pts];
        const end = (k: 0 | 1) => (k === 0 ? e.pts![0]! : e.pts![e.pts!.length - 1]!);
        return (
          <g key={e.id} opacity={dim} className={'sys-edge' + (lit ? ' sys-lit' : '')} data-edge={e.id}>
            {(e.paths ?? []).map((p, i) => <path key={i} d={roundedPath(p)} fill="none" stroke={ink} strokeWidth={sw} strokeDasharray={e.dash ?? undefined} />)}
            <path d={roundedPath(pts)} fill="none" stroke={ink} strokeWidth={sw} strokeDasharray={e.dash ?? undefined} />
            <path d={arrowHead(e.pts, hl, hw)} fill={ink} />
            {e.both && <path d={arrowHead(e.pts, hl, hw, true)} fill={ink} />}
            {e.port && (
              // the part at the other end lives on another sheet; its name sits
              // at the margin, small, where the line crosses
              <g className="sys-port">
                <circle cx={end(e.port.dir === 'in' ? 0 : 1)[0]} cy={end(e.port.dir === 'in' ? 0 : 1)[1]} r="2.4" fill="var(--sys-paper)" stroke={ink} strokeWidth="1.3" />
                <text
                  x={e.port.edge === 'right' ? e.port.x + e.port.w : e.port.x + e.port.w / 2}
                  y={e.port.edge === 'top' ? e.port.y + 2 : e.port.edge === 'right' ? e.port.y + 10 : e.port.y + e.port.h + 10}
                  textAnchor={e.port.edge === 'right' ? 'end' : 'middle'}
                  className="sys-port-name sys-t-phrase"
                >
                  {e.port.text}
                </text>
              </g>
            )}
            {e.lb?.hidden && !lit && !aud && (() => {
              const [mx, my] = midOf(e.pts);
              return <circle cx={mx} cy={my} r="2.6" fill={ink} />;
            })()}
            {live && !aud && all.map((p, i) => (
              <path key={'hit' + i} d={roundedPath(p)} className="sys-hit" fill="none" stroke="transparent" strokeWidth="14" onPointerEnter={() => onHover('edge:' + e.id)} onPointerLeave={() => onHover(null)} />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// An overlay's words ride after the line's own words, set in mono in the
// overlay's ink; `tails` holds where each starts in the text. The wrap joins
// words with one space, so the offsets carry across lines.
function tailSplit(lines: string[], tails: { at: number; ink: string }[]): ReactNode[] {
  const sep = OV_SEP.length;
  const runOf = (c: number) => {
    let r = -1;
    for (let k = 0; k < tails.length; k++) {
      if (c >= tails[k]!.at) r = k;
      else if (c >= tails[k]!.at - sep) return -2;
    }
    return r;
  };
  let at = 0;
  return lines.map((l) => {
    const s0 = at;
    at += l.length + 1;
    const out: ReactNode[] = [];
    for (let i = 0; i < l.length; ) {
      const r = runOf(s0 + i);
      let j = i + 1;
      while (j < l.length && runOf(s0 + j) === r) j++;
      const t = l.slice(i, j);
      if (r === -1) out.push(t);
      else if (r === -2) {
        if (i > 0 && j < l.length) out.push(' ');
      } else out.push(<span key={i} className="sys-rate sys-mono" style={{ color: tails[r]!.ink }}>{t}</span>);
      i = j;
    }
    return <>{out}</>;
  });
}

function EdgeLabels({ edges, focus }: { edges: Edge[]; focus: Focus }) {
  return (
    <>
      {edges.map((e) => {
        if (!e.lb || !e.says || e.style === 'aud') return null;
        const lit = !!focus?.edges.has(e.id);
        if (e.lb.hidden && !lit) return null;
        const dim = focus && !lit ? 0.25 : 1;
        const cls = 'sys-elabel ' + (e.quiet ? 'sys-t-quiet' : 'sys-t-phrase') + (lit ? ' sys-show' : '') + (e.lb.hidden ? ' sys-float' : '');
        const lines = e.tails ? tailSplit(e.lb.lines, e.tails) : e.lb.lines;
        return (
          <div key={e.id} data-edge={e.id} className={cls} style={{ left: e.lb.x, top: e.lb.y, width: e.lb.w, opacity: dim < 1 ? dim : undefined }}>
            {e.letter && <NoteMark l={e.letter} className="sys-letter sys-in" />}
            <span>{lines.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{l}</Fragment>)}</span>
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- figures
// Drawn things that are not parts and not lines of the model.
function FigArrow({ f }: { f: Figure }) {
  const pts = f.pts!;
  const hl = f.heavy ? 11 : 8, hw = f.heavy ? 4.4 : 3.3;
  const a = pts[0]!, b = pts[pts.length - 1]!;
  const horiz = Math.abs(b[1] - a[1]) < 1;
  const ink = f.heavy ? 'var(--sys-ink)' : 'var(--sys-line)';
  return (
    <g>
      <path d={roundedPath(trimEnd(pts, hl - 1))} fill="none" stroke={ink} strokeWidth={f.heavy ? 1.8 : 1.3} strokeDasharray={f.dashed ? '4 4' : undefined} />
      <path d={arrowHead(pts, hl, hw)} fill={ink} />
      {f.label && (horiz
        ? <text x={a[0] + 10} y={a[1] - 7} className="sys-fig-albl sys-t-phrase">{f.label}</text>
        : <text x={a[0] + 8} y={(a[1] + b[1]) / 2 + 4} className="sys-fig-albl sys-t-phrase">{f.label}</text>)}
    </g>
  );
}

const Lines = ({ lines }: { lines?: string[] }) => <>{(lines ?? []).map((l, i) => <Fragment key={i}>{i > 0 && <br />}{l}</Fragment>)}</>;

function Figures({ list, under, focus }: { list: Figure[]; under: boolean; focus: Focus }) {
  const items = list.filter((f) => !!f.under === under);
  if (!items.length) return null;
  const SVG = ['lifeline', 'vline', 'arrow', 'diamond'];
  const svg = items.filter((f) => SVG.includes(f.type));
  const html = items.filter((f) => !['lifeline', 'vline', 'arrow'].includes(f.type));
  return (
    <div className="sys-figl">
      {svg.length > 0 && (
        <svg className="sys-abs" width="1" height="1">
          {svg.map((f) => {
            if (f.type === 'lifeline') return <line key={f.id} x1={f.x} x2={f.x} y1={f.y0} y2={f.y1} stroke={f.faint ? 'var(--sys-line-faint)' : 'var(--sys-line-soft)'} strokeWidth="1" strokeDasharray="2 4" />;
            if (f.type === 'vline')
              return (
                <g key={f.id}>
                  <line x1={f.x} x2={f.x} y1={f.y0} y2={f.y1! - 8} stroke="var(--sys-line-faint)" strokeWidth="1" />
                  {f.arrow && <path d={`M${f.x},${f.y1} l-3.5,-9 h7 z`} fill="var(--sys-line-faint)" />}
                </g>
              );
            if (f.type === 'arrow') return <FigArrow key={f.id} f={f} />;
            const cx = f.x! + f.w! / 2, cy = f.y! + f.h! / 2;
            return <path key={f.id} d={`M${cx},${f.y} L${f.x! + f.w!},${cy} L${cx},${f.y! + f.h!} L${f.x},${cy} Z`} fill="var(--sys-box)" stroke="var(--sys-ink)" strokeWidth="1.3" strokeLinejoin="round" />;
          })}
        </svg>
      )}
      {html.map((f) => {
        const box: CSSProperties = { left: f.x, top: f.y, width: f.w, height: f.h };
        const letter = f.letter ? <NoteMark l={f.letter} className="sys-letter sys-fig-letter" /> : null;
        switch (f.type) {
          case 'tick':
            return <div key={f.id} className="sys-fig-tick sys-mono sys-t-phrase" style={{ left: f.x, top: f.y! - 8, width: f.w }}>{f.at}</div>;
          case 'text':
            return <div key={f.id} className={'sys-fig-text sys-t-phrase ' + (f.cls ? 'sys-' + f.cls : '')} style={{ left: f.x, top: f.y, width: f.w }}>{f.text}</div>;
          case 'diamond':
            return <div key={f.id + ':t'} className="sys-fig-dia sys-t-phrase" style={box}><span><Lines lines={f.lines} /></span>{letter}</div>;
          case 'step':
            return (
              <div key={f.id} className={'sys-fig-step' + (f.strong ? ' sys-strong' : '')} style={box}>
                <div className={f.strong ? 'sys-st-t sys-t-name' : 'sys-st-s sys-t-phrase'}>{(f.lines ?? []).map((l, i) => <div key={i}>{l}</div>)}</div>
                {!!f.code?.length && <div className="sys-st-c sys-mono sys-t-phrase">{f.code.map((l, i) => <div key={i}>{l}</div>)}</div>}
                {letter}
              </div>
            );
          case 'term':
            return <div key={f.id} className={'sys-fig-term sys-t-name' + (f.bad ? ' sys-bad' : '') + (f.mono ? ' sys-entry sys-mono' : '')} style={box}><span><Lines lines={f.lines} /></span>{letter}</div>;
          case 'load':
            return (
              <div key={f.id} className="sys-fig-load" style={box}>
                <div className="sys-ld-h sys-t-phrase"><span className="sys-ld-when">{f.when}</span>{f.size && <span className="sys-mono">{f.size}</span>}</div>
                <div className="sys-st-t sys-t-name">{(f.lines ?? []).map((l, i) => <div key={i}>{l}</div>)}</div>
                {!!f.code?.length && <div className="sys-st-c sys-mono sys-t-phrase">{f.code.map((l, i) => <div key={i}>{l}</div>)}</div>}
              </div>
            );
          case 'payload': {
            const lit = !!(focus && f.edge && focus.edges.has(f.edge));
            const dim = !!(focus && f.edge && !lit);
            return (
              <div key={f.id} className={'sys-fig-pl' + (f.schema ? ' sys-schema' : '') + (lit ? ' sys-lit' : '')} style={{ ...box, opacity: dim ? 0.3 : undefined }}>
                {f.title && <div className="sys-pl-h sys-mono sys-t-name">{f.title}</div>}
                <div className="sys-pl-b sys-mono sys-t-phrase">{(f.lines ?? []).map((l, i) => <div key={i}>{l || ' '}</div>)}</div>
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------- the sheet
function SheetImpl({ layout: L, model, lod = 2, live = false, onNavigate, onEnter }: SheetProps) {
  const [hover, setHover] = useState<string | null>(null);
  const focus = live ? focusOf(hover, L) : null;
  const P = model.parts;
  // parts in reading order (bands top to bottom, left to right): the order Tab walks them in
  const order = useMemo(() => Object.entries(L.parts).sort(([, a], [, b]) => (Math.abs(a.y - b.y) < 8 ? a.x - b.x : a.y - b.y)), [L]);
  const notesCtx = useMemo(() => ({ notes: L.notes, live }), [L.notes, live]);
  const onHover = (h: string | null) => live && setHover(h);
  return (
    <NotesCtx.Provider value={notesCtx}>
      <div className={`sys-sheet sys-lod-${lod}` + (live ? ' sys-live' : '') + (L.dense ? ' sys-dense' : '')} style={{ width: L.w, height: L.h }} data-sheet={L.id}>
        <div className="sys-paper" />
        <svg className="sys-abs sys-zones" width="1" height="1">
          {L.zones.map((z) => (
            <rect key={z.id} data-zone={z.id} x={z.x} y={z.y} width={z.w} height={z.h} rx="4" className={'sys-zone' + (z.solid ? ' sys-solid' : '') + (z.hair ? ' sys-hair' : '') + (z.tone === 'none' && !z.hair && !z.solid ? ' sys-none' : '')} />
          ))}
          {L.splits.map((s, i) => <line key={i} x1={s.x} y1={s.y0} x2={s.x} y2={s.y1} stroke="var(--sys-line-faint)" strokeDasharray="3 4" />)}
        </svg>
        <Figures list={L.figures} under focus={focus} />
        <EdgeLayer edges={L.edges} focus={focus} live={live} onHover={onHover} />
        <div>
          {L.zones.map((z) =>
            z.label ? (
              <div key={z.id} data-zone={z.id} className={'sys-zlabel sys-t-name' + (z.labelW ? ' sys-side' : '') + (z.hair || z.tone === 'none' ? ' sys-on-paper' : '')} style={{ left: z.x + 14, top: z.y + 11, maxWidth: z.labelW }}>
                {z.marks.length > 0 && <Marks ids={z.marks} s={17} />}
                <span>{z.label}</span>
                {z.means && <em className="sys-t-phrase">{z.means}</em>}
              </div>
            ) : null,
          )}
        </div>
        <div className="sys-parts">
          {order.map(([id, box]) => {
            const p = P[id];
            if (!p) return null;
            const lit = !!focus?.parts.has(id);
            const dim = focus && !lit ? 0.45 : 1;
            const first = box.cw && box.opens ? model.byScope[box.opens]?.[0] : undefined;
            const opens = !!(first && (onEnter || onNavigate));
            return (
              <div
                key={id}
                className={'sys-part' + (lit ? ' sys-lit' : '') + (hover === id ? ' sys-hov' : '')}
                data-part={id}
                data-opens={opens ? '' : undefined}
                title={p.name}
                style={{ left: box.x, top: box.y, width: box.w, height: box.h, opacity: dim < 1 ? dim : undefined }}
                // a live sheet's parts take the keyboard: Tab walks them in reading
                // order, the view moves between them with the arrows and dives on Enter
                tabIndex={live ? 0 : undefined}
                aria-label={live ? [p.name, p.role, opens ? `${plural(box.cw!, 'sheet')} inside, Enter opens it` : ''].filter(Boolean).join('. ') : undefined}
                onPointerEnter={() => onHover(id)}
                onPointerLeave={() => onHover(null)}
                onFocus={live ? () => onHover(id) : undefined}
                onBlur={live ? () => onHover(null) : undefined}
              >
                <PartBody p={p} box={box} simple={L.simple} />
                {box.ov && (
                  <>
                    {box.ov.tint && <span className="sys-ov-tint" style={{ background: box.ov.tint }} aria-hidden="true" />}
                    {box.ov.marks.length > 0 && <span className="sys-ov-mark sys-mono sys-t-phrase">{box.ov.marks.map((m, i) => <Fragment key={i}>{i > 0 && ' '}<span style={{ color: m.ink }}>{m.text}</span></Fragment>)}</span>}
                  </>
                )}
                {box.cw ? (
                  // a window at rest says it has an inside, quietly: one footer
                  // line in small type, and a second hairline behind the box's
                  // bottom-right corner, like a stack of sheets
                  <>
                    <span className="sys-win-stack" aria-hidden="true" />
                    {live && opens ? (
                      <button type="button" tabIndex={-1} className="sys-win-cue sys-go sys-t-phrase" onClick={(e) => { e.stopPropagation(); if (onEnter) onEnter(id); else onNavigate!(first!); }} aria-label={`Open ${p.name}: ${plural(box.cw, 'sheet')} inside`}>
                        {plural(box.cw, 'sheet') + ' inside'}
                        <Chevron />
                      </button>
                    ) : (
                      <span className="sys-win-cue sys-t-phrase">{plural(box.cw, 'sheet') + ' inside'}<Chevron /></span>
                    )}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
        <Figures list={L.figures} under={false} focus={focus} />
        <div>
          <EdgeLabels edges={L.edges} focus={focus} />
          <div className="sys-ann">
            <div className="sys-head" style={{ left: 56, top: 40 }}>
              <div className="sys-title sys-t-name">{L.title}</div>
              <div className="sys-q sys-t-phrase">{L.question}</div>
            </div>
            {L.callouts.map((c) => (
              <div key={c.id} className={'sys-aud sys-side-' + c.side} style={{ left: c.x, top: c.y, width: c.w }}>
                <div className="sys-big sys-t-name" title={c.full ?? undefined}>{c.title.map((l, i) => <div key={i}>{l}</div>)}</div>
                <div className="sys-body sys-t-phrase">{c.text.join(' ')}</div>
              </div>
            ))}
            {L.splits.map((s, i) => (
              <Fragment key={i}>
                <div className="sys-zsplit sys-t-phrase" style={{ left: s.x - 12, top: s.ty, transform: 'translateX(-100%)' }}>{s.left}</div>
                <div className="sys-zsplit sys-t-phrase" style={{ left: s.x + 12, top: s.ty }}>{s.right}</div>
              </Fragment>
            ))}
            {L.letters.map((m) => <NoteMark key={m.l} l={m.l} className="sys-letter sys-mk sys-t-phrase" style={{ left: m.x, top: m.y }} />)}
          </div>
        </div>
      </div>
    </NotesCtx.Provider>
  );
}

const Chevron = () => (
  <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden="true">
    <path d="M1.5 1.5L5 5L1.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Sheet = memo(SheetImpl);
