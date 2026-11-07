// The step player: a board part that plays a step-through
// (`@plannotator/core/shape-steps`) one state at a time, next to its code.
// The running line is lit and each step says one sentence. Back, step, play,
// scrub and speed. Three drawings: bars for an array, nodes and edges for a
// graph (a hash ring too), and labelled rows of boxes (buckets, a list, a
// cache). SVG and HTML only, colours from the board's variables; ShapePlayers
// loads it lazily, so a board with no step-through pays nothing.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ShapeStepFrame, ShapeStepRole, ShapeSteps } from '@plannotator/core/shape-steps';

const CSS = `
.ssp { display: grid; grid-template-columns: minmax(calc(250px * var(--u)), 38%) 1fr; grid-template-rows: 1fr auto auto auto; column-gap: calc(14px * var(--u)); width: 100%; color: var(--ink); font-size: calc(12.5px * var(--u)); line-height: 1.4; text-align: left; }
.ssp.fill { height: 100%; min-height: 260px; }
.ssp.narrow { grid-template-columns: 1fr; grid-template-rows: auto auto auto auto auto; height: auto; }
.ssp-code { grid-column: 1; grid-row: 1 / span 2; min-height: 0; overflow: auto; margin: 0; padding: calc(8px * var(--u)) 0; border-radius: calc(10px * var(--u)); background: var(--sunk); font-family: var(--font-mono, ui-monospace, monospace); font-size: .9em; line-height: 1.6; position: relative; }
.ssp.narrow .ssp-code { grid-column: 1; grid-row: 5; max-height: calc(9 * 1.6em + 16px * var(--u)); margin-top: calc(10px * var(--u)); }
.ssp-code ol { list-style: none; margin: 0; padding: 0; counter-reset: ln; }
.ssp-code li { display: flex; gap: calc(10px * var(--u)); padding: 0 calc(10px * var(--u)) 0 0; white-space: pre; transition: background .18s; }
.ssp-code li::before { counter-increment: ln; content: counter(ln); flex: none; width: 2.4em; text-align: right; color: var(--grey); opacity: .7; }
.ssp-code li[aria-current=step] { background: color-mix(in oklab, var(--mark) 16%, transparent); }
.ssp-code li[aria-current=step]::before { color: var(--mark); opacity: 1; font-weight: 700; }
.ssp-code .cm { color: var(--grey); }
.ssp-code .kw { color: var(--mark); }
.ssp-stage { grid-column: 2; grid-row: 1; position: relative; min-height: 0; border-radius: calc(10px * var(--u)); background: color-mix(in oklab, var(--paper) 70%, var(--surface, var(--paper))); box-shadow: inset 0 0 0 calc(1px * var(--u)) var(--rule); overflow: hidden; }
.ssp.narrow .ssp-stage { grid-column: 1; grid-row: 1; }
.ssp svg.draw { position: absolute; inset: 0; width: 100%; height: 100%; }
.ssp svg text { font-family: inherit; }
.ssp .halo { paint-order: stroke; stroke: var(--paper); stroke-width: calc(3.5px * var(--u)); stroke-linejoin: round; }
.ssp .mono { font-family: var(--font-mono, ui-monospace, monospace); }
.ssp .bar { transition: y .22s ease, height .22s ease, fill .18s; }
.ssp .node, .ssp .edge { transition: fill .18s, stroke .18s, stroke-width .18s, opacity .18s; }
.ssp.reduce .bar, .ssp.reduce .node, .ssp.reduce .edge, .ssp.reduce .ssp-code li { transition: none; }
.ssp-side { grid-column: 2; grid-row: 2; display: flex; flex-wrap: wrap; gap: calc(6px * var(--u)) calc(14px * var(--u)); align-items: center; padding-top: calc(8px * var(--u)); color: var(--ink2); }
.ssp.narrow .ssp-side { grid-column: 1; grid-row: 2; }
.ssp-legend { display: flex; flex-wrap: wrap; gap: calc(4px * var(--u)) calc(12px * var(--u)); color: var(--grey); font-size: .92em; }
.ssp-legend i { display: inline-block; width: calc(10px * var(--u)); height: calc(10px * var(--u)); border-radius: calc(3px * var(--u)); margin-right: calc(5px * var(--u)); vertical-align: -1px; }
.ssp-vars { display: flex; flex-wrap: wrap; gap: calc(6px * var(--u)); margin-left: auto; }
.ssp-vars span { font-family: var(--font-mono, ui-monospace, monospace); font-size: .9em; padding: calc(1px * var(--u)) calc(7px * var(--u)); border-radius: 999px; background: var(--sunk); color: var(--ink); white-space: nowrap; }
.ssp-vars span b { color: var(--grey); font-weight: 400; margin-right: .4em; }
.ssp-queue { position: absolute; left: calc(10px * var(--u)); right: calc(10px * var(--u)); bottom: calc(8px * var(--u)); display: flex; gap: calc(5px * var(--u)); align-items: center; flex-wrap: wrap; font-size: .92em; }
.ssp-queue > b { color: var(--grey); font-weight: 500; margin-right: calc(2px * var(--u)); }
.ssp-queue span { font-family: var(--font-mono, ui-monospace, monospace); padding: calc(1px * var(--u)) calc(7px * var(--u)); border-radius: calc(6px * var(--u)); background: var(--paper); box-shadow: inset 0 0 0 calc(1px * var(--u)) var(--amber); }
.ssp-queue span:first-of-type { background: color-mix(in oklab, var(--amber) 22%, var(--paper)); }
.ssp-cap { grid-column: 1 / -1; grid-row: 3; margin: calc(10px * var(--u)) calc(2px * var(--u)) 0; min-height: 2.9em; line-height: 1.45; color: var(--ink); }
.ssp.narrow .ssp-cap { grid-row: 3; }
.ssp-cap b { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink2); margin-right: .5em; }
.ssp-bar { grid-column: 1 / -1; grid-row: 4; display: flex; align-items: center; gap: calc(8px * var(--u)); padding-top: calc(8px * var(--u)); flex-wrap: wrap; }
.ssp button { appearance: none; font: inherit; color: var(--ink); background: transparent; border: 0; border-radius: calc(7px * var(--u)); padding: calc(5px * var(--u)) calc(9px * var(--u)); cursor: pointer; line-height: 1.2; min-height: calc(28px * var(--u)); }
.ssp button:hover:not(:disabled) { background: var(--sunk); }
.ssp button:disabled { opacity: .4; cursor: default; }
.ssp button:focus-visible, .ssp input:focus-visible, .ssp-code:focus-visible { outline: calc(2px * var(--u)) solid var(--mark); outline-offset: calc(2px * var(--u)); }
.ssp .icon { width: calc(32px * var(--u)); height: calc(32px * var(--u)); padding: 0; display: grid; place-items: center; flex: none; }
.ssp .icon svg { width: calc(14px * var(--u)); height: calc(14px * var(--u)); }
.ssp .play { background: var(--mark); color: var(--primary-foreground, #fff); border-radius: 999px; }
.ssp .play:hover:not(:disabled) { background: color-mix(in oklab, var(--mark) 85%, var(--ink)); }
.ssp input[type=range] { flex: 1 1 calc(140px * var(--u)); min-width: calc(90px * var(--u)); accent-color: var(--mark); height: calc(24px * var(--u)); margin: 0; }
.ssp .n { font-variant-numeric: tabular-nums; color: var(--ink2); font-family: var(--font-mono, ui-monospace, monospace); font-size: .92em; min-width: 4.2em; }
.ssp .seg { display: inline-flex; padding: calc(2px * var(--u)); border-radius: calc(9px * var(--u)); background: var(--sunk); gap: calc(2px * var(--u)); }
.ssp .seg button[aria-pressed=true] { background: var(--paper); font-weight: 600; }
.ssp-rows { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: calc(12px * var(--u)) calc(14px * var(--u)); gap: var(--gap); overflow: hidden; }
.ssp-rows.has-queue { padding-bottom: calc(44px * var(--u)); }
.ssp-row { display: flex; align-items: center; gap: calc(6px * var(--u)); min-height: var(--rh); padding: 0 calc(6px * var(--u)); border-radius: calc(8px * var(--u)); transition: background .18s; }
.ssp-row > b { flex: none; min-width: var(--lw); text-align: right; font-family: var(--font-mono, ui-monospace, monospace); font-weight: 500; font-size: .9em; color: var(--grey); padding-right: calc(4px * var(--u)); }
.ssp-row[data-role] > b { color: var(--ink); font-weight: 700; }
.ssp-row .box { flex: none; min-width: calc(2.4em); padding: calc(3px * var(--u)) calc(8px * var(--u)); border-radius: calc(6px * var(--u)); font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--bf); text-align: center; background: var(--paper); box-shadow: inset 0 0 0 calc(1.3px * var(--u)) color-mix(in oklab, var(--ink) 30%, var(--paper)); color: var(--ink); white-space: nowrap; transition: background .18s, box-shadow .18s, color .18s, opacity .18s; }
.ssp-row .box.filled { color: var(--paper); font-weight: 700; box-shadow: none; }
.ssp-row .box.wait { box-shadow: inset 0 0 0 calc(2.4px * var(--u)) var(--amber); }
.ssp-row .box.off { opacity: .4; }
.ssp-row .join { flex: none; color: var(--grey); font-size: .9em; }
.ssp-row .none { color: var(--grey); opacity: .6; font-size: .9em; }
.ssp.reduce .ssp-row, .ssp.reduce .box { transition: none; }
.ssp .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;

const SPEEDS = [0.5, 1, 2] as const;
/** At 1×, a step lasts this long. */
const STEP_MS = 1100;

/** The order a role wins in when an item has several. */
const ROLE_ORDER: ShapeStepRole[] = ['now', 'moved', 'look', 'done', 'wait', 'off'];
const ROLE_FILL: Record<ShapeStepRole, string> = {
  now: 'var(--mark, #5b5bd6)',
  moved: 'var(--alert, #d33)',
  look: 'var(--amber, #b87a12)',
  done: 'var(--green, #2b8a57)',
  wait: 'var(--paper, #fff)',
  off: 'color-mix(in oklab, var(--ink) 12%, var(--paper))',
};
const ROLE_WORD: Record<ShapeStepRole, string> = { now: 'acting', moved: 'just changed', look: 'looking at', done: 'settled', wait: 'waiting', off: 'out of play' };
const BASE_FILL = 'color-mix(in oklab, var(--ink) 20%, var(--paper))';

function roleOf<T>(byRole: Partial<Record<ShapeStepRole, T[]>> | undefined, item: T, eq: (a: T, b: T) => boolean = Object.is): ShapeStepRole | undefined {
  if (!byRole) return undefined;
  return ROLE_ORDER.find((r) => byRole[r]?.some((x) => eq(x, item)));
}

const KW = /\b(func|for|range|if|else|return|continue|break|def|in|while|let|const|var|go|select|case)\b/g;
function codeLine(line: string, lang?: string): React.ReactNode {
  const cmAt = lang === 'python' ? line.indexOf('#') : line.indexOf('//');
  const body = cmAt >= 0 ? line.slice(0, cmAt) : line;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(KW)) {
    if (m.index! > last) parts.push(body.slice(last, m.index));
    parts.push(<span key={m.index} className="kw">{m[0]}</span>);
    last = m.index! + m[0].length;
  }
  parts.push(body.slice(last));
  if (cmAt >= 0) parts.push(<span key="cm" className="cm">{line.slice(cmAt)}</span>);
  return parts;
}

export interface StepPlayerProps {
  steps: ShapeSteps;
  /** Reduced motion: no tweens; each step is drawn in place. */
  reduce?: boolean;
  /** Open at this step, from 0 (pictures, tests). */
  at?: number;
}

export default function StepPlayer({ steps, reduce = false, at }: StepPlayerProps) {
  const frames = steps.frames;
  const last = frames.length - 1;
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, u: 1, rw: 0 });
  const [idx, setIdx] = useState(Math.max(0, Math.min(last, at ?? 0)));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  // Does the drawing give the player a height to fill? Otherwise the stage takes a height of its own.
  const [fill, setFill] = useState(false);
  const [srLine, setSrLine] = useState('');
  const frame = frames[idx]!;

  useLayoutEffect(() => {
    const root = rootRef.current, stage = stageRef.current;
    if (!root || !stage) return;
    const slot = root.parentElement;
    if (slot) {
      root.style.display = 'none';
      setFill(slot.clientHeight >= 200);
      root.style.display = '';
    }
    const measure = () => {
      const k = root.offsetWidth ? root.getBoundingClientRect().width / root.offsetWidth : 1;
      setSize({ w: stage.clientWidth, h: stage.clientHeight, u: k > 0.05 ? 1 / k : 1, rw: root.clientWidth });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);
  const { w: W, h: H, u } = size;
  const narrow = size.rw > 0 && size.rw / u < 640;
  // A narrow player is as tall as it needs.
  useLayoutEffect(() => {
    const slot = rootRef.current?.parentElement;
    if (!slot || !narrow || !fill) return;
    const was = slot.style.height;
    slot.style.height = 'auto';
    return () => {
      slot.style.height = was;
    };
  }, [narrow, fill]);

  // Play: a step every STEP_MS / speed, stopping at the last.
  useEffect(() => {
    if (!playing) return;
    if (idx >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIdx((i) => Math.min(last, i + 1)), STEP_MS / speed);
    return () => clearTimeout(t);
  }, [playing, idx, speed, last]);

  // Keep the lit line in view, inside the code pane only (the page never scrolls).
  useEffect(() => {
    const pane = codeRef.current;
    const li = pane?.querySelector<HTMLElement>('li[aria-current=step]');
    if (!pane || !li) return;
    const top = li.offsetTop, bottom = top + li.offsetHeight;
    if (top < pane.scrollTop + 8 || bottom > pane.scrollTop + pane.clientHeight - 8) pane.scrollTop = Math.max(0, top - pane.clientHeight / 2 + li.offsetHeight / 2);
  }, [idx, narrow]);

  const say = (i: number) => `Step ${i + 1} of ${frames.length}, line ${frames[i]!.line}: ${frames[i]!.say}`;
  const go = (i: number) => {
    const n = Math.max(0, Math.min(last, i));
    setIdx(n);
    setSrLine(say(n));
  };
  const play = (on: boolean) => {
    if (on && idx >= last) setIdx(0);
    setPlaying(on);
    if (!on) setSrLine(say(idx));
  };

  const roles = useMemo(() => {
    const used = new Set<ShapeStepRole>();
    for (const f of frames) {
      for (const g of [f.cells, f.nodes, f.edges]) if (g) for (const [r, l] of Object.entries(g)) if ((l as unknown[] | undefined)?.length) used.add(r as ShapeStepRole);
      for (const row of f.rows ?? []) {
        if (row.role) used.add(row.role);
        for (const r of row.roles ?? []) if (r) used.add(r);
      }
    }
    return ROLE_ORDER.filter((r) => used.has(r));
  }, [frames]);

  const maxRows = steps.show === 'rows' ? Math.max(1, ...frames.map((f) => f.rows?.length ?? 0)) : 0;
  const hasQueue = frames.some((f) => f.queue);
  // On a phone, or with no height from the drawing, the stage has its own height (the same on every step).
  const stageH =
    narrow || !fill
      ? (steps.show === 'array' ? (narrow ? 230 : 300) : steps.show === 'rows' ? Math.min(narrow ? 420 : 460, 28 + maxRows * (narrow ? 34 : 40) + (hasQueue ? 40 : 0)) : narrow ? 300 : 380) * u
      : undefined;
  const vars = Object.entries(frame.vars ?? {});

  return (
    <div className={`ssp${narrow ? ' narrow' : ''}${fill && !narrow ? ' fill' : ''}${reduce ? ' reduce' : ''}`} ref={rootRef} style={{ ['--u' as string]: String(u) }} role="group" aria-label={`Step-through: ${steps.title}`}>
      <style>{CSS}</style>
      <div className="ssp-code" ref={codeRef} role="region" aria-label="Code" tabIndex={0}>
        <ol>
          {steps.code.lines.map((l, i) => (
            <li key={i} aria-current={frame.line === i + 1 ? 'step' : undefined}>
              <span>{codeLine(l, steps.code.lang)}</span>
            </li>
          ))}
        </ol>
      </div>
      <div ref={stageRef} className="ssp-stage" style={stageH ? { height: stageH } : undefined}>
        {W > 0 && steps.show === 'array' && <ArrayView steps={steps} frame={frame} W={W} H={H} u={u} />}
        {W > 0 && steps.show === 'graph' && <GraphView steps={steps} frame={frame} W={W} H={H} u={u} narrow={narrow} />}
        {W > 0 && steps.show === 'rows' && <RowsView steps={steps} frame={frame} H={H} u={u} maxRows={maxRows} />}
        {frame.queue && (
          <div className="ssp-queue" aria-label={`${steps.queueLabel ?? 'queue'}: ${frame.queue.join(', ') || 'empty'}`}>
            <b>{steps.queueLabel ?? 'queue'}</b>
            {frame.queue.length ? frame.queue.map((q, i) => <span key={i}>{q}</span>) : <em style={{ color: 'var(--grey)' }}>empty</em>}
          </div>
        )}
      </div>
      <div className="ssp-side">
        {roles.length > 0 && (
          <span className="ssp-legend" aria-hidden="true">
            {roles.map((r) => (
              <span key={r}>
                <i style={{ background: ROLE_FILL[r], boxShadow: r === 'wait' ? 'inset 0 0 0 2px var(--amber)' : undefined }} />
                {ROLE_WORD[r]}
              </span>
            ))}
          </span>
        )}
        {vars.length > 0 && (
          <span className="ssp-vars">
            {vars.map(([k, v]) => (
              <span key={k}>
                <b>{k}</b>
                {v === null ? '∞' : String(v)}
              </span>
            ))}
          </span>
        )}
      </div>
      <p className="ssp-cap">
        <b>
          {idx + 1}/{frames.length}
        </b>
        {frame.say}
      </p>
      <div className="ssp-bar">
        <button type="button" className="icon" onClick={() => (setPlaying(false), go(idx - 1))} disabled={idx === 0} aria-label="Back one step">
          <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 2v10M11.5 2.6v8.8a.5.5 0 0 1-.8.4L5 7.4a.5.5 0 0 1 0-.8l5.7-4.4a.5.5 0 0 1 .8.4Z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button type="button" className="icon play" onClick={() => play(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? (
            <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="3" y="2" width="3" height="10" rx="1" fill="currentColor" /><rect x="8" y="2" width="3" height="10" rx="1" fill="currentColor" /></svg>
          ) : (
            <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M4 2.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L4.9 1.7a.6.6 0 0 0-.9.5Z" fill="currentColor" /></svg>
          )}
        </button>
        <button type="button" className="icon" onClick={() => (setPlaying(false), go(idx + 1))} disabled={idx === last} aria-label="Next step">
          <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M11 2v10M2.5 2.6v8.8a.5.5 0 0 0 .8.4L9 7.4a.5.5 0 0 0 0-.8L3.3 2.2a.5.5 0 0 0-.8.4Z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <input type="range" min={0} max={last} step={1} value={idx} aria-label="Step" aria-valuetext={say(idx)} onChange={(e) => (setPlaying(false), go(Number(e.target.value)))} />
        <span className="n" aria-hidden="true">
          {idx + 1} / {frames.length}
        </span>
        <span className="seg" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)} aria-label={`${s === 0.5 ? 'Half' : s === 1 ? 'Normal' : 'Double'} speed`}>
              {s === 0.5 ? '½×' : `${s}×`}
            </button>
          ))}
        </span>
      </div>
      <div className="sr" aria-live="polite">{srLine}</div>
    </div>
  );
}

// ───────────────────────── array: bars ─────────────────────────

function ArrayView({ steps, frame, W, H, u }: { steps: ShapeSteps; frame: ShapeStepFrame; W: number; H: number; u: number }) {
  const { max, n, edge } = useMemo(() => {
    let max = 0, n = 0, edge = false;
    for (const f of steps.frames) {
      for (const v of f.array ?? []) max = Math.max(max, Math.abs(v));
      n = Math.max(n, f.array?.length ?? 0);
      for (const p of Object.values(f.ptr ?? {})) if (p < 0 || p >= (f.array?.length ?? 0)) edge = true;
    }
    return { max: max || 1, n, edge };
  }, [steps]);
  const a = frame.array ?? [];
  const slots = n + (edge ? 1.4 : 0);
  const pad = 14 * u;
  const bw = (W - 2 * pad) / slots;
  const x0 = pad + (edge ? bw * 0.7 : 0);
  const ptrRows = Math.max(1, ...Object.values(groupBy(frame.ptr ?? {})).map((l) => l.length));
  const bottom = H - (18 + ptrRows * 17 + 6) * u;
  const top = 26 * u;
  const fs = Math.max(10 * u, Math.min(15 * u, bw * 0.36));
  return (
    <svg className="draw" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Array: ${a.join(', ')}`}>
      {a.map((v, i) => {
        const role = roleOf(frame.cells, i);
        const h = Math.max(2 * u, (Math.abs(v) / max) * (bottom - top));
        const x = x0 + i * bw + bw * 0.1;
        const fill = role ? ROLE_FILL[role] : BASE_FILL;
        return (
          <g key={i} opacity={role === 'off' ? 0.45 : 1}>
            <rect className="bar" x={x} width={bw * 0.8} style={{ y: bottom - h, height: h, fill } as React.CSSProperties} rx={3 * u} stroke={role === 'wait' ? 'var(--amber)' : 'none'} strokeWidth={2 * u} />
            <text x={x + bw * 0.4} y={bottom - h - 6 * u} fontSize={fs} textAnchor="middle" fill="var(--ink)" fontWeight={role && role !== 'off' ? 700 : 500} className="mono" style={{ transition: 'y .22s' }}>
              {v}
            </text>
            <text x={x + bw * 0.4} y={bottom + 14 * u} fontSize={10 * u} textAnchor="middle" fill="var(--grey)" className="mono">
              {i}
            </text>
          </g>
        );
      })}
      <line x1={x0} x2={x0 + n * bw} y1={bottom} y2={bottom} stroke="var(--rule)" strokeWidth={u} />
      {Object.entries(groupBy(frame.ptr ?? {})).map(([at, names]) =>
        names.map((name, k) => {
          const x = x0 + Number(at) * bw + bw / 2;
          const y = bottom + (30 + k * 17) * u;
          return (
            <g key={name}>
              {k === 0 && <path d={`M${x},${bottom + 19 * u}l${-4.5 * u},${6 * u}h${9 * u}z`} fill="var(--mark)" />}
              <text x={x} y={y + 6 * u} fontSize={11.5 * u} textAnchor="middle" fill="var(--mark)" fontWeight={700} className="mono">
                {name}
              </text>
            </g>
          );
        }),
      )}
    </svg>
  );
}

