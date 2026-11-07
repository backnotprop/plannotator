/**
 * The run player (DOM-gated, DOM_TESTS=1). What regresses if these fail:
 * - under reduced motion the run no longer opens at its end, still, with the
 *   moment written out, or it starts playing by itself;
 * - scrubbing stops moving the picture and the words that say the moment;
 * - "By goroutine" / "By channel" no longer regroups the rows, or a run with
 *   nothing to group by offers the control anyway;
 * - a scenario stops saying, on the picture, that it is not a recorded trace;
 * - a failed call loses its red end, or a span past the playhead is drawn early;
 * - the time slider needs hundreds of key presses to cross the run;
 * - it stops playing once by itself when first seen, or plays under reduced motion.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POOL_RUN } from '../../../../../tests/fixtures/shape-run-player';
import type { ShapeRun } from '@plannotator/core/shape-run';

const hasDom = typeof document !== 'undefined';
const RunPlayer = hasDom ? (await import('./RunPlayer')).default : (null as never);

let root: Root | null = null;
let slot: HTMLElement | null = null;
let restore: (() => void) | null = null;

/** happy-dom lays nothing out: give elements a size while a test runs, then put the prototype back. */
function sized(w = 900, h = 400) {
  const proto = HTMLElement.prototype;
  const was = { cw: Object.getOwnPropertyDescriptor(proto, 'clientWidth'), ch: Object.getOwnPropertyDescriptor(proto, 'clientHeight') };
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => w });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => h });
  restore = () => {
    if (was.cw) Object.defineProperty(proto, 'clientWidth', was.cw);
    else delete (proto as { clientWidth?: number }).clientWidth;
    if (was.ch) Object.defineProperty(proto, 'clientHeight', was.ch);
    else delete (proto as { clientHeight?: number }).clientHeight;
  };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  slot?.remove();
  slot = null;
  restore?.();
  restore = null;
});

async function mount(props: Partial<React.ComponentProps<typeof RunPlayer>> = {}) {
  sized();
  slot = document.createElement('div');
  document.body.append(slot);
  root = createRoot(slot);
  await act(async () => {
    root!.render(<RunPlayer run={POOL_RUN} {...props} />);
  });
  return slot;
}

const caption = (el: HTMLElement) => el.querySelector('.srp-cap')!.textContent!;
const rowNames = (el: HTMLElement) => [...el.querySelectorAll('svg text')].map((t) => t.textContent);

