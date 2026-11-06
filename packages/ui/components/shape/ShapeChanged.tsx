// What's changed: the change read as a patch (approval "shape-whats-changed", look A · Patch).
// Each change is a hunk: its kind, its title, where it is in the code and the
// review's guide step, then − was and + now lines. The call paths beside it
// are unified diffs of the path: Starts, +/−/~ steps, @@ fork rows, Ends.
// Desktop sets the two side by side; a narrow board stacks them, paths first.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { parseShapeCodeTarget, type ShapeChangeFlow, type ShapeChangeItem, type ShapeChanged as ShapeChangedData, type ShapeCodeTarget, type ShapeFlowEnd, type ShapeFlowStep } from '@plannotator/core/shape';
import type { MarkState } from './ShapeDrawn';
import { ShapeInline } from './inline';
import type { ShapeReviewAt, ShapeSurfaceReview } from './types';

/** A host's `open`, never throwing: a sync throw or a rejection answers false, as a place it cannot show does. */
export function openShapeReview(review: ShapeSurfaceReview, at: ShapeReviewAt): Promise<boolean> {
  return Promise.resolve()
    .then(() => review.open(at))
    .then((ok) => ok === true, () => false);
}

const KIND: Record<ShapeChangeItem['kind'], string> = { behaviour: 'Behaviour', contract: 'Contract', moved: 'Moved', removed: 'Removed', check: 'Check this' };
/** The glyph is for the eye; the word is for a screen reader. */
const STEP_GLYPH: Record<ShapeFlowStep['is'], string> = { new: '+', gone: '-', changed: '~', same: '' };
const STEP_WORD: Record<ShapeFlowStep['is'], string> = { new: 'New: ', gone: 'Gone: ', changed: 'Changed: ', same: '' };
const STEP_CLASS: Record<ShapeFlowStep['is'], string> = { new: 'add', gone: 'del', changed: 'mod', same: '' };

const st = (i: number) => ({ 'data-step': '', style: { ['--i' as string]: Math.min(i, 8) } as React.CSSProperties });

function markClass(id: string, marks: MarkState) {
  return ['mk', marks.erasing.has(id) && 'erasing', marks.fresh.has(id) && 'fresh', marks.noted.has(id) && 'noted'].filter(Boolean).join(' ');
}

const linesOf = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const baseName = (path: string) => path.split('/').pop() ?? path;

