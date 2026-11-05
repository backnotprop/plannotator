/**
 * "Follow an example" (approval "trace-it-board", build approved on r5): one
 * control in the board's dock, shown on How it works when the board has
 * examples. Pressed, the drawing lights one example's path through its own
 * parts and arrows (followPainter.ts), and a card above the dock names the
 * example and steps through it. Folded, a step is its number and its plain
 * sentence; open, it is the path (r7): the steps on a rail by their tags, beside
 * what goes in → what happens → what comes out.
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
import type { ShapeExample, ShapeExampleCheck, ShapeExampleInput, ShapeExampleSource, ShapeExampleStep } from '@plannotator/core/shape';
import { animate, FOLLOW_EASE, FollowPainter } from './followPainter';
import {
  followCardCut,
  followCheckCode,
  followDir,
  followFileFit,
  followFnName,
  followReduce,
  followSignature,
  followSignatureFit,
  followSource,
  FOLLOW_LITERAL,
  type FollowAction,
  type FollowDir,
  type FollowPhase,
} from './followState';

const NOTE = 'An example, read from the code. Nothing was run.';

/** The width the dock needs with "Follow an example" in words. */
const DOCK_ROOM = 920;
/** A mono character, in the card's 12 px code. */
const CH = 7.25;
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
    out.push(`function ${followSignature(s.signature)}`, `function ${s.signature}`);
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

/** A name that may wrap: after a dot, never mid-word, and it copies clean. */
const Dotted = ({ name }: { name: string }) => (
  <>
    {name.split(/(?<=\.)/).map((part, i) => (
      <React.Fragment key={i}>
        {i > 0 && <wbr />}
        {part}
      </React.Fragment>
    ))}
  </>
);

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
// From @hugeicons/core-free-icons 4.4.0 (https://hugeicons.com, https://github.com/hugeicons/hugeicons), MIT License,
// Copyright (c) 2025 Hugeicons: permission is hereby granted, free of charge, to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies, subject to this notice; THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
// WARRANTY OF ANY KIND. Only the free MIT set; no Hugeicons Pro icon. Stroke Rounded, drawn at the Inbox's 1.6.
const HUGE = {
  left: 'M15 6C15 6 9.00001 10.4189 9 12C8.99999 13.5812 15 18 15 18',
  right: 'M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18',
  up: 'M17.9998 15C17.9998 15 13.5809 9.00001 11.9998 9C10.4187 8.99999 5.99985 15 5.99985 15',
  down: 'M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9',
  close: 'M18.9991 19L5 5.00098M19 5L5.00092 18.999',
  tick: 'M5 14L8.5 17.5L19 6.5',
  minus: 'M20 12L4 12',
  out: 'M9 6.65032C9 6.65032 15.9383 6.10759 16.9154 7.08463C17.8924 8.06167 17.3496 15 17.3496 15M16.5 7.5L6.5 17.5',
};
const Huge = ({ name, size = 16, weight = 1.6, className }: { name: keyof typeof HUGE; size?: number; weight?: number; className?: string }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={HUGE[name]} />
  </svg>
);
const Mark = ({ result }: { result: ShapeExampleCheck['result'] }) => (
  <svg className="mk" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={result === 'pass' ? 'holds' : result === 'fail' ? 'fails' : 'not reached'}>
    <path d={HUGE[result === 'pass' ? 'tick' : result === 'fail' ? 'close' : 'minus']} />
  </svg>
);
/** A step's number, drawn as the picture's tag draws it: filled while it is the step on now. */
const StepN = ({ n, now }: { n: number; now?: boolean }) => <b className={`shp-ex-n${now ? ' now' : ''}`}>{n}</b>;

// ───────────────────────── the card's parts ─────────────────────────

type At = { path: string; line: number };

/** What the three parts need. `chars`: how many mono characters fit in the code's column. */
interface PartProps {
  step: ShapeExampleStep;
  onCode: (to: At) => void;
  canOpen: (path: string) => boolean;
  onStep: (i: number) => void;
  chars: number;
  /** How many mono characters fit across the inputs' column. */
  pane: number;
}

