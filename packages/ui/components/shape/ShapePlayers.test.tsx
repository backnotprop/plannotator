/**
 * A drawn view plays its runs and step-throughs (DOM-gated, DOM_TESTS=1).
 * What regresses if these fail:
 * - a host that passes no runs or steps (Workspaces, code review's diagrams)
 *   gets a player, or anything in a `data-run` slot, where it got nothing;
 * - a board's `<div data-run>` / `<div data-steps>` stops playing its part,
 *   or plays one the board does not have;
 * - one player that cannot draw takes the board (or the other player) down;
 * - a player drawn in the drawing's own tree, where the board's frame CSS
 *   (`svg text { fill: var(--ink) }`) and the agent's CSS repaint its words.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import { POOL_RUN, SORT_STEPS } from '../../../../tests/fixtures/shape-run-player';
import type { ShapeRun } from '@plannotator/core/shape-run';

const hasDom = typeof document !== 'undefined';
const drawnModule = hasDom ? await import('./ShapeDrawn') : null;

let root: Root | null = null;
let container: HTMLElement | null = null;
let unbridge: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => unbridge?.());
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const HTML = '<h2>Played</h2><div data-run="pool"></div><div data-steps="sort"></div><div data-run="other"></div>';

async function draw(props: Partial<React.ComponentProps<NonNullable<typeof drawnModule>['ShapeDrawn']>>) {
  const { ShapeDrawn } = drawnModule!;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ShapeDrawn drawn={{ html: HTML }} reduce {...props} />);
  });
  // The players load lazily: let their chunks resolve.
  for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  const board = container.querySelector('.shp-drawn-host')!.shadowRoot!.querySelector('.board') as HTMLElement;
  const slot = (sel: string) => board.querySelector<HTMLElement>(sel)!;
  /** The player's own shadow root inside a slot. */
  const player = (sel: string) => slot(sel).querySelector<HTMLElement>('[data-shape-player]')?.shadowRoot ?? null;
  return { board, slot, player };
}

describe.skipIf(!hasDom)('players in a drawn view', () => {
  test('a host that passes no runs or steps gets the drawing exactly as drawn', async () => {
    const { board, slot } = await draw({});
    expect(board.querySelector('h2')!.textContent).toBe('Played');
    expect(slot('[data-run="pool"]').childNodes).toHaveLength(0);
    expect(slot('[data-steps="sort"]').childNodes).toHaveLength(0);
  });

  test('each slot plays the part the board has under its id, and a slot for one it lacks stays empty', async () => {
    const { slot, player } = await draw({ runs: { pool: POOL_RUN }, steps: { sort: SORT_STEPS } });
    expect(player('[data-run="pool"]')!.querySelector('[role=group]')!.getAttribute('aria-label')).toBe(`Run: ${POOL_RUN.title}`);
    expect(player('[data-steps="sort"]')!.querySelector('[role=group]')!.getAttribute('aria-label')).toBe(`Step-through: ${SORT_STEPS.title}`);
    expect(slot('[data-run="other"]').childNodes).toHaveLength(0);
  });

  test('each player draws in a shadow root of its own, out of reach of the drawing\'s CSS', async () => {
    const { board, player } = await draw({ runs: { pool: POOL_RUN }, steps: { sort: SORT_STEPS } });
    // Nothing of a player is in the drawing's tree, where `svg text` and an agent's `.node` would match it.
    expect(board.querySelector('.srp, .ssp, svg, button')).toBeNull();
    for (const sel of ['[data-run="pool"]', '[data-steps="sort"]']) {
      const shadow = player(sel)!;
      expect(shadow).not.toBeNull();
      expect(shadow.querySelector('style')!.textContent).toContain(sel.includes('run') ? '.srp' : '.ssp');
      expect(shadow.querySelector('[role=group] button')).not.toBeNull();
    }
  });

  test('a run that cannot be drawn leaves its slot empty and the rest of the board playing', async () => {
    const broken = { ...POOL_RUN, lanes: undefined } as unknown as ShapeRun;
    // React reports the caught error; the test only cares that it was caught.
    const error = console.error;
    console.error = () => {};
    let drawn: Awaited<ReturnType<typeof draw>>;
    try {
      drawn = await draw({ runs: { pool: broken }, steps: { sort: SORT_STEPS } });
    } finally {
      console.error = error;
    }
    const { board, player } = drawn;
    expect(board.querySelector('h2')!.textContent).toBe('Played');
    expect(player('[data-run="pool"]')!.childNodes).toHaveLength(0);
    expect(player('[data-steps="sort"]')!.querySelector('[role=group]')).not.toBeNull();
  });
});