function groupBy(ptr: Record<string, number>): Record<string, string[]> {
  const g: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(ptr)) (g[v] ??= []).push(k);
  return g;
}

// ───────────────────────── graph: nodes and edges ─────────────────────────

function GraphView({ steps, frame, W, H, u, narrow }: { steps: ShapeSteps; frame: ShapeStepFrame; W: number; H: number; u: number; narrow: boolean }) {
  const g = steps.graph!;
  const r = (narrow ? 13 : 16) * u;
  const padX = r + 22 * u, padT = r + 18 * u, padB = r + (frame.queue || steps.frames.some((f) => f.queue) ? 44 : 18) * u;
  // A ring keeps its circle round: one scale for x and y, centred.
  // Words beside small dots need room outside the ring, more of it on a phone.
  const wordRoom = g.ring && g.nodes.some((n) => n.small) ? (narrow ? 58 : 70) * u : 0;
  const ringS = Math.max(0.2, Math.min(W - 2 * padX - 2 * wordRoom, H - padT - padB - wordRoom * 0.6) / 100);
  const ringO = { x: (W - 100 * ringS) / 2, y: padT + (H - padT - padB - 100 * ringS) / 2 };
  const pos = new Map(
    g.nodes.map((n) => [n.id, g.ring ? { x: ringO.x + n.x * ringS, y: ringO.y + n.y * ringS } : { x: padX + (n.x / 100) * (W - 2 * padX), y: padT + (n.y / 100) * (H - padT - padB) }]),
  );
  const big = g.nodes.filter((n) => !n.small);
  const ringR = g.ring ? ((big.length ? big : g.nodes).reduce((a, n) => a + Math.hypot(n.x - 50, n.y - 50), 0) / Math.max(1, (big.length ? big : g.nodes).length)) * ringS : 0;
  const ringC = { x: ringO.x + 50 * ringS, y: ringO.y + 50 * ringS };
  const sameEdge = (a: [string, string], b: [string, string]) => (a[0] === b[0] && a[1] === b[1]) || (!g.directed && a[0] === b[1] && a[1] === b[0]);
  const edgeStyle = (role?: ShapeStepRole) =>
    role === 'look' ? { stroke: 'var(--amber)', w: 4 } : role === 'done' ? { stroke: 'var(--green)', w: 3.6 } : role === 'now' ? { stroke: 'var(--mark)', w: 4 } : role === 'moved' ? { stroke: 'var(--alert)', w: 4 } : { stroke: 'color-mix(in oklab, var(--ink) 32%, var(--paper))', w: 1.6 };
  const fs = 12.5 * u;
  return (
    <svg className="draw" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Graph. ${frame.say}`}>
      <defs>
        <marker id="ssp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0L10,5L0,10z" fill="context-stroke" />
        </marker>
      </defs>
      {g.ring && <circle cx={ringC.x} cy={ringC.y} r={ringR} fill="none" stroke="color-mix(in oklab, var(--ink) 28%, var(--paper))" strokeWidth={2 * u} />}
      {/* Plain edges first, lit edges on top. */}
      {[...g.edges]
        .map((e) => ({ e, role: roleOf(frame.edges, [e.from, e.to] as [string, string], sameEdge) }))
        .sort((x, y) => (x.role ? 1 : 0) - (y.role ? 1 : 0))
        .map(({ e, role }) => {
          const p = pos.get(e.from)!, q = pos.get(e.to)!;
          const st = edgeStyle(role);
          const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
          const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
          const a = { x: p.x + ux * r, y: p.y + uy * r }, b = { x: q.x - ux * (r + (g.directed ? 3 * u : 0)), y: q.y - uy * (r + (g.directed ? 3 * u : 0)) };
          const mx = (p.x + q.x) / 2 - uy * 11 * u, my = (p.y + q.y) / 2 + ux * 11 * u;
          return (
            <g key={`${e.from}-${e.to}`} opacity={role === 'off' ? 0.3 : 1}>
              <line className="edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={st.stroke} strokeWidth={st.w * u} strokeLinecap="round" markerEnd={g.directed ? 'url(#ssp-arrow)' : undefined} />
              {e.w !== undefined && (
                <text x={mx} y={my + 4 * u} fontSize={fs * 0.92} textAnchor="middle" fill={role && role !== 'off' ? st.stroke : 'var(--ink2)'} fontWeight={role && role !== 'off' ? 700 : 500} className="halo mono">
                  {e.w}
                </text>
              )}
            </g>
          );
        })}
      {g.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const role = roleOf(frame.nodes, n.id);
        const filled = role && role !== 'wait' && role !== 'off';
        const tag = frame.tags && n.id in frame.tags ? frame.tags[n.id] : undefined;
        if (n.small) {
          // A small dot: its words sit beside it, pushed away from the ring's centre (or to the right).
          const dx = g.ring ? p.x - ringC.x : 1, dy = g.ring ? p.y - ringC.y : 0;
          const len = Math.hypot(dx, dy) || 1;
          const ox = (dx / len) * 12 * u, oy = (dy / len) * 12 * u;
          const words = tag === undefined ? n.label ?? n.id : `${n.label ?? n.id} → ${tag === null ? '∞' : tag}`;
          const sr = 5.5 * u;
          return (
            <g key={n.id} opacity={role === 'off' ? 0.4 : 1}>
              <circle className="node" cx={p.x} cy={p.y} r={sr} fill={filled ? ROLE_FILL[role] : 'var(--paper)'} stroke={role === 'wait' ? 'var(--amber)' : filled ? 'var(--paper)' : 'var(--ink)'} strokeWidth={(role === 'wait' ? 2.2 : 1.6) * u} />
              <text x={p.x + ox} y={p.y + oy + fs * 0.3} fontSize={fs * 0.86} textAnchor={Math.abs(dx / len) < 0.3 ? 'middle' : dx > 0 ? 'start' : 'end'} fontWeight={role && role !== 'off' ? 700 : 500} fill={role === 'moved' ? 'var(--alert)' : 'var(--ink)'} className="halo mono">
                {words}
              </text>
            </g>
          );
        }
        return (
          <g key={n.id} opacity={role === 'off' ? 0.4 : 1}>
            {role === 'now' && <circle cx={p.x} cy={p.y} r={r + 5 * u} fill="none" stroke="var(--mark)" strokeOpacity={0.35} strokeWidth={3 * u} />}
            <circle className="node" cx={p.x} cy={p.y} r={r} fill={filled ? ROLE_FILL[role] : 'var(--paper)'} stroke={role === 'wait' ? 'var(--amber)' : filled ? ROLE_FILL[role] : 'var(--ink)'} strokeWidth={(role === 'wait' ? 2.6 : 1.5) * u} />
            <text x={p.x} y={p.y + fs * 0.36} fontSize={fs} textAnchor="middle" fontWeight={700} fill={filled ? 'var(--paper)' : 'var(--ink)'}>
              {n.label ?? n.id}
            </text>
            {tag !== undefined && (
              <text x={p.x + r * 0.8} y={p.y - r - 4 * u} fontSize={fs * 0.95} textAnchor="start" fontWeight={role === 'moved' ? 800 : 600} fill={role === 'moved' ? 'var(--alert)' : tag === null ? 'var(--grey)' : 'var(--ink)'} className="halo mono">
                {tag === null ? '∞' : tag}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ───────────────────────── rows: buckets, lists, caches ─────────────────────────

const ROW_TINT: Partial<Record<ShapeStepRole, string>> = {
  look: 'color-mix(in oklab, var(--amber) 16%, transparent)',
  now: 'color-mix(in oklab, var(--mark) 13%, transparent)',
  moved: 'color-mix(in oklab, var(--alert) 12%, transparent)',
  done: 'color-mix(in oklab, var(--green) 13%, transparent)',
  wait: 'color-mix(in oklab, var(--amber) 9%, transparent)',
};

function RowsView({ steps, frame, H, u, maxRows }: { steps: ShapeSteps; frame: ShapeStepFrame; H: number; u: number; maxRows: number }) {
  const rows = frame.rows ?? [];
  const hasQueue = steps.frames.some((f) => f.queue);
  // Every frame uses the same row height and label width, so stepping never makes the layout jump.
  const avail = H - (hasQueue ? 56 : 24) * u;
  const gap = Math.max(2, Math.min(8 * u, avail / maxRows / 6));
  const rh = Math.max(18, Math.min(36 * u, avail / maxRows - gap));
  const lw = Math.max(...steps.frames.flatMap((f) => (f.rows ?? []).map((r) => r.label.length)), 1);
  const bf = `${Math.max(10, Math.min(13.5 * u, rh * 0.42))}px`;
  const joined = (row: { join?: 'arrow' | 'none' }) => (row.join ?? steps.rowsJoin) === 'arrow';
  return (
    <div className={`ssp-rows${hasQueue ? ' has-queue' : ''}`} style={{ ['--rh' as string]: `${rh}px`, ['--gap' as string]: `${gap}px`, ['--lw' as string]: `${lw * 0.62 + 0.6}em`, ['--bf' as string]: bf }} role="img" aria-label={rows.map((r) => `${r.label}: ${r.items.join(joined(r) ? ' → ' : ', ') || 'empty'}`).join('; ')}>
      {rows.map((row, i) => { const arrow = joined(row); return (
        <div key={i} className="ssp-row" data-role={row.role} style={{ background: row.role ? ROW_TINT[row.role] : undefined, opacity: row.role === 'off' ? 0.45 : 1 }}>
          <b>{row.label}</b>
          {row.items.length === 0 && <span className="none">{arrow ? '∅' : '·'}</span>}
          {row.items.map((it, k) => {
            const role = row.roles?.[k] ?? undefined;
            const filled = role && role !== 'wait' && role !== 'off';
            return (
              <React.Fragment key={k}>
                {arrow && k > 0 && <span className="join" aria-hidden="true">→</span>}
                <span className={`box${filled ? ' filled' : ''}${role === 'wait' ? ' wait' : ''}${role === 'off' ? ' off' : ''}`} style={filled ? { background: ROLE_FILL[role] } : undefined}>
                  {it}
                </span>
              </React.Fragment>
            );
          })}
        </div>
      ); })}
    </div>
  );
}