/** Where a value came from. A line in the step's own file is only its number; the file is named once, at the function. */
function Source({ from, home, room, onCode, canOpen, onStep }: { from: ShapeExampleSource; home: string; room: number; onCode: (to: At) => void; canOpen: (path: string) => boolean; onStep: (i: number) => void }) {
  const src = followSource(from);
  if (src.kind === 'step')
    return (
      <button type="button" className="shp-ex-src handed" onClick={() => onStep(src.step - 1)} title={`From step ${src.step}`} aria-label={`From step ${src.step}`}>
        from <StepN n={src.step} />
      </button>
    );
  if (src.kind === 'text') return <span className="shp-ex-src" title={src.text}>{src.text}</span>;
  const file = fileOf(src.path);
  const label = (
    <>
      {src.path !== home && <span className="f">{followFileFit(file, src.line, room)}</span>}
      <span className="l">:{src.line}</span>
    </>
  );
  if (!canOpen(src.path)) return <span className="shp-ex-src" title={`${src.path}:${src.line}`}>{label}</span>;
  return (
    <button type="button" className="shp-ex-src link" onClick={() => onCode(src)} title={`Open ${file} at line ${src.line}`} aria-label={`Open ${file} at line ${src.line}`}>
      {label}
    </button>
  );
}

/** What "What happens", its gap and the link's arrow take of the code's column, in characters. */
const FN_CAPTION = 16;

/** The function's place: a file and a line, opening the code. */
function FnLink({ step, chars, onCode, canOpen }: Pick<PartProps, 'step' | 'chars' | 'onCode' | 'canOpen'>) {
  const file = fileOf(step.code.path);
  const label = (
    <span className="u">
      <span className="f">{followFileFit(file, step.code.line, chars - FN_CAPTION)}</span>
      <span className="l">:{step.code.line}</span>
    </span>
  );
  if (!canOpen(step.code.path)) return <span className="shp-ex-line" title={step.code.path}>{label}</span>;
  return (
    <button type="button" className="shp-ex-line" onClick={() => onCode(step.code)} title={`Open ${file} at line ${step.code.line}`}>
      {label}
      <Huge name="out" size={12} className="shp-ex-oi" />
    </button>
  );
}

function InputRow({ v, tall, wide, home, room, onCode, canOpen, onStep }: { v: ShapeExampleInput; tall: boolean; wide: boolean; home: string; room: number } & Pick<PartProps, 'onCode' | 'canOpen' | 'onStep'>) {
  const handed = typeof v.from === 'object' && 'step' in v.from;
  return (
    <li className={`shp-ex-row${tall ? ' tall' : ''}${tall && wide ? ' wide' : ''}`} data-handoff={handed ? '' : undefined}>
      <code className="nm" title={v.name}><Dotted name={v.name} /></code>
      <span className="vl">
        <Val v={v.value} hand={handed} type={v.type} />
        {v.reading && <span className="pl">{v.reading}</span>}
      </span>
      <Source from={v.from} home={home} room={room} onCode={onCode} canOpen={canOpen} onStep={onStep} />
    </li>
  );
}

/**
 * Goes in: name, value, where it came from, with one name column so values read
 * down. A row that cannot fit on one line gives its value the next line; only a
 * file name longer than half the pane is ever cut.
 */
function Inputs({ step, onCode, canOpen, onStep, pane }: PartProps) {
  if (!step.inputs.length) return <p className="shp-ex-none">Nothing</p>;
  const names = step.inputs.map((v) => v.name.length).filter((n) => n <= pane / 2);
  const nw = names.length ? Math.max(...names) : 0;
  const room = Math.floor(pane / 2);
  const labelOf = (v: ShapeExampleInput) => {
    const src = followSource(v.from);
    if (src.kind === 'step') return 6;
    if (src.kind === 'text') return Math.min(room, src.text.length);
    const line = String(src.line).length + 1;
    return src.path === step.code.path ? line : followFileFit(fileOf(src.path), src.line, room).length + line;
  };
  const sw = Math.max(...step.inputs.map(labelOf));
  const valueW = (v: ShapeExampleInput) => v.value.length + (v.reading ? v.reading.length + 2 : 0);
  // The name column is nw + 1 characters; the two gaps are 12 px each, under 4 characters.
  const tall = (v: ShapeExampleInput) => v.name.length > nw || nw + 1 + 4 + labelOf(v) + valueW(v) > pane;
  const wide = (v: ShapeExampleInput) => v.name.length + labelOf(v) + 2 > pane;
  return (
    <ul className="shp-ex-vars" style={{ '--nw': `${nw + 1}ch`, '--sw': `${sw + 1}ch` } as React.CSSProperties}>
      {step.inputs.map((v, i) => (
        <InputRow key={`${v.name}-${i}`} v={v} tall={tall(v)} wide={wide(v)} home={step.code.path} room={room} onCode={onCode} canOpen={canOpen} onStep={onStep} />
      ))}
    </ul>
  );
}

