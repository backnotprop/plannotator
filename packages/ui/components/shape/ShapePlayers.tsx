// The players a drawn view holds: each `<div data-run="id">` in the drawing
// plays `runs[id]`, each `<div data-steps="id">` plays `steps[id]`. ShapeDrawn
// renders this only when a host passes runs or steps, and the players' code
// loads only when the drawing has a slot for one, so a board without them
// costs nothing and draws exactly as before.
//
// Each player draws in a shadow root of its own, on a host it adds to the
// slot: the board's frame CSS (`svg text { fill: … }`) and the agent's own
// drawing CSS (`.node`, `svg`, `button`, …) stop at that boundary, while the
// board's variables (--ink, --paper, --mark, …) and its font still inherit.
import React, { Component, Suspense, lazy, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  /** The player's own shadow root, on a host inside the drawing's slot. */
  root: ShadowRoot;
  kind: 'run' | 'steps';
  id: string;
}

/** The host a player draws in: as tall as the slot when the slot has a height, else as tall as the player. */
const HOST_CSS = 'display:block;width:100%;height:100%;';

export interface ShapePlayersProps {
  /** The drawing's `.board` (in its shadow root), drawn afresh each time `drawnKey` changes. */
  board: HTMLElement | null;
  drawnKey: number;
  runs?: Readonly<Record<string, ShapeRun>>;
  steps?: Readonly<Record<string, ShapeSteps>>;
  reduce: boolean;
}

export function ShapePlayers({ board, drawnKey, runs, steps, reduce }: ShapePlayersProps) {
  // The slots, with the drawing they were found in: slots of an older drawing are never rendered into.
  const [found, setFound] = useState<{ key: number; board: HTMLElement | null; slots: Slot[] }>({ key: -1, board: null, slots: [] });
  // Slots are found again when the drawing changes or the board gains or loses an id (a new object with the same ids is not a change).
  const parts = useRef({ runs, steps });
  parts.current = { runs, steps };
  const ids = `${Object.keys(runs ?? {}).join(' ')}|${Object.keys(steps ?? {}).join(' ')}`;
  useLayoutEffect(() => {
    const { runs, steps } = parts.current;
    const slots: Slot[] = [];
    const hosts: HTMLElement[] = [];
    for (const el of board?.querySelectorAll<HTMLElement>('[data-run], [data-steps]') ?? []) {
      const run = el.getAttribute('data-run');
      const kind = run !== null ? 'run' : 'steps';
      const id = (run ?? el.getAttribute('data-steps') ?? '').trim();
      // A slot for a part the board lacks stays as drawn: empty.
      if (!(kind === 'run' ? runs && Object.hasOwn(runs, id) : steps && Object.hasOwn(steps, id))) continue;
      const host = el.ownerDocument.createElement('div');
      host.setAttribute('data-shape-player', kind);
      host.style.cssText = HOST_CSS;
      el.appendChild(host);
      hosts.push(host);
      slots.push({ root: host.attachShadow({ mode: 'open' }), kind, id });
    }
    setFound({ key: drawnKey, board, slots });
    return () => {
      for (const host of hosts) host.remove();
    };
  }, [board, drawnKey, ids]);
  const slots = found.key === drawnKey && found.board === board ? found.slots : [];
  return (
    <>
      {slots.map(({ root, kind, id }, i) => {
        const run = kind === 'run' && runs && Object.hasOwn(runs, id) ? runs[id] : undefined;
        const step = kind === 'steps' && steps && Object.hasOwn(steps, id) ? steps[id] : undefined;
        if (!run && !step) return null;
        return createPortal(
          <Contained>
            <Suspense fallback={null}>{run ? <RunPlayer run={run} reduce={reduce} /> : <StepPlayer steps={step!} reduce={reduce} />}</Suspense>
          </Contained>,
          root,
          `${drawnKey}:${i}`,
        );
      })}
    </>
  );
}
