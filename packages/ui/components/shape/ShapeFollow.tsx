/**
 * "Follow an example" (approval "trace-it-board", build approved on r5): one
 * control in the board's dock, shown on How it works when the board has
 * examples. Pressed, the drawing lights one example's path through its own
 * parts and arrows (followPainter.ts), and a card above the dock names the
 * example and steps through it. Folded, a step is its number and its plain
 * sentence; open, it is what goes in → what happens → what comes out.
 *
 * Motion (r5):
 *  - The card's size changes are FLIPs, transforms only: its skin scales from
 *    its old box with the corners corrected on every keyframe, and its parts
 *    slide. The board makes room on the same curve, in the same frame.
 *  - Forward, the output flies into the next step's input (300 ms) while the
 *    other rows come in 30 ms apart; back is a quick reverse slide; a jump is
 *    a cross-fade. Closing the open card fades its content first (110 ms).
 *  - Every press cancels what is in flight and starts from where things are.
 *  - Reduced motion: 150 ms fades only.
 *
 * Code reads as the Code view shows it: the same highlighter (Pierre's Shiki)
 * and themes (pierre-light, pierre-dark).
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ShapeExample, ShapeExampleCheck, ShapeExampleSource, ShapeExampleStep } from '@plannotator/core/shape';
import { animate, FOLLOW_EASE, FollowPainter } from './followPainter';
import {
  followCheckCode,
  followDir,
  followFnName,
  followReduce,
  followSignature,
  followSource,
  FOLLOW_LITERAL,
  type FollowAction,
  type FollowDir,
  type FollowPhase,
} from './followState';

const NOTE = 'An example, read from the code. Nothing was run.';

/** The card and the board: one duration. */
const SIZE_MS = 260;
/** The document timeline (it follows a slowed-down recording; performance.now does not). */
const clock = () => Number(document.timeline?.currentTime ?? performance.now());
/** cubic-bezier(.22, 1, .36, 1) as a function, for the board's frame-by-frame resize. */
const easeOut = (() => {
  const [x1, y1, x2, y2] = [0.22, 1, 0.36, 1];
  const bez = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bez(mid, x1, x2) < x) lo = mid;
      else hi = mid;
    }
    return bez((lo + hi) / 2, y1, y2);
  };
})();

const fileOf = (path: string) => path.split('/').pop() ?? path;

// ───────────────────────── code, as the Code view shows it ─────────────────────────

type Tok = { t: string; s?: React.CSSProperties };
type Tokenizer = { codeToTokens: (c: string, o: object) => { tokens: { content: string; htmlStyle?: unknown }[][] } };
const tokCache = new Map<string, Tok[][]>();
let hlP: Promise<Tokenizer> | null = null;
const highlighter = () =>
  (hlP ??= import('@pierre/diffs').then((m) => m.getSharedHighlighter({ themes: ['pierre-light', 'pierre-dark'], langs: ['typescript'] }) as unknown as Promise<Tokenizer>));

function styleOf(tk: { htmlStyle?: unknown }): React.CSSProperties | undefined {
  let st = tk.htmlStyle as Record<string, string> | string | undefined;
  if (typeof st === 'string') {
    const o: Record<string, string> = {};
    for (const part of st.split(';')) {
      const i = part.indexOf(':');
      if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    st = o;
  }
  if (!st) return undefined;
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(st)) if (k.startsWith('--shiki-')) o[k] = v;
  return o as React.CSSProperties;
}

function tokenizeInto(h: Tokenizer, code: string) {
  if (tokCache.has(code)) return;
  const r = h.codeToTokens(code, { lang: 'typescript', themes: { light: 'pierre-light', dark: 'pierre-dark' }, defaultColor: false });
  tokCache.set(code, r.tokens.map((line) => line.map((tk) => ({ t: tk.content, s: styleOf(tk) }))));
}

/** Every snippet an example shows, as the card asks for it (prefix included). */
function snippetsOf(ex: ShapeExample): string[] {
  const out: string[] = [];
  for (const s of ex.steps) {
    out.push(`function ${followSignature(s.signature)}`);
    for (const c of s.checks) {
      out.push(followCheckCode(c));
      if (c.saw && FOLLOW_LITERAL.test(c.saw)) out.push(`x = ${c.saw}`);
    }
    for (const v of s.inputs) if (FOLLOW_LITERAL.test(v.value)) out.push(`x = ${v.value}`);
    if (FOLLOW_LITERAL.test(s.output.value)) out.push(`x = ${s.output.value}`);
    out.push(`let x: ${s.output.type}`);
  }
  return out;
}