function CheckRow({ c }: { c: ShapeExampleCheck }) {
  return (
    <li className={`shp-ex-row ${c.result === 'not-reached' ? 'skip' : c.result}${c.decides ? ' decides' : ''}`}>
      <Mark result={c.result} />
      <Code className="cond" code={followCheckCode(c)} />
      <span className="got">
        {c.decides && c.result === 'fail' && c.short ? <b className="short">{c.short}</b> : c.decides ? <span className="dec">Decided it</span> : null}
        {c.result === 'not-reached' ? <span className="say">not reached</span> : c.saw && FOLLOW_LITERAL.test(c.saw) ? <Val v={c.saw} /> : <span className="say">{c.saw}</span>}
      </span>
    </li>
  );
}

const Signature = ({ step, chars }: Pick<PartProps, 'step' | 'chars'>) => <Code className="shp-ex-sig" code={followSignatureFit(step.signature, chars)} pre="function " />;

function Output({ step, label }: { step: ShapeExampleStep; label?: boolean }) {
  return (
    <div className="shp-ex-ret shp-ex-row">
      {label && <span className="shp-ex-cap">Comes out</span>}
      <code className="nm" title={step.output.name}><Dotted name={step.output.name} /></code>
      {step.output.note && <span className="pl">{step.output.note}</span>}
      <span className="shp-ex-rr">
        <Code className="shp-ex-type" code={step.output.type} pre="let x: " />
        <Val v={step.output.value} hand out type={step.output.type} />
      </span>
    </div>
  );
}

/**
 * Two panes: the values, then the code, with the line that decided it lit and
 * what comes out as the code's last line. A long step scrolls its checks; the
 * signature above them stays.
 */
function StepPanes({ k, cur, withInputs, ...p }: PartProps & { k: string; cur: boolean; withInputs: boolean }) {
  const { step } = p;
  return (
    <div className={`shp-ex-io panes${cur ? ' cur' : ''}`} data-io={k} aria-hidden={cur ? undefined : true} inert={!cur}>
      {withInputs && (
        <section className="shp-ex-col in" aria-label="Goes in">
          <p className="shp-ex-cap">
            Goes in{step.inputs.length > 7 && <span className="shp-ex-many"> {step.inputs.length}</span>}
          </p>
          <Inputs {...p} />
        </section>
      )}
      <section className="shp-ex-col fn" aria-label="What happens">
        <div className="shp-ex-caps">
          <p className="shp-ex-cap">What happens</p>
          <FnLink {...p} />
        </div>
        <Signature step={step} chars={p.chars} />
        {step.checks.length > 0 && (
          <div className="shp-ex-scroll">
            <ul className="shp-ex-checks">
              {step.checks.map((c, i) => (
                <CheckRow key={`${c.code}-${i}`} c={c} />
              ))}
            </ul>
          </div>
        )}
        <Output step={step} label />
      </section>
    </div>
  );
}

/**
 * The stack keeps the tallest step's height, so the board never moves as you
 * step. A step much shorter than that shows on a card that ends where it ends:
 * only the surface shrinks (from the bottom, so the arrows and the path stay
 * under the pointer). A huge --ex-cut lets the step and the rail take their own
 * heights to be read; the layout box never changes.
 */
function fitSurface(card: HTMLElement, phone: boolean) {
  const stack = card.querySelector<HTMLElement>('.shp-ex-ios');
  const cur = stack?.querySelector<HTMLElement>('.shp-ex-io.cur');
  if (phone || !stack || !cur) {
    card.style.removeProperty('--ex-cut');
    return;
  }
  card.style.setProperty('--ex-cut', '99999px');
  const rail = card.querySelector<HTMLElement>('.shp-ex-rail');
  const cut = followCardCut(stack.clientHeight - cur.offsetHeight, rail ? rail.parentElement!.clientHeight - rail.offsetHeight : null);
  card.style.setProperty('--ex-cut', `${cut}px`);
}

/** The card's width when open, read while it is folded too. */
function openWidth(card: HTMLElement): number {
  const folded = !card.classList.contains('expanded');
  card.classList.add('expanded');
  const w = card.offsetWidth;
  if (folded) card.classList.remove('expanded');
  return w;
}

