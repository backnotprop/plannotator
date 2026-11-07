/**
 * The scene player in the DOM (DOM_TESTS=1). What regresses if these fail:
 * - under reduced motion a scene moves by itself, or shows a moment between two beats
 *   (Next, a drag of the time slider, Play), so a person who asked for no motion sees it;
 * - `plannotator shape frame`'s page (frame.ts) no longer stands the scene still at the moment asked;
 * - the player's own controls reach past its shadow root into the drawing, or the drawing's
 *   pieces are not put back when the player goes.
 * happy-dom has no SVG geometry, so places and paths are not checked here (timeline.test.ts does
 * them on their own); a look such as opacity is.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ShapeScene } from '@plannotator/core/shape-scene';

const hasDom = typeof document !== 'undefined';
const players = hasDom ? await import('./ScenePlayers') : null;
const frame = hasDom ? await import('./frame') : null;

const SCENE: ShapeScene = {
  scene: 1,
  title: 'The lamp turns on',
  unit: 'ms',
  end: 10,
  beats: [
    { at: 0, say: 'The lamp is off.' },
    { at: 4, say: 'The switch closes.' },
    { at: 8, say: 'The lamp is on.' },
  ],
  tracks: { lamp: [{ at: 0, opacity: 0.2 }, { at: 8, opacity: 1, ease: 'linear' }] },
};

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  frame?.setSceneFrame(null);
});

async function mount(reduce: boolean) {
  container = document.createElement('div');
  const board = document.createElement('div');
  board.className = 'board';
  board.innerHTML = '<div data-scene="lamp"><svg viewBox="0 0 100 50"><g data-part="lamp"><rect width="20" height="20"/></g></svg></div>';
  container.append(board);
  const mountAt = document.createElement('div');
  container.append(mountAt);
  document.body.append(container);
  root = createRoot(mountAt);
  const { ScenePlayers } = players!;
  await act(async () => {
    root!.render(<ScenePlayers board={board} drawnKey={0} scenes={{ lamp: SCENE }} reduce={reduce} />);
  });
  // The player is a lazy chunk: wait for it to land.
  for (let i = 0; i < 50 && !board.querySelector('[data-shape-player]')?.shadowRoot?.querySelector('.ssc'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  const shadow = board.querySelector('[data-shape-player]')!.shadowRoot!;
  const piece = board.querySelector<SVGGElement>('[data-part="lamp"]')!;
  const slider = () => shadow.querySelector<HTMLInputElement>('input[aria-label="Time"]')!;
  const caption = () => shadow.querySelector('.ssc-cap')!.textContent ?? '';
  const press = async (label: string) => {
    await act(async () => {
      shadow.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
    });
  };
  const drag = async (v: number) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(slider(), String(v));
      slider().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  return { board, shadow, piece, slider, caption, press, drag };
}

describe.skipIf(!hasDom)('the scene player', () => {
  test('reduced motion: it opens on the first beat and Next goes straight to the next beat, drawn in place', async () => {
    const p = await mount(true);
    expect(p.caption()).toContain('The lamp is off.');
    expect(Number(p.slider().value)).toBe(0);
    expect(p.piece.style.opacity).toBe('0.2');
    await p.press('Next beat');
    expect(p.caption()).toContain('The switch closes.');
    expect(Number(p.slider().value)).toBe(4);
    expect(Number(p.piece.style.opacity)).toBeCloseTo(0.6);
    expect(p.shadow.querySelector('button[aria-label="Play"]')).not.toBeNull();
  });

  test('reduced motion: a drag between two beats lands on the beat before it', async () => {
    const p = await mount(true);
    await p.drag(7.3);
    expect(Number(p.slider().value)).toBe(4);
    expect(p.caption()).toContain('The switch closes.');
  });

  test('reduced motion: Play shows one beat at a time and stops on the last', async () => {
    const p = await mount(true);
    await p.press('Double speed');
    await p.press('Play');
    for (let i = 0; i < 25 && Number(p.slider().value) < 8; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      // Never a moment between beats.
      expect([0, 4, 8]).toContain(Number(p.slider().value));
    }
    expect(Number(p.slider().value)).toBe(8);
    expect(p.caption()).toContain('The lamp is on.');
  });

  test("shape frame's page: the scene stands still at the moment asked for", async () => {
    frame!.setSceneFrame({ scene: 'lamp', at: 6 });
    const p = await mount(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(Number(p.slider().value)).toBe(6);
    expect(p.caption()).toContain('The switch closes.');
    expect(p.shadow.querySelector('button[aria-label="Play"]')).not.toBeNull();
  });

  test('the controls live in their own shadow root, and the piece is put back when the player goes', async () => {
    const p = await mount(true);
    await p.press('Next beat');
    expect(p.board.querySelector('input')).toBeNull();
    act(() => root?.unmount());
    root = null;
    expect(p.piece.style.opacity).toBe('');
    expect(p.board.querySelector('[data-shape-player]')).toBeNull();
  });
});