async function scrubTo(el: HTMLElement, t: number) {
  const input = el.querySelector<HTMLInputElement>('input[type=range]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(t));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe.skipIf(!hasDom)('the run player', () => {
  test('under reduced motion it opens at the end, still, and says the moment', async () => {
    const el = await mount({ reduce: true });
    expect(caption(el)).toStartWith('30 ms');
    expect(caption(el)).toBe('30 ms · blocked: worker 2 on results');
    expect(el.querySelector('button.play')!.getAttribute('aria-label')).toBe('Play');
    const range = el.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(range.getAttribute('aria-label')).toBe('Time');
    expect(range.getAttribute('aria-valuetext')).toBe(caption(el));
  });

  test('scrubbing moves the picture and the words with it', async () => {
    const el = await mount({ reduce: true });
    await scrubTo(el, 5);
    expect(caption(el)).toStartWith('5 ms');
    expect(caption(el)).toContain('1 in flight: main on results');
    expect(caption(el)).toContain('working: worker 1 (job 1), worker 2 (job 2)');
    // Nothing that starts later is drawn yet: no leak, no mark words.
    expect(rowNames(el)).not.toContain('job 2: bad input');
    await scrubTo(el, 16);
    expect(caption(el)).toContain('main returns early');
    expect(rowNames(el)).toContain('job 2: bad input');
  });

  test('the grouping regroups the rows, and a run with nothing to group by has no grouping', async () => {
    const el = await mount({ reduce: true });
    const group = el.querySelector('[role=group][aria-label="Group by"]')!;
    const [byLane, byRes] = [...group.querySelectorAll('button')];
    expect(byLane!.textContent).toBe('By goroutine');
    expect(byRes!.textContent).toBe('By channel');
    expect(byLane!.getAttribute('aria-pressed')).toBe('true');
    expect(rowNames(el)).toContain('worker 1');
    expect(rowNames(el)).not.toContain('jobs');
    await act(async () => byRes!.click());
    expect(byRes!.getAttribute('aria-pressed')).toBe('true');
    expect(rowNames(el)).toContain('results');
    expect(rowNames(el)).toContain('own work');
    expect(rowNames(el)).not.toContain('worker 1');

    act(() => root?.unmount());
    const plain: ShapeRun = { run: 1, title: 'one lane', lanes: [{ id: 'a', label: 'a' }], spans: [{ lane: 'a', from: 0, to: 4, end: 'ok' }] };
    await act(async () => {
      root = createRoot(slot!);
      root.render(<RunPlayer run={plain} reduce />);
    });
    expect(slot!.querySelector('[aria-label="Group by"]')).toBeNull();
    expect(caption(slot!)).toStartWith('4 ms');
  });

  test('a scenario says so on the picture; a recorded run does not', async () => {
    const el = await mount({ reduce: true });
    expect(el.querySelector('.srp-badge')?.textContent).toBe('scenario · not a recorded trace');
    expect(el.querySelector('.srp-src')?.textContent).toBe('scenario, written from pool.go');
    act(() => root?.unmount());
    await act(async () => {
      root = createRoot(slot!);
      root.render(<RunPlayer run={{ ...POOL_RUN, source: 'recorded: go run ./pool' }} reduce />);
    });
    expect(slot!.querySelector('.srp-badge')).toBeNull();
  });

  test('a failed call ends in red with a cross once it has ended, and not before', async () => {
    const el = await mount({ at: 12 });
    const failedEnd = () => [...el.querySelectorAll('svg path')].filter((p) => p.getAttribute('stroke') === 'var(--alert)');
    expect(failedEnd()).toHaveLength(0);
    await scrubTo(el, 15);
    // The red last stretch and the cross.
    expect(failedEnd().length).toBeGreaterThanOrEqual(2);
  });

  test('the time slider crosses the run in steps a keyboard can count', async () => {
    const el = await mount({ reduce: true });
    const input = el.querySelector<HTMLInputElement>('input[type=range]')!;
    const press = (key: string) => act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    await press('Home');
    expect(caption(el)).toStartWith('0 ms');
    // 40 presses cross the 30 ms run: four are 3 ms, a Page key is ten of them.
    for (let i = 0; i < 4; i++) await press('ArrowRight');
    expect(caption(el)).toStartWith('3 ms');
    await press('PageUp');
    expect(caption(el)).toStartWith('6 ms');
    await press('End');
    expect(caption(el)).toStartWith('30 ms');
  });

  test('it plays once by itself when first seen, and never under reduced motion', async () => {
    const was = globalThis.IntersectionObserver;
    let seen: (() => void) | null = null;
    globalThis.IntersectionObserver = class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        seen = () => cb([{ isIntersecting: true }]);
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      const still = await mount({ reduce: true });
      await act(async () => seen?.());
      expect(still.querySelector('button.play')!.getAttribute('aria-label')).toBe('Play');
      act(() => root?.unmount());
      seen = null;
      await act(async () => {
        root = createRoot(slot!);
        root.render(<RunPlayer run={POOL_RUN} />);
      });
      expect(seen).not.toBeNull();
      // Synchronous: an awaited act would wait out the whole playback.
      act(() => seen!());
      expect(slot!.querySelector('button.play')!.getAttribute('aria-label')).toBe('Pause');
      act(() => root?.unmount());
      root = null;
    } finally {
      globalThis.IntersectionObserver = was;
    }
  });
});