/** Moves `box`'s scroll by as little as shows `el`. */
function keepInView(box: HTMLElement, el: HTMLElement) {
  const a = box.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  if (b.left < a.left) box.scrollLeft += b.left - a.left - 8;
  else if (b.right > a.right) box.scrollLeft += b.right - a.right + 8;
  if (b.top < a.top) box.scrollTop += b.top - a.top;
  else if (b.bottom > a.bottom) box.scrollTop += b.bottom - a.bottom;
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
  const [openW, setOpenW] = useState(0);
  const [dockTight, setDockTight] = useState(false);
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
    const card = cardRef.current;
    if (!card) return;
    flip.current = snapshot(card);
    setOpenW(openWidth(card));
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

  // The open card's width sets how long a signature's line can be, and when the panes stack.
  const cardOn = phase.open && how;
  const expandedNow = expanded;
  useEffect(() => {
    const card = cardRef.current;
    if (!cardOn || !card || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setOpenW(openWidth(card)));
    ro.observe(card);
    return () => ro.disconnect();
  }, [cardOn, expandedNow]);

  // The dock's seven other buttons keep their words: where all eight would not fit, this one gives its up.
  useEffect(() => {
    if (!surface || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setDockTight(surface.clientWidth < DOCK_ROOM));
    ro.observe(surface);
    return () => ro.disconnect();
  }, [surface]);

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
    if (card) fitSurface(card, phone);
    if (card && before && !red) {
      for (const a of flipping.current) a.cancel();
      flipping.current = [];
      for (const el of card.querySelectorAll<HTMLElement>('[data-flip]')) {
        const key = el.dataset.flip!;
        const was = before.get(key);
        const now = el.getBoundingClientRect();
        if (!was) {
          if (key === 'ios' || key === 'stops') {
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

  // A long step scrolls in its pane: the line that decided it is always in view when you land on it.
  const stepOn = phase.open ? phase.step : null;
  useLayoutEffect(() => {
    if (!expanded || stepOn === null) return;
    const io = cardRef.current?.querySelector<HTMLElement>('.shp-ex-io.cur');
    const line = io?.querySelector<HTMLElement>('.decides');
    // Two panes scroll the checks; one column scrolls the whole step.
    const sc = cardRef.current?.classList.contains('narrow') ? io : line?.closest<HTMLElement>('.shp-ex-scroll');
    if (!sc || !line) return;
    const a = sc.getBoundingClientRect();
    const b = line.getBoundingClientRect();
    if (b.top < a.top || b.bottom > a.bottom) sc.scrollTop += b.top - a.top - (a.height - b.height) / 2;
  }, [expanded, stepOn, phase]);

  // The path keeps the step on now in view; a phone's sheet starts each step at its top.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const on = card?.querySelector<HTMLElement>('.shp-ex-stop.on');
    if (on?.parentElement) keepInView(on.parentElement, on);
    if (phone) card?.querySelector('.shp-ex-in')?.scrollTo?.({ top: 0 });
  }, [expanded, stepOn, phone, openW]);

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
  const narrow = phone || (openW > 0 && openW < 860);
  const withRail = showIO && !narrow;
  const withStrip = showIO && narrow;
  const withInputs = !!ex && ex.steps.some((s) => s.inputs.length > 0);
  // How many mono characters fit in each pane: the rail (232), the main area's padding (28) and the panes' gap (24) go first.
  const width = openW || 1100;
  const panes = width - 284;
  const charsNow = narrow ? Math.max(28, Math.floor((width - 64) / CH)) : Math.floor((withInputs ? (panes * 8) / 14 : width - 260) / CH) - 1;
  const paneNow = narrow ? Math.floor((width - 40) / CH) : Math.floor((panes * 6) / 14 / CH);
  const toStep = (i: number) => dispatch({ type: 'step', step: i });

  const stepNav = (
    <div className={`shp-ex-nav${step ? ' cur' : ''}`} aria-hidden={step ? undefined : true}>
      <button type="button" className="shp-ex-icon" onClick={() => dispatch({ type: 'back' })} disabled={!step || (phase.open && phase.step === 0)} aria-label="Previous step" title="Previous step">
        <Huge name="left" />
      </button>
      <button type="button" className="shp-ex-icon" onClick={() => dispatch({ type: 'next' })} disabled={!step || !ex || (phase.open && phase.step === ex.steps.length - 1)} aria-label="Next step" title="Next step">
        <Huge name="right" />
      </button>
    </div>
  );
  const startNav = (
    <div className={`shp-ex-nav${step ? '' : ' cur'}`} aria-hidden={step ? true : undefined}>
      <button type="button" className="shp-ex-step" onClick={() => dispatch({ type: 'step', step: 0 })} tabIndex={step ? -1 : undefined}>
        Step through
        <Huge name="right" size={14} />
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
    <button
      type="button"
      className={`shp-ex-more${expanded ? ' icon' : ''}`}
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide inputs and outputs' : 'Inputs and outputs'}
      title={expanded ? 'Hide inputs and outputs' : undefined}
      onClick={() => setExpanded(!expanded)}
      data-flip="more"
    >
      {!expanded && 'Inputs and outputs'}
      <Huge name={expanded ? 'up' : 'down'} size={14} />
    </button>
  );
  const allSteps = step && !expanded && (
    <button type="button" className="shp-ex-quiet" onClick={() => dispatch({ type: 'step', step: null })} data-flip="all">
      All steps
    </button>
  );
  const close = (
    <button type="button" className="shp-ex-icon" onClick={() => dispatch({ type: 'close' })} aria-label="Stop following" title="Stop following" data-flip="close">
      <Huge name="close" />
    </button>
  );
  const tabs = examples.length > 1 && (
    <div className="shp-tgroup shp-ex-tabs" role="group" aria-label="Which example" data-flip="tabs">
      {examples.map((e, i) => (
        <button key={`${e.name}-${i}`} type="button" className={`shp-tbtn${phase.open && i === phase.ex ? ' on' : ''}`} aria-pressed={phase.open && i === phase.ex} title={e.name} style={{ flexShrink: e.name.length > 16 ? 1 : 0 }} onClick={() => dispatch({ type: 'example', ex: i })}>
          <span className="tn">{e.name}</span>
        </button>
      ))}
    </div>
  );
  const note = (
    <p className="shp-ex-note" data-flip="note">
      {NOTE}
    </p>
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
      {!phone && !dockTight && <span className="tl">Follow an example</span>}
    </button>
  ) : null;

  const stops =
    ex &&
    (withRail || withStrip) &&
    ex.steps.map((s, i) => {
      const on = phase.open && phase.step === i;
      return (
        <button key={i} type="button" className={`shp-ex-stop${on ? ' on' : ''}`} aria-current={on ? 'step' : undefined} onClick={() => toStep(i)} title={s.text} aria-label={`Step ${i + 1}: ${s.tag}`}>
          <StepN n={i + 1} now={on} />
          {(withRail || on) && <span className="st">{s.tag}</span>}
        </button>
      );
    });

  const body =
    ex && showIO && phase.open ? (
      <div className="shp-ex-ios" data-flip="ios">
        {ex.steps.map((s, i) => (
          <StepPanes key={i} step={s} onCode={onCode} canOpen={canOpen} onStep={toStep} chars={charsNow} pane={paneNow} k={`${phase.ex}-${i}`} cur={phase.step === i} withInputs={withInputs} />
        ))}
      </div>
    ) : null;

  const card =
    how && ex ? (
      <section ref={cardRef} className={`shp-ex-card${phone ? ' phone' : ''}${showIO ? ' expanded' : ''}${narrow ? ' narrow' : ''}`} aria-label={`Example: ${ex.title}`} data-follow-card="">
        <div className="shp-ex-skin" data-flip="skin" aria-hidden="true" />
        <div className="shp-ex-in">
          {phone && (
            <button type="button" className="shp-ex-grab" onClick={() => step && setExpanded(!expanded)} aria-label={expanded ? 'Show less' : 'Show more'} disabled={!step} data-flip="grab">
              <span />
            </button>
          )}
          {withRail && (
            <nav className="shp-ex-rail" aria-label="Steps">
              {tabs}
              <div className="shp-ex-stops" data-flip="stops">{stops}</div>
              {note}
            </nav>
          )}
          <div className="shp-ex-main">
            <div className="shp-ex-bar">
              {!phone && navs}
              <div className="shp-ex-stack shp-ex-texts" data-flip="text" aria-live="polite">
                <div className={`shp-ex-text all${step ? '' : ' cur'}`} aria-hidden={step ? true : undefined}>
                  <p className="shp-ex-does">{ex.title}</p>
                  {!showIO && ex.lead && <p className="shp-ex-sub">{ex.lead}</p>}
                </div>
                {ex.steps.map((s, i) => {
                  const on = phase.open && phase.step === i;
                  return (
                    <div key={i} className={`shp-ex-text${on ? ' cur' : ''}`} aria-hidden={on ? undefined : true}>
                      <span className="shp-ex-count">
                        <StepN n={i + 1} now /> of {ex.steps.length}
                      </span>
                      <div>
                        <p className="shp-ex-does" title={showIO ? s.text : undefined}>{s.text}</p>
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
              <div className="shp-ex-side">
                {!withRail && tabs}
                {!phone && allSteps}
                {!phone && more}
                {close}
              </div>
            </div>
            {withStrip && <div className="shp-ex-strip" data-flip="stops">{stops}</div>}
            {body}
          </div>
          {phone && (
            <div className="shp-ex-foot" data-flip="foot">
              {more}
              {allSteps}
              {navs}
            </div>
          )}
          {!withRail && note}
        </div>
      </section>
    ) : null;

  return { button, card, sheet: !!card && phone };
}
