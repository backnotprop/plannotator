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

async function mount(reduce: boolean, scene: ShapeScene = SCENE) {
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
    root!.render(<ScenePlayers board={board} drawnKey={0} scenes={{ lamp: scene }} reduce={reduce} />);
  });
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
  const count = () => shadow.querySelector('.ssc-bar .n')!.textContent ?? '';
  const key = async (k: string) => {
    await act(async () => {
      slider().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    });
  };
  return { board, shadow, piece, slider, caption, count, press, drag, key };
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

  test('a scene counted in steps shows one count, the caption\'s beat, at every beat, between beats and at the end', async () => {
    const says = ['Start.', 'One road.', 'A shorter road.', 'Half way there.', 'Done.'];
    const steps: ShapeScene = {
      ...SCENE,
      unit: 'step',
      end: 6,
      beats: [0, 1, 2, 3.5, 5].map((at, i) => ({ at, say: says[i]! })),
    };
    const p = await mount(false, steps);
    const check = (i: number) => {
      expect(p.count()).toBe(`${i + 1} of 5`);
      expect(p.caption().trim()).toBe(says[i]!);
      expect(p.slider().getAttribute('aria-valuetext')).toBe(`Beat ${i + 1} of 5: ${says[i]}`);
      // Exactly one count on screen (the screen reader's live line, hidden, says the same words as the slider).
      const shown = [...p.shadow.querySelectorAll('.ssc > *:not(.sr):not(style)')].map((el) => el.textContent ?? '').join(' ');
      expect(shown.match(/\d+\s*(of|\/)\s*\d+/g)).toEqual([`${i + 1} of 5`]);
      const live = p.shadow.querySelector('.sr')!.textContent ?? '';
      if (live) expect(live).toBe(`Beat ${i + 1} of 5: ${says[i]}`);
    };
    for (const [t, i] of [[0, 0], [0.5, 0], [1, 1], [2, 2], [3.4, 2], [3.5, 3], [4.9, 3], [5, 4], [6, 4]] as const) {
      await p.drag(t);
      expect(Number(p.slider().value)).toBe(t);
      check(i);
    }
    await p.press('Back one beat');
    check(4);
    await p.press('Back one beat');
    check(3);
  });

  test('reduced motion: a first beat after 0 is where it opens, and Play from the last beat starts there again', async () => {
    const late: ShapeScene = {
      ...SCENE,
      beats: [{ at: 5, say: 'The switch closes.' }, { at: 8, say: 'The lamp is on.' }],
      tracks: { lamp: [{ at: 0, opacity: 0.2 }, { at: 5, opacity: 0.6, ease: 'jump' }, { at: 8, opacity: 1, ease: 'jump' }] },
    };
    const p = await mount(true, late);
    expect(Number(p.slider().value)).toBe(5);
    expect(Number(p.piece.style.opacity)).toBeCloseTo(0.6);
    expect(p.caption()).toContain('The switch closes.');
    expect(p.count()).toBe('1 of 2');
    await p.press('Next beat');
    expect(Number(p.slider().value)).toBe(8);
    expect(p.count()).toBe('2 of 2');
    await p.press('Double speed');
    await p.press('Play');
    expect(Number(p.slider().value)).toBe(5);
    expect(p.caption()).toContain('The switch closes.');
  });

  test("reduced motion: the slider's keys step by beats", async () => {
    const p = await mount(true);
    await p.key('ArrowRight');
    expect(Number(p.slider().value)).toBe(4);
    await p.key('ArrowUp');
    expect(Number(p.slider().value)).toBe(8);
    await p.key('ArrowRight');
    expect(Number(p.slider().value)).toBe(8);
    await p.key('ArrowLeft');
    expect(Number(p.slider().value)).toBe(4);
    expect(p.caption()).toContain('The switch closes.');
    await p.key('End');
    expect(Number(p.slider().value)).toBe(8);
    await p.key('Home');
    expect(Number(p.slider().value)).toBe(0);
  });
});
