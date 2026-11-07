// The scene player: plays a scene the agent drew (`@plannotator/core/shape-scene`).
// The drawing is the agent's own SVG in the slot, above this player; this
// player adds the caption, the code line, a colour key and the controls under
// it, and moves the drawing's `data-part` pieces through `SceneDom`.
// Play, drag through time, ½× 1× 2×, Back and Next between beats. Under
// reduced motion nothing moves by itself or between beats: it opens at the
// first beat, and Play and Next show one beat at a time, each drawn in place.
// No other controls (no swimlanes, bars or step-through views: a ready-made
// view would bias the drawing), no Tailwind classes, and no keyboard shortcut
// (the slider's arrow keys are the browser's own).
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ShapeScene } from '@plannotator/core/shape-scene';
import { SceneDom } from './dom';
import { beatAt, clockWords, nextBeatTime, playMs, reducedTime } from './timeline';
import { fitScene, scrollerOf } from './fit';
import { LIT_TECHNICAL, LOOK_CSS, applyTechnicalLook } from './look';

const CSS = `
.ssc { display: block; width: 100%; color: var(--ink); font-size: calc(12.5px * var(--u)); line-height: 1.4; text-align: left; margin-top: calc(8px * var(--u)); }
.ssc-cap { margin: 0 calc(2px * var(--u)); min-height: 2.9em; line-height: 1.45; color: var(--ink); }
.ssc-cap b { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink2); margin-right: .5em; }
.ssc-side { display: flex; flex-wrap: wrap; gap: calc(6px * var(--u)) calc(14px * var(--u)); align-items: center; padding-top: calc(4px * var(--u)); color: var(--ink2); }
.ssc-legend { display: flex; flex-wrap: wrap; gap: calc(4px * var(--u)) calc(12px * var(--u)); color: var(--grey); font-size: .92em; }
.ssc-legend i { display: inline-block; width: calc(10px * var(--u)); height: calc(10px * var(--u)); border-radius: calc(3px * var(--u)); margin-right: calc(5px * var(--u)); vertical-align: -1px; }
.ssc-src { color: var(--grey); font-size: .88em; margin-left: auto; }
.ssc-code { margin: calc(8px * var(--u)) 0 0; padding: calc(6px * var(--u)) 0; border-radius: calc(10px * var(--u)); background: var(--sunk); font-family: var(--font-mono, ui-monospace, monospace); font-size: .9em; line-height: 1.6; max-height: calc(7 * 1.6em + 12px * var(--u)); overflow: auto; position: relative; }
.ssc-code ol { list-style: none; margin: 0; padding: 0; counter-reset: ln; }
.ssc-code li { display: flex; gap: calc(10px * var(--u)); padding: 0 calc(10px * var(--u)) 0 0; white-space: pre; transition: background .18s; }
.ssc-code li::before { counter-increment: ln; content: counter(ln); flex: none; width: 2.4em; text-align: right; color: var(--grey); opacity: .7; }
.ssc-code li[aria-current=step] { background: color-mix(in oklab, var(--mark) 16%, transparent); }
.ssc-code li[aria-current=step]::before { color: var(--mark); opacity: 1; font-weight: 700; }
.ssc.reduce .ssc-code li { transition: none; }
.ssc-bar { display: flex; align-items: center; gap: calc(8px * var(--u)); padding-top: calc(8px * var(--u)); flex-wrap: wrap; }
.ssc button { appearance: none; font: inherit; color: var(--ink); background: transparent; border: 0; border-radius: calc(7px * var(--u)); padding: calc(5px * var(--u)) calc(9px * var(--u)); cursor: pointer; line-height: 1.2; min-height: calc(28px * var(--u)); }
.ssc button:hover:not([aria-disabled=true]) { background: var(--sunk); }
.ssc button[aria-disabled=true] { opacity: .4; cursor: default; }
.ssc button:focus-visible, .ssc input:focus-visible, .ssc-code:focus-visible { outline: calc(2px * var(--u)) solid var(--mark); outline-offset: calc(2px * var(--u)); }
.ssc .icon { width: calc(32px * var(--u)); height: calc(32px * var(--u)); padding: 0; display: grid; place-items: center; flex: none; }
.ssc .icon svg { width: calc(14px * var(--u)); height: calc(14px * var(--u)); }
.ssc .play { background: var(--mark); color: var(--primary-foreground, #fff); border-radius: 999px; }
.ssc .play:hover:not([aria-disabled=true]) { background: color-mix(in oklab, var(--mark) 85%, var(--ink)); }
.ssc input[type=range] { flex: 1 1 calc(140px * var(--u)); min-width: calc(90px * var(--u)); accent-color: var(--mark); height: calc(24px * var(--u)); margin: 0; }
.ssc .n { font-variant-numeric: tabular-nums; color: var(--ink2); font-family: var(--font-mono, ui-monospace, monospace); font-size: .92em; min-width: 6.5em; }
.ssc .seg { display: inline-flex; padding: calc(2px * var(--u)); border-radius: calc(9px * var(--u)); background: var(--sunk); gap: calc(2px * var(--u)); }
.ssc .seg button[aria-pressed=true] { background: var(--paper); font-weight: 600; }
.ssc .ticks { position: relative; flex: 1 1 calc(140px * var(--u)); min-width: calc(90px * var(--u)); display: flex; flex-direction: column; }
.ssc .ticks input { flex: none; width: 100%; min-width: 0; }
.ssc .ticks span { position: absolute; bottom: calc(-2px * var(--u)); width: calc(3px * var(--u)); height: calc(3px * var(--u)); border-radius: 50%; background: var(--grey); opacity: .6; transform: translateX(-50%); pointer-events: none; }
.ssc .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.ssc-warn { color: var(--alert); font-size: .9em; }
/* The technical look: hairline controls, a monospace for the numbers, one accent. */
.ssc.tech { border-top: 1px solid var(--rule); padding-top: calc(10px * var(--u)); margin-top: calc(10px * var(--u)); }
.ssc.tech .ssc-cap { font-size: 1.04em; letter-spacing: -.003em; }
.ssc.tech .ssc-cap b { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 500; font-size: .86em; color: var(--grey); letter-spacing: .02em; margin-right: .9em; }
.ssc.tech .ssc-legend, .ssc.tech .ssc-src { font-family: var(--font-mono, ui-monospace, monospace); font-size: .8em; letter-spacing: .01em; }
.ssc.tech .ssc-legend i { width: calc(12px * var(--u)); height: calc(3px * var(--u)); border-radius: 0; vertical-align: 2px; }
.ssc.tech button { border-radius: calc(3px * var(--u)); }
.ssc.tech .icon { width: calc(28px * var(--u)); height: calc(28px * var(--u)); box-shadow: inset 0 0 0 1px var(--rule); }
.ssc.tech .icon svg { width: calc(11px * var(--u)); height: calc(11px * var(--u)); }
.ssc.tech .play { background: transparent; color: var(--ink); border-radius: calc(3px * var(--u)); box-shadow: inset 0 0 0 1px var(--ink); }
.ssc.tech .play:hover:not([aria-disabled=true]) { background: var(--sunk); }
.ssc.tech input[type=range] { accent-color: var(--ink); height: calc(18px * var(--u)); }
.ssc.tech .ticks span { width: 1px; height: calc(5px * var(--u)); border-radius: 0; bottom: calc(-3px * var(--u)); }
.ssc.tech .n { font-size: .82em; color: var(--grey); }
.ssc.tech .seg { background: transparent; box-shadow: inset 0 0 0 1px var(--rule); border-radius: calc(3px * var(--u)); }
.ssc.tech .seg button { font-family: var(--font-mono, ui-monospace, monospace); font-size: .82em; min-height: calc(24px * var(--u)); padding: calc(3px * var(--u)) calc(8px * var(--u)); }
.ssc.tech .seg button[aria-pressed=true] { background: var(--sunk); font-weight: 500; }
.ssc.tech .ssc-code { border-radius: calc(3px * var(--u)); background: transparent; box-shadow: inset 0 0 0 1px var(--rule); max-height: calc(5 * 1.6em + 12px * var(--u)); }
`;

