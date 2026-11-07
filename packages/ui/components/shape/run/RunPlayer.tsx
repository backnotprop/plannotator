// The run player: a board part that plays a run (`@plannotator/core/shape-run`)
// as flat swimlanes, time to scale. Two groupings of one scene, by lane and by
// resource, with one motion between them. Play, scrub, speed. SVG only: words
// stay sharp, colours come from the board's variables, and it costs nothing
// until a board has a run (ShapePlayers loads it lazily).
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ShapeRun } from '@plannotator/core/shape-run';
import {
  anchorOf,
  buildScene,
  ease,
  failsAtEnd,
  fitProjector,
  fmtTime,
  inFlight,
  mixWeights,
  momentText,
  niceStep,
  spanTone,
  spanY,
  SUB_STEP,
  toneVar,
  weightsOf,
  type RunMode,
  type Weights,
} from './scene';

const CSS = `
.srp { display: flex; flex-direction: column; width: 100%; color: var(--ink); font-size: calc(12.5px * var(--u)); line-height: 1.4; text-align: left; }
.srp.fill { height: 100%; min-height: 240px; }
.srp-stage { position: relative; flex: 1; min-height: 0; border-radius: calc(10px * var(--u)); background: color-mix(in oklab, var(--paper) 70%, var(--surface, var(--paper))); box-shadow: inset 0 0 0 calc(1px * var(--u)) var(--rule); overflow: hidden; }
.srp svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; }
.srp svg text { font-family: inherit; }
.srp .halo { paint-order: stroke; stroke: var(--paper); stroke-width: calc(3.5px * var(--u)); stroke-linejoin: round; }
.srp-bar { display: flex; align-items: center; gap: calc(8px * var(--u)) calc(10px * var(--u)); padding: calc(10px * var(--u)) calc(2px * var(--u)) 0; flex-wrap: wrap; }
.srp-scrub { display: flex; align-items: center; gap: calc(10px * var(--u)); flex: 1 1 calc(220px * var(--u)); min-width: 0; }
.srp button { appearance: none; font: inherit; color: var(--ink); background: transparent; border: 0; border-radius: calc(7px * var(--u)); padding: calc(5px * var(--u)) calc(9px * var(--u)); cursor: pointer; line-height: 1.2; min-height: calc(28px * var(--u)); }
.srp button:hover { background: var(--sunk); }
.srp button:focus-visible, .srp input:focus-visible { outline: calc(2px * var(--u)) solid var(--mark); outline-offset: calc(2px * var(--u)); }
.srp .play { width: calc(32px * var(--u)); height: calc(32px * var(--u)); padding: 0; display: grid; place-items: center; background: var(--mark); color: var(--primary-foreground, #fff); border-radius: 999px; flex: none; }
.srp .play:hover { background: color-mix(in oklab, var(--mark) 85%, var(--ink)); }
.srp .play svg { position: static; width: calc(14px * var(--u)); height: calc(14px * var(--u)); }
.srp input[type=range] { flex: 1 1 auto; min-width: calc(80px * var(--u)); accent-color: var(--mark); height: calc(24px * var(--u)); margin: 0; }
.srp .t { font-variant-numeric: tabular-nums; min-width: calc(56px * var(--u)); color: var(--ink2); font-family: var(--font-mono, ui-monospace, monospace); font-size: .92em; white-space: nowrap; }
.srp .seg { display: inline-flex; padding: calc(2px * var(--u)); border-radius: calc(9px * var(--u)); background: var(--sunk); gap: calc(2px * var(--u)); }
.srp .seg button[aria-pressed=true] { background: var(--paper); font-weight: 600; }
.srp-cap { margin: calc(8px * var(--u)) calc(2px * var(--u)) 0; color: var(--ink2); min-height: 2.9em; }
.srp-cap b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.srp-key { list-style: none; margin: calc(8px * var(--u)) 0 0; padding: 0; display: grid; gap: calc(5px * var(--u)); }
.srp-key li { display: flex; align-items: baseline; gap: calc(7px * var(--u)); transition: opacity .2s; }
.srp.reduce .srp-key li { transition: none; }
.srp-key .n { flex: none; display: inline-grid; place-items: center; width: calc(17px * var(--u)); height: calc(17px * var(--u)); border-radius: 999px; color: var(--paper); font-weight: 700; font-size: .78em; transform: translateY(calc(-1px * var(--u))); }
.srp-key .t { min-width: 3.6em; }
.srp-key .l { color: var(--grey); }
.srp-badge { position: absolute; top: calc(8px * var(--u)); right: calc(10px * var(--u)); font-size: .84em; padding: calc(2px * var(--u)) calc(8px * var(--u)); border-radius: 999px; color: var(--ink2); background: color-mix(in oklab, var(--amber) 16%, var(--paper)); pointer-events: none; }
.srp-src { margin: calc(4px * var(--u)) calc(2px * var(--u)) 0; color: var(--grey); font-size: .88em; }
.srp .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;

const SPEEDS = [0.5, 1, 2] as const;
/** At 1×, the whole run plays in this many seconds, whatever its unit. */
const PLAY_SECONDS = 9;

interface Label {
  key: string;
  x: number;
  y: number;
  text: string;
  size: number;
  anchor: 'start' | 'end' | 'middle';
  fill: string;
  opacity: number;
  weight: number;
  /** Stays where it is (row names, a state's words), and others keep clear of it. */
  pin: boolean;
  upOnly?: boolean;
  /** Dropped when there is no free line for it (span words, message words): its <title> still says it. */
  optional?: boolean;
}

export interface RunPlayerProps {
  run: ShapeRun;
  /** Reduced motion: no autoplay, it opens at the end, and the grouping changes in place. */
  reduce?: boolean;
  /** The first grouping. Default: the run's own `view`, else by lane. */
  mode?: RunMode;
  /** Open at this time, paused (pictures, tests). */
  at?: number;
}

export default function RunPlayer({ run, reduce = false, mode: firstMode, at }: RunPlayerProps) {
  const scene = useMemo(() => buildScene(run), [run]);
  const unit = run.unit ?? 'ms';
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, u: 1 });
  // Does the drawing give the player a height to fill? Otherwise it is as tall as its rows need.
  const [fill, setFill] = useState(false);
  const hasRes = (run.resources?.items.length ?? 0) > 0;
  const startMode: RunMode = firstMode ?? (hasRes ? (run.view ?? 'lanes') : 'lanes');
  const [mode, setModeState] = useState<RunMode>(startMode);
  const [now, setNow] = useState(at ?? (reduce ? scene.end : 0));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [, setTick] = useState(0);
  const [srLine, setSrLine] = useState('');
  const anim = useRef({
    w: weightsOf(startMode) as Weights,
    from: weightsOf(startMode) as Weights,
    to: weightsOf(startMode) as Weights,
    t0: 0,
    last: 0,
    raf: 0,
    autoplayed: at !== undefined || reduce,
  });
  const playingRef = useRef(false);
  const speedRef = useRef<number>(speed);
  speedRef.current = speed;

  // Size, and the board's scale: a board scales its canvas, so the player sizes its words and lines back up.
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
      setSize({ w: stage.clientWidth, h: stage.clientHeight, u: k > 0.05 ? 1 / k : 1 });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  const loop = useCallback(
    (ts: number) => {
      const a = anim.current;
      const dt = a.last ? Math.min(64, ts - a.last) : 16;
      a.last = ts;
      let more = false;
      if (a.t0) {
        const k = reduce ? 1 : Math.min(1, (ts - a.t0) / 500);
        a.w = mixWeights(a.from, a.to, ease(k));
        if (k < 1) more = true;
        else a.t0 = 0;
      }
      if (playingRef.current) {
        more = true;
        setNow((n) => {
          const next = n + (dt / 1000) * (scene.end / PLAY_SECONDS) * speedRef.current;
          if (next >= scene.end) {
            playingRef.current = false;
            setPlaying(false);
            return scene.end;
          }
          return next;
        });
      }
      setTick((x) => x + 1);
      a.raf = more ? requestAnimationFrame(loop) : 0;
      if (!a.raf) a.last = 0;
    },
    [reduce, scene.end],
  );
  const kick = useCallback(() => {
    if (!anim.current.raf) anim.current.raf = requestAnimationFrame(loop);
  }, [loop]);
  useEffect(() => () => cancelAnimationFrame(anim.current.raf), []);

  const setMode = (m: RunMode) => {
    const a = anim.current;
    setModeState(m);
    if (reduce) {
      a.w = a.from = a.to = weightsOf(m);
      a.t0 = 0;
      return;
    }
    a.from = a.w;
    a.to = weightsOf(m);
    a.t0 = performance.now();
    kick();
  };
  const play = (on: boolean) => {
    if (on && now >= scene.end - 1e-6) setNow(0);
    playingRef.current = on;
    setPlaying(on);
    if (on) kick();
    else setSrLine(momentText(run, now, unit));
  };

  // Play once when it first comes into view (never under reduced motion).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || anim.current.autoplayed || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !anim.current.autoplayed) {
          anim.current.autoplayed = true;
          playingRef.current = true;
          setPlaying(true);
          kick();
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(root);
    return () => io.disconnect();
  }, [kick]);

  // ── Draw ──
  const { w: W, h: H, u } = size;
  const wts = anim.current.w;
  // A narrow stage numbers its marks and lists them under the controls.
  const narrow = W > 0 && W / u < 600;
  // The label gutter fits the longest row name, so a phone never cuts one off ("producer b", "ch1 (cap 2)").
  const longest = Math.max(1, ...run.lanes.map((l) => l.label.length), ...(run.resources?.items ?? []).map((r) => r.label.length), (run.resources?.home ?? '').length);
  const padL = Math.min(W * 0.42, Math.max((narrow ? 56 : 96) * u, (longest * 7.2 + 26) * u));
  const pad = { l: padL, r: (narrow ? 14 : 28) * u, t: (narrow ? 44 : 34) * u, b: 34 * u };
  const P = W > 0 ? fitProjector(scene, wts, W, H, pad) : null;
  const markOrder = [...(run.marks ?? []).keys()].sort((a, b) => run.marks![a]!.at - run.marks![b]!.at);
  // Without a height from the drawing, the rows set it (the same in both groupings, so regrouping never jumps).
  const rowUnits = Math.max(...[scene.rowsL, scene.rowsR].map((rows) => rows.reduce((n, r) => n + 1 + (r.subs - 1) * SUB_STEP * 1.6, 0)));
  const stageHeight = fill ? undefined : Math.round((narrow ? Math.max(200, rowUnits * 34 + 90) : Math.min(680, Math.max(240, rowUnits * 50 + 90))) * u);
  const fs = 11.5 * u;
  const items: React.ReactNode[] = [];
  const top: React.ReactNode[] = [];
  const labels: Label[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => `M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`;

  if (P) {
    const X0 = P.x(0), X1 = P.x(scene.end);
    // Row lines and names.
    for (const [rows, wt, kind] of [[scene.rowsL, wts.lanes, 'L'], [scene.rowsR, wts.res, 'R']] as const) {
      if (wt < 0.01) continue;
      for (const r of rows) {
        const y = P.y(r.y - ((r.subs - 1) * SUB_STEP) / 2);
        items.push(<path key={`gr${kind}${r.key}`} d={line(X0, y, X1, y)} stroke="var(--rule)" strokeWidth={u} opacity={wt * 0.9} />);
        labels.push({ key: `rl${kind}${r.key}`, x: X0 - 12 * u, y: y + fs * 0.35, text: r.label, size: fs, anchor: 'end', fill: r.key.startsWith('res:') ? 'var(--alert)' : 'var(--ink2)', opacity: wt, weight: 400, pin: true });
      }
    }

    // The time axis.
    const step = niceStep(scene.end);
    const digits = step < 1 ? Math.min(3, Math.ceil(-Math.log10(step) + 1e-9)) : 0;
    for (let t = 0; t <= scene.end + 1e-6; t += step) {
      const x = P.x(t);
      items.push(<path key={`tg${t}`} d={line(x, P.top, x, P.bottom)} stroke="var(--rule)" strokeWidth={u} opacity={0.45} />);
      top.push(
        <text key={`tk${t}`} x={x} y={P.bottom + 20 * u} fontSize={fs * 0.9} textAnchor="middle" fill="var(--grey)">
          {digits ? +t.toFixed(digits) : Math.round(t)}
          {t === 0 ? ` ${unit}` : ''}
        </text>,
      );
    }

    // Limits: a dashed line across every row, named at its top.
    for (const lim of run.limits ?? []) {
      const x = P.x(lim.at);
      const col = toneVar(lim.tone ?? 'grey');
      items.push(<path key={`lim${lim.at}${lim.label}`} d={line(x, P.top - 6 * u, x, P.bottom)} stroke={col} strokeOpacity={0.75} strokeWidth={1.2 * u} strokeDasharray={`${5 * u} ${4 * u}`} />);
      labels.push({ key: `liml${lim.at}${lim.label}`, x, y: P.top - 12 * u, text: lim.label, size: fs * 0.92, anchor: 'middle', fill: col, opacity: 1, weight: 500, pin: false, upOnly: true });
    }

    // Spans: the part of each that has happened by now.
    for (const s of scene.spans) {
      const sp = s.span;
      if (now < sp.from) continue;
      const t1 = Math.max(Math.min(sp.to, now), sp.from + scene.end * 0.002);
      const y = P.y(spanY(s, wts));
      const x0 = P.x(sp.from), x1 = P.x(t1);
      const col = spanTone(sp);
      const state = !sp.lane;
      // No end: a wait, drawn thin.
      const wait = !state && !sp.end;
      const width = (state ? 16 : wait ? 2.2 : 7.5) * u;
      const dash = wait ? `${3 * u} ${3 * u}` : sp.end === 'cancelled' ? `${4 * u} ${3 * u}` : undefined;
      const done = now >= sp.to;
      const where = [s.laneLabel, s.resLabel].filter(Boolean).join(' on ');
      // Two states that touch on one row keep a seam between them.
      const g = state && x1 - x0 > 5 * u ? 1.2 * u : 0;
      // A failure's last stretch is red: the span was work until it failed.
      const failLen = failsAtEnd(sp) && done ? Math.min(14 * u, (x1 - x0) * 0.3) : 0;
      items.push(
        <g key={`s${s.i}`}>
          <title>{`${where}: ${sp.from}–${sp.to} ${unit}${sp.label ? `, ${sp.label}` : ''}${sp.end ? ` (${sp.end})` : ''}`}</title>
          <path d={line(x0 + g, y, x1 - g, y)} stroke={col} strokeWidth={width} strokeLinecap={state ? 'butt' : 'round'} strokeDasharray={dash} opacity={state ? 0.22 : sp.end === 'cancelled' ? 0.75 : 1} />
          {failLen > 0 && <path d={line(x1 - failLen, y, x1, y)} stroke="var(--alert)" strokeWidth={width} strokeLinecap="round" />}
          {!done && !state && !wait && <circle cx={x1} cy={y} r={width * 0.75} fill={col} />}
          {done && (sp.end === 'error' || sp.end === 'timeout') && (
            <path d={`M${x1 - 5 * u},${y - 5 * u}L${x1 + 5 * u},${y + 5 * u}M${x1 + 5 * u},${y - 5 * u}L${x1 - 5 * u},${y + 5 * u}`} stroke="var(--alert)" strokeWidth={2.2 * u} strokeLinecap="round" className="halo" />
          )}
          {done && sp.end === 'won' && <circle cx={x1} cy={y} r={5.5 * u} fill="var(--green)" stroke="var(--paper)" strokeWidth={1.5 * u} />}
          {done && sp.end === 'cancelled' && <path d={line(x1, y - 6 * u, x1, y + 6 * u)} stroke="var(--grey)" strokeWidth={2 * u} />}
        </g>,
      );
      // Its words: what the row does not already say. A mark at its start says it instead.
      const marked = (run.marks ?? []).some((m) => m.lane === sp.lane && Math.abs(m.at - sp.from) <= scene.end * 0.03);
      const words = state ? sp.label : marked ? undefined : [wts.res > 0.5 ? s.laneLabel : sp.on ? s.resLabel : undefined, sp.label].filter(Boolean).join(' · ');
      // A state's words that do not fit in its band are left out (its neighbours' words stay readable).
      const fits = !state || !words || words.length * fs * 0.86 * 0.56 <= x1 - x0 - 6 * u;
      if (words && fits) {
        const stateFill = sp.tone === 'alert' || sp.end === 'open' || sp.end === 'error' ? 'var(--alert)' : 'var(--ink)';
        labels.push({
          key: `sw${s.i}`,
          // A state's words sit in the middle of its band, so they belong to that band and not the next one.
          x: state ? (x0 + x1) / 2 : x0 + 2 * u,
          y: state ? y + fs * 0.35 : y - width / 2 - 4 * u,
          text: words,
          size: fs * 0.86,
          anchor: state ? 'middle' : 'start',
          fill: state ? stateFill : 'var(--ink2)',
          opacity: 1,
          weight: state ? 500 : 400,
          pin: state,
          optional: !state,
        });
      }
    }

    // Messages: from where the sender's work was, to the lane that took it. A send that waited slants
    // over its wait; while it is on its way the arrow grows and carries a dot.
    for (const [i, m] of (run.msgs ?? []).entries()) {
      if (now < m.at) continue;
      const a0 = anchorOf(scene, { lane: m.from, t: m.at }, wts, 'end');
      const arrive = m.arrive ?? m.at;
      const a1 = anchorOf(scene, { lane: m.to, t: arrive }, wts, 'start');
      const p = { x: P.x(a0.t), y: P.y(a0.y) }, qEnd = { x: P.x(a1.t), y: P.y(a1.y) };
      const k = arrive > m.at ? Math.min(1, (now - m.at) / (arrive - m.at)) : 1;
      const q = { x: p.x + (qEnd.x - p.x) * k, y: p.y + (qEnd.y - p.y) * k };
      const col = m.tone ? toneVar(m.tone) : 'var(--grey)';
      const ang = Math.atan2(qEnd.y - p.y, qEnd.x - p.x);
      const hl = 7 * u;
      const head = `M${q.x - hl * Math.cos(ang - 0.45)},${q.y - hl * Math.sin(ang - 0.45)}L${q.x},${q.y}L${q.x - hl * Math.cos(ang + 0.45)},${q.y - hl * Math.sin(ang + 0.45)}`;
      const name = (id: string) => run.lanes.find((l) => l.id === id)?.label ?? id;
      items.push(
        <g key={`m${i}`} opacity={m.tone ? 0.95 : 0.6}>
          <title>{`${name(m.from)} → ${name(m.to)}${m.label ? `: ${m.label}` : ''}, sent at ${m.at}${arrive > m.at ? `, taken at ${arrive} (waited ${+(arrive - m.at).toFixed(2)} ${unit})` : ''}`}</title>
          <path d={line(p.x, p.y, q.x, q.y)} stroke={col} strokeWidth={1.3 * u} strokeDasharray={m.tone === 'alert' ? `${3 * u} ${3 * u}` : undefined} fill="none" />
          {k < 1 ? <circle cx={q.x} cy={q.y} r={3.2 * u} fill={col} /> : <path d={head} stroke={col} strokeWidth={1.3 * u} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
        </g>,
      );
      if (m.label && k >= 1 && !narrow) {
        labels.push({ key: `ml${i}`, x: qEnd.x + 4 * u, y: qEnd.y + (qEnd.y >= p.y ? -5 : 13) * u, text: m.label, size: fs * 0.78, anchor: 'start', fill: 'var(--grey)', opacity: 1, weight: 300, pin: false, optional: true });
      }
    }

    // Marks: a dot where it happened, and its words (a number with a key below, on a narrow stage).
    for (const [i, mk] of (run.marks ?? []).entries()) {
      if (now < mk.at) continue;
      const a = anchorOf(scene, { lane: mk.lane, on: mk.lane ? undefined : mk.on, t: mk.at }, wts, 'start');
      const p = { x: P.x(a.t), y: P.y(a.y) };
      const col = toneVar(mk.tone ?? 'ink');
      const fresh = playing && !reduce && now - mk.at < scene.end * 0.05 ? 1 + (1 - (now - mk.at) / (scene.end * 0.05)) * 0.8 : 1;
      if (narrow) {
        const n = markOrder.indexOf(i) + 1;
        top.push(
          <g key={`k${i}`}>
            <circle cx={p.x} cy={p.y} r={7.5 * u * fresh} fill={col} stroke="var(--paper)" strokeWidth={1.5 * u} />
            <text x={p.x} y={p.y + 3.6 * u} fontSize={10 * u} fontWeight={700} textAnchor="middle" fill="var(--paper)">
              {n}
            </text>
          </g>,
        );
        continue;
      }
      items.push(<circle key={`k${i}`} cx={p.x} cy={p.y} r={4.2 * u * fresh} fill={col} stroke="var(--paper)" strokeWidth={1.5 * u} />);
      const text = mk.lane && wts.res > 0.5 ? `${run.lanes.find((l) => l.id === mk.lane)?.label}: ${mk.label}` : mk.label;
      const right = p.x + (text.length + 2) * fs * 0.56 > W - 12 * u;
      labels.push({ key: `kl${i}`, x: p.x + (right ? -9 : 9) * u, y: p.y - 9 * u, text, size: fs * 0.95, anchor: right ? 'end' : 'start', fill: col, opacity: 1, weight: 600, pin: false });
    }

    // The playhead.
    if (now > 0 && now < scene.end) {
      const x = P.x(now);
      items.push(<path key="now" d={line(x, P.top - 6 * u, x, P.bottom)} stroke="var(--mark)" strokeOpacity={0.6} strokeWidth={1.5 * u} />);
    }
  }

  // Words never sit on words: pinned words first where they belong, then each label takes the nearest free line, inside the stage.
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const order = (l: Label) => (l.pin ? 0 : 1000 - l.weight);
  for (const l of [...labels].filter((l) => l.opacity > 0.02).sort((a, b) => order(a) - order(b))) {
    const wdt = l.text.length * l.size * 0.56;
    let x = l.x, anchor = l.anchor;
    if (!l.pin) {
      if (anchor === 'start' && x + wdt > W - 4 * u) [x, anchor] = [W - 4 * u, 'end'];
      else if (anchor === 'end' && x - wdt < 4 * u) [x, anchor] = [4 * u, 'start'];
      else if (anchor === 'middle') x = Math.min(Math.max(x, wdt / 2 + 4 * u), W - wdt / 2 - 4 * u);
    }
    const x0 = anchor === 'end' ? x - wdt : anchor === 'middle' ? x - wdt / 2 : x;
    const hit = (y: number) => placed.some((b) => x0 < b.x1 && x0 + wdt > b.x0 && y - l.size < b.y1 && y + l.size * 0.25 > b.y0);
    let y = l.y;
    if (!l.pin) {
      // An optional word never drops below its line: there it would sit on its own bar.
      const tries = l.upOnly ? [0, -1, -2, 1] : l.optional ? [0, -1] : [0, -1, 1, -2, 2, -3, 3];
      let found = false;
      for (const dy of tries)
        if (!hit(l.y + dy * l.size * 1.15)) {
          y = l.y + dy * l.size * 1.15;
          found = true;
          break;
        }
      if (!found && l.optional) continue;
    }
    placed.push({ x0, x1: x0 + wdt, y0: y - l.size, y1: y + l.size * 0.25 });
    top.push(
      <text key={l.key} x={x} y={y} fontSize={l.size} fontWeight={l.weight} textAnchor={anchor} fill={l.fill} opacity={l.opacity} className="halo">
        {l.text}
      </text>,
    );
  }

  const caption = momentText(run, now, unit);
  const [capTime, ...capRest] = caption.split(' · ');
  const laneWord = run.laneLabel ?? 'lane';
  const views: [RunMode, string][] = hasRes ? [['lanes', `By ${laneWord}`], ['res', `By ${run.resources!.label}`]] : [];
  // A run written or simulated from code says so on the picture itself, not only in a footnote.
  const scenario = /^\s*(scenario|simulated)/i.test(run.source ?? '');
  const laneName = (id?: string) => (id ? run.lanes.find((l) => l.id === id)?.label : undefined);
  return (
    <div className={`srp${fill ? ' fill' : ''}${reduce ? ' reduce' : ''}`} ref={rootRef} style={{ ['--u' as string]: String(u) }} role="group" aria-label={`Run: ${run.title}`}>
      <style>{CSS}</style>
      <div ref={stageRef} className="srp-stage" style={stageHeight ? { flex: 'none', height: stageHeight } : undefined}>
        <svg viewBox={`0 0 ${Math.max(1, W)} ${Math.max(1, H)}`} role="img" aria-label={`${run.title}. ${caption}`}>
          {items}
          {top}
        </svg>
        {scenario && <span className="srp-badge">scenario · not a recorded trace</span>}
      </div>
      <div className="srp-bar">
        <div className="srp-scrub">
          <button type="button" className="play" onClick={() => play(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? (
              <svg viewBox="0 0 14 14" aria-hidden="true">
                <rect x="3" y="2" width="3" height="10" rx="1" fill="currentColor" />
                <rect x="8" y="2" width="3" height="10" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 14 14" aria-hidden="true">
                <path d="M4 2.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L4.9 1.7a.6.6 0 0 0-.9.5Z" fill="currentColor" />
              </svg>
            )}
          </button>
          <input
            type="range"
            min={0}
            max={scene.end}
            step={scene.end / 520}
            value={now}
            aria-label="Time"
            aria-valuetext={caption}
            onChange={(e) => {
              playingRef.current = false;
              setPlaying(false);
              setNow(Number(e.target.value));
            }}
            onPointerUp={() => setSrLine(momentText(run, now, unit))}
            onKeyUp={() => setSrLine(momentText(run, now, unit))}
          />
          <span className="t" aria-hidden="true">
            {fmtTime(now, unit)}
          </span>
        </div>
        <span className="seg" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)} aria-label={`${s === 0.5 ? 'Half' : s === 1 ? 'Normal' : 'Double'} speed`}>
              {s === 0.5 ? '½×' : `${s}×`}
            </button>
          ))}
        </span>
        {views.length > 0 && (
          <span className="seg" role="group" aria-label="Group by">
            {views.map(([m, label]) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {label}
              </button>
            ))}
          </span>
        )}
      </div>
      <p className="srp-cap">
        <b>{capTime}</b>
        {capRest.length ? ` · ${capRest.join(' · ')}` : ''}
      </p>
      {run.source && <p className="srp-src">{run.source}</p>}
      {narrow && markOrder.length > 0 && (
        <ol className="srp-key" aria-hidden="true">
          {markOrder.map((i, k) => {
            const m = run.marks![i]!;
            return (
              <li key={i} style={{ opacity: now >= m.at ? 1 : 0.45 }}>
                <span className="n" style={{ background: toneVar(m.tone ?? 'ink') }}>
                  {k + 1}
                </span>
                <span className="t">{fmtTime(m.at, unit)}</span>
                <span>
                  {m.label}
                  {m.lane ? <span className="l"> · {laneName(m.lane)}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="sr" aria-live="polite">
        {srLine}
      </div>
      <ol className="sr" aria-label="What happened">
        {markOrder.map((i) => {
          const m = run.marks![i]!;
          return <li key={i}>{`${fmtTime(m.at, unit)}: ${m.label}${m.lane ? ` (${laneName(m.lane)})` : ''}`}</li>;
        })}
      </ol>
    </div>
  );
}