/**
 * Highlights an example ahead of time, a few snippets per idle moment, so
 * opening the card never waits on the highlighter (loading it and tokenizing
 * everything at once cost one ~100 ms frame).
 */
function warm(ex: ShapeExample): () => void {
  let stop = false;
  let id = 0;
  const ric = typeof window.requestIdleCallback === 'function';
  const idle = (fn: (d: { timeRemaining: () => number }) => void): number =>
    ric ? window.requestIdleCallback(fn, { timeout: 400 }) : globalThis.setTimeout(() => fn({ timeRemaining: () => 8 }), 16) as unknown as number;
  highlighter()
    .then((h) => {
      if (stop) return;
      const todo = snippetsOf(ex).filter((c) => !tokCache.has(c));
      const run = (d: { timeRemaining: () => number }) => {
        if (stop) return;
        while (todo.length && d.timeRemaining() > 3) tokenizeInto(h, todo.shift()!);
        if (todo.length) id = idle(run);
      };
      id = idle(run);
    })
    .catch(() => {});
  return () => {
    stop = true;
    if (ric) window.cancelIdleCallback(id);
    else globalThis.clearTimeout(id);
  };
}

function useTokens(code: string): Tok[][] | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (tokCache.has(code)) return;
    let live = true;
    highlighter()
      .then((h) => {
        tokenizeInto(h, code);
        if (live) force((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code]);
  return tokCache.get(code) ?? null;
}

/** Drops the first `n` characters (a prefix that only gave the highlighter its context). */
function strip(lines: Tok[][], n: number): Tok[][] {
  if (!n) return lines;
  const first: Tok[] = [];
  let left = n;
  for (const tk of lines[0] ?? []) {
    if (left <= 0) first.push(tk);
    else if (tk.t.length <= left) left -= tk.t.length;
    else {
      first.push({ ...tk, t: tk.t.slice(left) });
      left = 0;
    }
  }
  return [first, ...lines.slice(1)];
}

/** TypeScript, highlighted like the Code view; plain until the highlighter is ready (same text, so nothing moves). */
function Code({ code, pre = '', className }: { code: string; pre?: string; className?: string }) {
  const lines = useTokens(pre + code);
  if (!lines) return <code className={className}>{code}</code>;
  return (
    <code className={className}>
      {strip(lines, pre.length).map((line, i) => (
        <React.Fragment key={i}>
          {i > 0 && '\n'}
          {line.map((tk, j) => (
            <React.Fragment key={j}>
              <span className="tk" style={tk.s}>
                {tk.t}
              </span>
              {/* A place to wrap after a dot, so a long name breaks at its parts, never mid-word (and copies clean). */}
              {tk.t.endsWith('.') && <wbr />}
            </React.Fragment>
          ))}
        </React.Fragment>
      ))}
    </code>
  );
}

/** A value: a literal in its type's colour, anything else as plain code. */
function Val({ v, hand, out, type }: { v: string; hand?: boolean; out?: boolean; type?: string }) {
  return (
    <span className={`shp-ex-val${hand ? ' hand' : ''}`} data-out={out ? '' : undefined} data-hand={hand ? '' : undefined} title={type}>
      {FOLLOW_LITERAL.test(v) ? <Code code={v} pre="x = " /> : <code>{v}</code>}
    </span>
  );
}

// ───────────────────────── icons ─────────────────────────

function RailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 3.4v7.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity=".55" />
      <circle cx="7" cy="2.4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="7" cy="7" r="1.4" fill="currentColor" opacity=".7" />
      <circle cx="7" cy="11.6" r="1.7" fill="currentColor" />
    </svg>
  );
}
const Chevron = ({ dir = 'right' }: { dir?: 'right' | 'left' | 'down' | 'up' }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={{ right: 'M9 6l6 6-6 6', left: 'M15 6l-6 6 6 6', down: 'M6 9l6 6 6-6', up: 'M6 15l6-6 6 6' }[dir]} />
  </svg>
);
const Close = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
/** "Open": a small arrow out, for anything that opens the code. */
const OpenIcon = () => (
  <svg className="shp-ex-oi" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7L7 3M3.6 3H7v3.4" />
  </svg>
);
/** The hand-off between the three parts, drawn as the board draws its arrows: a line and an open head. */
const Flow = ({ down }: { down?: boolean }) =>
  down ? (
    <svg className="shp-ex-flow down" width="16" height="24" viewBox="0 0 16 24" aria-hidden="true">
      <path d="M8 2V21M2 15L8 21L14 15" />
    </svg>
  ) : (
    <svg className="shp-ex-flow" width="28" height="16" viewBox="0 0 28 16" aria-hidden="true">
      <path d="M2 8H25M18 2L25 8L18 14" />
    </svg>
  );