/** A diff line's words: `code` spans stand out, as a word diff's changed run does. Nothing else is markup. */
function DiffWords({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(<code key={key++} className="tok">{m[1]}</code>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

interface Links {
  onCode?: (target: ShapeCodeTarget) => void;
  onStep?: (step: number) => void;
  /** How many steps the review has, when the host says. */
  steps?: number;
}

/** `path:line`, shown as `file.ts:42`. A link when the board can open code, plain words otherwise. */
function CodeLink({ at, onCode }: { at: string; onCode?: Links['onCode'] }) {
  const target = parseShapeCodeTarget(at);
  if (!target) return null;
  const label = `${baseName(target.path)}:${target.line}`;
  if (!onCode) return <span className="shp-chg-loc plain">{label}</span>;
  // The name starts with the words on the button (WCAG 2.5.3), then says where it goes.
  return (
    <button type="button" className="shp-chg-loc" onClick={() => onCode(target)} title={`${target.path}:${target.line}`} aria-label={`${label}, open ${target.path} at line ${target.line}`}>
      {label}
    </button>
  );
}

function Hunk({ item, marks, links }: { item: ShapeChangeItem; marks: MarkState; links: Links }) {
  const code = item.code ?? [];
  // A step the review has (or may have: a host that does not say how many keeps the link, and it lands at the start).
  const step = item.step && links.onStep && (links.steps === undefined || item.step <= links.steps) ? item.step : null;
  return (
    <article className={`shp-chg-hunk ${markClass(item.id, marks)}`} data-mark={item.id} data-change-kind={item.kind}>
      <div className="shp-chg-hh">
        <span className={`shp-chg-kind${item.kind === 'check' ? ' check' : ''}`}>{KIND[item.kind]}</span>
        <h4 className="shp-chg-title"><ShapeInline text={item.title} /></h4>
        {(code.length > 0 || step) && (
          <span className="shp-chg-links">
            {code.map((at, n) => <CodeLink key={`${n}-${at}`} at={at} onCode={links.onCode} />)}
            {step && (
              <button type="button" className="shp-chg-step" onClick={() => links.onStep!(step)} aria-label={`Guide step ${step}, open the guided review there`}>
                Guide step {step}
              </button>
            )}
          </span>
        )}
      </div>
      <div className="shp-chg-body">
        {item.kind === 'moved' ? (
          <div className="shp-chg-ln mod">
            <span className="g" aria-hidden="true">→</span>
            <span className="tx">
              <span className="shp-sr">Moved: </span>
              {item.from} <span className="dim">to</span> {item.to}
              {item.lines ? <span className="dim">{`  ${item.lines} ${item.lines === 1 ? 'line' : 'lines'}, unchanged`}</span> : null}
            </span>
          </div>
        ) : item.kind === 'check' ? null : (
          <>
            {linesOf(item.was).map((line, n) => (
              <div key={`w${n}`} className="shp-chg-ln del">
                <span className="g" aria-hidden="true">-</span>
                <span className="tx"><span className="shp-sr">{item.kind === 'removed' ? 'Removed: ' : 'Was: '}</span><DiffWords text={line} /></span>
              </div>
            ))}
            {linesOf(item.now).map((line, n) => (
              <div key={`n${n}`} className="shp-chg-ln add">
                <span className="g" aria-hidden="true">+</span>
                <span className="tx"><span className="shp-sr">Now: </span><DiffWords text={line} /></span>
              </div>
            ))}
          </>
        )}
        {item.note && (
          <div className="shp-chg-note">
            <span aria-hidden="true" />
            <p><ShapeInline text={item.note} /></p>
          </div>
        )}
      </div>
    </article>
  );
}

function FlowStep({ step, onCode }: { step: ShapeFlowStep; onCode?: Links['onCode'] }) {
  return (
    <div className={`shp-chg-fr ${STEP_CLASS[step.is]}`}>
      <span className="lab" />
      <span className="g" aria-hidden="true">{STEP_GLYPH[step.is]}</span>
      <span className="call">
        <span className="shp-sr">{STEP_WORD[step.is]}</span>
        <span className="fn">{step.call}</span>
        {step.note && <span className="nt"><DiffWords text={step.note} /></span>}
      </span>
      <span className="at">{step.at && <CodeLink at={step.at} onCode={onCode} />}</span>
    </div>
  );
}

function FlowEnd({ end }: { end: ShapeFlowEnd }) {
  if (end.was === undefined || end.was === end.now) {
    return (
      <div className="shp-chg-fr end">
        <span className="lab">Ends</span>
        <span className="g" aria-hidden="true" />
        <span className="call">{end.now}{end.was !== undefined && <span className="nt">no change</span>}</span>
        <span />
      </div>
    );
  }
  return (
    <>
      <div className="shp-chg-fr end del">
        <span className="lab">Ends</span>
        <span className="g" aria-hidden="true">-</span>
        <span className="call"><span className="shp-sr">Was: </span>{end.was}</span>
        <span />
      </div>
      <div className="shp-chg-fr end add">
        <span className="lab" />
        <span className="g" aria-hidden="true">+</span>
        <span className="call"><span className="shp-sr">Now: </span>{end.now}</span>
        <span />
      </div>
    </>
  );
}

function Flow({ flow, marks, onCode, i }: { flow: ShapeChangeFlow; marks: MarkState; onCode?: Links['onCode']; i: number }) {
  return (
    <section className={`shp-chg-pane ${markClass(flow.id, marks)}`} data-mark={flow.id} aria-label={`Call path: ${flow.title}`} {...st(i)}>
      <div className="shp-chg-ph">
        <h3 className="shp-chg-pt"><ShapeInline text={flow.title} /></h3>
        <span className="key" aria-hidden="true">
          <span><span className="plus">+</span> new</span>
          <span><span className="minus">-</span> gone</span>
          <span>~ changed</span>
        </span>
      </div>
      <div className="shp-chg-rows">
        <div className="shp-chg-fr start">
          <span className="lab">Starts</span>
          <span className="g" aria-hidden="true" />
          <span className="call">{flow.start}</span>
          <span />
        </div>
        {(flow.steps ?? []).map((s, n) => <FlowStep key={`s${n}`} step={s} onCode={onCode} />)}
        {(flow.forks ?? []).map((fork, n) => (
          <React.Fragment key={`f${n}`}>
            <div className="shp-chg-fr fork">
              <span className="lab" aria-hidden="true">@@</span>
              <span className="g" aria-hidden="true" />
              <span className="call"><span className="shp-sr">When: </span>{fork.when}</span>
              <span />
            </div>
            {(fork.steps ?? []).map((s, k) => <FlowStep key={`s${k}`} step={s} onCode={onCode} />)}
            {fork.end && <FlowEnd end={fork.end} />}
          </React.Fragment>
        ))}
        {flow.end && <FlowEnd end={flow.end} />}
      </div>
    </section>
  );
}

export interface ShapeChangedProps {
  changed: ShapeChangedData;
  marks: MarkState;
  /** The review this board is part of: its facts, its two buttons and the guide-step links. Absent: none of them. */
  review?: ShapeSurfaceReview | null;
  /** A `file:line` link opens code. Absent: the places show as words. */
  onCode?: (target: ShapeCodeTarget) => void;
}

/** The nearest ancestor that scrolls (the board's view), or the page. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return document.scrollingElement as HTMLElement | null;
}

/**
 * The call paths stay in sight beside a long list of changes, but only while they fit in the view: taller ones
 * scroll with the page, so their bottom is never out of reach until the list ends.
 */
function useStickWhenFits(on: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const scroller = scrollerOf(el);
    if (!scroller) return;
    const measure = () => {
      const cs = getComputedStyle(scroller);
      const room = scroller.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      setFits(el.offsetHeight > 0 && el.offsetHeight <= room);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    watch.observe(scroller);
    return () => watch.disconnect();
  }, [on]);
  return { ref, fits };
}

export function ShapeChanged({ changed, marks, review, onCode }: ShapeChangedProps) {
  const links: Links = {
    onCode,
    steps: review?.steps,
    // A step the review turns out not to have opens the review at its start.
    onStep: review ? (step) => void openShapeReview(review, { step }).then((ok) => (ok ? true : openShapeReview(review, {}))) : undefined,
  };
  const meta = review ? [review.label, review.files !== undefined ? `${review.files} ${review.files === 1 ? 'file' : 'files'}` : null].filter(Boolean) : [];
  const counts = review && (review.additions !== undefined || review.deletions !== undefined);
  const flows = changed.flows ?? [];
  const stick = useStickWhenFits(flows.length > 0);
  return (
    <div className={`shp-chg${flows.length ? '' : ' one'}`}>
      {(changed.summary || review) && (
        <header className="shp-chg-head" {...st(0)}>
          {changed.summary && <p className="shp-chg-sum"><ShapeInline text={changed.summary} /></p>}
          {(meta.length > 0 || counts) && (
            <p className="shp-chg-meta">
              {meta.map((m) => <span key={m}>{m}</span>)}
              {counts && (
                <span>
                  {review!.additions !== undefined && <span className="plus" aria-label={`${review!.additions} lines added`}>+{review!.additions}</span>}
                  {review!.additions !== undefined && review!.deletions !== undefined && ' '}
                  {review!.deletions !== undefined && <span className="minus" aria-label={`${review!.deletions} lines removed`}>-{review!.deletions}</span>}
                </span>
              )}
            </p>
          )}
          {review && (
            <div className="shp-chg-acts">
              <button type="button" className="shp-chg-btn primary" onClick={() => void openShapeReview(review, {})}>Guided review</button>
              <button type="button" className="shp-chg-btn" onClick={() => void openShapeReview(review, { files: true })}>Full review</button>
            </div>
          )}
        </header>
      )}
      <div className="shp-chg-cols">
        <section className="shp-chg-pane changes" aria-label="Changes" {...st(1)}>
          <div className="shp-chg-ph">
            <h3 className="shp-chg-pt">Changes</h3>
            <span className="c">{changed.items.length}</span>
          </div>
          {changed.items.map((item) => <Hunk key={item.id} item={item} marks={marks} links={links} />)}
          {changed.also && (
            <div className="shp-chg-also">
              <span className="k">Also</span>
              <p><ShapeInline text={changed.also} /></p>
            </div>
          )}
        </section>
        {flows.length > 0 && (
          <div ref={stick.ref} className={`shp-chg-flows${stick.fits ? ' fits' : ''}`}>
            {flows.map((flow, n) => <Flow key={flow.id} flow={flow} marks={marks} onCode={onCode} i={n + 2} />)}
          </div>
        )}
      </div>
    </div>
  );
}