const SPEEDS = [0.5, 1, 2] as const;
/** Under reduced motion, Play shows a beat this long (at 1×). */
const BEAT_HOLD_MS = 1800;

/** The element a player sits in: the drawing's slot around the shadow host it was given. */
function slotOf(root: HTMLElement): HTMLElement | null {
  const host = (root.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
  return host?.parentElement ?? root.parentElement ?? null;
}

const KW = /\b(func|for|range|if|else|return|continue|break|def|in|while|let|const|var|go|select|case|await|async)\b/g;
function codeLine(line: string, lang?: string): React.ReactNode {
  const cmAt = lang === 'python' ? line.indexOf('#') : line.indexOf('//');
  const body = cmAt >= 0 ? line.slice(0, cmAt) : line;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(KW)) {
    if (m.index! > last) parts.push(body.slice(last, m.index));
    parts.push(<span key={m.index} style={{ color: 'var(--mark)' }}>{m[0]}</span>);
    last = m.index! + m[0].length;
  }
  parts.push(body.slice(last));
  if (cmAt >= 0) parts.push(<span key="cm" style={{ color: 'var(--grey)' }}>{line.slice(cmAt)}</span>);
  return parts;
}

export interface ScenePlayerProps {
  scene: ShapeScene;
  reduce?: boolean;
  /** Open at this time, paused, scrolled into view (`plannotator shape frame`, tests); no autoplay. */
  at?: number;
  /** Scale the drawing down so it and the controls fit the visible height (default on). */
  fitView?: boolean;
  /** 'technical': the drawing and the controls take the technical look (look.ts). Absent: the drawing as drawn. */
  look?: 'technical';
}

