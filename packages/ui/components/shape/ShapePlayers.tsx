// The players a drawn view holds: each `<div data-run="id">` in the drawing
// plays `runs[id]`, each `<div data-steps="id">` plays `steps[id]`. ShapeDrawn
// renders this only when a host passes runs or steps, and the players' code
// loads only when the drawing has a slot for one, so a board without them
// costs nothing and draws exactly as before.
import React, { Component, Suspense, lazy, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ShapeRun } from '@plannotator/core/shape-run';
import type { ShapeSteps } from '@plannotator/core/shape-steps';

const RunPlayer = lazy(() => import('./run/RunPlayer'));
const StepPlayer = lazy(() => import('./steps/StepPlayer'));

/** One player that cannot load or draw leaves its slot empty; the rest of the board stays. */
class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface Slot {
  el: HTMLElement;
  kind: 'run' | 'steps';
  id: string;
}

export interface ShapePlayersProps {
  /** The drawing's `.board` (in its shadow root), drawn afresh each time `drawnKey` changes. */
  board: HTMLElement | null;
  drawnKey: number;
  runs?: Readonly<Record<string, ShapeRun>>;
  steps?: Readonly<Record<string, ShapeSteps>>;
  reduce: boolean;
}

export function ShapePlayers({ board, drawnKey, runs, steps, reduce }: ShapePlayersProps) {
  const [slots, setSlots] = useState<Slot[]>([]);
  useLayoutEffect(() => {
    const found: Slot[] = [];
    for (const el of board?.querySelectorAll<HTMLElement>('[data-run], [data-steps]') ?? []) {
      const run = el.getAttribute('data-run');
      if (run !== null) found.push({ el, kind: 'run', id: run.trim() });
      else found.push({ el, kind: 'steps', id: (el.getAttribute('data-steps') ?? '').trim() });
    }
    setSlots(found);
  }, [board, drawnKey]);
  return (
    <>
      {slots.map(({ el, kind, id }, i) => {
        const run = kind === 'run' && runs && Object.hasOwn(runs, id) ? runs[id] : undefined;
        const step = kind === 'steps' && steps && Object.hasOwn(steps, id) ? steps[id] : undefined;
        if (!run && !step) return null;
        return createPortal(
          <Contained>
            <Suspense fallback={null}>{run ? <RunPlayer run={run} reduce={reduce} /> : <StepPlayer steps={step!} reduce={reduce} />}</Suspense>
          </Contained>,
          el,
          `${drawnKey}:${i}`,
        );
      })}
    </>
  );
}
