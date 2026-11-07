/**
 * The step player (DOM-gated, DOM_TESTS=1). What regresses if these fail:
 * - stepping no longer lights the code line the frame names, or the sentence
 *   and the drawing stop following the step;
 * - Back works on the first step or Next past the last;
 * - the scrubber stops reaching every step, or stops saying which one it is on;
 * - rows (buckets, a list) lose their chain or their order.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SORT_STEPS } from '../../../../../tests/fixtures/shape-run-player';
import type { ShapeSteps } from '@plannotator/core/shape-steps';

const hasDom = typeof document !== 'undefined';
const StepPlayer = hasDom ? (await import('./StepPlayer')).default : (null as never);

let root: Root | null = null;
let slot: HTMLElement | null = null;
let restore: (() => void) | null = null;

/** happy-dom lays nothing out: give elements a size while a test runs, then put the prototype back. */
function sized(w = 900, h = 420) {
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

async function mount(steps: ShapeSteps = SORT_STEPS, at?: number) {
  sized();
  slot = document.createElement('div');
  document.body.append(slot);
  root = createRoot(slot);
  await act(async () => {
    root!.render(<StepPlayer steps={steps} reduce at={at} />);
  });
  return slot;
}

const litLine = (el: HTMLElement) => {
  const lines = [...el.querySelectorAll('.ssp-code li')];
  return lines.findIndex((li) => li.getAttribute('aria-current') === 'step') + 1;
};
const said = (el: HTMLElement) => el.querySelector('.ssp-cap')!.textContent!;
const button = (el: HTMLElement, name: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;

describe.skipIf(!hasDom)('the step player', () => {
  test('each step lights its code line, says its sentence and draws its state', async () => {
    const el = await mount();
    expect(litLine(el)).toBe(1);
    expect(said(el)).toBe('1/6Start: 3 alone is sorted.');
    expect(el.querySelector('[role=img]')!.getAttribute('aria-label')).toBe('Array: 3, 1, 4, 2');
    await act(async () => button(el, 'Next step').click());
    await act(async () => button(el, 'Next step').click());
    expect(litLine(el)).toBe(3);
    expect(said(el)).toBe('3/6' + SORT_STEPS.frames[2]!.say);
    expect(el.querySelector('[role=img]')!.getAttribute('aria-label')).toBe('Array: 1, 3, 4, 2');
    // A screen reader hears the step it landed on.
    expect(el.querySelector('[aria-live=polite]')!.textContent).toBe(`Step 3 of 6, line 3: ${SORT_STEPS.frames[2]!.say}`);
  });

  test('Back stops at the first step and Next at the last', async () => {
    const el = await mount();
    expect(button(el, 'Back one step').disabled).toBe(true);
    for (let i = 0; i < 8; i++) await act(async () => button(el, 'Next step').click());
    expect(said(el)).toStartWith('6/6');
    expect(button(el, 'Next step').disabled).toBe(true);
    expect(button(el, 'Back one step').disabled).toBe(false);
  });

  test('the scrubber reaches every step and says which one it is on', async () => {
    const el = await mount();
    const range = el.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(range.getAttribute('aria-label')).toBe('Step');
    expect(range.max).toBe('5');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '5');
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(said(el)).toBe('6/6Done: every number is in its place.');
    expect(range.getAttribute('aria-valuetext')).toBe('Step 6 of 6, line 5: Done: every number is in its place.');
    expect(litLine(el)).toBe(5);
    expect(el.querySelector('.ssp-vars')!.textContent).toBe('swaps4');
  });

  test('rows keep their order and a chain shows its arrows', async () => {
    const lru: ShapeSteps = {
      steps: 1,
      title: 'LRU',
      code: { lines: ['get(k)'] },
      show: 'rows',
      frames: [{ line: 1, say: 'B moves to the front.', rows: [{ label: 'recent', items: ['B', 'A', 'C'], join: 'arrow', roles: ['moved', null, null] }, { label: 'map', items: ['A', 'B', 'C'] }] }],
    };
    const el = await mount(lru);
    expect(el.querySelector('.ssp-rows')!.getAttribute('aria-label')).toBe('recent: B → A → C; map: A, B, C');
    const [chain, map] = [...el.querySelectorAll('.ssp-row')];
    expect(chain!.querySelectorAll('.join')).toHaveLength(2);
    expect(map!.querySelectorAll('.join')).toHaveLength(0);
    expect(chain!.querySelector('.box.filled')!.textContent).toBe('B');
  });
});