export default function ScenePlayer({ scene, reduce = false, at, fitView = true, look }: ScenePlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const domRef = useRef<SceneDom | null>(null);
  const [t, setT] = useState(() => Math.max(0, Math.min(scene.end, at ?? 0)));
  const tRef = useRef(t);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [u, setU] = useState(1);
  const [missing, setMissing] = useState<string[]>([]);
  const [srLine, setSrLine] = useState('');
  /** Next is moving to this time (a short tween), or null. */
  const goal = useRef<number | null>(null);
  const beats = scene.beats;
  const bi = beatAt(scene, t);
  const beat = beats[bi]!;

  const show = useCallback((v: number) => {
    const c = Math.max(0, Math.min(scene.end, v));
    tRef.current = c;
    setT(c);
    domRef.current?.apply(c);
  }, [scene.end]);

  // Find the pieces; measure again when the board resizes, and once the board's own entrance has settled.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const slot = root ? slotOf(root) : null;
    if (!root || !slot) return;
    const dom = look === 'technical' ? new SceneDom(slot, scene, LIT_TECHNICAL, true) : new SceneDom(slot, scene);
    domRef.current = dom;
    // Fit the drawing and the player into the height the person can see (fit.ts).
    let unfit: (() => void) | null = null;
    let unlook: (() => void) | null = null;
    let lookStyle: HTMLStyleElement | null = null;
    if (look === 'technical') {
      slot.setAttribute('data-scene-look', 'technical');
      lookStyle = slot.ownerDocument.createElement('style');
      lookStyle.textContent = LOOK_CSS;
      slot.prepend(lookStyle);
    }
    const fit = (k: number) => {
      unlook?.();
      unlook = null;
      unfit?.();
      unfit = null;
      const svg = slot.querySelector('svg');
      if (fitView && svg) unfit = fitScene(slot, svg, k);
      if (look === 'technical' && svg) unlook = applyTechnicalLook(svg);
    };
    const measure = () => {
      const k = root.offsetWidth ? root.getBoundingClientRect().width / root.offsetWidth : 1;
      setU(k > 0.05 ? 1 / k : 1);
      fit(k > 0.05 ? k : 1);
      dom.measure();
      dom.apply(tRef.current);
      setMissing(dom.missing);
    };
    measure();
    // A still of one moment: the scene in view, whatever is above it on the board.
    if (at !== undefined) slot.scrollIntoView?.({ block: 'nearest' });
    const later = setTimeout(measure, 1400);
    let ro: ResizeObserver | undefined;
    const win = slot.ownerDocument.defaultView;
    const sc = fitView ? scrollerOf(slot) : null;
    if (typeof ResizeObserver !== 'undefined') {
      let last = slot.clientWidth, lastH = sc?.clientHeight ?? 0;
      ro = new ResizeObserver(() => {
        const h = sc?.clientHeight ?? 0;
        if (Math.abs(slot.clientWidth - last) < 2 && Math.abs(h - lastH) < 2) return;
        last = slot.clientWidth;
        lastH = h;
        measure();
      });
      ro.observe(slot);
      if (sc) ro.observe(sc);
    }
    const onWin = () => measure();
    if (fitView && !sc) win?.addEventListener('resize', onWin);
    return () => {
      clearTimeout(later);
      ro?.disconnect();
      win?.removeEventListener('resize', onWin);
      unlook?.();
      unfit?.();
      lookStyle?.remove();
      if (look === 'technical') slot.removeAttribute('data-scene-look');
      dom.restore();
      domRef.current = null;
    };
    // `at` is read once, when the player opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, fitView, look]);

  // Play once when it first comes into view (never under reduced motion, or when opened at a time).
  useEffect(() => {
    const root = rootRef.current;
    if (reduce || at !== undefined || !root || typeof IntersectionObserver === 'undefined') return;
    const slot = slotOf(root) ?? root;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.4)) {
        io.disconnect();
        if (tRef.current <= 0) setPlaying(true);
      }
    }, { threshold: [0.4] });
    io.observe(slot);
    return () => io.disconnect();
  }, [reduce, at]);

  // Smooth play: time runs at end / playMs per ms, times the speed. Next's short tween runs here too.
  useEffect(() => {
    if (reduce || (!playing && goal.current === null)) return;
    let raf = 0, last = performance.now();
    const rate = scene.end / playMs(scene);
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const g = goal.current;
      if (g !== null) {
        // Next: get to the next beat in about half a second whatever the gap.
        const step = Math.max(rate * dt * speed, (Math.abs(g - tRef.current) + 1e-6) * Math.min(1, dt / 160));
        const v = tRef.current + Math.sign(g - tRef.current) * Math.min(step, Math.abs(g - tRef.current));
        show(v);
        if (Math.abs(g - v) < 1e-6) {
          goal.current = null;
          setPlaying(false);
          return;
        }
      } else {
        const v = tRef.current + rate * dt * speed;
        show(v);
        if (v >= scene.end) {
          setPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, reduce, speed, scene, show]);

  // Reduced motion: Play shows one beat at a time, each drawn in place.
  useEffect(() => {
    if (!reduce || !playing) return;
    const next = nextBeatTime(scene, tRef.current);
    if (next === null) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => show(next), BEAT_HOLD_MS / speed);
    return () => clearTimeout(id);
  }, [reduce, playing, t, speed, scene, show]);

  // Keep the lit code line in view, inside the code pane only.
  useEffect(() => {
    const pane = codeRef.current;
    const li = pane?.querySelector<HTMLElement>('li[aria-current=step]');
    if (!pane || !li) return;
    const top = li.offsetTop, bottom = top + li.offsetHeight;
    if (top < pane.scrollTop + 4 || bottom > pane.scrollTop + pane.clientHeight - 4) pane.scrollTop = Math.max(0, top - pane.clientHeight / 2 + li.offsetHeight / 2);
  }, [bi]);

  const words = (i: number) => `Beat ${i + 1} of ${beats.length}, ${clockWords(scene, beats[i]!.at)}: ${beats[i]!.say}`;
  const play = (on: boolean) => {
    goal.current = null;
    if (on && tRef.current >= scene.end - 1e-9) show(0);
    setPlaying(on);
    if (!on) setSrLine(words(beatAt(scene, tRef.current)));
  };
  const toBeat = (i: number, tween: boolean) => {
    const n = Math.max(0, Math.min(beats.length - 1, i));
    setSrLine(words(n));
    if (tween && !reduce && beats[n]!.at > tRef.current) {
      goal.current = beats[n]!.at;
      setPlaying(true);
      return;
    }
    goal.current = null;
    setPlaying(false);
    show(beats[n]!.at);
  };
  // Back: the start of this beat if we are past it, else the beat before.
  const back = () => toBeat(t > beat.at + 1e-6 ? bi : bi - 1, false);
  const nextIdx = beats.findIndex((b) => b.at > t + 1e-9);
  const atStart = t <= beats[0]!.at + 1e-9 && bi === 0;
  const atEnd = nextIdx < 0;
  const scrub = (v: number) => {
    goal.current = null;
    setPlaying(false);
    // Reduced motion: the slider lands on beats only, so nothing is ever shown half way.
    show(reduce ? reducedTime(scene, v) : v);
  };
  const scenario = /^(scenario|simulated|written from|read from)/i.test(scene.source ?? '');

  return (
    <div className={`ssc${reduce ? ' reduce' : ''}${look === 'technical' ? ' tech' : ''}`} ref={rootRef} style={{ ['--u' as string]: String(u) }} role="group" aria-label={`Animation: ${scene.title}`}>
      <style>{CSS}</style>
      <p className="ssc-cap" aria-hidden="true">
        <b>{look === 'technical' ? `${String(bi + 1).padStart(2, '0')}/${String(beats.length).padStart(2, '0')}` : `${bi + 1}/${beats.length}`}</b>
        {beat.say}
      </p>
      {(scene.legend?.length || scene.source) && (
        <div className="ssc-side">
          {scene.legend && (
            <span className="ssc-legend">
              {scene.legend.map((l) => (
                <span key={l.color + l.label}>
                  <i style={{ background: `var(--${l.color})` }} />
                  {l.label}
                </span>
              ))}
            </span>
          )}
          {scene.source && <span className="ssc-src">{scenario ? `${scene.source} · not a recording` : scene.source}</span>}
        </div>
      )}
      {scene.code && (
        <div className="ssc-code" ref={codeRef} role="region" aria-label="Code" tabIndex={0}>
          <ol>
            {scene.code.lines.map((l, i) => (
              <li key={i} aria-current={beat.line === i + 1 ? 'step' : undefined}>
                <span>{codeLine(l, scene.code!.lang)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {missing.length > 0 && <p className="ssc-warn">Not in the drawing: {missing.map((m) => `data-part="${m}"`).join(', ')}</p>}
      <div className="ssc-bar">
        {/* At an end the button stays focusable (aria-disabled), so a keyboard user's focus is not dropped to the page. */}
        <button type="button" className="icon" onClick={() => !atStart && back()} aria-disabled={atStart} aria-label="Back one beat">
          <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 2v10M11.5 2.6v8.8a.5.5 0 0 1-.8.4L5 7.4a.5.5 0 0 1 0-.8l5.7-4.4a.5.5 0 0 1 .8.4Z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button type="button" className="icon play" onClick={() => play(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? (
            <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="3" y="2" width="3" height="10" rx="1" fill="currentColor" /><rect x="8" y="2" width="3" height="10" rx="1" fill="currentColor" /></svg>
          ) : (
            <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M4 2.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L4.9 1.7a.6.6 0 0 0-.9.5Z" fill="currentColor" /></svg>
          )}
        </button>
        <button type="button" className="icon" onClick={() => !atEnd && toBeat(nextIdx, true)} aria-disabled={atEnd} aria-label="Next beat">
          <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M11 2v10M2.5 2.6v8.8a.5.5 0 0 0 .8.4L9 7.4a.5.5 0 0 0 0-.8L3.3 2.2a.5.5 0 0 0-.8.4Z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <span className="ticks">
          <input type="range" min={0} max={scene.end} step="any" value={t} aria-label="Time" aria-valuetext={words(bi)} onChange={(e) => scrub(Number(e.target.value))} />
          {beats.map((b, i) => (
            <span key={i} style={{ left: `${(b.at / scene.end) * 100}%` }} />
          ))}
        </span>
        <span className="n" aria-hidden="true">{clockWords(scene, t)}</span>
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