const Mark = ({ result }: { result: ShapeExampleCheck['result'] }) => (
  <svg className="mk" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={result === 'pass' ? 'holds' : result === 'fail' ? 'fails' : 'not reached'}>
    <path d={result === 'pass' ? 'M2.5 6.2L5 8.5L9.5 3.5' : result === 'fail' ? 'M3 3L9 9M9 3L3 9' : 'M3 6H9'} />
  </svg>
);

// ───────────────────────── the card's parts ─────────────────────────

type At = { path: string; line: number };

function Source({ from, onCode, canOpen }: { from: ShapeExampleSource; onCode: (to: At) => void; canOpen: (path: string) => boolean }) {
  const src = followSource(from);
  if (src.kind === 'step') return <span className="shp-ex-src handed">from step {src.step}</span>;
  if (src.kind === 'text') return <span className="shp-ex-src">{src.text}</span>;
  const file = fileOf(src.path);
  if (!canOpen(src.path)) return <span className="shp-ex-src">{file}:{src.line}</span>;
  return (
    <button type="button" className="shp-ex-src link" onClick={() => onCode(src)} title={`Open ${file} at line ${src.line}`}>
      <span className="u">
        {file}:{src.line}
      </span>
      <OpenIcon />
    </button>
  );
}

/** What goes in → what happens → what comes out. */
function StepIO({ step, k, cur, onCode, canOpen, phone }: { step: ShapeExampleStep; k: string; cur: boolean; onCode: (to: At) => void; canOpen: (path: string) => boolean; phone: boolean }) {
  const file = fileOf(step.code.path);
  const nameWidth = step.inputs.length ? Math.max(...step.inputs.map((v) => v.name.length)) : 0;
  return (
    <div className={`shp-ex-io${phone ? ' stacked' : ''}${cur ? ' cur' : ''}`} data-io={k} aria-hidden={cur ? undefined : true} inert={!cur}>
      <section className="shp-ex-col in" aria-label="Goes in">
        <p className="shp-ex-cap">Goes in</p>
        <ul className="shp-ex-ins" style={{ '--nw': `${nameWidth}ch` } as React.CSSProperties}>
          {step.inputs.map((v, i) => {
            const handed = typeof v.from === 'object' && 'step' in v.from;
            return (
              <li key={`${v.name}-${i}`} className="shp-ex-row" data-handoff={handed ? '' : undefined}>
                <code className="nm">{v.name}</code>
                <span className="vl">
                  <Val v={v.value} hand={handed} type={v.type} />
                  {v.reading && <span className="pl">{v.reading}</span>}
                </span>
                <Source from={v.from} onCode={onCode} canOpen={canOpen} />
              </li>
            );
          })}
        </ul>
      </section>
      <Flow down={phone} />
      <section className="shp-ex-col fn" aria-label="What happens">
        <p className="shp-ex-cap">What happens</p>
        <div className="shp-ex-box">
          <Code className="shp-ex-sig shp-ex-row" code={followSignature(step.signature)} pre="function " />
          <ul className="shp-ex-checks">
            {step.checks.map((c, i) => (
              <li key={`${c.code}-${i}`} className={`shp-ex-row ${c.result === 'not-reached' ? 'skip' : c.result}${c.decides ? ' decides' : ''}`}>
                <Mark result={c.result} />
                <Code className="cond" code={followCheckCode(c)} />
                <span className="got">
                  {c.result === 'not-reached' ? <span className="say">not reached</span> : c.saw && FOLLOW_LITERAL.test(c.saw) ? <Val v={c.saw} /> : <span className="say">{c.saw}</span>}
                </span>
                {c.decides && (
                  <span className="dec">
                    {c.result === 'fail' ? (
                      <>
                        Decided it: {c.short ? <b>{c.short}</b> : 'it fails'}, so the step returns early.
                      </>
                    ) : (
                      'Decided it.'
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {canOpen(step.code.path) ? (
            <button type="button" className="shp-ex-line shp-ex-row" onClick={() => onCode(step.code)}>
              <span className="u">
                Open {file} at line {step.code.line}
              </span>
              <OpenIcon />
            </button>
          ) : (
            <span className="shp-ex-line shp-ex-row">
              {file}:{step.code.line}
            </span>
          )}
        </div>
      </section>
      <Flow down={phone} />
      <section className="shp-ex-col out" aria-label="Comes out">
        <p className="shp-ex-cap">Comes out</p>
        <div className="shp-ex-outv shp-ex-row">
          <code className="nm">{step.output.name}</code>
          <Val v={step.output.value} hand out type={step.output.type} />
        </div>
        <Code className="shp-ex-type shp-ex-row" code={step.output.type} pre="let x: " />
        {step.output.note && <span className="shp-ex-meta shp-ex-row">{step.output.note}</span>}
      </section>
    </div>
  );
}

/** Rects of the card's moving parts, for a FLIP: where they are on screen now (mid-flight included). */
function snapshot(card: HTMLElement) {
  const m = new Map<string, DOMRect>();
  for (const el of card.querySelectorAll<HTMLElement>('[data-flip]')) m.set(el.dataset.flip!, el.getBoundingClientRect());
  return m;
}

/**
 * The board makes room for the card on the card's own curve. The view's
 * padding changes at once; the drawing is then held, frame by frame, at a rect
 * eased from where it was to where its new fit puts it (a transform on its fit
 * box), so it never snaps, whenever the drawing re-fits.
 */
function useBoardRoom(onFrame: () => void) {
  const raf = useRef(0);
  const from = useRef<DOMRect | null>(null);
  const t0 = useRef(0);
  const frame = useRef(onFrame);
  frame.current = onFrame;
  const stop = useCallback((fit: HTMLElement | null) => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    if (fit) fit.style.transform = fit.style.transformOrigin = '';
    const shell = fit?.closest<HTMLElement>('.shp-drawn');
    if (shell) shell.style.clipPath = 'inset(-24px)';
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return useCallback(
    (view: HTMLElement | null, padding: string, reduce: boolean) => {
      if (!view || view.style.paddingBottom === padding) return;
      const fit = view.querySelector<HTMLElement>('.shp-drawn-fit');
      const was = fit?.getBoundingClientRect() ?? null;
      view.style.paddingBottom = padding;
      if (!fit || !was || !fit.style.width || reduce || typeof requestAnimationFrame !== 'function') {
        stop(fit ?? null);
        frame.current();
        return;
      }
      cancelAnimationFrame(raf.current);
      from.current = was;
      t0.current = clock();
      // While it moves, the drawing may sit past its frame's edge for a moment: no clip until it lands.
      const shell = fit.closest<HTMLElement>('.shp-drawn');
      if (shell) shell.style.clipPath = 'none';
      const tick = () => {
        const el = view.querySelector<HTMLElement>('.shp-drawn-fit');
        const a = from.current;
        if (!el || !a) return stop(el);
        const p = Math.min(1, (clock() - t0.current) / SIZE_MS);
        const e = easeOut(p);
        const keep = el.style.transform;
        el.style.transform = '';
        const to = el.getBoundingClientRect();
        el.style.transform = keep;
        if (p >= 1 || !to.width) {
          stop(el);
          frame.current();
          return;
        }
        const s = (a.width + (to.width - a.width) * e) / to.width;
        el.style.transformOrigin = '0 0';
        el.style.transform = `translate(${a.left + (to.left - a.left) * e - to.left}px, ${a.top + (to.top - a.top) * e - to.top}px) scale(${s})`;
        frame.current();
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    },
    [stop],
  );
}

// ───────────────────────── the hook ─────────────────────────

export interface ShapeFollowOptions {
  /** The How it works view's examples (`views.how.examples`). None: no button, no card. */
  examples: readonly ShapeExample[] | undefined;
  /** The How it works drawing's `.board` (ShapeDrawn's `onBoard`), or null while it is not drawn. */
  board: HTMLElement | null;
  /** How it works is the view on now. */
  active: boolean;
  phone: boolean;
  reduce: boolean;
  /** The board's root (`.shp-root`): the view to make room in, and the surface the card closes over. */
  surface: HTMLElement | null;
  /** Open a file at a line (the function, a source). */
  onCode: (at: At) => void;
  /** May this path be opened? A source that cannot is named only. */
  canOpen: (path: string) => boolean;
  /** Where to start (a host's own shots). Default: closed. */
  initial?: FollowPhase;
  initialOpen?: boolean;
}

/**
 * The dock's button and the card, for ShapeSurface to place: the button in
 * the dock after the views, the card in the surface (it sits above the dock).
 * `sheet`: the card is a phone's bottom sheet, and the dock steps aside.
 */
export function useShapeFollow(options: ShapeFollowOptions): { button: React.ReactNode; card: React.ReactNode; sheet: boolean } {
  const { board, active, phone, reduce, surface, onCode, canOpen } = options;
  const examples = options.examples ?? [];
  const examplesRef = useRef(examples);
  examplesRef.current = examples;
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;
  const [phase, setPhaseRaw] = useState<FollowPhase>(options.initial ?? { open: false });
  const [expanded, setExpandedRaw] = useState(options.initialOpen ?? false);
  const how = active && !!board;
  const cardRef = useRef<HTMLElement | null>(null);
  const painter = useRef<FollowPainter | null>(null);
  const flip = useRef<Map<string, DOMRect> | null>(null);
  const flipping = useRef<Animation[]>([]);
  const stepping = useRef<{ anims: Animation[]; ghost: HTMLElement | null }>({ anims: [], ghost: null });
  const closing = useRef<Animation | null>(null);
  const room = useBoardRoom(() => painter.current?.place());
  const viewOf = useCallback(() => surface?.querySelector<HTMLElement>('.shp-view.v-how:not(.leaving)') ?? null, [surface]);

  // Every change of the card's layout goes through here, so its parts can FLIP from where they are.
  const prepare = useCallback(() => {
    if (cardRef.current) flip.current = snapshot(cardRef.current);
  }, []);
  const dispatch = useCallback(
    (action: FollowAction) => {
      prepare();
      setPhaseRaw((p) => followReduce(p, action, examplesRef.current));
    },
    [prepare],
  );
  const setExpanded = useCallback(
    (open: boolean) => {
      const card = cardRef.current;
      closing.current?.cancel();
      closing.current = null;
      const ios = card?.querySelector<HTMLElement>('.shp-ex-ios');
      if (!open && ios && !reduceRef.current) {
        // Closing: the content goes first (quickly), then the card closes on its curve.
        const a = animate(ios, [{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: 'ease-out', fill: 'forwards' });
        if (a) {
          closing.current = a;
          a.onfinish = () => {
            closing.current = null;
            prepare();
            setExpandedRaw(false);
          };
          return;
        }
      }
      prepare();
      setExpandedRaw(open);
    },
    [prepare],
  );

  // A new version with fewer examples (or none): nothing to follow past its end.
  useEffect(() => {
    if (phase.open && !examples[phase.ex]) setPhaseRaw({ open: false });
  }, [phase, examples]);

  // The step on now, and where it was.
  const stepNow = useRef<number | null>(phase.open ? phase.step : null);
  const last = useRef<FollowPhase | null>(phase.open ? phase : null);

  // The example on the picture: built once per example, then only its states change.
  const example = phase.open ? examples[phase.ex] : undefined;
  useEffect(() => (example ? warm(example) : undefined), [example]);
  useEffect(() => {
    if (!board || !example || !active) return;
    const p = new FollowPainter(board, example);
    painter.current = p;
    p.set(stepNow.current, 'jump', reduceRef.current);
    const root = board.getRootNode() as ShadowRoot | Document;
    // While an example is followed, a click on the picture jumps to the step of the lit part it lands on, and
    // does nothing else (no Change it, no link): the picture is the example's now.
    const onClick = (e: Event) => {
      const path = e.composedPath();
      e.stopPropagation();
      e.preventDefault();
      const lit = path.find((t): t is Element => t instanceof Element && t.hasAttribute('data-ex-i'));
      if (lit) dispatch({ type: 'step', step: Number(lit.getAttribute('data-ex-i')) });
    };
    const quiet = (e: Event) => e.stopPropagation();
    root.addEventListener('click', onClick, true);
    root.addEventListener('pointermove', quiet, true);
    root.addEventListener('mouseup', quiet, true);
    return () => {
      p.destroy();
      if (painter.current === p) painter.current = null;
      root.removeEventListener('click', onClick, true);
      root.removeEventListener('pointermove', quiet, true);
      root.removeEventListener('mouseup', quiet, true);
    };
  }, [board, example, active, dispatch]);

  // The card's moving parts and the board, on one curve (FLIP: the layout changes at once; transforms ease it in).
  useLayoutEffect(() => {
    const card = cardRef.current;
    const before = flip.current;
    flip.current = null;
    const red = reduceRef.current;
    if (card && before && !red) {
      for (const a of flipping.current) a.cancel();
      flipping.current = [];
      for (const el of card.querySelectorAll<HTMLElement>('[data-flip]')) {
        const key = el.dataset.flip!;
        const was = before.get(key);
        const now = el.getBoundingClientRect();
        if (!was) {
          if (key === 'ios') {
            const a = animate(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: 70, easing: FOLLOW_EASE, fill: 'backwards' });
            if (a) flipping.current.push(a);
          }
          continue;
        }
        if (key === 'skin') {
          if (!now.width || !now.height) continue;
          // The card's surface: scaled from its old box, its corners corrected so they stay round.
          const r = phone ? 18 : 14;
          const frames: Keyframe[] = [];
          for (let i = 0; i <= 12; i++) {
            const p = i / 12;
            const w = was.width + (now.width - was.width) * p;
            const h = was.height + (now.height - was.height) * p;
            const sx = w / now.width;
            const sy = h / now.height;
            const x = was.left + (now.left - was.left) * p - now.left;
            const y = was.top + (now.top - was.top) * p - now.top;
            frames.push({
              offset: p,
              transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})`,
              borderRadius: phone ? `${r / sx}px ${r / sx}px 0 0 / ${r / sy}px ${r / sy}px 0 0` : `${r / sx}px / ${r / sy}px`,
            });
          }
          if (Math.abs(was.width - now.width) + Math.abs(was.height - now.height) + Math.abs(was.top - now.top) > 0.5) {
            const a = animate(el, frames, { duration: SIZE_MS, easing: FOLLOW_EASE });
            if (a) flipping.current.push(a);
          }
          continue;
        }
        const dx = was.left - now.left;
        const dy = was.top - now.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          const a = animate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: SIZE_MS, easing: FOLLOW_EASE });
          if (a) flipping.current.push(a);
        }
      }
    } else if (card && before && red) {
      const ios = card.querySelector<HTMLElement>('[data-flip="ios"]');
      if (ios && !before.get('ios')) animate(ios, [{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'linear' });
    }
    // The picture makes room: never covered, it fits above the card.
    const shown = !!card && how && phase.open;
    room(viewOf(), shown ? `${Math.round(card!.offsetHeight + (phone ? 20 : 76 + 16))}px` : '', red);
  });

  // Stepping: the board's light, the card's hand-off, and the way the new step comes in.
  useLayoutEffect(() => {
    const was = last.current;
    const dir: FollowDir = followDir(was, phase);
    const now = phase.open ? phase : null;
    last.current = now;
    stepNow.current = now?.step ?? null;
    if (!now || (was?.open && was.ex === now.ex && was.step === now.step)) return;
    const red = reduceRef.current;
    if (was?.open && was.ex === now.ex) painter.current?.set(now.step, dir, red);

    // The card: what was on goes; what is on now comes in.
    const st = stepping.current;
    for (const a of st.anims) a.cancel();
    st.ghost?.remove();
    st.anims = [];
    st.ghost = null;
    const card = cardRef.current;
    const ios = card?.querySelector<HTMLElement>('.shp-ex-ios');
    if (!card || !ios || now.step === null) return;
    const key = (s: number | null) => `${now.ex}-${s}`;
    const curEl = ios.querySelector<HTMLElement>(`[data-io="${key(now.step)}"]`);
    const oldEl = was?.open && was.ex === now.ex && was.step !== null ? ios.querySelector<HTMLElement>(`[data-io="${key(was.step)}"]`) : null;
    if (!curEl) return;
    const push = (a: Animation | null) => a && st.anims.push(a);
    if (oldEl) {
      oldEl.classList.add('leaving');
      const out = animate(
        oldEl,
        red || dir !== 'back' ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(12px)' }],
        { duration: red ? 150 : 140, easing: 'ease-out', fill: 'forwards' },
      );
      if (out) {
        out.onfinish = () => {
          oldEl.classList.remove('leaving');
          out.cancel();
        };
        out.oncancel = () => oldEl.classList.remove('leaving');
        push(out);
      } else oldEl.classList.remove('leaving');
    }
    if (red) {
      push(animate(curEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'linear', fill: 'backwards' }));
      return;
    }
    if (dir === 'back') {
      push(animate(curEl, [{ opacity: 0, transform: 'translateX(-12px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: 40, easing: FOLLOW_EASE, fill: 'backwards' }));
      return;
    }
    if (dir !== 'fwd' || !oldEl) {
      push(animate(curEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 40, easing: 'ease-out', fill: 'backwards' }));
      return;
    }
    // Forward: the output just left flies into the new step's inputs, and the rest comes in row by row.
    const from = oldEl.querySelector<HTMLElement>('[data-out]');
    const land = curEl.querySelector<HTMLElement>('[data-handoff] [data-hand]');
    const rows = [...curEl.querySelectorAll<HTMLElement>('.shp-ex-row')].filter((r) => !r.hasAttribute('data-handoff'));
    rows.forEach((r, i) => push(animate(r, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: 60 + i * 30, easing: FOLLOW_EASE, fill: 'backwards' })));
    if (!from || !land) return;
    const a = from.getBoundingClientRect();
    const z = land.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const ghost = from.cloneNode(true) as HTMLElement;
    ghost.classList.add('shp-ex-ghost');
    ghost.removeAttribute('data-out');
    // In the card's own box (its translate would make `fixed` mean the card anyway).
    Object.assign(ghost.style, { left: `${z.left - c.left}px`, top: `${z.top - c.top}px` });
    const fly = animate(ghost, [{ transform: `translate(${a.left - z.left}px, ${a.top - z.top}px)` }, { transform: 'none' }], { duration: 300, easing: FOLLOW_EASE });
    if (!fly) return;
    card.appendChild(ghost);
    st.ghost = ghost;
    const hold = animate(land, [{ opacity: 0 }, { opacity: 0 }], { duration: 300 });
    const finish = () => {
      ghost.remove();
      if (st.ghost === ghost) st.ghost = null;
    };
    fly.onfinish = finish;
    fly.oncancel = finish;
    push(fly);
    push(hold);
  }, [phase]);

  // Closing the card: it fades where it was (React has already let it go).
  const lastCard = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (cardRef.current) {
      lastCard.current = cardRef.current;
      return;
    }
    const gone = lastCard.current;
    lastCard.current = null;
    const stage = surface?.querySelector<HTMLElement>('.shp-surface');
    if (!gone || !stage || gone.isConnected) return;
    gone.classList.add('leaving');
    gone.setAttribute('inert', '');
    stage.appendChild(gone);
    const a = animate(gone, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: reduceRef.current ? 150 : 180, easing: 'ease-out', fill: 'forwards' });
    if (a) a.onfinish = () => gone.remove();
    else gone.remove();
  });

  // A narrow board scrolls: keep the step on now in view, above the sheet.
  useEffect(() => {
    if (!board || !phase.open || phase.step === null || !phone) return;
    const el = painter.current?.elementOf(phase.step) as HTMLElement | null | undefined;
    const view = viewOf();
    if (!el || !view || typeof view.scrollTo !== 'function') return;
    const top = el.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop - 56;
    view.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
  }, [board, phase, phone, expanded, reduce, viewOf]);

  if (!examples.length) return { button: null, card: null, sheet: false };

  const ex = phase.open ? examples[phase.ex] ?? null : null;
  const step = phase.open && phase.step !== null && ex ? ex.steps[phase.step] ?? null : null;
  const showIO = expanded && !!step;

  const stepNav = (
    <div className={`shp-ex-nav${step ? ' cur' : ''}`} aria-hidden={step ? undefined : true}>
      <button type="button" className="shp-ex-quiet" onClick={() => dispatch({ type: 'step', step: null })} tabIndex={step ? undefined : -1}>
        All steps
      </button>
      <button type="button" className="shp-ex-icon" onClick={() => dispatch({ type: 'back' })} disabled={!step || (phase.open && phase.step === 0)} aria-label="Previous step">
        <Chevron dir="left" />
      </button>
      <button type="button" className="shp-ex-icon" onClick={() => dispatch({ type: 'next' })} disabled={!step || !ex || (phase.open && phase.step === ex.steps.length - 1)} aria-label="Next step">
        <Chevron />
      </button>
    </div>
  );
  const startNav = (
    <div className={`shp-ex-nav${step ? '' : ' cur'}`} aria-hidden={step ? true : undefined}>
      <button type="button" className="shp-ex-step" onClick={() => dispatch({ type: 'step', step: 0 })} tabIndex={step ? -1 : undefined}>
        Step through
        <Chevron />
      </button>
    </div>
  );
  const navs = (
    <div className="shp-ex-stack shp-ex-navs" data-flip="nav">
      {startNav}
      {stepNav}
    </div>
  );
  const more = step && (
    <button type="button" className="shp-ex-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} data-flip="more">
      {expanded ? 'Hide inputs and outputs' : 'Inputs and outputs'}
      <Chevron dir={expanded ? 'up' : 'down'} />
    </button>
  );

  const button = how ? (
    <button
      type="button"
      className={`shp-tbtn${phase.open ? ' on' : ''}`}
      aria-pressed={phase.open}
      title="Follow one example through this picture"
      aria-label="Follow an example"
      data-follow=""
      onClick={() => dispatch({ type: 'toggle' })}
    >
      <RailIcon />
      {!phone && <span className="tl">Follow an example</span>}
    </button>
  ) : null;

  const card =
    how && ex ? (
      <section ref={cardRef} className={`shp-ex-card${phone ? ' phone' : ''}${showIO ? ' expanded' : ''}`} aria-label={`Example: ${ex.title}`} data-follow-card="">
        <div className="shp-ex-skin" data-flip="skin" aria-hidden="true" />
        <div className="shp-ex-in">
          {phone && (
            <button type="button" className="shp-ex-grab" onClick={() => step && setExpanded(!expanded)} aria-label={expanded ? 'Show less' : 'Show more'} disabled={!step} data-flip="grab">
              <span />
            </button>
          )}
          <div className="shp-ex-head">
            <div className="shp-tgroup" role="group" aria-label="Which example" data-flip="tabs">
              {examples.map((e, i) => (
                <button key={`${e.name}-${i}`} type="button" className={`shp-tbtn${phase.open && i === phase.ex ? ' on' : ''}`} aria-pressed={phase.open && i === phase.ex} onClick={() => dispatch({ type: 'example', ex: i })}>
                  {e.name}
                </button>
              ))}
            </div>
            <span className="shp-ex-sp" />
            {!phone && more}
            <button type="button" className="shp-ex-icon" onClick={() => dispatch({ type: 'close' })} aria-label="Stop following" title="Stop following" data-flip="close">
              <Close />
            </button>
          </div>
          <div className="shp-ex-body" aria-live="polite">
            <div className="shp-ex-stack shp-ex-texts" data-flip="text">
              <div className={`shp-ex-text all${step ? '' : ' cur'}`} aria-hidden={step ? true : undefined}>
                <p className="shp-ex-does">{ex.title}</p>
                {!showIO && ex.lead && <p className="shp-ex-sub">{ex.lead}</p>}
              </div>
              {ex.steps.map((s, i) => {
                const on = phase.open && phase.step === i;
                return (
                  <div key={i} className={`shp-ex-text${on ? ' cur' : ''}`} aria-hidden={on ? undefined : true}>
                    <span className="shp-ex-count">
                      {i + 1} of {ex.steps.length}
                    </span>
                    <div>
                      <p className="shp-ex-does">{s.text}</p>
                      {!showIO && (
                        <p className="shp-ex-sub">
                          {canOpen(s.code.path) ? (
                            <button type="button" className="shp-ex-fn" onClick={() => onCode(s.code)} title={`Open ${fileOf(s.code.path)} at line ${s.code.line}`} tabIndex={on ? undefined : -1}>
                              {followFnName(s.signature)}
                            </button>
                          ) : (
                            <code className="shp-ex-fn">{followFnName(s.signature)}</code>
                          )}
                          {s.detail && <span> · {s.detail}</span>}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {!phone && navs}
          </div>
          {showIO && phase.open && (
            <div className="shp-ex-ios" data-flip="ios">
              {ex.steps.map((s, i) => (
                <StepIO key={i} step={s} k={`${phase.ex}-${i}`} cur={phase.step === i} onCode={onCode} canOpen={canOpen} phone={phone} />
              ))}
            </div>
          )}
          {phone && (
            <div className="shp-ex-foot" data-flip="foot">
              {more}
              {navs}
            </div>
          )}
          <p className="shp-ex-note" data-flip="note">
            {NOTE}
          </p>
        </div>
      </section>
    ) : null;

  return { button, card, sheet: !!card && phone };
}
